import { readFileSync } from 'node:fs';
import {
  loadBrokerSchemes,
  loadClientLibraries,
  productCategories,
  type ClientLibraryRule,
} from '../rules.js';
import { scanFiles, toRelPosix } from '../scan.js';
import type { DetectedStore, Evidence, StoreCategory } from '../types.js';
import type { Detector, DetectorContext } from './types.js';

/**
 * Dependency-manifest detector (PLAN.md 2.2).
 *
 * Reads package.json / requirements.txt / pyproject.toml / Gemfile / go.mod,
 * maps dependency names to products via `client_libraries` in
 * rules/products.yaml, and emits DetectedStore with `dependency` Evidence.
 * Commented-out lines never produce a detection. Postgres client libraries are
 * recognized and skipped (consolidation target, never inventoried).
 *
 * Celery broker rule: only a LITERAL broker URL in Python config resolves to a
 * product (scheme → `broker_schemes`); env-var/settings indirection or absent
 * config yields the `unknown-broker` pseudo-product — never a guess. Role
 * confidence for `unknown-broker` is capped `low` downstream (Stage 3).
 */

/** One matched dependency line in a manifest. */
interface DepHit {
  name: string;
  line: number;
  excerpt: string;
}

/** PEP 503 name normalization: lowercase, runs of `-_.` collapse to `-`. */
function normalizePypi(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

type Ecosystem = 'npm' | 'pypi' | 'gem' | 'go';

function lookupLibrary(name: string, ecosystem: Ecosystem): ClientLibraryRule | undefined {
  const libs = loadClientLibraries();
  switch (ecosystem) {
    case 'pypi':
      return libs.get(normalizePypi(name));
    case 'go': {
      const lower = name.toLowerCase();
      // Go major versions live in the import path (…/go-redis/v9).
      return libs.get(lower) ?? libs.get(lower.replace(/\/v\d+$/, ''));
    }
    default:
      return libs.get(name.toLowerCase());
  }
}

// --- per-format parsers (each returns raw hits; product lookup happens later) ---

const PACKAGE_JSON_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** Throws on malformed JSON — caller turns that into a skip+warning. */
function parsePackageJson(raw: string): DepHit[] {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const rawLines = raw.split('\n');
  const hits: DepHit[] = [];
  for (const section of PACKAGE_JSON_SECTIONS) {
    const deps = parsed[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
      const idx = rawLines.findIndex((l) => l.includes(`"${name}"`) && l.includes(':'));
      hits.push({
        name,
        line: idx + 1, // 0 (not found) becomes line 1; findIndex miss is near-impossible here
        excerpt: `"${name}": "${String(version)}"`,
      });
    }
  }
  return hits;
}

function parseRequirementsTxt(raw: string): DepHit[] {
  const hits: DepHit[] = [];
  raw.split('\n').forEach((line, i) => {
    let t = line.trim();
    if (t === '' || t.startsWith('#') || t.startsWith('-')) return; // comments, -r/-e/--options
    const hash = t.search(/\s#/);
    if (hash !== -1) t = t.slice(0, hash).trim();
    const m = t.match(/^([A-Za-z0-9._-]+)/);
    if (m?.[1]) hits.push({ name: m[1], line: i + 1, excerpt: t });
  });
  return hits;
}

const PYPROJECT_ARRAY_SECTIONS = /^(project|project\.optional-dependencies|dependency-groups)$/;
const PYPROJECT_TABLE_SECTIONS = /^tool\.poetry(\.group\.[^.\]]+)?\.(dev-)?dependencies$/;

/** Line-based TOML reading (no TOML parser in the fixed dependency set). */
function parsePyprojectToml(raw: string): DepHit[] {
  const hits: DepHit[] = [];
  let section = '';
  let inDepsArray = false;

  raw.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) return;

    const sec = t.match(/^\[([^\]]+)\]/);
    if (sec?.[1]) {
      section = sec[1].trim();
      inDepsArray = false;
      return;
    }

    const excerpt = t.replace(/,\s*$/, '');

    if (PYPROJECT_ARRAY_SECTIONS.test(section)) {
      if (!inDepsArray) {
        // `dependencies = [` in [project]; any `name = [` in the extras/groups tables.
        const opensArray =
          section === 'project' ? /^dependencies\s*=\s*\[/.test(t) : /^[\w."'-]+\s*=\s*\[/.test(t);
        if (!opensArray) return;
        inDepsArray = true;
      }
      for (const m of t.matchAll(/["']([A-Za-z0-9._-]+)[^"']*["']/g)) {
        if (m[1]) hits.push({ name: m[1], line: i + 1, excerpt });
      }
      if (t.includes(']')) inDepsArray = false;
      return;
    }

    if (PYPROJECT_TABLE_SECTIONS.test(section)) {
      const m = t.match(/^([A-Za-z0-9._-]+)\s*=/);
      if (m?.[1] && m[1].toLowerCase() !== 'python') {
        hits.push({ name: m[1], line: i + 1, excerpt });
      }
    }
  });
  return hits;
}

