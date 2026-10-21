# Local MVP: setup and implementation guide

This guide describes the implementation currently in the repository. [PRD.md](PRD.md), [ARCHITECTURE.md](ARCHITECTURE.md), [API.md](API.md) and [DATA_MODEL.md](DATA_MODEL.md) also describe a larger hosted target; those requirements are not automatically current capabilities. Verification results must be recorded independently of this implementation guide.

## 1. What runs

```text
Website server -----------+
Windows explicit CLI ----+--> authenticated loopback Fastify API --> local SQLite
Read-only MCP adapter ---+                    |
                                             +--> local background evidence jobs
                                             +--> optional configured HTTP AI adapter
                                             +--> explicit gh CLI repository import
```

The web server, CLI and MCP share runtime response contracts and the same local API. They do not open the server evidence database directly. The CLI has its own SQLite outbox for offline durability. The API ordinarily runs the local background processor, one job at a time; a separate worker executable is also present. There is no need to start it for the default development flow.

CLI and MCP version 0.4.0 can also be installed together from a private local tarball without this source checkout. Follow [CLIENT_INSTALLATION.md](CLIENT_INSTALLATION.md) for Node requirements, isolated installation, explicit server credentials, upgrades and removal. The API and website remain separate processes; source-development commands below retain their existing fallback paths.

Current server persistence is SQLite, not PostgreSQL/pgvector/pg-boss. Default enrichment deterministically organizes observed captured events into labeled memories; it is not a model-generated explanation. Lexical recall also searches the latest imported redacted code snapshot and returns immutable file citations. The optional provider path is separate and remains disabled unless explicitly configured.

Use [OWNER_SETUP.md](OWNER_SETUP.md) for the remaining owner actions: registering and authorizing a real private GitHub App, deliberately enabling an AI provider, and connecting a chosen MCP host. Local capture and recall work without App credentials or AI; GitHub import can use the existing authorized `gh` account when all App settings are absent.

### Recall evidence before a summary is ready

Accepted command evidence is searchable through Ask, CLI `ask` and MCP `search_memory` even when enrichment is queued, running or failed. Search covers the retained redacted command/arguments, working path, commit, outcome/error fields, captured output and diffs. It is token-based lexical retrieval, not semantic matching or guaranteed exact-substring search. Unsynced outbox rows are not in the server index; upload them before expecting recall.

When no stored summary exists, recall returns an observed projection with `representation: raw_event`, an explicit captured-event label and, when known, the current job's `processingStatus`. It retains the original event UUID and citations. `get_memory` resolves that same UUID before enrichment finishes. Reading evidence creates no memory, changes no job state and calls no provider. Stored-memory counts therefore remain counts of persisted summaries, not recall projections.

If a stored summary exists, it takes precedence, including when only the original output or diff matched. Raw and summary hits deduplicate by event UUID before applying the result limit. Repository/session scope and deletion checks apply to search and detail. Displayed output is bounded; follow the original event link at `/events/[id]` for the full retained capture, which can itself have capture truncation. A failed command or later passing command alone does not establish a causal fix. Ask still composes a cited answer from retrieved evidence rather than performing cross-event AI reasoning.

The normal application store upgrades to schema 8 and backfills its raw-evidence index from accepted events. For a recovery point before an upgrade, use [BACKUPS.md](BACKUPS.md); its operator supports schema 7 or 8 without upgrading the source. Implementation instructions and acceptance results remain separate; see [STATUS.md](STATUS.md).

### Find an older investigation

The Investigations page searches the complete authorized session directory before limiting results. Use a literal title substring, repository and optional open/closed filter; it does not search command/error, journal or imported-code content. Use Ask for those evidence queries. Title matching normalizes Unicode to NFC and lowercase, with punctuation treated literally. The display is bounded to 200 characters; `titleTruncated` indicates that matching text may fall outside the shown prefix. Open/closed describes the investigation state, not whether a fix was verified.

Each page is ordered by newest creation time and ID, rather than latest command/note activity. The page count and whole filtered matching count are separate. Use Older results to continue or First page to refresh the newest view; filter submissions reset the cursor. Directory pages are live reads, so later creation/deletion can change totals. A malformed browser URL shows a recoverable error without falling back to a wider search; its error view can have HTTP 200, while invalid API inputs return 400.

