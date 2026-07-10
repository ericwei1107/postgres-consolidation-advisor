import type { DetectorContext } from '../detectors/types.js';
import { scanFiles, toRelPosix } from '../scan.js';
import type { Evidence } from '../types.js';
import type { Signal } from './types.js';

/**
 * olapPresenceSignals (PLAN.md 4.3 / §1.7) — analytical dataset size is
 * "rarely visible in-repo" (§1.7's own fallback), so the verdict keys off
 * presence signals instead: a dbt project's model count is a repo-wide
 * property, not tied to any one detected warehouse store, so this scans the
 * whole repo rather than taking a storeId.
 */
export async function olapPresenceSignals(ctx: DetectorContext): Promise<Signal | null> {
  const dbtProjectFiles = await scanFiles(ctx.repoPath, ['**/dbt_project.yml'], ctx.config);
  if (dbtProjectFiles.length === 0) return null;

  const modelFiles = await scanFiles(ctx.repoPath, ['**/models/**/*.sql'], ctx.config);

  const evidence: Evidence[] = dbtProjectFiles.map((f) => ({
    kind: 'dependency',
    file: toRelPosix(ctx.repoPath, f),
    excerpt: 'dbt_project.yml present',
  }));

  return {
    variable: 'dbt-model-count',
    value: modelFiles.length,
    observability: 'estimated',
    evidence,
  };
}
