import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { harvestUsage } from '../src/usage/harvester.js';
import type { DetectedStore } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'pa-usage-'));
}

function stores(...ids: string[]): DetectedStore[] {
  return ids.map((id) => {
    const [product] = id.split(':');
    return { id, product: product ?? 'unknown', category: ['cache'], evidence: [] };
  });
}

function context(repoPath: string) {
  const warnings: string[] = [];
  return { repoPath, config: DEFAULT_CONFIG, addWarning: (message: string) => warnings.push(message), warnings };
}

describe('usage harvester (Stage 3.1)', () => {
  it('node-monolith emits cache and BullMQ Redis calls with source locations', async () => {
    const result = await analyze({
      repoPath: join(FIXTURES_DIR, 'node-monolith'),
      config: DEFAULT_CONFIG,
      noAi: true,
    });
    const redis = result.stores.find((store) => store.product === 'redis');
    const calls = redis?.evidence.filter((e) => e.kind === 'call-site') ?? [];
    expect(calls.map((call) => call.file)).toEqual(
      expect.arrayContaining(['src/cache.ts', 'src/queue.ts', 'src/worker.ts']),
    );
    expect(calls.map((call) => call.excerpt)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('.get('),
        expect.stringContaining('.set('),
        expect.stringContaining('.expire('),
        expect.stringContaining('new Queue('),
        expect.stringContaining('new Worker('),
      ]),
    );
    expect(calls.every((call) => call.line !== undefined)).toBe(true);
  });

  it('does not treat Map.get, headers.get, or dict.get as Redis usage without a Redis import', async () => {
    const dir = tempRepo();
    writeFileSync(
      join(dir, 'decoy.ts'),
      [
        'const map = new Map<string, string>();',
        "// import Redis from 'ioredis';",
        '// const redis = new Redis();',
        'map.get("key");',
        'fetch("/api").then((response) => response.headers.get("etag"));',
        'const dict = { get: (key: string) => key };',
        'dict.get("key");',
      ].join('\n'),
    );
    const detected = stores('redis:default');
    const ctx = context(dir);
    expect(await harvestUsage(detected, ctx)).toEqual([]);
    expect(detected[0]!.evidence).toEqual([]);
  });

  it('attributes separately constructed Redis clients to their configured instances', async () => {
    const dir = tempRepo();
    writeFileSync(
      join(dir, 'clients.ts'),
      [
        "import Redis from 'ioredis';",
        "const cache = new Redis('redis://redis-cache:6379');",
        "const broker = new Redis('redis://redis-broker:6379');",
        'cache.get("profile:1");',
        'broker.set("job:1", "pending");',
      ].join('\n'),
    );
    const detected = stores('redis:redis-cache', 'redis:redis-broker', 'redis:default');
    const usage = await harvestUsage(detected, context(dir));
    expect(usage.map((hit) => [hit.storeId, hit.command])).toEqual([
      ['redis:redis-cache', 'get'],
      ['redis:redis-broker', 'set'],
    ]);
  });

  it('tracks factory-created Node Redis clients', async () => {
    const dir = tempRepo();
    writeFileSync(
      join(dir, 'client.ts'),
      [
        "import { createClient } from 'redis';",
        "const redis = createClient({ url: 'redis://redis-cache:6379' });",
        'await redis.get("profile:1");',
      ].join('\n'),
    );
    const usage = await harvestUsage(stores('redis:redis-cache', 'redis:default'), context(dir));
    expect(usage.map((hit) => [hit.storeId, hit.command])).toEqual([['redis:redis-cache', 'get']]);
  });

  it('caps each store at 200 calls and reports max-files truncation', async () => {
    const dir = tempRepo();
    writeFileSync(
      join(dir, 'a-client.ts'),
      ["import Redis from 'ioredis';", 'const redis = new Redis();', ...Array(201).fill('redis.get("x");')].join('\n'),
    );
    writeFileSync(join(dir, 'z-extra.ts'), 'export const ignored = true;\n');
    const detected = stores('redis:default');
    const ctx = context(dir);
    const usage = await harvestUsage(detected, ctx, { maxFiles: 1 });
    expect(usage).toHaveLength(200);
    expect(ctx.warnings).toEqual(expect.arrayContaining([expect.stringContaining('--max-files')]));
  });

  it('skips oversized lines and records a warning instead of regexing them', async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, 'minified.ts'), `import Redis from 'ioredis';\n${'x'.repeat(5_001)}`);
    const ctx = context(dir);
    expect(await harvestUsage(stores('redis:default'), ctx)).toEqual([]);
    expect(ctx.warnings).toEqual(expect.arrayContaining([expect.stringContaining('line exceeds 5k')]));
  });

  it('scans a 10k-file tree in a single bounded pass', async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, 'client.ts'), "import Redis from 'ioredis';\nconst redis = new Redis();\nredis.get('x');\n");
    for (let i = 0; i < 10_000; i++) writeFileSync(join(dir, `file-${i}.ts`), 'export {};\n');

    const start = performance.now();
    const usage = await harvestUsage(stores('redis:default'), context(dir));
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(usage.map((hit) => hit.command)).toEqual(['get']);
  }, 20_000);
});
