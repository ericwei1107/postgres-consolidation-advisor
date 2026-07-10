import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { extractOrmModels } from '../src/detectors/orm.js';
import type { DetectorContext } from '../src/detectors/types.js';
import type { GeminiClient } from '../src/classify/gemini.js';
import { renderTemplate } from '../src/snippets/templates.js';
import { tailorSnippet, type TailorOptions } from '../src/snippets/tailor.js';
import type { FieldSummary } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

function clientWith(...responses: Array<string | Error>): { client: GeminiClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      models: {
        generateContent: async ({ model }) => {
          calls.push(model);
          const response = responses.shift();
          if (response instanceof Error) throw response;
          return { text: response ?? '' };
        },
      },
    },
  };
}

function ctxFor(repoPath: string): DetectorContext {
  return { repoPath, config: DEFAULT_CONFIG, addWarning: () => {} };
}

const genericQueueSql = renderTemplate('redis-queue-to-pgmq', { queueName: 'jobs' });

describe('Gemini snippet tailoring (Stage 6.2) — adapt', () => {
  it('ships the Gemini-adapted SQL when it passes the AST-shape guard', async () => {
    const renamed = renderTemplate('redis-queue-to-pgmq', { queueName: 'email-notifications' });
    const { client, calls } = clientWith(renamed);
    const result = await tailorSnippet('redis-queue-to-pgmq', genericQueueSql, undefined, { noAi: false, client });
    expect(result).toEqual({ sql: renamed.trim(), tailored: true });
    expect(calls).toHaveLength(1);
  });

  it('strips a markdown code fence Gemini wraps the SQL in', async () => {
    const renamed = renderTemplate('redis-queue-to-pgmq', { queueName: 'email-notifications' });
    const { client } = clientWith('```sql\n' + renamed + '\n```');
    const result = await tailorSnippet('redis-queue-to-pgmq', genericQueueSql, undefined, { noAi: false, client });
    expect(result).toEqual({ sql: renamed.trim(), tailored: true });
  });

  it('fixture run: mongo->jsonb snippet tailored to match python-service\'s real FieldSummary', async () => {
    const models = await extractOrmModels(ctxFor(join(FIXTURES_DIR, 'python-service')));
    const profiles = models.find((m) => m.product === 'mongodb');
    expect(profiles).toBeDefined();
    const summary: FieldSummary = profiles!.summary;

    // Rendered with a generic placeholder column name — this is what
    // tailoring is FOR: matching the app's real field names.
    const generic = renderTemplate('mongo-collection-to-jsonb', {
      tableName: 'documents',
      hotColumns: [{ name: 'hot_field', sqlType: 'bigint' }],
      coldColumn: 'doc',
      ginIndexName: 'documents_doc_gin',
    });

    const tailored = renderTemplate('mongo-collection-to-jsonb', {
      tableName: summary.model,
      hotColumns: [{ name: 'views', sqlType: 'bigint' }],
      coldColumn: 'doc',
      ginIndexName: `${summary.model}_doc_gin`,
    });

    const { client } = clientWith(tailored);
    const result = await tailorSnippet('mongo-collection-to-jsonb', generic, summary, { noAi: false, client });
    expect(result.tailored).toBe(true);
    expect(result.sql).toContain('views bigint');
    expect(result.sql).toContain(summary.model);
    expect(result.sql).not.toContain('hot_field');
  });
});

describe('Gemini snippet tailoring (Stage 6.2) — validate (AST-shape guard)', () => {
  it('discards a tailored snippet that adds an extra statement (prompt-injection shape)', async () => {
    const injected = `${genericQueueSql}\nDROP TABLE secrets;`;
    const warnings: string[] = [];
    const { client } = clientWith(injected);
    const result = await tailorSnippet('redis-queue-to-pgmq', genericQueueSql, undefined, {
      noAi: false,
      client,
      addWarning: (w) => warnings.push(w),
    });
    expect(result).toEqual({ sql: genericQueueSql, tailored: false });
    expect(warnings[0]).toContain('failed the AST-shape guard');
  });

  it('discards tailored output that does not parse as SQL at all', async () => {
    const warnings: string[] = [];
    const { client } = clientWith('Sure! Here is the adapted snippet you asked for.');
    const result = await tailorSnippet('redis-queue-to-pgmq', genericQueueSql, undefined, {
      noAi: false,
      client,
      addWarning: (w) => warnings.push(w),
    });
    expect(result).toEqual({ sql: genericQueueSql, tailored: false });
    expect(warnings[0]).toContain('unusable SQL');
  });
});

describe('Gemini snippet tailoring (Stage 6.2) — fallback', () => {
  it('does not call Gemini for --no-ai', async () => {
    const { client, calls } = clientWith(new Error('must not be used'));
    const result = await tailorSnippet('redis-queue-to-pgmq', genericQueueSql, undefined, { noAi: true, client });
    expect(result).toEqual({ sql: genericQueueSql, tailored: false });
    expect(calls).toEqual([]);
  });

  it('never tailors .ts templates — untailored wins without calling Gemini', async () => {
    const rendered = renderTemplate('bullmq-to-pgmq', { queueName: 'jobs', pascalName: 'Jobs' });
    const { client, calls } = clientWith(new Error('must not be used'));
    const result = await tailorSnippet('bullmq-to-pgmq', rendered, undefined, { noAi: false, client });
    expect(result).toEqual({ sql: rendered, tailored: false });
    expect(calls).toEqual([]);
  });

  it('ships untailored with a warning when no API key/client is available', async () => {
    const warnings: string[] = [];
    const options: TailorOptions = { noAi: false, addWarning: (w) => warnings.push(w) };
    const result = await tailorSnippet('redis-queue-to-pgmq', genericQueueSql, undefined, options);
    expect(result).toEqual({ sql: genericQueueSql, tailored: false });
    expect(warnings[0]).toContain('GEMINI_API_KEY is not set');
  });

  it('downgrades only on a rate limit and succeeds with the next model', async () => {
    const renamed = renderTemplate('redis-queue-to-pgmq', { queueName: 'email-notifications' });
    const warnings: string[] = [];
    const { client, calls } = clientWith(Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }), renamed);
    const result = await tailorSnippet('redis-queue-to-pgmq', genericQueueSql, undefined, {
      noAi: false,
      client,
      models: ['best', 'fallback'],
      addWarning: (w) => warnings.push(w),
    });
    expect(calls).toEqual(['best', 'fallback']);
    expect(result).toEqual({ sql: renamed.trim(), tailored: true });
    expect(warnings[0]).toContain('retrying snippet tailoring with fallback');
  });

  it('falls back to untailored after every configured model is rate limited', async () => {
    const limited = () => Object.assign(new Error('429 RESOURCE_EXHAUSTED'), { status: 429 });
    const { client, calls } = clientWith(limited(), limited());
    const result = await tailorSnippet('redis-queue-to-pgmq', genericQueueSql, undefined, {
      noAi: false,
      client,
      models: ['best', 'fallback'],
    });
    expect(result).toEqual({ sql: genericQueueSql, tailored: false });
    expect(calls).toEqual(['best', 'fallback']);
  });

  it('falls back to untailored on a non-rate-limit Gemini error without retrying', async () => {
    const { client, calls } = clientWith(new Error('internal error'));
    const result = await tailorSnippet('redis-queue-to-pgmq', genericQueueSql, undefined, {
      noAi: false,
      client,
      models: ['best', 'fallback'],
    });
    expect(result).toEqual({ sql: genericQueueSql, tailored: false });
    expect(calls).toEqual(['best']);
  });
});
