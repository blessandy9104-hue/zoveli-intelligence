import { IntelligenceInputError } from '../errors.js';
import { sha256 } from '../text.js';
import type {
  CandleInput,
  DomainResult,
  InstrumentType,
  MarketInterpretation,
  MarketInstrument,
  PricePoint,
  Timeframe,
} from '../types.js';

export const MPM_VERSION = '1.0' as const;
export const MPM_DISCLAIMER =
  'Interpretation of historical and current price structure only. ' +
  'Not a prediction, recommendation, or guarantee of any outcome.';

const INSTRUMENT_TYPES: readonly InstrumentType[] = [
  'equity_index', 'equity', 'commodity', 'fx', 'crypto', 'treasury',
];
const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
const MAX_POINTS = 10_000;

const POSITIVE_TERMS = new Set([
  'strong', 'raised', 'beat', 'growth', 'gain', 'gains', 'up', 'higher',
  'bull', 'bullish', 'rally', 'record', 'rise', 'rising', 'improve',
]);
const NEGATIVE_TERMS = new Set([
  'slump', 'cut', 'loss', 'losses', 'miss', 'down', 'lower', 'bear',
  'bearish', 'crash', 'fall', 'falling', 'weak', 'weaken', 'drop',
]);

interface Candle {
  close: number;
  high: number;
  low: number;
}

/** Normalize flat closes or candle objects; reject malformed input. */
export function asCandles(series: PricePoint[]): Candle[] {
  if (typeof series === 'string' || !Array.isArray(series)) {
    throw new IntelligenceInputError('prices must be an array of numbers or candle objects');
  }
  if (series.length > MAX_POINTS) {
    throw new IntelligenceInputError(`prices may contain at most ${MAX_POINTS} observations`);
  }
  const candles: Candle[] = [];
  for (const item of series) {
    let close: number;
    let high: number;
    let low: number;
    if (typeof item === 'number') {
      close = item;
      high = item;
      low = item;
    } else if (item && typeof item === 'object' && 'close' in item) {
      const candle = item as CandleInput;
      close = Number(candle.close);
      high = candle.high === undefined ? close : Number(candle.high);
      low = candle.low === undefined ? close : Number(candle.low);
    } else {
      throw new IntelligenceInputError('prices items must be numbers or { close, high?, low? } objects');
    }
    if (!Number.isFinite(close) || !Number.isFinite(high) || !Number.isFinite(low)) {
      throw new IntelligenceInputError('price values must be finite numbers');
    }
    if (high < low) throw new IntelligenceInputError('candle high must be >= low');
    if (close < low || close > high) {
      throw new IntelligenceInputError('candle close must lie within the high/low range');
    }
    candles.push({ close, high, low });
  }
  if (candles.length < 2) {
    throw new IntelligenceInputError('prices must contain at least two observations');
  }
  return candles;
}

function emaSeries(closes: number[], span: number): number[] {
  const alpha = 2 / (span + 1);
  const out: number[] = [];
  let seed = closes[0] ?? 0;
  for (const close of closes) {
    seed = alpha * close + (1 - alpha) * seed;
    out.push(seed);
  }
  return out;
}

