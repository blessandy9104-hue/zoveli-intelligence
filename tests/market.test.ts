import { describe, expect, it } from 'vitest';
import {
  MPM_DISCLAIMER,
  asCandles,
  classifyTrend,
  indicatorSummary,
  interpretMarket,
  marketResult,
  riskFlags,
  sentimentOf,
  validateInterpretation,
} from '../src/domains/market.js';
import { IntelligenceInputError } from '../src/errors.js';
import type { MarketInterpretation } from '../src/types.js';

const UPTREND = Array.from({ length: 21 }, (_, index) => 100 + index);
const FLAT = [100, 100.1, 99.9, 100, 100.2, 99.8, 100.1, 99.9, 100];

describe('market interpretation (MPM)', () => {
  it('classifies an uptrend deterministically', () => {
    const first = interpretMarket(UPTREND, 'equity');
    const second = interpretMarket(UPTREND, 'equity');

    expect(first.trend.kind).toBe('uptrend');
    expect(first.trend.drift_pct).toBeGreaterThan(0);
    expect(['breakout', 'trend_continuation']).toContain(first.pattern.primary);
    expect(first.state).toBe('interpretation');
    expect(first.mpm_version).toBe('1.0');
    expect(first.disclaimer).toBe(MPM_DISCLAIMER);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('classifies a narrow range as sideways consolidation', () => {
    const interpretation = interpretMarket(FLAT, { type: 'equity_index', timeframe: '1d' });
    expect(interpretation.trend.kind).toBe('sideways');
    expect(interpretation.pattern.primary).toBe('range_consolidation');
  });

  it('flags high volatility from expanded candle ranges', () => {
    const candles = Array.from({ length: 10 }, () => ({ close: 100, high: 110, low: 90 }));
    const interpretation = interpretMarket(candles, 'crypto');
    expect(interpretation.volatility.level).toBe('high');
    expect(interpretation.volatility.atr_pct).toBeGreaterThan(6);
    expect(interpretation.risk_flags.some((flag) => flag.type === 'high_volatility')).toBe(true);
  });

  it('computes RSI(14) and EMA readings', () => {
    const closes = Array.from({ length: 16 }, (_, index) => 100 + index);
    const summary = indicatorSummary(asCandles(closes));
    const rsi = summary.find((entry) => entry.indicator === 'rsi');
    const ma = summary.find((entry) => entry.indicator === 'ma');
    expect(rsi?.reading).toBe('overbought');
    expect(ma?.reading).toBe('price_above_fast_ema');
  });

  it('classifies supplied news tone without fetching anything', () => {
    expect(sentimentOf({ news: 'strong growth and record gains' }).tone).toBe('positive');
    expect(sentimentOf({ news: 'crash and slump as losses deepen' }).tone).toBe('negative');
    expect(sentimentOf({ news: 'growth but weak guidance' }).tone).toBe('mixed');
    expect(sentimentOf({ news: 'quarterly update' }).tone).toBe('neutral');
    expect(sentimentOf({}).tone).toBe('none');
  });

  it('rejects malformed price input', () => {
    expect(() => interpretMarket([100], 'equity')).toThrow(IntelligenceInputError);
    expect(() => interpretMarket([100, Number.POSITIVE_INFINITY], 'equity')).toThrow(IntelligenceInputError);
    expect(() => interpretMarket([100, { close: 100, high: 90, low: 95 }], 'equity')).toThrow(IntelligenceInputError);
    expect(() => interpretMarket([100, { close: 102, high: 101, low: 99 }], 'equity')).toThrow(IntelligenceInputError);
    expect(() => interpretMarket([100, 101], 'bond')).toThrow(IntelligenceInputError);
    expect(() => interpretMarket([100, 101], { type: 'equity', timeframe: '2d' as never })).toThrow(IntelligenceInputError);
    expect(() => interpretMarket('nope', 'equity')).toThrow(IntelligenceInputError);
  });

  it('treats user context as optional but rejects a non-object', () => {
    expect(() => interpretMarket([100, 101], 'equity', null as unknown as Record<string, unknown>)).toThrow(
      IntelligenceInputError
    );
  });

  it('validates interpretation objects against the schema contract', () => {
    const interpretation = interpretMarket(UPTREND, 'equity');
    expect(validateInterpretation(interpretation)).toBe(true);
    expect(validateInterpretation({})).toBe(false);
    expect(validateInterpretation({ ...interpretation, state: 'forecast' })).toBe(false);
    expect(validateInterpretation({ ...interpretation, disclaimer: 'advice' })).toBe(false);
  });

  it('wraps interpretation as verified computed evidence', () => {
    const interpretation = interpretMarket(UPTREND, 'equity');
    const result = marketResult(interpretation, UPTREND);

    expect(result.verification).toBe('verified');
    expect(result.confidence).toBe(interpretation.pattern.confidence);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].kind).toBe('computation');
    expect(result.evidence[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.disclosures.join(' ')).toContain('Not a prediction');
    expect((result.data?.interpretation as MarketInterpretation).trend.kind).toBe('uptrend');
  });

  it('caps risk flags and never emits directives', () => {
    const wild = Array.from({ length: 30 }, (_, index) => ({
      close: index % 2 === 0 ? 200 : 80,
      high: 220,
      low: 60,
    }));
    const flags = riskFlags(asCandles(wild));
    expect(flags.length).toBeLessThanOrEqual(5);
    for (const flag of flags) {
      expect(flag.type).not.toContain('buy');
      expect(flag.type).not.toContain('sell');
    }
  });

  it('rejects more than 10,000 observations', () => {
    const huge = new Array(10_001).fill(100);
    expect(() => asCandles(huge)).toThrow(IntelligenceInputError);
  });

  it('exposes a trend classifier usable in isolation', () => {
    expect(classifyTrend([100, 101, 102, 103]).kind).toBe('uptrend');
    expect(classifyTrend([103, 102, 101, 100]).kind).toBe('downtrend');
  });
});
