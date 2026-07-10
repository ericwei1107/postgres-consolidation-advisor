import type { Evidence } from '../types.js';
import type { UsageEvidence } from '../usage/harvester.js';
import type { Signal } from './types.js';

/**
 * searchFeatures (PLAN.md 4.3 / §1.3) — counts aggregation/relevance-tuning
 * feature usage (`aggs`, `function_score`) already captured by the Stage 3.1
 * harvester's elasticsearch/opensearch call patterns. A zero count is a real
 * signal (keyword search with basic ranking, the consolidate-shaped case),
 * not an absent one — absence is "no search usage for this store at all".
 */

const FEATURE_COMMANDS = new Set(['aggs', 'function_score']);

function toEvidence({ kind, file, line, excerpt }: UsageEvidence): Evidence {
  return { kind, file, ...(line !== undefined ? { line } : {}), excerpt };
}

export function searchFeatures(storeId: string, usage: UsageEvidence[]): Signal | null {
  const hits = usage.filter((u) => u.storeId === storeId);
  if (hits.length === 0) return null;

  const featureHits = hits.filter((u) => FEATURE_COMMANDS.has(u.command.toLowerCase()));

  return {
    variable: 'feature-signal-count',
    value: featureHits.length,
    observability: 'static',
    evidence: featureHits.map(toEvidence),
  };
}
