import type { OrmModel } from '../detectors/orm.js';
import type { DetectorContext } from '../detectors/types.js';
import { applyThresholdOverride, loadScoringConfig, mappingsFor, thresholdsByCategory } from '../rules.js';
import type { DetectedStore, StoreRole, Verdict } from '../types.js';
import type { UsageEvidence } from '../usage/harvester.js';
import { collectSignals } from './collectSignals.js';
import { computeVerdict, type VerdictRules } from './verdict.js';

export { computeVerdict, type VerdictRules } from './verdict.js';
export { collectSignals } from './collectSignals.js';

const NO_VERDICT_ROLES = new Set(['relational', 'unknown']);

/** Loads a category's rules once — the one place Stage 5.1 touches the filesystem-backed loaders. */
export function buildVerdictRules(
  category: StoreRole['role'],
  overrides: Record<string, number> = {},
): VerdictRules {
  return {
    category,
    // Overridden thresholds carry `overridden: true`; the verdict engine
    // renders "(user-overridden; cited source no longer applies)" in place
    // of the citation (the .postgres-advisor.yaml contract in config.ts).
    thresholds: thresholdsByCategory(category).map((t) => applyThresholdOverride(t, overrides[t.id]).rule),
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
    if (store?.suppressed) continue; // suppressed stores stay in the inventory but get no verdict
    const signals = await collectSignals(role, store, usage, models, ctx);
    const rules = buildVerdictRules(role.role, ctx.config.threshold_overrides);
    verdicts.push(computeVerdict(role, signals, rules));
  }
  return verdicts;
}
