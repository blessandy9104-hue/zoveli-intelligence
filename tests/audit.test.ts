import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditChain, genesisHash } from '../src/audit.js';
import { AuditIntegrityError } from '../src/errors.js';
import { createWorkspace, fixedClock, type Workspace } from './helpers.js';

describe('AuditChain', () => {
  let ws: Workspace;
  let logPath: string;

  beforeEach(() => {
    ws = createWorkspace();
    logPath = path.join(ws.dataDir, 'audit.jsonl');
  });

  afterEach(() => ws.cleanup());

  it('starts at genesis and chains each receipt to the prior hash', () => {
    const chain = new AuditChain(logPath, fixedClock());
    const first = chain.append({
      domain: 'documents',
      verification: 'grounded',
      requestHash: 'a'.repeat(64),
      answerHash: 'b'.repeat(64),
    });
    const second = chain.append({
      domain: 'market',
      verification: 'verified',
      requestHash: 'c'.repeat(64),
      answerHash: 'd'.repeat(64),
    });

    expect(first.prevHash).toBe(genesisHash());
    expect(second.prevHash).toBe(first.hash);
    expect(first.id).toBe(first.hash.slice(0, 16));
    expect(chain.count).toBe(2);
    expect(chain.tip).toBe(second.hash);
    expect(chain.verify().ok).toBe(true);
  });

  it('verifies a clean chain and reports the tip', () => {
    const chain = new AuditChain(logPath, fixedClock());
    chain.append({ domain: 'planning', verification: 'advisory', requestHash: '1'.repeat(64), answerHash: '2'.repeat(64) });
    const third = chain.append({ domain: 'preferences', verification: 'advisory', requestHash: '3'.repeat(64), answerHash: '4'.repeat(64) });

    const verification = chain.verify();
    expect(verification).toMatchObject({ ok: true, entries: 2, tipHash: third.hash, problems: [] });
  });

  it('detects a tampered entry by hash mismatch and chain break', () => {
    const chain = new AuditChain(logPath, fixedClock());
    chain.append({ domain: 'documents', verification: 'grounded', requestHash: 'a'.repeat(64), answerHash: 'b'.repeat(64) });
    chain.append({ domain: 'market', verification: 'verified', requestHash: 'c'.repeat(64), answerHash: 'd'.repeat(64) });

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    entry.answerHash = 'f'.repeat(64);
    lines[0] = JSON.stringify(entry);
    fs.writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');

    const verification = chain.verify();
    expect(verification.ok).toBe(false);
    expect(verification.problems.some((problem) => problem.line === 1 && problem.issue === 'hash mismatch')).toBe(true);
    expect(verification.problems).toHaveLength(1);
  });

  it('returns the requested tail in order', () => {
    const chain = new AuditChain(logPath, fixedClock());
    const receipts = ['documents', 'market', 'planning'].map((domain) =>
      chain.append({ domain, verification: 'advisory', requestHash: 'a'.repeat(64), answerHash: 'b'.repeat(64) })
    );

    expect(chain.tail(2).map((receipt) => receipt.hash)).toEqual([receipts[1].hash, receipts[2].hash]);
    expect(chain.tail(0)).toEqual([]);
  });

  it('refuses to append when the tip is not valid JSON', () => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '{not-json\n', 'utf8');
    expect(() => new AuditChain(logPath)).toThrow(AuditIntegrityError);
  });

  it('reports malformed lines during verification', () => {
    const chain = new AuditChain(logPath, fixedClock());
    chain.append({ domain: 'documents', verification: 'grounded', requestHash: 'a'.repeat(64), answerHash: 'b'.repeat(64) });
    fs.appendFileSync(logPath, 'garbage\n', 'utf8');

    const verification = chain.verify();
    expect(verification.ok).toBe(false);
    expect(verification.problems.some((problem) => problem.issue === 'invalid JSON')).toBe(true);
  });

  it('treats a missing log as an empty clean chain', () => {
    const chain = new AuditChain(logPath);
    expect(chain.count).toBe(0);
    expect(chain.verify()).toMatchObject({ ok: true, entries: 0 });
    expect(chain.tail()).toEqual([]);
  });
});
