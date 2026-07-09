import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type AdvisorConfig } from '../src/config.js';
import { composeDetector } from '../src/detectors/compose.js';
import type { DetectedStore } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

async function run(repoPath: string, config: AdvisorConfig = DEFAULT_CONFIG) {
  const warnings: string[] = [];
  const detections = await composeDetector.detect({
    repoPath,
    config,
    addWarning: (m) => warnings.push(m),
  });
  return { stores: detections.map((d) => d.store), warnings };
}

/** (product, file) pairs from compose-kind evidence — the done-condition key. */
function composePairs(stores: DetectedStore[]): Set<string> {
  const pairs = new Set<string>();
  for (const s of stores) {
    for (const e of s.evidence) {
      if (e.kind === 'compose') pairs.add(`${s.product}@${e.file}`);
    }
  }
  return pairs;
}

function expectedComposePairs(fixture: string): Set<string> {
  const raw = readFileSync(join(FIXTURES_DIR, fixture, 'expected-inventory.json'), 'utf8');
  const stores = JSON.parse(raw) as DetectedStore[];
  return composePairs(stores);
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'pa-compose-'));
}

describe('compose/k8s detector (done-conditions for 2.1)', () => {
  const fixtures = ['empty', 'node-monolith', 'python-service', 'edge-cases', 'adversarial'];

  it.each(fixtures)('%s: compose-kind detections match expected-inventory (product+file)', async (fx) => {
    const { stores } = await run(join(FIXTURES_DIR, fx));
    expect(composePairs(stores)).toEqual(expectedComposePairs(fx));
  });

  it('never inventories Postgres even though every fixture runs on it', async () => {
    for (const fx of fixtures) {
      const { stores } = await run(join(FIXTURES_DIR, fx));
      expect(stores.some((s) => /postgres/i.test(s.product)), fx).toBe(false);
    }
  });

  it('captures deploy.replicas on a matched store service as evidence', async () => {
    const dir = tempRepo();
    writeFileSync(
      join(dir, 'docker-compose.yml'),
      ['services:', '  cache:', '    image: redis:7', '    deploy:', '      replicas: 3'].join('\n'),
    );
    const { stores } = await run(dir);
    const replicas = stores.flatMap((s) => s.evidence).find((e) => e.excerpt.includes('replicas:'));
    expect(replicas?.excerpt).toContain('3');
  });

  it('redacts secret-shaped values in captured environment blocks', async () => {
    const dir = tempRepo();
    writeFileSync(
      join(dir, 'docker-compose.yml'),
      [
        'services:',
        '  cache:',
        '    image: redis:7',
        '    environment:',
        '      REDIS_PASSWORD: hunter2',
        '      REDIS_URL: redis://user:s3cret@redis:6379',
      ].join('\n'),
    );
    const { stores } = await run(dir);
    const excerpts = stores.flatMap((s) => s.evidence).map((e) => e.excerpt);
    expect(excerpts.join('\n')).not.toContain('hunter2');
    expect(excerpts.join('\n')).not.toContain('s3cret');
    expect(excerpts.some((e) => e.includes('redis://<redacted>@redis:6379'))).toBe(true);
  });

  it('resolves ${VAR:-default} image interpolation', async () => {
    const dir = tempRepo();
    writeFileSync(
      join(dir, 'docker-compose.yml'),
      ['services:', '  q:', '    image: ${REDIS_IMAGE:-redis:7}'].join('\n'),
    );
    const { stores } = await run(dir);
    expect(stores.map((s) => s.product)).toEqual(['redis']);
  });

  it('skips a malformed compose file with a warning and does not crash', async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: [this is: not: valid: yaml');
    const { stores, warnings } = await run(dir);
    expect(stores).toEqual([]);
    expect(warnings.some((w) => w.includes('docker-compose.yml'))).toBe(true);
  });

  it('caps YAML alias expansion (billion-laughs) as a skip+warning', async () => {
    const dir = tempRepo();
    const aliases = Array.from({ length: 300 }, () => '*a').join(', ');
    writeFileSync(
      join(dir, 'docker-compose.yml'),
      ['anchors: &a value', `boom: [${aliases}]`, 'services:', '  cache:', '    image: redis:7'].join('\n'),
    );
    const { stores, warnings } = await run(dir);
    expect(stores).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('ignores compose files inside node_modules', async () => {
    const dir = tempRepo();
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'docker-compose.yml'), 'services:\n  c:\n    image: redis:7\n');
    const { stores } = await run(dir);
    expect(stores).toEqual([]);
  });

  it('does not follow symlinked directories out of the repo', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pa-outside-'));
    writeFileSync(join(outside, 'docker-compose.yml'), 'services:\n  c:\n    image: memcached:1.6\n');
    const dir = tempRepo();
    writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  c:\n    image: redis:7\n');
    symlinkSync(outside, join(dir, 'linked'), 'dir');
    const { stores } = await run(dir);
    expect(stores.map((s) => s.product).sort()).toEqual(['redis']);
  });

  it('detects images in k8s manifests under k8s/', async () => {
    const dir = tempRepo();
    mkdirSync(join(dir, 'k8s'), { recursive: true });
    writeFileSync(
      join(dir, 'k8s', 'deploy.yaml'),
      [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'spec:',
        '  template:',
        '    spec:',
        '      containers:',
        '        - name: mq',
        '          image: rabbitmq:3.13',
      ].join('\n'),
    );
    const { stores } = await run(dir);
    expect(stores.map((s) => s.product)).toEqual(['rabbitmq']);
  });

  it('skips Helm templates/ with a single warning but reads plain k8s manifests', async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: app\nversion: 0.1.0\n');
    // A scannable manifest under templates/ that WOULD match if not skipped.
    mkdirSync(join(dir, 'templates'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'docker-compose.yml'), 'services:\n  c:\n    image: redis:7\n');
    mkdirSync(join(dir, 'k8s'), { recursive: true });
    writeFileSync(join(dir, 'k8s', 'cache.yaml'), 'spec:\n  containers:\n    - image: memcached:1.6\n');
    const { stores, warnings } = await run(dir);
    expect(stores.map((s) => s.product)).toEqual(['memcached']);
    expect(warnings.filter((w) => w.includes('Helm templates skipped'))).toHaveLength(1);
  });

  it('honors config.ignore globs', async () => {
    const dir = tempRepo();
    mkdirSync(join(dir, 'examples'), { recursive: true });
    writeFileSync(join(dir, 'examples', 'docker-compose.yml'), 'services:\n  c:\n    image: redis:7\n');
    const { stores } = await run(dir, { ...DEFAULT_CONFIG, ignore: ['examples/**'] });
    expect(stores).toEqual([]);
  });
});
