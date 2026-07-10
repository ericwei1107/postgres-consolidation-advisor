import { loadRoleRules, type RoleRule } from '../rules.js';
import type { DetectedStore, Evidence, StoreRole } from '../types.js';
import type { UsageEvidence } from '../usage/harvester.js';

function evidenceFromUsage(usage: UsageEvidence[]): Evidence[] {
  return usage.map(({ kind, file, line, excerpt }) => ({ kind, file, ...(line ? { line } : {}), excerpt }));
}

function role(storeId: string, roleName: StoreRole['role'], confidence: StoreRole['confidence'], evidence: Evidence[]): StoreRole {
  return { storeId, role: roleName, confidence, classifiedBy: 'rule', evidence };
}

function hasLibraryEvidence(store: DetectedStore, libraries: string[]): boolean {
  return store.evidence.some(
    (e) => e.kind === 'dependency' && libraries.some((library) => e.excerpt.toLowerCase().includes(library)),
  );
}

function classifyCacheQueueMix(store: DetectedStore, usage: UsageEvidence[], rule: RoleRule): StoreRole[] {
  const cache = rule.cache;
  const queue = rule.queue;
  if (!cache || !queue) return [role(store.id, 'unknown', 'low', store.evidence)];

  const commands = usage.map((hit) => hit.command.toLowerCase());
  const cacheUsage = usage.filter((hit) => cache.commands.includes(hit.command.toLowerCase()));
  const queueUsage = usage.filter((hit) => queue.commands.includes(hit.command.toLowerCase()));
  const hasQueueLibrary = hasLibraryEvidence(store, queue.libraries);
  const hasQueue = hasQueueLibrary || queueUsage.length > 0;
  const cacheShare = commands.length === 0 ? 0 : cacheUsage.length / commands.length;
  const roles: StoreRole[] = [];

  if (cacheUsage.length > 0 && hasQueue) {
    roles.push(role(store.id, 'cache', cache.mixedConfidence, evidenceFromUsage(cacheUsage)));
  } else if (cacheUsage.length > 0 && cacheShare >= cache.minShare) {
    roles.push(role(store.id, 'cache', 'high', evidenceFromUsage(cacheUsage)));
  }
  if (hasQueue) {
    const queueEvidence = [
      ...store.evidence.filter(
        (e) => e.kind === 'dependency' && queue.libraries.some((library) => e.excerpt.toLowerCase().includes(library)),
      ),
      ...evidenceFromUsage(queueUsage),
    ];
    roles.push(role(store.id, 'queue', 'high', queueEvidence.length > 0 ? queueEvidence : store.evidence));
  }
  return roles.length > 0 ? roles : [role(store.id, 'unknown', 'low', store.evidence)];
}

/** Deterministic role classification. Ambiguous stores stay `unknown` for Stage 3.3. */
export function classifyStores(stores: DetectedStore[], usage: UsageEvidence[]): StoreRole[] {
  const byStore = new Map<string, UsageEvidence[]>();
  for (const hit of usage) {
    const hits = byStore.get(hit.storeId) ?? [];
    hits.push(hit);
    byStore.set(hit.storeId, hits);
  }

  const rules = loadRoleRules();
  return stores.flatMap((store) => {
    const storeUsage = byStore.get(store.id) ?? [];
    const rule = rules.get(store.product);
    if (!rule) return [role(store.id, 'unknown', 'low', store.evidence)];
    // Dispatch on the rule's shape, not the product name: any product whose
    // rules define both a cache command set and queue libraries (today:
    // redis) gets the command-mix classification.
    if (rule.cache && rule.queue) return classifyCacheQueueMix(store, storeUsage, rule);
    if (rule.fixedRole) {
      const evidence = storeUsage.length > 0 ? evidenceFromUsage(storeUsage) : store.evidence;
      return [role(store.id, rule.fixedRole, 'high', evidence)];
    }
    return [role(store.id, 'unknown', 'low', store.evidence)];
  });
}
