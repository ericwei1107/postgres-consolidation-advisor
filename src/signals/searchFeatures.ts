import type { DetectorContext } from '../detectors/types.js';
import type { Evidence } from '../types.js';
import type { UsageEvidence } from '../usage/harvester.js';
import { readRepoFile } from './sourceScan.js';
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

/**
 * search.log-analytics-gate's static half (PLAN.md §1.3): a daily-index
 * naming pattern — a rolling `name-*` query pattern, or a template literal
 * that stitches year/month/day into an index name — is the concrete,
 * grep-able signature of the log-analytics access shape. Logstash/Beats
 * presence in compose is the gate's other named signal but lives in a
 * different detector's evidence, so it isn't checked here.
 */
const DAILY_INDEX_PATTERNS: RegExp[] = [
  /['"`][\w-]*-\*['"`]/,
  /`[\w-]*-\$\{[^}]+\}\.\$\{[^}]+\}\.\$\{[^}]+\}`/,
];

export function searchLogAnalyticsSignal(storeId: string, usage: UsageEvidence[], ctx: DetectorContext): Signal | null {
  const hits = usage.filter((u) => u.storeId === storeId);
  if (hits.length === 0) return null;

  const files = [...new Set(hits.map((u) => u.file))];
  const evidence: Evidence[] = [];
  for (const file of files) {
    const raw = readRepoFile(ctx, file);
    if (raw === null) continue;
    if (DAILY_INDEX_PATTERNS.some((pattern) => pattern.test(raw))) {
      evidence.push({ kind: 'call-site', file, excerpt: 'daily-index naming pattern detected' });
    }
  }
  if (evidence.length === 0) return null;

  return {
    variable: 'log-analytics-signal-count',
    value: evidence.length,
    observability: 'static',
    evidence,
  };
}