```powershell
node apps/cli/dist/index.js session list
node apps/cli/dist/index.js session list --repository <repository-id> --query "migration" --status closed --limit 10
node apps/cli/dist/index.js session list --all-repositories --query "migration" --limit 5 --cursor <nextCursor>
```

CLI prints one runtime-validated page as JSON. Default scope is the bound repository when present, otherwise the authorized workspace; query/status options retain that scope. `--repository` and `--all-repositories` are mutually exclusive explicit scopes that ignore cwd binding configuration. Read returned `filters` for the effective normalized selection. CLI/API page size defaults to 20 and supports 1–50. MCP `find_sessions` accepts `query`, `repositoryId`, `status`, `cursor` and a 1–10 limit (default five); it returns every page member and original API-provided title/flag within a 96 KiB escaped transport budget.

All clients call protected `POST /v1/sessions/search` with a validated JSON body. Return `page.nextCursor` unchanged for older results, or omit it for a fresh first page. Page size may change; effective filters must remain the same when using a cursor. These purpose-bound signed cursors survive restart and deletion of their anchor row, but do not bypass current scope/generation checks. They store a query digest rather than raw query text. No client follows pages automatically. This is distinct from the fixed accepted-event snapshots in `session show`/`get_session_context`. The directory requires no migration or provider credentials and loads no raw evidence payloads.

### Investigation journal

Open an investigation to record a note, decision or reported resolution, optionally linking up to ten captured command IDs from that investigation. Entries keep the local user's author/time, remain separate from raw command evidence and are not independently verified. Report text is normalized and redacted before persistence/search. Existing entries cannot be edited; add a correction as another note. Saving a resolution report does not close the investigation or prove a fix.

The composer preserves its draft and submission UUID after an uncertain response; retry unchanged text to avoid a duplicate entry. Editing the draft starts a new identity. Journal pages have their own earlier/latest navigation and preserve the command timeline's cursor. Original note pages and Ask citations retain attached evidence links. Ask can recover exact note terms or recent journal context, including an investigation with no captured command yet.

```powershell
node apps/cli/dist/index.js session note <session-id> --kind decision --text "Explain why you chose this approach" --event <event-id>
node apps/cli/dist/index.js session notes <session-id> --limit 10
```

Repeat `--event` to attach more commands. After an uncertain CLI write, use the printed `--note-id` with the same text/kind/links. CLI does not automatically retry note writes or add them to the capture outbox. MCP tools `search_session_notes`, `get_session_note` and `get_session_notes` read these reports; they never create one. Parent session/repository/workspace deletion removes notes and their search entries. Browser GitHub connection state does not confer another user's authority to write notes.

`npm run acceptance:journal` launches the compiled website and an isolated in-memory API store. It uses explicitly synthetic command metadata to check journal contracts, browser mutation guards, retries, redaction, CLI, Ask, note pages and actual MCP stdio. It loads no real user evidence and calls no GitHub or AI service; its report is `.memvora/journal-acceptance.json`. Existing real command/source acceptance checks remain separate.

### Investigation recap

Open an investigation to see a cited recap above its raw timeline. This computation works directly from accepted commands, including when enrichment is pending. It labels zero/nonzero exits, startup failures, interruptions, incomplete outcomes and diff/capture flags without inferring a fix or an engineer's intent. Each ordered step links to original evidence. Counts cover the included selection: all events through 40, otherwise first 20 and last 20 with explicit omitted-middle coverage. The full retained history remains available through timeline pagination. Refresh to include later uploads; the recap is computed on request rather than stored.

The same recap is available through CLI and MCP:

```powershell
node apps/cli/dist/index.js session recap <session-id>
node apps/cli/dist/index.js session recap <session-id> --json
```

With a bound local capture, omit the ID to read its current investigation. An explicit ID uses the shared local connection without requiring a capture binding in the current directory. MCP tool `get_session_recap` accepts `{ "id": "<session-id>" }`, returns cited observed steps and disclosed coverage, and never executes the recorded commands. This is a deterministic investigation recap; the optional AI adapter remains separate per-command enrichment.

With the compiled app running and an existing investigation containing at least three commands, `npm run acceptance:recap` checks API, CLI and real MCP agreement against original event UUIDs. It inserts no evidence or answer and verifies the evidence/processing counts remain unchanged. The ignored report is `.memvora/recap-acceptance.json`.

