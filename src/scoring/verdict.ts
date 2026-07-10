import type { MappingOption, ScoringConfig, ThresholdBand, ThresholdRule } from '../rules.js';
import { isSignalRange, type Signal, type SignalRange } from '../signals/types.js';
import type {
  Confidence,
  Evidence,
  MigrationEffort,
  StoreCategory,
  StoreRole,
  ThresholdComparison,
  Verdict,
} from '../types.js';

/**
 * Verdict engine (PLAN.md 5.1) — pure function `(StoreRole, signals, rules)
 * -> Verdict`. No I/O: every rule/mapping/scoring input is passed in, loaded
 * by the caller from rules.ts (see `buildVerdictRules` below, which is the
 * one place that touches the filesystem-backed rule loaders).
 *
 * Decision order, fixed by PLAN.md 5.1:
 *  1. Qualitative gates — any gate firing decides the verdict outright,
 *     fitScore capped at `scoring.qualitative_gate_max_fit_score`.
 *  2. A bands threshold with a matching signal — entire estimated range
 *     below the boundary -> consolidate, above -> keep, straddling (or
 *     landing in a gap between bands) -> borderline, regardless of whether
 *     the yaml spells out an explicit borderline band.
 *  3. No bands threshold resolves (no matching signal), but the category has
 *     a *supporting axis* — a signal that doesn't measure the threshold
 *     variable itself but is still decision-informative (search's
 *     aggs/function_score feature count when corpus size is unknown, per
 *     §1.3's own stated fallback). Confidence here depends on whether the
 *     primary axis is EVER resolvable in v1: `live_source: incumbent-only`
 *     means the supporting axis effectively *is* the permanent decision
 *     variable (high confidence); `pg-stats` means a better answer exists in
 *     principle via `--live` and this is a hedge (medium).
 *  4. Total axis absence: no gate, no band match, no supporting axis ->
 *     `borderline`, confidence `low`, per PLAN.md §0's general rule. The
 *     verdict still names a `postgresEquivalent` (the category's default/
 *     first mapping option) so the report isn't a shrug.
 */

export interface VerdictRules {
  category: StoreCategory;
  thresholds: ThresholdRule[];
  mappingOptions: MappingOption[];
  scoring: ScoringConfig;
}

interface GateContext {
  storeRole: StoreRole;
  signals: Signal[];
  rules: VerdictRules;
}

type GateChecker = (ctx: GateContext) => boolean;

function numericSignal(signals: Signal[], variable: string): number | undefined {
  const signal = signals.find((s) => s.variable === variable);
  if (!signal || isSignalRange(signal.value)) return undefined;
  return signal.value;
}

function bandMax(rules: VerdictRules, thresholdId: string): number | undefined {
  const threshold = rules.thresholds.find((t) => t.id === thresholdId);
  if (!threshold || threshold.comparison !== 'bands') return undefined;
  return threshold.bands.find((b) => b.max !== undefined)?.max;
}

/**
 * Gates this engine can actually evaluate from Stage 4.3 signals. Gates not
 * listed here (streaming-semantics, sub-ms-slo, change-streams-sharding,
 * multitenant-serverless, incumbent-dependency, bi-concurrency-cross-org,
 * niche-nondb-features) have no supporting signal yet and never fire — an
 * honest limitation, not a silent wrong answer: PLAN.md never claims a
 * confident "keep" it can't back with evidence.
 */
const GATE_CHECKERS: Record<string, GateChecker> = {
  'cache.redis-native-structures-gate': ({ signals }) => {
    const share = numericSignal(signals, 'command-mix-plain-kv-share');
    return share !== undefined && share < 1;
  },
  'document.field-level-update-gate': ({ signals, rules }) => {
    const mutators = numericSignal(signals, 'field-level-mutator-count');
    const size = numericSignal(signals, 'avg-doc-size-bytes');
    const boundary = bandMax(rules, 'document.avg-doc-size-bytes');
    if (mutators === undefined || size === undefined || boundary === undefined) return false;
    return mutators > 0 && size > boundary;
  },
  'graph.variable-length-or-gds-gate': ({ signals }) => {
    const count = numericSignal(signals, 'variable-length-traversal-count');
    return count !== undefined && count > 0;
  },
  'graph.fixed-depth-traversal-gate': ({ signals }) => {
    const count = numericSignal(signals, 'variable-length-traversal-count');
    return count !== undefined && count === 0;
  },
  'geospatial.default-consolidate-gate': ({ storeRole }) => storeRole.evidence.length > 0,
};

