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
