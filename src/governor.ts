import { AuditChain, auditLogPathFor } from './audit.js';
import { DocumentIntelligence, type DocumentOptions } from './domains/documents.js';
import { interpretMarket, marketResult } from './domains/market.js';
import { createPlan, planResult } from './domains/planning.js';
import { PreferenceIntelligence } from './domains/preferences.js';
import { IntelligenceInputError } from './errors.js';
import { IntelligenceRegistry } from './registry.js';
import { ensureDir, resolveDataDir } from './store.js';
import { hashObject, sha256 } from './text.js';
import type {
  DomainId,
  DomainResult,
  IntelligenceRequest,
  IntelligenceResult,
  IntelligenceStatus,
  MarketInstrument,
  ModelTier,
  PreferenceSignal,
  Receipt,
  RouteDecision,
  VerificationLevel,
} from './types.js';

export const INTELLIGENCE_VERSION = '0.1.0';
export const INTELLIGENCE_NAME = '@zoveli/intelligence';

const TIER_ORDER: Record<ModelTier, number> = { tiny: 0, small: 1, medium: 2, large: 3 };
const VERIFICATION_ORDER: Record<VerificationLevel, number> = {
  unverified: 0,
  advisory: 1,
  grounded: 2,
  verified: 3,
};

export type IntelligenceOptions = Omit<DocumentOptions, 'dataDir'> & {
  /** Defaults to ZOVELI_INTEL_DATA_DIR or ~/.zoveli/intelligence. */
  dataDir?: string;
};

/**
 * One governor over the deterministic intelligence domains. It routes a
 * request, runs the domain, caps its verification claim to what the domain can
 * actually prove, and seals a hash-chained receipt.
 */
export class IntelligenceGovernor {
  readonly name = INTELLIGENCE_NAME;
  readonly version = INTELLIGENCE_VERSION;
  readonly dataDir: string;
  readonly auditPath: string;
  readonly registry: IntelligenceRegistry;
  readonly documents: DocumentIntelligence;
  readonly preferences: PreferenceIntelligence;
  readonly audit: AuditChain;

  constructor(options: IntelligenceOptions = {}) {
    this.dataDir = resolveDataDir(options.dataDir);
    ensureDir(this.dataDir);
    this.auditPath = auditLogPathFor(this.dataDir);
    this.registry = new IntelligenceRegistry();
    this.documents = new DocumentIntelligence({ ...options, dataDir: this.dataDir });
    this.preferences = new PreferenceIntelligence({
      dataDir: this.dataDir,
      now: options.now,
    });
    this.audit = new AuditChain(this.auditPath, options.now);
  }

  route(query: string, domain?: DomainId): RouteDecision {
    return this.registry.route(query, domain);
  }

  /** True when a model at `tier` is capable enough for every domain. */
  supports(tier: ModelTier): boolean {
    return this.registry
      .list()
      .every((domain) => TIER_ORDER[tier] >= TIER_ORDER[domain.minModelTier]);
  }

  async ask(request: IntelligenceRequest): Promise<IntelligenceResult> {
    if (!request || typeof request !== 'object') {
      throw new IntelligenceInputError('request must be an object');
    }
    const query = typeof request.query === 'string' ? request.query.trim() : '';
    if (!query) throw new IntelligenceInputError('query must be a non-empty string');
    if (query.length > 4000) throw new IntelligenceInputError('query is too long (max 4000 chars)');
    if (request.payload !== undefined && !isPlainObject(request.payload)) {
      throw new IntelligenceInputError('payload must be an object');
    }
    const payload = request.payload ?? {};
    const routedBy: IntelligenceResult['routedBy'] = request.domain ? 'explicit' : 'keyword';
    const route = this.registry.route(query, request.domain);
    const result = this.runDomain(route.domain.id, query, payload, request.limits?.maxResults);
    const capped = this.capVerification(result, route.domain.verification);
    const receipt = this.seal(
      route.domain.id,
      { query, payload },
      capped.answer,
      capped.verification
    );
    return {
      ...capped,
      domain: route.domain.id,
      routedBy,
      routeScore: route.score,
      receipt,
    };
  }

  /**
   * Append a hash-chained receipt for an intelligence-adjacent mutation or
   * read that does not pass through `ask` (indexing, forgetting, diagnostics).
   */
  seal(
    domain: string,
    request: unknown,
    answer: string,
    verification: VerificationLevel = 'verified'
  ): Receipt {
    return this.audit.append({
      domain,
      verification,
      requestHash: hashObject(request),
      answerHash: sha256(answer),
    });
  }