### Personal portable handover

Open an investigation's **Handover report** to preview `/sessions/[id]/handover`, then download Markdown or JSON. This combines observed command evidence with the latest authored notes without treating those notes as independently verified facts. Each preview/download computes a fresh authorized snapshot; later uploads or notes can change the next report.

The report reads existing SQLite data in one transaction. It includes the recap's all-through-40 or first-20/last-20 selection, the latest ten current-generation notes, and every original same-session command cited by those notes. Additional linked commands can come from the omitted middle. Event membership is deduplicated and ordered, at most 140; note bodies retain their complete normalized/redacted text. Embedded note/event UUIDs preserve offline citation resolution. Outcome counts belong to the recap's selected events, while report coverage separately counts all embedded events and omitted notes/events. Repository-file contents and derived memories are excluded.

This computation writes no database records, starts no jobs and calls no AI or GitHub provider. It needs no additional migration beyond existing capture/journal storage. Commands, working paths, output and diff text are normalized, defensively redacted and safely excerpted; explicit flags separate export clipping from original capture truncation. Adaptive output/diff limits preserve IDs, citations and membership while keeping compact report JSON within 2 MiB. Pretty JSON and Markdown files have a separate 8 MiB download cap. A size cap is not a performance guarantee.

```powershell
node apps/cli/dist/index.js session export <session-id> --format markdown
node apps/cli/dist/index.js session export <session-id> --format json --output .\investigation-handover.json
```

Without an ID, CLI uses the current bound investigation; an explicit ID uses the configured local connection. Markdown is the default format. With no `--output`, validated file content goes to stdout. `--output` requires an existing parent directory, creates a new file exclusively and refuses to overwrite existing files or symlinks. A failed disk write may leave a new partial file for manual review. It does not automatically open, execute or upload the report.

MCP `get_session_handover({id})` provides a read-only preview under a 96 KiB response budget, preserving every event/note/source ID and coverage while disclosing further excerpt shortening. It explicitly omits output/diff text, working directories and detailed event timestamps/signals/errors; `fullReportIncluded` is false. It does not create a downloadable file; use the website or CLI for that. Original API locators still refer to this local instance, while the report's embedded records resolve its included citations offline.

A download is an independent personal copy. Later deletion, disconnect or access changes in Memvora cannot remove or update saved copies. Review private output/code and possible undetected secrets before sharing. This bounded report is not a complete backup or repository export, and does not implement company ownership, recipient access controls or offboarding revocation.

## 2. Start development

Prerequisites: Windows PowerShell, Node 24 or 26 and npm 11+. The Git executable adds commit/dirty/diff provenance. GitHub CLI is optional until importing GitHub context. No local AI model, GPU workload or external database is needed for capture and observed recall.

From `C:\Users\victus\Desktop\hackathon\vips-cosmic`:

```powershell
.\scripts\with-resource-limits.ps1 npm.cmd ci
.\scripts\with-resource-limits.ps1 npm.cmd run dev
```

The resource wrapper sets affinity to two logical processors on Windows, below-normal priority, two-thread worker pools and bounded Node memory/V8 pool settings for the command's process tree. It is the recommended entry point for install, development, build and checks. It does not start a GPU process. If execution policy blocks the file, use a process-scoped invocation:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\with-resource-limits.ps1 npm.cmd run dev
```

Visit `http://127.0.0.1:3000`. API default: `http://127.0.0.1:4000`. Keep the first terminal running. Restart after changing server configuration. Shared-package changes require rebuilding/restarting the development command.

Optional config:

```powershell
Copy-Item .env.example .env
```

Do not overwrite an existing local `.env`. Root scripts load it for API/CLI/worker. Next.js reads environment files from `apps/web`; when changing `MEMVORA_API_URL`, `MEMVORA_DATA_DIR` or an explicit local token, provide consistent values in the web server environment, such as ignored `apps/web/.env.local`. Never use a `NEXT_PUBLIC_` token variable.

Direct `node` invocations and MCP hosts do not automatically load the root `.env`. With custom API/data-directory/credential overrides, pass the corresponding environment explicitly. `MEMVORA_DATA_DIR` must be an absolute path. The default commands below work without overrides.

## 3. Local identity and data

