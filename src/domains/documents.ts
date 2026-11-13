import * as fs from 'node:fs';
import * as path from 'node:path';
import { IntelligenceInputError, IntelligenceSecurityError, StoreCorruptionError } from '../errors.js';
import { readJsonStore, writeJsonStore } from '../store.js';
import {
  clip,
  lineNumberAt,
  normalizeWhitespace,
  sha256,
  stripHtml,
  titleOf,
  tokenize,
} from '../text.js';
import type {
  DomainResult,
  DocumentChunk,
  DocumentHit,
  DocumentIndexData,
  DocumentIndexResult,
  DocumentStats,
  Evidence,
  IndexedDocument,
} from '../types.js';

const SUPPORTED_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text', '.rst', '.adoc',
  '.json', '.jsonl', '.csv', '.tsv', '.html', '.htm',
  '.log', '.yml', '.yaml',
]);

const SKIPPED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage',
  '.venv', 'venv', '__pycache__', '.cache', '.next', '.turbo',
]);

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 500;
const DEFAULT_CHUNK_WORDS = 220;
const DEFAULT_CHUNK_OVERLAP = 40;

export interface DocumentOptions {
  dataDir: string;
  /** Directories the index may read from. Defaults to the current directory. */
  roots?: string[];
  maxFileBytes?: number;
  maxFiles?: number;
  chunkWords?: number;
  chunkOverlapWords?: number;
  now?: () => Date;
}

interface IndexLimits {
  maxFiles: number;
  maxFileBytes: number;
}

/**
 * Local document intelligence: deterministic BM25 retrieval over an explicit
 * set of allowlisted folders. No embeddings, no network, no hidden model.
 * Answers are extractive and always carry source + line citations.
 */
export class DocumentIntelligence {
  readonly dataDir: string;
  readonly indexPath: string;
  private readonly roots: string[];
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly chunkWords: number;
  private readonly chunkOverlap: number;
  private readonly now: () => Date;
  private data: DocumentIndexData;
  private tokenCache = new Map<string, string[]>();
  private vocabularyCache: number | null = null;

