# HTTP, CLI and MCP contracts

This document retains the original **hosted-target contract plan**. It is not the current implementation inventory: later sections include planned browser/device authentication, PostgreSQL-oriented behavior and historical starter wording. Use [LOCAL_MVP.md](LOCAL_MVP.md) for the actual local implementation and `packages/contracts/src/local.ts` for its schemas.

The local code now includes SQLite-backed evidence intake, repository/session routes, observed memories, cited ask, a real command wrapper and read-only MCP retrieval tools. It uses a trusted-machine loopback credential, not the hosted login/pairing system described below. GitHub browsing/import supports an optional private GitHub App user connection or, only with all App settings absent, an explicit local `gh` bridge. AI is optional and disabled by default. Integration and acceptance results remain separately recorded. Shared runtime validation continues through `packages/contracts`.

## Implemented local GitHub App connection

These routes connect GitHub to the existing personal local workspace; they do not implement the hosted browser-login routes in the later target inventory. All Fastify routes below retain local bearer authentication and loopback Host/Origin checks. A Next.js browser adapter holds the server credential and forwards the OAuth callback; the public browser callback is not an authentication exemption on the API. Owner registration and real GitHub consent are prerequisites for live use, not implied verification results. See [GITHUB_SETUP.md](GITHUB_SETUP.md).

| Route                              | Strict input                                                                                                                                   | Result                                                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/github/status`            | No body                                                                                                                                        | `{available, mode, user, message, oauth: {configured, callbackUrl, connected, user, expiresAt, message}}`; mode is `gh_cli`, `github_app` or `unconfigured`. Credentials are never returned.           |
| `POST /v1/github/oauth/start`      | `{browserHash}`: lowercase SHA-256 hex, exactly 64 characters                                                                                  | `{authorizationUrl, expiresAt, callbackUrl}`. Creates a durable ten-minute single-use authorization attempt bound to the local principal/workspace generation and browser.                             |
| `POST /v1/github/oauth/finish`     | `{state, browserHash, code? , error?}`: exactly one of code/error; state is 43 base64url characters; code length 1–2,048; error length 1–100   | `{status: "connected" \| "denied", user}`. Validates/consumes the attempt, exchanges the code with its PKCE verifier and resolves stable numeric GitHub identity before saving.                        |
| `POST /v1/github/oauth/disconnect` | `{}`                                                                                                                                           | `{disconnected: true}`. Removes local tokens and attempts, advances the connection revision and fences pending writes. Does not remotely revoke or uninstall.                                          |
| `GET /v1/github/installations`     | Optional `page` (1–100, default 1)                                                                                                             | `{items, page, hasMore}`. Only active installations of the configured App accessible to the connected GitHub user. Each item has `id`, `accountLogin`, `appId`, `repositorySelection` and `suspended`. |
| `GET /v1/github/repositories`      | Optional `page` (1–100); App mode requires positive numeric `installationId`                                                                   | `{items, page, hasMore}`. Verifies the selected installation. App-mode repository items add `installationId` and `accessPage` to the ordinary repository metadata.                                     |
| `POST /v1/github/import`           | `{fullName, installationId?, repositoryId?, repositoryPage?}`. App mode requires all three numeric selection fields; `repositoryPage` is 1–100 | `{repository, context, partial}`. Confirms selected repository ID/full name/page membership before and after the bounded fetch and checks connection revision at save.                                 |

The website callback is exactly `http://127.0.0.1:3000/api/github/oauth/callback` for the default setup. Start creates an HttpOnly, SameSite=Lax browser nonce cookie scoped to `/api/github/oauth`; only its SHA-256 hash goes to the API. The callback requires the trusted local host and cookie, forwards `code` or `error` plus `state` and the browser hash to the protected finish route, then issues a 303 to a fixed Settings result. It accepts no arbitrary redirect destination and applies no-store/no-referrer response policies. The API stores a state hash and encrypted S256 PKCE verifier; the client secret and local API credential stay server-side. [GitHub App authorization contract](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