The API creates `.memvora/local-token` and `.memvora/server.sqlite` under the project by default. `MEMVORA_DATA_DIR` overrides the server data directory. `MEMVORA_LOCAL_TOKEN` can override the credential; it must contain at least 32 characters. The web server reads it on the server side; source-checkout CLI/MCP entry points retain the application-root fallback even when capturing another repository. Installed portable clients require an explicit server data directory or token and do not search for an application root.

This token identifies a trusted-machine development workspace. It is not GitHub OAuth, a browser session, a per-device credential, company membership or an OS credential-store implementation. The API refuses non-loopback binding and production mode. Do not expose it through port forwarding, a public tunnel or public hosting as if it had production authentication. Clients reject redirects and API-origin URLs containing credentials, queries or fragments.

Repository capture data lives in `<captured-repository>/.memvora/config.json` and `outbox.sqlite`; it remains separate from the server's token and evidence database. Initialization creates a nested `.memvora/.gitignore` before storing data, and preserves an existing ignore file. Verify local capture data remains excluded before committing. Back up local data deliberately if it matters; normal build output is not a backup.

### Database recovery points

Use the local `/backups` guide or `npm run backup:local -- create` through the resource wrapper to create a new complete SQLite snapshot. `npm run backup:local -- verify --input <absolute-backup-directory>` checks the same saved copy read-only. The operator uses SQLite's online backup mechanism, writes its completion manifest last and refuses an existing destination. It preserves accepted evidence, imported versions, search state, counters, deletion fences and encrypted connection state. It excludes external credentials/environment and repository-local outboxes, so unuploaded commands need a separate copy. The raw snapshot contains private records and signing material and is not encrypted as a whole. See [BACKUPS.md](BACKUPS.md) for paths, Windows access controls, size/time limits and the disposable synthetic recovery rehearsal. No live restore or replacement command is implemented.

## 4. Capture a real investigation

In a second terminal from the project root:

```powershell
.\scripts\with-resource-limits.ps1 npm.cmd run cli -- login
.\scripts\with-resource-limits.ps1 npm.cmd run cli -- init
.\scripts\with-resource-limits.ps1 npm.cmd run cli -- status
.\scripts\with-resource-limits.ps1 npm.cmd run cli -- session start "Investigate failing project check"
.\scripts\with-resource-limits.ps1 npm.cmd run cli -- run -- npm test
```

`login` verifies the existing local development token; it does not open an OAuth/device approval flow. First-time `init` explicitly registers the local repository and creates its first session. Repeating it verifies the existing authorized repository and current session without changing the binding file or opening/resetting the outbox. A closed current session stays closed; use `session start` for new work. A repository-only binding remains repository-only. An invalid binding, denied/deleted repository, mismatched repository selector or conflicting API origin fails without replacing local data. `--repository-id` uses exact authorized lookup rather than the recent repository list. Initialization reads a Git remote where available but does not thereby authorize a GitHub App. A local folder without a commit has `commitSha: null` with unavailable metadata reported.

Open `http://127.0.0.1:3000/setup` for commands with the actual installation paths and a read-only MCP host configuration. The guide reports whether the CLI/MCP build files exist and verifies local API connectivity. Repository detail pages link to an authorized scoped version. Copy the PowerShell commands into a terminal in your actual target repository; they do not depend on that project defining Memvora npm scripts. The guide reads no environment-file contents and includes no token values.

First-ever initialization still spans server creation and an exclusive local config write. A network failure or competing initialization can leave a created repository/session before the local write succeeds. Existing bindings are preserved; this is not a cross-process, server-wide idempotency guarantee. Keep pending evidence and investigate the failed setup instead of deleting the outbox or editing captured UUID/sequence values.

To capture an external project, build the services once through the resource wrapper, change into that project, and invoke the absolute CLI path:

```powershell
# Run this build from the Memvora project root first.
.\scripts\with-resource-limits.ps1 npm.cmd run build:services

# In another terminal, change into your actual target repository.
$memvoraCli = 'C:\Users\victus\Desktop\hackathon\vips-cosmic\apps\cli\dist\index.js'
node $memvoraCli init
node $memvoraCli session start "Investigate actual failure"
node $memvoraCli run -- npm test
```

If the API uses overrides from the root `.env`, include that file explicitly on each direct CLI invocation, for example:

```powershell
node --env-file-if-exists="C:\Users\victus\Desktop\hackathon\vips-cosmic\.env" $memvoraCli status
```

