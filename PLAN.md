<!-- /autoplan restore point: /Users/ericwei/.gstack/projects/ericwei1107-postgres-consolidation-advisor/main-autoplan-restore-20260707-234700.md -->
# PLAN.md — Postgres Consolidation Advisor

A CLI that points at an app's codebase, inventories every non-Postgres data store it
uses, and answers per store: **consolidate into Postgres, or keep it — and why,
specifically.** Verdicts are grounded in the repo's *observed* usage, not the store's
theoretical capability. The "keep it" calls name a quantified threshold, with a cited
source for every number.

Context: the "Postgres Is Enough" thesis (postgresisenough.dev) — most teams add
Redis/Elastic/Mongo/Kafka/Pinecone by default, paying in operational surface area
(deployments, backups, failure modes, 3 AM pages) for capacity they will never use.
Only ~0.3% of projects reach "webscale" (the thesis site's figure — illustrative,
not independently sourced; do not cite it in report output). This tool
operationalizes the counter-check: prove the extra store is earning its keep, or
fold it into Postgres.

**Who runs this, and when.** Primary persona: the staff/senior engineer who owns
infra cost or on-call quality. Trigger moments: (a) a PR adds a new data store —
the GitHub Action fires; (b) a cost/complexity review or on-call retro — they run
`npx postgres-advisor` once and bring the report to the discussion. The report must
enable a concrete next action within 24 hours: open a migration ticket (snippet
attached), or write the justification entry that shuts the debate down.

**Competitive position.** No direct competitor tool exists today (checked July
2026), but every Postgres vendor (Tiger Data, Neon, Supabase, Tembo) actively
markets this thesis and could ship a console version; general coding agents can
approximate the detection layer. The durable assets are (a) the sourced threshold
ruleset (§1) and (b) the CI gate — and *vendor neutrality*: this tool is the referee
the vendors structurally can't be. Source-grading (below) exists to defend exactly
that position.

---

## 0. Decisions made up front (so no task has to make them)

**Language/stack: TypeScript on Node ≥ 20, single npm package.**
Rationale: (a) the detection surface is mostly JSON/YAML/lockfile parsing, native to
the Node ecosystem; (b) shipping as `npx postgres-advisor` and as a GitHub Action is
zero-friction from one codebase; (c) `@anthropic-ai/sdk` is first-class. Python repos
are *analysis targets*, not the implementation language — detectors read
`requirements.txt`/`pyproject.toml`/SQLAlchemy files as text, which needs no Python
runtime.

**Fixed dependency set** (tasks must not add others without listing it in Open
Questions): `commander` (CLI), `yaml` (compose/config parsing), `fast-glob` (file
walking), `zod` (validating rule files and detector output), `@anthropic-ai/sdk`
(judgment calls only), `pg` (live mode only), `vitest` (tests), `tsup` (build).
No tree-sitter/AST parsing in v1: call-pattern extraction is line-based
regex over client-library call sites, which is deterministic, fast, language-agnostic
enough, and its known imprecision is exactly what the Claude disambiguation step and
confidence scores exist to absorb.

**Claude is used in exactly two places, nowhere else:**
1. Role disambiguation — e.g. "is this Redis usage a cache, a queue, a rate limiter,
   or several of those?" given extracted call-site snippets.
2. Snippet tailoring — adapting a deterministic migration template to the repo's
   actual schema/names.
Everything else (detection, mapping, scoring, thresholds) is rule-based and runs fully
offline. Every Claude call site has a deterministic fallback (`--no-ai` flag): role
falls back to "ambiguous — multiple candidate roles listed, confidence low"; snippets
fall back to the untailored template.

**Verdicts are never binary.** Output is one of `consolidate` / `keep` /
`borderline`, each with a fit score 0–100, a confidence (`high`/`medium`/`low`), and
the specific threshold comparison that produced it. When a threshold variable can't
be observed statically, the verdict is `borderline`, confidence `low`, with the
observable range stated and a pointer to live-stats mode.

---

## 1. The hard part: quantifying "when Postgres stops being enough"

Methodology, per store category. Each entry states: the **observable signal** that
stands in for the threshold variable, the **numeric threshold** with its **source**,
and the **static fallback** when the signal can't be observed.