App mode requires valid `GITHUB_APP_ID`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`; `GITHUB_CALLBACK_URL` defaults to the callback above. **Any nonempty value among those four requests App mode.** Incomplete configuration denies GitHub actions without failing the rest of local startup. Once App mode is requested there is no GitHub CLI fallback, including after disconnect, provider failure or expired authorization. In GitHub CLI mode, App installation selectors are invalid; repository imports retain the explicit local `gh` authorization behavior.

App user credentials are encrypted with AES-256-GCM using an HKDF key derived from the ignored local API server secret, with authenticated user/workspace-generation/purpose binding. This is same-host server-secret encryption, not a platform credential store. Key rotation/loss requires reconnection. Near-expiry refresh is serialized within one API process and saved with revision compare-and-swap; coordination across multiple API hosts is not implemented. A GitHub 401 authorization failure clears the current connection; 403/404 deny the action, while rate limits and temporary failures preserve the credential. Safe provider errors are `GITHUB_AUTH_EXPIRED` (401), `GITHUB_ACCESS_DENIED` (403) and `GITHUB_REMOTE_UNAVAILABLE` (503). Provider bodies, authorization codes and tokens do not appear in these error messages.

Installation IDs and repository IDs are selectors, never authority. Selection must satisfy configured App identity, active installation and connected-user access. Imports verify exact repository ID/full name against its selected installation page both before and after fetch. A changed/disconnected connection or a deleted repository/workspace prevents the old request from committing. Retained local history remains readable after disconnect. Disconnect does not uninstall the App or revoke its remote grant; that requires the owner's GitHub settings. Webhook-driven revocation, hosted login, continuous sync and cross-device access reconciliation remain planned.

## Implemented local investigation journal

Journal entries are separate immutable records for a user's note, decision or reported resolution. They do not modify captured events, close a session, verify a fix or invoke AI. Every read/write uses the same protected local API and live parent scope; read-only MCP exposes no note-writing tool.

| Route                           | Input                                                                                                                                               | Result                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /v1/sessions/:id/notes`   | `{id,kind,body,eventIds}`; required UUID retry identity, kind `note/decision/resolution`, body 1–4,000 characters, at most ten distinct event UUIDs | `{note}`; 201 new, 200 identical normalized retry, 409 changed identity/payload/context       |
| `GET /v1/sessions/:id/notes`    | Optional `limit` 1–50 (default 20), `before` UUID                                                                                                   | `{sessionId,totalNotes,items,olderBeforeId}`; latest selected window returned in append order |
| `GET /v1/session-notes/:id`     | Note UUID                                                                                                                                           | `{note}` with original persisted author/time and event citations                              |
| `POST /v1/session-notes/search` | Strict `SearchRequest`                                                                                                                              | `{items,requestId}`, at most 20 scoped literal full-text matches                              |

`SessionNote` contains its UUID, repository/session IDs, kind, body, server-derived author snapshot, creation time, literal label `User-authored — not independently verified`, and up to ten event citations. Attached events must belong to that exact authorized session/repository. Uncited reports are allowed and remain explicitly unverified. Normalize terminal/control text before known-pattern credential redaction; only the resulting text/digest enters SQLite and FTS. Empty or oversized normalized bodies are rejected. Event-source IDs are sorted for retry equivalence. Author/body/time and event links cannot be edited; append a correction as another entry. Parent deletion physically removes notes and their FTS rows. Generation checks prevent stale scope reads and retries.

Schema 7 adds append ordinals, immutable-note storage and transactional FTS triggers. List/search do not load full note history. `before` is the oldest note UUID returned when earlier notes exist; it must resolve within the same live session. It is a selector, not authority. Follow it unchanged, or refresh without it for latest notes. This is live append pagination, independent of the event timeline's fixed intake snapshot; total count can grow. Foreign/deleted note selectors return 404. Client-selected note/event UUID collisions with another citation kind in the same workspace are rejected to keep ID-based source links unambiguous.

Ask includes at most five matching notes, or the latest five from the selected recent investigation for resume prompts, and marks their statements as author claims. Latest investigation activity considers accepted commands and appended notes, including journal-only sessions. `session_note` citations resolve to the original note and retain author, time, note kind and event links. The existing answer `mode` describes derivation, not the truth of a statement; a deterministic retrieved note is not independently observed execution. Notes are not fed into the optional per-command AI enrichment adapter.

