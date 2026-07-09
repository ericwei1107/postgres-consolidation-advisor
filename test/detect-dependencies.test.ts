import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type AdvisorConfig } from '../src/config.js';
import { dependenciesDetector } from '../src/detectors/dependencies.js';
import type { DetectedStore } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

async function run(repoPath: string, config: AdvisorConfig = DEFAULT_CONFIG) {
  const warnings: string[] = [];
  const detections = await dependenciesDetector.detect({
    repoPath,
    config,
    addWarning: (m) => warnings.push(m),
  });
  return { stores: detections.map((d) => d.store), warnings };
}

/** (product, file) pairs from dependency-kind evidence — the done-condition key. */
function dependencyPairs(stores: DetectedStore[]): Set<string> {
  const pairs = new Set<string>();
  for (const s of stores) {
    for (const e of s.evidence) {
      if (e.kind === 'dependency') pairs.add(`${s.product}@${e.file}`);
    }
  }
  return pairs;
}

function expectedDependencyPairs(fixture: string): Set<string> {
  const raw = readFileSync(join(FIXTURES_DIR, fixture, 'expected-inventory.json'), 'utf8');
  const stores = JSON.parse(raw) as DetectedStore[];
  return dependencyPairs(stores);
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'pa-deps-'));
}

describe('dependency-manifest detector (done-conditions for 2.2)', () => {
  const fixtures = ['empty', 'node-monolith', 'python-service', 'edge-cases', 'adversarial'];

  it.each(fixtures)('%s: dependency-kind detections match expected-inventory (product+file)', async (fx) => {
    const { stores } = await run(join(FIXTURES_DIR, fx));
    expect(dependencyPairs(stores)).toEqual(expectedDependencyPairs(fx));
  });

  it('edge-cases: the commented-out elasticsearch dependency produces NO detection', async () => {
    const { stores } = await run(join(FIXTURES_DIR, 'edge-cases'));
    expect(stores.some((s) => s.product === 'elasticsearch')).toBe(false);
  });

  it('never inventories Postgres client libraries (pg / psycopg2-binary present in fixtures)', async () => {
    for (const fx of fixtures) {
      const { stores } = await run(join(FIXTURES_DIR, fx));
      expect(stores.some((s) => /postgres/i.test(s.product)), fx).toBe(false);
    }
  });

  it('node-monolith: one redis store per manifest with ioredis AND bullmq evidence, category cache+queue', async () => {
    const { stores } = await run(join(FIXTURES_DIR, 'node-monolith'));
    const redis = stores.find((s) => s.product === 'redis');
    expect(redis).toBeDefined();
    const excerpts = redis!.evidence.map((e) => e.excerpt).join('\n');
    expect(excerpts).toContain('ioredis');
    expect(excerpts).toContain('bullmq');
    expect(redis!.category).toContain('cache');
    expect(redis!.category).toContain('queue');
  });

  it('evidence carries the manifest file and a 1-based line number', async () => {
    const { stores } = await run(join(FIXTURES_DIR, 'python-service'));
    const pinecone = stores.find((s) => s.product === 'pinecone');
    expect(pinecone?.evidence).toEqual([
      {
        kind: 'dependency',
        file: 'requirements.txt',
        line: 8,
        excerpt: 'pinecone-client==4.1.0',
      },
    ]);
  });

  describe('celery broker resolution', () => {
    it('python-service: literal redis:// broker URL resolves celery to redis (queue)', async () => {
      const { stores } = await run(join(FIXTURES_DIR, 'python-service'));
      const redis = stores.find((s) => s.product === 'redis');
      expect(redis).toBeDefined();
      expect(redis!.evidence.some((e) => e.excerpt.includes('celery'))).toBe(true);
      expect(redis!.category).toContain('queue');
      expect(stores.some((s) => s.product === 'unknown-broker')).toBe(false);
    });

    it('env-var broker indirection → unknown-broker with queue category, never a Redis guess', async () => {
      const dir = tempRepo();
      writeFileSync(join(dir, 'requirements.txt'), 'celery==5.4.0\n');
      writeFileSync(
        join(dir, 'tasks.py'),
        'import os\nfrom celery import Celery\napp = Celery("t", broker=os.environ["BROKER_URL"])\n',
      );
      const { stores } = await run(dir);
      expect(stores.map((s) => s.product)).toEqual(['unknown-broker']);
      expect(stores[0]!.category).toEqual(['queue']);
    });

    it('no broker config at all → unknown-broker', async () => {
      const dir = tempRepo();
      writeFileSync(join(dir, 'requirements.txt'), 'celery==5.4.0\n');
      const { stores } = await run(dir);
      expect(stores.map((s) => s.product)).toEqual(['unknown-broker']);
    });

    it('literal amqp:// broker URL resolves to rabbitmq', async () => {
      const dir = tempRepo();
      writeFileSync(join(dir, 'requirements.txt'), 'celery==5.4.0\n');
      writeFileSync(
        join(dir, 'tasks.py'),
        'from celery import Celery\napp = Celery("t", broker="amqp://guest@rabbit:5672//")\n',
      );
      const { stores } = await run(dir);
      expect(stores.map((s) => s.product)).toEqual(['rabbitmq']);
    });
  });

  describe('manifest formats', () => {
    it('pyproject.toml: PEP 621 dependencies array (with PyPI name normalization)', async () => {
      const dir = tempRepo();
      writeFileSync(
        join(dir, 'pyproject.toml'),
        [
          '[project]',
          'name = "svc"',
          'dependencies = [',
          '    "Pinecone_Client>=4.0",',
          '    "pymongo==4.7.2",',
          ']',
          '',
          '[build-system]',
          'requires = ["hatchling"]',
        ].join('\n'),
      );
      const { stores } = await run(dir);
      expect(stores.map((s) => s.product).sort()).toEqual(['mongodb', 'pinecone']);
    });

    it('pyproject.toml: poetry dependency tables', async () => {
      const dir = tempRepo();
      writeFileSync(
        join(dir, 'pyproject.toml'),
        [
          '[tool.poetry]',
          'name = "svc"',
          '',
          '[tool.poetry.dependencies]',
          'python = "^3.12"',
          'redis = "^5.0"',
          '# kafka-python = "^2.0"  commented out, must not detect',
          '',
          '[tool.poetry.group.dev.dependencies]',
          'pytest = "^8.0"',
        ].join('\n'),
      );
      const { stores } = await run(dir);
      expect(stores.map((s) => s.product)).toEqual(['redis']);
    });

    it('Gemfile: gem lines detected, commented-out gems ignored', async () => {
      const dir = tempRepo();
      writeFileSync(
        join(dir, 'Gemfile'),
        ['source "https://rubygems.org"', '', 'gem "sidekiq", "~> 7.2"', '# gem "elasticsearch"', 'gem "pg"'].join('\n'),
      );
      const { stores } = await run(dir);
      expect(stores.map((s) => s.product)).toEqual(['redis']);
      expect(stores[0]!.category).toEqual(['queue']);
    });

    it('go.mod: require block detected incl. /vN major suffix, commented lines ignored', async () => {
      const dir = tempRepo();
      writeFileSync(
        join(dir, 'go.mod'),
        [
          'module example.com/app',
          '',
          'go 1.22',
          '',
          'require (',
          '\tgithub.com/redis/go-redis/v9 v9.5.1',
          '\t// github.com/segmentio/kafka-go v0.4.47',
          '\tgithub.com/lib/pq v1.10.9',
          ')',
        ].join('\n'),
      );
      const { stores } = await run(dir);
      expect(stores.map((s) => s.product)).toEqual(['redis']);
    });

    it('package.json: devDependencies count too', async () => {
      const dir = tempRepo();
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'x', devDependencies: { mongoose: '^8.0.0' } }, null, 2),
      );
      const { stores } = await run(dir);
      expect(stores.map((s) => s.product)).toEqual(['mongodb']);
    });
  });

  describe('parse-error policy and walk hygiene', () => {
    it('malformed package.json is skipped with a warning, run continues', async () => {
      const dir = tempRepo();
      writeFileSync(join(dir, 'package.json'), '{ "dependencies": { "ioredis": ');
      writeFileSync(join(dir, 'requirements.txt'), 'pymongo==4.7.2\n');
      const { stores, warnings } = await run(dir);
      expect(warnings.some((w) => w.includes('package.json'))).toBe(true);
      expect(stores.map((s) => s.product)).toEqual(['mongodb']);
    });

    it('ignores manifests inside node_modules', async () => {
      const dir = tempRepo();
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(
        join(dir, 'node_modules', 'pkg', 'package.json'),
        JSON.stringify({ dependencies: { ioredis: '^5.0.0' } }),
      );
      const { stores } = await run(dir);
      expect(stores).toEqual([]);
    });

    it('honors config.ignore globs', async () => {
      const dir = tempRepo();
      mkdirSync(join(dir, 'examples'), { recursive: true });
      writeFileSync(
        join(dir, 'examples', 'package.json'),
        JSON.stringify({ dependencies: { ioredis: '^5.0.0' } }),
      );
      const { stores } = await run(dir, { ...DEFAULT_CONFIG, ignore: ['examples/**'] });
      expect(stores).toEqual([]);
    });
  });
});
