import type { AdvisorConfig } from './config.js';
import { composeDetector } from './detectors/compose.js';
import { dependenciesDetector } from './detectors/dependencies.js';
import { envDetector } from './detectors/env.js';
import { ormDetector } from './detectors/orm.js';
import { mergeDetections } from './detectors/merge.js';
import { harvestUsage } from './usage/harvester.js';
import { classifyStores } from './classify/rules.js';
import { classifyStoresWithGemini } from './classify/gemini.js';
import type { Detection, Detector, DetectorContext } from './detectors/types.js';
import type { AnalysisResult } from './types.js';

/**
 * Pipeline entry point (PLAN.md §2):
 *   Scanner → Detectors → UsageExtractor → RoleClassifier → FitScorer → SnippetGen → Reporters
 *
 * Stage 2.x wires the detectors (compose/k8s, dependency manifests, env/config)
 * and the instance-identity merge (2.3). Detectors run isolated: a throw
 * becomes a warning so one failure never sinks the whole run. Usage
 * extraction, roles, and verdicts arrive in later stages.
 */
export interface AnalyzeOptions {
  repoPath: string;
  config: AdvisorConfig;
  noAi: boolean;
  maxFiles?: number;
}

const DETECTORS: Detector[] = [composeDetector, dependenciesDetector, envDetector, ormDetector];

export async function analyze(opts: AnalyzeOptions): Promise<AnalysisResult> {
  const warnings: string[] = [];
  const ctx: DetectorContext = {
    repoPath: opts.repoPath,
    config: opts.config,
    addWarning: (message) => warnings.push(message),
  };

  const detections: Detection[] = [];
  for (const detector of DETECTORS) {
    try {
      detections.push(...(await detector.detect(ctx)));
    } catch (e) {
      warnings.push(`detector "${detector.name}" failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const stores = mergeDetections(detections, ctx.addWarning);
  const usage = await harvestUsage(stores, ctx, { maxFiles: opts.maxFiles });
  const ruleRoles = classifyStores(stores, usage);
  const roles = await classifyStoresWithGemini(stores, ruleRoles, usage, {
    noAi: opts.noAi,
    apiKey: process.env.GEMINI_API_KEY,
    addWarning: ctx.addWarning,
  });

  return {
    schemaVersion: 1,
    stores,
    roles,
    verdicts: [],
    warnings,
  };
}
