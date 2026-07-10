import { AdvisorError } from './errors.js';
import {
  applyThresholdOverride,
  MAPPED_CATEGORIES,
  thresholdById,
  thresholdsByCategory,
  type ThresholdBand,
  type ThresholdRule,
  type ThresholdSource,
} from './rules.js';

/**
 * `explain <id>` / `explain --list` rendering — PLAN.md 4.2.
 *
 * Output is always markdown: it is both the terminal-readable format and
 * the golden-file format for tests, and it's what the report's
 * threshold-comparison tables and `## Justification` blocks are built from
 * elsewhere in the app.
 */

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const [intPart, frac] = Math.abs(n).toString().split('.');
  const withCommas = (intPart ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + withCommas + (frac ? `.${frac}` : '');
}

function formatSource(s: ThresholdSource): string {
  return `- ${s.url} (${s.grade}${s.note ? ` — ${s.note}` : ''})`;
}

function formatBand(b: ThresholdBand): string {
  const cmp =
    b.min !== undefined && b.max !== undefined
      ? `${fmt(b.min)} ≤ value < ${fmt(b.max)}`
      : b.min !== undefined
        ? `value ≥ ${fmt(b.min)}`
        : b.max !== undefined
          ? `value < ${fmt(b.max)}`
          : '(unbounded)';
  const mapping = b.mappingOption ? ` → \`${b.mappingOption}\`` : '';
  return `- **${b.decision}**: ${cmp}${mapping}`;
}

function liveSourceLine(rule: ThresholdRule): string {
  if (rule.liveSource === 'pg-stats') {
    return '**Live source:** pg-stats — resolvable by `postgres-advisor analyze --live`';
  }
  if (rule.liveSource === 'incumbent-only') {
    return `**Live source:** incumbent-only — ${rule.liveSourceNote ?? 'requires data from the incumbent store; out of v1 scope'}`;
  }
  return '**Live source:** none — not resolvable by live mode';
}

function renderThreshold(rule: ThresholdRule, overrideValue: number | undefined): string {
  const { rule: effective, applied, unsupported } = applyThresholdOverride(rule, overrideValue);
  const lines: string[] = [];

  lines.push(`## ${effective.id}`, '');
  lines.push(`**Category:** ${effective.category}`);
  lines.push(`**Variable:** ${effective.variable}`);
  lines.push(`**Description:** ${effective.description}`);
  lines.push(`**Observability:** ${effective.observability}`);
  lines.push(liveSourceLine(effective));
  lines.push('');

  if (effective.comparison === 'bands') {
    lines.push('**Comparison:** range bands');
    for (const b of effective.bands) lines.push(formatBand(b));
  } else if (effective.comparison === 'gate') {
    lines.push(`**Comparison:** qualitative gate — fires \`${effective.gateDecision}\` when any signal is present`);
    for (const s of effective.gateSignals) lines.push(`- ${s}`);
  } else {
    lines.push('**Comparison:** reference figure (not a decision boundary)');
    lines.push(`- ${fmt(effective.value)}${effective.unit ? ` ${effective.unit}` : ''}`);
  }
  lines.push('');

  if (applied) {
    lines.push(`**Note:** user-overridden to ${fmt(overrideValue as number)} (cited source no longer applies)`, '');
  } else if (unsupported) {
    lines.push(
      `**Note:** an override is configured for \`${effective.id}\` but this is a \`${effective.comparison}\` threshold with no single overridable value — ignored`,
      '',
    );
  }

  lines.push(`**Assumption:** ${effective.assumptionId ? `${effective.assumptionId} (see PLAN.md "Open Questions / Assumptions Made")` : 'none'}`);

  if (effective.sources.length > 0) {
    lines.push('', '**Sources:**');
    for (const s of effective.sources) lines.push(formatSource(s));
  }

  if (effective.failureMode) {
    lines.push('', `**Failure mode (keep):** ${effective.failureMode}`);
  }

  if (effective.note) {
    lines.push('', `**Implementation note:** ${effective.note}`);
  }

  return lines.join('\n') + '\n';
}

/** Renders one threshold's detail — `postgres-advisor explain <id>`. */
export function explainThreshold(id: string, overrides: Record<string, number> = {}): string {
  const rule = thresholdById(id);
  if (!rule) {
    throw new AdvisorError({
      problem: `unknown threshold id \`${id}\``,
      fix: 'run `postgres-advisor explain --list` to see every valid id',
      docsAnchor: 'methodology',
    });
  }
  return renderThreshold(rule, overrides[id]);
}

/** Renders every threshold id grouped by category — `postgres-advisor explain --list`. */
export function listThresholds(): string {
  const lines: string[] = ['# Threshold ids', ''];
  for (const category of MAPPED_CATEGORIES) {
    const rules = thresholdsByCategory(category);
    if (rules.length === 0) continue;
    lines.push(`## ${category}`);
    for (const r of rules) lines.push(`- ${r.id}`);
    lines.push('');
  }
  lines.push('details: `postgres-advisor explain <id>`');
  return lines.join('\n') + '\n';
}
