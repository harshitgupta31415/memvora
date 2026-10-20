# Memvora product requirements

Owner: harshitgupta31415 · Product lead: Harshit Gupta · Team: Himanshu Mittal, Gaurav Basnal, Yash Lalwani

Status: implementation plan for a new build · Updated: 21 October 2026

This document describes the intended product. A scaffold, a health endpoint, example data, or a passing unit test does not mean the connected product has been delivered. Track actual completion in [ROADMAP.md](ROADMAP.md).

## 1. Product purpose

Memvora preserves the evidence behind engineering work: commands, errors, code changes, relevant repository context, and checks. It turns that history into retrievable, cited memories so a developer or their coding assistant can recover how an earlier investigation progressed.

The central promise is: **find the earlier failure, the approaches tried, the change made, and the evidence for the outcome without rebuilding the investigation from memory.** Recorded activity supports inference about decisions; it does not expose a person's thoughts or establish that one change caused a result.

### Problem

Git captures committed changes, but frequently omits failed attempts, local errors, setup details, and the reason behind a workaround. Terminal output disappears. AI sessions lose context. A developer returning after several months repeats work; a teammate inheriting a codebase reconstructs it through messages and meetings.

### First release

One developer, a personal workspace, one or more explicitly authorized GitHub repositories, a Windows command wrapper, a website, `memvora ask`, and read-only MCP tools. All clients use one retrieval service and one authorization policy. The first complete milestone is one genuine error-to-recall loop, followed by an independent error to demonstrate that the pipeline is not a prerecorded answer.

### Long-term value

Company-owned memory can support employee departures, onboarding, incident escalation, code reviews, upgrades, and legacy maintenance. Memvora can reduce repetitive knowledge-transfer work; it does not replace architectural discussion, people, undocumented business knowledge, or required handover responsibilities. Organization ownership and offboarding are a later release, not a personal-MVP capability.

## 2. Users and important use cases

| User or situation             | Question                                       | Useful result                                                                   | Release                                     |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| Returning developer           | How did I fix this error before?               | Earlier attempts, relevant change, checks, commit/version conditions, citations | MVP                                         |
| Interrupted investigation     | Where did I stop?                              | Latest evidence, unresolved state, failed approaches, next unanswered question  | MVP                                         |
| Coding assistant through MCP  | What is known about this failure in this repo? | Bounded, authorized source bundle with event and artifact references            | MVP                                         |
| Developer asking in terminal  | What did I do last time?                       | Same answer contract as website, with readable ordered steps                    | MVP                                         |
| New developer                 | How does this part actually work?              | Recorded setup and investigation examples, linked repository context            | Later sharing                               |
| Teammate escalation           | What has already been tried?                   | Reproduction steps, output, diffs, incomplete checks                            | Later sharing                               |
| Engineer leaving a company    | What context should stay with the team?        | Company-owned, permission-controlled evidence and memories                      | Later organizations                         |
| Reviewer                      | Why is this workaround here?                   | Observed failure, alternatives attempted, verification evidence                 | Later integrations                          |
| Upgrade or database migration | What broke during the previous upgrade?        | Recorded versions, corrective changes, rollback and validation evidence         | MVP recall; richer views later              |
| Recurring incident            | Did we see this behavior before?               | Relevant historical evidence with environment and freshness warnings            | MVP manual recall; alert integrations later |

## 3. Outcomes and boundaries

Success means evidence survives connection failures and new logins, a relevant earlier investigation is discoverable, and an answer can be checked against original sources. The MVP must be useful when the AI provider is unavailable: raw events and repository context remain accessible.

In scope:

- Explicit GitHub authorization, all or selected repositories, and incremental repository context.
- Windows-first explicit command execution with stdout, stderr, startup errors, exit status, timestamps, session order, cwd, commit and local diff provenance.
- Local durable outbox, idempotent upload, authoritative evidence storage, asynchronous structured summaries.
- Timeline, search, cited recall, `memvora ask`, and a local stdio MCP adapter.
- Access revocation, deletion, visible processing failures, bounded resource use, and development acceptance checks.

Out of MVP scope:

