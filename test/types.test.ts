import { describe, expect, it } from 'vitest';
import {
  AnalysisResultSchema,
  DetectedStoreSchema,
  VerdictSchema,
} from '../src/types.js';

describe('core type schemas (§2, frozen)', () => {
  it('validates a well-formed DetectedStore', () => {
    const store = {
      id: 'redis:node-monolith:redis-cache',
      product: 'redis',
      category: ['cache', 'queue'],
      evidence: [
        { kind: 'compose', file: 'docker-compose.yml', line: 12, excerpt: 'image: redis:7' },
      ],
    };
    expect(DetectedStoreSchema.parse(store)).toEqual(store);
  });

  it('rejects an unknown store category', () => {
    expect(
      DetectedStoreSchema.safeParse({
        id: 'x',
        product: 'redis',
        category: ['blockchain'],
        evidence: [],
      }).success,
    ).toBe(false);
  });

  it('validates a consolidate verdict carrying migrationEffort', () => {
    const verdict = {
      storeId: 'redis:x',
      role: 'cache',
      decision: 'consolidate',
      fitScore: 85,
      confidence: 'high',
      thresholdComparisons: [
        {
          variable: 'cache_ops_per_sec',
          observed: 'unknown (command-mix axis decided)',
          threshold: '< 5000/sec [A2]',
          source: 'https://dev.to/raphaeldelio/can-postgres-replace-redis-as-a-cache-2ne1',
          passed: true,
        },
      ],
      rationale: 'Plain KV usage in src/cache.ts; 14 call sites across 3 files to rewrite; data migration: none; rollback: keep Redis running until cutover verified.',
      postgresEquivalent: 'UNLOGGED table + pg_cron TTL sweep',
      migrationEffort: {
        callSites: 14,
        filesTouched: 3,
        dataMigration: 'none',
        rollbackNote: 'keep Redis running until cutover verified',
      },
    };
    expect(VerdictSchema.parse(verdict)).toEqual(verdict);
  });

  it('rejects fitScore outside 0-100', () => {
    expect(
      VerdictSchema.safeParse({
        storeId: 'x',
        role: 'cache',
        decision: 'keep',
        fitScore: 130,
        confidence: 'low',
        thresholdComparisons: [],
        rationale: 'r',
        postgresEquivalent: 'n/a',
      }).success,
    ).toBe(false);
  });

  it('round-trips an empty AnalysisResult (the analyze stub output)', () => {
    const empty = { schemaVersion: 1, stores: [], roles: [], verdicts: [], warnings: [] };
    expect(AnalysisResultSchema.parse(empty)).toEqual(empty);
  });
});
