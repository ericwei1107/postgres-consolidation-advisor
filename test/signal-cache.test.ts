import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { DetectorContext } from '../src/detectors/types.js';
import { cacheCommandMix } from '../src/signals/cacheCommandMix.js';
import { cacheFanOut } from '../src/signals/cacheFanOut.js';
import { runPipeline } from './helpers/pipeline.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'pa-cache-signal-'));
}

function ctxFor(repoPath: string): DetectorContext {
  return { repoPath, config: DEFAULT_CONFIG, addWarning: () => {} };
}

describe('cacheCommandMix (done-conditions for 4.3)', () => {
  it('node-monolith: cache.ts is entirely plain-KV (get/set/expire) -> share 1', async () => {
    const { stores, usage } = await runPipeline(join(FIXTURES_DIR, 'node-monolith'));
    const redis = stores.find((s) => s.product === 'redis')!;
    const signal = cacheCommandMix(redis.id, usage);
    expect(signal).not.toBeNull();
    expect(signal!.variable).toBe('command-mix-plain-kv-share');
    expect(signal!.observability).toBe('static');
    expect(signal!.value).toBe(1);
    expect(signal!.evidence.length).toBeGreaterThan(0);
  });

  it('a mixed command set (get/set + zadd) produces a share strictly between 0 and 1', () => {
    const usage = [
      { storeId: 'redis:x', command: 'get', kind: 'call-site' as const, file: 'a.ts', line: 1, excerpt: 'redis.get(k)' },
      { storeId: 'redis:x', command: 'set', kind: 'call-site' as const, file: 'a.ts', line: 2, excerpt: 'redis.set(k, v)' },
      { storeId: 'redis:x', command: 'zadd', kind: 'call-site' as const, file: 'a.ts', line: 3, excerpt: 'redis.zadd(k, 1, m)' },
    ];
    const signal = cacheCommandMix('redis:x', usage);
    expect(signal!.value).toBeCloseTo(2 / 3);
  });

  it('signal absent: no redis command hits for this store -> null', () => {
    expect(cacheCommandMix('redis:x', [])).toBeNull();
  });

  it('ignores hits for a different store id', () => {
    const usage = [
      { storeId: 'redis:other', command: 'get', kind: 'call-site' as const, file: 'a.ts', line: 1, excerpt: 'redis.get(k)' },
    ];
    expect(cacheCommandMix('redis:x', usage)).toBeNull();
  });
});

describe('cacheFanOut (done-conditions for 4.3, [A9])', () => {
  it('fires when >=10 cache calls appear within one function\'s lexical span', async () => {
    const repo = tempRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { ioredis: '^5.4.1' } }),
    );
    const lines = ["import Redis from 'ioredis';", 'const redis = new Redis();', '', 'export async function buildFeed() {'];
    for (let i = 0; i < 12; i++) lines.push(`  await redis.get('k${i}');`);
    lines.push('}');
    writeFileSync(join(repo, 'src', 'feed.ts'), lines.join('\n'));

    const { ctx, stores, usage } = await runPipeline(repo);
    const redis = stores.find((s) => s.product === 'redis')!;
    const signal = await cacheFanOut(redis.id, usage, ctx);
    expect(signal).not.toBeNull();
    expect(signal!.variable).toBe('fan-out-calls-per-request');
    expect(signal!.observability).toBe('estimated');
    expect(signal!.value).toBe(12);
  });

  it('node-monolith: cache.ts calls stay well under the fan-out line (max 3 per function)', async () => {
    const { ctx, stores, usage } = await runPipeline(join(FIXTURES_DIR, 'node-monolith'));
    const redis = stores.find((s) => s.product === 'redis')!;
    const signal = await cacheFanOut(redis.id, usage, ctx);
    // cachedUser() has 3 calls (get, set, expire) in one function span.
    expect(signal!.value).toBe(3);
    expect(signal!.value).toBeLessThan(10);
  });

  it('signal absent: no cache-shaped call sites for this store -> null', async () => {
    const { ctx } = await runPipeline(join(FIXTURES_DIR, 'empty'));
    const signal = await cacheFanOut('redis:none', [], ctx);
    expect(signal).toBeNull();
  });

  it('a loop-driven fan-out is invisible to the static heuristic by design (adversarial feed.ts)', async () => {
    const { ctx, stores, usage } = await runPipeline(join(FIXTURES_DIR, 'adversarial'));
    const redis = stores.find((s) => s.product === 'redis')!;
    const signal = await cacheFanOut(redis.id, usage, ctx);
    // buildFeed() has 2 static call-site lines even though the loop runs ~12x
    // at request time — the heuristic is explicitly line-based, not reachability.
    expect(signal!.value).toBe(2);
  });
});