Use the same Node option for `init`, `run`, `sync`, session commands and `ask` when those overrides are required. Keep the environment file private.

The current terminal cwd is the target of capture. Run the failing command, try a corrective code change, run a relevant check again, then end the investigation. Do not edit Memvora to insert the expected answer. Repeat with a second independent failure to test generality. A passing command alone does not prove the root cause or that a complete incident is resolved.

```powershell
node $memvoraCli run -- npm test
node $memvoraCli session end
node $memvoraCli ask "What did I try for the earlier failing check?"
```

Choose a question containing actual recorded error text or distinctive command context. If code was imported, identifiers, filenames or distinctive code phrases can also match file evidence. Open returned event or file sources in the website. If no matching evidence exists, recall should report insufficient evidence. The observed mode is not a semantic/vector search engine or a guarantee that any reworded question matches. Imported code shows what was captured; it does not establish that a command ran or that an issue was fixed.

### File-based command inputs

Use a script file when quoting a complex command would obscure what is being executed:

```powershell
node $memvoraCli run -- node .\scripts\reproduce-issue.cjs
node $memvoraCli run -- node .\scripts\verify-fix.cjs
```

These filenames are examples; create or select real project scripts rather than assuming Memvora generated them. Literal arguments after `--` use `shell:false`. On Windows, npm/npx resolve to their JavaScript entry points under Node. Other batch files require explicit shell mode:

```powershell
node $memvoraCli run --shell powershell -- "Get-ChildItem ."
node $memvoraCli run --shell cmd -- "echo local shell smoke test"
```

Shell mode accepts one deliberately interpreted command string. Noninteractive capture disables stdin; password prompts, full-screen terminal apps and arbitrary integrated terminal history are not supported. Commands run outside `memvora run` are not captured.

## 5. What capture records and how sync works

Each invocation gets a new UUID and monotonic local session sequence before launch. The outbox persists redacted starting metadata, continuously drains stdout/stderr, stores bounded chunks, then finalizes the outcome and code-diff snapshot. Missing executables remain execution attempts. Signaled termination and crash recovery are marked interrupted/incomplete rather than fabricated success.

Git provenance is best-effort evidence. Failed HEAD, status or before/after diff probes add a safe stage/classification to `git.error`; failed diff phases are omitted rather than stored as empty snapshots. Missing Git, a non-repository folder, an unborn HEAD or a timed-out probe does not prevent command capture. It does make `capture.complete` false, even if command output and exit status were recorded fully. A false `git.dirty` alongside `git.error` is not confirmation of a clean worktree; inspect the error and retained snapshots. Raw Git diagnostics are not persisted.

Diffs are bounded, filtered tracked-file snapshots within the capture directory, relative to the then-current HEAD. They can contain pre-existing changes and omit untracked-file contents; they are not a precise patch attributed to one command. Recaps describe text equality/difference only when both snapshots are present, untruncated and Git probing reported no error. Equal retained prefixes or failed probes cannot confirm an unchanged worktree. Open original events for phase/truncation metadata; a snapshot difference does not prove which change fixed an error.

Uploads use immutable event IDs. API acknowledgement follows durable acceptance and lists exact committed IDs. Only those IDs become synced locally. A lost response leads to a safe resend; a new event created during upload stays pending until its own acknowledgement. Recovery marks an unfinished execution incomplete only when its recorded owner process is confirmed dead. A running or inaccessible owner is preserved, so concurrent sync cannot finalize a live capture. Legacy ownerless rows or a reused process ID need manual review rather than a destructive guess.

```powershell
node $memvoraCli sync
node $memvoraCli status
```

An unavailable API during auto-sync does not discard finalized local evidence. First binding/session creation still requires the API. If a command fails, the wrapper preserves its failure status where representable even if capture succeeded.

### Inspect a local outbox and sync one selection

Use `/capture-recovery` for manual PowerShell command generation, or follow [OUTBOX_RECOVERY.md](OUTBOX_RECOVERY.md). `outbox list --directory <absolute-capture-folder>` reads existing local metadata without a token, API, initialization, migration or crash recovery; it never opens the server database. It defaults to the oldest 20 `unsynced` rows and supports state/session filters plus a positive `--after` row ID. Unsynced combines finalized pending rows and unfinished captures; an incomplete row may still have a live owner. Synced means an exact acknowledgement was recorded locally, not that later server access/deletion is unchanged. Listing is logically read-only, though SQLite can manage lock sidecars.

