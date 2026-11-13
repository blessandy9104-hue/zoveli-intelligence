import { IntelligenceInputError, StoreCorruptionError } from '../errors.js';
import { readJsonStore, writeJsonStore } from '../store.js';
import { sha256 } from '../text.js';
import type {
  DomainResult,
  PreferenceBias,
  PreferenceCategory,
  PreferenceData,
  PreferenceSignal,
} from '../types.js';

const SIGNALS: readonly PreferenceSignal[] = [
  'too_technical', 'too_vague', 'more_detail', 'less_detail', 'liked', 'disliked',
];

const DEFAULT_SIGNALS: Record<PreferenceSignal, number> = {
  too_technical: 0,
  too_vague: 0,
  more_detail: 0,
  less_detail: 0,
  liked: 0,
  disliked: 0,
};

export interface PreferenceOptions {
  dataDir: string;
  now?: () => Date;
}

/**
 * Local preference learning from explicit owner feedback. There is no implicit
 * profiling and no model call: only the signals the owner records are stored.
 */
export class PreferenceIntelligence {
  readonly dataDir: string;
  readonly storePath: string;
  private readonly now: () => Date;
  private data: PreferenceData;

  constructor(options: PreferenceOptions) {
    this.dataDir = options.dataDir;
    this.storePath = `${options.dataDir.replace(/[\\/]+$/, '')}/preferences.json`;
    this.now = options.now ?? (() => new Date());
    this.data = this.load();
  }

  record(category: string, signal: PreferenceSignal): PreferenceBias {
    const key = normalizeCategory(category);
    if (!SIGNALS.includes(signal)) {
      throw new IntelligenceInputError(`unknown preference signal: ${String(signal)}`, {
        allowed: SIGNALS,
      });
    }
    const existing = this.data.categories[key] ?? {
      signals: { ...DEFAULT_SIGNALS },
      updatedAt: this.now().toISOString(),
    };
    existing.signals[signal] = Math.min(1000, existing.signals[signal] + 1);
    existing.updatedAt = this.now().toISOString();
    this.data.categories[key] = existing;
    writeJsonStore(this.storePath, this.data);
    return this.bias(key);
  }

  get(category: string): PreferenceBias {
    return this.bias(normalizeCategory(category));
  }

  list(): PreferenceBias[] {
    return Object.keys(this.data.categories)
      .sort()
      .map((category) => this.bias(category));
  }

  toResult(bias: PreferenceBias): DomainResult {
    const recorded = bias.updatedAt !== null;
    const answer = recorded
      ? `Preferences for "${bias.category}": ${bias.styleHint} ` +
        `Analytic bias ${bias.analyticBias.toFixed(2)}, synthesis bias ${bias.synthesisBias.toFixed(2)}.`
      : `No preference feedback is recorded for "${bias.category}" yet. ${bias.styleHint}`;
    return {
      answer,
      verification: 'advisory',
      confidence: recorded ? 0.8 : 0.2,
      evidence: recorded
        ? [
            {
              kind: 'preference',
              label: `Owner feedback for ${bias.category}`,
              value: {
                signals: bias.signals,
                analyticBias: bias.analyticBias,
                synthesisBias: bias.synthesisBias,
              },
              sha256: sha256(JSON.stringify({ category: bias.category, signals: bias.signals })),
            },
          ]
        : [],
      disclosures: [
        'Derived only from feedback the owner explicitly recorded; newer feedback overrides older weighting.',
        'Stored locally and never used for advertising or telemetry.',
      ],
      data: bias as unknown as Record<string, unknown>,
    };
  }

  private bias(category: string): PreferenceBias {
    const stored: PreferenceCategory | undefined = this.data.categories[category];
    const signals = { ...DEFAULT_SIGNALS, ...(stored?.signals ?? {}) };
    const analytic = clamp(
      1 +
        0.1 * (signals.too_vague + signals.more_detail) -
        0.05 * (signals.too_technical + signals.less_detail) +
        0.05 * signals.liked -
        0.05 * signals.disliked,
      0.5,
      2
    );
    const synthesis = clamp(
      1 +
        0.1 * (signals.too_technical + signals.less_detail) -
        0.05 * (signals.too_vague + signals.more_detail) +
        0.05 * signals.liked -
        0.05 * signals.disliked,
      0.5,
      2
    );
    const total = Object.values(signals).reduce((sum, value) => sum + value, 0);
    const styleHint =
      total === 0
        ? 'No preference signal yet; answer with balanced precision.'
        : analytic > synthesis + 0.1
          ? 'Prefers precise, evidence-first answers with explicit assumptions.'
          : synthesis > analytic + 0.1
            ? 'Prefers concise, big-picture answers with less implementation detail.'
            : 'Balanced between precision and brevity.';
    return {
      category,
      analyticBias: round(analytic, 4),
      synthesisBias: round(synthesis, 4),
      styleHint,
      signals,
      updatedAt: stored?.updatedAt ?? null,
    };
  }

  private load(): PreferenceData {
    const data = readJsonStore<PreferenceData>(this.storePath, () => ({
      version: 1,
      categories: {},
    }));
    if (
      !data ||
      data.version !== 1 ||
      typeof data.categories !== 'object' ||
      data.categories === null ||
      Array.isArray(data.categories)
    ) {
      throw new StoreCorruptionError(`unexpected preference store shape in ${this.storePath}`, {
        file: this.storePath,
      });
    }
    return data;
  }
}

function normalizeCategory(category: string): string {
  const value = typeof category === 'string' ? category.trim() : '';
  if (!value) throw new IntelligenceInputError('category must be a non-empty string');
  if (value.length > 80) throw new IntelligenceInputError('category is too long (max 80 chars)');
  return value.toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