- Universal passive capture of commands run outside Memvora, a custom terminal emulator, production-grade interactive PTY capture, or a promise of 100% capture compatibility.
- Company membership, cross-user sharing, employee offboarding, SSO, enterprise policy, or public memory sharing.
- Automatic code execution or remediation by MCP tools, autonomous deploys, or claims that an AI summary proves a fix.
- Full historical indexing of every branch and commit, every language parser, CI/Slack/IDE integrations, and an independently deployed microservice for each domain.
- Automatic migration of old Memvora accounts or evidence. A future import requires explicit versioned conversion and validation.

## 4. Product principles

1. Persist observations before enrichment. AI calls never sit on the evidence acknowledgement path.
2. Own history by a stable workspace and repository, never by a login session.
3. Preserve repeated attempts. Execution IDs identify executions; hashes only identify reusable content.
4. Require citations and uncertainty. Distinguish observations, inferred explanations, and user-confirmed outcomes.
5. Enforce current access before every candidate query and evidence expansion.
6. Expose incomplete capture, truncation, processing failures, and unsupported cases honestly.
7. Prefer an end-to-end tested slice over many disconnected screens or adapters.

## 5. Requirements

P0 is required for the connected personal MVP. P1 improves that release after its core loop works. P2 belongs to a later release. All statuses start as planned unless the repository implementation explicitly proves otherwise.

### Identity and repository access

| ID    | Priority | Requirement and acceptance                                                                                                                                                                                                                      |
| ----- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ID-01 | P0       | GitHub sign-in resolves a stable GitHub numeric ID and existing personal workspace. Logout and subsequent login expose the same authorized history.                                                                                             |
| ID-02 | P0       | GitHub App installation supports all or selected repositories. Server verifies both user authority and installation access before linking an installation to a workspace. An arbitrary installation ID cannot bind someone else's repositories. |
| ID-03 | P0       | Browser-approved CLI pairing uses distinct short user code and secret device code, expiry, polling limits and single consumption. Expired or rejected pairing yields no credential.                                                             |
| ID-04 | P0       | Tokens are hashed at rest, expiring and revocable, bound to workspace and scopes. CLI stores credentials through the Windows credential store; failure cannot silently write a plaintext token.                                                 |
| ID-05 | P0       | Every read and write checks workspace activity, current repository access, and credential validity. Terminal evidence uses the same repository restrictions as code evidence.                                                                   |
| ID-06 | P1       | Users can list and revoke paired devices with last-use metadata.                                                                                                                                                                                |

### GitHub context

| ID    | Priority | Requirement and acceptance                                                                                                                                                                     |
| ----- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GH-01 | P0       | Initial import stores repository metadata, default-ref checkpoint, supported text files and commit provenance. Issues and PR metadata can be limited to a documented recent window.            |
| GH-02 | P0       | Webhook HMAC is checked against raw bytes before parsing. Accepted delivery ID and work scheduling commit durably before 2xx. A duplicate delivery schedules no duplicate import effect.       |
| GH-03 | P0       | Subsequent sync processes changed, renamed and deleted paths. Failed comparison or rewritten history falls back to a bounded tree refresh. A failed transaction never advances the checkpoint. |
| GH-04 | P0       | Binary, generated, excluded and sensitive files are filtered before upload/enrichment. Unsupported files are reported, not silently called indexed.                                            |
| GH-05 | P0       | Revoked/suspended installations and removed repositories block ingestion and retrieval, including derived memories. Sync status distinguishes pending, partial, ready, failed and denied.      |
| GH-06 | P1       | Recovery can list and redeliver failed GitHub deliveries or request reconciliation. GitHub delivery failure must not be assumed to retry automatically.                                        |

### CLI capture and delivery

