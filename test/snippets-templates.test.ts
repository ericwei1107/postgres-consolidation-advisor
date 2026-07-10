import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { extractOrmModels } from '../src/detectors/orm.js';
import type { DetectorContext } from '../src/detectors/types.js';
import { loadEmbeddingDims } from '../src/rules.js';
import { renderTemplate, TEMPLATE_FILES, type TemplateId } from '../src/snippets/templates.js';
import { validateSql } from '../src/snippets/validateSql.js';
import type {
  CacheUnloggedTableContext,
  GraphRecursiveCteContext,
  MongoJsonbContext,
  QueueContext,
  QueueTsContext,
  SearchParadeDbContext,
  SearchTsvectorContext,
  TimeseriesContext,
  VectorContext,
} from '../src/snippets/types.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

function assertNoUnresolvedMustache(rendered: string, id: string): void {
  expect(rendered, `${id}: rendered output`).not.toContain('{{');
  expect(rendered, `${id}: rendered output`).not.toContain('}}');
}

function ctxFor(repoPath: string): DetectorContext {
  return { repoPath, config: DEFAULT_CONFIG, addWarning: () => {} };
}

describe('snippet template library (done-conditions for 6.1)', () => {
  it('every mapping option in TEMPLATE_FILES has a corresponding file on disk', () => {
    // Exercises templatesDir() resolution implicitly: a missing file throws on read.
    for (const id of Object.keys(TEMPLATE_FILES) as TemplateId[]) {
      expect(() => renderTemplate(id, {} as never), id).not.toThrow(/could not locate/);
    }
  });

  it('cache: redis-cache-to-unlogged-table renders and passes SQL syntax validation', async () => {
    const context: CacheUnloggedTableContext = { tableName: 'session_cache', ttlSeconds: 1800 };
    const sql = renderTemplate('redis-cache-to-unlogged-table', context);
    assertNoUnresolvedMustache(sql, 'redis-cache-to-unlogged-table');
    await expect(validateSql(sql, 'redis-cache-to-unlogged-table')).resolves.not.toThrow();
    expect(sql).toContain('CREATE UNLOGGED TABLE IF NOT EXISTS session_cache');
    expect(sql).toContain('DEFAULT 1800');
  });

  it('queue: redis-queue-to-pgmq renders and passes SQL syntax validation', async () => {
    const context: QueueContext = { queueName: 'email-jobs' };
    const sql = renderTemplate('redis-queue-to-pgmq', context);
    assertNoUnresolvedMustache(sql, 'redis-queue-to-pgmq');
    await expect(validateSql(sql, 'redis-queue-to-pgmq')).resolves.not.toThrow();
    expect(sql).toContain("pgmq.create('email-jobs')");
  });

  it('document: mongo-collection-to-jsonb renders against python-service\'s real FieldSummary', async () => {
    const models = await extractOrmModels(ctxFor(join(FIXTURES_DIR, 'python-service')));
    const profiles = models.find((m) => m.product === 'mongodb');
    expect(profiles, 'python-service should yield the mongo profiles model').toBeDefined();

    // Hot columns = fields the fixture's own $inc/$push usage actually mutates
    // (PLAN.md 1.4's promote-hot-fields-out-of-the-blob middle path); the rest
    // stay in the cold JSONB blob.
    const hotColumns = profiles!.summary.fields
      .filter((f) => f.type === 'number')
      .map((f) => ({ name: f.name, sqlType: 'bigint' }));
    expect(hotColumns).toEqual([{ name: 'views', sqlType: 'bigint' }]);

    const context: MongoJsonbContext = {
      tableName: profiles!.summary.model,
      hotColumns,
      coldColumn: 'doc',
      ginIndexName: `${profiles!.summary.model}_doc_gin`,
    };
    const sql = renderTemplate('mongo-collection-to-jsonb', context);
    assertNoUnresolvedMustache(sql, 'mongo-collection-to-jsonb');
    await expect(validateSql(sql, 'mongo-collection-to-jsonb')).resolves.not.toThrow();
    expect(sql).toContain('views bigint');
    expect(sql).toContain("doc - '_id' - 'views'");
  });

  it('document: mongo-collection-to-jsonb renders correctly with zero hot columns', async () => {
    const context: MongoJsonbContext = { tableName: 'logs', hotColumns: [], coldColumn: 'doc', ginIndexName: 'logs_doc_gin' };
    const sql = renderTemplate('mongo-collection-to-jsonb', context);
    assertNoUnresolvedMustache(sql, 'mongo-collection-to-jsonb (no hot columns)');
    await expect(validateSql(sql, 'mongo-collection-to-jsonb')).resolves.not.toThrow();
  });

  it('search: es-index-to-tsvector renders and passes SQL syntax validation', async () => {
    const context: SearchTsvectorContext = {
      tableName: 'posts',
      textColumns: ['title', 'body'],
      tsvectorColumn: 'search_vector',
      indexName: 'posts_search_idx',
    };
    const sql = renderTemplate('es-index-to-tsvector', context);
    assertNoUnresolvedMustache(sql, 'es-index-to-tsvector');
    await expect(validateSql(sql, 'es-index-to-tsvector')).resolves.not.toThrow();
    expect(sql).toContain("coalesce(title, '') || ' ' ||");
    expect(sql).toContain("coalesce(body, '')");
  });

  it('search: es-index-to-paradedb renders and passes SQL syntax validation', async () => {
    const context: SearchParadeDbContext = { tableName: 'posts', textColumns: ['title', 'body'], indexName: 'posts_bm25_idx' };
    const sql = renderTemplate('es-index-to-paradedb', context);
    assertNoUnresolvedMustache(sql, 'es-index-to-paradedb');
    await expect(validateSql(sql, 'es-index-to-paradedb')).resolves.not.toThrow();
    expect(sql).toContain("paradedb.match('title, body', $1)");
  });

  it('vector: pinecone-to-pgvector renders with dims from the real embedding_dims table', async () => {
    const dims = loadEmbeddingDims().get('text-embedding-3-small');
    expect(dims).toBe(1536);
    const context: VectorContext = { tableName: 'profile_embeddings', dims: dims!, indexName: 'profile_embeddings_hnsw_idx' };
    const sql = renderTemplate('pinecone-to-pgvector', context);
    assertNoUnresolvedMustache(sql, 'pinecone-to-pgvector');
    await expect(validateSql(sql, 'pinecone-to-pgvector')).resolves.not.toThrow();
    expect(sql).toContain('embedding vector(1536)');
  });

  it('timeseries: influx-to-timescale renders and passes SQL syntax validation', async () => {
    const context: TimeseriesContext = { tableName: 'device_metrics', timeColumn: 'recorded_at' };
    const sql = renderTemplate('influx-to-timescale', context);
    assertNoUnresolvedMustache(sql, 'influx-to-timescale');
    await expect(validateSql(sql, 'influx-to-timescale')).resolves.not.toThrow();
    expect(sql).toContain("create_hypertable('device_metrics', by_range('recorded_at'))");
  });

  it('graph: cypher-to-recursive-cte renders and passes SQL syntax validation', async () => {
    const context: GraphRecursiveCteContext = { tableName: 'follows', cteName: 'follow_chain', maxDepth: 3 };
    const sql = renderTemplate('cypher-to-recursive-cte', context);
    assertNoUnresolvedMustache(sql, 'cypher-to-recursive-cte');
    await expect(validateSql(sql, 'cypher-to-recursive-cte')).resolves.not.toThrow();
    expect(sql).toContain('WHERE t.depth < 3');
  });

  it('an invalid rendered SQL string is rejected by validateSql (sanity check on the validator itself)', async () => {
    await expect(validateSql('SELECT FROM WHERE this is not valid (((', 'sanity-check')).rejects.toThrow();
  });

  it('queue: bullmq-to-pgmq.ts.hbs renders self-contained TypeScript that passes tsc --noEmit', () => {
    const context: QueueTsContext = { queueName: 'send-receipts', pascalName: 'SendReceipts' };
    const rendered = renderTemplate('bullmq-to-pgmq', context);
    assertNoUnresolvedMustache(rendered, 'bullmq-to-pgmq');
    expect(rendered).toContain('export async function enqueueSendReceipts');

    const dir = mkdtempSync(join(tmpdir(), 'pa-snippet-tsc-'));
    const file = join(dir, 'snippet.ts');
    writeFileSync(file, rendered);
    expect(() =>
      execFileSync(
        'npx',
        ['tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'bundler', '--skipLibCheck', file],
        { stdio: 'pipe' },
      ),
    ).not.toThrow();
  });
});
