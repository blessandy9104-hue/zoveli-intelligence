import type { IntelligenceGovernor } from './governor.js';
import { IntelligenceInputError } from './errors.js';
import { DOMAINS } from './registry.js';
import type {
  DomainId,
  IntelligenceTool,
  PreferenceSignal,
} from './types.js';

const DOMAIN_IDS = DOMAINS.map((domain) => domain.id);
const PREFERENCE_SIGNALS: readonly PreferenceSignal[] = [
  'too_technical', 'too_vague', 'more_detail', 'less_detail', 'liked', 'disliked',
];

const DOMAIN_SCHEMA = {
  type: 'string',
  enum: DOMAIN_IDS,
  description: 'Optional domain override. Omit to route by intent.',
};

const LIMIT_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: 50,
  description: 'Maximum number of results to return.',
};

/**
 * Tool descriptors for the intelligence subsystem. Each tool validates its own
 * arguments so both the MCP server and in-process hosts get the same contract.
 */
export function createIntelligenceTools(governor: IntelligenceGovernor): IntelligenceTool[] {
  const tools: IntelligenceTool[] = [
    {
      name: 'intel_status',
      description:
        'Report intelligence subsystem version, registered domains, document index size, preference count, and audit tip.',
      parameters: objectSchema({}),
      execute: () => governor.status(),
    },
    {
      name: 'intel_route',
      description:
        'Show which deterministic intelligence domain would answer a query, with scores and alternatives. Does not run the domain.',
      parameters: objectSchema(
        {
          query: { type: 'string', minLength: 1, maxLength: 4000, description: 'Question or objective to route.' },
          domain: DOMAIN_SCHEMA,
        },
        ['query']
      ),
      execute: (args) => {
        const query = requireString(args, 'query');
        const domain = optionalDomain(args);
        const decision = governor.route(query, domain);
        return {
          domain: decision.domain.id,
          name: decision.domain.name,
          score: decision.score,
          verification: decision.domain.verification,
          minModelTier: decision.domain.minModelTier,
          alternatives: decision.alternatives.map((candidate) => ({
            domain: candidate.domain.id,
            score: candidate.score,
          })),
        };
      },
    },
    {
      name: 'intel_ask',
      description:
        'Route a question to a deterministic domain and return a governed answer with verification, evidence, disclosures, and a hash-chained receipt. Market requests need payload.prices; planning accepts payload.constraints/deadline/context; preferences accepts payload.action/category/signal.',
      parameters: objectSchema(
        {
          query: { type: 'string', minLength: 1, maxLength: 4000, description: 'Question or objective.' },
          domain: DOMAIN_SCHEMA,
          payload: {
            type: 'object',
            description:
              'Domain payload. documents: none. market: { prices, instrument, context? }. planning: { constraints?, deadline?, context? }. preferences: { action: list|get|record, category?, signal? }.',
            additionalProperties: true,
          },
          limits: {
            type: 'object',
            properties: { maxResults: LIMIT_SCHEMA },
            additionalProperties: false,
          },
        },
        ['query']
      ),
      execute: (args) =>
        governor.ask({
          query: requireString(args, 'query'),
          domain: optionalDomain(args),
          payload: optionalObject(args, 'payload'),
          limits: optionalObject(args, 'limits') as { maxResults?: number } | undefined,
        }),
    },
    {
      name: 'intel_docs_index',
      description:
        'Index local text, markdown, HTML, JSON, CSV, or YAML files and folders. Paths must stay inside the configured document roots. Re-indexing a file replaces its chunks.',
      parameters: objectSchema(
        {
          paths: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            minItems: 1,
            maxItems: 100,
            description: 'Absolute or root-relative file and directory paths to index.',
          },
        },
        ['paths']
      ),
      execute: (args) => {
        const paths = requireStringArray(args, 'paths');
        const result = governor.documents.indexPaths(paths);
        const receipt = governor.seal('documents', { paths }, `indexed ${result.indexed.length} files`);
        return { ...result, receipt };
      },
    },
    {
      name: 'intel_docs_search',
      description:
        'Search the local document index with BM25 and return ranked excerpts, source paths, and line ranges. Does not generate an answer.',
      parameters: objectSchema(
        {
          query: { type: 'string', minLength: 1, maxLength: 4000 },
          limit: LIMIT_SCHEMA,
        },
        ['query']
      ),
      execute: (args) => {
        const query = requireString(args, 'query');
        const hits = governor.documents.search(query, optionalNumber(args, 'limit') ?? 8);
        return { query, count: hits.length, hits };
      },
    },
    {
      name: 'intel_docs_answer',
      description:
        'Answer a question extractively from indexed local documents, with source and line citations. Withholds when no indexed source supports an answer.',
      parameters: objectSchema(
        {
          query: { type: 'string', minLength: 1, maxLength: 4000 },
          limit: LIMIT_SCHEMA,
        },
        ['query']
      ),
      execute: (args) =>
        governor.ask({
          query: requireString(args, 'query'),
          domain: 'documents',
          limits: { maxResults: optionalNumber(args, 'limit') },
        }),
    },
    {
      name: 'intel_docs_list',
      description: 'List documents in the local index with chunk counts, index timestamps, and whether the source file still exists.',
      parameters: objectSchema({}),
      execute: () => ({ documents: governor.documents.list() }),
    },
    {
      name: 'intel_docs_forget',
      description:
        'Remove a document from the local index by source path. Never deletes the underlying file.',
      parameters: objectSchema(
        {
          source: { type: 'string', minLength: 1, description: 'Indexed source path to remove.' },
        },
        ['source']
      ),
      execute: (args) => {
        const source = requireString(args, 'source');
        const result = governor.documents.forget(source);
        const receipt = governor.seal('documents', { source }, `removed=${result.removed}`);
        return { ...result, receipt };
      },
    },
    {
      name: 'intel_docs_stats',
      description: 'Report local document index totals: files, chunks, vocabulary terms, roots, and data directory.',
      parameters: objectSchema({}),
      execute: () => governor.documents.stats(),
    },
    {
      name: 'intel_market_interpret',
      description:
        'Interpret a supplied price window deterministically (trend, volatility, pattern, risk flags, RSI, EMA, ATR). Interpretation only: never predicts or recommends.',
      parameters: objectSchema(
        {
          prices: {
            type: 'array',
            minItems: 2,
            maxItems: 10000,
            description: 'Array of closing prices or { close, high?, low? } candle objects.',
            items: {
              oneOf: [
                { type: 'number' },
                {
                  type: 'object',
                  properties: {
                    close: { type: 'number' },
                    high: { type: 'number' },
                    low: { type: 'number' },
                  },
                  required: ['close'],
                  additionalProperties: false,
                },
              ],
            },
          },
          instrument: {
            oneOf: [
              { type: 'string', enum: ['equity_index', 'equity', 'commodity', 'fx', 'crypto', 'treasury'] },
              {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['equity_index', 'equity', 'commodity', 'fx', 'crypto', 'treasury'] },
                  timeframe: { type: 'string', enum: ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] },
                },
                required: ['type'],
                additionalProperties: false,
              },
            ],
          },
          context: {
            type: 'object',
            description: 'Optional user-provided context. Only context.news is read, for tone classification.',
            additionalProperties: true,
          },
        },
        ['prices', 'instrument']
      ),
      execute: (args) => {
        if (!Array.isArray(args.prices)) {
          throw new IntelligenceInputError('prices must be an array');
        }
        if (args.instrument === undefined) {
          throw new IntelligenceInputError('instrument is required');
        }
        return governor.ask({
          query: 'Interpret the supplied price window.',
          domain: 'market',
          payload: {
            prices: args.prices,
            instrument: args.instrument,
            context: args.context,
          },
        });
      },
    },
    {
      name: 'intel_plan_create',
      description:
        'Turn an objective into a deterministic, reviewable plan with completion and verification criteria. Advisory only: nothing is executed.',
      parameters: objectSchema(
        {
          objective: { type: 'string', minLength: 1, maxLength: 2000 },
          constraints: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 20,
          },
          deadline: { type: 'string', description: 'Optional ISO date or date-time.' },
          context: { type: 'string', maxLength: 2000 },
        },
        ['objective']
      ),
      execute: (args) =>
        governor.ask({
          query: requireString(args, 'objective'),
          domain: 'planning',
          payload: {
            constraints: Array.isArray(args.constraints) ? args.constraints : [],
            deadline: typeof args.deadline === 'string' ? args.deadline : '',
            context: typeof args.context === 'string' ? args.context : '',
          },
        }),
    },
    {
      name: 'intel_preferences_list',
      description: 'List every locally recorded preference category and its derived style bias.',
      parameters: objectSchema({}),
      execute: () =>
        governor.ask({
          query: 'List owner preferences.',
          domain: 'preferences',
          payload: { action: 'list' },
        }),
    },
    {
      name: 'intel_preferences_get',
      description: 'Get the derived style bias for one preference category.',
      parameters: objectSchema(
        { category: { type: 'string', minLength: 1, maxLength: 80 } },
        ['category']
      ),
      execute: (args) =>
        governor.ask({
          query: 'Read owner preferences.',
          domain: 'preferences',
          payload: { action: 'get', category: requireString(args, 'category') },
        }),
    },
    {
      name: 'intel_preferences_record',
      description:
        'Record one explicit owner feedback signal and return the updated style bias. Signals: too_technical, too_vague, more_detail, less_detail, liked, disliked.',
      parameters: objectSchema(
        {
          category: { type: 'string', minLength: 1, maxLength: 80 },
          signal: { type: 'string', enum: PREFERENCE_SIGNALS },
        },
        ['category', 'signal']
      ),
      execute: (args) => {
        const category = requireString(args, 'category');
        const signal = requireString(args, 'signal');
        if (!PREFERENCE_SIGNALS.includes(signal as PreferenceSignal)) {
          throw new IntelligenceInputError(`unknown preference signal: ${signal}`, {
            allowed: PREFERENCE_SIGNALS,
          });
        }
        return governor.ask({
          query: 'Record owner preference feedback.',
          domain: 'preferences',
          payload: { action: 'record', category, signal },
        });
      },
    },
    {
      name: 'intel_audit_verify',
      description:
        'Verify the SHA-256 audit chain end to end. Reports entry count, tip hash, and any broken or tampered lines.',
      parameters: objectSchema({}),
      execute: () => governor.verifyAudit(),
    },
    {
      name: 'intel_audit_tail',
      description:
        'Return the most recent hash-chained receipts. Receipts contain hashes and routing metadata, never raw queries or document text.',
      parameters: objectSchema({
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      }),
      execute: (args) => ({
        receipts: governor.audit.tail(optionalNumber(args, 'limit') ?? 10),
      }),
    },
  ];
  return tools;
}

export function findTool(
  tools: readonly IntelligenceTool[],
  name: string
): IntelligenceTool | undefined {
  return tools.find((tool) => tool.name === name);
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new IntelligenceInputError(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalDomain(args: Record<string, unknown>): DomainId | undefined {
  const value = args.domain;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !DOMAIN_IDS.includes(value as DomainId)) {
    throw new IntelligenceInputError(`unknown intelligence domain: ${String(value)}`, {
      allowed: DOMAIN_IDS,
    });
  }
  return value as DomainId;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new IntelligenceInputError(`${key} must be a finite number`);
  }
  return number;
}

function optionalObject(
  args: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new IntelligenceInputError(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new IntelligenceInputError(`${key} must be a non-empty array of strings`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new IntelligenceInputError(`${key} must contain only non-empty strings`);
    }
    out.push(item.trim());
  }
  return out;
}
