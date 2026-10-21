# Data model and invariants

Status: logical target schema, not a claim that migrations already implement every table. Use [API.md](API.md) for public DTOs. Database names can differ from DTO names through explicit mappings.

## Ownership

A stable workspace owns memory. A login session authenticates a person but never owns repository history. MVP has one personal owner per workspace; organizations and membership are future work. Every domain record that contains or references evidence carries `workspace_id`. Repository-scoped records additionally carry `repository_id`.

Use composite unique keys and foreign keys to prevent cross-workspace and cross-repository links at the database boundary. A workspace-only key cannot prevent two repositories within that workspace from being linked accidentally. Repository-scoped parent records expose unique `(workspace_id, repository_id, id)` keys, while their children carry the same scope in every foreign key. UUIDs being hard to guess is not authorization. Centralized scoped queries remain required even with database constraints.

## Logical tables

| Table                  | Important fields                                                                                                                                                               | Constraints / purpose                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                | id, github_user_id, display_name, created_at                                                                                                                                   | Stable GitHub numeric ID unique; username can change.                                                                                                         |
| `workspaces`           | id, owner_user_id, status, generation, created_at, deleted_at                                                                                                                  | Active/deleting/deleted fence; preserve minimal tombstone after purge.                                                                                        |
| `web_sessions`         | id, user_id, token_hash, expires_at, revoked_at                                                                                                                                | Authentication lifetime only; never used to scope evidence history.                                                                                           |
| `device_pairings`      | id, user_code_hash, device_code_hash, status, expires_at, approved_by, consumed_at                                                                                             | Distinct codes; single atomic consumption; short retention.                                                                                                   |
| `credentials`          | id, workspace_id, principal_id, token_hash, scopes, generation, expires_at, revoked_at, last_used_at                                                                           | Never store raw bearer token.                                                                                                                                 |
| `github_installations` | workspace_id, installation_id, account_id, status, checked_at                                                                                                                  | Link only after user authority verification; suspension/removal visible.                                                                                      |
| `repositories`         | id, workspace_id, github_repository_id, installation_id, full_name, default_ref, access_status                                                                                 | Stable GitHub numeric repo ID; rename updates presentation only.                                                                                              |
| `repository_syncs`     | workspace_id, repository_id, ref, checkpoint_sha, status, last_error_code, updated_at                                                                                          | Unique workspace/repo/ref; checkpoint advances with artifacts in one transaction.                                                                             |
| `webhook_deliveries`   | delivery_id, event_type, payload_digest, received_at, status                                                                                                                   | Unique GitHub delivery ID; bounded retention; no secret logging.                                                                                              |
| `sessions`             | id, workspace_id, repository_id, device_id, title, started_at, ended_at, status                                                                                                | Investigation grouping independent of web session.                                                                                                            |
| `execution_events`     | id, workspace_id, repository_id, session_id, sequence, payload_digest, command, args, shell, cwd, started_at, ended_at, outcome, exit_code, signal, commit_sha, capture_status | Unique workspace/event ID; unique session sequence; finalized payload immutable.                                                                              |
| `artifacts`            | id, workspace_id, repository_id, kind, content_hash, commit_sha, path, encoding, size_bytes, content_or_blob_ref, redaction_info, truncation_info                              | Content dedup scoped to workspace/repo and representation; hashes never replace event IDs.                                                                    |
| `event_artifacts`      | workspace_id, repository_id, event_id, artifact_id, role, ordinal                                                                                                              | Output chunks, starting/ending diffs and referenced code; scoped foreign keys require event and artifact to belong to the same repository; ordering explicit. |
| `memories`             | id, workspace_id, repository_id, session_id, current_version, input_version, status, error_code                                                                                | Logical memory and current processing state.                                                                                                                  |
| `memory_versions`      | workspace_id, repository_id, memory_id, version, input_version, prompt_version, provider_config_id, structured_summary, created_at                                             | Scoped parent-memory foreign key; unique scoped memory/version and input/config dedup key. Superseded versions remain traceable subject to retention.         |
| `evidence_links`       | workspace_id, repository_id, memory_id, memory_version, event_id, artifact_id, locator, claim_role                                                                             | Reference a scoped memory version and at least one valid source in that same repository; no arbitrary source IDs.                                             |
| `search_documents`     | workspace_id, repository_id, source_kind, source_id, text_vector, content_version                                                                                              | GIN full-text index and scoped metadata indexes.                                                                                                              |
| `embeddings`           | workspace_id, repository_id, source_id, content_version, embedding_model_id, dimension, vector                                                                                 | Vectors from incompatible models never mixed. Dimension follows selected provider/migration.                                                                  |
| `audit_events`         | id, workspace_id, actor_id, action, target_id, request_id, created_at, safe_metadata                                                                                           | Access/lifecycle diagnostics; no raw token, terminal output or source code.                                                                                   |

Queue tables belong to the queue library. Domain records retain processing state/provenance without depending on opaque queue internals. A transactional domain outbox may be added if the chosen queue integration cannot use the active evidence transaction.

### Required relational scope constraints

The target migrations must include these ownership relationships, not only unscoped foreign keys to globally unique IDs:

