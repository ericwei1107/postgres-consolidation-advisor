# Stage 3 reality checkpoint

Run date: 2026-07-09. These are detection and role-classification runs only;
the verdict engine does not exist yet. Both runs used the built CLI and
`--no-ai`, so the output is reproducible without an API key.

Command:

```sh
node dist/cli.js analyze <clone> --no-ai --format json --out <result>.json
```

## [Outline](https://github.com/outline/outline)

- Revision: `f0f935e38e8ceb396580fb0222a31b208fb0d269`
- Compose file: `docker-compose.yml`
- Result: completed without a crash.
- Detected: four Redis identities: `redis:redis`, `redis:127.0.0.1:6379`,
  `redis:localhost:6379`, and an unattributed `redis:default` dependency
  bucket.
- Assigned roles: `redis:default` is `queue` / high (the `bull` dependency);
  the three URL-derived identities are `unknown` / low.

Manual inspection confirms one Compose Redis service. It is used by Bull queues,
cache helpers, WebSocket pub/sub, rate limiting, and locks. The prior run also
reported MongoDB solely because ProseMirror constructs `new Schema(...)`.

Findings:

| Finding | Disposition |
| --- | --- |
| ProseMirror schemas were falsely detected as Mongoose/MongoDB. | **Fixed:** the ORM detector now requires an explicit Mongoose import or `require` before treating `new Schema(...)` as a Mongoose model; a regression test covers the exact shape. |
| Bull queue usage was missed because `bull` was absent from Redis dependency, call-pattern, and role rules. | **Fixed:** added `bull` as a Redis queue library and regression coverage for high-confidence queue classification. |
| Dev/test/sample `REDIS_URL` values and the Compose service are reported as distinct identities; static analysis cannot prove they are alternate environments. It also cannot track singleton receivers such as `Redis.defaultClient`, so cache/pub-sub/rate-limit roles remain unknown. | **Known limitation:** instance identity is intentionally evidence-based. The report warning identifies this ambiguity; use path ignores or live/AI follow-up until environment profiles and static singleton receivers are modeled. |

## [Activepieces](https://github.com/activepieces/activepieces)

- Revision: `c801a1766e52cc5d2f28d580b9c04885f43990cf`
- Compose file: `docker-compose.yml`
- Result: completed without a crash.
- Detected: Redis (`redis:redis`), MinIO benchmark services, plus MongoDB,
  Pinecone, Qdrant, and RabbitMQ dependencies from community connector packages.
- Assigned roles: Redis `queue` / high; MongoDB `document` / high; Pinecone and
  Qdrant `vector` / high; RabbitMQ `queue` / high; MinIO identities `unknown` /
  low.

Manual inspection confirms the primary Compose deployment contains Postgres and
Redis, with five worker replicas. The Redis/BullMQ queue classification is
correct. The other products are connector integrations under
`packages/pieces/community`, not backing stores deployed by Activepieces. The
MinIO services are confined to `benchmark/docker-compose.minio.yml`.

Findings:

| Finding | Disposition |
| --- | --- |
| Nested package manifests in a plugin/connector monorepo look like application dependencies, producing MongoDB/Pinecone/Qdrant/RabbitMQ false positives. | **Known limitation:** dependency detection intentionally scans all manifests and has no plugin-package boundary yet. Restrict `paths` or add `ignore: ["packages/pieces/community/**"]` for this repository. |
| Benchmark Compose files look like production topology, producing MinIO false positives. | **Known limitation:** Compose scanning is recursive and does not infer deployment intent. Add `ignore: ["benchmark/**"]` for this repository. |
| Helm templates are skipped. | **Known limitation:** surfaced as a warning; this run's root Compose file provided the relevant topology. |

## Checkpoint outcome

Both repositories completed without crashes. Every false positive or negative
found during manual inspection is fixed above or recorded as a known limitation;
Stage 4 may proceed from this detector baseline.
