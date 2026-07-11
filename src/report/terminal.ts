import type { AnalysisResult, Verdict } from '../types.js';

/**
 * Terminal output contract (PLAN.md 7.0) — stdout is the first surface a user
 * hits. This module renders the *artifact* half: one scannable line per
 * (store, role) verdict, an impact-shaped summary, and a single next-action
 * line. Progress/phase lines and the AI banners are the CLI's job (they go to
 * stderr so a piped stdout stays clean); this module only owns the artifact
 * and the banner *strings* so their copy lives in one place.
 *
 * Design rules baked in here:
 *   - Badge text ([CONSOLIDATE]/[KEEP]/[BORDERLINE]) is never color-only —
 *     color is decoration on top of always-present text, and is dropped
 *     entirely when `color` is false (piped / NO_COLOR / written to a file).
 *   - fitScore appears in NO human surface (JSON only) — the threshold table
 *     in the full report carries the numeric argument.
 */

const ANSI = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
} as const;

const BADGE: Record<Verdict['decision'], { text: string; color: string }> = {
  consolidate: { text: '[CONSOLIDATE]', color: ANSI.green },
  keep: { text: '[KEEP]', color: ANSI.blue },
  borderline: { text: '[BORDERLINE]', color: ANSI.gray },
};

const BADGE_WIDTH = Math.max(...Object.values(BADGE).map((b) => b.text.length));

/** Section order mirrors the markdown report (PLAN.md 7.1): consolidate → keep → borderline. */
const DECISION_RANK: Record<Verdict['decision'], number> = { consolidate: 0, keep: 1, borderline: 2 };

/** Up-front stderr banner when AI is available-but-off (PLAN.md 7.0). */
export const NO_AI_BANNER = 'Running without AI disambiguation — role confidence may be lower';
/** Distinct from the generic API-error fallback: a set-but-rejected key (401/403). */
export const AI_KEY_REJECTED = 'GEMINI_API_KEY set but rejected — check the key, or pass --no-ai to silence';

export interface TerminalOptions {
  /** Emit ANSI color. False when piped, NO_COLOR is set, or writing to a file. */
  color: boolean;
}

/** The short, headline-shaped tail of each verdict line — the argument lives in the full report. */
function detailFor(v: Verdict): string {
  switch (v.decision) {
    case 'consolidate':
      return v.postgresEquivalent;
    case 'keep':
      return 'earning its keep';
    case 'borderline': {
      const variable = v.thresholdComparisons[0]?.variable;
      return variable ? `one measurement away — ${variable}` : 'one measurement away';
    }
  }
}

/**
 * Renders the default `analyze` stdout artifact. `stores` is used only to map a
 * verdict's storeId back to a human product name; verdicts drive everything else.
 */
export function renderTerminal(result: AnalysisResult, opts: TerminalOptions): string {
  const { stores, verdicts } = result;

  // Empty repo is a win state; a repo with stores but no verdicts (all
  // suppressed or relational) is a near-win — say so honestly, don't blank.
  if (verdicts.length === 0) {
    if (stores.length === 0) {
      return '0 data stores detected — nothing to consolidate. This repo is already Postgres-only.\n';
    }
    return `${stores.length} data stores detected — no consolidation candidates (all suppressed or relational).\n`;
  }

  const productById = new Map(stores.map((s) => [s.id, s.product]));
  const sorted = [...verdicts].sort(
    (a, b) =>
      DECISION_RANK[a.decision] - DECISION_RANK[b.decision] ||
      a.storeId.localeCompare(b.storeId) ||
      a.role.localeCompare(b.role),
  );

  const rows = sorted.map((v) => ({
    v,
    label: `${productById.get(v.storeId) ?? v.storeId} (${v.role})`,
    detail: detailFor(v),
  }));
  const labelWidth = Math.max(...rows.map((r) => r.label.length));

  const lines = rows.map(({ v, label, detail }) => {
    const badge = BADGE[v.decision];
    const paddedBadge = badge.text.padEnd(BADGE_WIDTH);
    const shownBadge = opts.color ? `${badge.color}${paddedBadge}${ANSI.reset}` : paddedBadge;
    const connector = v.decision === 'consolidate' ? '→' : '—';
    return `${shownBadge}  ${label.padEnd(labelWidth)}  ${connector} ${detail}`;
  });

  // Impact framing is store-level: a store folds only when EVERY one of its
  // roles consolidates (a cache+queue Redis counts once, and only if both go).
  const storeIds = [...new Set(verdicts.map((v) => v.storeId))];
  const foldable = storeIds.filter((id) =>
    verdicts.filter((v) => v.storeId === id).every((v) => v.decision === 'consolidate'),
  );
  const impact =
    foldable.length > 0
      ? `You can fold ${foldable.length} of ${storeIds.length} stores into Postgres.`
      : `0 of ${storeIds.length} stores can fold into Postgres — the rest are keep or borderline.`;

  const hasBorderline = verdicts.some((v) => v.decision === 'borderline');
  const nextAction = hasBorderline
    ? 'Full report: --out report.md · borderlines: --live <conn>'
    : 'Full report: --out report.md';

  return [...lines, '', impact, nextAction, ''].join('\n');
}
