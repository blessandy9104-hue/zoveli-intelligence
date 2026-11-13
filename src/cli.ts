#!/usr/bin/env node
import * as fs from 'node:fs';
import { createIntelligence } from './index.js';
import { INTELLIGENCE_VERSION } from './governor.js';
import { IntelligenceError, IntelligenceInputError } from './errors.js';
import { runMcpServer } from './mcp.js';
import { createIntelligenceTools } from './tools.js';
import type { DomainId, IntelligenceResult, PreferenceSignal } from './types.js';

const HELP = `zoveli-intel — local-first deterministic intelligence

Usage:
  zoveli-intel <command> [options]

Commands:
  status                          Show subsystem, index, preference, and audit status.
  route <query>                   Show domain routing without running a domain.
  ask <query>                     Route and answer a question.
  docs index <path...>            Index local files or folders.
  docs search <query>             BM25 search over the local index.
  docs answer <query>             Extractive, cited answer from local documents.
  docs list                       List indexed documents.
  docs forget <source>            Remove one document from the index.
  docs stats                      Show index totals.
  market <csv | --file <json>>    Interpret a price window (interpretation only).
  plan <objective>                Create a deterministic, reviewable plan.
  prefs list                      List recorded preference categories.
  prefs get <category>            Show one category's style bias.
  prefs record <category> <sig>   Record explicit feedback (e.g. more_detail).
  audit verify                    Verify the SHA-256 receipt chain.
  audit tail [limit]              Show the most recent receipts.
  mcp                             Serve MCP over stdio (newline-delimited JSON-RPC).

Global options:
  --data-dir <path>    Local state directory (default: ~/.zoveli/intelligence).
  --root <path>        Allowlisted document root; repeatable (default: cwd).
  --json               Print machine-readable JSON.
  --help, -h           Show help.
  --version, -v        Print the version.

Command options:
  --domain <id>        documents | market | planning | preferences
  --payload <json>     Domain payload for ask (market needs prices + instrument).
  --limit <n>          Result limit for search, answer, audit tail.
  --constraint <text>  Plan constraint; repeatable.
  --deadline <date>    Plan deadline.
  --context <text>     Plan context (treated as unverified input).
  --instrument <type>  equity_index | equity | commodity | fx | crypto | treasury
  --timeframe <tf>     1m | 5m | 15m | 1h | 4h | 1d | 1w
  --file <path>        Read market input from a JSON file.
`;