function parseGemfile(raw: string): DepHit[] {
  const hits: DepHit[] = [];
  raw.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('#')) return;
    const m = t.match(/^gem\s+["']([^"']+)["']/);
    if (m?.[1]) hits.push({ name: m[1], line: i + 1, excerpt: t });
  });
  return hits;
}

function parseGoMod(raw: string): DepHit[] {
  const hits: DepHit[] = [];
  let inRequire = false;
  raw.split('\n').forEach((line, i) => {
    const commentIdx = line.indexOf('//');
    const code = (commentIdx === -1 ? line : line.slice(0, commentIdx)).trim();
    if (code === '') return;
    if (!inRequire && /^require\s*\(/.test(code)) {
      inRequire = true;
      return;
    }
    if (inRequire && code === ')') {
      inRequire = false;
      return;
    }
    const m = inRequire ? code.match(/^(\S+)\s+v\S+$/) : code.match(/^require\s+(\S+)\s+v\S+$/);
    if (m?.[1]) hits.push({ name: m[1], line: i + 1, excerpt: code });
  });
  return hits;
}

interface ManifestKind {
  glob: string;
  ecosystem: Ecosystem;
  parse: (raw: string) => DepHit[];
}

const MANIFESTS: ManifestKind[] = [
  { glob: '**/package.json', ecosystem: 'npm', parse: parsePackageJson },
  { glob: '**/requirements.txt', ecosystem: 'pypi', parse: parseRequirementsTxt },
  { glob: '**/pyproject.toml', ecosystem: 'pypi', parse: parsePyprojectToml },
  { glob: '**/Gemfile', ecosystem: 'gem', parse: parseGemfile },
  { glob: '**/go.mod', ecosystem: 'go', parse: parseGoMod },
];

/**
 * Resolve the Celery broker product from Python config. Matches literal
 * `broker=` / `broker_url=` / CELERY_BROKER_URL assignments with a quoted URL;
 * anything else (indirection, no config) → `unknown-broker`.
 */
const LITERAL_BROKER_RE = /\b(?:celery_)?broker(?:_url)?\s*=\s*["']([a-z][a-z0-9+.-]*):\/\//i;

async function resolveCeleryBroker(ctx: DetectorContext): Promise<string> {
  const schemes = loadBrokerSchemes();
  const pyFiles = await scanFiles(ctx.repoPath, ['**/*.py'], ctx.config);
  for (const file of pyFiles) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const m = raw.match(LITERAL_BROKER_RE);
    if (m?.[1]) return schemes[m[1].toLowerCase()] ?? 'unknown-broker';
  }
  return 'unknown-broker';
}

export const dependenciesDetector: Detector = {
  name: 'dependencies',
  async detect(ctx: DetectorContext): Promise<DetectedStore[]> {
    // One store per (manifest file, product); merging across files/detectors
    // by instance identity is Stage 2.3.
    const stores = new Map<string, DetectedStore>();
    let brokerProduct: string | undefined; // resolved lazily, once per repo

    const add = (rel: string, product: string, categories: StoreCategory[], ev: Evidence) => {
      const key = `${rel}\0${product}`;
      let store = stores.get(key);
      if (!store) {
        store = { id: `${product}:${rel}`, product, category: [], evidence: [] };
        stores.set(key, store);
      }
      for (const c of categories) {
        if (!store.category.includes(c)) store.category.push(c);
      }
      store.evidence.push(ev);
    };

    for (const manifest of MANIFESTS) {
      const files = await scanFiles(ctx.repoPath, [manifest.glob], ctx.config);
      for (const file of files) {
        const rel = toRelPosix(ctx.repoPath, file);
        let hits: DepHit[];
        try {
          hits = manifest.parse(readFileSync(file, 'utf8'));
        } catch (e) {
          ctx.addWarning(`skipped ${rel}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }

        for (const hit of hits) {
          const rule = lookupLibrary(hit.name, manifest.ecosystem);
          if (!rule) continue;

          let product: string;
          if (rule.brokerFromConfig) {
            brokerProduct ??= await resolveCeleryBroker(ctx);
            product = brokerProduct;
          } else {
            product = rule.product as string; // schema guarantees product when not brokerFromConfig
          }
          if (product === 'postgres') continue;

          add(rel, product, rule.category ?? productCategories(product), {
            kind: 'dependency',
            file: rel,
            ...(hit.line > 0 ? { line: hit.line } : {}),
            excerpt: hit.excerpt,
          });
        }
      }
    }

    return [...stores.values()];
  },
};
