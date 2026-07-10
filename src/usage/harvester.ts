import { readFileSync, statSync } from 'node:fs';
import { redactLine } from '../redact.js';
import { loadCallPatterns, type CallPatternRule } from '../rules.js';
import { scanFiles, toRelPosix } from '../scan.js';
import type { Evidence, DetectedStore } from '../types.js';
import type { DetectorContext } from '../detectors/types.js';

/** A call-site Evidence record plus the structured command needed by Stage 3.2. */
export interface UsageEvidence extends Evidence {
  storeId: string;
  command: string;
}

export interface HarvestOptions {
  /** Bound source-file work for unusually large repositories. */
  maxFiles?: number;
}

const SOURCE_GLOBS = ['**/*.{js,jsx,mjs,cjs,ts,tsx,py,rb,go}'];
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 5_000;
const MAX_CALLS_PER_STORE = 200;

interface ProductScope {
  rule: CallPatternRule;
  symbols: Set<string>;
}

interface Receiver {
  product: string;
  expression: string;
}

function excerpt(line: string): string {
  // A call-site line can embed a connection URL with credentials (PLAN.md 2.3
  // redaction rule applies to every Evidence surface, not just env files).
  const trimmed = redactLine(line.trim().replace(/\s+/g, ' '));
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Imported/required libraries and their local constructor symbols. */
function importScopes(raw: string, rules: CallPatternRule[]): Map<string, ProductScope> {
  const scopes = new Map<string, ProductScope>();
  for (const rule of rules) {
    const symbols = new Set<string>();
    let imported = false;
    for (const library of rule.libraries) {
      const escaped = escapeRegex(library);
      const pythonModule = escapeRegex(library.replaceAll('/', '.'));
      const jsFrom = new RegExp(`\\bimport\\s+([^;\\n]+?)\\s+from\\s+["']${escaped}["']`, 'g');
      for (const match of raw.matchAll(jsFrom)) {
        imported = true;
        const binding = match[1] ?? '';
        for (const name of binding.matchAll(/[A-Za-z_$][\w$]*/g)) {
          const value = name[0];
          if (!['as', 'type'].includes(value)) symbols.add(value);
        }
      }
      const jsRequire = new RegExp(
        `\\b(?:const|let|var)\\s+([^=;\\n]+?)\\s*=\\s*require\\s*\\(\\s*["']${escaped}["']\\s*\\)`,
        'g',
      );
      for (const match of raw.matchAll(jsRequire)) {
        imported = true;
        for (const name of (match[1] ?? '').matchAll(/[A-Za-z_$][\w$]*/g)) symbols.add(name[0]);
      }
      if (new RegExp(`\\b(?:import|require)\\s*(?:\\(|)[^\\n]*["']${escaped}["']`).test(raw)) imported = true;

      const pythonFrom = new RegExp(`^\\s*from\\s+${pythonModule}\\s+import\\s+(.+)$`, 'gm');
      for (const match of raw.matchAll(pythonFrom)) {
        imported = true;
        for (const part of (match[1] ?? '').split(',')) {
          const name = part.trim().match(/^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?/);
          if (name?.[1]) symbols.add(name[2] ?? name[1]);
        }
      }
      // `\b` keeps `import redispatcher` from counting as a redis import.
      const pythonImport = new RegExp(`^\\s*import\\s+${pythonModule}\\b(?:\\s+as\\s+([A-Za-z_]\\w*))?`, 'gm');
      for (const match of raw.matchAll(pythonImport)) {
        imported = true;
        symbols.add(match[1] ?? library.split(/[/-]/).pop() ?? library);
      }
      if (new RegExp(`^\\s*require\\s*["']${escaped}["']`, 'gm').test(raw)) imported = true;
    }
    if (imported) scopes.set(rule.product, { rule, symbols });
  }
  return scopes;
}

function assignmentExpressions(raw: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of raw.matchAll(/(?:^|\n)\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g)) {
    if (match[1] && match[2]) values.set(match[1], match[2]);
  }
  return values;
}

function expandExpression(expression: string, assignments: Map<string, string>): string {
  let result = expression;
  for (let i = 0; i < 3; i++) {
    const next = result.replace(/\b[A-Za-z_$][\w$]*\b/g, (name) => assignments.get(name) ?? name);
    if (next === result) break;
    result = next;
  }
  return result;
}

/**
 * Resolve a construction/factory callee path to a product via its imported
 * symbols: the last segment (`new Redis(` / destructured `createClient(`),
 * the full path, or — for dotted paths — the root module symbol, which is how
 * Python (`redis.Redis(...)`) and namespace imports (`new Redis.Cluster(...)`)
 * spell it.
 */
function productForCallee(path: string, symbolProduct: Map<string, string>): string | undefined {
  const segments = path.split('.');
  return (
    symbolProduct.get(segments[segments.length - 1] ?? '') ??
    symbolProduct.get(path) ??
    (segments.length > 1 ? symbolProduct.get(segments[0] ?? '') : undefined)
  );
}