const BOOLEAN_FLAGS = new Set(['json', 'help', 'version']);
const PREFERENCE_SIGNALS: readonly PreferenceSignal[] = [
  'too_technical', 'too_vague', 'more_detail', 'less_detail', 'liked', 'disliked',
];

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
  booleans: Set<string>;
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.booleans.has('help') || parsed.positionals[0] === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (parsed.booleans.has('version')) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  const command = parsed.positionals[0];
  if (!command) {
    process.stdout.write(HELP);
    process.exitCode = 2;
    return;
  }
  const rest = parsed.positionals.slice(1);
  const json = parsed.booleans.has('json');
  const dataDir = getFlag(parsed, 'data-dir');
  const roots = getFlags(parsed, 'root');
  const governor = createIntelligence({
    dataDir,
    roots: roots.length > 0 ? roots : undefined,
  });

  if (command === 'mcp') {
    const tools = createIntelligenceTools(governor);
    await runMcpServer({
      tools,
      serverInfo: { name: governor.name, version: governor.version },
    });
    return;
  }

  switch (command) {
    case 'status': {
      const status = governor.status();
      if (json) return printJson(status);
      printStatus(status);
      return;
    }
    case 'route': {
      const query = requireQuery(rest, 'route');
      const domain = getFlag(parsed, 'domain') as DomainId | undefined;
      const decision = governor.route(query, domain);
      if (json) {
        return printJson({
          domain: decision.domain.id,
          name: decision.domain.name,
          score: decision.score,
          verification: decision.domain.verification,
          minModelTier: decision.domain.minModelTier,
          alternatives: decision.alternatives.map((candidate) => ({
            domain: candidate.domain.id,
            score: candidate.score,
          })),
        });
      }
      console.log(`${decision.domain.id}  ${decision.domain.name}`);
      console.log(
        `score ${decision.score}  verification ${decision.domain.verification}  ` +
          `min model ${decision.domain.minModelTier}`
      );
      if (decision.alternatives.length > 0) {
        console.log('Alternatives:');
        for (const candidate of decision.alternatives) {
          console.log(`  ${candidate.domain.id}  score ${candidate.score}`);
        }
      }
      return;
    }
    case 'ask': {
      const query = requireQuery(rest, 'ask');
      const payload = parsePayloadFlag(parsed);
      const result = await governor.ask({
        query,
        domain: getFlag(parsed, 'domain') as DomainId | undefined,
        payload,
        limits: { maxResults: optionalInt(parsed, 'limit') },
      });
      if (json) return printJson(result);
      printAskResult(result);
      return;
    }
    case 'docs':
      await handleDocs(governor, rest, parsed, json);
      return;
    case 'market': {
      const input = readMarketInput(rest, parsed);
      const result = await governor.ask({
        query: 'Interpret the supplied price window.',
        domain: 'market',
        payload: input,
      });
      if (json) return printJson(result);
      printAskResult(result);
      return;
    }
    case 'plan': {
      const objective = requireQuery(rest, 'plan');
      const result = await governor.ask({
        query: objective,
        domain: 'planning',
        payload: {
          constraints: getFlags(parsed, 'constraint'),
          deadline: getFlag(parsed, 'deadline') ?? '',
          context: getFlag(parsed, 'context') ?? '',
        },
      });
      if (json) return printJson(result);
      printAskResult(result);
      return;
    }
    case 'prefs':
      await handlePrefs(governor, rest, parsed, json);
      return;
    case 'audit': {
      const action = rest[0] ?? 'verify';
      if (action === 'verify') {
        const verification = governor.verifyAudit();
        if (json) return printJson(verification);
        console.log(verification.ok ? 'Audit chain OK' : 'Audit chain BROKEN');
        console.log(`Entries: ${verification.entries}`);
        console.log(`Tip: ${verification.tipHash}`);
        for (const problem of verification.problems) {
          console.log(`  line ${problem.line}: ${problem.issue}`);
        }
        if (!verification.ok) process.exitCode = 1;
        return;
      }
      if (action === 'tail') {
        const limit = rest[1] ? parseInteger(rest[1], 'limit') : optionalInt(parsed, 'limit') ?? 10;
        const receipts = governor.audit.tail(limit);
        if (json) return printJson({ receipts });
        if (receipts.length === 0) {
          console.log('No receipts recorded.');
          return;
        }
        for (const receipt of receipts) {
          console.log(
            `${receipt.ts}  ${receipt.domain.padEnd(12)} ${receipt.verification.padEnd(11)} ` +
              `${receipt.id}  prev ${receipt.prevHash.slice(0, 12)}`
          );
        }
        return;
      }
      throw new IntelligenceInputError(`unknown audit action: ${action}`, {
        allowed: ['verify', 'tail'],
      });
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

async function handleDocs(
  governor: ReturnType<typeof createIntelligence>,
  rest: string[],
  parsed: ParsedArgs,
  json: boolean
): Promise<void> {
  const action = rest[0] ?? 'list';
  const tail = rest.slice(1);
  switch (action) {
    case 'index': {
      if (tail.length === 0) {
        throw new IntelligenceInputError('docs index requires at least one file or folder path');
      }
      const result = governor.documents.indexPaths(tail);
      const receipt = governor.seal('documents', { paths: tail }, `indexed ${result.indexed.length} files`);
      if (result.indexed.length === 0 && result.errors.length > 0) process.exitCode = 1;
      if (json) return printJson({ ...result, receipt });
      console.log(`Indexed ${result.indexed.length} file(s); considered ${result.filesConsidered}.`);
      for (const entry of result.indexed) {
        console.log(`  ${entry.chunks} chunks  ${entry.path}`);
      }
      if (result.errors.length > 0) {
        console.log('Errors:');
        for (const error of result.errors) console.log(`  ${error.path}: ${error.error}`);
      }
      console.log(`Receipt: ${receipt.id}`);
      return;
    }
    case 'search': {
      const query = requireQuery(tail, 'docs search');
      const hits = governor.documents.search(query, optionalInt(parsed, 'limit') ?? 8);
      if (json) return printJson({ query, count: hits.length, hits });
      if (hits.length === 0) {
        console.log('No indexed local document matched.');
        return;
      }
      for (const hit of hits) {
        console.log(`${hit.score.toFixed(3)}  ${hit.title}  (${hit.source}:${hit.startLine}-${hit.endLine})`);
        console.log(`  ${hit.excerpt.slice(0, 240).replace(/\s+/g, ' ')}`);
      }
      return;
    }
    case 'answer': {
      const query = requireQuery(tail, 'docs answer');
      const result = await governor.ask({
        query,
        domain: 'documents',
        limits: { maxResults: optionalInt(parsed, 'limit') },
      });
      if (json) return printJson(result);
      printAskResult(result);
      return;
    }
    case 'list': {
      const documents = governor.documents.list();
      if (json) return printJson({ documents });
      if (documents.length === 0) {
        console.log('No documents indexed.');
        return;
      }
      for (const doc of documents) {
        console.log(`${doc.chunks} chunks  ${doc.exists ? 'present' : 'MISSING'}  ${doc.path}`);
      }
      return;
    }
    case 'forget': {
      if (!tail[0]) throw new IntelligenceInputError('docs forget requires a source path');
      const result = governor.documents.forget(tail[0]);
      const receipt = governor.seal('documents', { source: tail[0] }, `removed=${result.removed}`);
      if (json) return printJson({ ...result, receipt });
      console.log(result.removed ? `Removed from index: ${result.path}` : `Not indexed: ${result.path}`);
      console.log(`Receipt: ${receipt.id}`);
      return;
    }
    case 'stats': {
      const stats = governor.documents.stats();
      if (json) return printJson(stats);
      console.log(`Documents: ${stats.documents}`);
      console.log(`Chunks: ${stats.chunks}`);
      console.log(`Vocabulary terms: ${stats.terms}`);
      console.log(`Roots: ${stats.roots.join(', ')}`);
      console.log(`Updated: ${stats.updatedAt ?? 'never'}`);
      return;
    }
    default:
      throw new IntelligenceInputError(`unknown docs action: ${action}`, {
        allowed: ['index', 'search', 'answer', 'list', 'forget', 'stats'],
      });
  }
}

async function handlePrefs(
  governor: ReturnType<typeof createIntelligence>,
  rest: string[],
  parsed: ParsedArgs,
  json: boolean
): Promise<void> {
  const action = rest[0] ?? 'list';
  if (action === 'list') {
    const result = await governor.ask({
      query: 'List owner preferences.',
      domain: 'preferences',
      payload: { action: 'list' },
    });
    if (json) return printJson(result);
    printAskResult(result);
    return;
  }
  if (action === 'get') {
    const category = rest[1];
    if (!category) throw new IntelligenceInputError('prefs get requires a category');
    const result = await governor.ask({
      query: 'Read owner preferences.',
      domain: 'preferences',
      payload: { action: 'get', category },
    });
    if (json) return printJson(result);
    printAskResult(result);
    return;
  }
  if (action === 'record') {
    const category = rest[1];
    const signal = rest[2];
    if (!category || !signal) {
      throw new IntelligenceInputError('prefs record requires <category> <signal>');
    }
    if (!PREFERENCE_SIGNALS.includes(signal as PreferenceSignal)) {
      throw new IntelligenceInputError(`unknown preference signal: ${signal}`, {
        allowed: PREFERENCE_SIGNALS,
      });
    }
    const result = await governor.ask({
      query: 'Record owner preference feedback.',
      domain: 'preferences',
      payload: { action: 'record', category, signal },
    });
    if (json) return printJson(result);
    printAskResult(result);
    return;
  }
  throw new IntelligenceInputError(`unknown prefs action: ${action}`, {
    allowed: ['list', 'get', 'record'],
  });
}

function readMarketInput(rest: string[], parsed: ParsedArgs): Record<string, unknown> {
  const file = getFlag(parsed, 'file');
  let prices: unknown;
  let instrument: unknown = getFlag(parsed, 'instrument') ?? 'equity';
  let timeframe = getFlag(parsed, 'timeframe');
  let context: unknown;
  if (file) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new IntelligenceInputError(`cannot read ${file}: ${messageOf(error)}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new IntelligenceInputError(`invalid JSON in ${file}: ${messageOf(error)}`);
    }
    if (Array.isArray(value)) {
      prices = value;
    } else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      prices = object.prices;
      if (object.instrument !== undefined) instrument = object.instrument;
      if (typeof object.timeframe === 'string') timeframe = object.timeframe;
      context = object.context;
    } else {
      throw new IntelligenceInputError('market file must contain a price array or { prices, instrument, timeframe }');
    }
  } else if (rest.length > 0) {
    prices = rest
      .join(',')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const value = Number(entry);
        if (!Number.isFinite(value)) {
          throw new IntelligenceInputError(`invalid price value: ${entry}`);
        }
        return value;
      });
  } else {
    const flagPrices = getFlag(parsed, 'prices');
    if (!flagPrices) {
      throw new IntelligenceInputError('market requires a CSV price list, --file, or --prices');
    }
    prices = flagPrices.split(',').map((entry) => Number(entry.trim()));
  }
  if (!Array.isArray(prices) || prices.length === 0) {
    throw new IntelligenceInputError('market input must include a non-empty prices array');
  }
  const payload: Record<string, unknown> = { prices, instrument };
  if (typeof timeframe === 'string' && timeframe) {
    payload.instrument = { type: instrument, timeframe };
  }
  if (context !== undefined) payload.context = context;
  return payload;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printAskResult(result: IntelligenceResult): void {
  console.log(result.answer);
  console.log('');
  console.log(
    `Domain: ${result.domain} (${result.routedBy}, score ${result.routeScore})  ` +
      `Verification: ${result.verification}  Confidence: ${result.confidence}`
  );
  console.log(`Receipt: ${result.receipt.id} (${result.receipt.hash.slice(0, 16)}…)`);
  if (result.evidence.length > 0) {
    console.log('Evidence:');
    for (const item of result.evidence) {
      const where = item.locator ? ` — ${item.locator}` : '';
      const source = item.source ? ` (${item.source})` : '';
      console.log(`  [${item.kind}] ${item.label}${source}${where}`);
    }
  }
  if (result.disclosures.length > 0) {
    console.log('Disclosures:');
    for (const item of result.disclosures) console.log(`  - ${item}`);
  }
}

function printStatus(status: ReturnType<ReturnType<typeof createIntelligence>['status']>): void {
  console.log(`${status.name} ${status.version}`);
  console.log(`Data: ${status.dataDir}`);
  console.log('Domains:');
  for (const domain of status.domains) {
    console.log(
      `  ${domain.id.padEnd(12)} ${domain.verification.padEnd(10)} min ${domain.minModelTier}  ` +
        `${domain.deterministic ? 'deterministic' : 'model-assisted'}`
    );
  }
  console.log(
    `Documents: ${status.documents.documents} files, ${status.documents.chunks} chunks, ` +
      `${status.documents.terms} terms`
  );
  console.log(`Preference categories: ${status.preferences.categories}`);
  console.log(`Audit: ${status.audit.entries} entries, tip ${status.audit.tipHash.slice(0, 16)}…`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === '-h') {
      booleans.add('help');
      index += 1;
      continue;
    }
    if (token === '-v') {
      booleans.add('version');
      index += 1;
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      index += 1;
      continue;
    }
    const equals = token.indexOf('=');
    const name = (equals >= 0 ? token.slice(2, equals) : token.slice(2)).trim();
    if (!name) throw new IntelligenceInputError(`invalid option: ${token}`);
    if (BOOLEAN_FLAGS.has(name)) {
      booleans.add(name);
      index += 1;
      continue;
    }
    let value: string | undefined;
    if (equals >= 0) {
      value = token.slice(equals + 1);
      index += 1;
    } else if (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
      value = argv[index + 1];
      index += 2;
    } else {
      throw new IntelligenceInputError(`option --${name} requires a value`);
    }
    const existing = flags.get(name);
    if (existing) existing.push(value);
    else flags.set(name, [value]);
  }
  return { positionals, flags, booleans };
}

function getFlag(parsed: ParsedArgs, name: string): string | undefined {
  return parsed.flags.get(name)?.at(-1);
}

function getFlags(parsed: ParsedArgs, name: string): string[] {
  return parsed.flags.get(name) ?? [];
}

function optionalInt(parsed: ParsedArgs, name: string): number | undefined {
  const value = getFlag(parsed, name);
  return value === undefined ? undefined : parseInteger(value, name);
}

function parseInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new IntelligenceInputError(`${name} must be a positive integer`);
  }
  return number;
}

function parsePayloadFlag(parsed: ParsedArgs): Record<string, unknown> | undefined {
  const raw = getFlag(parsed, 'payload');
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new IntelligenceInputError(`--payload is not valid JSON: ${messageOf(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntelligenceInputError('--payload must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function requireQuery(rest: string[], command: string): string {
  const query = rest.join(' ').trim();
  if (!query) throw new IntelligenceInputError(`${command} requires a query`);
  return query;
}

function readVersion(): string {
  return INTELLIGENCE_VERSION;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof IntelligenceError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    if (error.details) process.stderr.write(`${JSON.stringify(error.details)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
