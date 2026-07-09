import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { mergeDetections } from '../src/detectors/merge.js';
import type { Detection } from '../src/detectors/types.js';
import type { DetectedStore, Evidence } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

const ev = (kind: Evidence['kind'], file: string, excerpt: string): Evidence => ({ kind, file, excerpt });

function det(
  product: string,
  identity: Detection['identity'],
  evidence: Evidence[],
  category: DetectedStore['category'] = ['cache'],
): Detection {
  return { store: { id: `${product}:x`, product, category, evidence }, identity };
}

describe('mergeDetections (dedup logic, done-conditions for 2.3)', () => {
  it('same instance found by compose + env + dependency is ONE store with three evidence entries', () => {
    const warnings: string[] = [];
    const stores = mergeDetections(
      [
        det('redis', { kind: 'service', name: 'redis' }, [ev('compose', 'docker-compose.yml', 'image: redis:7')]),
        det('redis', { kind: 'default' }, [ev('dependency', 'package.json', '"ioredis": "^5.4.1"')]),
        // compose DNS: env URL host equals the service name → same instance
        det('redis', { kind: 'hostport', host: 'redis', port: '6379' }, [
          ev('env', '.env', 'REDIS_URL=redis://redis:6379'),
        ]),
      ],
      (m) => warnings.push(m),
    );
    expect(stores).toHaveLength(1);
    expect(stores[0]!.evidence).toHaveLength(3);
    expect(new Set(stores[0]!.evidence.map((e) => e.kind))).toEqual(new Set(['compose', 'dependency', 'env']));
    expect(warnings).toEqual([]);
  });

  it('two Redis services in one compose file are TWO DetectedStores', () => {
    const stores = mergeDetections(
      [
        det('redis', { kind: 'service', name: 'redis-cache' }, [ev('compose', 'docker-compose.yml', 'image: redis:7')]),
        det('redis', { kind: 'service', name: 'redis-broker' }, [ev('compose', 'docker-compose.yml', 'image: redis:7')]),
      ],
      () => {},
    );
    expect(stores.map((s) => s.id).sort()).toEqual(['redis:redis-broker', 'redis:redis-cache']);
  });

  it('unattributable evidence with multiple instances stays in a default bucket with an ambiguity warning', () => {
    const warnings: string[] = [];
    const stores = mergeDetections(
      [
        det('redis', { kind: 'service', name: 'redis-cache' }, [ev('compose', 'docker-compose.yml', 'image: redis:7')]),
        det('redis', { kind: 'service', name: 'redis-broker' }, [ev('compose', 'docker-compose.yml', 'image: redis:7')]),
        det('redis', { kind: 'default' }, [ev('dependency', 'package.json', '"ioredis": "^5.4.1"')]),
      ],
      (m) => warnings.push(m),
    );
    expect(stores).toHaveLength(3);
    const bucket = stores.find((s) => s.id === 'redis:default');
    expect(bucket?.evidence.map((e) => e.kind)).toEqual(['dependency']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('redis-cache');
    expect(warnings[0]).toContain('redis-broker');
    expect(warnings[0]).toContain('medium');
  });

  it('env host:port attributes to the matching service, not to the other instance', () => {
    const stores = mergeDetections(
      [
        det('redis', { kind: 'service', name: 'redis-cache' }, [ev('compose', 'docker-compose.yml', 'image: redis:7')]),
        det('redis', { kind: 'service', name: 'redis-broker' }, [ev('compose', 'docker-compose.yml', 'image: redis:7')]),
        det('redis', { kind: 'hostport', host: 'redis-cache', port: '6379' }, [
          ev('env', '.env', 'REDIS_URL=redis://redis-cache:6379'),
        ]),
      ],
      () => {},
    );
    const cache = stores.find((s) => s.id === 'redis:redis-cache');
    expect(cache?.evidence.map((e) => e.kind).sort()).toEqual(['compose', 'env']);
    const broker = stores.find((s) => s.id === 'redis:redis-broker');
    expect(broker?.evidence.map((e) => e.kind)).toEqual(['compose']);
  });

  it('hostport identity anchors an instance when no compose service exists; defaults fold in', () => {
    const stores = mergeDetections(
      [
        det('redis', { kind: 'hostport', host: 'localhost', port: '6379' }, [
          ev('env', '.env', 'REDIS_URL=redis://localhost:6379'),
        ]),
        det('redis', { kind: 'default' }, [ev('dependency', 'package.json', '"ioredis": "^5.4.1"')]),
      ],
      () => {},
    );
    expect(stores).toHaveLength(1);
    expect(stores[0]!.id).toBe('redis:localhost:6379');
    expect(stores[0]!.evidence).toHaveLength(2);
  });

  it('distinct host:port identities stay separate stores', () => {
    const stores = mergeDetections(
      [
        det('redis', { kind: 'hostport', host: 'redis-a', port: '6379' }, [ev('env', '.env', 'A')]),
        det('redis', { kind: 'hostport', host: 'redis-b', port: '6379' }, [ev('env', '.env', 'B')]),
      ],
      () => {},
    );
    expect(stores.map((s) => s.id).sort()).toEqual(['redis:redis-a:6379', 'redis:redis-b:6379']);
  });

  it('categories union across detectors (cache seed + queue from bullmq)', () => {
    const stores = mergeDetections(
      [
        det('redis', { kind: 'service', name: 'redis' }, [ev('compose', 'docker-compose.yml', 'image: redis:7')], ['cache']),
        det('redis', { kind: 'default' }, [ev('dependency', 'package.json', '"bullmq": "^5.7.0"')], ['queue']),
      ],
      () => {},
    );
    expect(stores[0]!.category).toEqual(['cache', 'queue']);
  });

  it('identical evidence entries dedupe on merge', () => {
    const e = ev('compose', 'docker-compose.yml', 'image: redis:7');
    const stores = mergeDetections(
      [
        det('redis', { kind: 'service', name: 'redis' }, [e]),
        det('redis', { kind: 'service', name: 'redis' }, [{ ...e }]),
      ],
      () => {},
    );
    expect(stores[0]!.evidence).toHaveLength(1);
  });
});

describe('analyze end-to-end inventory vs fixtures (2.3 merge in the pipeline)', () => {
  const fixtures = ['empty', 'node-monolith', 'python-service', 'edge-cases', 'adversarial'];

  /** Per-store (kind, file) evidence pairs keyed by product — the full inventory shape. */
  function inventoryShape(stores: DetectedStore[]): Record<string, string[]> {
    const shape: Record<string, string[]> = {};
    for (const s of stores) {
      shape[s.product] = [...new Set(s.evidence.filter((e) => e.kind !== 'call-site').map((e) => `${e.kind}@${e.file}`))].sort();
    }
    return shape;
  }

  it.each(fixtures)('%s: merged inventory matches expected-inventory.json (product + evidence kinds/files)', async (fx) => {
    const repoPath = join(FIXTURES_DIR, fx);
    const result = await analyze({ repoPath, config: DEFAULT_CONFIG, noAi: true });
    const expected = JSON.parse(
      readFileSync(join(FIXTURES_DIR, fx, 'expected-inventory.json'), 'utf8'),
    ) as DetectedStore[];
    expect(inventoryShape(result.stores)).toEqual(inventoryShape(expected));
    // one merged store per expected store — dedup produced no splits or extras
    expect(result.stores).toHaveLength(expected.length);
  });

  it('node-monolith: redis is ONE store with >=2 evidence kinds (done-condition)', async () => {
    const result = await analyze({
      repoPath: join(FIXTURES_DIR, 'node-monolith'),
      config: DEFAULT_CONFIG,
      noAi: true,
    });
    const redis = result.stores.filter((s) => s.product === 'redis');
    expect(redis).toHaveLength(1);
    expect(new Set(redis[0]!.evidence.map((e) => e.kind)).size).toBeGreaterThanOrEqual(2);
    expect(redis[0]!.category).toEqual(expect.arrayContaining(['cache', 'queue']));
  });

  it('edge-cases: kafka store has exactly one env evidence entry (done-condition)', async () => {
    const result = await analyze({
      repoPath: join(FIXTURES_DIR, 'edge-cases'),
      config: DEFAULT_CONFIG,
      noAi: true,
    });
    const kafka = result.stores.find((s) => s.product === 'kafka');
    expect(kafka?.evidence).toHaveLength(1);
    expect(kafka?.evidence[0]?.kind).toBe('env');
  });
});