function rsi14(closes: number[]): number {
  if (closes.length < 15) return 50;
  const window = closes.slice(-15);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < window.length; i += 1) {
    const delta = window[i] - window[i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  if (gains === 0 && losses === 0) return 50;
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function atr(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  let sum = 0;
  let previous = candles[0].close;
  for (let i = 1; i < candles.length; i += 1) {
    const candle = candles[i];
    const tr = Math.max(candle.high, previous) - Math.min(candle.low, previous);
    sum += Math.max(tr, 0);
    previous = candle.close;
  }
  return sum / (candles.length - 1);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function atrPct(candles: Candle[]): number {
  const value = atr(candles);
  const mid = mean(candles.map((candle) => candle.close));
  return mid === 0 ? 0 : (100 * value) / mid;
}

export function classifyTrend(closes: number[]): MarketInterpretation['trend'] {
  const first = closes[0];
  const last = closes[closes.length - 1];
  const mid = mean(closes);
  const driftPct = first === 0 ? 0 : (100 * (last - first)) / first;
  const rangePct = mid === 0 ? 0 : (100 * (Math.max(...closes) - Math.min(...closes))) / mid;

  if (rangePct < 2 && Math.abs(driftPct) < 0.8) {
    return {
      kind: 'sideways',
      signal_strength: round(Math.abs(driftPct) / 8, 2),
      drift_pct: round(driftPct, 4),
    };
  }
  if (driftPct >= 0.8) {
    return {
      kind: 'uptrend',
      signal_strength: round(Math.min(1, 0.2 + Math.abs(driftPct) / 10), 2),
      drift_pct: round(driftPct, 4),
    };
  }
  if (driftPct <= -0.8) {
    return {
      kind: 'downtrend',
      signal_strength: round(Math.min(1, 0.2 + Math.abs(driftPct) / 10), 2),
      drift_pct: round(driftPct, 4),
    };
  }
  return { kind: 'choppy', signal_strength: 0.5, drift_pct: round(driftPct, 4) };
}

export function assessVolatility(candles: Candle[]): MarketInterpretation['volatility'] {
  const value = atrPct(candles);
  if (value < 2) return { level: 'low', bucket: 'atr_below_2', atr_pct: round(value, 4) };
  if (value <= 6) return { level: 'medium', bucket: 'atr_pct_2_6', atr_pct: round(value, 4) };
  return { level: 'high', bucket: 'atr_pct_above_6', atr_pct: round(value, 4) };
}

export function detectPattern(
  candles: Candle[],
  trend: MarketInterpretation['trend'],
  volatility: MarketInterpretation['volatility']
): MarketInterpretation['pattern'] {
  const closes = candles.map((candle) => candle.close);
  const high = Math.max(...candles.map((candle) => candle.high));
  const low = Math.min(...candles.map((candle) => candle.low));
  const mid = mean(closes);
  const rangePct = mid === 0 ? 0 : (100 * (high - low)) / mid;
  const first = closes[0];
  const last = closes[closes.length - 1];
  const driftPct = first === 0 ? 0 : (100 * (last - first)) / first;
  const ema = emaSeries(closes, 9)[closes.length - 1];
  const distancePct = ema === 0 ? 0 : (100 * (last - ema)) / ema;
  const kind = trend.kind;

  if (kind === 'sideways') {
    return {
      primary: 'range_consolidation',
      confidence: 0.7,
      rationale: 'Price structure is bound in a narrow range with negligible drift.',
    };
  }
  if (kind === 'choppy' && rangePct < 6 && Math.abs(driftPct) < 3) {
    return {
      primary: 'breakout',
      confidence: 0.6,
      rationale:
        'Compressed structure sits inside the breakout window (range <6%, drift <3%): ' +
        'a directional break is not confirmed.',
    };
  }
  if (volatility.level === 'high') {
    return {
      primary: 'volatility_cluster',
      confidence: 0.55,
      rationale: 'Expanded true ranges produce clustered volatility with no clean trend.',
    };
  }
  if ((kind === 'uptrend' || kind === 'downtrend') && Math.abs(distancePct) >= 1) {
    return {
      primary: 'breakout',
      confidence: 0.65,
      rationale: 'Price extends beyond the fast EMA on persistent directional drift.',
    };
  }
  if (kind === 'uptrend' || kind === 'downtrend') {
    return {
      primary: 'trend_continuation',
      confidence: 0.55,
      rationale: 'Directional drift dominates the window; structure continues its prevailing lean.',
    };
  }
  return {
    primary: 'pole_reversal',
    confidence: 0.45,
    rationale: 'Shallow or mixed structure: recent price pulled back from the window extremes.',
  };
}

export function riskFlags(
  candles: Candle[]
): MarketInterpretation['risk_flags'] {
  const closes = candles.map((candle) => candle.close);
  const value = atr(candles);
  const mid = mean(closes);
  const atrPercent = mid === 0 ? 0 : (100 * value) / mid;
  const ema = emaSeries(closes, 9)[closes.length - 1];
  const distancePct = ema === 0 ? 0 : (100 * (closes[closes.length - 1] - ema)) / ema;
  const flags: MarketInterpretation['risk_flags'] = [];

  if (atrPercent > 6) {
    flags.push({
      type: 'high_volatility',
      severity: 'high',
      note: 'ATR% exceeds the high-volatility threshold.',
    });
  }
  if (Math.abs(distancePct) > 6) {
    flags.push({
      type: 'overextension',
      severity: 'high',
      note: 'Price is stretched more than 6% from the fast EMA(9).',
    });
  } else if (Math.abs(distancePct) > 3) {
    flags.push({
      type: 'overextension',
      severity: 'medium',
      note: 'Price is stretched more than 3% from the fast EMA(9).',
    });
  }
  let sharp: 'high' | 'medium' | null = null;
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] === 0) continue;
    const movePct = (Math.abs(closes[i] - closes[i - 1]) * 100) / closes[i - 1];
    if (movePct > 6) {
      sharp = 'high';
      break;
    }
    if (movePct > 3) sharp = 'medium';
  }
  if (sharp) {
    flags.push({
      type: 'sharp_move',
      severity: sharp,
      note: sharp === 'high' ? 'A single-bar move exceeded 6%.' : 'A single-bar move exceeded 3%.',
    });
  }
  return flags.slice(0, 5);
}

