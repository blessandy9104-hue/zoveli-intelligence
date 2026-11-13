import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, writeFile, type Workspace } from './helpers.js';

const CLI = path.resolve('dist', 'cli.js');

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], input?: string): RunResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    input,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runJson<T = Record<string, any>>(args: string[]): T {
  const result = run(args);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

describe('zoveli-intel CLI', () => {
  let ws: Workspace;
  let doc: string;

  beforeEach(() => {
    ws = createWorkspace();
    doc = writeFile(
      ws.root,
      'runbook.md',
      'Restart the gateway with the blue button. The maintenance window is Monday at 09:00.'
    );
  });

  afterEach(() => ws.cleanup());

  function base(extra: string[] = []): string[] {
    return ['--data-dir', ws.dataDir, '--root', ws.root, ...extra];
  }

  it('prints help and version', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('zoveli-intel');

    const version = run(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe('0.1.0');
  });

  it('reports status as JSON', () => {
    const status = runJson<Record<string, any>>(base(['status', '--json']));
    expect(status.name).toBe('@zoveli/intelligence');
    expect(status.domains).toHaveLength(4);
    expect(status.audit.entries).toBe(0);
  });

  it('indexes, searches, answers, lists, and forgets documents', () => {
    const indexed = runJson<Record<string, any>>(base(['docs', 'index', ws.root, '--json']));
    expect(indexed.indexed).toHaveLength(1);
    expect(indexed.receipt.domain).toBe('documents');

    const search = runJson<Record<string, any>>(base(['docs', 'search', 'blue', 'button', '--json']));
    expect(search.count).toBeGreaterThan(0);

    const answer = run(base(['docs', 'answer', 'How do I restart', 'the gateway?']));
    expect(answer.status).toBe(0);
    expect(answer.stdout).toContain('grounded');
    expect(answer.stdout).toContain('blue button');
    expect(answer.stdout).toContain('Receipt:');

    const list = runJson<Record<string, any>>(base(['docs', 'list', '--json']));
    expect(list.documents).toHaveLength(1);

    const stats = runJson<Record<string, any>>(base(['docs', 'stats', '--json']));
    expect(stats.terms).toBeGreaterThan(0);

    const forgot = runJson<Record<string, any>>(base(['docs', 'forget', doc, '--json']));
    expect(forgot.removed).toBe(true);
  });

  it('interprets a market CSV window as JSON', () => {
    const result = runJson<Record<string, any>>(
      base(['market', '100,101,102,103,104,105,106', '--instrument', 'equity', '--json'])
    );
    expect(result.domain).toBe('market');
    expect(result.verification).toBe('verified');
    expect(result.data.interpretation.trend.kind).toBe('uptrend');
  });

  it('creates a plan and records preferences', () => {
    const plan = runJson<Record<string, any>>(
      base([
        'plan',
        'Build',
        'a',
        'local',
        'search',
        'feature',
        '--constraint',
        'no network',
        '--deadline',
        '2099-01-01',
        '--json',
      ])
    );
    expect(plan.domain).toBe('planning');
    expect(plan.data.steps.length).toBeGreaterThan(0);

    const recorded = runJson<Record<string, any>>(base(['prefs', 'record', 'coding', 'more_detail', '--json']));
    expect(recorded.data.signals.more_detail).toBe(1);

    const listed = runJson<Record<string, any>>(base(['prefs', 'list', '--json']));
    expect(listed.answer).toContain('coding');
  });

  it('verifies and tails the audit chain', () => {
    runJson(base(['plan', 'Build', 'a', 'local', 'search', 'feature', '--json']));
    const verification = runJson<Record<string, any>>(base(['audit', 'verify', '--json']));
    expect(verification.ok).toBe(true);
    expect(verification.entries).toBe(1);

    const tail = runJson<Record<string, any>>(base(['audit', 'tail', '1', '--json']));
    expect(tail.receipts).toHaveLength(1);
    expect(tail.receipts[0].domain).toBe('planning');
  });

  it('returns usage and input errors with non-zero exit codes', () => {
    const unknown = run(base(['nonsense']));
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('Unknown command');

    const missing = run(base(['ask']));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('INTEL_INPUT');

    const outside = writeFile(ws.base, 'outside.md', 'Not allowed.');
    const refused = run(base(['docs', 'index', outside]));
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('outside the configured document roots');
  });

  it('serves an MCP handshake over stdio', () => {
    const input = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      '',
    ].join('\n');
    const result = run(['mcp', '--data-dir', ws.dataDir, '--root', ws.root], input);

    expect(result.status, result.stderr).toBe(0);
    const responses = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
    expect(responses).toHaveLength(2);
    expect(responses[0].result.protocolVersion).toBe('2025-06-18');
    expect(responses[1].result.tools).toHaveLength(16);
  });
});