The website's journal form keeps the same UUID and draft after an uncertain save, and starts a fresh identity after edits. Its same-origin BFF preserves backend 201/200 status without returning the local bearer token. CLI `session note [id] --text ... --kind ... --event <uuid> --note-id <retry-uuid>` writes reports; `session notes [id] --limit ... --before ...` reads pages. CLI failures expose the stable retry UUID rather than the submitted body. MCP `search_session_notes`, `get_session_note` and `get_session_notes` preserve member/citation/navigation identity within a 96 KiB transport budget, shortening bodies only with explicit disclosure.

## Implemented local investigation recaps

`GET /v1/sessions/:id/recap` returns the shared `SessionRecap` contract after the same local bearer, workspace and repository checks as raw evidence. It accepts no query fields or body. It is a read-only computation: it neither stores a recap nor starts enrichment jobs, and it works while command memories are pending or AI is disabled.

One authorized read transaction selects the accepted event count and at most 40 raw events in session-sequence order. Through 40 events all are included; above 40, only the first 20 and last 20 are included. `coverage` gives `totalEvents`, `includedEvents`, `omittedEvents`, `eventLimit: 40` and `selection: all | first_and_last`. Every count describes the selected events. Middle attempts can contain important evidence; use the paged timeline to inspect the rest. A fresh request includes later accepted uploads; this is independent of a timeline cursor's fixed intake snapshot.

The response contains live session metadata from that transaction, `generatedAt`, `mode: observed`, a deterministic label and summary, counts, up to 40 ordered steps, event citations and uncertainty. Outcome categories are zero exit (`passed`), nonzero exit (`failed`), `spawnFailed`, `interrupted` and `incomplete` (including completed runs without an exit code). `withDiffs` and `incompleteCapture` are overlapping flags, not additional outcome categories. A nonempty diff snapshot may include changes already present before the command; text equality is an observation about captured snapshots only.

Each step retains sequence and event UUID, command (300 characters), outcome (160), output excerpt (600) and a diff-snapshot description (300). Excerpts normalize terminal control characters, redact known credential patterns and shorten without splitting a surrogate pair. Original accepted evidence remains at `/v1/events/:id`; every cited UUID belongs to the authorized selection. Counts and a successful exit do not establish engineer intent, root cause or a causal fix. Empty sessions return no steps or citations. Deleted/inaccessible sessions return 404; invalid/deleted workspaces return 403. No schema migration is required.

The website shows this recap above the raw investigation timeline. CLI `memvora session recap [id]` prints ordered cited observations; `--json` returns the shared contract. MCP `get_session_recap` uses the same route and preserves all step/source membership while disclosing any extra shortening required by its response budget. It does not invoke a model or execute recorded commands. The existing optional AI adapter still generates separate per-command memories; an AI interpretation of an entire investigation remains future work.

## Implemented local session-history pagination

`GET /v1/sessions/:id/events` returns an authenticated, bounded page across the complete accepted session history. The strict query accepts only optional `cursor` (1–2,048 characters) and `limit` (1–50, default 20). With no cursor, it opens a new durable-intake snapshot and returns its latest events in ascending session-sequence order. `olderCursor` and `newerCursor` navigate that same snapshot; a null cursor means no events remain in that direction.

```ts
type SessionEventsPage = {
  session: Session;
  events: CapturedEvent[];
  memories: Memory[];
  page: {
    snapshotEventCount: number;
    returnedEvents: number;
    firstSequence: number | null;
    lastSequence: number | null;
    olderCursor: string | null;
    newerCursor: string | null;
  };
};
```

An empty snapshot has no events, null sequence boundaries and null navigation cursors. Each page contains memories associated with its returned events; raw events remain usable when enrichment is pending or has failed. `session.eventCount` is the live accepted count and may differ from the fixed `snapshotEventCount`. Summary processing and live session metadata can change while paging; the snapshot fixes event membership, not an immutable view of every derived summary.

