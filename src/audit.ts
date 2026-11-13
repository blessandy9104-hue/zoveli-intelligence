import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuditIntegrityError } from './errors.js';
import { appendLine, ensureDir } from './store.js';
import { hashObject, sha256, stableStringify } from './text.js';
import type { Receipt, VerificationLevel } from './types.js';

const GENESIS_HASH = sha256('zoveli-intelligence-genesis');

export interface AuditAppendInput {
  domain: string;
  verification: VerificationLevel;
  requestHash: string;
  answerHash: string;
}

export interface AuditVerification {
  ok: boolean;
  entries: number;
  tipHash: string;
  problems: Array<{ line: number; issue: string; event?: string }>;
}

/**
 * Append-only SHA-256 hash chain. Entries contain hashes and routing metadata,
 * not raw queries or document text, so the audit trail stays useful without
 * becoming a second copy of private data.
 */
export class AuditChain {
  readonly path: string;
  private readonly now: () => Date;
  private tipHash: string;
  private entryCount: number;

  constructor(logPath: string, now: () => Date = () => new Date()) {
    this.path = path.resolve(logPath);
    this.now = now;
    const tip = readTip(this.path);
    this.tipHash = tip.hash;
    this.entryCount = tip.count;
  }

  get tip(): string {
    return this.tipHash;
  }

  get count(): number {
    return this.entryCount;
  }

  append(input: AuditAppendInput): Receipt {
    const entry = {
      ts: this.now().toISOString(),
      domain: input.domain,
      verification: input.verification,
      requestHash: input.requestHash,
      answerHash: input.answerHash,
      prevHash: this.tipHash,
    };
    const hash = hashObject(entry);
    const receipt: Receipt = {
      ...entry,
      id: hash.slice(0, 16),
      hash,
    };
    appendLine(this.path, stableStringify(receipt));
    this.tipHash = hash;
    this.entryCount += 1;
    return receipt;
  }

  verify(): AuditVerification {
    const problems: AuditVerification['problems'] = [];
    let previous = GENESIS_HASH;
    let entries = 0;
    let content: string;
    try {
      content = fs.readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true, entries: 0, tipHash: GENESIS_HASH, problems: [] };
      }
      throw new AuditIntegrityError(`cannot read audit log: ${(error as Error).message}`, {
        path: this.path,
      });
    }

    let lineNumber = 0;
    for (const line of content.split('\n')) {
      lineNumber += 1;
      if (!line.trim()) continue;
      entries += 1;
      let entry: Receipt;
      try {
        entry = JSON.parse(line) as Receipt;
      } catch {
        problems.push({ line: lineNumber, issue: 'invalid JSON' });
        break;
      }
      const { hash, ...rest } = entry;
      const payload: Record<string, unknown> = { ...rest };
      // `id` is derived from the hash, so it is not part of the hashed payload.
      delete payload.id;
      const expected = hashObject(payload);
      if (hash !== expected) {
        problems.push({ line: lineNumber, issue: 'hash mismatch', event: entry.domain });
      }
      if (entry.prevHash !== previous) {
        problems.push({ line: lineNumber, issue: 'chain break', event: entry.domain });
      }
      previous = typeof hash === 'string' ? hash : '';
    }

    const ok = problems.length === 0;
    return { ok, entries, tipHash: previous || GENESIS_HASH, problems };
  }

  tail(limit = 10): Receipt[] {
    if (limit <= 0) return [];
    let content: string;
    try {
      content = fs.readFileSync(this.path, 'utf8');
    } catch {
      return [];
    }
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit);
    const out: Receipt[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as Receipt);
      } catch {
        // ignore malformed tail lines; verify() reports them
      }
    }
    return out;
  }
}

function readTip(file: string): { hash: string; count: number } {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { hash: GENESIS_HASH, count: 0 };
    }
    throw new AuditIntegrityError(`cannot read audit log: ${(error as Error).message}`, { file });
  }
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { hash: GENESIS_HASH, count: 0 };
  const last = lines[lines.length - 1];
  let entry: Receipt;
  try {
    entry = JSON.parse(last) as Receipt;
  } catch {
    throw new AuditIntegrityError('audit log tip is not valid JSON; refusing to append', { file });
  }
  if (typeof entry.hash !== 'string' || entry.hash.length !== 64) {
    throw new AuditIntegrityError('audit log tip has no valid hash; refusing to append', { file });
  }
  return { hash: entry.hash, count: lines.length };
}

export function genesisHash(): string {
  return GENESIS_HASH;
}

export function auditLogPathFor(dataDir: string): string {
  ensureDir(dataDir);
  return path.join(dataDir, 'audit.jsonl');
}
