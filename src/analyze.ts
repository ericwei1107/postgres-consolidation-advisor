import type { AdvisorConfig } from './config.js';
import type { AnalysisResult } from './types.js';

/**
 * Pipeline entry point (PLAN.md §2):
 *   Scanner → Detectors → UsageExtractor → RoleClassifier → FitScorer → SnippetGen → Reporters
 *
 * Stage 1.1: end-to-end skeleton producing an empty inventory. Detectors
 * arrive in Stage 2, and each subsequent stage fills in its box.
 */
export interface AnalyzeOptions {
  repoPath: string;
  config: AdvisorConfig;
  noAi: boolean;
}

export async function analyze(_opts: AnalyzeOptions): Promise<AnalysisResult> {
  return {
    schemaVersion: 1,
    stores: [],
    roles: [],
    verdicts: [],
    warnings: [],
  };
}