/** Search's feature-signal-count and cache's command-mix-plain-kv-share, per PLAN.md §1.2/1.3's own fallback text. */
interface SupportingAxis {
  variable: string;
  /** True when the observed value points toward `consolidate`. */
  favorable: (value: number) => boolean;
  /** The bands threshold this axis stands in for (drives confidence + citation). */
  standsInFor: string;
}

const SUPPORTING_AXES: Partial<Record<StoreCategory, SupportingAxis>> = {
  cache: {
    variable: 'command-mix-plain-kv-share',
    favorable: (v) => v >= 1,
    standsInFor: 'cache.est-ops-per-sec',
  },
  search: {
    variable: 'feature-signal-count',
    favorable: (v) => v === 0,
    standsInFor: 'search.corpus-size-docs',
  },
};

function confidenceFromObservability(observability: Signal['observability']): Confidence {
  if (observability === 'static') return 'high';
  if (observability === 'estimated') return 'medium';
  return 'low';
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const [intPart, frac] = Math.abs(n).toString().split('.');
  const withCommas = (intPart ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + withCommas + (frac ? `.${frac}` : '');
}

function formatValue(value: number | SignalRange, unit?: string): string {
  const suffix = unit ? ` ${unit}` : '';
  return isSignalRange(value) ? `${fmt(value.min)}-${fmt(value.max)}${suffix}` : `${fmt(value)}${suffix}`;
}

function formatBand(band: ThresholdBand, unit?: string): string {
  const suffix = unit ? ` ${unit}` : '';
  if (band.min !== undefined && band.max !== undefined) return `${fmt(band.min)} <= value < ${fmt(band.max)}${suffix}`;
  if (band.min !== undefined) return `value >= ${fmt(band.min)}${suffix}`;
  if (band.max !== undefined) return `value < ${fmt(band.max)}${suffix}`;
  return '(unbounded)';
}

function mappingOption(rules: VerdictRules, name: string | undefined): MappingOption | undefined {
  if (name) return rules.mappingOptions.find((o) => o.name === name);
  return rules.mappingOptions[0];
}

function primarySource(threshold: ThresholdRule | undefined): string {
  return threshold?.sources[0]?.url ?? '';
}

function evidenceRef(evidence: Evidence[]): string {
  const first = evidence[0];
  if (!first) return 'no evidence recorded';
  return first.line !== undefined ? `${first.file}:${first.line}` : first.file;
}

/** clamp to [0, scoring.base_score] — fitScore is JSON-only (never rendered in human surfaces, PLAN.md 7.0), so a defensible heuristic is enough. */
function clampScore(n: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(n)));
}

/** 0 = deep in the consolidate zone, 1 = deep in the keep zone, 0.5 = borderline/unresolved. */
function bandDistanceRatio(value: number, decision: Verdict['decision'], band: ThresholdBand | undefined): number {
  if (decision === 'consolidate' && band?.max !== undefined && band.max > 0) {
    return Math.max(0, Math.min(1, value / band.max)) * 0.5;
  }
  if (decision === 'keep' && band?.min !== undefined && band.min > 0) {
    return 0.5 + Math.max(0, Math.min(1, 1 - band.min / Math.max(value, band.min))) * 0.5;
  }
  return 0.5;
}

function bandContaining(value: number, bands: ThresholdBand[]): ThresholdBand | undefined {
  return bands.find((b) => (b.min === undefined || value >= b.min) && (b.max === undefined || value < b.max));
}