  status(): IntelligenceStatus {
    return {
      name: this.name,
      version: this.version,
      dataDir: this.dataDir,
      domains: this.registry.list().map((domain) => ({
        id: domain.id,
        name: domain.name,
        verification: domain.verification,
        minModelTier: domain.minModelTier,
        deterministic: domain.deterministic,
      })),
      documents: this.documents.stats(),
      preferences: { categories: this.preferences.list().length },
      audit: { entries: this.audit.count, tipHash: this.audit.tip, path: this.auditPath },
    };
  }

  verifyAudit() {
    return this.audit.verify();
  }

  private runDomain(
    domain: DomainId,
    query: string,
    payload: Record<string, unknown>,
    maxResults?: number
  ): DomainResult {
    switch (domain) {
      case 'documents':
        return this.documents.answer(query, maxResults ?? 5);
      case 'planning':
        return planResult(
          createPlan({
            objective: query,
            constraints: Array.isArray(payload.constraints) ? payload.constraints.map(String) : [],
            deadline: typeof payload.deadline === 'string' ? payload.deadline : '',
            context: typeof payload.context === 'string' ? payload.context : '',
          })
        );
      case 'market': {
        if (!Array.isArray(payload.prices)) {
          throw new IntelligenceInputError(
            'market requests require payload.prices (an array of numbers or candle objects)',
            { example: { prices: [100, 101, 102], instrument: 'equity' } }
          );
        }
        const instrument = payload.instrument;
        if (
          typeof instrument !== 'string' &&
          !isPlainObject(instrument)
        ) {
          throw new IntelligenceInputError('payload.instrument must be a string or { type, timeframe }');
        }
        const interpretation = interpretMarket(
          payload.prices,
          instrument as string | MarketInstrument,
          isPlainObject(payload.context) ? payload.context : undefined
        );
        return marketResult(interpretation, payload.prices);
      }
      case 'preferences':
        return this.runPreferences(payload);
      default:
        throw new IntelligenceInputError(`unsupported intelligence domain: ${String(domain)}`);
    }
  }

  private runPreferences(payload: Record<string, unknown>): DomainResult {
    const action = typeof payload.action === 'string' ? payload.action : 'list';
    if (action === 'record') {
      const category = typeof payload.category === 'string' ? payload.category : '';
      const signal = payload.signal;
      if (typeof signal !== 'string') {
        throw new IntelligenceInputError('preference record requires payload.signal');
      }
      return this.preferences.toResult(
        this.preferences.record(category, signal as PreferenceSignal)
      );
    }
    if (action === 'get') {
      const category = typeof payload.category === 'string' ? payload.category : '';
      if (!category) throw new IntelligenceInputError('preference get requires payload.category');
      return this.preferences.toResult(this.preferences.get(category));
    }
    if (action !== 'list') {
      throw new IntelligenceInputError(`unknown preference action: ${action}`, {
        allowed: ['list', 'get', 'record'],
      });
    }
    const list = this.preferences.list();
    if (list.length === 0) {
      return {
        answer: 'No owner preference feedback is recorded yet.',
        verification: 'advisory',
        confidence: 0.2,
        evidence: [],
        disclosures: ['Preferences are recorded only from explicit owner feedback.'],
        data: { preferences: [] },
      };
    }
    return {
      answer:
        `Recorded preference categories: ${list.map((entry) => entry.category).join(', ')}. ` +
        list.map((entry) => `${entry.category}: ${entry.styleHint}`).join(' '),
      verification: 'advisory',
      confidence: 0.7,
      evidence: list.map((entry) => ({
        kind: 'preference' as const,
        label: entry.category,
        value: { analyticBias: entry.analyticBias, synthesisBias: entry.synthesisBias },
      })),
      disclosures: ['Reflects only explicitly recorded feedback; stored locally.'],
      data: { preferences: list as unknown as Record<string, unknown>[] },
    };
  }

  private capVerification(result: DomainResult, ceiling: VerificationLevel): DomainResult {
    const floor: VerificationLevel = result.evidence.length === 0 ? 'unverified' : result.verification;
    const capped =
      VERIFICATION_ORDER[floor] > VERIFICATION_ORDER[ceiling] ? ceiling : floor;
    return capped === result.verification ? result : { ...result, verification: capped };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