- `sessions`, `execution_events`, `artifacts`, and `memories` reference `repositories` through `(workspace_id, repository_id)`. Sessions, events, artifacts, and memories each expose unique `(workspace_id, repository_id, id)` keys for child references.
- An event's `(workspace_id, repository_id, session_id)` references its session. A memory uses the same scoped session reference when a session is present.
- `event_artifacts` references its event and artifact through `(workspace_id, repository_id, event_id)` and `(workspace_id, repository_id, artifact_id)`, respectively.
- `memory_versions` references its parent memory through `(workspace_id, repository_id, memory_id)` and exposes a unique `(workspace_id, repository_id, memory_id, version)` key. `evidence_links` references that complete version key and uses the same repository scope for its event and artifact foreign keys.
- A check constraint requires at least one of `event_id` or `artifact_id` on an evidence link. When both identify an event artifact, validate the pair against `event_artifacts` rather than accepting two unrelated sources from the same repository.

These are internal relational requirements. Public event payloads already contain `repositoryId`; clients do not supply an authoritative `workspaceId`. The server resolves workspace ownership and maps external IDs to scoped database keys. A future feature linking memories across repositories needs an explicit authorized relationship and contract change; it must not weaken these MVP constraints implicitly.

## Execution and artifact identity

Every actual invocation receives a fresh random UUID, including a repeated command producing identical output. A session sequence orders captured executions from a single session and must be allocated atomically locally. Server uniqueness is `(workspace_id, event_id)`, with the immutable canonical payload digest used to detect ID reuse.

An output artifact or file chunk may share content with another execution. Deduplicating its bytes is safe if links retain each execution's identity, order and scope. Content-hash deduplication must not merge attempts, overwrite timestamps, combine repositories or remove failed commands.

Do not change already-uploaded event payloads when adding later human notes or resolving an investigation. Store annotations and outcome updates as separate versioned records. Reused event ID plus changed immutable payload is a conflict, not an update.

The implemented local schema7 journal uses `local_session_notes` for immutable UUID/body/kind/author/time/event-link records with workspace/repository/session generation snapshots and an append ordinal. `local_session_note_fts` indexes only redacted bodies through transactional insert/delete triggers. A note is a user-authored claim, including the `resolution` kind, rather than an observed or independently verified outcome. Each appended entry is a separate immutable authored record; corrections append new entries. Parent deletion removes records and FTS content. This local implementation does not apply or complete the hosted annotation/authentication model above.

## Local SQLite model

`local_sessions` stores current repo/session binding and next sequence. `local_executions` records started/running/finalized state, metadata and completeness. `local_output_chunks` stores redacted chunks with stream and ordinal. `outbox` stores immutable finalized envelope, payload digest, retry count, next attempt time, last error and state. `local_schema_version` tracks migrations.

Finalize execution and enqueue its immutable envelope in one local transaction. Started/running rows found after process crash become incomplete captures with known evidence; do not synthesize a successful exit. Upload selects a fixed snapshot of event IDs. Exact ACK updates only those matching rows. A new row created while uploading cannot be marked synced accidentally.

The outbox must not include raw credentials. Store an OS credential reference in configuration. Scoped local configuration can contain endpoint URL, repo binding, exclusion policy, output limits and a schema version. Git-ignore local generated capture data even if it is redacted.

## Summary contract

```ts
type InvestigationSummary = {
  problem: { text: string; evidenceIds: string[] };
  attempts: Array<{ step: number; action: string; observedResult: string; evidenceIds: string[] }>;
  changes: Array<{ description: string; evidenceIds: string[] }>;
  outcome: {
    status: 'unresolved' | 'check_passed' | 'user_confirmed';
    description: string;
    evidenceIds: string[];
  };
  unresolvedQuestions: string[];
  uncertainty: string[];
};
```

This is the target summary shape; implement runtime schemas and limits before exposing it. An evidence ID must be a member of the bounded input bundle and resolve to an authorized record. `check_passed` means a recorded relevant check passed; it does not claim a causal proof. An outcome cannot become `user_confirmed` because the model guessed it. Preserve a separate user-authored confirmation record.

## Indexing and retrieval

- B-tree indexes begin with workspace/repository for timeline and source-detail lookups. Use stable keyset pagination `(started_at, id)` or `(sequence, id)`.
- GIN full-text search indexes normalized searchable projections. Keep original redacted evidence independently inspectable.
- Vector indexes are added after workload and model selection. Every vector query includes current allowed scope and compatible embedding model/version.
- A source update or deletion invalidates its derived searchable representation; stale embeddings cannot remain readable after access removal.
- Store content and input versions on derived records. Rebuild a summary or embedding without mutating original evidence.

## Migration and retention rules

Use reviewed, versioned Drizzle migrations. Never run automatic destructive schema pushes against shared environments. Prove rollback/recovery for destructive changes through backup or forward repair. Queue/application versions must be compatible during deploys.

MVP retains evidence until user deletion, subject to configured storage limits shown before capture. Local synced-row cleanup and server retention are separate policies. Exceeding a limit yields an explicit block/truncation state; never silently discard unsynced evidence. Backup expiry, operational audit retention and legal/organization policies must be defined before a public service launch.

## Required invariant tests

1. Foreign keys reject a memory citation to a different workspace or repository.
2. Same event retransmission is idempotent; same ID with a different digest rolls back.
3. Identical content across executions preserves both event identities.
4. Failed checkpoint transaction leaves old checkpoint and artifacts consistent.
5. Deleting workspace generation prevents a previously claimed worker from committing.
6. Revoked repository filters exclude raw events, summaries and vector candidates.
7. A newer input version makes older enrichment output stale and uncommittable.