export function indicatorSummary(
  candles: Candle[]
): MarketInterpretation['indicator_summary'] {
  const closes = candles.map((candle) => candle.close);
  const ema = emaSeries(closes, 9)[closes.length - 1];
  const last = closes[closes.length - 1];
  const maReading = last >= ema ? 'price_above_fast_ema' : 'price_below_fast_ema';
  const rsi = rsi14(closes);
  const rsiReading = rsi >= 70 ? 'overbought' : rsi <= 30 ? 'oversold' : 'neutral_zone';
  return [
    {
      indicator: 'ma',
      reading: maReading,
      detail: `fast EMA(9) ${ema.toFixed(4)} vs last close ${last.toFixed(4)} (${maReading})`,
    },
    {
      indicator: 'rsi',
      reading: rsiReading,
      detail: `RSI(14) ${rsi.toFixed(1)} (${rsiReading})`,
    },
  ];
}

export function sentimentOf(context?: Record<string, unknown>): MarketInterpretation['sentiment'] {
  const news = context?.news;
  if (typeof news !== 'string' || !news.trim()) {
    return { source: 'user_provided', tone: 'none' };
  }
  const tokens = news.toLowerCase().split(/\s+/);
  const positive = tokens.filter((token) => POSITIVE_TERMS.has(token)).length;
  const negative = tokens.filter((token) => NEGATIVE_TERMS.has(token)).length;
  const tone = positive && negative ? 'mixed' : positive ? 'positive' : negative ? 'negative' : 'neutral';
  return { source: 'user_provided', tone };
}

