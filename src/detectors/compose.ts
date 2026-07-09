import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';
import { redactedAssignment } from '../redact.js';
import { matchImage, type ProductRule } from '../rules.js';
import { scanFiles, toRelPosix } from '../scan.js';
import type { Evidence } from '../types.js';
import type { Detection, Detector, DetectorContext } from './types.js';

/**
 * docker-compose / k8s / Helm manifest detector (PLAN.md 2.1).
 *
 * Emits one DetectedStore per service/container whose image matches a product in
 * rules/products.yaml. Cross-file/cross-detector dedup by instance identity is
 * Stage 2.3 — here each matching service is its own store. Postgres images do not
 * match the product table by design (it is the consolidation target).
 */

const COMPOSE_GLOBS = [
  '**/docker-compose*.yml',
  '**/docker-compose*.yaml',
  '**/compose.yml',
  '**/compose.yaml',
];
const K8S_GLOBS = ['**/k8s/**/*.yml', '**/k8s/**/*.yaml'];

/** Resolve `image: ${VAR:-default}` interpolation to a concrete ref, or null. */
function resolveImage(image: string): { value: string; interpolated: boolean } | null {
  if (!image.includes('${')) return { value: image, interpolated: false };
  const withDefault = /\$\{[^:}]+:-([^}]+)\}/;
  const m = image.match(withDefault);
  if (!m || m[1] === undefined) return null; // no default → not statically knowable
  return { value: image.replace(withDefault, m[1]), interpolated: true };
}

function lineOf(rawLines: string[], needle: string, fromLine = 0): number | undefined {
  for (let i = fromLine; i < rawLines.length; i++) {
    if (rawLines[i]?.includes(needle)) return i + 1;
  }
  return undefined;
}

function envPairs(environment: unknown): [string, string][] {
  if (!environment) return [];
  if (Array.isArray(environment)) {
    return environment
      .filter((e): e is string => typeof e === 'string')
      .map((e) => {
        const idx = e.indexOf('=');
        return idx === -1 ? ([e, ''] as [string, string]) : ([e.slice(0, idx), e.slice(idx + 1)] as [string, string]);
      });
  }
  if (typeof environment === 'object') {
    return Object.entries(environment as Record<string, unknown>).map(
      ([k, v]) => [k, v == null ? '' : String(v)] as [string, string],
    );
  }
  return [];
}

function detectionFromMatch(
  rule: ProductRule,
  serviceName: string | undefined,
  evidence: Evidence[],
): Detection {
  return {
    store: {
      id: `${rule.product}:${serviceName ?? 'default'}`,
      product: rule.product,
      category: [...rule.category],
      evidence,
    },
    // k8s manifests carry no compose-style service identity → default bucket.
    identity: serviceName !== undefined ? { kind: 'service', name: serviceName } : { kind: 'default' },
  };
}