`sync --session <UUID>` or `sync --event <UUID>` attempts one mutually exclusive selection from the original bound capture folder. An older rejected event need not block an unrelated selected upload. Selected sync does not recover unfinished executions, change IDs/content, force acknowledgements or recreate deleted server records. Its JSON result separates acknowledged evidence and selected/global remaining counts; later-created rows are outside its start boundary. Auto-sync after `run` targets the new event. Ordinary unfiltered sync retains conservative confirmed-dead recovery. The raw local outbox remains private and is excluded from server-only backups; preserve it rather than deleting or reassigning rejected evidence.

Current conservative capture limits are 128 KiB persisted output per command, 32 KiB per before/after tracked diff, a bounded output-chunk count and a 16 KiB line buffer. Overlong lines are suppressed and count toward truncation; output loss makes capture incomplete. The local database has a 500 MiB admission cap. Output continues draining after persistence caps. Unsynced data is not silently evicted. File capture does not include untracked contents; tracked sensitive paths are excluded from diff snapshots.

Known credential patterns, the local token, password/token arguments and private-key blocks are redacted before local storage/display. Redaction is imperfect; avoid commands that print private credentials. Capture children do not inherit Memvora's `MEMVORA_LOCAL_TOKEN`, `AI_API_KEY`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET` or `GITHUB_PRIVATE_KEY` variables. The child's own application credentials require its usual explicit configuration.

## 6. Website routes

| Route                     | Purpose                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `/`                       | Counts and recent recorded work in the local workspace.                      |
| `/repositories`           | Explicit local registration plus optional GitHub browsing/import.            |
| `/repositories/[id]`      | Repository details, imported context and relevant sessions.                  |
| `/sessions`               | Server-filtered live investigation directory with bounded older pages.       |
| `/sessions/[id]`          | Captured attempts and generated/observed memories.                           |
| `/sessions/[id]/handover` | Personal report preview, coverage and Markdown/JSON downloads.               |
| `/events/[id]`            | Original command, outcome, output and tracked diffs.                         |
| `/memories/[id]`          | Summary, mode, steps, uncertainty and source links.                          |
| `/ask`                    | Source-linked recall with repository filtering.                              |
| `/jobs`                   | Scoped processing states, attempt history and explicit failed-summary retry. |
| `/settings`               | Actual local storage/enrichment settings, limits and connection diagnostics. |
| `/capture-recovery`       | Manual offline outbox-list and selected-sync command guide.                  |

The first-run workspace is empty. Counts and memories reflect stored data, not showcase samples. Processing may briefly lag ingestion. A failed provider job leaves raw event detail available. Open Memory processing to filter by repository, investigation or state. Failed summaries can be retried explicitly after fixing their configuration; running, queued and ready jobs cannot be reset. Each cycle has three automatic attempts, and manual retry counts remain visible. A retry uses the same accepted evidence and the current summary configuration, which can send it to a configured AI endpoint again.

Deletion actions currently use the guarded local API; the settings screen has no deletion controls.

Imported-file detail opens at `/sources/[id]?startLine=N&limit=100`, showing immutable provenance and bounded stored-snapshot lines.

### Browse older investigation history

The website provides Earlier attempts, Later attempts, page-size selection and Refresh latest. The CLI exposes the same route as `memvora session show [authorized-session-uuid] --limit 5`, with optional `--cursor` for a returned navigation cursor. Without an explicit UUID it uses the bound current investigation; an explicit UUID uses the explicit/environment/default connection independently of folder bindings. Output is validated JSON containing the original events, their linked summaries and page metadata.

The session history view and MCP can navigate beyond the legacy latest-100-event window. The local API route is `GET /v1/sessions/:id/events?limit=20`. The first page contains the latest accepted events, ordered by session sequence. Follow its `page.olderCursor` to earlier events and `page.newerCursor` to later events in the same snapshot. API limits are 1–50 events per page; MCP uses 1–10, default five. Empty pages expose null sequence boundaries and navigation cursors rather than invented history.

