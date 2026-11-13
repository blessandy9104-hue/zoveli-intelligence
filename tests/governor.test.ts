import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { genesisHash } from '../src/audit.js';
import { IntelligenceInputError } from '../src/errors.js';
import { createIntelligence } from '../src/index.js';
import type { IntelligenceGovernor } from '../src/governor.js';
import { createWorkspace, fixedClock, writeFile, type Workspace } from './helpers.js';

describe('IntelligenceGovernor', () => {
  let ws: Workspace;
  let governor: IntelligenceGovernor;

  beforeEach(() => {
    ws = createWorkspace();
    governor = createIntelligence({
      dataDir: ws.dataDir,
      roots: [ws.root],
      now: fixedClock(),
    });
  });

  afterEach(() => ws.cleanup());

  it('routes intents to the matching deterministic domain', () => {
    expect(governor.route('What do my notes say about the manual?').domain.id).toBe('documents');
    expect(governor.route('Interpret RSI and volatility for this stock').domain.id).toBe('market');
    expect(governor.route('Make me a plan with steps for moving').domain.id).toBe('planning');
    expect(governor.route('Record my preference for more detail').domain.id).toBe('preferences');
  });

  it('falls back to documents for unmatched queries', () => {
    const decision = governor.route('tell me something');
    expect(decision.domain.id).toBe('documents');
    expect(decision.score).toBe(0);
  });

  it('honors an explicit domain override and lists alternatives', () => {
    const decision = governor.route('Interpret RSI and volatility for this stock', 'planning');
    expect(decision.domain.id).toBe('planning');
    expect(decision.score).toBe(1);
    expect(decision.alternatives.length).toBeGreaterThan(0);
    expect(() => governor.route('hello', 'nope' as never)).toThrow(IntelligenceInputError);
  });

  it('withholds document answers when nothing is indexed', async () => {
    const result = await governor.ask({ query: 'What do my notes say about the manual?' });

    expect(result.domain).toBe('documents');
    expect(result.routedBy).toBe('keyword');
    expect(result.verification).toBe('unverified');
    expect(result.evidence).toEqual([]);
    expect(result.receipt.domain).toBe('documents');
    expect(result.receipt.verification).toBe('unverified');
    expect(result.receipt.id).toHaveLength(16);
    expect(result.receipt.prevHash).toHaveLength(64);
  });

  it('answers grounded document questions with a receipt', async () => {
    writeFile(ws.root, 'manual.md', 'The reset button is under the desk. Hold it for five seconds to reboot.');
    governor.documents.indexPaths([ws.root]);

    const result = await governor.ask({
      query: 'Where is the reset button on the manual?',
      domain: 'documents',
    });

    expect(result.domain).toBe('documents');
    expect(result.routedBy).toBe('explicit');
    expect(result.verification).toBe('grounded');
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.answer).toContain('reset button');
    expect(result.receipt.verification).toBe('grounded');
  });

  it('runs deterministic market interpretation and requires prices', async () => {
    const prices = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
    const result = await governor.ask({
      query: 'Interpret this price window',
      domain: 'market',
      payload: { prices, instrument: 'equity' },
    });

    expect(result.domain).toBe('market');
    expect(result.verification).toBe('verified');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.evidence[0].kind).toBe('computation');
    expect(result.receipt.verification).toBe('verified');

    await expect(
      governor.ask({ query: 'Interpret this price window', domain: 'market', payload: {} })
    ).rejects.toBeInstanceOf(IntelligenceInputError);
    await expect(
      governor.ask({
        query: 'Interpret this price window',
        domain: 'market',
        payload: { prices, instrument: { type: 'equity' } },
      })
    ).resolves.toMatchObject({ verification: 'verified' });
  });

  it('returns advisory plans with plan evidence', async () => {
    const result = await governor.ask({
      query: 'Build a local search feature',
      domain: 'planning',
      payload: { constraints: ['no network'], deadline: '2099-01-01' },
    });

    expect(result.domain).toBe('planning');
    expect(result.verification).toBe('advisory');
    expect(result.evidence[0].kind).toBe('plan');
    expect(result.data?.category).toBe('build');
    expect(result.receipt.verification).toBe('advisory');
  });

  it('keeps empty preference lists unverified and records explicit feedback', async () => {
    const empty = await governor.ask({
      query: 'List owner preferences',
      domain: 'preferences',
      payload: { action: 'list' },
    });
    expect(empty.verification).toBe('unverified');
    expect(empty.evidence).toEqual([]);

    const recorded = await governor.ask({
      query: 'Record owner preference feedback',
      domain: 'preferences',
      payload: { action: 'record', category: 'coding', signal: 'more_detail' },
    });
    expect(recorded.verification).toBe('advisory');
    expect(recorded.evidence).toHaveLength(1);
    expect(recorded.data?.category).toBe('coding');

    const listed = await governor.ask({
      query: 'List owner preferences',
      domain: 'preferences',
      payload: { action: 'list' },
    });
    expect(listed.verification).toBe('advisory');
    expect(listed.answer).toContain('coding');
    expect(governor.status().preferences.categories).toBe(1);

    const fetched = await governor.ask({
      query: 'Read owner preferences',
      domain: 'preferences',
      payload: { action: 'get', category: 'coding' },
    });
    expect(fetched.data?.category).toBe('coding');
  });

  it('rejects malformed requests at the boundary', async () => {
    await expect(governor.ask(null as never)).rejects.toBeInstanceOf(IntelligenceInputError);
    await expect(governor.ask({ query: '  ' })).rejects.toBeInstanceOf(IntelligenceInputError);
    await expect(governor.ask({ query: 'x'.repeat(4001) })).rejects.toBeInstanceOf(IntelligenceInputError);
    await expect(
      governor.ask({ query: 'hello', domain: 'documents', payload: [] as never })
    ).rejects.toBeInstanceOf(IntelligenceInputError);
    await expect(
      governor.ask({ query: 'hello', domain: 'preferences', payload: { action: 'nope' } })
    ).rejects.toBeInstanceOf(IntelligenceInputError);
    await expect(
      governor.ask({ query: 'hello', domain: 'preferences', payload: { action: 'record' } })
    ).rejects.toBeInstanceOf(IntelligenceInputError);
    await expect(
      governor.ask({ query: 'hello', domain: 'preferences', payload: { action: 'get' } })
    ).rejects.toBeInstanceOf(IntelligenceInputError);
  });

  it('seals store mutations and keeps one verifiable chain', async () => {
    const before = governor.audit.count;
    const tipBefore = governor.audit.tip;
    const receipt = governor.seal('documents', { paths: [ws.root] }, 'indexed 0 files');
    expect(receipt.prevHash).toBe(tipBefore);
    expect(tipBefore).toBe(genesisHash());

    await governor.ask({
      query: 'Build a local search feature',
      domain: 'planning',
    });
    const verification = governor.verifyAudit();
    expect(verification.ok).toBe(true);
    expect(verification.entries).toBe(before + 2);
    expect(verification.tipHash).toBe(governor.audit.tip);
  });

  it('detects tampering after real requests', async () => {
    await governor.ask({ query: 'Build a local search feature', domain: 'planning' });
    await governor.ask({ query: 'List owner preferences', domain: 'preferences' });

    const lines = fs.readFileSync(governor.auditPath, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    entry.domain = 'tampered';
    lines[0] = JSON.stringify(entry);
    fs.writeFileSync(governor.auditPath, `${lines.join('\n')}\n`, 'utf8');

    const verification = governor.verifyAudit();
    expect(verification.ok).toBe(false);
    expect(verification.problems.length).toBeGreaterThan(0);
  });

  it('reports status and model tier support', () => {
    const status = governor.status();
    expect(status.name).toBe('@zoveli/intelligence');
    expect(status.domains).toHaveLength(4);
    expect(status.documents.documents).toBe(0);
    expect(status.audit.entries).toBe(0);
    expect(governor.supports('tiny')).toBe(true);
    expect(governor.supports('large')).toBe(true);
  });
});
