import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type AdvisorConfig } from '../src/config.js';
import { extractOrmModels, ormDetector } from '../src/detectors/orm.js';
import type { DetectedStore } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

function ctx(repoPath: string, config: AdvisorConfig = DEFAULT_CONFIG) {
  const warnings: string[] = [];
  return {
    context: { repoPath, config, addWarning: (m: string) => warnings.push(m) },
    warnings,
  };
}

async function run(repoPath: string, config: AdvisorConfig = DEFAULT_CONFIG) {
  const { context, warnings } = ctx(repoPath, config);
  const detections = await ormDetector.detect(context);
  return { detections, stores: detections.map((d) => d.store), warnings };
}

/** (product, file) pairs from orm-schema evidence — the done-condition key. */
function ormPairs(stores: DetectedStore[]): Set<string> {
  const pairs = new Set<string>();
  for (const s of stores) {
    for (const e of s.evidence) {
      if (e.kind === 'orm-schema') pairs.add(`${s.product}@${e.file}`);
    }
  }
  return pairs;
}

function expectedOrmPairs(fixture: string): Set<string> {
  const raw = readFileSync(join(FIXTURES_DIR, fixture, 'expected-inventory.json'), 'utf8');
  return ormPairs(JSON.parse(raw) as DetectedStore[]);
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'pa-orm-'));
}

