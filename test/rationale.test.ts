import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildVerdictRules, computeVerdict } from '../src/scoring/index.js';
import { renderRationale } from '../src/scoring/rationale.js';
import { thresholdById } from '../src/rules.js';
import type { Signal } from '../src/signals/types.js';
import type { Evidence, StoreCategory, StoreRole, Verdict } from '../src/types.js';

/**
 * Rationale templating (PLAN.md 5.2). Every case below drives `computeVerdict`
 * to an actual `keep` decision through the real gate/threshold data in
 * rules/thresholds.yaml — these are not hand-written strings, so a change to
 * the yaml or the template shows up here.
 */

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');
const BANNED_WORDS = ['probably', 'likely', 'vibe'];

function ev(file: string, excerpt: string, line = 1): Evidence {
  return { kind: 'call-site', file, line, excerpt };
}

function role(storeId: string, category: StoreCategory, evidence: Evidence[] = []): StoreRole {
  return { storeId, role: category, confidence: 'high', classifiedBy: 'rule', evidence };
}

function signal(variable: string, value: Signal['value'], observability: Signal['observability'], evidence: Evidence[] = []): Signal {
  return { variable, value, observability, evidence };
}

function assertCleanKeep(v: Verdict, storeId: string): void {
  expect(v.decision).toBe('keep');
  expect(v.rationale).toMatch(new RegExp(`^Keep ${storeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — `));
  expect(v.rationale).toContain(`Postgres alternative ${v.postgresEquivalent} would still pay this cost:`);
  expect(v.rationale).toMatch(/Evidence: \S+\.$/);
  for (const word of BANNED_WORDS) expect(v.rationale.toLowerCase()).not.toContain(word);
}