Navigation fixes the set of events accepted at the first request. Later uploads are excluded even if they have earlier sequence numbers. A fresh request without a cursor starts a new snapshot. `page.snapshotEventCount` stays fixed while `session.eventCount` reports the live accepted total, so those counts can differ. Enrichment can finish while browsing; source events remain authoritative and page-associated memories can change independently of fixed event membership.

Cursors are opaque, signed and bound to the authenticated workspace/repository/session generations. Return them unchanged and URL-encoded, with the same session ID. They do not grant access. Tampered or wrong-session cursors are rejected; deletion makes the old scope unavailable and does not allow an old cursor to recreate evidence. The original `GET /v1/sessions/:id` still provides its latest-100 window for compatibility; use `/events` for paged history.

After building and starting the app, run `npm run acceptance:history` to verify earlier/later API, CLI and real MCP stdio navigation against an existing investigation with at least three captured events. It seeds no evidence, pins the same snapshot across adapters and writes the ignored `.memvora/history-acceptance.json` report. Large MCP pages adapt their excerpts to a 96 KiB total response budget while retaining every event ID and navigation cursor.

## 7. Optional GitHub context

With no App settings, use your existing `gh auth login` identity. A complete private GitHub App configuration enables browser connection from Settings and Repositories, followed by authorized installation and repository selection. App mode never falls back to the CLI's broader access after a failure. The repository page explicitly imports a bounded snapshot: up to 20 supported small text files, 256 KiB total, recent issue/PR metadata and commit provenance. Large repositories are intentionally partial. Import does not run repository code.

The local App flow implements state/browser binding, S256 PKCE, server-side token encryption, refresh, numeric account pinning and current user/installation repository checks. Owner registration and credentials are needed for a live connection; [GITHUB_SETUP.md](GITHUB_SETUP.md) gives the exact private App settings. Local disconnect removes credentials and pending flows while retaining imported history. It does not uninstall the App or revoke the GitHub grant. Hosted browser/device authentication, durable webhooks and continuous synchronization remain separate work. Do not paste a GitHub token into the website.

After building, `npm run acceptance:github-oauth` launches a separate compiled website and an isolated in-memory API with an explicitly injected fixture provider. It checks the actual BFF start/callback cookie flow, PKCE, missing-browser and replay rejection, denial, protected installation selection, import/source recall and local disconnect. It uses no live GitHub authorization or user evidence and records `.memvora/oauth-acceptance.json`. Windows and Linux CI run this check after the build.

### Search and cite imported code

Ask combines matching command investigations with up to five imported-file matches. File evidence retains its source ID, repository/path, available commit SHA, content hash and bounded line range. Source-specific search also returns file matches without pretending they are execution memories. Session-filtered asks narrow file evidence to that session's repository. Explicit recent-investigation questions use command history, even if imported text contains those words. Optional per-event AI enrichment still receives execution evidence; imported code is retrieved directly in this slice.

Search considers only the latest captured import for each allowed repository. Reimporting creates or selects immutable file versions and changes the current set atomically. An old citation still opens its original redacted text while its parent remains active; `isCurrent: false` identifies historical evidence. A source with unknown commit keeps `commitSha: null`. Source line numbers describe the stored redacted snapshot, which can differ from original GitHub lines after redaction.

Files may be omitted because of size, type, exclusions, network limits or bounded selection. A partial snapshot does not prove omitted paths were deleted or that the whole repository was searched. A failed atomic save leaves the previous captured set current. Per-repository retained history is capped at 32 MiB of file text and 2,000 immutable versions; exceeding admission limits rejects the new import and preserves prior citations instead of silently evicting them.

Repository/workspace deletion makes both current and historical sources unavailable and removes search entries. Source reads recheck scope; knowing an old source ID does not grant access. See [API.md](API.md) for source query/range contracts.

## 8. Optional HTTP AI

Observed summaries work by default without a provider. To enable the separate HTTP adapter deliberately, configure ignored root `.env`:

```dotenv
MEMVORA_AI_ENABLED=true
AI_BASE_URL=https://your-provider.example/v1
AI_API_KEY=your-key
AI_MODEL=your-supported-model
```

Restart the relevant processes. The chosen provider must support the adapter's request/JSON-response parameters. Existing memories are not silently relabeled as AI output. The worker validates structured output and citations; failure leaves raw evidence and a truthful job state. No real provider is claimed tested without its configured credentials and recorded results. Enabling this sends bounded redacted evidence to that endpoint. See [AI_SETUP.md](AI_SETUP.md) for exact constraints.