function parseCompose(file: string, rel: string, raw: string, ctx: DetectorContext): Detection[] {
  let docs;
  try {
    docs = parseAllDocuments(raw);
  } catch (e) {
    ctx.addWarning(`skipped ${rel}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  const rawLines = raw.split('\n');
  const detections: Detection[] = [];

  for (const doc of docs) {
    if (doc.errors.length > 0) {
      ctx.addWarning(`skipped ${rel}: ${doc.errors[0]?.message ?? 'YAML parse error'}`);
      continue;
    }
    let js: unknown;
    try {
      // maxAliasCount here is the billion-laughs guard: alias expansion (not
      // parsing) is the amplification step, and it happens in toJS.
      js = doc.toJS({ maxAliasCount: 100 });
    } catch (e) {
      ctx.addWarning(`skipped ${rel}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const services = (js as { services?: unknown })?.services;
    if (!services || typeof services !== 'object') continue;

    for (const [name, svcRaw] of Object.entries(services as Record<string, unknown>)) {
      const svc = svcRaw as { image?: unknown; deploy?: { replicas?: unknown }; environment?: unknown };
      if (typeof svc?.image !== 'string') continue;

      const resolved = resolveImage(svc.image);
      if (!resolved) continue;
      const rule = matchImage(resolved.value);
      if (!rule) continue;

      const evidence: Evidence[] = [];
      const imageLine = lineOf(rawLines, resolved.value) ?? lineOf(rawLines, name);
      evidence.push({
        kind: 'compose',
        file: rel,
        ...(imageLine ? { line: imageLine } : {}),
        excerpt: resolved.interpolated ? `image: ${svc.image}` : `image: ${resolved.value}`,
      });

      const replicas = svc.deploy?.replicas;
      if (replicas != null) {
        const rLine = lineOf(rawLines, 'replicas:');
        evidence.push({
          kind: 'compose',
          file: rel,
          ...(rLine ? { line: rLine } : {}),
          excerpt: `replicas: ${String(replicas)}`,
        });
      }

      for (const [k, v] of envPairs(svc.environment)) {
        const eLine = lineOf(rawLines, `${k}:`) ?? lineOf(rawLines, `${k}=`);
        evidence.push({
          kind: 'compose',
          file: rel,
          ...(eLine ? { line: eLine } : {}),
          excerpt: redactedAssignment(k, v),
        });
      }

      detections.push(detectionFromMatch(rule, name, evidence));
    }
  }
  return detections;
}

/** Recursively collect container `image:` refs from a k8s manifest node. */
function collectK8sImages(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectK8sImages(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'image' && typeof value === 'string') out.push(value);
      else collectK8sImages(value, out);
    }
  }
}

function parseK8s(file: string, rel: string, raw: string, ctx: DetectorContext): Detection[] {
  let docs;
  try {
    docs = parseAllDocuments(raw);
  } catch (e) {
    ctx.addWarning(`skipped ${rel}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  const rawLines = raw.split('\n');
  const detections: Detection[] = [];
  const seen = new Set<string>();

  for (const doc of docs) {
    if (doc.errors.length > 0) {
      ctx.addWarning(`skipped ${rel}: ${doc.errors[0]?.message ?? 'YAML parse error'}`);
      continue;
    }
    const images: string[] = [];
    let js: unknown;
    try {
      js = doc.toJS({ maxAliasCount: 100 });
    } catch (e) {
      ctx.addWarning(`skipped ${rel}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    collectK8sImages(js, images);
    for (const image of images) {
      const resolved = resolveImage(image);
      if (!resolved) continue;
      const rule = matchImage(resolved.value);
      if (!rule) continue;
      const key = `${rule.product}:${resolved.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = lineOf(rawLines, resolved.value);
      detections.push(
        detectionFromMatch(rule, undefined, [
          {
            kind: 'compose',
            file: rel,
            ...(line ? { line } : {}),
            excerpt: `image: ${resolved.value}`,
          },
        ]),
      );
    }
  }
  return detections;
}

export const composeDetector: Detector = {
  name: 'compose',
  async detect(ctx: DetectorContext): Promise<Detection[]> {
    // Helm: Go-templated YAML under templates/ can't be parsed as plain YAML.
    // Skip it wholesale with a single warning when a Chart.yaml is present.
    const charts = await scanFiles(ctx.repoPath, ['**/Chart.yaml'], ctx.config);
    const helmIgnore = charts.length > 0 ? ['**/templates/**'] : [];
    if (charts.length > 0) ctx.addWarning('Helm templates skipped (unsupported)');

    const composeFiles = await scanFiles(ctx.repoPath, COMPOSE_GLOBS, ctx.config, helmIgnore);
    const k8sFiles = await scanFiles(ctx.repoPath, K8S_GLOBS, ctx.config, helmIgnore);

    const detections: Detection[] = [];
    for (const file of composeFiles) {
      const rel = toRelPosix(ctx.repoPath, file);
      detections.push(...parseCompose(file, rel, readFileSync(file, 'utf8'), ctx));
    }
    for (const file of k8sFiles) {
      const rel = toRelPosix(ctx.repoPath, file);
      detections.push(...parseK8s(file, rel, readFileSync(file, 'utf8'), ctx));
    }
    return detections;
  },
};
