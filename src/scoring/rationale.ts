import type { MigrationEffort, Verdict } from '../types.js';

/**
 * Rationale templating (PLAN.md 5.2) — the single place every verdict's
 * prose is assembled, so "keep" and "consolidate" read consistently no
 * matter which decision path in verdict.ts produced them.
 *
 * Keep:       "Keep <store> — <observed> <verb> <threshold> (<source>).
 *              Postgres alternative <equivalent> would still pay this cost:
 *              <failure mode>. Evidence: <path>."
 * Consolidate: same lead clause, then "Evidence: <path>." followed by the
 *              migration-effort line whenever one was computed.
 * Borderline:  lead clause + evidence only — there is no alternative to
 *              name and no migration to describe for an undecided verdict.
 */

const LEAD_WORD: Record<Verdict['decision'], string> = {
  keep: 'Keep',
  consolidate: 'Consolidate',
  borderline: 'Borderline for',
};

export interface RationaleContext {
  decision: Verdict['decision'];
  storeId: string;
  /** What was observed (a signal value, or the qualitative gate signals that fired). */
  observed: string;
  /** How `observed` relates to `threshold` — e.g. "exceeds", "is under", "trips". */
  verb: string;
  /** The threshold/gate being compared against, in prose. */
  threshold: string;
  /** "(grade: url)", the override note, or "" when there is nothing to cite. */
  citation: string;
  postgresEquivalent: string;
  /** Required for `keep`; ignored otherwise. */
  failureMode?: string;
  evidenceRef: string;
  /** Rendered as a trailing sentence for every `consolidate` verdict that has one. */
  migrationEffort?: MigrationEffort;
  /** An extra informational sentence appended before "Evidence:" — e.g. vector's RAM-math note (PLAN.md §1.5) or OLAP's dbt presence signal (§1.7). */
  note?: string;
}

function endWithPeriod(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function migrationLine(effort: MigrationEffort): string {
  return (
    `${plural(effort.callSites, 'call site')} across ${plural(effort.filesTouched, 'file')} to rewrite; ` +
    `data migration: ${effort.dataMigration}; rollback: ${endWithPeriod(effort.rollbackNote)}`
  );
}

export function renderRationale(ctx: RationaleContext): string {
  const cite = ctx.citation ? ` ${ctx.citation}` : '';
  // `threshold` is sometimes a full sentence from thresholds.yaml (a gate's
  // `description`) that already ends in a period — endWithPeriod on the
  // WHOLE clause (not a hardcoded trailing ".") avoids a double period.
  const head = `${LEAD_WORD[ctx.decision]} ${ctx.storeId} — ${endWithPeriod(`${ctx.observed} ${ctx.verb} ${ctx.threshold}${cite}`)}`;
  const note = ctx.note?.trim() ? ` ${endWithPeriod(ctx.note)}` : '';

  if (ctx.decision === 'keep') {
    const failure = ctx.failureMode?.trim()
      ? endWithPeriod(ctx.failureMode)
      : 'has no drop-in Postgres substitute at this shape.';
    return `${head} Postgres alternative ${ctx.postgresEquivalent} would still pay this cost: ${failure}${note} Evidence: ${ctx.evidenceRef}.`;
  }

  if (ctx.decision === 'consolidate') {
    const tail = ctx.migrationEffort ? ` ${migrationLine(ctx.migrationEffort)}` : '';
    return `${head}${note} Evidence: ${ctx.evidenceRef}.${tail}`;
  }

  return `${head}${note} Evidence: ${ctx.evidenceRef}.`;
}
