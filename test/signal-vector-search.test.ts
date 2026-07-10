import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { searchFeatures } from '../src/signals/searchFeatures.js';
import { vectorScale } from '../src/signals/vectorScale.js';
import { runPipeline } from './helpers/pipeline.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

describe('vectorScale (done-conditions for 4.3, §1.5)', () => {
  it('python-service vectors.py: text-embedding-3-small -> 1536 dims', async () => {
    const { ctx, stores, usage } = await runPipeline(join(FIXTURES_DIR, 'python-service'));
    const pinecone = stores.find((s) => s.product === 'pinecone')!;
    const signal = vectorScale(pinecone.id, usage, ctx);
    expect(signal).not.toBeNull();
    expect(signal!.variable).toBe('embedding-dims');
    expect(signal!.observability).toBe('static');
    expect(signal!.value).toBe(1536);
    expect(signal!.evidence[0]!.excerpt).toBe('text-embedding-3-small');
  });

  it('resolves each table entry correctly (text-embedding-3-large -> 3072)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'pa-vector-signal-'));
    writeFileSync(join(repo, 'requirements.txt'), 'pinecone-client==4.1.0\n');
    mkdirSync(join(repo, 'app'));
    writeFileSync(
      join(repo, 'app', 'embed.py'),
      [
        'from pinecone import Pinecone',
        'pc = Pinecone(api_key="")',
        'index = pc.Index("x")',
        'EMBED_MODEL = "text-embedding-3-large"',
        '',
        'def upsert(values):',
        '    index.upsert(vectors=[{"id": "1", "values": values}])',
      ].join('\n'),
    );
    const { ctx, stores, usage } = await runPipeline(repo);
    const pinecone = stores.find((s) => s.product === 'pinecone')!;
    const signal = vectorScale(pinecone.id, usage, ctx);
    expect(signal!.value).toBe(3072);
  });

  it('signal absent: no known embedding model name found in any of this store\'s files -> null', async () => {
    const { ctx } = await runPipeline(join(FIXTURES_DIR, 'python-service'));
    const usage = [
      { storeId: 'pinecone:x', command: 'upsert', kind: 'call-site' as const, file: 'app/db.py', line: 1, excerpt: 'index.upsert(...)' },
    ];
    expect(vectorScale('pinecone:x', usage, ctx)).toBeNull();
  });

  it('signal absent: no usage evidence for this store at all -> null', async () => {
    const { ctx } = await runPipeline(join(FIXTURES_DIR, 'python-service'));
    expect(vectorScale('pinecone:x', [], ctx)).toBeNull();
  });
});

describe('searchFeatures (done-conditions for 4.3, §1.3)', () => {
  it('node-monolith search.ts: plain .search(), no aggs/function_score -> real zero', async () => {
    const { stores, usage } = await runPipeline(join(FIXTURES_DIR, 'node-monolith'));
    const es = stores.find((s) => s.product === 'elasticsearch')!;
    const signal = searchFeatures(es.id, usage);
    expect(signal).not.toBeNull();
    expect(signal!.variable).toBe('feature-signal-count');
    expect(signal!.observability).toBe('static');
    expect(signal!.value).toBe(0);
  });

  it('counts aggs/function_score occurrences when present', () => {
    const usage = [
      { storeId: 'elasticsearch:x', command: 'search', kind: 'call-site' as const, file: 'a.ts', line: 1, excerpt: 'client.search(...)' },
      { storeId: 'elasticsearch:x', command: 'aggs', kind: 'call-site' as const, file: 'a.ts', line: 2, excerpt: 'aggs: {...}' },
      { storeId: 'elasticsearch:x', command: 'function_score', kind: 'call-site' as const, file: 'a.ts', line: 3, excerpt: 'function_score: {...}' },
    ];
    const signal = searchFeatures('elasticsearch:x', usage);
    expect(signal!.value).toBe(2);
    expect(signal!.evidence.length).toBe(2);
  });

  it('signal absent: no usage evidence for this store at all -> null', () => {
    expect(searchFeatures('elasticsearch:x', [])).toBeNull();
  });
});