| ID     | Priority | Requirement and acceptance                                                                                                                                                                                                                              |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CAP-01 | P0       | `memvora run -- <command> [args...]` captures commands explicitly run through it. Builds, tests, lint, failures and successful commands are included.                                                                                                   |
| CAP-02 | P0       | Each invocation creates a fresh UUID and session sequence before launch. Same command/output in two sessions remains two events.                                                                                                                        |
| CAP-03 | P0       | Capture continuously drains stdout and stderr without holding all output in memory. Finalization waits for child close and stream completion; spawn failure is stored as an attempt.                                                                    |
| CAP-04 | P0       | Record start/end timestamps, duration, cwd, workspace/repo/session IDs, command arguments, commit SHA, dirty state, bounded starting and ending diffs, exit code or signal, and capture completeness. Untracked files follow explicit inclusion policy. |
| CAP-05 | P0       | Append redacted bounded chunks and execution state to local SQLite. Network loss does not lose captured evidence. Local storage failure is visible and capture degradation is reported.                                                                 |
| CAP-06 | P0       | Uploads resend immutable event IDs. Mark only exact acknowledged IDs synced. An event arriving during an upload remains pending until its own acknowledgement.                                                                                          |
| CAP-07 | P0       | Windows shell handling is explicit and tested for supported PowerShell and `cmd.exe` commands. Shell metacharacters are not accidentally interpreted by argument concatenation. Preserve child exit behavior where possible.                            |
| CAP-08 | P0       | Missing executable, cancellation, truncated output, process crash, unresolved repo and revoked token have distinct visible outcomes. Unresolved/denied repositories never upload unscoped evidence.                                                     |
| CAP-09 | P0       | Secrets are redacted before persistence/upload where detectable; `.env`, credentials, private keys and ignored sensitive paths are excluded. No complete environment-variable dump. Redaction limitations are documented.                               |
| CAP-10 | P1       | Session start/end, optional human note, pause/resume and configurable local retention. A note is labeled user-authored.                                                                                                                                 |
| CAP-11 | P2       | Interactive `node-pty`/ConPTY mode, explicit command-boundary integration and merged-stream metadata. Keep wrapper mode as supported fallback.                                                                                                          |

### Storage, enrichment and trust

| ID     | Priority | Requirement and acceptance                                                                                                                                                                                                     |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MEM-01 | P0       | Evidence and enrichment scheduling commit in one database transaction. No acknowledgement precedes commit; transaction rollback creates no accepted event.                                                                     |
| MEM-02 | P0       | Repeated event ID plus identical immutable payload is safe; same ID with changed payload rejects the batch with a conflict. Uniqueness includes workspace scope.                                                               |
| MEM-03 | P0       | Worker produces validated structured memories: problem, attempts, changes, observed outcome, unresolved questions, uncertainty and evidence references. Every reference resolves inside authorized workspace/repository scope. |
| MEM-04 | P0       | Raw evidence remains readable if enrichment fails. Retry is bounded, backoff is visible, and failed processing is not labeled ready.                                                                                           |
| MEM-05 | P0       | Final worker write checks workspace generation, activity and input version under lock. Redelivery and stale jobs cannot duplicate a memory version or resurrect deleted data.                                                  |
| MEM-06 | P0       | A passing command is recorded as a passing command. A fix is reported as supported only when a relevant check or explicit user confirmation is linked; causal certainty is not invented.                                       |
| MEM-07 | P0       | AI inputs are bounded and treated as untrusted data. Repository comments or terminal output cannot override system instructions, authorization, tool policy or citations.                                                      |
| MEM-08 | P1       | Versioned summaries can be regenerated when evidence changes; provenance records model configuration, prompt version and input version without storing credentials.                                                            |

### Retrieval, website and MCP

| ID     | Priority | Requirement and acceptance                                                                                                                                                                     |
| ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RET-01 | P0       | Search scopes workspace and current allowed repositories inside lexical and optional vector candidate queries before ranking or evidence expansion.                                            |
| RET-02 | P0       | Search supports exact error text plus PostgreSQL full-text; optional vector similarity augments recall. Missing vectors must not block exact-error search.                                     |
| RET-03 | P0       | Website, CLI ask and MCP share core retrieval, source identifiers and error semantics. No separate permissive MCP search branch.                                                               |
| RET-04 | P0       | Answers include ordered historical steps, source IDs, relevant repository/commit conditions and uncertainty. Empty or weak evidence returns insufficient evidence rather than an invented fix. |
| WEB-01 | P0       | Website shows repository connection/sync status, session timeline, execution detail, raw output/diff, memory status and cited recall. Every answer source opens the original event/artifact.   |
| WEB-02 | P0       | Loading, empty, offline, denied, partial, pending, failed and deleted states are distinguishable. Summary failure must not hide raw history.                                                   |
| MCP-01 | P0       | Local stdio tools `search_memory`, `get_memory`, `get_session_context` call the same API using a scoped credential. They do not run shell commands or write repository files.                  |
| MCP-02 | P0       | stdout contains only protocol traffic; diagnostic output uses stderr. Tool results are bounded, paginated where necessary and carry source metadata.                                           |
| MCP-03 | P2       | Remote MCP with protocol-compliant authorization after local retrieval is proven. Local authentication is not automatically a remote authorization design.                                     |

