import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntelligenceInputError } from '../src/errors.js';
import { createIntelligence } from '../src/index.js';
import { createIntelligenceTools, findTool } from '../src/tools.js';
import { createWorkspace, fixedClock, writeFile, type Workspace } from './helpers.js';

describe('intelligence tools', () => {
  let ws: Workspace;
  let tools: ReturnType<typeof createIntelligenceTools>;

  beforeEach(() => {
    ws = createWorkspace();
    const governor = createIntelligence({
      dataDir: ws.dataDir,
      roots: [ws.root],
      now: fixedClock(),
    });
    tools = createIntelligenceTools(governor);
  });

  afterEach(() => ws.cleanup());

  function tool(name: string) {
    const found = findTool(tools, name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  }

  it('exposes a unique, well-formed tool inventory', () => {
    const names = tools.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      'intel_status',
      'intel_route',
      'intel_ask',
      'intel_docs_index',
      'intel_docs_search',
      'intel_docs_answer',
      'intel_docs_list',
      'intel_docs_forget',
      'intel_docs_stats',
      'intel_market_interpret',
      'intel_plan_create',
      'intel_preferences_list',
      'intel_preferences_get',
      'intel_preferences_record',
      'intel_audit_verify',
      'intel_audit_tail',
    ]);
    for (const entry of tools) {
      expect(entry.description.length).toBeGreaterThan(20);
      expect(entry.parameters).toMatchObject({ type: 'object' });
    }
    expect(findTool(tools, 'nope')).toBeUndefined();
  });

  it('reports status and routes without running a domain', async () => {
    const status = (await tool('intel_status').execute({})) as Record<string, any>;
    expect(status.domains).toHaveLength(4);
    expect(status.documents.documents).toBe(0);

    const route = (await tool('intel_route').execute({
      query: 'Interpret RSI for this stock',
    })) as Record<string, any>;
    expect(route.domain).toBe('market');
    expect(route.alternatives).toEqual(expect.any(Array));
  });

  it('indexes, searches, answers, lists, stats, and forgets documents', async () => {
    const doc = writeFile(ws.root, 'runbook.md', 'Restart the gateway with the blue button every Monday morning.');

    const indexed = (await tool('intel_docs_index').execute({ paths: [ws.root] })) as Record<string, any>;
    expect(indexed.indexed).toHaveLength(1);
    expect(indexed.receipt.domain).toBe('documents');

    const search = (await tool('intel_docs_search').execute({ query: 'blue button', limit: 3 })) as Record<string, any>;
    expect(search.count).toBeGreaterThan(0);
    expect(search.hits[0].source).toBe(doc);

    const answer = (await tool('intel_docs_answer').execute({ query: 'How do I restart the gateway?' })) as Record<string, any>;
    expect(answer.verification).toBe('grounded');
    expect(answer.answer).toContain('blue button');

    const list = (await tool('intel_docs_list').execute({})) as Record<string, any>;
    expect(list.documents).toHaveLength(1);

    const stats = (await tool('intel_docs_stats').execute({})) as Record<string, any>;
    expect(stats.documents).toBe(1);
    expect(stats.terms).toBeGreaterThan(0);

    const forgotten = (await tool('intel_docs_forget').execute({ source: doc })) as Record<string, any>;
    expect(forgotten.removed).toBe(true);
    expect(forgotten.receipt.domain).toBe('documents');
  });

  it('answers through ask with an explicit domain or routing', async () => {
    const plan = (await tool('intel_ask').execute({
      query: 'Build a local search feature',
      domain: 'planning',
      payload: { constraints: ['no network'] },
    })) as Record<string, any>;
    expect(plan.domain).toBe('planning');
    expect(plan.verification).toBe('advisory');
    expect(plan.receipt.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('interprets a market window', async () => {
    const result = (await tool('intel_market_interpret').execute({
      prices: [100, 101, 102, 103, 104, 105],
      instrument: 'equity',
      context: { news: 'strong growth' },
    })) as Record<string, any>;

    expect(result.domain).toBe('market');
    expect(result.verification).toBe('verified');
    expect(result.data.interpretation.sentiment.tone).toBe('positive');
    expect(() => tool('intel_market_interpret').execute({})).toThrow(IntelligenceInputError);
    expect(() =>
      tool('intel_market_interpret').execute({ prices: 'nope', instrument: 'equity' })
    ).toThrow(IntelligenceInputError);
  });

  it('creates plans', async () => {
    const result = (await tool('intel_plan_create').execute({
      objective: 'Organize a three-day research trip',
      constraints: ['budget 500'],
      deadline: '2099-05-01',
    })) as Record<string, any>;

    expect(result.domain).toBe('planning');
    expect(result.data.steps.length).toBeGreaterThan(0);
    expect(result.verification).toBe('advisory');
  });

  it('records and reads preferences', async () => {
    const recorded = (await tool('intel_preferences_record').execute({
      category: 'coding',
      signal: 'too_technical',
    })) as Record<string, any>;
    expect(recorded.domain).toBe('preferences');
    expect(recorded.data.signals.too_technical).toBe(1);

    const fetched = (await tool('intel_preferences_get').execute({ category: 'coding' })) as Record<string, any>;
    expect(fetched.data.category).toBe('coding');

    const listed = (await tool('intel_preferences_list').execute({})) as Record<string, any>;
    expect(listed.answer).toContain('coding');
  });

  it('verifies and tails the receipt chain', async () => {
    await tool('intel_plan_create').execute({ objective: 'Build a local search feature' });

    const verification = (await tool('intel_audit_verify').execute({})) as Record<string, any>;
    expect(verification.ok).toBe(true);
    expect(verification.entries).toBeGreaterThan(0);

    const tail = (await tool('intel_audit_tail').execute({ limit: 1 })) as Record<string, any>;
    expect(tail.receipts).toHaveLength(1);
    expect(tail.receipts[0].domain).toBe('planning');
  });

  it('validates required arguments at the tool boundary', async () => {
    expect(() => tool('intel_route').execute({})).toThrow(IntelligenceInputError);
    expect(() => tool('intel_ask').execute({ query: 'hello', payload: [] })).toThrow(
      IntelligenceInputError
    );
    expect(() => tool('intel_docs_index').execute({ paths: [] })).toThrow(IntelligenceInputError);
    expect(() => tool('intel_docs_index').execute({ paths: [1] })).toThrow(IntelligenceInputError);
    expect(() => tool('intel_docs_forget').execute({})).toThrow(IntelligenceInputError);
    expect(() =>
      tool('intel_preferences_record').execute({ category: 'coding', signal: 'nope' })
    ).toThrow(IntelligenceInputError);
    expect(() => tool('intel_plan_create').execute({})).toThrow(IntelligenceInputError);
  });

  it('reports out-of-root indexing as an error result, not a crash', async () => {
    const outside = writeFile(ws.base, 'secret.md', 'Do not index this.');
    const result = (await tool('intel_docs_index').execute({ paths: [outside] })) as Record<string, any>;
    expect(result.indexed).toEqual([]);
    expect(result.errors[0].error).toContain('outside the configured document roots');
  });
});
