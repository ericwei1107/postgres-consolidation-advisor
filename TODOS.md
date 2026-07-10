# TODOS

Deferred scope from /autoplan review (2026-07-08). Each entry names its revisit trigger.

## Deferred from CEO review (Phase 1)

- [ ] **SARIF reporter** — GitHub code-scanning integration. Revisit when: users ask
  for code-scanning annotations; the Action's PR comment covers the CI UX until then.
- [ ] **Cost estimation module** ($/mo of kept stores from managed-service pricing) —
  Revisit when: a maintained pricing data source exists; pricing tables rot too fast
  to hand-maintain. Note: the migration-effort field (gate decision #17) covers the
  effort side of cost; this item is the dollars side.
- [ ] **Go/Java/Rust call-pattern rules** — patterns are cheap data
  (rules/call-patterns.yaml) but unvalidated without fixture coverage. Revisit:
  post-v1, add one fixture per language WITH the patterns.
- [ ] **Incumbent-store live metrics** (Redis INFO, Kafka consumer lag, ES _stats) —
  the v2 flagship. Turns most borderline verdicts definitive and enables
  before/after migration proof. Architecture already accommodates (observability
  tags + live-override merge layer, Stage 8.2).
- [x] **Benchmark reproduction harness** — ACCEPTED at final gate 2026-07-08 →
  now PLAN.md Stage 9.3. (Kept here for traceability.)
- [ ] **Monorepo per-service store attribution** — DEFERRED at final gate
  2026-07-08. v1 ships single-inventory per repo; eng fix C1 (per-instance
  call-site attribution) covers multi-instance-within-one-app. Revisit when a
  real monorepo user hits the limit; `ignore:`/`paths:` config is the interim
  escape hatch.
- [ ] **`init` subcommand** (generates Action workflow + initial lockfile) — deferred by DX POLISH mode; copy-paste walkthrough in README covers v1. Revisit on user feedback.

## Deferred from mid-implementation lint (2026-07-10)

Findings from the whole-codebase review after Stage 5.1; each was judged not
worth fixing before its natural stage. Fixed in the same review (for the
record): call-site secret redaction, threshold_overrides in verdicts,
`suppress`, the default-bucket confidence cap, Gemini weak-role-only
replacement, the roles.yaml `command_mix` partition, traversalShape comment
stripping, and the `--write-lock` error copy.

- [x] **Orphaned signals** — RESOLVED in 5.2: `embedding-dims` now drives an
  HNSW RAM-math note (`vectorRamNote`, PLAN.md §1.5) rendered whenever a
  `count-vectors` band comparison fires; `dbt-model-count` now surfaces as a
  presence-signal note (`olapPresenceNote`, §1.7) on the OLAP total-axis-absence
  path, the only place it was ever meant to matter. Both render via
  `RationaleContext.note` in `src/scoring/rationale.ts`.
- [x] **Role confidence doesn't feed verdict confidence** — RESOLVED in 5.2:
  `capByRoleConfidence` caps verdict confidence at `low` when the role
  classification itself was `low` (a `medium`/`high` role confidence is left
  alone — it already means "we're sure this is the role," so a permanently-
  unresolvable supporting axis can still earn `high`, PLAN.md §1.2/§1.3). No
  existing fixture had a `low`-confidence non-`unknown` role, so this was a
  no-op on all goldens; `weight`/`default_weight` are now wired into fitScore's
  band-distance calculation (`weightedDistance`) — also a no-op today since
  every threshold's weight equals `default_weight`.
- [x] **roles.yaml has no fixed_role for memcached/influxdb/clickhouse/neo4j** —
  RESOLVED in 5.2: all four now have `fixed_role` entries. This surfaced a new,
  correct case in the `edge-cases` golden (a compose-detected-but-unused
  `memcached` store now gets a `borderline`/`low` verdict instead of being
  silently dropped as `unknown`) — folded into the 5.2 golden refresh.
- [ ] **Evidence line attribution is first-match-in-file** — compose.ts
  (`replicas:`, env keys) and queueThroughput.ts point at the first matching
  line in the file, which can be the wrong service's line in multi-service
  compose files. Cosmetic until reports render clickable evidence (7.1).
- [ ] **docUpdateShape counts `$set/$inc/$push` across whole files**, not just
  inside update calls — can over-count from comments/aggregations. Acceptable
  for a gate that only needs >0, tighten if it misfires on real repos (9.2).
- [ ] **Repeated filesystem walks** — every detector and several signal
  extractors glob/read the tree independently (extractOrmModels runs twice by
  design). Fine at fixture scale; add a shared file-listing cache if 9.2's
  real-repo runs are slow.
- [ ] **redact.ts doesn't scrub query-string secrets** (`?api_key=...` in an
  otherwise credential-free URL). Extend when the reporters land (7.1) so the
  rule is tested against rendered output.
- [x] **package.json `files` lists `templates/`** — RESOLVED in 6.1: the
  directory now exists (9 templates) and `npm pack --dry-run` confirms it
  ships.