describe('ORM-schema detector (done-conditions for 2.4)', () => {
  const fixtures = ['empty', 'node-monolith', 'python-service', 'edge-cases', 'adversarial'];

  it.each(fixtures)('%s: orm-schema detections match expected-inventory (product+file)', async (fx) => {
    const { stores } = await run(join(FIXTURES_DIR, fx));
    expect(ormPairs(stores)).toEqual(expectedOrmPairs(fx));
  });

  it('python-service: yields the mongo document model with its field summary', async () => {
    const { stores } = await run(join(FIXTURES_DIR, 'python-service'));
    const mongo = stores.find((s) => s.product === 'mongodb');
    expect(mongo).toBeDefined();
    expect(mongo!.evidence).toEqual([
      {
        kind: 'orm-schema',
        file: 'app/documents.py',
        line: 12,
        excerpt:
          'model profiles (pymongo): display_name, bio, prefs object (nested), tags array, views number',
      },
    ]);
  });

  it('python-service: typed extraction (snapshot) — pymongo doc model + SQLAlchemy models', async () => {
    const { context } = ctx(join(FIXTURES_DIR, 'python-service'));
    expect(await extractOrmModels(context)).toMatchSnapshot();
  });

  it('node-monolith: yields Prisma-on-Postgres (snapshot), never inventoried as a store', async () => {
    const { context } = ctx(join(FIXTURES_DIR, 'node-monolith'));
    const models = await extractOrmModels(context);
    expect(models.every((m) => m.orm === 'prisma' && m.product === 'postgres')).toBe(true);
    expect(models.map((m) => m.summary.model)).toEqual(['User', 'Post']); // file order
    expect(models).toMatchSnapshot();

    const { stores } = await run(join(FIXTURES_DIR, 'node-monolith'));
    expect(stores).toEqual([]);
  });

  describe('Prisma', () => {
    it('provider mongodb → a mongodb detection with per-model field summaries', async () => {
      const dir = tempRepo();
      mkdirSync(join(dir, 'prisma'));
      writeFileSync(
        join(dir, 'prisma', 'schema.prisma'),
        [
          'datasource db {',
          '  provider = "mongodb"',
          '  url      = env("MONGODB_URI")',
          '}',
          '',
          'type Address {',
          '  street String',
          '  city   String',
          '}',
          '',
          'model Customer {',
          '  id      String  @id @map("_id")',
          '  email   String  @unique',
          '  meta    Json?',
          '  address Address',
          '  // a comment line',
          '  @@index([email])',
          '}',
        ].join('\n'),
      );
      const { stores } = await run(dir);
      expect(stores.map((s) => s.product)).toEqual(['mongodb']);
      expect(stores[0]!.evidence).toEqual([
        {
          kind: 'orm-schema',
          file: 'prisma/schema.prisma',
          line: 11,
          excerpt:
            'model Customer (prisma): id String, email String, meta Json? (nested), address Address (nested)',
        },
      ]);
    });

    it('provider postgresql/mysql schemas are extracted but never inventoried', async () => {
      const dir = tempRepo();
      writeFileSync(
        join(dir, 'schema.prisma'),
        ['datasource db {', '  provider = "mysql"', '}', '', 'model T {', '  id Int @id', '}'].join('\n'),
      );
      const { context } = ctx(dir);
      const models = await extractOrmModels(context);
      expect(models).toHaveLength(1);
      expect(models[0]!.product).toBe('relational');
      const { stores } = await run(dir);
      expect(stores).toEqual([]);
    });

    it('inherits a schema-folder provider and composite types across Prisma files', async () => {
      const dir = tempRepo();
      mkdirSync(join(dir, 'prisma', 'models'), { recursive: true });
      writeFileSync(
        join(dir, 'prisma', 'schema.prisma'),
        ['datasource db {', '  provider = "mongodb"', '}'].join('\n'),
      );
      writeFileSync(
        join(dir, 'prisma', 'models', 'types.prisma'),
        ['type Address {', '  street String', '}'].join('\n'),
      );
      writeFileSync(
        join(dir, 'prisma', 'models', 'customer.prisma'),
        ['model Customer {', '  id String @id', '  address Address', '} // Customer'].join('\n'),
      );

      const { context } = ctx(dir);
      expect(await extractOrmModels(context)).toEqual([
        {
          orm: 'prisma',
          product: 'mongodb',
          file: 'prisma/models/customer.prisma',
          line: 1,
          summary: {
            model: 'Customer',
            fields: [
              { name: 'id', type: 'String', nested: false },
              { name: 'address', type: 'Address', nested: true },
            ],
          },
        },
      ]);
    });
  });

  describe('Mongoose', () => {
    it('does not mistake another library\'s Schema constructor for Mongoose', async () => {
      const dir = tempRepo();
      writeFileSync(
        join(dir, 'editor.ts'),
        [
          'import { Schema } from "prosemirror-model";',
          'const schema = new Schema({ nodes: {}, marks: {} });',
        ].join('\n'),
      );
      const { stores } = await run(dir);
      expect(stores).toEqual([]);
    });

    it('extracts field names, types, and nested depth from a schema object literal', async () => {
      const dir = tempRepo();
      writeFileSync(
        join(dir, 'user.model.ts'),
        [
          "import mongoose, { Schema } from 'mongoose';",
          '',
          'const userSchema = new Schema({',
          '  email: { type: String, required: true },',
          '  name: String,',
          '  age: Number,',
          '  prefs: { theme: String, locale: String },',
          '  tags: [String],',
          '  posts: [{ title: String, body: String }],',
          '});',
          '',
          "export const User = mongoose.model('User', userSchema);",
        ].join('\n'),
      );
      const { stores, detections } = await run(dir);
      expect(stores.map((s) => s.product)).toEqual(['mongodb']);
      expect(detections[0]!.identity).toEqual({ kind: 'default' });

      const { context } = ctx(dir);
      const [model] = await extractOrmModels(context);
      expect(model!.summary.model).toBe('User'); // registered name, not the variable
      expect(model!.summary.fields).toEqual([
        { name: 'email', type: 'String', nested: false },
        { name: 'name', type: 'String', nested: false },
        { name: 'age', type: 'Number', nested: false },
        { name: 'prefs', type: 'object', nested: true },
        { name: 'tags', type: 'array', nested: false },
        { name: 'posts', type: 'array', nested: true },
      ]);
    });

    it('unregistered schema falls back to the variable name minus the Schema suffix', async () => {
      const dir = tempRepo();
      writeFileSync(
        join(dir, 'order.js'),
        "const mongoose = require('mongoose');\nconst orderSchema = new mongoose.Schema({ total: Number });",
      );
      const { context } = ctx(dir);
      const [model] = await extractOrmModels(context);
      expect(model!.summary.model).toBe('order');
    });

    it('handles comments in schema literals and schema assignments split across lines', async () => {
      const dir = tempRepo();
      writeFileSync(
        join(dir, 'user.js'),
        [
          "import mongoose, { Schema } from 'mongoose';",
          'const userSchema =',
          '  new Schema({',
          '    // A comment mentioning } must not close the literal.',
          '    email: String,',
          '    /* A comment mentioning { must not affect field parsing. */',
          '    name: String',
          '  });',
          "mongoose.model('User', userSchema);",
        ].join('\n'),
      );
      const { context } = ctx(dir);
      const [model] = await extractOrmModels(context);
      expect(model!.summary).toEqual({
        model: 'User',
        fields: [
          { name: 'email', type: 'String', nested: false },
          { name: 'name', type: 'String', nested: false },
        ],
      });
    });

    it('an unbalanced schema literal is skipped without crashing', async () => {
      const dir = tempRepo();
      writeFileSync(join(dir, 'broken.ts'), 'const s = new Schema({ a: String, b: {');
      const { stores } = await run(dir);
      expect(stores).toEqual([]);
    });
  });

  describe('SQLAlchemy', () => {
    it('python-service db.py: Column/relationship line-regex yields both models', async () => {
      const { context } = ctx(join(FIXTURES_DIR, 'python-service'));
      const models = await extractOrmModels(context);
      const sa = models.filter((m) => m.orm === 'sqlalchemy');
      expect(sa.map((m) => m.summary.model)).toEqual(['User', 'Order']);
      expect(sa[0]!.summary.fields).toEqual([
        { name: 'id', type: 'Integer', nested: false },
        { name: 'email', type: 'String', nested: false },
        { name: 'name', type: 'String', nested: false },
        { name: 'orders', type: 'relationship', nested: false },
      ]);
      // Relational schemas are never inventoried.
      expect(sa.every((m) => m.product === 'relational')).toBe(true);
    });

    it('supports 2.0-style mapped_column with Mapped annotations', async () => {
      const dir = tempRepo();
      writeFileSync(
        join(dir, 'models.py'),
        [
          'from sqlalchemy.orm import Mapped, mapped_column',
          '',
          'class Widget(Base):',
          '    __tablename__ = "widgets"',
          '    id: Mapped[int] = mapped_column(Integer, primary_key=True)',
          '    label: Mapped[str] = mapped_column(String(50))',
        ].join('\n'),
      );
      const { context } = ctx(dir);
      const [model] = await extractOrmModels(context);
      expect(model!.summary).toEqual({
        model: 'Widget',
        fields: [
          { name: 'id', type: 'Integer', nested: false },
          { name: 'label', type: 'String', nested: false },
        ],
      });
    });

    it('classes without Column() (plain Python) produce nothing', async () => {
      const dir = tempRepo();
      writeFileSync(
        join(dir, 'plain.py'),
        ['class Service:', '    name = "svc"', '    def run(self):', '        pass'].join('\n'),
      );
      const { context } = ctx(dir);
      expect(await extractOrmModels(context)).toEqual([]);
    });
  });

  describe('pymongo document shapes', () => {
    it('merges $set/$inc fields across calls; collection name from db["..."] mapping', async () => {
      const dir = tempRepo();
      writeFileSync(
        join(dir, 'store.py'),
        [
          'items = db["items"]',
          '',
          'items.insert_one({"sku": "a-1", "qty": 3, "dims": {"w": 2}})',
          'items.update_one({"sku": "a-1"}, {"$inc": {"qty": 1}, "$push": {"log": "x"}})',
        ].join('\n'),
      );
      const { context } = ctx(dir);
      const [model] = await extractOrmModels(context);
      expect(model!.summary.model).toBe('items');
      expect(model!.summary.fields).toEqual([
        { name: 'sku', type: 'string', nested: false },
        { name: 'qty', type: 'number', nested: false },
        { name: 'dims', type: 'object', nested: true },
        { name: 'log', type: 'array', nested: false },
      ]);
    });

    it('a python file without pymongo-shaped calls produces nothing', async () => {
      const dir = tempRepo();
      writeFileSync(join(dir, 'app.py'), 'settings = {}\nsettings.update({"a": 1})\n');
      const { context } = ctx(dir);
      expect(await extractOrmModels(context)).toEqual([]);
    });

    it('harvests replacement documents rather than their filters', async () => {
      const dir = tempRepo();
      writeFileSync(
        join(dir, 'store.py'),
        [
          'items = db.get_collection("items")',
          'items.replace_one({"_id": 1}, {"title": "first", "meta": {"v": 1}})',
          'items.find_one_and_replace({"_id": 2}, {"title": "second", "tags": ["new"]})',
        ].join('\n'),
      );
      const { context } = ctx(dir);
      const [model] = await extractOrmModels(context);
      expect(model!.summary).toEqual({
        model: 'items',
        fields: [
          { name: 'title', type: 'string', nested: false },
          { name: 'meta', type: 'object', nested: true },
          { name: 'tags', type: 'array', nested: false },
        ],
      });
    });
  });

  describe('walk hygiene', () => {
    it('ignores schemas inside node_modules', async () => {
      const dir = tempRepo();
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(
        join(dir, 'node_modules', 'pkg', 'schema.prisma'),
        'datasource db {\n  provider = "mongodb"\n}\nmodel X {\n  id String @id\n}',
      );
      const { stores } = await run(dir);
      expect(stores).toEqual([]);
    });

    it('honors config.ignore globs', async () => {
      const dir = tempRepo();
      mkdirSync(join(dir, 'examples'));
      writeFileSync(
        join(dir, 'examples', 'schema.prisma'),
        'datasource db {\n  provider = "mongodb"\n}\nmodel X {\n  id String @id\n}',
      );
      const { stores } = await run(dir, { ...DEFAULT_CONFIG, ignore: ['examples/**'] });
      expect(stores).toEqual([]);
    });
  });
});
