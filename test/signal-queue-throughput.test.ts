import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { DetectorContext } from '../src/detectors/types.js';
import { queueThroughput } from '../src/signals/queueThroughput.js';
import { isSignalRange } from '../src/signals/types.js';
import type { DetectedStore } from '../src/types.js';
import { runPipeline } from './helpers/pipeline.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'pa-queue-throughput-'));
}

function ctxFor(repoPath: string): DetectorContext {
  return { repoPath, config: DEFAULT_CONFIG, addWarning: () => {} };
}

function redisStore(label = 'redis'): DetectedStore {
  return { id: `redis:${label}`, product: 'redis', category: ['queue'], evidence: [] };
}

describe('queueThroughput (done-conditions for 4.3)', () => {
  it('node-monolith: 2 replicas x 10 concurrency x [0.1,10] = [2, 200] msgs/sec (exact, per PLAN.md 4.3)', async () => {
    const { ctx, stores } = await runPipeline(join(FIXTURES_DIR, 'node-monolith'));
    const redis = stores.find((s) => s.product === 'redis');
    expect(redis).toBeDefined();
    const signal = await queueThroughput(redis!, ctx);
    expect(signal).not.toBeNull();
    expect(signal!.variable).toBe('est-peak-msgs-sec');
    expect(signal!.observability).toBe('estimated');
    expect(isSignalRange(signal!.value)).toBe(true);
    expect(signal!.value).toEqual({ min: 2, max: 200 });
  });

  it('python-service: 2 replicas x 8 (celery worker_concurrency) x [0.1,10] = [1.6, 160]', async () => {
    const { ctx, stores } = await runPipeline(join(FIXTURES_DIR, 'python-service'));
    const redis = stores.find((s) => s.product === 'redis');
    expect(redis).toBeDefined();
    const signal = await queueThroughput(redis!, ctx);
    expect(signal!.value).toEqual({ min: 1.6, max: 160 });
  });

  it('does not attribute an unrelated service\'s replicas to the queue store (api also uses REDIS_URL as a cache)', async () => {
    const { ctx, stores } = await runPipeline(join(FIXTURES_DIR, 'node-monolith'));
    const redis = stores.find((s) => s.product === 'redis')!;
    const signal = await queueThroughput(redis, ctx);
    // 3 (api defaults to 1 + worker 2) would be the bug this guards against.
    expect((signal!.value as { min: number }).min).toBe(2);
  });

  it('signal absent: no concurrency config found anywhere -> null', async () => {
    const repo = tempRepo();
    writeFileSync(
      join(repo, 'docker-compose.yml'),
      [
        'services:',
        '  redis:',
        '    image: redis:7',
        '  worker:',
        '    build: .',
        '    command: node src/worker.js',
        '    deploy:',
        '      replicas: 3',
        '    depends_on:',
        '      - redis',
      ].join('\n'),
    );
    mkdirSync(join(repo, 'src'));
    writeFileSync(
      join(repo, 'src', 'worker.ts'),
      "import { Worker } from 'bullmq';\nnew Worker('email', async () => {}, { connection: {} });\n",
    );
    const signal = await queueThroughput(redisStore(), ctxFor(repo));
    expect(signal).toBeNull();
  });

  it('signal absent: no compose service references the store at all -> null', async () => {
    const repo = tempRepo();
    mkdirSync(join(repo, 'src'));
    writeFileSync(
      join(repo, 'src', 'worker.ts'),
      "import { Worker } from 'bullmq';\nnew Worker('email', async () => {}, { connection: {}, concurrency: 5 });\n",
    );
    const signal = await queueThroughput(redisStore(), ctxFor(repo));
    expect(signal).toBeNull();
  });

  it('a service with no explicit deploy.replicas defaults to 1 (standard docker-compose semantics)', async () => {
    const repo = tempRepo();
    writeFileSync(
      join(repo, 'docker-compose.yml'),
      [
        'services:',
        '  redis:',
        '    image: redis:7',
        '  worker:',
        '    build: .',
        '    command: node src/worker.js',
        '    depends_on:',
        '      - redis',
      ].join('\n'),
    );
    mkdirSync(join(repo, 'src'));
    writeFileSync(
      join(repo, 'src', 'worker.ts'),
      "import { Worker } from 'bullmq';\nnew Worker('email', async () => {}, { connection: {}, concurrency: 4 });\n",
    );
    const signal = await queueThroughput(redisStore(), ctxFor(repo));
    // 1 replica (default) x 4 concurrency x [0.1, 10] = [0.4, 40]
    expect(signal!.value).toEqual({ min: 0.4, max: 40 });
  });
});