Threshold numbers marked **[A#]** are assumptions or extrapolations — every one is
listed in "Open Questions / Assumptions Made" at the end for review. Unmarked
numbers come from the cited source.

### General estimation model (used by several categories)

Static analysis cannot see production traffic, so throughput is *estimated from
provisioned capacity* — how much the team has built to handle — and reported as a
range, never a point:

> `est_peak = Σ(worker_replicas × per-worker concurrency)` × (an assumed 0.1–10
> jobs/sec per concurrent worker slot) **[A1]**

where replicas come from `docker-compose.yml` `deploy.replicas` / k8s manifests, and
concurrency from framework config (Sidekiq `concurrency:`, Celery `worker_concurrency`,
BullMQ `Worker(..., { concurrency })`, Gunicorn workers, etc.). The two-orders-of-
magnitude spread is deliberate: the report shows the range, and the verdict logic
only fires a confident "keep" or "consolidate" when the *entire range* falls on one
side of the threshold. Otherwise: `borderline`, defer to live mode.

### 1.1 Queue (Redis+Sidekiq/BullMQ/Celery, RabbitMQ, SQS, Kafka-as-queue)

- **Signal:** estimated peak msgs/sec via the general model; count of distinct
  queues/topics; presence of *streaming semantics* — consumer groups with replay,
  offset management, Kafka Streams/ksqlDB/Connect, log-compaction config, retention
  settings. Streaming semantics are a **qualitative gate**, checked before any number:
  if the repo replays history or fans one event out to N independent consumer groups,
  Postgres queues are the wrong shape regardless of throughput. Concrete replay
  signals (enumerated in `rules/call-patterns.yaml`): `fromBeginning: true`,
  `seek(`, multiple distinct groupIds consuming one topic, retention/compaction
  config. Mere `groupId` presence must NOT fire the gate — kafkajs requires a
  groupId on every consumer, so that alone proves nothing (Gunnar Morling,
  ["'Just Use Postgres' Considered Harmful"](https://www.morling.dev/blog/you-dont-need-kafka-just-use-postgres-considered-harmful/)).
- **Thresholds:**
  - `< 1,000 msgs/sec` estimated → **consolidate** (pgmq or `FOR UPDATE SKIP LOCKED`).
    Plain SKIP LOCKED implementations sustain 1k–10k jobs/sec
    ([SKIP LOCKED pattern write-ups](https://medium.com/@the_atomic_architect/postgresql-replaced-my-message-queue-and-taught-me-skip-locked-along-the-way-87d59e5b9525);
    the classic [10k jobs/sec Que benchmark](https://gist.github.com/chanks/7585810)).
  - `1,000–10,000 msgs/sec` → **borderline**: feasible — pgmq benchmarked >30k
    msgs/sec on 16 vCPU ([Tembo MQ benchmark](https://legacy.tembo.io/blog/mq-stack-benchmarking/)) —
    but requires tuning (unlogged queues, aggressive autovacuum) and consumer
    transactions must stay short or MVCC/WAL bloat bites
    ([kmoppel, Postgres/Kafka/event queues](https://kmoppel.github.io/2025-11-13-postgres-kafka-and-event-queues/)).
  - `> 10,000 msgs/sec` sustained, or the streaming-semantics gate fires → **keep**.
    Verdict text names the number: "your provisioned capacity implies ~N msgs/sec;
    SKIP LOCKED is comfortable to ~10k on tuned hardware; Kafka's batching/sequential
    I/O is built for the range above that."
- **Fallback:** no worker config found → range reported as unknown, `borderline`,
  point to live mode (`pg_stat_statements` on the enqueue-equivalent tables, or
  Redis `INFO` / Kafka consumer-lag metrics the user pastes in — v1 reads
  `pg_stat_statements` only).

### 1.2 Cache (Redis, Memcached)

- **Signal:** which Redis *commands* the code uses — this is statically observable
  and is the primary gate. Plain `GET/SET/DEL/EXPIRE/TTL` → cache role, consolidable.
  `ZADD/ZRANGE` (leaderboards), `PUBLISH/SUBSCRIBE`, `XADD` (streams), `EVAL` (Lua),
  `INCR`-heavy rate limiting → Redis-native structures with no clean Postgres
  equivalent at the same latency; each detected structure is named in the verdict.
- **Thresholds:** benchmark ([raphaeldelio, Redis vs Postgres cache benchmark](https://dev.to/raphaeldelio/can-postgres-replace-redis-as-a-cache-2ne1)):
  Postgres unlogged-table reads ≈ **16k ops/sec at ~0.7 ms** vs Redis ≈ **890k
  ops/sec at ~0.1 ms** on comparable hardware.
  - Estimated cache ops `< 5,000/sec` **[A2]** and commands are plain KV → **consolidate**
    (UNLOGGED table + `pg_cron` TTL sweep; Postgres has no native TTL — stated in
    the verdict as a cost, not hidden).
  - **Keep** on latency only when an explicit sub-ms SLO appears in config, or
    high per-request fan-out is detected (many cache reads per handled request —
    threshold: ≥10 distinct cache calls reachable per endpoint handler **[A9]**).
    Mere presence in a request hot path is NOT a keep signal: nearly every cache
    is in a hot path, and 0.7 ms vs 0.1 ms is invisible inside a typical 50–200 ms
    request. Verdict cites the 0.1 ms vs 0.7 ms gap only when the fan-out math
    makes it material.
  - Redis-native structures detected → **keep** (or **partial consolidate**: the
    verdict may split one Redis instance into "migrate the plain-KV usage, keep the
    pub/sub usage" — per-role verdicts, see §2 data model).
- **Fallback:** cache QPS is rarely statically estimable → default `borderline`
  on the numeric axis, decide on the command-mix axis (which *is* observable), and
  say so: "verdict based on usage shape; validate rate in live mode."

### 1.3 Full-text search (Elasticsearch, Algolia, OpenSearch, Meilisearch)

- **Signal:** corpus size estimate (row counts from seed files, migration comments,
  fixture sizes — weak; live mode reads `pg_class.reltuples`); *feature usage*:
  aggregations/faceting, percolator, ILM/index lifecycle, log-analytics patterns
  (daily indices, Logstash/Beats in compose), fuzzy/typo tolerance, custom analyzers,
  relevance tuning (`function_score`).
- **Thresholds:**
  - Corpus `< ~5M` docs, features = keyword search + basic ranking → **consolidate**
    to `tsvector` + `pg_trgm`. Native Postgres FTS "performs well over tables with a
    few million rows, degrades considerably over tens of millions," and top-N by
    `ts_rank` must score every match
    ([Neon, Postgres FTS vs Elasticsearch](https://neon.com/blog/postgres-full-text-search-vs-elasticsearch)).
  - Corpus `5M–100M` docs, or BM25 relevance matters → **consolidate to ParadeDB
    `pg_search`** (BM25 via Tantivy, "indexing and search times nearly identical to a
    dedicated Elasticsearch instance," 20× faster ranking than tsvector at 1M rows —
    [ParadeDB](https://www.paradedb.com/blog/elasticsearch-vs-postgres)). Verdict
    notes this is an extension adoption, not vanilla Postgres.
  - Log analytics at scale (daily-index pattern), heavy aggregations as primary
    workload, or corpus `> ~100M` docs **[A3]** → **keep** Elasticsearch. (BM25-in-
    Postgres engines have been benchmarked to 138M docs
    ([TigerData pg_textsearch](https://www.tigerdata.com/blog/pg-textsearch-bm25-full-text-search-postgres)),
    so the 100M line is conservative and flagged.)
- **Fallback:** corpus size unknown statically (the common case) → verdict decided
  on the feature axis with confidence `medium`; size axis reported "unknown, check
  live mode."

### 1.4 Document store (MongoDB, CouchDB, DynamoDB-as-docstore)

- **Signal:** all statically observable from schemas + call sites: average document
  size (inferred from Mongoose/schema field counts and any seed data); **update
  shape** — field-level mutators (`$set`, `$inc`, `$push`) vs whole-doc replacement;
  use of change streams, multi-document transactions, sharding config, aggregation
  pipelines beyond what translates to SQL.
- **Thresholds:** the pivotal mechanism is TOAST: JSONB values over ~**2 KB** are
  compressed/chunked out-of-line, and updating *one field* rewrites and re-TOASTs the
  *whole document* plus all indexes (no HOT updates on indexed JSONB)
  ([Franck Pachot, JSONB TOAST limits](https://dev.to/franckpachot/postgresql-jsonb-size-limits-to-prevent-toast-slicing-9e8),
  [no-HOT-on-JSONB write amplification](https://dev.to/mongodb/no-hot-updates-on-jsonb-13k7)).
  - Docs typically `< 2 KB`, or read-mostly at any size → **consolidate** to JSONB
    (+ GIN index), or FerretDB if the team wants wire-protocol compatibility.
  - Frequent field-level updates (`$inc` counters, `$push` arrays) on multi-KB docs
    → **keep** Mongo; verdict cites the TOAST rewrite mechanism and names the hot
    fields it found. Middle path offered in the snippet: promote hot fields to real
    columns, keep the cold blob in JSONB.
  - Change streams or sharding actively used → **keep**, qualitative gate.
- **Fallback:** doc size not inferable → decide on update-shape axis alone,
  confidence `medium`.

### 1.5 Vector / AI (Pinecone, Weaviate, Qdrant, Milvus, Chroma)

- **Signal:** embedding dimensionality (statically visible at the embed call:
  `text-embedding-3-small` → 1536, etc.); vector count estimate (what gets embedded —
  per-row? per-chunk? corpus hints); filtered-search complexity; index params if any.
- **Thresholds:**
  - `< ~5M vectors` → **consolidate** to pgvector HNSW: at 1M scale it matches or
    beats dedicated engines ([Supabase pgvector vs Pinecone](https://supabase.com/blog/pgvector-vs-pinecone)).
    HNSW wants the index in RAM; the verdict computes the estimate
    (`vectors × dims × 4 bytes` + graph overhead) and states it.
  - `5M–50M vectors` → **consolidate with pgvectorscale** (StreamingDiskANN):
    benchmarked at 50M vectors / 99% recall, 471 QPS, 28× lower p95 and 16× higher
    throughput than Pinecone s1
    ([Timescale pgvectorscale benchmark](https://www.tigerdata.com/blog/pgvector-vs-pinecone)).
  - `> ~100M vectors` **[A4]**, or multi-tenant serverless isolation is the point →
    **keep**; flagged as assumption since public benchmarks stop at 50M.
- **Fallback:** vector count usually estimable only as a range from corpus hints →
  report range; if the range straddles 5M, `borderline` with the RAM math shown.

### 1.6 Time-series (InfluxDB, TimescaleDB-as-separate-instance, Prometheus remote storage)

- **Signal:** ingest rate = (device/source count × sampling interval), both often in
  config; series cardinality (tag fields in schema); retention/downsampling config.
- **Thresholds:**
  - This category defaults to **consolidate** (TimescaleDB extension or plain
    partitioned tables + `pg_partman` + BRIN): at high cardinality (10M devices)
    TimescaleDB out-ingested InfluxDB 50k vs 38k rows/sec
    ([TimescaleDB vs InfluxDB](https://medium.com/timescale/timescaledb-vs-influxdb-purpose-built-differently-for-time-series-data-36489299877)) —
    the specialized store isn't even faster in the regime that matters.
  - **Keep** only when estimated ingest `> ~500k rows/sec` sustained on a single
    node **[A5]**, or the deployment already depends on InfluxDB 3.0-specific
    features / existing Grafana-Flux dashboards (migration cost gate, qualitative).
- **Fallback:** ingest usually estimable from config; otherwise `borderline` → live
  mode (`pg_stat_user_tables.n_tup_ins` deltas).

### 1.7 OLAP (Snowflake, BigQuery, Redshift, ClickHouse)

- **Signal:** analytical dataset size (dbt project models, warehouse table count,
  export/ELT job configs — Fivetran/Airbyte in compose); BI concurrency (dashboard
  tool configs); whether the warehouse is also serving external/customer-facing
  analytics.
- **Thresholds:**
  - Regularly-scanned data `< ~500 GB` → **consolidate**: run analytics on a Postgres
    replica with `pg_analytics`/DuckDB-over-Parquet; sub-second on modest hardware to
    ~100 GB, and "above ~500 GB a real warehouse pays off"
    ([dataskew.io](https://dataskew.io/blog/metabase-duckdb-local-analytics/),
    [Definite on DuckDB](https://www.definite.app/blog/duckdb-ducklake-business-case)).
  - `500 GB – few TB` → **borderline**: DuckDB is production-proven into the
    terabytes single-node ([10 TB scale report](https://datamonkeysite.com/2025/10/19/running-duckdb-at-10-tb-scale/)),
    but concurrency and governance push toward a warehouse. Verdict lists both costs.
  - `> few TB` scanned per query, or high concurrent BI usage, or cross-org data
    sharing → **keep**.
- **Fallback:** dataset size rarely visible in-repo → verdict keys off *presence*
  signals (a dbt project with 400 models is different from 12), confidence `low`,
  defer numbers to live mode against the warehouse's own metadata if the user allows.

### 1.8 Graph (Neo4j, Neptune)

- **Signal:** traversal shape in queries — statically extractable from Cypher/Gremlin
  strings: fixed-depth patterns (`(a)-[:X]->(b)-[:Y]->(c)`) vs variable-length
  (`[:X*1..]`), plus graph-algorithm library usage (PageRank, community detection);
  edge-count estimate from schema/seeds.
- **Thresholds:** **no reliable public benchmark grounds a numeric line here — this
  category is explicitly qualitative, and the report says so** **[A6]**.
  - Fixed-depth ≤ 3-hop traversals → **consolidate** to recursive CTEs (plain SQL).
  - Cypher-shaped workloads without graph-algorithm libraries → **consolidate to
    Apache AGE** (openCypher in Postgres), verdict notes AGE's maturity risk.
  - Variable-length deep traversal as the core access pattern, or GDS-style
    algorithms → **keep** Neo4j.
- **Fallback:** none needed; the signal (query text) is fully static.

### 1.9 Geospatial (dedicated GIS systems)

- **Signal:** which GIS operations appear in code.
- **Threshold:** effectively none — **consolidate by default**: PostGIS is the
  reference implementation of SQL geospatial and typically *more* capable than
  bolt-on GIS layers. **Keep** only for niche server products' non-DB features
  (tile rendering pipelines etc.), a qualitative gate. Flagged **[A7]** only in the
  sense that "PostGIS is at parity or better" is asserted from its standard-bearer
  status, not a benchmark.

### Confidence and the static/live seam, summarized

Every threshold variable is tagged in the rules file with `observability:
static | estimated | live-only`. `static` signals produce `high` confidence verdicts;
`estimated` produce ranges and cap confidence at `medium`; `live-only` variables cap
at `low` unless live mode ran. The report's per-store section always shows the
comparison as: *observed/estimated value* vs *threshold (source)* → verdict.

---

## 2. Architecture

```
repo path
  └─> Scanner        (walk files, cheap classification of what's worth parsing)
  └─> Detectors      (compose / env / manifests / ORM schemas)  → DetectedStore[]
  └─> UsageExtractor (call-site harvest per store)              → UsageEvidence[]
  └─> RoleClassifier (rules first; Claude iff ambiguous)        → StoreRole[] (a store can have several)
  └─> FitScorer      (declarative rules/*.yaml + thresholds)    → Verdict[] per (store, role)
  └─> SnippetGen     (templates/*.sql.hbs; Claude tailoring)    → Snippet[]
  └─> Reporters      (markdown | json | html)
[live mode: PgStatsCollector feeds real numbers into FitScorer, replacing estimates]
```

Core types (defined once in Stage 1, frozen after):

```ts
type StoreCategory = 'cache'|'queue'|'search'|'document'|'vector'|'timeseries'|'olap'|'graph'|'geospatial'|'relational'|'unknown';
interface DetectedStore { id: string; product: string; category: StoreCategory[]; evidence: Evidence[]; }
interface Evidence { kind: 'compose'|'env'|'dependency'|'orm-schema'|'call-site'|'live-stats'; file: string; line?: number; excerpt: string; }
interface StoreRole { storeId: string; role: StoreCategory; confidence: 'high'|'medium'|'low'; classifiedBy: 'rule'|'claude'; evidence: Evidence[]; }
interface Verdict { storeId: string; role: StoreCategory; decision: 'consolidate'|'keep'|'borderline'; fitScore: number; confidence: 'high'|'medium'|'low';
  thresholdComparisons: { variable: string; observed: string; threshold: string; source: string; passed: boolean }[];
  rationale: string; postgresEquivalent: string; snippetId?: string; }
```

Additions from review: `interface FieldSummary { model: string; fields: { name:
string; type: string; nested: boolean }[]; estimatedDocBytes?: number }` — the
ORM detector (2.4) emits structured `FieldSummary[]` (not excerpt strings) so
doc-size estimation (4.3) and snippet tailoring (6.2) consume typed data.
`Verdict.migrationEffort?: { callSites: number; filesTouched: number;
dataMigration: 'copy'|'dual-write'|'none'; rollbackNote: string }` — populated
for every `consolidate` verdict from data already harvested (call-site counts,
files) plus per-mapping `data_migration`/`rollback` fields in
`rules/mappings.yaml`; rendered in the ticket block (7.1h) and rationale (5.2)
so a consolidate verdict carries its cost side, not just its fit side.
**Type freeze is now in effect** (final-gate decisions landed 2026-07-08).

Verdicts are per **(store, role)** pair — one Redis instance used as cache *and*
queue gets two verdicts, possibly different.

---

## 3. Stages and tasks

Each stage ≈ one day, independently completable. Implementer: one task at a time,
no memory beyond this file and the codebase — every task states its exact inputs,
outputs, and done-condition.

### Stage 1 — Scaffold, core types, fixture repos

- [x] **1.1 — Repo scaffold and CLI skeleton** ✅ 2026-07-08
  - Inputs/dependencies: none (first task).
  - Expected output: npm package `postgres-advisor` with `tsup` build, `vitest`
    configured, `commander`-based CLI exposing `analyze [path]` (path defaults to
    `.`; bare `npx postgres-advisor` with no subcommand runs `analyze .` — the
    Champion-tier hello world is one command in the repo root) (flags: `--format
    md|json|html`, `--no-ai`, `--out <file>`, `--fail-on
    <keep|borderline|new-store>[,...]` [comma-separable exact-match list,
    default none; `new-store` with no local lockfile → exit 2 "run `analyze
    --write-lock` first"] with exit codes 0=ok, 1=condition hit, 2=error) and
    `explain <threshold-id>` (stub until 4.2). Stdout contract with `--format`:
    when stdout is not a TTY, stdout carries ONLY the artifact (clean piping);
    progress and warnings go to stderr. `engines: {node: ">=20"}` plus a runtime
    check that prints "postgres-advisor requires Node ≥ 20 (you have X)" instead
    of an ESM stack trace. Error-message convention (all surfaces): problem +
    cause + fix + stable docs anchor URL,
    `src/types.ts` containing exactly the interfaces from §2 plus zod schemas for
    each. Loads optional `.postgres-advisor.yaml` (zod-validated; invalid config
    = hard fail exit 2 with the named field, same policy as rules files — it
    gates CI semantics; the error shows an inline example of the valid shape):
    `suppress:` list
    of store ids/products (suppressed stores appear in the inventory annotated
    "suppressed", get no verdict), `ignore:`/`paths:` glob lists (user-scoped
    scan control — the cheapest slice of the monorepo problem; fixtures/,
    examples/, generated dirs full of decoy compose files need an escape
    hatch), and `threshold_overrides:` map (see 4.2; fitScore weights are NOT
    overridable in v1 — documented).
    Config suppression affects LOCAL analyze output only — it does NOT satisfy the
    CI gate in 9.1; the lockfile `## Justification` is the only gate-silencing
    mechanism. `analyze` runs end-to-end and prints an empty inventory.
  - Done-condition: `npx tsx src/cli.ts analyze ./fixtures/empty` exits 0 with
    "0 data stores detected"; `npm test` passes with one smoke test; `npm run build`
    emits ESM + CJS; npm registry name `postgres-advisor` availability verified
    (pick fallback name now if taken).

- [ ] **1.2 — Fixture repos (the test bed everything else validates against)**
  - Inputs/dependencies: 1.1.
  - Expected output: `fixtures/` with three miniature but realistic apps, committed
    as plain files (no node_modules): **(a)** `node-monolith` — Express +
    Prisma/Postgres + ioredis used as BOTH cache (GET/SET/EXPIRE) and BullMQ queue,
    Elasticsearch client with basic `search` calls, docker-compose with redis,
    elasticsearch, postgres, `deploy.replicas: 2` on a worker service with BullMQ
    `concurrency: 10`; **(b)** `python-service` — FastAPI + SQLAlchemy + Celery
    (broker=redis, `worker_concurrency=8`) + pymongo with a Mongoose-equivalent
    document model including an `$inc` counter update + pinecone-client with
    `text-embedding-3-small`; **(c)** `edge-cases` — env-var-only detection (a
    `KAFKA_BROKERS` var, no client lib), a store in compose but unused in code, a
    commented-out dependency; **(d)** `adversarial` — usage shapes chosen to fire
    the FALSE-POSITIVE direction of the rules: Redis as session store (plain KV but
    latency-irrelevant), Kafka used as a dumb work queue (no consumer groups/replay
    — should NOT trip the streaming gate), Elasticsearch used only for log storage
    (daily indices — SHOULD trip the log-analytics keep), a high-fan-out cache
    endpoint (≥10 cache reads per request — should trip the A9 fan-out keep). Each
    fixture ships `expected-inventory.json` — the ground truth detectors must
    produce.
  - Done-condition: fixtures exist, `expected-inventory.json` validates against the
    zod schema for `DetectedStore[]`, and a `fixtures/README.md` table lists what
    each fixture is designed to exercise.

### Stage 2 — Detection engine

- [ ] **2.1 — docker-compose / k8s manifest detector**
  - Inputs/dependencies: 1.1 types, 1.2 fixtures; `yaml` package.
  - Expected output: `src/detectors/compose.ts` — parses any `docker-compose*.yml`,
    `compose.y?ml` (modern default names), and `k8s/**/*.yaml`; if `Chart.yaml`
    is present, skips `templates/**` with ONE "Helm templates skipped
    (unsupported)" warning (Go-templated YAML would otherwise flood the warnings
    section); `image: ${VAR}` interpolation → detected with confidence `low`
    when the default value matches a product regex; matches service images
    against a product table in
    `rules/products.yaml` (image regexes for: redis, memcached, elasticsearch,
    opensearch, mongo, kafka, rabbitmq, influxdb, clickhouse, neo4j, minio — plus
    the products themselves as `category` seeds). Captures `deploy.replicas` and
    environment blocks as Evidence.
  - Done-condition: unit test — running against all fixtures (incl. adversarial)
    yields exactly the compose-kind entries of each `expected-inventory.json`
    (matched on product+file, order-insensitive). Parse-error policy (applies to
    ALL detectors): a malformed file (bad YAML/JSON/TOML) is skipped, recorded as
    an analysis warning with file + reason, and never crashes the run; each
    detector is isolated — one detector throwing is caught, logged as a warning,
    and the others still report. YAML parsing uses safe defaults with alias/depth
    caps (billion-laughs hardening); file walking never follows symlinks and
    always ignores node_modules/vendor/.git/dist/build by default.

- [ ] **2.2 — Dependency-manifest detector**
  - Inputs/dependencies: 2.1's `rules/products.yaml` (extend it with a
    `client_libraries` map: e.g. `ioredis|redis|node-redis → redis`,
    `bullmq|bee-queue → redis(queue)`, `@elastic/elasticsearch`, `mongoose|pymongo|
    motor → mongodb`, `kafkajs|confluent-kafka → kafka`, `celery → (broker from
    config)`, `@pinecone-database/pinecone|pinecone-client → pinecone`,
    `weaviate-client`, `@qdrant/js-client-rest`, `pg|psycopg|asyncpg → postgres`).
  - Expected output: `src/detectors/dependencies.ts` — reads `package.json`,
    `requirements.txt`, `pyproject.toml`, `Gemfile`, `go.mod`; ignores
    commented-out lines; emits `DetectedStore` with `dependency` Evidence.
    Celery broker resolution: only a literal broker URL/setting resolves to a
    product; `os.environ[...]`/settings-object indirection or absent config →
    `queue` role on an `unknown-broker` store with confidence `low` — never
    guess Redis.
  - Done-condition: unit tests vs fixtures pass, including the `edge-cases` fixture's
    commented-out dependency producing NO detection.

- [ ] **2.3 — Env/config detector**
  - Inputs/dependencies: 2.2.
  - Expected output: `src/detectors/env.ts` — scans `.env*`, `config/**`,
    `settings.py`, `*.config.{js,ts}` for URL-shaped values and known var names
    (`REDIS_URL`, `MONGODB_URI`, `ELASTICSEARCH_URL`, `KAFKA_BROKERS`,
    `DATABASE_URL`, `PINECONE_API_KEY`, etc. — table lives in `rules/products.yaml`,
    not code). Merges with prior detections by **product + instance identity**,
    NOT product alone (identity = compose service name, or URL host:port from
    env/config, else a per-product default bucket): two Redis services in one
    compose file (`redis-cache`, `redis-broker`) are TWO DetectedStores; the same
    instance found by compose + env + dependency is ONE store with three Evidence
    entries. When evidence can't be attributed to a specific instance, it attaches
    to the default bucket and the report notes the ambiguity (confidence capped at
    `medium` for affected stores). **Secret redaction rule:** Evidence excerpts
    from env/config files record the variable NAME and a redacted value
    (`REDIS_URL=redis://<redacted>@host:6379` → host:port kept for identity,
    credentials always stripped); raw secret values must never appear in Evidence,
    reports, lockfiles, or PR comments — unit-tested with a fixture .env
    containing a fake password.
  - Done-condition: `edge-cases` fixture's `KAFKA_BROKERS`-only store is detected
    with a single env Evidence; `node-monolith`'s redis is ONE store with ≥2
    evidence kinds; dedup logic unit-tested.

- [ ] **2.4 — ORM-schema detector**
  - Inputs/dependencies: 2.3.
  - Expected output: `src/detectors/orm.ts` — parses Prisma `schema.prisma`
    (datasource block + model shapes), Mongoose schema files (field counts, types,
    nested depth — feeds doc-size estimation later), SQLAlchemy models
    (line-regex for `Column(`, `relationship(`). Extracts per-model field summaries
    into Evidence excerpts.
  - Done-condition: `python-service` fixture yields the mongo document model with
    its field summary; `node-monolith` yields Prisma-on-Postgres; snapshot tests.

### Stage 3 — Usage extraction and role classification

- [ ] **3.1 — Call-site harvester**
  - Inputs/dependencies: Stage 2 complete (needs `DetectedStore[]` to know what to
    look for).
  - Expected output: `src/usage/harvester.ts` — for each detected store, scans
    source files for that store's client-call patterns. **Precision rules (bare
    method-name regexes drown in `Map.get`/`headers.get` noise otherwise):**
    (1) harvest ONLY in files that import/require that store's client library
    (the dependency detector already knows the package names); (2) prefer
    receiver-tracked patterns — receiver variable assigned from a client
    constructor (`const r = new Redis(...)` → `r.get(`) — over bare
    `\.get\(`; (3) **instance attribution**: locate client construction sites,
    bind each to a DetectedStore instance via the env var / URL / service name
    it was constructed with, attribute call sites to that instance;
    unattributable call sites go to the product's default bucket with
    confidence capped `medium` (extends the 2.3 identity rule); (4) BOM-sniff
    (UTF-16 → transcode or skip+warn) and null-byte-sniff (binary → skip)
    before regexing; (5) single-pass multi-pattern scan per file (combine all
    stores' patterns), not one pass per store — cost is O(files), not
    O(stores × files); `--max-files N` escape hatch. Patterns live in
    per-product lists (per-product pattern lists
    in `rules/call-patterns.yaml`: e.g. redis → `\.(get|set|setex|del|expire|zadd|
    zrange|publish|subscribe|xadd|eval|incr)\(`, mongo → `\.(find|insertOne|
    updateOne|aggregate|watch)\(` + `\$set|\$inc|\$push` in update docs, ES →
    `\.search\(|aggs\s*:|function_score`, kafka → `consumer\(|producer\(|
    eachMessage`). Emits `UsageEvidence` = Evidence + matched command name. Caps at
    200 call sites per store (enough for classification, bounds runtime). Skips
    files > 1 MB and lines > 5k chars (minified bundles: false-positive source and
    regex tarpit both); skipped files are counted in `--verbose` output.
  - Done-condition: for `node-monolith`, redis harvest contains both cache-shaped
    (`get/set/expire`) and queue-shaped (BullMQ `Worker|Queue`) hits with correct
    file:line; runtime < 5 s on a 10k-file synthetic tree (test generates one)
    and < 60 s on a 100k-file tree; a decoy fixture file full of
    `Map.get`/`fetch().headers.get`/`dict.get` calls harvests ZERO redis hits;
    a two-Redis-instance fixture (redis-cache + redis-broker) attributes call
    sites to the correct instance.

- [ ] **3.2 — Rule-based role classifier**
  - Inputs/dependencies: 3.1.
  - Expected output: `src/classify/rules.ts` + `rules/roles.yaml` — deterministic
    mapping: command-mix → roles with confidence. E.g. ≥90% of redis hits in
    {get,set,del,expire} → role `cache`/high; any BullMQ/Sidekiq/Celery import →
    role `queue`/high; both → two roles. Pinecone/Weaviate → `vector`/high
    trivially. Rules produce `StoreRole[]`; anything not matching a rule cleanly →
    role `unknown` with the evidence bundle passed forward.
  - Done-condition: fixtures classify correctly with `--no-ai` (node-monolith redis
    = cache+queue, python-service redis = queue via celery broker); table-driven
    unit tests for ≥10 command-mix scenarios.

- [ ] **3.3 — Claude disambiguation pass**
  - Inputs/dependencies: 3.2; `@anthropic-ai/sdk`; env `ANTHROPIC_API_KEY`.
  - Expected output: `src/classify/claude.ts` — ONLY invoked for `unknown`-role
    stores or rule confidence `low`. Prompt: store product + up to 30 UsageEvidence
    excerpts → strict JSON (`zod`-validated)
    `{roles: [{role, confidence}], rationale}` (`roles` min-length 1 — a single
    flat role would erase the per-(store,role) premise for an ambiguous Redis
    doing cache+queue+rate-limit).
    Model: `claude-sonnet-5` (judgment quality matters more than cost here; ~1–5
    calls per repo). Retries once on invalid JSON, then falls back to rule output.
    `--no-ai` skips entirely.
  - Done-condition: mocked-SDK unit tests (valid JSON, invalid JSON→retry→fallback,
    API error→fallback); one live integration test behind `RUN_LIVE_TESTS=1`.

- [ ] **3.4 — Reality checkpoint (real repos, before the verdict engine exists)**
  - Inputs/dependencies: 3.1–3.3.
  - Expected output: run detection + role classification (NOT verdicts — they
    don't exist yet) against 2 cloned real OSS apps with docker-compose files
    (candidates from awesome-selfhosted; same pool Stage 9.2 will use). Record
    per-repo: stores detected, roles assigned, confidence, false
    positives/negatives found by manual inspection, in
    `docs/validation-runs/checkpoint-stage3.md`.
  - Done-condition: both runs complete without crashes; every
    false-positive/negative found is either fixed in rules or logged as a known
    limitation BEFORE Stage 4 begins. This is the early contact with reality that
    keeps the estimation model from being built on a broken detection layer.

### Stage 4 — Mapping table and threshold rules as data

- [ ] **4.1 — Postgres-equivalent mapping table**
  - Inputs/dependencies: types from 1.1 only.
  - Expected output: `rules/mappings.yaml` — for each StoreCategory, ordered
    Postgres-native options with tradeoffs, exactly the §Project table: cache →
    UNLOGGED+pg_cron / materialized views; queue → pgmq / SKIP LOCKED / pgflow;
    search → tsvector+pg_trgm / ParadeDB pg_search; document → JSONB / FerretDB;
    vector → pgvector / pgvectorscale; timeseries → TimescaleDB / pg_partman+BRIN;
    olap → pg_analytics / DuckDB-attached; graph → recursive CTEs / Apache AGE;
    geospatial → PostGIS. Each option carries: `extension_required` (bool+name),
    `maturity` note, `operational_cost` note, `data_migration`
    (`copy|dual-write|none` — feeds `Verdict.migrationEffort`), and a one-line
    `rollback` note. zod schema + loader in `src/rules/load.ts`.
  - Done-condition: yaml validates on load; a table-driven test asserts every
    StoreCategory (except relational/unknown) has ≥1 mapping with all fields.

- [ ] **4.2 — Threshold rules file (§1 encoded as data)**
  - Inputs/dependencies: 4.1 loader.
  - Expected output: `rules/thresholds.yaml` — every threshold from §1 verbatim:
    stable `id` (format `<category>.<variable-slug>`, e.g.
    `queue.est-peak-msgs-sec`), variable name, observability tag
    (`static|estimated|live-only`), numeric value(s), comparison direction, source
    URL, **`source_grade: vendor|independent|reproduced`** (almost every current
    citation is a Postgres-vendor blog — the report discloses this grade next to
    every citation; it is the defense of the vendor-neutral position), and
    `assumption_id` (A1–A9) where flagged. The general estimation model constants
    (0.1–10 jobs/sec per worker slot [A1]) live here too. NO numeric literal
    related to thresholds may appear in TypeScript — enforced by a lint-style test
    that greps `src/scoring/` for numeric literals > 10. Implement `explain
    <threshold-id>`: prints value, comparison, source URL + grade, assumption
    status, and failure-mode text. `.postgres-advisor.yaml`
    `threshold_overrides: {<threshold-id>: <value>}` applies at load; an
    overridden threshold renders in every report as "(user-overridden; cited
    source no longer applies)". Each threshold also carries
    **`live_source: pg-stats | incumbent-only | none`** — which measurement can
    actually resolve it. This kills a circularity: v1 live mode reads only the
    app's Postgres, but most queue/cache borderline variables live in the
    incumbent store (Kafka traffic leaves no trace in `pg_stat_statements`).
    The report's "run --live" next-step is emitted ONLY for `pg-stats`
    thresholds (e.g. corpus/vector counts via `reltuples`); `incumbent-only`
    borderlines say honestly: "requires <Redis INFO / consumer-lag / _stats> —
    out of v1 scope; what to look at: <metric>". A `scoring:` section holds the
    verdict-engine constants (fitScore gate ≤30, base 100, weights) so 5.1
    passes 4.2's no-literals grep test by construction. Discoverability:
    `explain` with no argument (or `--list`) lists all threshold ids grouped by
    category; the report's threshold-comparison tables carry the id, and
    terminal output prints "details: `postgres-advisor explain <id>`"; store
    ids print in local analyze output so non-GitHub CI users can construct
    `justify <store-id>` commands.
  - Done-condition: yaml validates; round-trip test: loader → every §1 threshold
    reachable by `(category, variable)` lookup AND by `id`; the grep test passes;
    `explain queue.est-peak-msgs-sec` and `explain --list` golden-file tests;
    override test shows the overridden annotation in markdown output.

- [ ] **4.3 — Signal extractors (the estimation model)**
  - Inputs/dependencies: 4.2, Stage 2+3 outputs.
  - Expected output: `src/signals/*.ts`, one module per category needing
    estimation: `queueThroughput` (replicas × concurrency from compose/framework
    config → range via A1 constants), `cacheCommandMix` (from 3.1 harvest),
    `docUpdateShape` + `docSizeEstimate` (from 2.4 field summaries: fields ×
    30-bytes-avg heuristic [A8]), `vectorScale` (dims from model-name table
    {text-embedding-3-small:1536, -large:3072, ada-002:1536, all-MiniLM-L6-v2:384}
    — table lives in `rules/products.yaml` like every other threshold-shaped
    datum, not in TS; count range from corpus hints), `searchFeatures`,
    `cacheFanOut` (A9: counts cache-call sites within a single handler
    function's lexical span — same file, between route-handler anchors; crude
    and honestly labeled, NOT call-graph reachability, which regex can't do),
    `traversalShape` (regex over Cypher strings for `\*\d*\.\.`
    variable-length), `olapPresenceSignals`. Each returns
    `{variable, value|range, observability, evidence}`.
  - Done-condition: node-monolith queue estimate = 2 replicas × 10 concurrency ×
    [0.1,10] = [2, 200] msgs/sec range, exact match asserted in test; each extractor
    has ≥2 unit tests including a "signal absent → returns null" case.

### Stage 5 — Fit scoring and verdicts

- [ ] **5.1 — Verdict engine**
  - Inputs/dependencies: 4.1–4.3 complete.
  - Expected output: `src/scoring/verdict.ts` — pure function
    `(StoreRole, signals, rules) → Verdict`. Logic, fixed here: (1) qualitative
    gates first (streaming semantics, redis structures, change streams, GDS algos)
    — any gate firing → `keep`, fitScore ≤ 30, gate named in rationale;
    (2) numeric comparisons: entire estimated range below threshold →
    `consolidate`; entire range above → `keep`; straddling → `borderline`;
    (3) fitScore = 100 − weighted distance of observed values from thresholds
    (weights in thresholds.yaml, default equal); (4) confidence = min over used
    signals' observability tags (static=high, estimated=medium, live-only=low
    unless live data present). Every Verdict.thresholdComparisons entry carries the
    source URL from the rules file.
  - Done-condition: golden-file tests: all three fixtures produce committed
    `expected-verdicts.json` (node-monolith: redis-cache→consolidate/high,
    redis-queue→consolidate [range 2–200 < 1000], ES→consolidate-to-tsvector
    [feature axis, medium]; python-service: mongo→keep [$inc counter gate],
    pinecone→consolidate-to-pgvector; edge-cases: kafka→borderline/low [no
    signals]). Any rationale string must mention at least one Evidence file path.

- [ ] **5.2 — "Keep it" verdict quality pass**
  - Inputs/dependencies: 5.1.
  - Expected output: rationale templating in `src/scoring/rationale.ts` so every
    `keep` reads as: "Keep <store> — <observed signal> <exceeds/trips> <threshold>
    (<source>). Postgres alternative <equivalent> would <specific failure mode>."
    Every `consolidate` rationale ends with the migration-effort line: "<N> call
    sites across <M> files to rewrite; data migration: <shape>; rollback:
    <note>" (from `Verdict.migrationEffort`).
    Failure-mode strings per category live in `rules/thresholds.yaml`
    (`failure_mode` field): e.g. queue → "consumer transactions at this rate cause
    MVCC bloat and WAL pile-up"; document → "each $inc rewrites the full TOASTed
    document plus indexes."
  - Done-condition: snapshot tests of rendered rationales for every category's
    `keep` path; no rationale contains the words "probably", "likely", or "vibe" —
    asserted in test.

### Stage 6 — Migration snippets

- [ ] **6.1 — Snippet template library**
  - Inputs/dependencies: 4.1 mappings; Handlebars (`handlebars` pkg — add it, note
    in Open Questions).
  - Expected output: `templates/*.hbs`, one per mapping option, minimum set:
    `redis-cache→unlogged-table.sql.hbs` (table + pg_cron TTL sweep + example
    get/set functions), `redis-queue→pgmq.sql.hbs` (extension, queue create,
    send/read/archive calls in the app's language), `bullmq→pgmq.ts.hbs`,
    `mongo-collection→jsonb.sql.hbs` (table with promoted hot columns + GIN index +
    example migration `INSERT ... SELECT` from FerretDB or mongoexport),
    `es-index→tsvector.sql.hbs` (generated column + GIN + example ranked query),
    `es-index→paradedb.sql.hbs`, `pinecone→pgvector.sql.hbs` (extension, table with
    vector(dims), HNSW index with the repo's dims, example kNN query),
    `influx→timescale.sql.hbs`, `cypher→recursive-cte.sql.hbs`. Template variables:
    table/queue/index names, dims, field lists — all from Stage 2–4 outputs.
  - Done-condition: each template renders against fixture-derived contexts with no
    unresolved `{{...}}`; rendered SQL passes `pg_query`-based syntax validation.
    Use the **WASM build** of libpg-query (native bindings brick `npx` installs
    on Alpine/ARM/Node bumps — and a security control depends on this module
    loading); JS/TS snippets pass `tsc --noEmit`.

- [ ] **6.2 — Claude snippet tailoring**
  - Inputs/dependencies: 6.1, 3.3's Claude wrapper.
  - Expected output: `src/snippets/tailor.ts` — takes rendered template + the
    store's ORM field summary, asks Claude to adapt names/types/columns (strict
    instruction: modify identifiers and comments only, no structural changes),
    re-validates with libpg-query after — including an **AST-shape equality
    check**: parse both template and tailored output, compare normalized AST
    structure; any difference beyond identifiers/literals/comments (new
    statements, changed statement types) → discard and ship the untailored
    template. This structurally defuses prompt-injection from repo content (a
    hostile repo can't smuggle extra SQL into the snippet a user will
    copy-paste). Tailoring applies to `.sql` templates ONLY — `.ts` templates
    ship untailored (tsc verifies compilation, not intent; there is no TS
    equivalent of the AST guard in v1, so TS goes unguarded or untailored —
    untailored wins). If the validation module fails to load at runtime,
    tailoring is disabled entirely (fallback to untailored) — the guard is
    never skipped while tailoring proceeds. `--no-ai` skips.
  - Done-condition: mocked tests for adapt/validate/fallback paths; fixture run
    with mock produces `mongo→jsonb` snippet whose column names match the
    python-service document model fields.

### Stage 7 — Reports

- [ ] **7.0 — Terminal output contract (stdout is the first surface)**
  - Inputs/dependencies: Stage 5 verdicts.
  - Expected output: `src/report/terminal.ts`. Default `analyze` stdout: phased
    progress lines on TTY only ("Scanning… / 4 stores detected / Classifying
    roles… / Scoring…"), then one line per (store,role) — `[CONSOLIDATE]` green /
    `[KEEP]` blue / `[BORDERLINE]` gray, color on TTY, plain when piped, badge
    text never color-only — then an impact-shaped summary line ("You can fold 2
    of 4 stores into Postgres") and a final line naming the single next action
    ("Full report: --out report.md · borderlines: --live <conn>"). Live mode
    shows a sampling countdown ("sampling pg_stat 60s…"). If ANTHROPIC_API_KEY
    is absent and --no-ai not passed: one up-front banner ("Running without AI
    disambiguation — role confidence may be lower"), not scattered annotations;
    a SET-but-rejected key (401) is a distinct message ("ANTHROPIC_API_KEY set
    but rejected — check the key, or pass --no-ai to silence"), never collapsed
    into the generic API-error fallback. Honors `NO_COLOR` in addition to
    piped-output detection.
    Empty repo prints the win-state line. fitScore appears in NO human surface
    (JSON only — the threshold table carries the argument).
  - Done-condition: snapshot tests for TTY and piped output on node-monolith +
    empty fixtures; a test asserts no ANSI codes when stdout is not a TTY.

- [ ] **7.1 — Markdown + JSON reporters**
  - Inputs/dependencies: Stage 5 verdicts, Stage 6 snippets.
  - Expected output: `src/report/markdown.ts`, `src/report/json.ts`. Markdown
    layout, fixed: title + one-paragraph summary ("N stores, K consolidatable, M
    keep, B borderline"); inventory table (store / detected via / roles /
    confidence); per-store sections with verdict badge, the threshold-comparison
    table (observed | threshold | source-link | pass), rationale, collapsible
    snippet block; final "Assumptions used in this analysis" section auto-listing
    every A# the verdicts touched, each citation carrying its `source_grade`.
    JSON = the full Verdict[]/inventory, zod-schema versioned (`schemaVersion: 1`).
    Report-framing rules: (a) **empty state is a win state** — 0 non-Postgres
    stores renders "Nothing to consolidate — this repo is already Postgres-only",
    not an empty table; (b) **decisive axes lead** — each per-store section orders
    threshold comparisons decisive-first (qualitative gates and static signals
    before estimated ranges), and every `borderline` verdict ends with the exact
    next-step command (`postgres-advisor analyze --live <conn>`); (c) an
    "Analysis warnings" section lists skipped/malformed files and detector
    errors; (d) **determinism** — no wall-clock timestamps (unless `--timestamp`),
    repo-relative paths only, stable sort orders, so golden files stay byte-exact;
    (e) **section order is the sort key**: consolidate (confidence desc) → keep →
    borderline last, each borderline framed as a near-verdict ("One number
    decides this: <variable>."), with the follow-up split by the threshold's
    `live_source` tag: `pg-stats` → "Run `<live command>`. If
    <threshold-comparison> → <verdict>."; `incumbent-only`/`none` → the honest
    line from 4.2 (what metric to check on the incumbent store, why v1 can't
    measure it); (f) the headline is impact-shaped ("You can eliminate 2 of 4
    data stores"), counts go in the second sentence; (g) verdict badge lives in
    each store's heading (scannable by headlines alone); (h) every `consolidate`
    section is a **self-contained copy-paste block** (verdict + rationale +
    snippet + sources) that pastes into a ticket without hand-assembly; (i) the
    report header names the product + version ("postgres-advisor vX.Y — repo
    <name> @ <short-sha>").
  - Done-condition: golden-file markdown for node-monolith committed and byte-exact
    in CI; JSON output re-parses through the zod schema; empty-fixture golden shows
    the win-state copy; a warnings-section golden exists (malformed-yaml fixture).

- [ ] **7.2 — HTML report (optional web view)**
  - Inputs/dependencies: 7.1 JSON output.
  - Expected output: `src/report/html.ts` — single self-contained HTML file
    (inline CSS/JS, no CDN), rendering the JSON. Design spec (APP-UI rules, not
    cards): header = product name + version + repo + verdict-summary anchor
    rendered large ("2 of 4 stores consolidatable"); one **sortable table with
    expandable rows** (the data is homogeneous and comparative — a card grid
    scans worse; expand shows evidence, threshold table, snippet + copy button);
    color semantics fixed: consolidate = green (opportunity), keep = neutral
    blue (validated), borderline = gray (one measurement away — NOT warning
    yellow); CSS variables for the color system, one accent, real typeface
    stack declared (no bare system-ui as identity), body ≥16px, contrast
    ≥4.5:1; expand/collapse keyboard-operable (`<details>` or
    button+aria-expanded), semantic `<table>` markup; print stylesheet (rows
    expanded, controls hidden — these get PDF'd for cost reviews); empty state
    renders the same win-state copy as markdown. No framework; string templates
    + `<script>` with the JSON embedded.
  - Done-condition: file opens offline (no network requests — assert no `http` in
    output), renders all fixtures' data (incl. empty win-state); DOM smoke test
    via `happy-dom` incl. keyboard toggle of a row; axe-core-style contrast spot
    check on the palette values in a unit test.

### Stage 8 — Live-workload mode (stretch, but planned concretely)

- [ ] **8.1 — pg_stat_statements collector**
  - Inputs/dependencies: `pg` package; a Postgres with `pg_stat_statements` enabled
    (docker-compose file for tests: `postgres:16` + `shared_preload_libraries`).
  - Expected output: `src/live/collector.ts` + CLI flag `--live <conn-string>`.
    Reads: `pg_stat_statements` (calls/sec by normalized query — classify
    queue-like/cache-like patterns by table name matching the migration snippets'
    target tables), `pg_class.reltuples` (corpus/vector counts),
    `pg_stat_user_tables` (n_tup_ins deltas over a `--live-window 60s` double
    sample → real ingest rate). Read-only; refuses non-SELECT.
  - Done-condition: integration test in CI via docker: sampler interval is
    injectable so the test drives the clock deterministically; CI asserts
    order-of-magnitude correctness (shared runners make a ±20% wall-clock
    assertion a designed-in flake); the exact-rate (±20%) assertion runs in a
    local-only tagged test.

- [ ] **8.2 — Live signals override static estimates**
  - Inputs/dependencies: 8.1, 5.1.
  - Expected output: signal-merge layer — live measurements replace estimated
    ranges (observability upgraded to `static`-equivalent → confidence can reach
    `high`); report annotates which numbers are live vs estimated.
  - Done-condition: golden test — a `pg-stats`-observable borderline becomes
    definitive when fed a mocked live sample (e.g. node-monolith's ES corpus
    size resolved via mocked `reltuples`); markdown shows the "(measured)"
    annotation. (The earlier Kafka example was wrong by construction — Kafka
    traffic is `incumbent-only`, invisible to Postgres stats; kafka stays
    borderline in live mode and the report says so.)

### Stage 9 — Packaging, CI guard, docs

- [ ] **9.1 — npm packaging + GitHub Action**
  - Inputs/dependencies: all prior stages.
  - Expected output: publishable package (`bin: postgres-advisor`), plus
    `action.yml` + `src/action.ts`: runs analyze on the PR's checkout, diffs
    detected stores vs the base branch's committed `postgres-advisor.lock.json`
    (generated by `analyze --write-lock`), and fails/comments when a NEW store
    appears without a **justification entry in the lockfile** — schema (fixing
    the earlier `## Justification`-heading-in-JSON contradiction): per-store
    `justification: { author, date, reason, link? }` field, written by
    `postgres-advisor justify <store-id> --reason "..."`. Comment layout is
    designed for the PR author mid-flow, in this order: (1) what fired ("New
    data store detected: redis (queue)"), (2) **how to get unblocked** — the
    exact `justify` command and a paste-ready block, (3) the verdict section
    from the markdown reporter, collapsed in `<details>`. Comment lifecycle:
    ONE sticky comment per PR, edited in place on subsequent pushes (no comment
    spam); combined when multiple stores fire; after justification lands, the
    comment edits to "justified by <author>: <reason> ✓" and the check passes.
    No new stores → check passes silently, no comment. **Store-id stability
    (the gate's load-bearing contract):** id = content hash of (product +
    normalized instance identity), fallback chain documented; on gate-fire,
    fuzzy-match same-product lockfile entries and surface "possible rename of
    `<old-id>` — run `postgres-advisor justify --migrate-id`" instead of
    hard-failing a store justified last quarter. **Bootstrap:** base branch has
    no lockfile → check PASSES with a comment suggesting `analyze --write-lock`
    (adopting the Action must not fail the adoption PR). **Fork-PR permissions:**
    comment create/edit catches 403 (fork `GITHUB_TOKEN` lacks
    `pull-requests: write`) and degrades to `$GITHUB_STEP_SUMMARY` + check
    output; README documents the `permissions:` block. Verdict/classify
    rationale strings are model output conditioned on repo content — treated as
    untrusted in the comment renderer (escaped/fenced) exactly like file
    excerpts. Lockfile writes use the same canonical ordering + `/`-normalized
    paths as reports (7.1d) so committed lockfiles don't produce diff noise. Precedence rule:
    lockfile `## Justification` is the ONLY mechanism that satisfies the gate;
    `.postgres-advisor.yaml` suppressions do not (they shape local reports only).
    The plain-CLI equivalent (`analyze --fail-on new-store`, exit 1) works in any
    CI, not just GitHub Actions. Action security & modes: the Action defaults to
    `--no-ai` (no secret needed → safe on fork PRs; `anthropic-api-key` input
    opts in for same-repo workflows only); `fail: true|false` input picks
    fail-the-check vs comment-only mode (default `true`); PR-comment content
    derived from repo files (names, excerpts) is always code-fenced/escaped
    (markdown-injection hardening). `postgres-advisor.lock.json` carries its own
    `schemaVersion` with defined mismatch behavior (a committed CI-gating
    artifact cannot have undefined version skew): newer-major lockfile → exit 2
    "regenerate via `analyze --write-lock`"; older-minor → read-compatible with
    a deprecation note in the comment. This repo also ships its own CI workflow
    (`.github/workflows/ci.yml`: install, build, test on Node 20/22) — the golden
    files' "byte-exact in CI" promise needs a CI to run in (belongs to Stage 1.1,
    listed here for visibility).
  - Done-condition: `npm pack` output installs and runs in a clean docker
    container; action tested with `act` or a workflow-level integration test on
    the fixture repos (new-store PR → failing check with verdict comment).

- [ ] **9.2 — README, methodology doc, end-to-end validation on real OSS repos**
  - Inputs/dependencies: 9.1.
  - Expected output: README (first five lines = the npx one-liner + what you
    get; install, quickstart, sample report inlined, `--no-ai` and live-mode
    docs, env-var table [`ANTHROPIC_API_KEY`, `POSTGRES_ADVISOR_MODEL`],
    exit-code table, troubleshooting section [Helm-skipped, minified skips,
    --max-files], `--format json` note for agent/programmatic consumers);
    **config-file reference** with a complete annotated `.postgres-advisor.yaml`
    example and the suppression-vs-lockfile precedence rule stated in both the
    config docs and the Action docs; **Action setup walkthrough** with
    copy-paste workflow YAML incl. `permissions:` block; **lockfile/justify
    lifecycle doc**; `docs/methodology.md` = §1 of this plan
    exported verbatim with the A# table; CHANGELOG.md (semver policy stated),
    MIT LICENSE, CONTRIBUTING.md, GitHub issue templates (bug template asks for
    the report's warnings section); a `scripts/validate-real.ts` that runs the
    tool against 3 cloned real OSS apps (pick candidates with docker-compose files
    that include redis + one other store, e.g. from awesome-selfhosted; record the
    chosen repos and outputs in `docs/validation-runs/`).
  - Done-condition: all three real-repo runs complete without crashes, each
    detects ≥2 stores, and a human-readable review note per run is committed
    stating whether each verdict looks defensible (this is the plan's built-in
    verification step).

- [ ] **9.3 — Benchmark reproduction harness (the vendor-neutrality moat)**
  - Inputs/dependencies: 4.2 (thresholds with source_grade), docker.
  - Expected output: `docs/benchmarks/` + committed scripts reproducing the two
    load-bearing thresholds: SKIP LOCKED queue throughput and unlogged-table
    cache ops/sec, each against `postgres:16` in docker with pinned config and
    a results markdown (hardware noted). The corresponding thresholds.yaml
    entries upgrade `source_grade: vendor → reproduced` with the local results
    linked as a second source.
  - Done-condition: `npm run bench:queue` and `npm run bench:cache` complete on
    a dev machine and emit results markdown; at least 2 thresholds carry
    `source_grade: reproduced`; report renders the upgraded grade.

---

## Open Questions / Assumptions Made

Every judgment call and unverified number, for review before implementation:

**Threshold assumptions (flagged A# in §1 / `rules/thresholds.yaml`):**

- **[A1]** Estimation constant: 0.1–10 jobs/sec per concurrent worker slot when
  converting provisioned worker capacity into a throughput range. Invented spread;
  chosen to be wide enough that the true value is almost certainly inside it, which
  is also what makes many queue verdicts `borderline` by design. Needs calibration
  against real workloads (Stage 9.2 helps).
- **[A2]** Cache consolidation line of 5,000 ops/sec. Derived by taking ~⅓ of the
  measured 16k ops/sec Postgres unlogged-table read rate as headroom; the benchmark
  is a single machine/config (source cited in §1.2), not a general law.
- **[A3]** Search "keep Elasticsearch" corpus line of 100M docs. Conservative pick
  between the "tens of millions degrade" claim (Neon) and the 138M-doc BM25-in-
  Postgres benchmark (TigerData). The right line probably depends on QPS more than
  corpus size, which static analysis can't see.
- **[A4]** Vector "keep" line of 100M vectors. Public pgvectorscale benchmarks stop
  at 50M; the 100M number is an extrapolation, not a measurement.
- **[A5]** Time-series "keep" line of 500k rows/sec single-node sustained ingest.
  No single citable benchmark; assembled from the general shape of TSBS results.
  Weakest numeric claim in the plan.
- **[A6]** Graph category has NO numeric threshold at all — verdicts are purely
  qualitative (traversal shape). Acceptable? Alternative is inventing a number.
- **[A7]** "PostGIS at parity or better than specialized GIS" asserted from its
  reference-implementation status, not benchmarked.
- **[A8]** Document size estimate of ~30 bytes/field average when no seed data
  exists. Pure heuristic; only used to pick which side of the 2 KB TOAST line a
  model likely falls on, and always reported as an estimate.
- **[A9]** Cache fan-out keep-line of ≥10 distinct cache calls reachable per
  endpoint handler. Invented threshold replacing the earlier (wrong-shaped)
  "cache in request hot path → keep" rule, which would have fired on essentially
  every cache. Static call-graph reachability is approximate; the adversarial
  fixture exercises both directions.

**Design judgment calls:**

- Regex call-site harvesting instead of AST/tree-sitter (§0). Trades precision for
  simplicity/speed; mitigated by Claude disambiguation + confidence caps. Revisit if
  fixture false-positive rate is annoying in practice.
- TypeScript over Python despite many target repos being Python (§0 rationale).
- Claude model pinned to `claude-sonnet-5` for classification (3.3) — cost/quality
  guess, trivially changeable via env var `POSTGRES_ADVISOR_MODEL` (branded
  namespace; generic `ADVISOR_MODEL` invites collisions).
- `handlebars` added to the fixed dependency set in 6.1; `libpg-query` for SQL
  validation; `happy-dom` for 7.2 tests.
- Per-(store,role) verdicts mean one physical Redis can yield "consolidate the
  cache role, keep the pub/sub role" — arguably the honest answer, but it makes the
  headline count ("K consolidatable") fuzzier.
- The GitHub Action's justification mechanism (lockfile `## Justification` entries,
  9.1) is invented UX; no prior art followed.
- Live mode (Stage 8) only reads Postgres-side stats. Measuring the *incumbent*
  store's real traffic (Redis INFO, Kafka lag) would ground verdicts far better and
  is deliberately out of scope for v1.
- OLAP dataset-size signals are the weakest detection area; verdicts there will
  often be `borderline/low` without live/warehouse access. Acceptable for v1?
- Fixture ground truths (1.2) and golden verdicts (5.1) are authored by the
  implementer — they encode this plan's expectations, not external validation.
  Stage 9.2's real-repo runs are the counterweight.

## Review Addenda (/autoplan, 2026-07-08)

### System architecture (dependency graph)

```
                       rules/products.yaml  rules/call-patterns.yaml  rules/roles.yaml
                              │                      │                      │
 repo path ─▶ Scanner ─▶ Detectors ──▶ UsageExtractor ──▶ RoleClassifier ──▶ FitScorer ─▶ SnippetGen ─▶ Reporters
              (walk,     compose/deps/    (call-site        (rules first;      ▲   │        (hbs +        (md/json/html)
               ignore     env/orm          harvest,          Claude iff        │   │         Claude        │
               list,      │                caps+skips)       ambiguous)        │   ▼         tailor +      ▼
               symlink    ▼                                                    │  Verdict[]  AST guard)   report +
               off)     DetectedStore[]                                        │                          warnings
                        (merge: product         rules/thresholds.yaml ─────────┘                          section
                         + instance id,         rules/mappings.yaml
                         secret redaction)      .postgres-advisor.yaml (overrides)
                                                [live mode: PgStatsCollector ─▶ FitScorer]
```

Shadow paths, per flow: nil (no files → "0 stores", win-state copy) · empty
(store w/o call sites → role unknown, confidence low) · error (malformed file →
skip + warning; detector crash → isolated + warning; Claude fail/refusal →
deterministic fallback, logged distinctly).

### Error & Rescue Registry

| Codepath | What can go wrong | Rescued? | Rescue action | User sees |
|---|---|---|---|---|
| Scanner walk | EACCES, symlink loop | Y | skip + warning | warnings section |
| Detector parse (yaml/json/toml) | malformed file, YAML bomb | Y | safe-load caps; skip + warning | warnings section |
| Any detector | unexpected throw | Y | per-detector isolation | warnings section; others still report |
| Claude classify | timeout/429/5xx | Y | 1 retry → rule fallback | "(rule-classified; AI unavailable)" |
| Claude classify | invalid JSON | Y | retry once → fallback | as above |
| Claude classify | refusal | Y | fallback (logged as refusal, not JSON error) | as above |
| Snippet tailor | invalid SQL or AST drift | Y | ship untailored template | "(untailored template)" note |
| Rules load | zod validation fails | N — intentional hard fail | exit 2 with named field | "rules file invalid: <path>: <issue>" |
| Live mode | conn refused / auth | Y | exit 2, redacted conn string | actionable message |
| Live mode | pg_stat_statements missing | Y | named remediation | "enable via shared_preload_libraries... " |
| Report write | --out unwritable | Y | exit 2 | plain FS error |

### Failure Modes Registry

| Codepath | Failure mode | Rescued? | Test? | User sees? | Logged? |
|---|---|---|---|---|---|
| Detectors | malformed input files | Y | Y (malformed-yaml fixture) | warnings | Y |
| Harvester | minified/giant files | Y (skip) | Y (synthetic tree) | --verbose count | Y |
| Role classifier | ambiguous mix, no AI | Y (unknown/low) | Y (table-driven) | "ambiguous" verdict text | Y |
| Verdict engine | range straddles threshold | Y (borderline) | Y (golden) | borderline + next-step cmd | Y |
| Env detector | secret in .env | Y (redaction) | Y (fake-password fixture) | redacted value | Y |
| Action | fork PR w/o secrets | Y (--no-ai default) | Y (workflow test) | comment w/o AI extras | Y |
| Claude paths | API down | Y (fallback) | Y (mocked) | fallback annotations | Y |

No row is RESCUED=N/TEST=N/silent → **no CRITICAL GAPS open**. (Rules-load hard
fail is intentional and loud.)

### NOT in scope (deferred with rationale)
SARIF reporter · cost ($/mo) estimation · Go/Java/Rust call patterns ·
incumbent-store live metrics (Redis INFO/Kafka lag/ES _stats) — all in TODOS.md
with revisit triggers. Benchmark reproduction + monorepo attribution pending
final gate.

### What already exists (leverage map)
Greenfield repo — leverage is external: commander/yaml/fast-glob/zod (parsing +
validation), @anthropic-ai/sdk (2 call sites), pg (live mode), libpg-query
(SQL validation + AST guard), handlebars (templates), pgmq/pgvector/ParadeDB/
TimescaleDB/PostGIS/AGE (the consolidation targets — mapped in
rules/mappings.yaml, not rebuilt). No sub-problem re-implements an existing
library's job; detection rule tables are purpose-built data, not code.

### Dream state delta
This plan lands: full static advisor (9 categories) + CI gate + Postgres-side
live mode. Remaining to 12-month ideal: incumbent-store measurement, A1
calibration from real-repo corpus, post-migration verification. Architecture
(observability tags, 8.2 merge layer) makes those additive.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Keep cross-project-learnings config unset (project-scoped search only) | Mechanical | P3 | Avoid silently writing global config from an auto pipeline; reversible any time | Auto-enabling cross-project learnings |
| 2 | CEO | Implementation approach A: as-planned deterministic engine + narrow Claude | Mechanical | P1, P5 | B (inventory-only) deletes the quantified-verdict differentiator; C (LLM-centric) violates ratified premise P6 (determinism, offline, CI) | B minimal-viable; C LLM-centric |
| 3 | CEO | ACCEPT expansion: `.postgres-advisor.yaml` config (suppressions + threshold overrides) | Mechanical | P2 | Regex harvesting guarantees false positives; suppression is table stakes for CI. In blast radius, <5 files, <1d CC | Shipping v1 with no suppression story |
| 4 | CEO | ACCEPT expansion: `--fail-on` flag + exit codes | Mechanical | P2, P6 | CI gating outside GitHub Actions; Action needs the diff logic anyway | Action-only CI integration |
| 5 | CEO | ACCEPT expansion: `explain <threshold-id>` subcommand | Mechanical | P2 | Read-only over rules/thresholds.yaml; amplifies cited-source differentiator | — |
| 6 | CEO | DEFER: SARIF reporter → TODOS.md | Mechanical | P3 | Action comment covers CI UX; SARIF speculative | Adding now |
| 7 | CEO | DEFER: cost estimation → TODOS.md | Mechanical | P3 | Pricing data rots; new maintenance surface outside blast radius | Adding now |
| 8 | CEO | DEFER: Go/Java/Rust call patterns → TODOS.md | Mechanical | P2 | Outside blast radius once fixture validation cost counted | Data-only unvalidated patterns |
| 9 | CEO | Monorepo per-service attribution → TASTE DECISION at final gate | Taste | P2/P3 conflict | Real need; ambiguous blast radius (touches detection identity model) | — |
| 10 | CEO | Mode: SELECTIVE EXPANSION | Mechanical | /autoplan fixed | Autoplan override | Other modes |
| 11 | CEO | Fold accepted expansions into stage tasks 1.1/4.2/9.1 (not just this log) | Mechanical | P5 | Spec reviewer: implementer works stage-by-stage; unsynced scope would silently drop | Treating scope doc as authoritative delta |
| 12 | CEO | Fix §1.2: cache keep-gate = fan-out (≥10 calls/request [A9]) or explicit sub-ms SLO, not hot-path presence | Mechanical | P1 | Subagent finding: hot-path rule fires on ~every cache, contradicting the thesis in the flagship category | Keeping hot-path rule |
| 13 | CEO | Add `source_grade: vendor\|independent\|reproduced` to thresholds.yaml + report disclosure | Mechanical | P1 | Nearly all citations are Postgres-vendor blogs; disclosure defends vendor-neutral position | Hiding the conflict |
| 14 | CEO | Benchmark reproduction scripts (SKIP LOCKED, unlogged cache) → TASTE DECISION at gate | Taste | P1 vs P3 | M effort, new infra (bench harness) — borderline blast radius; strong moat argument | — |
| 15 | CEO | Add persona/trigger + competitive-position paragraphs to §0; soften unsourced 0.3% stat | Mechanical | P1 | Plan had zero words on user/trigger/competition; brand is citations, so unsourced stat softened | Leaving implicit |
| 16 | CEO | Add adversarial fixture (d) + new Stage 3.4 reality checkpoint on 2 real repos before Stage 4 | Mechanical | P1 | Fixtures were demo-shaped; first reality contact was previously after 9 stages | Validation-last sequencing |
| 17 | CEO | Migration-effort estimate on every `consolidate` verdict → TASTE DECISION at gate (recommend accept) | Taste | P1 | Subagent CRITICAL: fit-score without cost side is half a decision; data mostly already harvested; touches frozen §2 types | — |
| 18 | CEO | Roadmap inversion (ship Action gate before verdict engine) → challenge at gate [subagent-only]; default = plan's original stage order | Taste (challenge) | P6 | Single-voice strategic challenge to user's stated sequencing; user decides | Silently resequencing |
| 19 | CEO | Form-factor split (publish ruleset + gate; agents as detectors) → surfaced at gate [subagent-only]; default stands | Taste (challenge) | P6 | Re-litigates premise P6/approach A the user ratified at D2; surfaced once, not auto-adopted | Silently adopting |
| 20 | CEO | Finding "modal output is borderline/low" NOT re-litigated; residual → report-framing guidance in design phase | Mechanical | P6 | User explicitly chose static-first at premise gate D2; verdict logic already runs qualitative gates first | Re-opening premise |
| 21 | CEO §1 | Parse-error policy + detector isolation + walk hardening (symlinks off, ignore list, YAML caps) → 2.1 | Mechanical | P1 | Malformed target-repo files must never crash analysis; silent failures banned | Crash-on-bad-input |
| 22 | CEO §1 | Structured `FieldSummary` type replaces excerpt-string interface into 4.3/6.2 | Mechanical | P5 | Stringly-typed Evidence.excerpt as data interface is fragile | Parsing excerpts downstream |
| 23 | CEO §3 | Secret redaction rule in 2.3 (env values never in Evidence/reports/lockfile/comments) + fixture test | Mechanical | P1 | Highest-impact security finding: report artifacts get committed/posted | Trusting excerpts |
| 24 | CEO §3 | AST-shape equality guard on Claude-tailored snippets → 6.2 | Mechanical | P1 | Defuses prompt-injection → malicious SQL in copy-paste snippets | Syntax-only validation |
| 25 | CEO §3 | Action defaults --no-ai (fork-PR secret safety) + fail/comment-only mode input + comment escaping → 9.1 | Mechanical | P1 | Secrets must not be required on fork PRs; wrong-block mode needs an escape | Secret-required Action |
| 26 | CEO §4 | Merge key = product + instance identity (not product alone) → 2.3 | Mechanical | P1 | Two Redis instances in one compose are two stores; wrong merge poisons per-store verdicts | Product-only merge |
| 27 | CEO §6 | Repo's own CI workflow added (1.1/9.1); report determinism rules → 7.1 | Mechanical | P1 | "Byte-exact in CI" promised with no CI defined; golden files need determinism | Implicit CI |
| 28 | CEO §7 | Skip files >1MB / lines >5k chars in harvester → 3.1 | Mechanical | P3 | Minified bundles: false positives + regex tarpit | Scanning everything |
| 29 | CEO §8 | `--verbose` + Analysis-warnings report section; explicit no-telemetry-in-v1 | Mechanical | P1 | CLI observability = diagnosability; silent skips banned | Silent skips |
| 30 | CEO §9 | Lockfile gets own schemaVersion → 9.1 | Mechanical | P1 | Committed, diffed artifact needs versioned schema | Unversioned lockfile |
| 31 | CEO §11 | Empty state = win-state copy; borderline verdicts end with exact live-mode command → 7.1 | Mechanical | P1 | Empty report is the thesis succeeding; borderline needs a next action | Shrug-shaped report |
| 32 | CEO | Spec review loop on scope doc: 2 iterations, 9 issues fixed, 9/10 PASS | Mechanical | — | Convergence reached; PLAN.md and scope doc consistent | Iteration 3 |
| 33 | Design | Skip interactive mockup/comparison-board loop; offer /design-shotgun post-gate | Mechanical | P6 | Board feedback loop requires live user interaction, incompatible with auto pipeline; designer binary available for later | Blocking pipeline on board |
| 34 | Design | New task 7.0: terminal stdout contract (progress, badges, TTY/piped, impact summary, next-action line) | Mechanical | P1 | First surface every user hits had zero design | Unspecified stdout |
| 35 | Design | Fix justification format contradiction: JSON `justification:{author,date,reason,link?}` + `justify` subcommand + paste-ready PR block | Mechanical | P1, P5 | `## Justification` heading inside a .json lockfile was structurally impossible; this is the CI surface's load-bearing interaction | Markdown-in-JSON |
| 36 | Design | Borderline verdicts render as near-verdicts ("one number decides this" + exact command + threshold outcome) | Mechanical | P1 | Modal output is borderline by design (A1 spread); framing turns homework into one-command resolution | Shrug framing |
| 37 | Design | HTML report: expandable-row table replaces verdict cards; color semantics green/blue/gray; a11y + print spec; tokens | Mechanical | P5, P1 | Cards were an unexamined default (hard-rejection #7); comparative homogeneous data reads better as rows | Card grid |
| 38 | Design | fitScore suppressed in human surfaces (JSON only) | Mechanical | P5 | Unexplained 0-100 invites misreading; threshold table carries the argument | Displaying score |
| 39 | Design | Sticky single PR comment, edited in place; silent pass when no new stores; post-justify state shown | Mechanical | P1 | Comment-spam bots get muted; lifecycle hygiene is the Action's UX | New comment per push |
| 40 | Design | Report ordering consolidate→keep→borderline; impact-shaped headline; ticket-shaped consolidate blocks; product header | Mechanical | P1 | Payoff first; census language demoted; 24h-to-ticket promise gets a layout guarantee | Detection-order sections |
| 41 | Design | No DESIGN.md: minimal inline token spec now; full aesthetic direction deferred → /design-consultation | Mechanical | P3 | Utility surface ships with utility tokens; brand exploration is separate scope | Inventing a brand mid-review |
| 42 | Eng C1/C2 | Harvester precision: import-scoped scanning, receiver tracking, instance attribution via client construction sites; decoy + two-Redis fixtures | Mechanical | P1, P5 | Bare method regex classifies `Map.get` noise as a high-confidence cache; multi-instance attribution was unspecified | Naked regex + 200-cap of junk |
| 43 | Eng C3 | `live_source: pg-stats\|incumbent-only\|none` tag; --live next-step only when pg-observable; 8.2 Kafka done-condition rewritten | Mechanical | P1 | "Run --live" was a dead end for incumbent-store variables — circular promise | Uniform --live copy |
| 44 | Eng H1/H2 | WASM libpg-query; tailoring .sql-only; guard-unavailable → tailoring disabled (never guard-skipped); Alpine install smoke test | Mechanical | P1 | Native builds brick npx installs; TS templates were an unguarded injection channel | Native module + tailored TS |
| 45 | Eng H3/H4 | Store-id = content hash + rename fuzzy-match; bootstrap passes; 403-degrade to step summary; rationale escaped; lockfile canonical order | Mechanical | P1 | Gate's id contract was unspecified; fork comment writes would 403 at 2am | Hard-fail on rename/bootstrap |
| 46 | Eng H5 | A9 redefined as lexical-span heuristic + `cacheFanOut` extractor added to 4.3 | Mechanical | P5 | Call-graph reachability is unimplementable with line-regex; honest crude heuristic instead | Unimplementable gate |
| 47 | Eng M1-M10 | compose.y?ml + Helm skip + env-interpolated images; celery unknown-broker; multi-role classify schema; replay-signal enumeration; BOM/binary sniff; single-pass scan + 100k perf test; scoring constants to yaml; deterministic 8.1 sampler; codepoint sort + placeholder sha | Mechanical | P1, P4 | Ten medium correctness/consistency fixes, all in blast radius | Leaving as latent bugs |
| 48 | Eng minor | Config invalid = hard fail; dims table to products.yaml; `/`-normalized paths; type-freeze closes at this session's final gate | Mechanical | P5 | Consistency with rules-file policy and data-not-code principle | Divergent policies |
| 49 | DX | Bare `npx postgres-advisor` = `analyze .`; path defaults `.`; Node engine guard with friendly message | Mechanical | P1 | Champion-tier TTHW is one command in the repo root; Node 18 users deserve a sentence, not a stack trace | Required positional |
| 50 | DX | Discoverability: `explain --list`, ids in threshold tables + terminal, store ids printed locally | Mechanical | P5 | `explain <id>`/`justify <id>` referenced identifiers no surface displayed | Undiscoverable ids |
| 51 | DX | `--fail-on` comma-list semantics + no-lockfile exit 2; piped stdout carries only the artifact; NO_COLOR; 401 distinguished; error convention problem+cause+fix+docs anchor; config error shows shape | Mechanical | P1 | Fight-uncertainty principle: what happened, why, how to fix | Ambiguous CI semantics |
| 52 | DX | Docs completeness in 9.2: config reference + precedence, Action walkthrough, lockfile/justify lifecycle, exit codes, troubleshooting, env-var table, CHANGELOG+semver, LICENSE, CONTRIBUTING, issue templates; lockfile schemaVersion mismatch behavior; `ignore:`/`paths:` config; POSTGRES_ADVISOR_MODEL rename | Mechanical | P1 | The load-bearing subtleties (precedence, version skew) burn users if undocumented; first breaking release must not strand adopters | Docs as afterthought |
| 53 | DX | `init` subcommand (workflow generator) NOT added — DX POLISH mode forbids scope additions | Mechanical | P3 | Copy-paste walkthrough covers it; generator → TODOS.md | Adding scope in POLISH mode |
| 54 | Gate | USER APPROVED: migration-effort on consolidate verdicts → Verdict.migrationEffort + 5.2/7.1h rendering | User (gate D3) | P1 | Fit score without cost side is half a decision; data already harvested | One-sided verdicts |
| 55 | Gate | USER APPROVED: benchmark reproduction harness → new Stage 9.3; source_grade upgrades to `reproduced` | User (gate D3) | P1 | Vendor-neutrality moat; the two load-bearing thresholds get first-party evidence | Vendor-only citations |
| 56 | Gate | USER APPROVED: monorepo attribution DEFERRED; C1 instance attribution + ignore:/paths: are the interim answer | User (gate D3) | P3 | Real need not yet demonstrated; identity model stays simple in v1 | Speculative complexity |
| 57 | Gate | Challenge 1 (roadmap inversion) RESOLVED: original stage order stands | User (gate D3) | — | Single-voice challenge; user retains sequencing | Gate-first resequencing |
| 58 | Gate | Challenge 2 (form-factor split) RESOLVED: deterministic CLI stands per ratified P6; ruleset+methodology treated as first-class assets within it | User (gate D3) | — | Premise gate D2 + final gate agree | Ruleset-only product |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR (via /autoplan) | 8 proposals, 3 accepted, 4 deferred, 1 gated→deferred |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — (Codex CLI not installed) | all outside voices ran as Claude subagents |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (via /autoplan) | 23 issues, 0 critical gaps open |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (via /autoplan) | score: 5/10 → 8/10, 9 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | CLEAR (via /autoplan) | score: 5/10 → 8/10, TTHW: ~2 min → <2 min |

- **VERDICT:** CEO + ENG + DESIGN + DX CLEARED — ready to implement. All four phases ran at commit 4b11bdf; final approval gate passed 2026-07-08 (approve as-is).

NO UNRESOLVED DECISIONS