describe('rationale templating — keep path per category (done-conditions for 5.2)', () => {
  it('cache: Redis-native-structures gate', () => {
    const storeId = 'redis:leaderboard';
    const r = role(storeId, 'cache', [ev('src/scores.ts', 'redis.zadd(key, score, member)')]);
    const signals = [signal('command-mix-plain-kv-share', 0.4, 'static', r.evidence)];
    const v = computeVerdict(r, signals, buildVerdictRules('cache'));
    assertCleanKeep(v, storeId);
    expect(v.rationale).toMatchSnapshot();
  });

  it('cache: fan-out-calls-per-request bands keep (A9)', () => {
    const storeId = 'redis:feed';
    const evidence = Array.from({ length: 12 }, (_, i) => ev('src/feed.ts', `redis.get(k${i})`, i + 1));
    const r = role(storeId, 'cache', evidence);
    const signals = [signal('fan-out-calls-per-request', 12, 'estimated', evidence)];
    const v = computeVerdict(r, signals, buildVerdictRules('cache'));
    assertCleanKeep(v, storeId);
    expect(v.rationale).toMatchSnapshot();
  });

  it('queue: est-peak-msgs-sec bands keep', () => {
    const storeId = 'kafka:events';
    const evidence = [ev('docker-compose.yml', 'deploy.replicas: 50')];
    const r = role(storeId, 'queue', evidence);
    const signals = [signal('est-peak-msgs-sec', { min: 15000, max: 20000 }, 'estimated', evidence)];
    const v = computeVerdict(r, signals, buildVerdictRules('queue'));
    assertCleanKeep(v, storeId);
    expect(v.rationale).toMatchSnapshot();
  });

  it('search: log-analytics gate', () => {
    const storeId = 'elasticsearch:logs';
    const evidence = [ev('src/logs.ts', 'daily-index naming pattern detected')];
    const r = role(storeId, 'search', evidence);
    const signals = [signal('log-analytics-signal-count', 1, 'static', evidence)];
    const v = computeVerdict(r, signals, buildVerdictRules('search'));
    assertCleanKeep(v, storeId);
    expect(v.rationale).toMatchSnapshot();
  });

  it('document: field-level-update gate ($inc on a multi-KB doc)', () => {
    const storeId = 'mongodb:profiles';
    const evidence = [ev('app/documents.py', 'db.profiles.update_one({}, {"$inc": {"views": 1}})')];
    const r = role(storeId, 'document', evidence);
    const signals = [
      signal('field-level-mutator-count', 1, 'static', evidence),
      signal('avg-doc-size-bytes', 4096, 'estimated', evidence),
    ];
    const v = computeVerdict(r, signals, buildVerdictRules('document'));
    assertCleanKeep(v, storeId);
    expect(v.rationale).toMatchSnapshot();
  });

  it('document: change-streams gate (.watch( in harvested evidence)', () => {
    const storeId = 'mongodb:orders';
    const evidence = [ev('app/orders.py', 'db.orders.watch()')];
    const r = role(storeId, 'document', evidence);
    const v = computeVerdict(r, [], buildVerdictRules('document'));
    assertCleanKeep(v, storeId);
    expect(v.rationale).toMatchSnapshot();
  });

  it('vector: count-vectors bands keep', () => {
    const storeId = 'pinecone:embeddings';
    const evidence = [ev('src/vectors.ts', 'index.upsert(vectors)')];
    const r = role(storeId, 'vector', evidence);
    const signals = [signal('count-vectors', { min: 150000000, max: 200000000 }, 'estimated', evidence)];
    const v = computeVerdict(r, signals, buildVerdictRules('vector'));
    assertCleanKeep(v, storeId);
    expect(v.rationale).toMatchSnapshot();
  });

  it('timeseries: ingest-rows-per-sec bands keep', () => {
    const storeId = 'influxdb:metrics';
    const evidence = [ev('config/ingest.yml', 'devices: 20000000')];
    const r = role(storeId, 'timeseries', evidence);
    const signals = [signal('ingest-rows-per-sec', 750000, 'estimated', evidence)];
    const v = computeVerdict(r, signals, buildVerdictRules('timeseries'));
    assertCleanKeep(v, storeId);
    expect(v.rationale).toMatchSnapshot();
  });

  it('olap: scanned-data-size-gb bands keep', () => {
    const storeId = 'clickhouse:warehouse';
    const evidence = [ev('dbt/models/fact_events.sql', 'select * from raw_events')];
    const r = role(storeId, 'olap', evidence);
    const signals = [signal('scanned-data-size-gb', 5000, 'estimated', evidence)];
    const v = computeVerdict(r, signals, buildVerdictRules('olap'));
    assertCleanKeep(v, storeId);
    expect(v.rationale).toMatchSnapshot();
  });

  it('graph: variable-length-or-gds gate', () => {
    const storeId = 'neo4j:social';
    const evidence = [ev('src/graph.ts', 'MATCH (a)-[:FOLLOWS*1..]->(b) RETURN b')];
    const r = role(storeId, 'graph', evidence);
    const signals = [signal('variable-length-traversal-count', 1, 'static', evidence)];
    const v = computeVerdict(r, signals, buildVerdictRules('graph'));
    assertCleanKeep(v, storeId);
    expect(v.rationale).toMatchSnapshot();
  });

  // geospatial.niche-nondb-features-gate has no signal extractor yet (tile-
  // rendering-pipeline detection doesn't exist in Stage 4.3 — an honest gap,
  // same class as the other unwired gates documented in verdict.ts's
  // GATE_CHECKERS comment), so computeVerdict can never reach this decision
  // today. This exercises the TEMPLATE directly against the category's real
  // threshold data instead, so the rendering is still covered.
  it('geospatial: renders the keep template from real threshold data (gate not yet wired)', () => {
    const threshold = thresholdById('geospatial.niche-nondb-features-gate');
    if (!threshold || threshold.comparison !== 'gate') throw new Error('expected a gate threshold');
    const rationale = renderRationale({
      decision: 'keep',
      storeId: 'mapserver:tiles',
      observed: threshold.gateSignals.join('; '),
      verb: 'trips',
      threshold: threshold.description,
      citation: '',
      postgresEquivalent: 'PostGIS',
      failureMode: threshold.failureMode,
      evidenceRef: 'src/tiles.ts:1',
    });
    expect(rationale).toMatch(/^Keep mapserver:tiles — /);
    expect(rationale).toContain('Postgres alternative PostGIS would still pay this cost:');
    expect(rationale).toMatch(/Evidence: \S+\.$/);
    for (const word of BANNED_WORDS) expect(rationale.toLowerCase()).not.toContain(word);
    expect(rationale).toMatchSnapshot();
  });
});

