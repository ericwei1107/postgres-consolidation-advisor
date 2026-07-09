# fixtures/

Miniature but realistic apps that everything downstream validates against.
Committed as plain files (no `node_modules`, nothing installed) — detectors read
them as text. Each fixture ships an `expected-inventory.json`: the ground truth
that the detection engine (Stage 2) must reproduce.

## Ground-truth conventions

- **Postgres is never inventoried.** Every fixture below (except `empty` and
  `edge-cases`) runs on Postgres and says so in `docker-compose.yml` / `pg` /
  `schema.prisma`. That is on purpose: the inventory lists only the *non-Postgres*
  stores that get a verdict, so the fixtures also prove Postgres is correctly
  treated as the consolidation target, not as a store to flag.
- `expected-inventory.json` is a `DetectedStore[]` (see `src/types.ts`). Each
  entry carries detection-level `evidence` only — `compose` / `dependency` /
  `env` / `orm-schema`. Call-site evidence and role refinement are Stage 3, not
  part of the detection ground truth.
- `id` is `<product>:<fixture>` here for readability. The shipped tool computes a
  content hash (Stage 9.1); Stage 2 matches detections on `product` + `file`, not
  on the exact `id` string.

## What each fixture exercises

| Fixture | Stack | Non-Postgres stores (ground truth) | Designed to exercise |
|---|---|---|---|
| `empty` | none | *(none)* | The win state: `analyze` exits 0, "0 data stores detected". |
| `node-monolith` | Express + Prisma/Postgres | `redis` (cache **and** queue), `elasticsearch` (search) | One physical Redis with two roles (GET/SET/EXPIRE cache + BullMQ queue); multi-evidence dedup (compose + dependency); `deploy.replicas: 2` + BullMQ `concurrency: 10` capacity signals; Postgres present but not inventoried. |
| `python-service` | FastAPI + SQLAlchemy | `redis` (Celery queue), `mongodb` (document), `pinecone` (vector) | Celery broker resolved from a **literal** URL to Redis; Mongo document model with a nested object, an array, and an `$inc` counter (doc-size + counter-shape inputs); Pinecone (`text-embedding-3-small`, 1536-dim) with no container. |
| `edge-cases` | FastAPI | `kafka` (env-only), `memcached` (compose-only) | Env-var-only detection (`KAFKA_BROKERS`, no client lib); a store in compose but unused in code; a **commented-out** dependency that must produce NO detection. |
| `adversarial` | Express + Postgres | `redis` (cache), `kafka` (queue), `elasticsearch` (search) | False-positive-direction shapes: Redis as a latency-irrelevant session store; Kafka as a dumb work queue (no consumer groups/replay — must NOT trip the streaming gate); Elasticsearch as daily-index log storage (SHOULD trip the log-analytics keep); a >=10-reads-per-request fan-out cache endpoint (A9 fan-out keep). |

The role/verdict expectations called out for `adversarial` (and the capacity
signals in `node-monolith`/`python-service`) are exercised by later stages
(role classification 3.x, scoring 5.x). Stage 1.2 only fixes the **inventory**
ground truth in `expected-inventory.json`.