### Lifecycle and operations

| ID     | Priority | Requirement and acceptance                                                                                                                                                                            |
| ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPS-01 | P0       | Structured logs expose request IDs, job IDs, duration, counts and safe error codes without raw command output, tokens or repository source by default.                                                |
| OPS-02 | P0       | Explicit workspace deletion marks a persistent tombstone/generation, revokes credentials, blocks access, cancels work and purges dependent evidence. Old outboxes and running jobs cannot restore it. |
| OPS-03 | P0       | Web sessions use secure cookie policy and CSRF protection for mutations; device endpoints are rate limited. Dev-only bootstrap identities cannot run as production auth.                              |
| OPS-04 | P0       | Limits apply at local capture, request parsing, database writes, job inputs and answer outputs. Resource exhaustion produces a useful error and a truthful partial state.                             |
| OPS-05 | P1       | Export one's own evidence and memory with provenance and deletion/retention policy.                                                                                                                   |

## 6. Main user journeys

### Connect and capture

1. Developer signs in; server resolves stable identity and workspace.
2. Developer installs the GitHub App for all or selected repositories; server verifies authority and queues initial import.
3. `memvora login` opens an approval page. Browser approval exchanges a one-use device flow for a scoped CLI credential.
4. `memvora init` resolves the current Git remote to an authorized repository. No remote or permission means an actionable blocked state.
5. Developer runs `memvora run -- npm test`; capture starts a fresh event, records repository conditions and drains both streams.
6. CLI finalizes evidence locally, then uploads a bounded batch. Server acknowledges exact committed event IDs only.
7. Worker enriches evidence. Website shows raw timeline immediately and a summary when ready.

### Recover an earlier solution

1. Developer asks in the website or `memvora ask "How did I fix this error?"`, or an MCP client calls a read tool.
2. API resolves allowed repositories, searches bounded candidates, expands scoped evidence, and builds an answer.
3. User sees historical steps, remaining uncertainty and citations. Opening a source shows output, changes, check, and context rather than just the generated summary.
4. If current code differs, the answer flags the older commit/version conditions. It does not automatically execute the earlier fix.

### Interrupted work

An unfinished session has no manufactured success. Recall identifies what failed, the most recent captured diff, and unresolved questions. A later session can be linked to the earlier investigation without rewriting immutable events.

### Revocation or deletion

Current access changes block every client. Workspace deletion fences new and running writes before purge. The UI confirms completion only after required live data is removed; backup retention is described separately and is not misrepresented as immediate physical erasure.

## 7. States exposed to users

| Object          | States                                                             | Important transition rule                                                           |
| --------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Repository      | pending, syncing, partial, ready, failed, denied                   | Ready requires completion of the planned bounded import, not merely job start.      |
| Local execution | started, running, completed, spawn_failed, interrupted, incomplete | Crash recovery marks started/running rows incomplete; never fabricate an exit code. |
| Outbox          | pending, uploading, synced, blocked, rejected                      | Only exact server ACK moves a row to synced. Transient failure returns pending.     |
| Memory          | pending, processing, ready, failed, superseded                     | Invalid/stale output cannot become ready. Raw evidence is independent.              |
| Pairing         | pending, approved, consumed, expired, denied                       | Approval consumption is atomic and single-use.                                      |
| Workspace       | active, deleting, deleted                                          | Deleted workspace IDs remain fenced; no implicit recreation.                        |

## 8. Proposed limits and quality targets

These are initial acceptance targets for controlled development measurements, not established production results. Record dataset size, machine, API/provider configuration and concurrent clients with each result. Change targets through a documented decision.

