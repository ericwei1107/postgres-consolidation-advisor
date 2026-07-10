import type { UsageEvidence } from '../usage/harvester.js';
import type { Evidence } from '../types.js';
import type { Signal } from './types.js';

/**
 * cacheCommandMix (PLAN.md 4.3 / §1.2) — cache QPS is rarely statically
 * estimable, so the decisive static signal is the command mix: plain KV vs
 * Redis-native structures with no clean Postgres equivalent
 * (thresholds.yaml cache.redis-native-structures-gate). Returns the plain-KV
 * share (0..1) directly from the Stage 3.1 harvest — no re-scanning needed.
 */

const PLAIN_KV_COMMANDS = new Set(['get', 'set', 'setex', 'del', 'expire', 'ttl', 'mget', 'mset']);
const NATIVE_STRUCTURE_COMMANDS = new Set(['zadd', 'zrange', 'publish', 'subscribe', 'xadd', 'eval', 'incr']);

function toEvidence({ kind, file, line, excerpt }: UsageEvidence): Evidence {
  return { kind, file, ...(line !== undefined ? { line } : {}), excerpt };
}

export function cacheCommandMix(storeId: string, usage: UsageEvidence[]): Signal | null {
  const hits = usage.filter((u) => {
    if (u.storeId !== storeId) return false;
    const command = u.command.toLowerCase();
    return PLAIN_KV_COMMANDS.has(command) || NATIVE_STRUCTURE_COMMANDS.has(command);
  });
  if (hits.length === 0) return null;

  const plainCount = hits.filter((u) => PLAIN_KV_COMMANDS.has(u.command.toLowerCase())).length;

  return {
    variable: 'command-mix-plain-kv-share',
    value: plainCount / hits.length,
    observability: 'static',
    evidence: hits.map(toEvidence),
  };
}
