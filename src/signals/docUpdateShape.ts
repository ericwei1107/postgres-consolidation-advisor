import type { DetectorContext } from '../detectors/types.js';
import type { Evidence } from '../types.js';
import type { UsageEvidence } from '../usage/harvester.js';
import { readRepoFile } from './sourceScan.js';
import type { Signal } from './types.js';

/**
 * docUpdateShape (PLAN.md 4.3 / §1.4) — frequent field-level mutators
 * ($set/$inc/$push) vs whole-document replacement is the update-shape axis
 * that decides the TOAST-rewrite gate. The Stage 3.1 harvester captures the
 * *method* (updateOne/update_one/...) but never the operator keys inside the
 * update document, which usually sit on a later line of the same call — so
 * this re-scans the files the harvester already pointed at.
 */

const UPDATE_COMMANDS = new Set([
  'updateone',
  'updatemany',
  'findoneandupdate',
  'findoneandreplace',
  'replaceone',
  'update_one',
  'update_many',
  'find_one_and_update',
  'find_one_and_replace',
  'replace_one',
]);

const MUTATOR_OPERATOR_RE = /\$(?:set|inc|push)\b/g;

function toEvidence({ kind, file, line, excerpt }: UsageEvidence): Evidence {
  return { kind, file, ...(line !== undefined ? { line } : {}), excerpt };
}

export function docUpdateShape(storeId: string, usage: UsageEvidence[], ctx: DetectorContext): Signal | null {
  const updateHits = usage.filter((u) => u.storeId === storeId && UPDATE_COMMANDS.has(u.command.toLowerCase()));
  if (updateHits.length === 0) return null;

  const files = [...new Set(updateHits.map((u) => u.file))];
  let mutatorCount = 0;
  const evidence: UsageEvidence[] = [];

  for (const file of files) {
    const raw = readRepoFile(ctx, file);
    if (raw === null) continue;
    const matches = raw.match(MUTATOR_OPERATOR_RE) ?? [];
    mutatorCount += matches.length;
    if (matches.length > 0) evidence.push(...updateHits.filter((u) => u.file === file));
  }

  return {
    variable: 'field-level-mutator-count',
    value: mutatorCount,
    observability: 'static',
    evidence: evidence.map(toEvidence),
  };
}
