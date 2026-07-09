import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type AdvisorConfig } from '../src/config.js';
import { envDetector } from '../src/detectors/env.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

async function run(repoPath: string, config: AdvisorConfig = DEFAULT_CONFIG) {
  const warnings: string[] = [];
  const detections = await envDetector.detect({
    repoPath,
    config,
    addWarning: (m) => warnings.push(m),
  });
  return { detections, stores: detections.map((d) => d.store), warnings };
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'pa-env-'));
}

describe('env/config detector (done-conditions for 2.3)', () => {
  it('edge-cases: KAFKA_BROKERS-only store detected with a single env Evidence', async () => {
    const { stores, detections } = await run(join(FIXTURES_DIR, 'edge-cases'));
    const kafka = stores.find((s) => s.product === 'kafka');
    expect(kafka).toBeDefined();
    expect(kafka!.evidence).toEqual([
      {
        kind: 'env',
        file: '.env',
        line: 3,
        excerpt: 'KAFKA_BROKERS=broker1:9092,broker2:9092',
      },
    ]);
    // host:port list yields an instance identity from the first broker
    const identity = detections.find((d) => d.store.product === 'kafka')!.identity;
    expect(identity).toEqual({ kind: 'hostport', host: 'broker1', port: '9092' });
    // APP_ENV / LOG_LEVEL / commented lines must not detect anything
    expect(stores).toHaveLength(1);
  });

  it('redacts credentials in a .env containing a fake password (secret-redaction rule)', async () => {
    const dir = tempRepo();
    writeFileSync(
      join(dir, '.env'),
      [
        'REDIS_URL=redis://admin:hunter2@redis-main:6379/0',
        'PINECONE_API_KEY=pk-fake-abc123',
        'MONGODB_URI="mongodb://root:sup3rsecret@mongo:27017/app"',
      ].join('\n'),
    );
    const { stores } = await run(dir);
    const allExcerpts = stores.flatMap((s) => s.evidence).map((e) => e.excerpt).join('\n');
    expect(allExcerpts).not.toContain('hunter2');
    expect(allExcerpts).not.toContain('sup3rsecret');
    expect(allExcerpts).not.toContain('pk-fake-abc123');
    // host:port survives redaction (needed for instance identity)
    expect(allExcerpts).toContain('REDIS_URL=redis://<redacted>@redis-main:6379/0');
    expect(allExcerpts).toContain('PINECONE_API_KEY=<redacted>');
    expect(allExcerpts).toContain('MONGODB_URI=mongodb://<redacted>@mongo:27017/app');
  });

  it('resolves generic var names by URL scheme; postgres URLs detect nothing', async () => {
    const dir = tempRepo();
    writeFileSync(
      join(dir, '.env'),
      ['DATABASE_URL=postgres://user:pw@db:5432/app', 'QUEUE_URL=amqp://rabbit:5672'].join('\n'),
    );
    const { stores } = await run(dir);
    expect(stores.map((s) => s.product)).toEqual(['rabbitmq']);
  });

  it('scans settings.py and *.config.ts; skips commented-out lines', async () => {
    const dir = tempRepo();
    writeFileSync(
      join(dir, 'settings.py'),
      [
        'import os',
        '# REDIS_URL = "redis://commented:6379"  (must not detect)',
        'ELASTICSEARCH_URL = os.environ.get("ES", "http://es:9200")',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'cache.config.ts'),
      ['export default {', "  redisUrl: 'redis://cache-host:6380/1',", '};'].join('\n'),
    );
    const { stores, detections } = await run(dir);
    expect(stores.map((s) => s.product).sort()).toEqual(['elasticsearch', 'redis']);
    const redis = detections.find((d) => d.store.product === 'redis')!;
    expect(redis.identity).toEqual({ kind: 'hostport', host: 'cache-host', port: '6380' });
  });

  it('scans files under config/', async () => {
    const dir = tempRepo();
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'production.yaml'), 'redis:\n  REDIS_URL: redis://prod-redis:6379\n');
    const { stores } = await run(dir);
    expect(stores.map((s) => s.product)).toEqual(['redis']);
  });

  it('same var across .env and .env.example accumulates evidence on one detection', async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, '.env'), 'REDIS_URL=redis://redis:6379\n');
    writeFileSync(join(dir, '.env.example'), 'REDIS_URL=redis://redis:6379\n');
    const { stores } = await run(dir);
    expect(stores).toHaveLength(1);
    expect(stores[0]!.evidence.map((e) => e.file).sort()).toEqual(['.env', '.env.example']);
  });

  it('var name without resolvable host lands in the default bucket', async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, '.env'), 'PINECONE_API_KEY=pk-fake\n');
    const { detections } = await run(dir);
    expect(detections).toHaveLength(1);
    expect(detections[0]!.identity).toEqual({ kind: 'default' });
  });
});
