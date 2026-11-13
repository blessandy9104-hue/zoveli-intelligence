/**
 * @zoveli/intelligence — one governor over deterministic local domains.
 *
 * Documents: BM25 retrieval with extractive, line-cited answers.
 * Market: deterministic MPM interpretation (never prediction).
 * Planning: reviewable scaffolds with verification criteria.
 * Preferences: explicit feedback turned into a transparent style bias.
 * Audit: append-only SHA-256 hash chain of receipts.
 */

export * from './types.js';
export * from './errors.js';
export * from './text.js';
export * from './store.js';
export * from './audit.js';
export * from './registry.js';
export * from './domains/documents.js';
export * from './domains/market.js';
export * from './domains/planning.js';
export * from './domains/preferences.js';
export * from './tools.js';
export * from './mcp.js';
export {
  IntelligenceGovernor,
  INTELLIGENCE_NAME,
  INTELLIGENCE_VERSION,
  type IntelligenceOptions,
} from './governor.js';

import { IntelligenceGovernor, type IntelligenceOptions } from './governor.js';
import { createIntelligenceTools } from './tools.js';
import type { IntelligenceTool } from './types.js';

/** Create a governor using ZOVELI_INTEL_DATA_DIR or ~/.zoveli/intelligence. */
export function createIntelligence(options: IntelligenceOptions = {}): IntelligenceGovernor {
  return new IntelligenceGovernor(options);
}

/** Convenience bundle for hosts that want the governor and its tools together. */
export function createIntelligenceKit(options: IntelligenceOptions = {}): {
  governor: IntelligenceGovernor;
  tools: IntelligenceTool[];
} {
  const governor = new IntelligenceGovernor(options);
  return { governor, tools: createIntelligenceTools(governor) };
}
