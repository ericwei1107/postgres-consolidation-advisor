import type { MappingOption, ScoringConfig, ThresholdBand, ThresholdRule } from '../rules.js';
import { isSignalRange, type Signal, type SignalRange } from '../signals/types.js';
import { renderRationale } from './rationale.js';
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
  // Change-stream usage is directly visible in already-harvested call-site
  // evidence (mongo's `.watch(` pattern, PLAN.md 3.1) — no new signal needed.
  // Sharding-config detection isn't implemented, so only half the gate's
  // documented OR condition can fire; that's an honest partial, not a wrong
  // answer (matches the "gates not listed here" limitation above).
  'document.change-streams-sharding-gate': ({ storeRole }) => storeRole.evidence.some((e) => e.excerpt.includes('.watch(')),
  'search.log-analytics-gate': ({ signals }) => {
    const count = numericSignal(signals, 'log-analytics-signal-count');
    return count !== undefined && count > 0;
  },
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

const OVERRIDDEN_CITATION = 'user-overridden; cited source no longer applies';

function primarySource(threshold: ThresholdRule | undefined): string {
  if (threshold?.overridden) return OVERRIDDEN_CITATION;
  return threshold?.sources[0]?.url ?? '';
}

/** The parenthesized citation in a rationale: `(grade: url)`, or the override note. */
function citation(threshold: ThresholdRule): string {
  if (threshold.overridden) return `(${OVERRIDDEN_CITATION})`;
  return `(${threshold.sources[0]?.grade ?? 'source'}: ${primarySource(threshold)})`;
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

/**
 * Scales a [0,1] distance-from-boundary ratio by this threshold's relative
 * weight (thresholds.yaml `weight`, default `scoring.default_weight`) — a
 * heavier weight pushes fitScore further from the neutral midpoint (0.5), a
 * lighter one pulls it back toward "borderline-flavored" even on a clear-cut
 * decision. Every current threshold's weight equals default_weight, so this
 * is a no-op until a future threshold is intentionally weighted differently.
 */
function weightedDistance(ratio: number, weight: number, defaultWeight: number): number {
  if (defaultWeight <= 0) return ratio;
  const scale = weight / defaultWeight;
  return Math.max(0, Math.min(1, 0.5 + (ratio - 0.5) * scale));
}

/**
 * A `low`-confidence role classification means the store might not even play
 * this role — a verdict built on that footing can't honestly claim more
 * certainty than the classification it rests on, regardless of how clean the
 * threshold comparison looks. `medium`/`high` role confidence is left
 * untouched: those already mean "we're sure this is the role," so the
 * verdict's own signal observability is free to set confidence higher (e.g.
 * a permanently-unresolvable supporting axis earning `high`, PLAN.md §1.2/1.3).
 */
function capByRoleConfidence(confidence: Confidence, roleConfidence: Confidence): Confidence {
  return roleConfidence === 'low' ? 'low' : confidence;
}

/**
 * PLAN.md §1.5: "the verdict computes the estimate (vectors × dims × 4 bytes
 * + graph overhead) and states it" — `embedding-dims` (vectorScale, Stage
 * 4.3) is the genuinely static half of this category's signal; this is the
 * one place it's actually read. Uses the top of the vector-count range
 * (the more conservative RAM estimate) and rounds up; "graph overhead" is
 * named as an omission, not computed, since it depends on HNSW parameters
 * this tool never observes.
 */
function vectorRamNote(signals: Signal[], countValue: number | SignalRange): string | undefined {
  const dimsSignal = signals.find((s) => s.variable === 'embedding-dims');
  if (!dimsSignal || isSignalRange(dimsSignal.value)) return undefined;
  const dims = dimsSignal.value;
  const count = isSignalRange(countValue) ? countValue.max : countValue;
  const gb = (count * dims * 4) / 1e9;
  return `HNSW RAM estimate: ~${fmt(Math.ceil(gb))} GB for ${fmt(count)} vectors x ${dims} dims x 4 bytes (graph overhead not included)`;
}

/**
 * PLAN.md §1.7: dataset size is "rarely visible in-repo", so the verdict
 * "keys off presence signals ... instead" — `dbt-model-count`
 * (olapPresenceSignals, Stage 4.3) only ever matters when the real
 * scanned-data-size-gb axis is unresolved, which is exactly the
 * total-axis-absence path below.
 */
function olapPresenceNote(signals: Signal[]): string | undefined {
  const presence = signals.find((s) => s.variable === 'dbt-model-count');
  if (!presence || isSignalRange(presence.value)) return undefined;
  return `Presence signal: ${fmt(presence.value)} dbt model(s) detected (a repo-size hint, not a measurement of scanned data volume)`;
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

function migrationEffort(evidence: Evidence[], option: MappingOption | undefined): MigrationEffort | undefined {
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
    confidence: capByRoleConfidence(confidence, storeRole.confidence),
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
    const migration = decision === 'consolidate' ? migrationEffort(evidence, option) : undefined;
    const rationale = renderRationale({
      decision,
      storeId: storeRole.storeId,
      observed: gate.gateSignals.join('; '),
      verb: decision === 'keep' ? 'trips' : 'satisfies',
      threshold: gate.description,
      citation: gate.sources.length > 0 ? citation(gate) : '',
      postgresEquivalent: option?.label ?? 'no Postgres-native mapping defined for this category',
      failureMode: gate.failureMode,
      evidenceRef: evidenceRef(evidence),
      migrationEffort: migration,
    });
    return baseVerdict(
      storeRole,
      decision,
      confidence,
      rules.scoring.qualitativeGateMaxFitScore,
      comparison,
      option,
      rationale,
      migration,
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
    if (!loBand && !hiBand) {
      // Two very different kinds of "no band": a one-sided threshold (e.g.
      // cache.fan-out-calls-per-request: only a `keep` band starting at 10)
      // has no band at all below its cutoff — a value there isn't
      // "straddling" anything, this axis simply has nothing to say, so move
      // on to the next threshold (or the supporting-axis / total-absence
      // fallback) rather than reporting a false borderline. But a value in
      // an INTERIOR gap — cited bands exist both below and above it, e.g.
      // vector's 50M-100M where public benchmarks stop (A4) — was genuinely
      // observed and genuinely undecided: that is a borderline, and skipping
      // it would misreport the store as "no static signal found".
      const interiorGap =
        threshold.bands.some((b) => b.max !== undefined && b.max <= lo) &&
        threshold.bands.some((b) => b.min !== undefined && b.min > hi);
      if (!interiorGap) continue;
    }
    const straddles = !loBand || !hiBand || loBand.decision !== hiBand.decision;
    const decision: Verdict['decision'] = straddles ? 'borderline' : loBand.decision;
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
    const migration = decision === 'consolidate' ? migrationEffort(evidence, option) : undefined;
    const verb = decision === 'keep' ? 'exceeds' : decision === 'consolidate' ? 'is under' : 'sits inside';
    const rationale = renderRationale({
      decision,
      storeId: storeRole.storeId,
      observed: `${threshold.variable} observed ${formatValue(signal.value, threshold.unit)}`,
      verb,
      threshold: comparison.threshold,
      citation: threshold.sources.length > 0 ? citation(threshold) : '',
      postgresEquivalent: option?.label ?? 'no Postgres-native mapping defined for this category',
      failureMode: threshold.failureMode,
      evidenceRef: evidenceRef(evidence),
      migrationEffort: migration,
      note: threshold.variable === 'count-vectors' ? vectorRamNote(signals, signal.value) : undefined,
    });
    const rawRatio = bandDistanceRatio(hi, decision, band ?? loBand ?? hiBand);
    const scaledRatio = weightedDistance(rawRatio, threshold.weight ?? rules.scoring.defaultWeight, rules.scoring.defaultWeight);
    return baseVerdict(
      storeRole,
      decision,
      confidence,
      rules.scoring.baseScore * (1 - scaledRatio),
      comparison,
      option,
      rationale,
      migration,
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
      const migration = decision === 'consolidate' ? migrationEffort(evidence, option) : undefined;
      const rationale = renderRationale({
        decision,
        storeId: storeRole.storeId,
        observed: `${axis.variable} = ${formatValue(signal.value)}`,
        verb: 'stands in for',
        threshold: `${standIn?.variable ?? axis.standsInFor} (not statically observable in this repo)`,
        citation: '',
        postgresEquivalent: option?.label ?? 'no Postgres-native mapping defined for this category',
        evidenceRef: evidenceRef(evidence),
        migrationEffort: migration,
      });
      return baseVerdict(
        storeRole,
        decision,
        confidence,
        decision === 'consolidate' ? rules.scoring.baseScore * 0.7 : rules.scoring.baseScore * 0.5,
        comparison,
        option,
        rationale,
        migration,
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
  const rationale = renderRationale({
    decision: 'borderline',
    storeId: storeRole.storeId,
    observed: `no static signal resolves ${comparison.variable}`,
    verb: 'for',
    threshold:
      `this repo; defaulting to ${option?.label ?? 'the category default'} pending a corpus/usage estimate or ` +
      '`postgres-advisor analyze --live`',
    citation: '',
    postgresEquivalent: option?.label ?? 'no Postgres-native mapping defined for this category',
    evidenceRef: evidenceRef(storeRole.evidence),
    note: storeRole.role === 'olap' ? olapPresenceNote(signals) : undefined,
  });
  return baseVerdict(storeRole, 'borderline', 'low', rules.scoring.baseScore * 0.5, comparison, option, rationale, undefined, rules.scoring);
}