const RECEIVER_PATTERNS = [
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$.]*)\s*\(/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$.]*)\s*\(/g,
  /(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+)?([A-Za-z_$][\w$.]*)\s*\(/g,
];

function receiversFor(
  raw: string,
  scopes: Map<string, ProductScope>,
  assignments: Map<string, string>,
): Map<string, Receiver> {
  const receivers = new Map<string, Receiver>();
  const symbolProduct = new Map<string, string>();
  for (const [product, scope] of scopes) for (const symbol of scope.symbols) symbolProduct.set(symbol, product);

  for (const pattern of RECEIVER_PATTERNS) {
    for (const match of raw.matchAll(pattern)) {
      const target = match[1];
      const product = productForCallee(match[2] ?? '', symbolProduct);
      if (target && product) receivers.set(target, { product, expression: assignments.get(target) ?? match[0] ?? '' });
    }
  }

  // Propagate through collection/database objects and Kafka producer/consumer factories.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const [target, rhs] of assignments) {
      if (receivers.has(target)) continue;
      const source = rhs.match(/^([A-Za-z_$][\w$]*)\s*(?:\.|\[)/)?.[1];
      const parent = source ? receivers.get(source) : undefined;
      if (parent) {
        receivers.set(target, { product: parent.product, expression: rhs });
        changed = true;
      }
    }
    if (!changed) break;
  }
  return receivers;
}

function storeFor(product: string, expression: string, stores: DetectedStore[]): DetectedStore | undefined {
  const candidates = stores.filter((store) => store.product === product);
  if (candidates.length === 1) return candidates[0];
  const expanded = expression.toLowerCase();
  for (const store of candidates) {
    const label = store.id.slice(`${product}:`.length).toLowerCase();
    if (label !== 'default' && expanded.includes(label)) return store;
  }
  return candidates.find((store) => store.id === `${product}:default`);
}

function commandAt(line: string, index: number): { receiver?: string; command: string } | undefined {
  const before = line.slice(0, index);
  const receiver = before.match(/([A-Za-z_$][\w$]*)\s*$/)?.[1];
  const remainder = line.slice(index);
  const method = remainder.match(/^\.([A-Za-z_$][\w$]*)\s*\(/)?.[1];
  if (method) return { receiver, command: method };
  const constructor = remainder.match(/^(?:new\s+)?([A-Za-z_$][\w$]*)\s*\(/)?.[1];
  return constructor ? { command: constructor } : undefined;
}

/** A bare constructor call (`new Queue(...)`) counts as a call site when the product's rules say so. */
function isConstructorCommand(command: string, scope: ProductScope): boolean {
  return scope.symbols.has(command) && scope.rule.constructors.has(command.toLowerCase());
}

/**
 * Scan source once and append bounded call-site Evidence to the matching stores.
 * Files without a known client-library import are ignored before command regexes run.
 */
export async function harvestUsage(
  stores: DetectedStore[],
  ctx: DetectorContext,
  options: HarvestOptions = {},
): Promise<UsageEvidence[]> {
  const allFiles = await scanFiles(ctx.repoPath, SOURCE_GLOBS, ctx.config);
  const limit = options.maxFiles;
  const files = limit === undefined ? allFiles : allFiles.slice(0, limit);
  if (limit !== undefined && allFiles.length > files.length) {
    ctx.addWarning(`usage harvester stopped after ${limit} files (--max-files)`);
  }

  const usage: UsageEvidence[] = [];
  const byStore = new Map(stores.map((store) => [store.id, 0]));
  const rules = loadCallPatterns();

  for (const file of files) {
    const rel = toRelPosix(ctx.repoPath, file);
    let raw: string;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) {
        ctx.addWarning(`usage harvester skipped ${rel}: file exceeds 1 MB`);
        continue;
      }
      const bytes = readFileSync(file);
      if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
        ctx.addWarning(`usage harvester skipped ${rel}: UTF-16 source is not supported`);
        continue;
      }
      raw = bytes.toString('utf8').replace(/^\uFEFF/, '');
    } catch (e) {
      ctx.addWarning(`usage harvester skipped ${rel}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (raw.slice(0, 4096).includes('\0')) {
      ctx.addWarning(`usage harvester skipped ${rel}: binary source`);
      continue;
    }
    const lines = raw.split('\n');
    if (lines.some((line) => line.length > MAX_LINE_CHARS)) {
      ctx.addWarning(`usage harvester skipped ${rel}: line exceeds 5k characters`);
      continue;
    }

    const analysisRaw = lines
      .map((line) => (/^\s*(?:\/\/|#)/.test(line) ? '' : line))
      .join('\n');
    const scopes = importScopes(analysisRaw, rules);
    if (scopes.size === 0) continue;
    const assignments = assignmentExpressions(analysisRaw);
    const receivers = receiversFor(analysisRaw, scopes, assignments);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex] ?? '';
      if (/^\s*(?:\/\/|#)/.test(line)) continue;
      for (const [product, scope] of scopes) {
        for (const pattern of scope.rule.patterns) {
          pattern.lastIndex = 0;
          for (const match of line.matchAll(pattern)) {
            const location = commandAt(line, match.index ?? 0);
            const command = match[1] ?? location?.command;
            if (!command) continue;
            const receiver = location?.receiver ? receivers.get(location.receiver) : undefined;
            const tracked = receiver?.product === product;
            const constructor = isConstructorCommand(command, scope);
            if (!tracked && !constructor) continue;

            const expression = receiver
              ? expandExpression(receiver.expression, assignments)
              : line;
            const store = storeFor(product, expression, stores);
            if (!store || (byStore.get(store.id) ?? 0) >= MAX_CALLS_PER_STORE) continue;
            const evidence: UsageEvidence = {
              storeId: store.id,
              command,
              kind: 'call-site',
              file: rel,
              line: lineIndex + 1,
              excerpt: excerpt(line),
            };
            usage.push(evidence);
            store.evidence.push({ kind: evidence.kind, file: evidence.file, line: evidence.line, excerpt: evidence.excerpt });
            byStore.set(store.id, (byStore.get(store.id) ?? 0) + 1);
          }
        }
      }
    }
  }
  return usage;
}