| Concern                | Initial target or policy                                                                               | Measurement                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Ingest batch           | At most 50 events and 2 MiB uncompressed request body                                                  | Contract and boundary tests                  |
| Output/diff            | 1 MiB persisted output per command; 256 KiB per diff; explicit truncation counts                       | Large-output and large-diff fixture          |
| Chunking               | Output chunks at most 16 KiB; bounded cross-chunk redaction carry                                      | Stream fixture including split token         |
| Retrieval              | Top 20 combined candidates; at most 12 expanded sources; bounded response                              | Query traces without raw payload logging     |
| Ingest acknowledgement | p95 below 500 ms on warm local API/database for a batch of 10 small events, excluding network/provider | Repeatable local benchmark                   |
| Raw search             | p95 below 1 second for 10,000 seeded events on the documented test setup                               | Authorized exact/FTS test corpus             |
| Timeline               | 50 rows per page, keyset cursor                                                                        | No full-history materialization              |
| Enrichment             | Capture succeeds during provider outage; raw evidence available immediately after ingest               | Failure injection                            |
| Recovery               | Replayed batch produces zero duplicate executions; zero unauthorized sources returned                  | Integration tests, mandatory invariant       |
| Local outbox           | Warn at 250 MiB; stop new persisted capture at 500 MiB pending explicit cleanup                        | Disk-pressure fixture; never silent eviction |
| Accessibility          | Keyboard-operable primary flows, labeled controls, readable contrast, responsive timeline              | Manual review + relevant automated checks    |

The exact AI token/context budget, embedding dimension and job concurrency are configuration choices recorded before provider integration. The provider must not determine access policy.

## 9. Demo and release acceptance

The MVP is accepted only when a clean environment can follow the setup guide and complete both scenarios using actual captured evidence.

Scenario A: induce a real project test/build/runtime error, capture at least one failed attempt, make a corrective change, capture a relevant passing check, end the session, sign out/in, and retrieve the earlier work from website, CLI and MCP. Sources must resolve to original events. The result may be a verified passing check or a clearly unresolved issue; it must match the evidence.

Scenario B: produce an independent, previously unused error and repeat the pipeline without changing code to insert a canned answer. Remove any canned demo response from release paths. Test fixtures are permitted and must be labeled fixtures.

Mandatory adversarial checks:

- Identical commands in two repositories remain separate events and never cross access boundaries.
- Upload response loss and an event arriving during upload preserve correct pending state.
- A new login sees prior authorized history.
- AI timeout or invalid JSON leaves raw evidence and truthful failure state.
- Source references outside the evidence bundle are rejected.
- Removing repository access blocks old summaries and event detail through every client.
- A worker finishing after workspace deletion cannot write a new summary.
- A missing executable and an interrupted process remain inspectable execution attempts.
- A secret split across stream chunks does not bypass the documented redaction strategy.

## 10. Risks, decisions and dependencies

| Risk or open choice                         | Decision now / resolution                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Captured logs may contain credentials       | Explicit capture, client redaction, exclusions, bounded retention; validate known token formats and disclose imperfect detection.             |
| Windows command resolution differs by shell | Explicit adapters and argument tests. Wrapper first; interactive mode after compatibility work.                                               |
| AI inference overstates a fix               | Structured schema, evidence validation, uncertainty and outcome taxonomy; human confirmation optional.                                        |
| Large repositories exceed free tiers        | Incremental import, exclusions, bounded recent metadata and pagination. Document limits rather than promising full coverage.                  |
| Provider pricing/quotas change              | Provider adapter with timeouts, budgets, retry classification and no provider call on capture path.                                           |
| GitHub access changes during work           | Recheck current grants and workspace generation at reads and final writes; reconcile stale access.                                            |
| Sharing personal history with company       | No implicit ownership transfer. Define company-workspace policies and employee consent before organizations.                                  |
| Framework/library versions evolve           | Pin repository lockfile and supported runtime. Verify current official APIs before adding an integration.                                     |
| Deployment topology                         | Next.js web host, long-running API/worker host and PostgreSQL with required extensions; no background worker in an ephemeral request handler. |

Required setup: a GitHub App and callback/webhook URLs, a PostgreSQL instance supporting the chosen queue and vector extension, local SQLite support, Windows credential-store integration, a selected AI/embedding provider, and a configured local MCP client. The scaffold can run before these are configured; the product cannot claim a connected MVP until they are wired and accepted.

## 11. Supporting documents

- [Architecture and decisions](ARCHITECTURE.md)
- [Data model and invariants](DATA_MODEL.md)
- [HTTP, CLI and MCP contracts](API.md)
- [Delivery order and acceptance gates](ROADMAP.md)
- [Lessons from the old repositories](OLD_PROJECT_LESSONS.md)
- [Primary technical references](SOURCES.md)