/** storeRole.evidence and a signal's own evidence often overlap (both trace back to the same harvested call sites). */
function dedupeEvidence(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const e of evidence) {
    const key = `${e.kind}|${e.file}|${e.line ?? ''}|${e.excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function migrationEffort(rules: VerdictRules, storeRole: StoreRole, evidence: Evidence[], option: MappingOption | undefined): MigrationEffort | undefined {
  if (!option) return undefined;
  const callSites = evidence.filter((e) => e.kind === 'call-site').length;
  const filesTouched = new Set(evidence.map((e) => e.file)).size;
  return {
    callSites,
    filesTouched,
    dataMigration: option.dataMigration,
    rollbackNote: option.rollback,
  };
}

function baseVerdict(
  storeRole: StoreRole,
  decision: Verdict['decision'],
  confidence: Confidence,
  fitScore: number,
  comparison: ThresholdComparison,
  option: MappingOption | undefined,
  rationale: string,
  migration: MigrationEffort | undefined,
  scoring: ScoringConfig,
): Verdict {
  return {
    storeId: storeRole.storeId,
    role: storeRole.role,
    decision,
    fitScore: clampScore(fitScore, scoring.baseScore),
    confidence,
    thresholdComparisons: [comparison],
    rationale,
    postgresEquivalent: option?.label ?? 'no Postgres-native mapping defined for this category',
    ...(option ? { snippetId: option.name } : {}),
    ...(migration ? { migrationEffort: migration } : {}),
  };
}

/** Pure verdict computation — PLAN.md 5.1. */
export function computeVerdict(storeRole: StoreRole, signals: Signal[], rules: VerdictRules): Verdict {
  const gateThresholds = rules.thresholds.filter((t) => t.comparison === 'gate');
  for (const gate of gateThresholds) {
    if (gate.comparison !== 'gate') continue;
    const checker = GATE_CHECKERS[gate.id];
    if (!checker || !checker({ storeRole, signals, rules })) continue;

    const option = mappingOption(rules, gate.mappingOption);
    const decision = gate.gateDecision;
    const confidence = confidenceFromObservability(gate.observability);
    const comparison: ThresholdComparison = {
      variable: gate.variable,
      observed: gate.gateSignals.join('; '),
      threshold: `qualitative gate (fires -> ${decision})`,
      source: primarySource(gate),
      passed: decision === 'consolidate',
    };
    const evidence = dedupeEvidence([...storeRole.evidence, ...signals.flatMap((s) => s.evidence)]);
    const rationale =
      `${decision === 'keep' ? 'Keep' : 'Consolidate'} ${storeRole.storeId} — ${gate.description} ` +
      `(${evidenceRef(evidence)}). ${gate.failureMode ?? ''}`.trim();
    return baseVerdict(
      storeRole,
      decision,
      confidence,
      rules.scoring.qualitativeGateMaxFitScore,
      comparison,
      option,
      rationale,
      decision === 'consolidate' ? migrationEffort(rules, storeRole, evidence, option) : undefined,
      rules.scoring,
    );
  }

  const bandsThresholds = rules.thresholds.filter((t) => t.comparison === 'bands');
  for (const threshold of bandsThresholds) {
    if (threshold.comparison !== 'bands') continue;
    const signal = signals.find((s) => s.variable === threshold.variable);
    if (!signal) continue;

    const lo = isSignalRange(signal.value) ? signal.value.min : signal.value;
    const hi = isSignalRange(signal.value) ? signal.value.max : signal.value;
    const loBand = bandContaining(lo, threshold.bands);
    const hiBand = bandContaining(hi, threshold.bands);
    // A one-sided threshold (e.g. cache.fan-out-calls-per-request: only a
    // `keep` band starting at 10) has no band at all below its cutoff. A
    // value that lands in that gap isn't "straddling" anything — this axis
    // simply has nothing to say about it, so move on to the next threshold
    // (or the supporting-axis / total-absence fallback) rather than
    // reporting a false borderline.
    if (!loBand && !hiBand) continue;
    const straddles = !loBand || !hiBand || loBand.decision !== hiBand.decision;
    const decision: Verdict['decision'] = straddles ? 'borderline' : loBand.decision === 'borderline' ? 'borderline' : loBand.decision;
    const band = straddles ? threshold.bands.find((b) => b.decision === 'borderline') : hiBand;

    const confidence: Confidence = straddles ? 'low' : confidenceFromObservability(signal.observability);
    const option = mappingOption(rules, band?.mappingOption);
    const comparison: ThresholdComparison = {
      variable: threshold.variable,
      observed: formatValue(signal.value, threshold.unit),
      threshold: threshold.bands.map((b) => formatBand(b, threshold.unit)).join(' | '),
      source: primarySource(threshold),
      passed: decision === 'consolidate',
    };
    const evidence = dedupeEvidence([...storeRole.evidence, ...signal.evidence]);
    const rationale =
      `${decision === 'keep' ? 'Keep' : decision === 'borderline' ? 'Borderline for' : 'Consolidate'} ` +
      `${storeRole.storeId} — ${threshold.variable} observed ${formatValue(signal.value, threshold.unit)} vs ` +
      `${comparison.threshold} (${threshold.sources[0]?.grade ?? 'source'}: ${comparison.source}). ` +
      `Evidence: ${evidenceRef(evidence)}. ${decision === 'keep' ? (threshold.failureMode ?? '') : ''}`.trim();
    return baseVerdict(
      storeRole,
      decision,
      confidence,
      rules.scoring.baseScore * (1 - bandDistanceRatio(hi, decision, band ?? loBand ?? hiBand)),
      comparison,
      option,
      rationale,
      decision === 'consolidate' ? migrationEffort(rules, storeRole, evidence, option) : undefined,
      rules.scoring,
    );
  }

  const axis = SUPPORTING_AXES[storeRole.role];
  if (axis) {
    const signal = signals.find((s) => s.variable === axis.variable);
    const value = signal && !isSignalRange(signal.value) ? signal.value : undefined;
    if (signal && value !== undefined) {
      const standIn = rules.thresholds.find((t) => t.id === axis.standsInFor);
      const decision: Verdict['decision'] = axis.favorable(value) ? 'consolidate' : 'borderline';
      const permanentlyUnresolvable = standIn?.comparison === 'bands' && standIn.liveSource === 'incumbent-only';
      const confidence: Confidence = decision === 'borderline' ? 'low' : permanentlyUnresolvable ? 'high' : 'medium';
      const option = mappingOption(rules, undefined);
      const comparison: ThresholdComparison = {
        variable: axis.variable,
        observed: formatValue(signal.value),
        threshold: `${standIn?.variable ?? axis.standsInFor} is not statically observable; decided on ${axis.variable} instead`,
        source: primarySource(standIn),
        passed: decision === 'consolidate',
      };
      const evidence = dedupeEvidence([...storeRole.evidence, ...signal.evidence]);
      const rationale =
        `${decision === 'consolidate' ? 'Consolidate' : 'Borderline for'} ${storeRole.storeId} — ` +
        `${standIn?.variable ?? axis.standsInFor} isn't statically observable in this repo, so the verdict is ` +
        `decided on the observable proxy instead: ${axis.variable} = ${formatValue(signal.value)}. ` +
        `Evidence: ${evidenceRef(evidence)}.`;
      return baseVerdict(
        storeRole,
        decision,
        confidence,
        decision === 'consolidate' ? rules.scoring.baseScore * 0.7 : rules.scoring.baseScore * 0.5,
        comparison,
        option,
        rationale,
        decision === 'consolidate' ? migrationEffort(rules, storeRole, evidence, option) : undefined,
        rules.scoring,
      );
    }
  }

  // Total axis absence — PLAN.md §0: unobservable threshold variable -> borderline, confidence low.
  const primaryThreshold = bandsThresholds[0];
  const option = mappingOption(rules, primaryThreshold?.bands.find((b) => b.decision === 'consolidate')?.mappingOption);
  const comparison: ThresholdComparison = {
    variable: primaryThreshold?.variable ?? storeRole.role,
    observed: 'unknown (no static signal found)',
    threshold: primaryThreshold ? primaryThreshold.bands.map((b) => formatBand(b, primaryThreshold.unit)).join(' | ') : 'n/a',
    source: primarySource(primaryThreshold),
    passed: false,
  };
  const rationale =
    `Borderline for ${storeRole.storeId} — no static signal resolves ${comparison.variable} for this repo; ` +
    `defaulting to ${option?.label ?? 'the category default'} pending a corpus/usage estimate or ` +
    `\`postgres-advisor analyze --live\`. Evidence: ${evidenceRef(storeRole.evidence)}.`;
  return baseVerdict(storeRole, 'borderline', 'low', rules.scoring.baseScore * 0.5, comparison, option, rationale, undefined, rules.scoring);
}
