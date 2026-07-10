import type { OrmModel } from '../detectors/orm.js';
import type { DetectorContext } from '../detectors/types.js';
import { loadScoringConfig, mappingsFor, thresholdsByCategory } from '../rules.js';
import type { DetectedStore, StoreRole, Verdict } from '../types.js';
import type { UsageEvidence } from '../usage/harvester.js';
import { collectSignals } from './collectSignals.js';
import { computeVerdict, type VerdictRules } from './verdict.js';

export { computeVerdict, type VerdictRules } from './verdict.js';
export { collectSignals } from './collectSignals.js';

const NO_VERDICT_ROLES = new Set(['relational', 'unknown']);

/** Loads a category's rules once — the one place Stage 5.1 touches the filesystem-backed loaders. */
export function buildVerdictRules(category: StoreRole['role']): VerdictRules {
  return {
    category,
    thresholds: thresholdsByCategory(category),
    mappingOptions: mappingsFor(category),
    scoring: loadScoringConfig(),
  };
}

/** Computes one Verdict per StoreRole (skipping relational/unknown, which aren't consolidation targets). */
export async function computeVerdicts(
  stores: DetectedStore[],
  roles: StoreRole[],
  usage: UsageEvidence[],
  models: OrmModel[],
  ctx: DetectorContext,
): Promise<Verdict[]> {
  const storesById = new Map(stores.map((s) => [s.id, s]));
  const verdicts: Verdict[] = [];
  for (const role of roles) {
    if (NO_VERDICT_ROLES.has(role.role)) continue;
    const store = storesById.get(role.storeId);
    const signals = await collectSignals(role, store, usage, models, ctx);
    const rules = buildVerdictRules(role.role);
    verdicts.push(computeVerdict(role, signals, rules));
  }
  return verdicts;
}
