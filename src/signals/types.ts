import type { Evidence } from '../types.js';

/**
 * Signal extractors (PLAN.md 4.3) turn Stage 2/3 detection output into the
 * estimation model's numeric inputs. Every extractor returns this shape, or
 * `null` when the underlying signal simply isn't present in the repo.
 */

export type Observability = 'static' | 'estimated' | 'live-only';

export interface SignalRange {
  min: number;
  max: number;
}

export interface Signal {
  /** Matches a threshold's `variable` in rules/thresholds.yaml where one exists. */
  variable: string;
  value: number | SignalRange;
  observability: Observability;
  evidence: Evidence[];
}

export function isSignalRange(value: number | SignalRange): value is SignalRange {
  return typeof value === 'object';
}
