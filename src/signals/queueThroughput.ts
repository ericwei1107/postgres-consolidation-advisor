import { parseAllDocuments } from 'yaml';
import { COMPOSE_GLOBS } from '../detectors/compose.js';
import type { DetectorContext } from '../detectors/types.js';
import { loadConstants } from '../rules.js';
import { scanFiles, toRelPosix } from '../scan.js';
import type { DetectedStore, Evidence } from '../types.js';
import { fileImports, lineAt, readRepoFile, readSourceFiles } from './sourceScan.js';
import type { Signal } from './types.js';

/**
 * queueThroughput (PLAN.md 4.3) — est_peak = replicas x concurrency x [A1
 * range]. Neither number is captured by the Stage 2/3 detectors as-is:
 * `deploy.replicas` in compose.ts only attaches to services whose IMAGE
 * matches a known product (the queue's own container), never to the worker
 * service that actually consumes it; framework concurrency
 * (`concurrency: 10`, `worker_concurrency = 8`) is config the Stage 3.1
 * harvester was never designed to capture. This module re-scans both,
 * scoped to the services/files related to the given store.
 */

interface ComposeService {
  name: string;
  file: string;
  replicas?: number;
  replicasLine?: number;
  dependsOn: string[];
  envValues: string[];
  command?: string;
}

function commandString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string').join(' ');
  return undefined;
}

function dependsOnList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>);
  return [];
}

function envValueList(environment: unknown): string[] {
  if (!environment) return [];
  if (Array.isArray(environment)) return environment.filter((e): e is string => typeof e === 'string');
  if (typeof environment === 'object') {
    return Object.entries(environment as Record<string, unknown>).map(
      ([k, v]) => `${k}=${v == null ? '' : String(v)}`,
    );
  }
  return [];
}

async function collectComposeServices(ctx: DetectorContext): Promise<ComposeService[]> {
  const files = await scanFiles(ctx.repoPath, COMPOSE_GLOBS, ctx.config);
  const services: ComposeService[] = [];
  for (const path of files) {
    const rel = toRelPosix(ctx.repoPath, path);
    const raw = readRepoFile(ctx, rel);
    if (raw === null) continue;
    let docs;
    try {
      docs = parseAllDocuments(raw);
    } catch {
      continue;
    }
    const rawLines = raw.split('\n');
    for (const doc of docs) {
      if (doc.errors.length > 0) continue;
      let js: unknown;
      try {
        js = doc.toJS({ maxAliasCount: 100 });
      } catch {
        continue;
      }
      const svcMap = (js as { services?: unknown })?.services;
      if (!svcMap || typeof svcMap !== 'object') continue;
      for (const [name, svcRaw] of Object.entries(svcMap as Record<string, unknown>)) {
        const svc = svcRaw as {
          deploy?: { replicas?: unknown };
          environment?: unknown;
          depends_on?: unknown;
          command?: unknown;
        };
        const replicasValue = svc?.deploy?.replicas;
        const replicas = typeof replicasValue === 'number' ? replicasValue : undefined;
        const replicasLineIdx = replicas !== undefined ? rawLines.findIndex((l) => l.includes('replicas:')) : -1;
        const command = commandString(svc?.command);
        services.push({
          name,
          file: rel,
          ...(replicas !== undefined ? { replicas } : {}),
          ...(replicasLineIdx !== -1 ? { replicasLine: replicasLineIdx + 1 } : {}),
          dependsOn: dependsOnList(svc?.depends_on),
          envValues: envValueList(svc?.environment),
          ...(command !== undefined ? { command } : {}),
        });
      }
    }
  }
  return services;
}

function isRelatedService(svc: ComposeService, storeLabel: string): boolean {
  if (svc.dependsOn.some((d) => d.toLowerCase() === storeLabel.toLowerCase())) return true;
  const hostRe = new RegExp(`(://|@)${storeLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?::|/|$)`, 'i');
  return svc.envValues.some((kv) => hostRe.test(kv.slice(kv.indexOf('=') + 1)));
}

