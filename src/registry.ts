import { IntelligenceInputError } from './errors.js';
import type { DomainDefinition, DomainId, RouteCandidate, RouteDecision } from './types.js';

export const DOMAINS: readonly DomainDefinition[] = [
  {
    id: 'documents',
    name: 'Grounded documents',
    description: 'BM25 retrieval and extractive answers over local, allowlisted text files with line citations.',
    keywords: [
      'document', 'documents', 'doc', 'file', 'files', 'folder', 'notes', 'note', 'vault',
      'search', 'find', 'source', 'sources', 'cite', 'citation', 'read', 'summarize',
      'summary', 'manual', 'guide', 'knowledge', 'paper', 'report', 'markdown',
    ],
    verification: 'grounded',
    requiresEvidence: true,
    minModelTier: 'tiny',
    deterministic: true,
  },
  {
    id: 'market',
    name: 'Deterministic market structure',
    description: 'RSI, EMA, ATR, trend, volatility, pattern, and risk-flag interpretation of a supplied price window.',
    keywords: [
      'market', 'price', 'prices', 'trend', 'rsi', 'ema', 'atr', 'candle', 'candles',
      'stock', 'stocks', 'equity', 'crypto', 'fx', 'commodity', 'volatility',
      'breakout', 'sentiment', 'chart', 'overbought', 'oversold', 'uptrend', 'downtrend',
    ],
    verification: 'verified',
    requiresEvidence: true,
    minModelTier: 'tiny',
    deterministic: true,
  },
  {
    id: 'planning',
    name: 'Deterministic planning',
    description: 'Turns an objective into reviewable steps with completion and verification criteria.',
    keywords: [
      'plan', 'planning', 'steps', 'roadmap', 'schedule', 'organize', 'goal', 'checklist',
      'prepare', 'strategy', 'milestone', 'itinerary', 'how do i', 'how to',
    ],
    verification: 'advisory',
    requiresEvidence: false,
    minModelTier: 'tiny',
    deterministic: true,
  },
  {
    id: 'preferences',
    name: 'Owner preferences',
    description: 'Explicit feedback about tone and detail, stored locally and turned into a transparent style bias.',
    keywords: [
      'preference', 'preferences', 'prefer', 'style', 'tone', 'feedback',
      'too technical', 'too vague', 'more detail', 'less detail', 'liked', 'disliked',
    ],
    verification: 'advisory',
    requiresEvidence: false,
    minModelTier: 'tiny',
    deterministic: true,
  },
];

export class IntelligenceRegistry {
  private readonly domains: DomainDefinition[];

  constructor(domains: readonly DomainDefinition[] = DOMAINS) {
    if (domains.length === 0) throw new IntelligenceInputError('registry needs at least one domain');
    const ids = new Set<string>();
    for (const domain of domains) {
      if (ids.has(domain.id)) throw new IntelligenceInputError(`duplicate domain id: ${domain.id}`);
      ids.add(domain.id);
    }
    this.domains = [...domains];
  }

  list(): DomainDefinition[] {
    return [...this.domains];
  }

  get(id: string): DomainDefinition {
    const domain = this.domains.find((entry) => entry.id === id);
    if (!domain) {
      throw new IntelligenceInputError(`unknown intelligence domain: ${id}`, {
        available: this.domains.map((entry) => entry.id),
      });
    }
    return domain;
  }

  route(query: string, requested?: string): RouteDecision {
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text) throw new IntelligenceInputError('query must be a non-empty string');
    if (requested) {
      const explicit = this.get(requested);
      return {
        domain: explicit,
        score: 1,
        alternatives: this.score(text).filter((candidate) => candidate.domain.id !== explicit.id),
      };
    }
    const ranked = this.score(text);
    const best = ranked[0];
    if (!best) throw new IntelligenceInputError('no intelligence domains are registered');
    return { domain: best.domain, score: round(best.score, 4), alternatives: ranked.slice(1) };
  }

  private score(query: string): RouteCandidate[] {
    const lower = query.toLowerCase();
    const ranked = this.domains.map((domain) => {
      let score = 0;
      for (const keyword of domain.keywords) {
        if (lower.includes(keyword)) score += keyword.includes(' ') ? 2 : 1;
      }
      return { domain, score };
    });
    const matched = ranked.filter((candidate) => candidate.score > 0);
    const candidates = matched.length > 0 ? matched : [ranked.find((candidate) => candidate.domain.id === 'documents') ?? ranked[0]];
    return candidates.sort(
      (a, b) => b.score - a.score || a.domain.id.localeCompare(b.domain.id)
    );
  }
}

export function domainById(id: DomainId): DomainDefinition {
  const found = DOMAINS.find((domain) => domain.id === id);
  if (!found) throw new IntelligenceInputError(`unknown intelligence domain: ${id}`);
  return found;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