Later uploads cannot enter an existing snapshot, even if their session sequence is earlier than the first page. This uses a durable intake watermark as well as keyset boundaries, rather than treating the largest sequence as a sufficient snapshot. Refresh without a cursor to include new uploads. Clients must pass returned opaque cursors unchanged and URL-encode them; do not derive a cursor from sequence numbers or edit its contents.

The signed cursor is bound to the authenticated user/workspace, repository, session and their generations. It is navigation state, never an authorization credential. Invalid, altered or wrong-session cursors return 400 `INVALID_CURSOR` after live access checks. Deleted/inaccessible sessions or repositories return 404; an unavailable/deleted workspace returns 403. Deletion and generation fences apply on every page. The cursor-signing key persists with local storage so valid navigation can survive an API restart while the scope remains active.

The existing `GET /v1/sessions/:id` remains the legacy latest-100-event window for compatibility. New history browsing and MCP `get_session_context` use `/events` so work older than 100 accepted events remains navigable. The MCP tool defaults to five events, accepts up to ten, forwards an optional cursor, and returns the same page metadata with explicitly shortened output/diff excerpts. The hosted pagination targets later in this document are separate from these implemented local limits.

## Implemented local imported-code retrieval

These routes use the same authenticated local workspace/repository scope as execution evidence. They index imported redacted files, not arbitrary filesystem paths, and do not require a provider credential or hosted OAuth setup.

| Route                                | Input                                                                                          | Response and behavior                                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/repository-sources/search` | Strict `SearchRequest`: `query`, optional `repositoryIds`, optional `limit` (1–20)             | `{items: RepositorySourceMatch[], requestId}`. Lexical search over the latest captured import. Explicit inaccessible repositories deny; an empty repository list returns no hits.                             |
| `GET /v1/repository-sources/:id`     | Immutable UUID source ID; optional `startLine` (default 1), `limit` (default 100, maximum 200) | `{document: RepositorySourceDetail}`. Bounded redacted text with `startLine`, `endLine`, `excerptTruncated`, `hasBefore` and `hasAfter`. Historical versions resolve while their parent scope remains active. |

A match contains `source` metadata and a bounded excerpt. Metadata includes `id`, `repositoryId`, `fullName`, `path`, nullable `commitSha`, `blobSha`, SHA-256 `contentHash`, first-observed `importedAt`, `lineCount` and `isCurrent`. Line indices refer to the stored redacted snapshot; they are not promised original GitHub line positions. Unknown commits remain `null`. Source IDs resolve stored bytes, never mutable branch/path lookups or local file reads. `excerptTruncated` means a byte/character cap cut the selected range; `hasBefore` and `hasAfter` describe ordinary line pagination.

`POST /v1/ask` returns a discriminated `RecallCitation` union. Execution citations retain `kind: "event"`. Imported-code citations use `kind: "repository_file"` with source UUID, repository, API locator, full name/path, nullable commit, content hash and line range. Answer steps reference those source IDs. The website maps a file citation to `/sources/:id?startLine=N&limit=100`; its API locator points to `/v1/repository-sources/:id` with the bounded range.

Ask preserves the existing command-neighbor budget and adds at most five matching file excerpts, clipped to a 4,000-character per-excerpt budget with adjusted range metadata. Session-selected questions restrict code to the session's repository, intersected with explicit repository filters. Recognized recent-investigation questions remain command-only. Code content is captured context, not evidence that an earlier execution succeeded or that a fix was verified. Retrieval does not widen optional per-event AI enrichment inputs.

Reimport updates the current snapshot atomically but retains immutable source versions for older citations. A partial import's missing paths are not evidence of deletion from GitHub. Retained per-repository history is admitted up to 32 MiB of stored text and 2,000 versions; exceeding the cap rejects the save instead of silently evicting sources. Repository/workspace deletion blocks both current/historical reads, removes file search entries and fences stale saves. These are local SQLite guarantees to verify separately from the hosted target below.

## Implemented local job controls

These routes are implemented for the local SQLite mode and require the same loopback Host/Origin checks and local bearer credential as evidence routes. They do not implement hosted account authorization.

| Route                     | Implemented behavior                                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/jobs`            | Return `{items: JobSummary[]}`, newest creation time then job ID first. Optional `repositoryId`, `sessionId`, `status` and `limit` filters; default 50 and maximum 100. Explicit inaccessible selectors return 404 and never widen the query. |
| `POST /v1/jobs/:id/retry` | Strict JSON body `{}`. Only a terminal failed job in the current active workspace/repository/session generations can be rescheduled. Returns HTTP 202 with `{job}` in queued state.                                                           |