interface ConcurrencySource {
  libraries: string[];
  pattern: RegExp;
}

// Concurrency config shapes for the queue frameworks named in PLAN.md §1.1's
// general estimation model. Values found are taken as the per-replica
// concurrent-worker-slot count that A1's jobs/sec range multiplies against.
const CONCURRENCY_SOURCES: ConcurrencySource[] = [
  { libraries: ['bullmq', 'bull', 'bee-queue'], pattern: /\bconcurrency\s*:\s*(\d+)/ },
  { libraries: ['celery'], pattern: /\bworker_concurrency\s*=\s*(\d+)\b/ },
  { libraries: ['sidekiq'], pattern: /\bconcurrency\s*:\s*(\d+)/ },
];

async function findConcurrency(ctx: DetectorContext): Promise<{ value: number; evidence: Evidence } | null> {
  const files = await readSourceFiles(ctx);
  let best: { value: number; evidence: Evidence } | null = null;
  for (const { file, raw } of files) {
    for (const source of CONCURRENCY_SOURCES) {
      if (!source.libraries.some((lib) => fileImports(raw, lib))) continue;
      const match = source.pattern.exec(raw);
      source.pattern.lastIndex = 0;
      const found = match?.[1] !== undefined ? Number(match[1]) : undefined;
      if (found === undefined) continue;
      if (best === null || found > best.value) {
        best = {
          value: found,
          evidence: { kind: 'call-site', file, line: lineAt(raw, match!.index), excerpt: match![0].trim() },
        };
      }
    }
  }
  return best;
}

/** Filename without extension, e.g. `src/worker.ts` -> `worker`. */
function fileStem(file: string): string {
  const base = file.split('/').pop() ?? file;
  return base.replace(/\.[^.]+$/, '');
}

export async function queueThroughput(store: DetectedStore, ctx: DetectorContext): Promise<Signal | null> {
  const storeLabel = store.id.slice(store.product.length + 1);

  const services = await collectComposeServices(ctx);
  const related = services.filter((s) => isRelatedService(s, storeLabel));
  if (related.length === 0) return null;

  const concurrency = await findConcurrency(ctx);
  if (concurrency === null) return null;

  const jobsPerSlot = loadConstants().get('general.est-peak-jobs-per-worker-slot');
  if (!jobsPerSlot || typeof jobsPerSlot.value !== 'object') return null;
  const { min: minJobsPerSec, max: maxJobsPerSec } = jobsPerSlot.value;

  // Several services can legitimately touch this store (an API server that
  // just uses it as a cache, say) without being the worker that consumes it.
  // When the concurrency evidence's file stem shows up in a related
  // service's command, narrow to that service — it's the actual consumer.
  // No match at all (e.g. a bare `build: .` with the entrypoint in a
  // Dockerfile we can't see) falls back to every related service.
  const stem = fileStem(concurrency.evidence.file);
  const stemMatched = related.filter((s) => s.command?.includes(stem));
  const attributed = stemMatched.length > 0 ? stemMatched : related;

  const replicas = attributed.reduce((sum, s) => sum + (s.replicas ?? 1), 0);

  const composeEvidence: Evidence[] = attributed.map((s) => ({
    kind: 'compose',
    file: s.file,
    ...(s.replicasLine !== undefined ? { line: s.replicasLine } : {}),
    excerpt: s.replicas !== undefined ? `replicas: ${s.replicas}` : `${s.name}: no deploy.replicas (defaults to 1)`,
  }));

  return {
    variable: 'est-peak-msgs-sec',
    value: { min: replicas * concurrency.value * minJobsPerSec, max: replicas * concurrency.value * maxJobsPerSec },
    observability: 'estimated',
    evidence: [...composeEvidence, concurrency.evidence],
  };
}
