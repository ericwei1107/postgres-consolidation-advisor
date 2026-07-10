import { DEFAULT_CONFIG, type AdvisorConfig } from '../../src/config.js';
import { composeDetector } from '../../src/detectors/compose.js';
import { dependenciesDetector } from '../../src/detectors/dependencies.js';
import { envDetector } from '../../src/detectors/env.js';
import { extractOrmModels, ormDetector } from '../../src/detectors/orm.js';
import { mergeDetections } from '../../src/detectors/merge.js';
import type { DetectorContext } from '../../src/detectors/types.js';
import { harvestUsage, type UsageEvidence } from '../../src/usage/harvester.js';
import type { DetectedStore } from '../../src/types.js';
import type { OrmModel } from '../../src/detectors/orm.js';

/** Runs the full Stage 2/3 pipeline against a fixture — shared by signal-extractor tests (Stage 4.3). */
export async function runPipeline(
  repoPath: string,
  config: AdvisorConfig = DEFAULT_CONFIG,
): Promise<{ ctx: DetectorContext; stores: DetectedStore[]; usage: UsageEvidence[]; models: OrmModel[]; warnings: string[] }> {
  const warnings: string[] = [];
  const ctx: DetectorContext = { repoPath, config, addWarning: (m) => warnings.push(m) };

  const detections = [
    ...(await composeDetector.detect(ctx)),
    ...(await dependenciesDetector.detect(ctx)),
    ...(await envDetector.detect(ctx)),
    ...(await ormDetector.detect(ctx)),
  ];
  const stores = mergeDetections(detections, ctx.addWarning);
  const usage = await harvestUsage(stores, ctx);
  const models = await extractOrmModels(ctx);

  return { ctx, stores, usage, models, warnings };
}
