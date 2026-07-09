import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { redactValue, redactedAssignment } from '../redact.js';
import { loadEnvVars, loadUrlSchemes, productCategories } from '../rules.js';
import { scanFiles, toRelPosix } from '../scan.js';
import type { Evidence } from '../types.js';
import type { Detection, Detector, DetectorContext, InstanceIdentity } from './types.js';

/**
 * Env/config detector (PLAN.md 2.3).
 *
 * Scans .env*, config/**, settings.py, and *.config.{js,ts} for two signals,
 * both driven by tables in rules/products.yaml:
 *  - known variable NAMES (`env_vars`: REDIS_URL, KAFKA_BROKERS, ...);
 *  - URL-shaped values with a known scheme (`url_schemes`), which also covers
 *    generic names (DATABASE_URL=mongodb://... → mongodb; =postgres://... →
 *    skipped, Postgres is the consolidation target).
 *
 * Identity is the URL host:port when the value yields one (compose DNS makes
 * the host equal the service name, which is how the merge layer unifies this
 * with compose detections); otherwise the product's default bucket.
 *
 * Secret redaction rule: every excerpt goes through redact.ts — variable name
 * kept, credentials always stripped, secret-named values dropped entirely.
 */

const ENV_GLOBS = ['**/.env*', '**/config/**', '**/settings.py', '**/*.config.{js,ts}'];

const MAX_FILE_BYTES = 1024 * 1024;

/** `NAME=value` / `NAME: value` / `export NAME="value"` — name in assignment position. */
const ASSIGNMENT_RE = /^\s*(?:export\s+)?["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]\s*(.*)$/;

const URL_RE = /([a-z][a-z0-9+.-]*):\/\/([^\s"'`,;)\]}]+)/gi;

/** `host:port` at the start of a value (KAFKA_BROKERS=broker1:9092,broker2:9092). */
const HOSTPORT_RE = /^([A-Za-z0-9._-]+):(\d{1,5})(?:[,\s]|$)/;

const BARE_HOST_RE = /^[A-Za-z0-9._-]+$/;

function stripQuotes(value: string): string {
  const t = value.trim().replace(/[,;]\s*$/, '');
  const m = t.match(/^(["'])(.*)\1$/);
  return m?.[2] ?? t;
}

/** host[:port] from a URL's authority part (credentials already possible — strip them). */
function hostportFromUrl(rest: string): InstanceIdentity {
  const authority = (rest.split(/[/?#]/, 1)[0] ?? '').split('@').pop() ?? '';
  const m = authority.match(/^([A-Za-z0-9._-]+)(?::(\d{1,5}))?$/);
  if (!m?.[1]) return { kind: 'default' };
  return { kind: 'hostport', host: m[1], ...(m[2] ? { port: m[2] } : {}) };
}

interface LineHit {
  product: string;
  identity: InstanceIdentity;
  excerpt: string;
}

/** All store signals on one line. At most one hit per product per line. */
function scanLine(line: string): LineHit[] {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) return [];

  const envVars = loadEnvVars();
  const urlSchemes = loadUrlSchemes();
  const hits = new Map<string, LineHit>();

  const assignment = trimmed.match(ASSIGNMENT_RE);
  const name = assignment?.[1];
  const value = assignment ? stripQuotes(assignment[2] ?? '') : '';

  // Signal 1: known variable name.
  const namedProduct = name ? envVars.get(name.toUpperCase()) : undefined;
  if (name && namedProduct) {
    let identity: InstanceIdentity = { kind: 'default' };
    const url = [...value.matchAll(URL_RE)][0];
    const hostport = value.match(HOSTPORT_RE);
    if (url) identity = hostportFromUrl(url[2] ?? '');
    else if (hostport?.[1]) identity = { kind: 'hostport', host: hostport[1], port: hostport[2] };
    else if (name.toUpperCase().endsWith('_HOST') && BARE_HOST_RE.test(value)) {
      identity = { kind: 'hostport', host: value };
    }
    hits.set(namedProduct, { product: namedProduct, identity, excerpt: redactedAssignment(name, value) });
  }

  // Signal 2: URL-shaped values with a known scheme, anywhere on the line.
  for (const m of trimmed.matchAll(URL_RE)) {
    const product = urlSchemes.get((m[1] ?? '').toLowerCase());
    if (!product || hits.has(product)) continue;
    const fullUrl = m[0];
    const excerpt = name
      ? redactedAssignment(name, fullUrl)
      : redactValue('url', fullUrl);
    hits.set(product, { product, identity: hostportFromUrl(m[2] ?? ''), excerpt });
  }

  return [...hits.values()];
}

function identityKey(identity: InstanceIdentity): string {
  switch (identity.kind) {
    case 'service':
      return `svc:${identity.name}`;
    case 'hostport':
      return `net:${identity.host}${identity.port ? `:${identity.port}` : ''}`;
    case 'default':
      return 'default';
  }
}

function looksBinary(raw: string): boolean {
  return raw.slice(0, 4096).includes('\0');
}

/** Compose files under config/ belong to the compose detector, not this one. */
function isComposeFile(file: string): boolean {
  return /^(docker-)?compose[.-].*\.ya?ml$|^docker-compose\.ya?ml$/.test(basename(file));
}

export const envDetector: Detector = {
  name: 'env',
  async detect(ctx: DetectorContext): Promise<Detection[]> {
    const files = (await scanFiles(ctx.repoPath, ENV_GLOBS, ctx.config)).filter(
      (f) => !isComposeFile(f),
    );

    // One detection per (product, identity) accumulated across all files.
    const detections = new Map<string, Detection>();

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

      raw.split('\n').forEach((line, i) => {
        for (const hit of scanLine(line)) {
          if (hit.product === 'postgres') continue;

          const key = `${hit.product}\0${identityKey(hit.identity)}`;
          let detection = detections.get(key);
          if (!detection) {
            detection = {
              store: {
                id: `${hit.product}:${identityKey(hit.identity)}`,
                product: hit.product,
                category: productCategories(hit.product),
                evidence: [],
              },
              identity: hit.identity,
            };
            detections.set(key, detection);
          }
          const evidence: Evidence = { kind: 'env', file: rel, line: i + 1, excerpt: hit.excerpt };
          const dup = detection.store.evidence.some(
            (e) => e.file === evidence.file && e.line === evidence.line && e.excerpt === evidence.excerpt,
          );
          if (!dup) detection.store.evidence.push(evidence);
        }
      });
    }

    return [...detections.values()];
  },
};
