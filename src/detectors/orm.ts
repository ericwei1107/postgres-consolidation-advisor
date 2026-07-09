import { readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { productCategories } from '../rules.js';
import { scanFiles, toRelPosix } from '../scan.js';
import type { Evidence, FieldSummary } from '../types.js';
import type { Detection, Detector, DetectorContext } from './types.js';

/**
 * ORM-schema detector (PLAN.md 2.4).
 *
 * Parses, line/brace-based (no AST, per §0):
 *  - Prisma `*.prisma` — datasource provider + model shapes;
 *  - Mongoose schemas — `new Schema({...})` object literals in JS/TS;
 *  - SQLAlchemy models — `Column(` / `relationship(` line regexes in Python;
 *  - pymongo document shapes — `$set`/`$inc`/`$push` docs and `insert_one`
 *    literals (the "Mongoose-equivalent document model" of Python repos).
 *
 * Two outputs (PLAN.md §2 review addition): structured `FieldSummary[]` via
 * `extractOrmModels` — typed data for doc-size estimation (4.3) and snippet
 * tailoring (6.2) — and per-model summaries rendered into `orm-schema`
 * Evidence excerpts on the detections. Schemas targeting Postgres (Prisma
 * provider postgresql, SQLAlchemy) are never inventoried: Postgres is the
 * consolidation target. Their field summaries are still extracted.
 */

export type OrmKind = 'prisma' | 'mongoose' | 'sqlalchemy' | 'pymongo';

/** One parsed model: where it was found, what store it targets, and its shape. */
export interface OrmModel {
  orm: OrmKind;
  /** Product the schema targets. `postgres`/`relational` are never inventoried. */
  product: string;
  file: string;
  line: number;
  summary: FieldSummary;
}

const MAX_FILE_BYTES = 1024 * 1024;

function looksBinary(raw: string): boolean {
  return raw.slice(0, 4096).includes('\0');
}

// --- generic brace/paren-aware helpers (shared by the JS and Python parsers) ---

const OPEN_TO_CLOSE: Record<string, string> = { '{': '}', '(': ')', '[': ']' };

/** Exclusive end index of a JS/TS/Python comment starting at `i`, if any. */
function commentEnd(text: string, i: number): number | null {
  const c = text[i];
  const next = text[i + 1];
  if ((c === '/' && next === '/') || c === '#') {
    const newline = text.indexOf('\n', i + (c === '/' ? 2 : 1));
    return newline === -1 ? text.length : newline;
  }
  if (c === '/' && next === '*') {
    const close = text.indexOf('*/', i + 2);
    return close === -1 ? text.length : close + 2;
  }
  return null;
}

/** Remove comments while preserving line numbers and string literals. */
function withoutComments(text: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if (quote) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      continue;
    }
    const end = commentEnd(text, i);
    if (end !== null) {
      out += text.slice(i, end).replace(/[^\n]/g, ' ');
      i = end - 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** Content between the bracket at `openIdx` and its match (exclusive); null if unbalanced. */
function balancedSlice(text: string, openIdx: number): string | null {
  const open = text[openIdx] ?? '';
  const close = OPEN_TO_CLOSE[open];
  if (!close) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    const end = commentEnd(text, i);
    if (end !== null) {
      i = end - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return null;
}

/** Advance from `i` to the top-level comma ending the current value (or end of text). */
function skipValue(text: string, i: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (; i < text.length; i++) {
    const c = text[i] ?? '';
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    const end = commentEnd(text, i);
    if (end !== null) {
      i = end - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c in OPEN_TO_CLOSE) depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) return i;
  }
  return i;
}

interface RawEntry {
  key: string;
  value: string;
}

/** `key: value` entries at the top level of an object/dict literal's inner text. */
function topLevelEntries(objText: string): RawEntry[] {
  const entries: RawEntry[] = [];
  let i = 0;
  while (i < objText.length) {
    while (i < objText.length && /[\s,]/.test(objText[i] ?? '')) i++;
    const end = commentEnd(objText, i);
    if (end !== null) {
      i = end;
      continue;
    }
    if (i >= objText.length) break;
    const rest = objText.slice(i);
    const quoted = rest.match(/^(["'])((?:\\.|(?!\1).)*)\1\s*:/);
    const bare = quoted ? null : rest.match(/^([A-Za-z_$][\w$]*)\s*:/);
    if (!quoted && !bare) {
      i = skipValue(objText, i) + 1; // not key-shaped (spread, comment, ...) — skip the value
      continue;
    }
    const key = quoted ? (quoted[2] ?? '') : (bare?.[1] ?? '');
    i += (quoted ?? bare)![0].length;
    const start = i;
    i = skipValue(objText, i);
    entries.push({ key, value: objText.slice(start, i).trim() });
    i++;
  }
  return entries;
}

/** Comma-separated arguments, ignoring nested values, quoted strings, and comments. */
function topLevelArguments(text: string): string[] {
  const args: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    const end = commentEnd(text, i);
    if (end !== null) {
      i = end - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c in OPEN_TO_CLOSE) {
      depth++;
    } else if (c === '}' || c === ')' || c === ']') {
      depth--;
    } else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(text.slice(start).trim());
  return args;
}

type FieldShape = { type: string; nested: boolean };

/** Shape of a literal value (JS or Python) — `unknown` for identifiers/expressions. */
function classifyValue(value: string): FieldShape {
  const v = value.trim();
  if (v.startsWith('{')) return { type: 'object', nested: true };
  if (v.startsWith('[')) return { type: 'array', nested: v.includes('{') };
  if (/^["'`]/.test(v)) return { type: 'string', nested: false };
  if (/^-?\d/.test(v)) return { type: 'number', nested: false };
  if (/^(true|false|True|False)\b/.test(v)) return { type: 'boolean', nested: false };
  return { type: 'unknown', nested: false };
}

function lineOfIndex(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

// --- Prisma ---

/** Datasource provider → product. Anything Postgres-flavored is the consolidation target. */
const PRISMA_PROVIDER_PRODUCTS: Record<string, string> = {
  postgresql: 'postgres',
  postgres: 'postgres',
  cockroachdb: 'postgres',
  mongodb: 'mongodb',
  mysql: 'relational',
  sqlite: 'relational',
  sqlserver: 'relational',
};

interface PrismaParseOptions {
  provider?: string;
  compositeTypes?: ReadonlySet<string>;
}

function parsePrisma(raw: string, file: string, options: PrismaParseOptions = {}): OrmModel[] {
  const lines = withoutComments(raw).split('\n');
  let provider = options.provider;
  interface Block {
    kind: string;
    name: string;
    line: number;
    fields: { name: string; type: string }[];
  }
  let block: Block | null = null;
  const modelBlocks: Block[] = [];
  const compositeTypes = new Set(options.compositeTypes);

  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim();
    if (!block) {
      const m = t.match(/^(datasource|generator|model|type|enum|view)\s+([A-Za-z_]\w*)\s*\{/);
      if (m) {
        block = { kind: m[1] ?? '', name: m[2] ?? '', line: i + 1, fields: [] };
        if (block.kind === 'type') compositeTypes.add(block.name);
      }
      continue;
    }
    if (t === '}') {
      if (block.kind === 'model' || block.kind === 'type') modelBlocks.push(block);
      block = null;
      continue;
    }
    if (block.kind === 'datasource') {
      const p = t.match(/^provider\s*=\s*["']([^"']+)["']/);
      if (p?.[1]) provider = p[1].toLowerCase();
      continue;
    }
    if (block.kind === 'model' || block.kind === 'type') {
      if (t === '' || t.startsWith('//') || t.startsWith('@@')) continue;
      const f = t.match(/^([A-Za-z_]\w*)\s+([A-Za-z_]\w*(?:\[\])?\??)/);
      if (f?.[1] && f[2]) block.fields.push({ name: f[1], type: f[2] });
    }
  }

  const product = PRISMA_PROVIDER_PRODUCTS[provider ?? ''] ?? 'relational';
  return modelBlocks
    .filter((b) => b.kind === 'model' && b.fields.length > 0)
    .map((b) => ({
      orm: 'prisma' as const,
      product,
      file,
      line: b.line,
      summary: {
        model: b.name,
        fields: b.fields.map((f) => {
          const base = f.type.replace(/\[\]$|\?$/g, '');
          return { name: f.name, type: f.type, nested: base === 'Json' || compositeTypes.has(base) };
        }),
      },
    }));
}

function prismaProvider(raw: string): string | undefined {
  const clean = withoutComments(raw);
  for (const block of clean.matchAll(/(?:^|\n)\s*datasource\s+[A-Za-z_]\w*\s*\{/g)) {
    const open = block.index + block[0].lastIndexOf('{');
    const contents = balancedSlice(clean, open);
    const provider = contents?.match(/^\s*provider\s*=\s*["']([^"']+)["']/m)?.[1];
    if (provider) return provider.toLowerCase();
  }
  return undefined;
}

function prismaCompositeTypes(raw: string): Set<string> {
  const types = new Set<string>();
  for (const block of withoutComments(raw).matchAll(/(?:^|\n)\s*type\s+([A-Za-z_]\w*)\s*\{/g)) {
    if (block[1]) types.add(block[1]);
  }
  return types;
}

function parsePrismaFiles(files: { file: string; raw: string }[]): OrmModel[] {
  const providers = new Map<string, string>();
  for (const { file, raw } of files) {
    const provider = prismaProvider(raw);
    if (provider) providers.set(posix.dirname(file), provider);
  }

  const scopeFor = (file: string): string => {
    let dir = posix.dirname(file);
    while (true) {
      if (providers.has(dir)) return dir;
      if (dir === '.') return dir;
      dir = posix.dirname(dir);
    }
  };

  const typesByScope = new Map<string, Set<string>>();
  for (const { file, raw } of files) {
    const scope = scopeFor(file);
    let types = typesByScope.get(scope);
    if (!types) {
      types = new Set();
      typesByScope.set(scope, types);
    }
    for (const type of prismaCompositeTypes(raw)) types.add(type);
  }

  return files.flatMap(({ file, raw }) => {
    const scope = scopeFor(file);
    return parsePrisma(raw, file, {
      provider: providers.get(scope),
      compositeTypes: typesByScope.get(scope),
    });
  });
}

// --- Mongoose ---

const MONGOOSE_SCHEMA_RE = /(?:^|[^.\w])new\s+(?:mongoose\.)?Schema\s*(?:<[^>]*>)?\s*\(/g;

/** `{ type: String, required: true }` option objects vs nested subdocuments. */
function mongooseFieldShape(value: string): FieldShape {
  const v = value.trim();
  if (v.startsWith('{')) {
    const inner = balancedSlice(v, 0);
    if (inner === null) return { type: 'object', nested: true };
    const typeEntry = topLevelEntries(inner).find((e) => e.key === 'type');
    if (!typeEntry) return { type: 'object', nested: true };
    return mongooseFieldShape(typeEntry.value);
  }
  if (v.startsWith('[')) return { type: 'array', nested: v.includes('{') };
  const ident = v.match(/^[A-Za-z_$][\w$.]*/);
  if (ident) {
    const segments = ident[0].split('.');
    return { type: segments[segments.length - 1] ?? ident[0], nested: false };
  }
  return classifyValue(v);
}

function parseMongoose(raw: string, file: string): OrmModel[] {
  if (!raw.includes('Schema')) return [];

  // schema variable → registered model name (mongoose.model('User', userSchema)).
  const modelNames = new Map<string, string>();
  for (const m of raw.matchAll(
    /\.model\s*(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']\s*,\s*([A-Za-z_$][\w$]*)/g,
  )) {
    if (m[1] && m[2]) modelNames.set(m[2], m[1]);
  }

  const models: OrmModel[] = [];
  for (const m of raw.matchAll(MONGOOSE_SCHEMA_RE)) {
    const parenIdx = m.index + m[0].length - 1;
    const braceIdx = raw.slice(parenIdx + 1).search(/\S/);
    if (braceIdx === -1 || raw[parenIdx + 1 + braceIdx] !== '{') continue;
    const objText = balancedSlice(raw, parenIdx + 1 + braceIdx);
    if (objText === null) continue; // unbalanced — skip, never crash

    // The assigning variable, if this is `const userSchema = new Schema(...)`.
    const before = raw.slice(0, m.index);
    const varName = before.match(
      /(?:^|[;\n])\s*(?:export\s+)?(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)(?:\s*:\s*[^=;\n]+)?\s*=\s*$/,
    )?.[1];
    const model =
      (varName && modelNames.get(varName)) ?? varName?.replace(/Schema$/, '') ?? 'Schema';

    const fields = topLevelEntries(objText).map((e) => {
      const shape = mongooseFieldShape(e.value);
      return { name: e.key, type: shape.type, nested: shape.nested };
    });
    if (fields.length === 0) continue;

    models.push({
      orm: 'mongoose',
      product: 'mongodb',
      file,
      line: lineOfIndex(raw, m.index),
      summary: { model, fields },
    });
  }
  return models;
}

// --- SQLAlchemy (line-regex per PLAN.md 2.4) ---

const SA_CLASS_RE = /^class\s+([A-Za-z_]\w*)/;
const SA_COLUMN_RE =
  /^\s+([A-Za-z_]\w*)\s*(?::\s*Mapped\[([^\]]+)\])?\s*=\s*(?:\w+\.)?(?:Column|mapped_column)\(\s*(.*)$/;
const SA_RELATIONSHIP_RE = /^\s+([A-Za-z_]\w*)\s*(?::\s*[^=]+?)?\s*=\s*(?:\w+\.)?relationship\(/;

function sqlAlchemyColumnType(args: string, annotation: string | undefined): string {
  const rest = args.replace(/^["'][^"']*["']\s*,\s*/, ''); // optional explicit column name
  const ident = rest.match(/^(?:\w+\.)?([A-Za-z_]\w*)/);
  if (ident?.[1]) return ident[1];
  return annotation?.trim() ?? 'unknown';
}

function parseSqlAlchemy(raw: string, file: string): OrmModel[] {
  if (!raw.includes('Column(') && !raw.includes('mapped_column(')) return [];

  interface PyClass {
    name: string;
    line: number;
    fields: { name: string; type: string; nested: boolean }[];
    hasColumn: boolean;
  }
  const classes: PyClass[] = [];
  let current: PyClass | null = null;

  const close = () => {
    if (current?.hasColumn) classes.push(current);
    current = null;
  };

  raw.split('\n').forEach((line, i) => {
    const cls = line.match(SA_CLASS_RE);
    if (cls?.[1]) {
      close();
      current = { name: cls[1], line: i + 1, fields: [], hasColumn: false };
      return;
    }
    if (!current) return;
    // Any other top-level statement ends the class body.
    if (/^\S/.test(line) && line.trim() !== '') {
      close();
      return;
    }
    const col = line.match(SA_COLUMN_RE);
    if (col?.[1]) {
      current.fields.push({
        name: col[1],
        type: sqlAlchemyColumnType(col[3] ?? '', col[2]),
        nested: false,
      });
      current.hasColumn = true;
      return;
    }
    const rel = line.match(SA_RELATIONSHIP_RE);
    if (rel?.[1]) current.fields.push({ name: rel[1], type: 'relationship', nested: false });
  });
  close();

  return classes.map((c) => ({
    orm: 'sqlalchemy' as const,
    product: 'relational', // dialect lives in the engine URL, not the model — never inventoried
    file,
    line: c.line,
    summary: { model: c.name, fields: c.fields },
  }));
}

// --- pymongo document shapes ---

const PYMONGO_CALL_RE =
  /\b([A-Za-z_]\w*)\.(insert_one|insert_many|update_one|update_many|replace_one|find_one_and_update|find_one_and_replace)\s*\(/g;

const PYMONGO_OPERATOR_RE = /["']\$(set|setOnInsert|inc|mul|min|max|push|addToSet)["']\s*:\s*\{/g;

const NUMERIC_OPERATORS = new Set(['inc', 'mul', 'min', 'max']);
const ARRAY_OPERATORS = new Set(['push', 'addToSet']);

function parsePymongo(raw: string, file: string): OrmModel[] {
  if (!PYMONGO_CALL_RE.test(raw)) {
    PYMONGO_CALL_RE.lastIndex = 0;
    return [];
  }
  PYMONGO_CALL_RE.lastIndex = 0;

  // Collection variable → collection name (profiles = db["profiles"], db.get_collection("x")).
  const collections = new Map<string, string>();
  for (const m of raw.matchAll(/([A-Za-z_]\w*)\s*=\s*\w+\s*\[\s*["']([^"']+)["']\s*\]/g)) {
    if (m[1] && m[2]) collections.set(m[1], m[2]);
  }
  for (const m of raw.matchAll(/([A-Za-z_]\w*)\s*=\s*\w+\.get_collection\(\s*["']([^"']+)["']/g)) {
    if (m[1] && m[2]) collections.set(m[1], m[2]);
  }

  interface DocModel {
    line: number;
    fields: Map<string, FieldShape>;
  }
  const docs = new Map<string, DocModel>();

  const addField = (doc: DocModel, name: string, shape: FieldShape) => {
    const existing = doc.fields.get(name);
    if (!existing || (existing.type === 'unknown' && shape.type !== 'unknown')) {
      doc.fields.set(name, shape);
    }
  };

  for (const call of raw.matchAll(PYMONGO_CALL_RE)) {
    const receiver = call[1] ?? '';
    const method = call[2] ?? '';
    const args = balancedSlice(raw, call.index + call[0].length - 1);
    if (args === null) continue; // unbalanced — skip, never crash

    const model = collections.get(receiver) ?? receiver;
    let doc = docs.get(model);
    if (!doc) {
      doc = { line: lineOfIndex(raw, call.index), fields: new Map() };
      docs.set(model, doc);
    }

    const callArgs = topLevelArguments(args);
    if (method.startsWith('insert')) {
      // First dict literal is the document (insert_many: first element of the list).
      const document = callArgs[0] ?? '';
      const braceIdx = document.indexOf('{');
      const dictText = braceIdx === -1 ? null : balancedSlice(document, braceIdx);
      if (dictText !== null) {
        for (const e of topLevelEntries(dictText)) {
          if (!e.key.startsWith('$')) addField(doc, e.key, classifyValue(e.value));
        }
      }
      continue;
    }

    if (method === 'replace_one' || method === 'find_one_and_replace') {
      const replacement = callArgs[1] ?? '';
      const dictText = replacement.startsWith('{') ? balancedSlice(replacement, 0) : null;
      if (dictText !== null) {
        for (const e of topLevelEntries(dictText)) addField(doc, e.key, classifyValue(e.value));
      }
      continue;
    }

    // update/replace shapes: harvest fields from update-operator blocks.
    for (const op of args.matchAll(PYMONGO_OPERATOR_RE)) {
      const operator = op[1] ?? '';
      const dictText = balancedSlice(args, op.index + op[0].length - 1);
      if (dictText === null) continue;
      for (const e of topLevelEntries(dictText)) {
        const shape = NUMERIC_OPERATORS.has(operator)
          ? { type: 'number', nested: false }
          : ARRAY_OPERATORS.has(operator)
            ? { type: 'array', nested: false }
            : classifyValue(e.value);
        addField(doc, e.key, shape);
      }
    }
  }

  return [...docs.entries()]
    .filter(([, doc]) => doc.fields.size > 0)
    .map(([model, doc]) => ({
      orm: 'pymongo' as const,
      product: 'mongodb',
      file,
      line: doc.line,
      summary: {
        model,
        fields: [...doc.fields.entries()].map(([name, s]) => ({
          name,
          type: s.type,
          nested: s.nested,
        })),
      },
    }));
}

// --- extraction + detector ---

interface SourceKind {
  id: 'prisma' | 'mongoose' | 'python';
  globs: string[];
  parse: (raw: string, file: string) => OrmModel[];
}

const SOURCES: SourceKind[] = [
  { id: 'prisma', globs: ['**/*.prisma'], parse: parsePrisma },
  { id: 'mongoose', globs: ['**/*.{js,ts,jsx,tsx,mjs,cjs}'], parse: parseMongoose },
  {
    id: 'python',
    globs: ['**/*.py'],
    parse: (raw, file) => [...parseSqlAlchemy(raw, file), ...parsePymongo(raw, file)],
  },
];

/** Typed schema extraction — consumed by doc-size estimation (4.3) and snippet tailoring (6.2). */
export async function extractOrmModels(ctx: DetectorContext): Promise<OrmModel[]> {
  const models: OrmModel[] = [];
  for (const source of SOURCES) {
    const files = await scanFiles(ctx.repoPath, source.globs, ctx.config);
    const readable: { file: string; raw: string }[] = [];
    for (const file of files) {
      const rel = toRelPosix(ctx.repoPath, file);
      let raw: string;
      try {
        if (statSync(file).size > MAX_FILE_BYTES) continue;
        raw = readFileSync(file, 'utf8');
      } catch (e) {
        ctx.addWarning(`skipped ${rel}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (looksBinary(raw)) continue;
      readable.push({ file: rel, raw });
    }
    models.push(
      ...(source.id === 'prisma'
        ? parsePrismaFiles(readable)
        : readable.flatMap(({ raw, file }) => source.parse(raw, file))),
    );
  }
  return models.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.summary.model.localeCompare(b.summary.model),
  );
}

/** Per-model field summary rendered into an Evidence excerpt (PLAN.md 2.4). */
export function renderModelExcerpt(model: OrmModel): string {
  const fields = model.summary.fields
    .map((f) => `${f.name}${f.type !== 'unknown' ? ` ${f.type}` : ''}${f.nested ? ' (nested)' : ''}`)
    .join(', ');
  return `model ${model.summary.model} (${model.orm}): ${fields}`;
}

/** Products the detector never inventories: Postgres and generic relational schemas. */
const NEVER_INVENTORIED = new Set(['postgres', 'relational']);

export const ormDetector: Detector = {
  name: 'orm',
  async detect(ctx: DetectorContext): Promise<Detection[]> {
    const models = await extractOrmModels(ctx);

    // Schema files name a product but no instance — default bucket (2.3 rule).
    const byProduct = new Map<string, Detection>();
    for (const model of models) {
      if (NEVER_INVENTORIED.has(model.product)) continue;
      let detection = byProduct.get(model.product);
      if (!detection) {
        detection = {
          store: {
            id: `${model.product}:default`,
            product: model.product,
            category: productCategories(model.product),
            evidence: [],
          },
          identity: { kind: 'default' },
        };
        byProduct.set(model.product, detection);
      }
      const evidence: Evidence = {
        kind: 'orm-schema',
        file: model.file,
        line: model.line,
        excerpt: renderModelExcerpt(model),
      };
      detection.store.evidence.push(evidence);
    }

    return [...byProduct.values()];
  },
};
