# Delivery plan and acceptance gates

This is the original dependency-ordered plan for the full hosted product. The code now contains a connected local implementation spanning parts of these stages, using SQLite and a trusted-machine credential. Those local capabilities do not satisfy the remaining PostgreSQL, multiuser authentication, GitHub App, vector-search or production acceptance gates. See [LOCAL_MVP.md](LOCAL_MVP.md) for actual local behavior; record verified checks separately.

## Current local baseline

The repository implements a Next.js interface, authenticated loopback API, local SQLite evidence/job storage, command wrapper/outbox, sessions, cited recall and three read-only MCP retrieval tools. Default memory processing produces labeled observations; optional HTTP AI requires deliberate configuration. GitHub context is an explicit bounded manual import through authenticated `gh`, while OAuth/App registration and continuous sync remain separate. The draft PostgreSQL schema is not an applied migration. The stages below remain the full product's delivery and acceptance plan; code presence is not proof that their gates have passed.

## Stage 1 — Contracts and durable ownership

Implement versioned event/error/summary schemas, stable user/workspace/repository IDs, migration workflow, scoped query context and access generation. Decide supported Node/PostgreSQL versions, provider adapter and OS credential integration. Keep all configuration validated.

Gate: database constraints reject cross-workspace references; runtime schemas reject malformed input; clean setup and migrations work; no client imports server-only packages or secrets.

## Stage 2 — One authorized GitHub repository

Implement browser sign-in, verified GitHub App linking, one repo import, raw webhook HMAC, durable delivery deduplication, bounded incremental sync and truthful state. Add all/selected repo UI after one repo succeeds.

Gate: sign out/in retains history; arbitrary installation binding fails; duplicate webhook has one import effect; transaction failure leaves checkpoint unchanged; denied/revoked repo is inaccessible.

## Stage 3 — Reliable Windows capture

Implement device pairing and credential store, repo init, explicit wrapper, streaming redaction, local SQLite, crash recovery, event UUID/session sequence, output/diff limits and clear shell support. Keep interactive PTY deferred.

Gate: failing and successful `npm` commands are captured; missing executable is stored; large output stays bounded without deadlock; secrets spanning chunks are covered by the chosen rules; identical commands remain distinct; offline work survives restart.

## Stage 4 — Transactional intake

Implement `/v1/events/batch`, exact ACKs, canonical payload conflicts, event+queue atomicity and safe retries.

Gate: lost response followed by resend produces one execution; concurrent new local row remains pending; queue enqueue failure rolls back evidence; conflicting event ID rejects the batch; revoked token cannot upload.

## Stage 5 — Raw timeline and structured memory

Build repository/session timeline and source detail first. Implement bounded worker enrichment, validated summaries, source IDs, input versions, retries and final-write generation guards. Add embeddings after lexical/raw access is functional.

Gate: provider outage preserves usable raw history; invalid citations fail validation; stale job cannot overwrite newer evidence or resurrect deletion; passing command is not automatically described as a proven fix.

## Stage 6 — Shared recall

Implement one authorized exact/full-text and optional vector retrieval pipeline. Connect website ask and `memvora ask`. Add version/time conditions and insufficient-evidence behavior.

Gate: known earlier error is retrieved with resolvable sources; unrelated query says insufficient evidence; every branch excludes forbidden repository events, summaries and vectors; query limits prevent full-history materialization.

## Stage 7 — Local MCP and complete demo

Add read-only stdio tools over the same API. Write setup steps for an actual client. Finish denial/empty/error states, dev onboarding and the two independent error demonstrations in [PRD.md](PRD.md).

Gate: website, CLI and MCP recover the same evidence; protocol stdout is clean; no tool runs shell commands; clean install, lint, types, relevant tests and production builds pass.

## Stage 8 — Operational readiness

Exercise repository revocation and workspace deletion under concurrent ingestion/worker load. Set retention and quotas. Measure proposed latency/search goals on a documented dataset. Configure safe logs, backups, readiness, graceful shutdown and CI.

Gate: explicit measured results with environment noted; no unsupported speed claims; no dev bypass in production; tombstones fence old outboxes and jobs.

## Next releases

1. Interactive PTY/ConPTY with reliable command boundaries and merged-stream labeling; preserve wrapper mode.
2. Company-owned workspaces, membership/roles, handover/offboarding and retention policy designed before sharing personal data.
3. Rich code-review, incident and upgrade views backed by actual evidence rather than generated dashboard metrics.
4. Remote MCP with a reviewed transport/authorization design.
5. Extract enrichment or ingestion services only after measured scale, isolation or ownership needs justify them.

## Working agreement for implementation

Choose one small vertical task and list its acceptance checks before editing. Use the custom project skills and root `AGENTS.md`; inspect existing code before changing contracts. Do not ask an assistant to implement the entire PRD in one unreviewed pass. Keep migrations, contract changes and behavior changes explicit. Add meaningful tests around invariants and regressions; avoid tests that only reproduce the implementation. Record incomplete integration honestly and remove fixtures from production paths.
