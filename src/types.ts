/** Shared contracts for the intelligence subsystem. */

export type VerificationLevel = 'verified' | 'grounded' | 'advisory' | 'unverified';

export type EvidenceKind = 'computation' | 'document' | 'preference' | 'plan' | 'user-input';

export type ModelTier = 'tiny' | 'small' | 'medium' | 'large';

export type DomainId = 'documents' | 'market' | 'planning' | 'preferences';

export interface Evidence {
  kind: EvidenceKind;
  label: string;
  source?: string;
  locator?: string;
  excerpt?: string;
  sha256?: string;
  value?: unknown;
}

export interface Receipt {
  id: string;
  ts: string;
  domain: string;
  verification: VerificationLevel;
  requestHash: string;
  answerHash: string;
  prevHash: string;
  hash: string;
}

export interface DomainDefinition {
  id: DomainId;
  name: string;
  description: string;
  keywords: readonly string[];
  /** Best verification level the domain can produce. */
  verification: VerificationLevel;
  /** True when a result without evidence must be downgraded to unverified. */
  requiresEvidence: boolean;
  /** Smallest local model tier that can use the result capably. */
  minModelTier: ModelTier;
  /** Domain is deterministic and never calls a model or the network. */
  deterministic: boolean;
}

export interface IntelligenceLimits {
  maxResults?: number;
  maxChars?: number;
  maxSources?: number;
}

export interface IntelligenceRequest {
  /** Natural-language question or objective. */
  query: string;
  /** Explicit domain override; otherwise the governor routes by intent. */
  domain?: DomainId;
  /** Domain-specific payload (prices for market, signals for preferences). */
  payload?: Record<string, unknown>;
  limits?: IntelligenceLimits;
}

export interface DomainResult {
  answer: string;
  verification: VerificationLevel;
  confidence: number;
  evidence: Evidence[];
  disclosures: string[];
  data?: Record<string, unknown>;
}

export interface IntelligenceResult extends DomainResult {
  domain: DomainId;
  routedBy: 'explicit' | 'keyword';
  routeScore: number;
  receipt: Receipt;
}

export interface RouteCandidate {
  domain: DomainDefinition;
  score: number;
}

export interface RouteDecision {
  domain: DomainDefinition;
  score: number;
  alternatives: RouteCandidate[];
}

export interface DocumentChunk {
  id: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface IndexedDocument {
  path: string;
  title: string;
  sha256: string;
  size: number;
  mtimeMs: number;
  indexedAt: string;
  chunks: DocumentChunk[];
}

export interface DocumentIndexData {
  version: 1;
  updatedAt: string;
  roots: string[];
  documents: IndexedDocument[];
}

export interface DocumentHit {
  source: string;
  title: string;
  startLine: number;
  endLine: number;
  score: number;
  excerpt: string;
  sha256: string;
}

export interface DocumentStats {
  documents: number;
  chunks: number;
  terms: number;
  roots: string[];
  dataDir: string;
  updatedAt: string | null;
}

export interface DocumentIndexResult {
  indexed: Array<{ path: string; title: string; chunks: number; skipped: boolean }>;
  skippedUnsupported: string[];
  errors: Array<{ path: string; error: string }>;
  filesConsidered: number;
  limits: { maxFiles: number; maxFileBytes: number };
}

export type PreferenceSignal =
  | 'too_technical'
  | 'too_vague'
  | 'more_detail'
  | 'less_detail'
  | 'liked'
  | 'disliked';

export interface PreferenceCategory {
  signals: Record<PreferenceSignal, number>;
  updatedAt: string;
}

export interface PreferenceBias {
  category: string;
  analyticBias: number;
  synthesisBias: number;
  styleHint: string;
  signals: Record<PreferenceSignal, number>;
  updatedAt: string | null;
}

export interface PreferenceData {
  version: 1;
  categories: Record<string, PreferenceCategory>;
}

export type InstrumentType = 'equity_index' | 'equity' | 'commodity' | 'fx' | 'crypto' | 'treasury';

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w';

export interface CandleInput {
  close: number;
  high?: number;
  low?: number;
}

export type PricePoint = number | CandleInput;

export interface MarketInstrument {
  type: InstrumentType;
  timeframe?: Timeframe;
}

export interface MarketInterpretation {
  mpm_version: '1.0';
  state: 'interpretation';
  instrument: { type: InstrumentType; timeframe: Timeframe };
  pattern: {
    primary: 'trend_continuation' | 'range_consolidation' | 'breakout' | 'pole_reversal' | 'volatility_cluster';
    confidence: number;
    rationale: string;
  };
  trend: { kind: 'uptrend' | 'downtrend' | 'sideways' | 'choppy'; signal_strength: number; drift_pct: number };
  volatility: { level: 'low' | 'medium' | 'high'; bucket: string; atr_pct: number };
  risk_flags: Array<{
    type: 'overextension' | 'sharp_move' | 'gap' | 'high_volatility';
    severity: 'low' | 'medium' | 'high';
    note: string;
  }>;
  indicator_summary: Array<{ indicator: string; reading: string; detail: string }>;
  sentiment: { source: 'user_provided'; tone: 'positive' | 'neutral' | 'negative' | 'mixed' | 'none' };
  explanation: string;
  disclaimer: string;
}

export interface PlanStep {
  id: string;
  title: string;
  action: string;
  doneWhen: string;
  verification: string;
}

export interface PlanResult {
  id: string;
  objective: string;
  category: 'research' | 'build' | 'write' | 'analyze' | 'organize' | 'learn' | 'generic';
  steps: PlanStep[];
  assumptions: string[];
  risks: string[];
  disclosures: string[];
}

export interface IntelligenceStatus {
  name: string;
  version: string;
  dataDir: string;
  domains: Array<{
    id: DomainId;
    name: string;
    verification: VerificationLevel;
    minModelTier: ModelTier;
    deterministic: boolean;
  }>;
  documents: DocumentStats;
  preferences: { categories: number };
  audit: { entries: number; tipHash: string; path: string };
}

export interface IntelligenceTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}