  constructor(options: DocumentOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.indexPath = path.join(this.dataDir, 'documents.json');
    this.roots = normalizeRoots(options.roots && options.roots.length > 0 ? options.roots : [process.cwd()]);
    this.maxFileBytes = positiveInt(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    this.maxFiles = positiveInt(options.maxFiles, DEFAULT_MAX_FILES);
    this.chunkWords = Math.max(40, positiveInt(options.chunkWords, DEFAULT_CHUNK_WORDS));
    this.chunkOverlap = Math.max(0, Math.min(this.chunkWords - 1, positiveInt(options.chunkOverlapWords, DEFAULT_CHUNK_OVERLAP)));
    this.now = options.now ?? (() => new Date());
    this.data = this.load();
  }

  get allowedRoots(): string[] {
    return [...this.roots];
  }

  stats(): DocumentStats {
    return {
      documents: this.data.documents.length,
      chunks: this.data.documents.reduce((sum, doc) => sum + doc.chunks.length, 0),
      terms: this.vocabularySize(),
      roots: [...this.roots],
      dataDir: this.dataDir,
      updatedAt: this.data.updatedAt || null,
    };
  }

  list(): Array<{ path: string; title: string; chunks: number; exists: boolean; indexedAt: string }> {
    return this.data.documents
      .map((doc) => ({
        path: doc.path,
        title: doc.title,
        chunks: doc.chunks.length,
        exists: fs.existsSync(doc.path),
        indexedAt: doc.indexedAt,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Index one or more files/directories. Re-indexing replaces prior chunks. */
  indexPaths(inputs: string[]): DocumentIndexResult {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new IntelligenceInputError('indexPaths requires at least one file or directory');
    }
    const result: DocumentIndexResult = {
      indexed: [],
      skippedUnsupported: [],
      errors: [],
      filesConsidered: 0,
      limits: { maxFiles: this.maxFiles, maxFileBytes: this.maxFileBytes },
    };
    const seen = new Set<string>();

    for (const input of inputs) {
      let target: string;
      try {
        target = this.resolveAllowed(input);
      } catch (error) {
        result.errors.push({ path: String(input), error: messageOf(error) });
        continue;
      }
      if (!fs.existsSync(target)) {
        result.errors.push({ path: target, error: 'path does not exist' });
        continue;
      }
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        this.walkDirectory(target, result, seen);
      } else if (stat.isFile()) {
        this.indexFile(target, result, seen);
      } else {
        result.errors.push({ path: target, error: 'not a regular file or directory' });
      }
      if (result.filesConsidered >= this.maxFiles) break;
    }

    if (result.indexed.some((entry) => !entry.skipped)) {
      this.data.updatedAt = this.now().toISOString();
      this.resetCaches();
      this.persist();
    }
    return result;
  }

  search(query: string, limit = 8): DocumentHit[] {
    const q = normalizeQuery(query);
    const terms = [...new Set(tokenize(q))];
    if (terms.length === 0) return [];
    const topK = clampInt(limit, 1, 50);

    const chunks: Array<{ doc: IndexedDocument; chunk: DocumentChunk; tokens: string[] }> = [];
    for (const doc of this.data.documents) {
      for (const chunk of doc.chunks) {
        chunks.push({ doc, chunk, tokens: this.tokensFor(doc, chunk) });
      }
    }
    if (chunks.length === 0) return [];

    const avgLength = chunks.reduce((sum, entry) => sum + entry.tokens.length, 0) / chunks.length || 1;
    const documentFrequency = new Map<string, number>();
    for (const entry of chunks) {
      const unique = new Set(entry.tokens);
      for (const term of terms) {
        if (unique.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }

    const total = chunks.length;
    const k1 = 1.2;
    const b = 0.75;
    const lowerQuery = q.toLowerCase();
    const scored: Array<{ doc: IndexedDocument; chunk: DocumentChunk; score: number }> = [];

    for (const entry of chunks) {
      const frequencies = new Map<string, number>();
      for (const token of entry.tokens) {
        if (terms.includes(token)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }
      if (frequencies.size === 0) continue;
      let score = 0;
      for (const term of terms) {
        const tf = frequencies.get(term) ?? 0;
        if (tf === 0) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        const denominator = tf + k1 * (1 - b + (b * entry.tokens.length) / avgLength);
        score += idf * ((tf * (k1 + 1)) / denominator);
      }
      if (entry.chunk.text.toLowerCase().includes(lowerQuery)) score += 1.5;
      scored.push({ doc: entry.doc, chunk: entry.chunk, score });
    }

    return scored
      .sort((a, b2) => b2.score - a.score || a.doc.path.localeCompare(b2.doc.path))
      .slice(0, topK)
      .map((entry) => ({
        source: entry.doc.path,
        title: entry.doc.title,
        startLine: entry.chunk.startLine,
        endLine: entry.chunk.endLine,
        score: round(entry.score, 6),
        excerpt: excerptFor(entry.chunk.text, terms, 500),
        sha256: sha256(entry.chunk.text),
      }));
  }

  /** Extractive, citation-first answer. Withholds when nothing is indexed. */
  answer(query: string, limit = 5): DomainResult {
    const q = normalizeQuery(query);
    const hits = this.search(q, limit);
    if (hits.length === 0) {
      return {
        answer:
          'No indexed local document supports an answer to this question. ' +
          'Index a folder or file first, or ask a different question.',
        verification: 'unverified',
        confidence: 0,
        evidence: [],
        disclosures: [
          'No external or unindexed source was consulted; the subsystem does not guess from general knowledge.',
        ],
        data: { hits: [], query: q },
      };
    }

    const terms = [...new Set(tokenize(q))];
    const lines: string[] = [];
    const evidence: Evidence[] = [];
    const usedSentences = new Set<string>();
    let sources = 0;

    for (const hit of hits) {
      if (sources >= 3) break;
      const sentences = bestSentences(hit.excerpt, terms, 2);
      if (sentences.length === 0) continue;
      sources += 1;
      lines.push(`${sources}. ${sentences.join(' ')} [${hit.title}, lines ${hit.startLine}-${hit.endLine}]`);
      evidence.push({
        kind: 'document',
        label: hit.title,
        source: hit.source,
        locator: `lines ${hit.startLine}-${hit.endLine}`,
        excerpt: clip(hit.excerpt, 320),
        sha256: hit.sha256,
      });
      for (const sentence of sentences) usedSentences.add(sentence.toLowerCase());
    }

    if (lines.length === 0) {
      return {
        answer:
          'The indexed documents matched the query terms but produced no usable sentence. ' +
          'Try a more specific question.',
        verification: 'unverified',
        confidence: 0.1,
        evidence: [],
        disclosures: ['No sentence was quoted because every candidate was empty after extraction.'],
        data: { hits: hits.map(({ excerpt, ...rest }) => rest) },
      };
    }

    const topScore = hits[0]?.score ?? 0;
    const confidence = Math.min(0.95, 0.45 + Math.log1p(Math.max(0, topScore)) / 8);
    return {
      answer: `From ${sources} indexed local document${sources === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`,
      verification: 'grounded',
      confidence: round(confidence, 4),
      evidence,
      disclosures: [
        'Answers are extractive: quoted text comes from local files and is cited by source and line.',
        'No embedding model, network request, or general-knowledge guess was used.',
      ],
      data: {
        query: q,
        hits: hits.map(({ excerpt, ...rest }) => rest),
        citedSentences: [...usedSentences].length,
      },
    };
  }

  /** Remove a document from the index. Never deletes the underlying file. */
  forget(source: string): { removed: boolean; path: string } {
    const requested = String(source ?? '').trim();
    if (!requested) throw new IntelligenceInputError('forget requires a source path');
    let resolved = requested;
    try {
      resolved = this.resolveAllowed(requested);
    } catch {
      resolved = path.resolve(requested);
    }
    const before = this.data.documents.length;
    this.data.documents = this.data.documents.filter((doc) => doc.path !== resolved);
    const removed = this.data.documents.length !== before;
    if (removed) {
      this.data.updatedAt = this.now().toISOString();
      this.resetCaches();
      this.persist();
    }
    return { removed, path: resolved };
  }

  private walkDirectory(dir: string, result: DocumentIndexResult, seen: Set<string>): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      result.errors.push({ path: dir, error: messageOf(error) });
      return;
    }
    for (const entry of entries) {
      if (result.filesConsidered >= this.maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        this.walkDirectory(full, result, seen);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        result.skippedUnsupported.push(full);
        continue;
      }
      this.indexFile(full, result, seen);
    }
  }

  private indexFile(file: string, result: DocumentIndexResult, seen: Set<string>): void {
    const resolved = this.resolveAllowed(file);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    result.filesConsidered += 1;
    try {
      const stat = fs.statSync(resolved);
      if (stat.size > this.maxFileBytes) {
        result.errors.push({ path: resolved, error: `file exceeds ${this.maxFileBytes} bytes` });
        return;
      }
      const raw = fs.readFileSync(resolved, 'utf8');
      const text = normalizeDocumentText(resolved, raw);
      if (!text) {
        result.errors.push({ path: resolved, error: 'document is empty after text extraction' });
        return;
      }
      const chunks = chunkText(text, this.chunkWords, this.chunkOverlap);
      if (chunks.length === 0) {
        result.errors.push({ path: resolved, error: 'document produced no chunks' });
        return;
      }
      const doc: IndexedDocument = {
        path: resolved,
        title: titleOf(resolved),
        sha256: sha256(text),
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        indexedAt: this.now().toISOString(),
        chunks,
      };
      const previous = this.data.documents.findIndex((entry) => entry.path === resolved);
      if (previous >= 0) this.data.documents[previous] = doc;
      else this.data.documents.push(doc);
      this.data.documents.sort((a, b) => a.path.localeCompare(b.path));
      result.indexed.push({ path: resolved, title: doc.title, chunks: chunks.length, skipped: false });
    } catch (error) {
      result.errors.push({ path: resolved, error: messageOf(error) });
    }
  }

  private resolveAllowed(input: string): string {
    const candidate = path.resolve(String(input));
    let real: string;
    try {
      real = fs.realpathSync.native(candidate);
    } catch {
      // A missing path cannot be realpath'd; check it lexically now and let the
      // caller report "does not exist" without leaking outside the roots.
      real = candidate;
    }
    for (const root of this.roots) {
      if (isInside(real, root)) return real;
    }
    throw new IntelligenceSecurityError(
      `path is outside the configured document roots: ${candidate}`,
      { roots: this.roots }
    );
  }

  /** Unique indexed terms (vocabulary size), not the number of cached chunks. */
  private vocabularySize(): number {
    if (this.vocabularyCache !== null) return this.vocabularyCache;
    const terms = new Set<string>();
    for (const doc of this.data.documents) {
      for (const chunk of doc.chunks) {
        for (const token of this.tokensFor(doc, chunk)) terms.add(token);
      }
    }
    this.vocabularyCache = terms.size;
    return this.vocabularyCache;
  }

  private resetCaches(): void {
    this.tokenCache.clear();
    this.vocabularyCache = null;
  }

  private tokensFor(doc: IndexedDocument, chunk: DocumentChunk): string[] {
    const key = `${doc.sha256}:${chunk.id}`;
    const cached = this.tokenCache.get(key);
    if (cached) return cached;
    const tokens = tokenize(chunk.text);
    this.tokenCache.set(key, tokens);
    return tokens;
  }

  private load(): DocumentIndexData {
    const data = readJsonStore<DocumentIndexData>(this.indexPath, () => ({
      version: 1,
      updatedAt: '',
      roots: [...this.roots],
      documents: [],
    }));
    if (!data || data.version !== 1 || !Array.isArray(data.documents)) {
      throw new StoreCorruptionError(`unexpected document index shape in ${this.indexPath}`, {
        file: this.indexPath,
      });
    }
    return data;
  }

  private persist(): void {
    const payload: DocumentIndexData = { ...this.data, roots: [...this.roots] };
    writeJsonStore(this.indexPath, payload);
  }
}

function normalizeRoots(roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    const resolved = path.resolve(root);
    try {
      out.push(fs.realpathSync.native(resolved));
    } catch {
      out.push(resolved);
    }
  }
  return [...new Set(out)];
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function normalizeDocumentText(file: string, raw: string): string {
  const extension = path.extname(file).toLowerCase();
  const text = extension === '.html' || extension === '.htm' ? stripHtml(raw) : raw;
  return normalizeWhitespace(text);
}

function chunkText(text: string, size: number, overlap: number): DocumentChunk[] {
  const words: Array<{ value: string; offset: number }> = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    words.push({ value: match[0], offset: match.index });
  }
  if (words.length === 0) return [];
  const chunks: DocumentChunk[] = [];
  const step = Math.max(1, size - overlap);
  for (let start = 0; start < words.length; start += step) {
    const end = Math.min(words.length, start + size);
    const first = words[start];
    const last = words[end - 1];
    const startOffset = first.offset;
    const endOffset = last.offset + last.value.length;
    const slice = text.slice(startOffset, endOffset);
    chunks.push({
      id: `${start}-${end}`,
      startLine: lineNumberAt(text, startOffset),
      endLine: lineNumberAt(text, endOffset),
      text: slice,
    });
    if (end >= words.length) break;
  }
  return chunks;
}

function excerptFor(text: string, terms: string[], maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lower = text.toLowerCase();
  let best = 0;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0) {
      best = Math.max(0, index - Math.floor(maxChars / 3));
      break;
    }
  }
  return clip(text.slice(best, best + maxChars), maxChars);
}

function bestSentences(text: string, terms: string[], limit: number): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);
  const scored = sentences.map((sentence) => {
    const lower = sentence.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
    return { sentence, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.sentence);
}

function normalizeQuery(query: string): string {
  const value = typeof query === 'string' ? query.trim() : '';
  if (!value) throw new IntelligenceInputError('query must be a non-empty string');
  if (value.length > 4000) throw new IntelligenceInputError('query is too long (max 4000 chars)');
  return value;
}

function positiveInt(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function clampInt(value: unknown, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