`JobSummary` exposes `id`, `eventId`, `repositoryId`, `sessionId`, `status` (`queued`, `running`, `ready`, `failed`), current-budget `attempts`, `maxAttempts: 3`, cumulative manual `retryCount`, `createdAt`, `availableAt`, nullable `leaseUntil`, nullable safe `lastError`, and `canRetry`. Error values are only `ENRICHMENT_FAILED` or `LEASE_ATTEMPTS_EXHAUSTED`; there is no raw provider exception, credential or captured payload in this projection. The generic code does not diagnose a provider's exact failure cause.

A retry preserves the same immutable event and job identity, resets the current three-attempt budget, increments manual retry history, clears the old lease and schedules work immediately in one transaction. Queued, running and ready jobs return 409 without changing their state or budget. A repeated retry request after a successful reschedule also returns 409, so a lost response should be followed by reading current job status. Deleted or stale-generation jobs return 404 and cannot be restored. An old worker's lease token cannot complete a subsequently retried job. Repeated failures still stop after three attempts and leave source evidence available.

## HTTP conventions

- JSON requests/responses except raw GitHub webhooks. UTF-8, UTC ISO-8601 timestamps and UUID domain identifiers.
- Protected CLI/MCP routes use `Authorization: Bearer <credential>`; browser routes use validated web sessions. Credentials never appear in URLs, logs or repository files.
- Every protected route resolves a stable principal and workspace, then current repository grants. Client IDs select resources but do not grant access.
- API paths use `/v1`; breaking semantic/schema changes require a new version or an explicit compatibility window.
- Enforce request limits before parsing; validate unknown fields and response schemas at boundaries. One `requestId` connects safe logs and client errors.
- Pagination uses opaque keyset cursors. Default timeline page size 50; maximum 100. Do not expose arbitrary SQL filters.

Error envelope:

```json
{
  "error": {
    "code": "REPOSITORY_ACCESS_DENIED",
    "message": "This repository is not available to the current credential.",
    "requestId": "example-request-id",
    "retryable": false
  }
}
```

Use 400 for malformed schema, 401 for unauthenticated/expired credential, 403 for a known forbidden operation, 404 for inaccessible object detail where enumeration must be avoided, 409 for immutable ID conflict, 413 for request limits, 429 for throttling, 503 for temporary unavailability. Use one consistent resource-enumeration policy. Returning an empty search set must not reveal names or counts from forbidden repositories.

## Route inventory

