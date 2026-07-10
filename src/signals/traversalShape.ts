import { withoutComments } from '../detectors/orm.js';
import type { DetectorContext } from '../detectors/types.js';
import type { Evidence } from '../types.js';
import type { UsageEvidence } from '../usage/harvester.js';
import { readRepoFile } from './sourceScan.js';
import type { Signal } from './types.js';

/**
 * traversalShape (PLAN.md 4.3 / §1.8) — regexes the files a graph store's
 * call sites live in for the variable-length Cypher marker (`*1..`, `*..5`,
 * `*3..8`, ...). Graph has no numeric threshold ([A6]) — this signal feeds
 * the qualitative fixed-depth-vs-variable-length gate directly, not a band.
 * Comments are stripped first: a block comment like `/*...` contains `*..`,
 * which would otherwise read as a variable-length marker (real Cypher lives
 * in string literals, which stripping preserves).
 */

const VARIABLE_LENGTH_RE = /\*\d*\.\./g;

function toEvidence({ kind, file, line, excerpt }: UsageEvidence): Evidence {
  return { kind, file, ...(line !== undefined ? { line } : {}), excerpt };
}

export function traversalShape(storeId: string, usage: UsageEvidence[], ctx: DetectorContext): Signal | null {
  const hits = usage.filter((u) => u.storeId === storeId);
  if (hits.length === 0) return null;

  const files = [...new Set(hits.map((u) => u.file))];
  let count = 0;
  const matchedFiles = new Set<string>();

  for (const file of files) {
    const raw = readRepoFile(ctx, file);
    if (raw === null) continue;
    const matches = withoutComments(raw).match(VARIABLE_LENGTH_RE) ?? [];
    if (matches.length > 0) {
      count += matches.length;
      matchedFiles.add(file);
    }
  }

  return {
    variable: 'variable-length-traversal-count',
    value: count,
    observability: 'static',
    evidence: hits.filter((h) => matchedFiles.has(h.file)).map(toEvidence),
  };
}
