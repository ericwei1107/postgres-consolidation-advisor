import type { AdvisorConfig } from '../config.js';
import type { DetectedStore } from '../types.js';

/**
 * Detector contract (PLAN.md §2 pipeline). Each detector is isolated: the
 * orchestrator (analyze.ts) catches throws and turns them into warnings so one
 * detector failing never sinks the run.
 */
export interface DetectorContext {
  repoPath: string;
  config: AdvisorConfig;
  /** Record a non-fatal analysis warning (surfaced to stderr / report). */
  addWarning(message: string): void;
}

export interface Detector {
  readonly name: string;
  detect(ctx: DetectorContext): Promise<DetectedStore[]>;
}
