import type { DetectorContext } from '../detectors/types.js';
import type { Evidence } from '../types.js';
import type { UsageEvidence } from '../usage/harvester.js';
import { readRepoFile } from './sourceScan.js';
import type { Signal } from './types.js';

/**
 * cacheFanOut (PLAN.md 4.3, [A9]) — counts cache-call sites within a single
 * function's lexical span (same file, between consecutive function-boundary
 * anchors). Deliberately crude: this is line-based counting, not call-graph
 * reachability — a cache call issued inside a loop is one static line no
 * matter how many times it runs at request time, and that blind spot is
 * inherent to the heuristic, not a bug to work around here.
 */

const HANDLER_ANCHOR_PATTERNS: RegExp[] = [
  /\bapp\.(?:get|post|put|delete|patch)\s*\(/,
  /\brouter\.(?:get|post|put|delete|patch)\s*\(/,
  /@(?:app|router)\.(?:get|post|put|delete|patch)\s*\(/,
  /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+\w+\s*\(/,
  /\bexport\s+const\s+\w+\s*=\s*(?:async\s*)?\(/,
  /^\s*(?:async\s+)?def\s+\w+\s*\(/,
];

function isHandlerAnchor(line: string): boolean {
  return HANDLER_ANCHOR_PATTERNS.some((p) => p.test(line));
}

function toEvidence({ kind, file, line, excerpt }: UsageEvidence): Evidence {
  return { kind, file, ...(line !== undefined ? { line } : {}), excerpt };
}

export async function cacheFanOut(storeId: string, usage: UsageEvidence[], ctx: DetectorContext): Promise<Signal | null> {
  const hits = usage.filter((u) => u.storeId === storeId);
  if (hits.length === 0) return null;

  const byFile = new Map<string, UsageEvidence[]>();
  for (const hit of hits) {
    const list = byFile.get(hit.file) ?? [];
    list.push(hit);
    byFile.set(hit.file, list);
  }

  let maxFanOut = 0;
  let bestSpan: UsageEvidence[] = [];

  for (const [file, fileHits] of byFile) {
    const raw = readRepoFile(ctx, file);
    if (raw === null) continue;
    const lines = raw.split('\n');
    const anchorLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (isHandlerAnchor(lines[i] ?? '')) anchorLines.push(i + 1);
    }
    if (anchorLines.length === 0) continue;

    for (let i = 0; i < anchorLines.length; i++) {
      const start = anchorLines[i]!;
      const end = anchorLines[i + 1] ?? lines.length + 1;
      const inSpan = fileHits.filter((h) => h.line !== undefined && h.line >= start && h.line < end);
      if (inSpan.length > maxFanOut) {
        maxFanOut = inSpan.length;
        bestSpan = inSpan;
      }
    }
  }

  if (maxFanOut === 0) return null;
  return {
    variable: 'fan-out-calls-per-request',
    value: maxFanOut,
    observability: 'estimated',
    evidence: bestSpan.map(toEvidence),
  };
}
