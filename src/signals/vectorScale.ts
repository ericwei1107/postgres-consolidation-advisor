import type { DetectorContext } from '../detectors/types.js';
import { loadEmbeddingDims } from '../rules.js';
import type { UsageEvidence } from '../usage/harvester.js';
import { lineAt, readRepoFile } from './sourceScan.js';
import type { Signal } from './types.js';

/**
 * vectorScale (PLAN.md 4.3 / §1.5) — embedding dimensionality is the
 * genuinely static half of this category's signal (the RAM-math verdict
 * needs it: vectors x dims x 4 bytes + graph overhead); vector *count* is
 * explicitly the weak half ("usually estimable only as a range from corpus
 * hints" — PLAN.md §1.5's own fallback) and isn't fabricated here. Scans the
 * files the store's own call sites live in for a known embedding-model name
 * from rules/products.yaml `embedding_dims`.
 */
export function vectorScale(storeId: string, usage: UsageEvidence[], ctx: DetectorContext): Signal | null {
  const hits = usage.filter((u) => u.storeId === storeId);
  if (hits.length === 0) return null;

  const files = [...new Set(hits.map((u) => u.file))];
  const dimsTable = loadEmbeddingDims();

  for (const file of files) {
    const raw = readRepoFile(ctx, file);
    if (raw === null) continue;
    for (const [modelName, dims] of dimsTable) {
      const idx = raw.indexOf(modelName);
      if (idx === -1) continue;
      return {
        variable: 'embedding-dims',
        value: dims,
        observability: 'static',
        evidence: [{ kind: 'call-site', file, line: lineAt(raw, idx), excerpt: modelName }],
      };
    }
  }
  return null;
}