describe('rationale templating — previously-orphaned signals now surface in prose', () => {
  it('vector: embedding-dims drives an HNSW RAM-math note (PLAN.md §1.5)', () => {
    const storeId = 'pinecone:default';
    const evidence = [ev('src/vectors.ts', "text-embedding-3-small", 5)];
    const r = role(storeId, 'vector', evidence);
    const signals = [
      signal('count-vectors', 2_000_000, 'estimated', evidence),
      signal('embedding-dims', 1536, 'static', evidence),
    ];
    const v = computeVerdict(r, signals, buildVerdictRules('vector'));
    expect(v.decision).toBe('consolidate');
    expect(v.rationale).toContain('HNSW RAM estimate: ~13 GB for 2,000,000 vectors x 1536 dims x 4 bytes');
    for (const word of BANNED_WORDS) expect(v.rationale.toLowerCase()).not.toContain(word);
  });

  it('olap: dbt-model-count surfaces as a presence hint when scanned-data-size-gb is unresolved (PLAN.md §1.7)', () => {
    const storeId = 'clickhouse:default';
    const evidence = [ev('dbt_project.yml', 'dbt_project.yml present')];
    const r = role(storeId, 'olap', evidence);
    const signals = [signal('dbt-model-count', 42, 'estimated', evidence)];
    const v = computeVerdict(r, signals, buildVerdictRules('olap'));
    expect(v.decision).toBe('borderline');
    expect(v.rationale).toContain('Presence signal: 42 dbt model(s) detected');
  });
});

describe('rationale templating — consolidate rationales end with the migration-effort line', () => {
  const MIGRATION_LINE = /\d+ call sites? across \d+ files? to rewrite; data migration: (copy|dual-write|none); rollback: .+\.$/;

  it('every consolidate verdict across the golden fixtures carries the migration-effort sentence', async () => {
    for (const fixture of ['node-monolith', 'python-service', 'edge-cases', 'adversarial']) {
      const result = await analyze({ repoPath: join(FIXTURES_DIR, fixture), config: DEFAULT_CONFIG, noAi: true });
      for (const v of result.verdicts.filter((v) => v.decision === 'consolidate')) {
        expect(v.migrationEffort, `${fixture} ${v.storeId}/${v.role}`).toBeDefined();
        expect(v.rationale, `${fixture} ${v.storeId}/${v.role}`).toMatch(MIGRATION_LINE);
      }
    }
  });

  it('a synthetic gate consolidate verdict (geospatial default) also carries the line', () => {
    const storeId = 'postgis-candidate:default';
    const evidence = [ev('src/maps.ts', 'ST_Distance(a, b)')];
    const r = role(storeId, 'geospatial', evidence);
    const v = computeVerdict(r, [], buildVerdictRules('geospatial'));
    expect(v.decision).toBe('consolidate');
    expect(v.rationale).toMatch(MIGRATION_LINE);
  });
});

describe('rationale templating — no hedging language anywhere (done-conditions for 5.2)', () => {
  it('no verdict rationale across any fixture contains "probably", "likely", or "vibe"', async () => {
    for (const fixture of ['node-monolith', 'python-service', 'edge-cases', 'adversarial']) {
      const result = await analyze({ repoPath: join(FIXTURES_DIR, fixture), config: DEFAULT_CONFIG, noAi: true });
      for (const v of result.verdicts) {
        for (const word of BANNED_WORDS) {
          expect(v.rationale.toLowerCase(), `${fixture} ${v.storeId}/${v.role}`).not.toContain(word);
        }
      }
    }
  });

  it('golden expected-verdicts.json fixtures are themselves free of hedging language', () => {
    for (const fixture of ['node-monolith', 'python-service', 'edge-cases']) {
      const raw = readFileSync(join(FIXTURES_DIR, fixture, 'expected-verdicts.json'), 'utf8');
      const verdicts = JSON.parse(raw) as Verdict[];
      for (const v of verdicts) {
        for (const word of BANNED_WORDS) {
          expect(v.rationale.toLowerCase(), `${fixture} ${v.storeId}/${v.role}`).not.toContain(word);
        }
      }
    }
  });
});
