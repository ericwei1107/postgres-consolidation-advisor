import type { OrmModel } from '../detectors/orm.js';
import type { DetectorContext } from '../detectors/types.js';
import { cacheCommandMix } from '../signals/cacheCommandMix.js';
import { cacheFanOut } from '../signals/cacheFanOut.js';
import { docSizeEstimate } from '../signals/docSizeEstimate.js';
import { docUpdateShape } from '../signals/docUpdateShape.js';
import { olapPresenceSignals } from '../signals/olapPresenceSignals.js';
import { queueThroughput } from '../signals/queueThroughput.js';
import { searchFeatures } from '../signals/searchFeatures.js';
import type { Signal } from '../signals/types.js';
import { traversalShape } from '../signals/traversalShape.js';
import { vectorScale } from '../signals/vectorScale.js';
import type { DetectedStore, StoreRole } from '../types.js';
import type { UsageEvidence } from '../usage/harvester.js';

/**
 * Maps a StoreRole to the Stage 4.3 signals relevant to its category. No
 * timeseries/geospatial extractor exists yet (PLAN.md 4.3 didn't list one for
 * either — timeseries' own §1.6 fallback is "otherwise borderline", which is
 * exactly what the verdict engine does with zero signals), so those
 * categories fall straight through to the engine's total-axis-absence path.
 */
export async function collectSignals(
  storeRole: StoreRole,
  store: DetectedStore | undefined,
  usage: UsageEvidence[],
  models: OrmModel[],
  ctx: DetectorContext,
): Promise<Signal[]> {
  const storeId = storeRole.storeId;
  switch (storeRole.role) {
    case 'cache': {
      const mix = cacheCommandMix(storeId, usage);
      const fanOut = await cacheFanOut(storeId, usage, ctx);
      return [mix, fanOut].filter((s): s is Signal => s !== null);
    }
    case 'queue': {
      if (!store) return [];
      const throughput = await queueThroughput(store, ctx);
      return throughput ? [throughput] : [];
    }
    case 'search': {
      const features = searchFeatures(storeId, usage);
      return features ? [features] : [];
    }
    case 'document': {
      const model = models.find((m) => m.product === store?.product);
      const size = model ? docSizeEstimate(model) : null;
      const shape = docUpdateShape(storeId, usage, ctx);
      return [size, shape].filter((s): s is Signal => s !== null);
    }
    case 'vector': {
      const scale = vectorScale(storeId, usage, ctx);
      return scale ? [scale] : [];
    }
    case 'graph': {
      const traversal = traversalShape(storeId, usage, ctx);
      return traversal ? [traversal] : [];
    }
    case 'olap': {
      const presence = await olapPresenceSignals(ctx);
      return presence ? [presence] : [];
    }
    default:
      return [];
  }
}
