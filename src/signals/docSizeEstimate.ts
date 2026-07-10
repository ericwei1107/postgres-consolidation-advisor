import type { OrmModel } from '../detectors/orm.js';
import { loadConstants } from '../rules.js';
import type { Evidence } from '../types.js';
import type { Signal } from './types.js';

/**
 * docSizeEstimate (PLAN.md 4.3 / §1.4) — the pivotal number for the TOAST
 * threshold (document.avg-doc-size-bytes, ~2KB). Prefers a real seed-data-
 * derived estimate (`FieldSummary.estimatedDocBytes`, set by the Stage 2.4
 * ORM detector when it found sample data); falls back to the field-count
 * heuristic ([A8], document.avg-bytes-per-field) when no seed data exists.
 */
export function docSizeEstimate(model: OrmModel): Signal | null {
  const evidence: Evidence[] = [
    { kind: 'orm-schema', file: model.file, line: model.line, excerpt: `model ${model.summary.model}` },
  ];

  if (model.summary.estimatedDocBytes !== undefined) {
    return {
      variable: 'avg-doc-size-bytes',
      value: model.summary.estimatedDocBytes,
      observability: 'estimated',
      evidence,
    };
  }

  if (model.summary.fields.length === 0) return null;

  const bytesPerField = loadConstants().get('document.avg-bytes-per-field');
  if (!bytesPerField || typeof bytesPerField.value !== 'number') return null;

  return {
    variable: 'avg-doc-size-bytes',
    value: model.summary.fields.length * bytesPerField.value,
    observability: 'estimated',
    evidence,
  };
}
