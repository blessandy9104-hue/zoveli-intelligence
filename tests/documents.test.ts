import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentIntelligence } from '../src/domains/documents.js';
import { IntelligenceInputError, StoreCorruptionError } from '../src/errors.js';
import { createWorkspace, fixedClock, writeFile, type Workspace } from './helpers.js';

describe('DocumentIntelligence', () => {
  let ws: Workspace;
  let guide: string;
  let notes: string;

  beforeEach(() => {
    ws = createWorkspace();
    guide = writeFile(
      ws.root,
      'guide.md',
      '# Cooking\n\nTo bake bread you need flour and water. Preheat the oven to 220C. Knead the dough for ten minutes.'
    );
    notes = writeFile(ws.root, 'notes.txt', 'The project deadline is Friday. The budget is 500 dollars.');
    writeFile(
      ws.root,
      'page.html',
      '<html><body><h1>Travel</h1><p>Trains leave at noon from platform three.</p></body></html>'
    );
    writeFile(ws.root, 'image.png', 'not an indexable document');
  });

  afterEach(() => ws.cleanup());

  function createDocumentStore(options: Partial<ConstructorParameters<typeof DocumentIntelligence>[0]> = {}) {
    return new DocumentIntelligence({
      dataDir: ws.dataDir,
      roots: [ws.root],
      now: fixedClock(),
      ...options,
    });
  }

  it('indexes supported files, skips unsupported ones, and reports totals', () => {
    const documents = createDocumentStore();
    const result = documents.indexPaths([ws.root]);

    expect(result.indexed).toHaveLength(3);
    expect(result.filesConsidered).toBe(3);
    expect(result.skippedUnsupported.some((file) => file.endsWith('image.png'))).toBe(true);
    expect(result.errors).toEqual([]);

    const stats = documents.stats();
    expect(stats.documents).toBe(3);
    expect(stats.chunks).toBeGreaterThanOrEqual(3);
    expect(stats.terms).toBeGreaterThan(0);
    expect(stats.roots).toEqual([ws.root]);
    expect(stats.updatedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('ranks matching chunks and returns source line ranges', () => {
    const documents = createDocumentStore();
    documents.indexPaths([guide]);

    const hits = documents.search('knead dough', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toBe(guide);
    expect(hits[0].startLine).toBeGreaterThanOrEqual(1);
    expect(hits[0].endLine).toBeGreaterThanOrEqual(hits[0].startLine);
    expect(hits[0].excerpt.toLowerCase()).toContain('knead');
    expect(hits[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(documents.search('knead dough', 1)).toHaveLength(1);
  });

  it('answers extractively with citations and grounded verification', () => {
    const documents = createDocumentStore();
    documents.indexPaths([ws.root]);

    const result = documents.answer('How long should I knead the dough?');
    expect(result.verification).toBe('grounded');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.answer).toContain('Knead the dough for ten minutes.');
    expect(result.answer).toContain('guide');
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence[0].kind).toBe('document');
    expect(result.evidence[0].locator).toMatch(/^lines \d+-\d+$/);
    expect(result.disclosures.join(' ')).toContain('extractive');
  });

  it('withholds when nothing supports the answer', () => {
    const documents = createDocumentStore();
    documents.indexPaths([notes]);

    const result = documents.answer('quantum entanglement experiments');
    expect(result.verification).toBe('unverified');
    expect(result.confidence).toBe(0);
    expect(result.evidence).toEqual([]);
    expect(result.answer.toLowerCase()).toContain('no indexed local document');
  });

  it('rejects reads outside the allowlisted roots', () => {
    const outside = writeFile(ws.base, 'outside.md', 'Secret content that must not be indexed.');
    const documents = createDocumentStore();

    const result = documents.indexPaths([outside]);
    expect(result.indexed).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('outside the configured document roots');
  });

  it('reports missing paths as errors and rejects empty input', () => {
    const documents = createDocumentStore();
    const result = documents.indexPaths([path.join(ws.root, 'missing.md')]);
    expect(result.errors[0].error).toBe('path does not exist');
    expect(() => documents.indexPaths([])).toThrow(IntelligenceInputError);
  });

  it('forgets an index entry without deleting the file', () => {
    const documents = createDocumentStore();
    documents.indexPaths([guide]);
    expect(documents.list().some((doc) => doc.path === guide)).toBe(true);

    const result = documents.forget(guide);
    expect(result.removed).toBe(true);
    expect(fs.existsSync(guide)).toBe(true);
    expect(documents.list().some((doc) => doc.path === guide)).toBe(false);

    const again = documents.forget(guide);
    expect(again.removed).toBe(false);
  });

  it('replaces chunks on re-index instead of duplicating documents', () => {
    const documents = createDocumentStore();
    documents.indexPaths([guide]);
    expect(documents.search('knead').length).toBeGreaterThan(0);

    fs.writeFileSync(guide, 'Risotto needs arborio rice and slow stirring.', 'utf8');
    documents.indexPaths([guide]);

    expect(documents.list()).toHaveLength(1);
    expect(documents.search('knead')).toHaveLength(0);
    expect(documents.search('risotto').length).toBeGreaterThan(0);
  });

  it('strips HTML tags before indexing', () => {
    const documents = createDocumentStore();
    documents.indexPaths([path.join(ws.root, 'page.html')]);

    const result = documents.answer('When do trains leave?');
    expect(result.answer).toContain('platform three');
    expect(result.answer).not.toContain('<p>');
  });

  it('enforces the maximum file size', () => {
    const documents = createDocumentStore({ maxFileBytes: 10 });
    const result = documents.indexPaths([notes]);
    expect(result.indexed).toEqual([]);
    expect(result.errors[0].error).toContain('exceeds');
  });

  it('rejects empty queries', () => {
    const documents = createDocumentStore();
    expect(() => documents.search('')).toThrow(IntelligenceInputError);
    expect(() => documents.answer('  ')).toThrow(IntelligenceInputError);
  });

  it('fails closed on a corrupt index file', () => {
    const documents = createDocumentStore();
    documents.indexPaths([notes]);
    fs.writeFileSync(path.join(ws.dataDir, 'documents.json'), '{invalid', 'utf8');

    expect(() => createDocumentStore()).toThrow(StoreCorruptionError);
  });

  it('fails closed on an unexpected index shape', () => {
    fs.writeFileSync(path.join(ws.dataDir, 'documents.json'), '{"version":2}', 'utf8');
    expect(() => createDocumentStore()).toThrow(StoreCorruptionError);
  });
});
