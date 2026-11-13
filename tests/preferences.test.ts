import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreferenceIntelligence } from '../src/domains/preferences.js';
import { IntelligenceInputError, StoreCorruptionError } from '../src/errors.js';
import { createWorkspace, fixedClock, type Workspace } from './helpers.js';

describe('PreferenceIntelligence', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = createWorkspace();
  });

  afterEach(() => ws.cleanup());

  function createStore() {
    return new PreferenceIntelligence({ dataDir: ws.dataDir, now: fixedClock() });
  }

  it('starts neutral and reports no evidence before feedback', () => {
    const preferences = createStore();
    const bias = preferences.get('Coding');
    const result = preferences.toResult(bias);

    expect(bias.category).toBe('coding');
    expect(bias.updatedAt).toBeNull();
    expect(bias.analyticBias).toBe(1);
    expect(bias.synthesisBias).toBe(1);
    expect(bias.styleHint).toContain('balanced precision');
    expect(result.verification).toBe('advisory');
    expect(result.confidence).toBe(0.2);
    expect(result.evidence).toEqual([]);
  });

  it('turns explicit feedback into a transparent style bias', () => {
    const preferences = createStore();
    const moreDetail = preferences.record('Coding', 'more_detail');
    expect(moreDetail.analyticBias).toBe(1.1);
    expect(moreDetail.synthesisBias).toBe(0.95);
    expect(moreDetail.styleHint).toContain('precise');

    const tooTechnical = preferences.record('emails', 'too_technical');
    expect(tooTechnical.signals.too_technical).toBe(1);
    expect(tooTechnical.synthesisBias).toBeGreaterThan(tooTechnical.analyticBias);
    expect(tooTechnical.styleHint).toContain('big-picture');
    expect(tooTechnical.updatedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('clamps accumulated bias to the documented range', () => {
    const preferences = createStore();
    for (let index = 0; index < 200; index += 1) preferences.record('terminal', 'liked');
    const bias = preferences.get('terminal');
    expect(bias.analyticBias).toBe(2);
    expect(bias.synthesisBias).toBe(2);
  });

  it('lists categories in sorted order', () => {
    const preferences = createStore();
    preferences.record('writing', 'liked');
    preferences.record('coding', 'less_detail');
    expect(preferences.list().map((entry) => entry.category)).toEqual(['coding', 'writing']);
  });

  it('persists feedback across instances', () => {
    createStore().record('coding', 'too_vague');
    const reopened = createStore();
    expect(reopened.get('coding').signals.too_vague).toBe(1);
  });

  it('rejects unknown signals, empty categories, and oversized categories', () => {
    const preferences = createStore();
    expect(() => preferences.record('coding', 'make_it_nice' as never)).toThrow(IntelligenceInputError);
    expect(() => preferences.record('', 'liked')).toThrow(IntelligenceInputError);
    expect(() => preferences.record('x'.repeat(81), 'liked')).toThrow(IntelligenceInputError);
  });

  it('fails closed on malformed stored JSON', () => {
    fs.writeFileSync(path.join(ws.dataDir, 'preferences.json'), '{oops', 'utf8');
    expect(() => createStore()).toThrow(StoreCorruptionError);
  });

  it('fails closed on an unexpected store shape', () => {
    fs.writeFileSync(path.join(ws.dataDir, 'preferences.json'), '{"version":1,"categories":[]}', 'utf8');
    expect(() => createStore()).toThrow(StoreCorruptionError);
  });
});
