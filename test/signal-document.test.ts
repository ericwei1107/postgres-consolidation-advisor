import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { docSizeEstimate } from '../src/signals/docSizeEstimate.js';
import { docUpdateShape } from '../src/signals/docUpdateShape.js';
import { runPipeline } from './helpers/pipeline.js';
import type { OrmModel } from '../src/detectors/orm.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'pa-doc-signal-'));
}

describe('docSizeEstimate (done-conditions for 4.3, [A8])', () => {
  it('python-service profiles model: fields.length x 30 bytes/field, no seed data', async () => {
    const { models } = await runPipeline(join(FIXTURES_DIR, 'python-service'));
    const profiles = models.find((m) => m.summary.model === 'profiles');
    expect(profiles).toBeDefined();
    const signal = docSizeEstimate(profiles!);
    expect(signal).not.toBeNull();
    expect(signal!.variable).toBe('avg-doc-size-bytes');
    expect(signal!.observability).toBe('estimated');
    expect(signal!.value).toBe(profiles!.summary.fields.length * 30);
    expect(signal!.evidence[0]!.file).toBe(profiles!.file);
  });

  it('prefers a real seed-data-derived estimate over the field-count heuristic when present', () => {
    const model: OrmModel = {
      orm: 'mongoose',
      product: 'mongodb',
      file: 'models/user.ts',
      line: 3,
      summary: { model: 'User', fields: [{ name: 'a', type: 'string', nested: false }], estimatedDocBytes: 4096 },
    };
    const signal = docSizeEstimate(model);
    expect(signal!.value).toBe(4096);
  });

  it('signal absent: a model with zero fields and no seed estimate -> null', () => {
    const model: OrmModel = {
      orm: 'mongoose',
      product: 'mongodb',
      file: 'models/empty.ts',
      line: 1,
      summary: { model: 'Empty', fields: [] },
    };
    expect(docSizeEstimate(model)).toBeNull();
  });
});

describe('docUpdateShape (done-conditions for 4.3)', () => {
  it('python-service documents.py: $set (upsert_profile) + $inc (record_view) = 2 mutator hits', async () => {
    const { ctx, stores, usage } = await runPipeline(join(FIXTURES_DIR, 'python-service'));
    const mongo = stores.find((s) => s.product === 'mongodb')!;
    const signal = docUpdateShape(mongo.id, usage, ctx);
    expect(signal).not.toBeNull();
    expect(signal!.variable).toBe('field-level-mutator-count');
    expect(signal!.observability).toBe('static');
    expect(signal!.value).toBe(2);
  });

  it('whole-document replacement (replace_one, no $inc/$push/$set) yields a real zero, not absence', async () => {
    const repo = tempRepo();
    writeFileSync(repo + '/requirements.txt', 'pymongo==4.7.2\n');
    mkdirSync(join(repo, 'app'));
    writeFileSync(
      join(repo, 'app', 'documents.py'),
      [
        'from pymongo import MongoClient',
        'client = MongoClient()',
        'profiles = client["db"]["profiles"]',
        '',
        'def replace_profile(user_id, doc):',
        '    profiles.replace_one({"_id": user_id}, doc)',
        '',
      ].join('\n'),
    );
    const { ctx, stores, usage } = await runPipeline(repo);
    const mongo = stores.find((s) => s.product === 'mongodb')!;
    const signal = docUpdateShape(mongo.id, usage, ctx);
    expect(signal).not.toBeNull();
    expect(signal!.value).toBe(0);
  });

  it('signal absent: no update-shaped command harvested for this store -> null', () => {
    const usage = [
      { storeId: 'mongodb:x', command: 'find', kind: 'call-site' as const, file: 'a.py', line: 1, excerpt: 'db.find({})' },
    ];
    expect(docUpdateShape('mongodb:x', usage, { repoPath: '/nonexistent', config: DEFAULT_CONFIG, addWarning: () => {} })).toBeNull();
  });
});