export function interpretMarket(
  priceSeries: unknown,
  instrument: MarketInstrument | string,
  userContext?: Record<string, unknown>
): MarketInterpretation {
  if (!Array.isArray(priceSeries)) {
    throw new IntelligenceInputError('prices must be an array of numbers or candle objects');
  }
  const candles = asCandles(priceSeries as PricePoint[]);
  const parsedInstrument: MarketInstrument =
    typeof instrument === 'string' ? { type: instrument as InstrumentType } : instrument;
  const type = parsedInstrument.type;
  const timeframe = parsedInstrument.timeframe ?? '1d';
  if (!INSTRUMENT_TYPES.includes(type as InstrumentType)) {
    throw new IntelligenceInputError(`unknown instrument type: ${String(type)}`, {
      allowed: INSTRUMENT_TYPES,
    });
  }
  if (!TIMEFRAMES.includes(timeframe as Timeframe)) {
    throw new IntelligenceInputError(`unknown timeframe: ${String(timeframe)}`, {
      allowed: TIMEFRAMES,
    });
  }
  if (userContext !== undefined && (userContext === null || typeof userContext !== 'object')) {
    throw new IntelligenceInputError('context must be an object or omitted');
  }

  const closes = candles.map((candle) => candle.close);
  const trend = classifyTrend(closes);
  const volatility = assessVolatility(candles);
  const pattern = detectPattern(candles, trend, volatility);
  const flags = riskFlags(candles);
  const indicators = indicatorSummary(candles);
  const sentiment = sentimentOf(userContext);
  const explanation =
    `${pattern.primary} structure with ${flags.map((flag) => flag.type).join(', ') || 'no'} ` +
    `risk flag${flags.length === 1 ? '' : 's'}; ${trend.kind} lean at confidence ` +
    `${pattern.confidence.toFixed(2)} on ${volatility.level} volatility ` +
    `(ATR ${volatility.atr_pct.toFixed(2)}%).`;

  return {
    mpm_version: MPM_VERSION,
    state: 'interpretation',
    instrument: { type: type as InstrumentType, timeframe: timeframe as Timeframe },
    pattern,
    trend,
    volatility,
    risk_flags: flags,
    indicator_summary: indicators,
    sentiment,
    explanation,
    disclaimer: MPM_DISCLAIMER,
  };
}

export function validateInterpretation(value: unknown): value is MarketInterpretation {
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  const pattern = object.pattern as Record<string, unknown> | undefined;
  const trend = object.trend as Record<string, unknown> | undefined;
  const volatility = object.volatility as Record<string, unknown> | undefined;
  const instrument = object.instrument as Record<string, unknown> | undefined;
  return (
    object.mpm_version === MPM_VERSION &&
    object.state === 'interpretation' &&
    !!instrument &&
    INSTRUMENT_TYPES.includes(instrument.type as InstrumentType) &&
    TIMEFRAMES.includes(instrument.timeframe as Timeframe) &&
    !!pattern &&
    typeof pattern.confidence === 'number' &&
    pattern.confidence >= 0 &&
    pattern.confidence <= 1 &&
    !!trend &&
    ['uptrend', 'downtrend', 'sideways', 'choppy'].includes(String(trend.kind)) &&
    !!volatility &&
    ['low', 'medium', 'high'].includes(String(volatility.level)) &&
    Array.isArray(object.risk_flags) &&
    (object.risk_flags as unknown[]).length <= 5 &&
    Array.isArray(object.indicator_summary) &&
    typeof object.explanation === 'string' &&
    object.disclaimer === MPM_DISCLAIMER
  );
}

/** Domain result wrapper with explicit computed evidence and disclosures. */
export function marketResult(
  interpretation: MarketInterpretation,
  rawPrices: unknown
): DomainResult {
  return {
    answer:
      `${interpretation.explanation} ` +
      `${interpretation.indicator_summary.map((entry) => entry.detail).join('; ')}.`,
    verification: 'verified',
    confidence: interpretation.pattern.confidence,
    evidence: [
      {
        kind: 'computation',
        label: `MPM ${MPM_VERSION} deterministic interpretation`,
        value: {
          trend: interpretation.trend,
          volatility: interpretation.volatility,
          pattern: interpretation.pattern.primary,
          indicators: interpretation.indicator_summary,
        },
        sha256: sha256(JSON.stringify(rawPrices)),
      },
    ],
    disclosures: [
      interpretation.disclaimer,
      'Indicators are computed deterministically from the supplied price window; no forecast is made.',
    ],
    data: { interpretation },
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
