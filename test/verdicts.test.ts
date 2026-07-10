import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { Verdict } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

function sortVerdicts(verdicts: Verdict[]): Verdict[] {
  return [...verdicts].sort((a, b) => (a.storeId + a.role).localeCompare(b.storeId + b.role));
}

async function actualVerdicts(fixture: string): Promise<Verdict[]> {
  const result = await analyze({ repoPath: join(FIXTURES_DIR, fixture), config: DEFAULT_CONFIG, noAi: true });
  return sortVerdicts(result.verdicts);
}

function expectedVerdicts(fixture: string): Verdict[] {
  const raw = readFileSync(join(FIXTURES_DIR, fixture, 'expected-verdicts.json'), 'utf8');
  return JSON.parse(raw) as Verdict[];
}

describe('verdict engine golden files (done-conditions for 5.1)', () => {
  const fixtures = ['node-monolith', 'python-service', 'edge-cases'];

  it.each(fixtures)('%s: verdicts match the committed expected-verdicts.json exactly', async (fixture) => {
    expect(await actualVerdicts(fixture)).toEqual(expectedVerdicts(fixture));
  });

  it('node-monolith: redis-cache -> consolidate/high (command-mix axis, PLAN.md §1.2 fallback)', async () => {
    const verdicts = await actualVerdicts('node-monolith');
    const cache = verdicts.find((v) => v.storeId === 'redis:redis' && v.role === 'cache');
    expect(cache?.decision).toBe('consolidate');
    expect(cache?.confidence).toBe('high');
  });

  it('node-monolith: redis-queue -> consolidate, range 2-200 msgs/sec entirely under the 1,000 line', async () => {
    const verdicts = await actualVerdicts('node-monolith');
    const queue = verdicts.find((v) => v.storeId === 'redis:redis' && v.role === 'queue');
    expect(queue?.decision).toBe('consolidate');
    expect(queue?.thresholdComparisons[0]?.observed).toBe('2-200 msgs/sec');
  });

  it('node-monolith: elasticsearch -> consolidate-to-tsvector on the feature axis, medium confidence', async () => {
    const verdicts = await actualVerdicts('node-monolith');
    const es = verdicts.find((v) => v.role === 'search');
    expect(es?.decision).toBe('consolidate');
    expect(es?.postgresEquivalent).toBe('tsvector + pg_trgm');
    expect(es?.confidence).toBe('medium');
  });

  it('python-service: mongo -> consolidate (150-byte doc is well under the 2KB TOAST line; field-level-update gate correctly does not fire)', async () => {
    const verdicts = await actualVerdicts('python-service');
    const mongo = verdicts.find((v) => v.role === 'document');
    expect(mongo?.decision).toBe('consolidate');
  });

  it('python-service: pinecone -> borderline/low, no vector-count signal, but still names pgvector as the tentative default', async () => {
    const verdicts = await actualVerdicts('python-service');
    const vector = verdicts.find((v) => v.role === 'vector');
    expect(vector?.decision).toBe('borderline');
    expect(vector?.confidence).toBe('low');
    expect(vector?.postgresEquivalent).toBe('pgvector (HNSW index)');
  });

  it('edge-cases: kafka -> borderline/low (no signals at all: env-only detection, no code usage)', async () => {
    const verdicts = await actualVerdicts('edge-cases');
    const kafka = verdicts.find((v) => v.role === 'queue');
    expect(kafka?.decision).toBe('borderline');
    expect(kafka?.confidence).toBe('low');
  });

  it('every rationale mentions at least one Evidence file path', async () => {
    for (const fixture of [...fixtures, 'adversarial']) {
      const verdicts = await actualVerdicts(fixture);
      for (const v of verdicts) {
        expect(v.rationale, `${fixture} ${v.storeId}/${v.role}`).toMatch(/Evidence: \S+/);
      }
    }
  });

  it('fitScore stays within [0, 100] for every verdict', async () => {
    for (const fixture of [...fixtures, 'adversarial']) {
      const verdicts = await actualVerdicts(fixture);
      for (const v of verdicts) {
        expect(v.fitScore, `${fixture} ${v.storeId}/${v.role}`).toBeGreaterThanOrEqual(0);
        expect(v.fitScore).toBeLessThanOrEqual(100);
      }
    }
  });

  it('every consolidate verdict carries a migrationEffort', async () => {
    for (const fixture of [...fixtures, 'adversarial']) {
      const verdicts = await actualVerdicts(fixture);
      for (const v of verdicts.filter((v) => v.decision === 'consolidate')) {
        expect(v.migrationEffort, `${fixture} ${v.storeId}/${v.role}`).toBeDefined();
      }
    }
  });

  it('empty fixture produces zero verdicts', async () => {
    expect(await actualVerdicts('empty')).toEqual([]);
  });
});
