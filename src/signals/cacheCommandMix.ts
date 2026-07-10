import { loadRoleRules } from '../rules.js';
import type { UsageEvidence } from '../usage/harvester.js';
import type { Evidence } from '../types.js';
import type { Signal } from './types.js';

/**
 * cacheCommandMix (PLAN.md 4.3 / §1.2) — cache QPS is rarely statically
 * estimable, so the decisive static signal is the command mix: plain KV vs
 * Redis-native structures with no clean Postgres equivalent
 * (thresholds.yaml cache.redis-native-structures-gate). Returns the plain-KV
 * share (0..1) directly from the Stage 3.1 harvest — no re-scanning needed.
 * The command partition is data, not code: roles.yaml `command_mix` per
 * product. A product without one yields no signal (never a guess).
 */

function toEvidence({ kind, file, line, excerpt }: UsageEvidence): Evidence {
  return { kind, file, ...(line !== undefined ? { line } : {}), excerpt };
}

export function cacheCommandMix(storeId: string, usage: UsageEvidence[]): Signal | null {
  const product = storeId.split(':', 1)[0] ?? '';
  const mix = loadRoleRules().get(product)?.commandMix;
  if (!mix) return null;

  const hits = usage.filter((u) => {
    if (u.storeId !== storeId) return false;
    const command = u.command.toLowerCase();
    return mix.plainKv.has(command) || mix.nativeStructure.has(command);
  });
  if (hits.length === 0) return null;

  const plainCount = hits.filter((u) => mix.plainKv.has(u.command.toLowerCase())).length;

  return {
    variable: 'command-mix-plain-kv-share',
    value: plainCount / hits.length,
    observability: 'static',
    evidence: hits.map(toEvidence),
  };
}