## 9. MCP retrieval

Build services, then configure the MCP host to launch direct Node with the absolute `apps/mcp/dist/index.js` path. Avoid npm banners on protocol stdout. The same local token/data-directory rules apply.

```json
{
  "mcpServers": {
    "memvora": {
      "command": "node",
      "args": ["C:/Users/victus/Desktop/hackathon/vips-cosmic/apps/mcp/dist/index.js"],
      "env": { "MEMVORA_API_URL": "http://127.0.0.1:4000" }
    }
  }
}
```

Host configuration details vary by client. Available tools include `memvora_status`, `search_memory(query, repositoryIds?, limit?)`, `get_memory(id)`, `get_session_context(id, cursor?, limit?)` and the read-only `get_session_handover` preview, plus the imported-source tools described in the adapter guide. They use the API, retain source IDs and return bounded excerpts. Session context returns snapshot page metadata so earlier work can be retrieved through `olderCursor` instead of stopping at 100 events. No tool runs commands or edits code. Diagnostic output uses stderr. See [the adapter guide](../apps/mcp/README.md).

For custom configuration, set `MEMVORA_API_URL` and the absolute `MEMVORA_DATA_DIR` in the MCP server environment. The adapter itself does not load the root `.env`; the setup guide's generated Node launch arguments explicitly load that optional file. If an explicit token override is supplied outside that file, provide the same value through the host's private environment/secret settings; never commit it in the JSON configuration. All tool input schemas reject unknown fields before API access, so a misspelled selector cannot silently widen a search.

## 10. Current local routes versus hosted target

The current API implements `/health`, `/v1/system/status`, `/ready`, `/v1/me`, dashboard/settings, repository registration/list/detail, session creation/list/detail/close, paged history, recaps, immutable journal entries, personal handover preview/download, event batch/detail, memory search/detail, imported-source search/ranged detail, ask, scoped processing-job lists, failed-job retry and guarded local deletion actions. GitHub integration adds status, paginated repository browsing, explicit import and stored-context detail. Exact schemas are in `packages/contracts/src/local.ts`; route behavior is in `apps/api/src/app.ts` and `apps/api/src/integrations/github.ts`.

Local protection uses the bearer credential, loopback checks, repository/workspace scope and deletion fences. It is not a substitute for hosted users, organization roles, GitHub App revocation synchronization or remote MCP authorization. Remaining hosted work includes PostgreSQL migration, pg-boss integration, pgvector retrieval, per-device credentials, browser sessions/CSRF design, OS credential storage, company ownership, operational retention and public deployment readiness. Keep those original acceptance gates in the PRD/roadmap.

## 11. Checks and troubleshooting

Run checks under the resource wrapper:

```powershell
.\scripts\with-resource-limits.ps1 npm.cmd run check
.\scripts\with-resource-limits.ps1 npm.cmd run build
.\scripts\with-resource-limits.ps1 npm.cmd run doctor
```

These are instructions, not a record of passed results. Root verification records should identify actual commands/outcomes and whether external providers were exercised.

| Symptom                             | First check                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Website cannot reach API            | API terminal, loopback URL, matching environment and local token/data directory.                                                   |
| CLI cannot find credential          | Start API; check `MEMVORA_DATA_DIR`, `MEMVORA_LOCAL_TOKEN` or `--home`. Do not print the token.                                    |
| API rejects captured event          | Keep pending outbox data; inspect safe error/limits and current shared-package builds. Do not alter an already-sent event payload. |
| No stored summary after capture     | Check processing state; accepted raw evidence remains searchable without waiting for enrichment.                                   |
| Ask finds nothing                   | Use distinctive recorded text; verify bound repo/session and successful sync. Displayed excerpts may omit matching output.         |
| GitHub unavailable                  | Verify `gh` is installed/authenticated and network is available; restart after changing GitHub identity.                           |
| AI job fails                        | Check provider configuration and job state; accepted raw evidence remains available through recall and original history.           |
| npm/batch launch differs on Windows | Use Node/npm direct mode or one explicit quoted shell command; interactive programs are unsupported.                               |

Do not delete local data as a routine troubleshooting step. Export/backup useful evidence first and use the intended deletion controls for destructive actions.