| Method and route                     | Purpose                                             | Authentication / notes                                                    |
| ------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /health`                        | Process liveness                                    | No secrets; does not prove every dependency is ready.                     |
| `GET /v1/system/status`              | Starter capabilities and planned integration status | Implemented scaffold route; no connected-product completion claim.        |
| `GET /ready`                         | Dependency readiness                                | Restricted diagnostics; provider outage need not block capture readiness. |
| `GET /v1/auth/github/start`          | Begin browser sign-in                               | CSRF state and approved callback handling.                                |
| `GET /v1/auth/github/callback`       | Resolve identity and web session                    | Verify callback/state; never accept arbitrary redirect destinations.      |
| `POST /v1/auth/logout`               | Revoke browser session                              | Session + CSRF.                                                           |
| `POST /v1/device/pairings`           | Allocate user/device codes                          | Public but strongly rate limited.                                         |
| `POST /v1/device/pairings/approve`   | Approve user code                                   | Browser session + CSRF; show requested device/scopes.                     |
| `POST /v1/device/pairings/token`     | Poll with secret device code                        | Single consumption, expiry and interval enforcement.                      |
| `GET /v1/me`                         | Stable user/workspace context                       | No raw credentials.                                                       |
| `GET /v1/repositories`               | Current allowed repositories and sync state         | Paginated scoped projection.                                              |
| `POST /v1/github/installations/link` | Verify and bind installation                        | Browser owner and verified installation/user authority.                   |
| `POST /v1/webhooks/github`           | Durable webhook intake                              | Raw-byte GitHub HMAC; unique delivery ID.                                 |
| `POST /v1/repositories/:id/sync`     | Request bounded resync                              | Authorized repo, idempotent job key and rate limit.                       |
| `POST /v1/sessions`                  | Create investigation session                        | Repo-scoped CLI write credential.                                         |
| `POST /v1/sessions/:id/close`        | Mark capture grouping ended                         | Does not rewrite event facts or prove success.                            |
| `GET /v1/sessions`                   | Timeline groups                                     | Repo filter, cursor, page limit.                                          |
| `GET /v1/sessions/:id`               | Bounded context and processing state                | Reauthorize all linked sources.                                           |
| `POST /v1/events/batch`              | Atomic finalized-event ingestion                    | Write scope, limits, immutable IDs and exact ACK.                         |
| `GET /v1/events/:id`                 | Original redacted event and artifact locators       | Source scope recheck.                                                     |
| `GET /v1/artifacts/:id`              | Bounded artifact detail                             | Range/page policy for larger output.                                      |
| `POST /v1/memories/search`           | Ranked bounded sources                              | Read scope and current repository grants.                                 |
| `GET /v1/memories/:id`               | Structured summary, provenance and sources          | No stale permission bypass.                                               |
| `POST /v1/ask`                       | Answer using authorized evidence                    | Bounded provider input; insufficient-evidence response supported.         |
| `POST /v1/memories/:id/retry`        | Retry failed enrichment                             | Authorized scope, idempotent version key, rate limit.                     |
| `DELETE /v1/credentials/:id`         | Revoke paired device                                | Workspace owner/current authorized principal.                             |
| `DELETE /v1/workspace`               | Begin guarded deletion                              | Explicit confirmation UI, fresh owner verification and CSRF for browser.  |

## Pairing details

The pairing design belongs to Memvora; it is not automatically supplied by GitHub App installation or an MCP SDK.

Pairing request supplies a bounded `deviceName` and requested scopes. Response returns `userCode`, `deviceCode`, `verificationUri`, `expiresIn` and minimum poll `interval`. Initial defaults: 10-minute validity and 5-second polling, subject to rate-limit testing. Hash both codes at rest. The short displayed code is not a bearer credential.

Signed-in browser approval binds the pairing to an authorized workspace. Polling sends the secret code in a JSON body, never a URL. Pending returns a documented pending state; too-fast polling increases backoff; denied/expired returns a terminal state; successful atomic consumption returns the raw credential once. Polling after consumption cannot obtain it again. CLI uses the credential store before reporting login success.

## Event batch contract

The following illustrates the target structure. Replace fixture values with actual capture; implement the shared schema before shipping. Workspace is resolved from the credential; a selector in the body cannot override it.

```json
{
  "schemaVersion": 1,
  "events": [
    {
      "eventId": "11111111-1111-4111-8111-111111111111",
      "repositoryId": "22222222-2222-4222-8222-222222222222",
      "sessionId": "33333333-3333-4333-8333-333333333333",
      "sequence": 1,
      "startedAt": "2026-10-21T09:00:00.000Z",
      "endedAt": "2026-10-21T09:00:01.000Z",
      "command": { "executable": "npm", "args": ["test"], "shell": "cmd.exe" },
      "cwd": "repo-relative-or-redacted-location",
      "git": { "commitSha": null, "dirty": true },
      "outcome": { "kind": "completed", "exitCode": 1, "signal": null },
      "capture": { "complete": true, "truncatedBytes": 0, "redacted": true },
      "output": [{ "stream": "stderr", "ordinal": 0, "text": "fixture failure output" }],
      "diffs": []
    }
  ]
}
```

Contract decisions:

- At most 50 events/2 MiB per uncompressed batch. Output/diff caps also apply per event. Finalized events only; streaming partial-event upload is not an MVP feature.
- `outcome.kind` is `completed`, `spawn_failed`, `interrupted` or `incomplete`. Missing exit code is `null`, never automatically zero. Spawn error carries a safe error code/message through a discriminated schema.
- `stdout` and `stderr` are distinct in wrapper mode. Future PTY records use an explicit `pty` merged stream, not fabricated separation.
- Git SHA can be null for a repository with no commit. Record the reason when repository state cannot be read.
- Canonical server digest excludes transport-only fields. Clients may send a digest for diagnostics, but the server computes and verifies its own representation.
- First implementation uses an atomic batch. Invalid schema, unauthorized event or reused ID with different payload rejects the whole batch; no partial ACK.

Successful response after commit:

```json
{
  "acknowledgedEventIds": ["11111111-1111-4111-8111-111111111111"],
  "requestId": "example-request-id"
}
```

An identical resend returns the same acknowledged IDs without a duplicate execution/enrichment effect. An ambiguous network failure keeps all unacknowledged local IDs pending. The client never clears an entire live outbox based on a batch's success.

## Search and ask

Search input: `query` (nonempty bounded text), optional `repositoryIds`, `limit` (default 10/max 20), optional opaque cursor. Server intersects filters with current allowed repositories. Invalid/inaccessible explicit repo selectors follow the documented denial policy rather than widening the query.

Search results contain memory/source ID, repository ID, title/excerpt, outcome, event time, commit conditions, processing state, and authorized source locators. Similarity scores are internal ranking signals; do not present them as calibrated factual confidence.

Ask input adds an optional bounded `sessionId`. Response includes:

```ts
type RecallAnswer = {
  status: 'answered' | 'insufficient_evidence';
  answer: string;
  steps: Array<{ text: string; sourceIds: string[] }>;
  sources: Array<{
    id: string;
    kind: 'event' | 'artifact' | 'memory';
    repositoryId: string;
    locator: string;
  }>;
  uncertainty: string[];
  requestId: string;
};
```

A locator is an application source reference, not an arbitrary URL the model invents. Validate all cited IDs against the returned authorized bundle. Provider failure yields a truthful service error plus a way to access raw search results; it does not return a fabricated answer. No-source answers state insufficient evidence.

## CLI product surface

| Command                              | Target behavior                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `memvora login`                      | Browser approval and secure credential storage.                                         |
| `memvora logout`                     | Revoke or remove local credential; preserve workspace history.                          |
| `memvora init`                       | Resolve cwd/remote, choose authorized repo, save local binding.                         |
| `memvora status`                     | Show API/repo binding, pending count, blocked state and capture limits without secrets. |
| `memvora session start [title]`      | Begin explicit investigation grouping.                                                  |
| `memvora session end`                | End grouping; no automatic success claim.                                               |
| `memvora run -- <command> [args...]` | Capture supported explicit invocation and preserve child outcome.                       |
| `memvora sync`                       | Resend pending immutable events with bounded retry.                                     |
| `memvora ask <question>`             | Authorized cited recall in current repo; explicit repo override must be authorized.     |
| `memvora config`                     | Inspect/edit safe configuration and exclusions. Never print raw credentials.            |

Document which commands the starter actually implements. A placeholder should fail with a clear not-implemented message, never simulate successful capture, auth or synchronization.

## MCP tools

| Tool                  | Input                                   | Result                                                                 |
| --------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| `search_memory`       | query, optional repo IDs, bounded limit | Ranked memories/sources and safe locators.                             |
| `get_memory`          | memory ID                               | Current permitted summary, uncertainty and source references.          |
| `get_session_context` | session ID, optional cursor/limit       | Bounded ordered attempts, diffs/check references and unresolved state. |

Local stdio adapter uses an existing scoped credential through the same API. Transport stdout is reserved for JSON-RPC/protocol messages; logs go to stderr. Mark tools read-only in supported metadata. Tool names do not imply authority to execute commands. Tests verify no unauthorized source appears in tool text, metadata, errors or logs.

The current local adapter implements these three read tools through the authenticated API. `memvora_status` also calls the API for capability metadata. This local transport does not establish hosted authentication, installation-based repository grants, or production readiness. See [LOCAL_MVP.md](LOCAL_MVP.md) for executable setup and the actual bounded local contracts.
