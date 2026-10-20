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

Current server persistence is SQLite, not PostgreSQL/pgvector/pg-boss. Default enrichment deterministically organizes observed captured events into labeled memories; it is not a model-generated explanation. The optional provider path is separate and remains disabled unless explicitly configured.

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

## 3. Local identity and data

The API creates `.memvora/local-token` and `.memvora/server.sqlite` under the project by default. `MEMVORA_DATA_DIR` overrides the server data directory. `MEMVORA_LOCAL_TOKEN` can override the credential; it must contain at least 32 characters. The web server reads it on the server side; CLI/MCP read it from the application root even when capturing another repository.

This token identifies a trusted-machine development workspace. It is not GitHub OAuth, a browser session, a per-device credential, company membership or an OS credential-store implementation. The API refuses non-loopback binding and production mode. Do not expose it through port forwarding, a public tunnel or public hosting as if it had production authentication. Clients reject redirects and API-origin URLs containing credentials, queries or fragments.

Repository capture data lives in `<captured-repository>/.memvora/config.json` and `outbox.sqlite`; it remains separate from the server's token and evidence database. Initialization creates a nested `.memvora/.gitignore` before storing data, and preserves an existing ignore file. Verify local capture data remains excluded before committing. Back up local data deliberately if it matters; normal build output is not a backup.

## 4. Capture a real investigation

In a second terminal from the project root:

```powershell
.\scripts\with-resource-limits.ps1 npm.cmd run cli -- login
.\scripts\with-resource-limits.ps1 npm.cmd run cli -- init
.\scripts\with-resource-limits.ps1 npm.cmd run cli -- status
.\scripts\with-resource-limits.ps1 npm.cmd run cli -- session start "Investigate failing project check"
.\scripts\with-resource-limits.ps1 npm.cmd run cli -- run -- npm test
```

`login` verifies the existing local development token; it does not open an OAuth/device approval flow. `init` explicitly registers the local repository and creates its first session. It reads a Git remote where available but does not thereby authorize a GitHub App. A local folder without a commit has `commitSha: null` with unavailable metadata reported.

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

The current terminal cwd is the target of capture. Run the failing command, try a corrective code change, run a relevant check again, then end the investigation. Do not edit Memvora to insert the expected answer. Repeat with a second independent failure to test generality. A passing command alone does not prove the root cause or that a complete incident is resolved.

```powershell
node $memvoraCli run -- npm test
node $memvoraCli session end
node $memvoraCli ask "What did I try for the earlier failing check?"
```

Choose a question containing actual recorded error text or distinctive command context. Open the returned event sources in the website. If no matching evidence exists, recall should report insufficient evidence. The observed mode is not a semantic/vector search engine or a guarantee that any reworded question matches.

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

Uploads use immutable event IDs. API acknowledgement follows durable acceptance and lists exact committed IDs. Only those IDs become synced locally. A lost response leads to a safe resend; a new event created during upload stays pending until its own acknowledgement. Recovery marks an unfinished execution incomplete only when its recorded owner process is confirmed dead. A running or inaccessible owner is preserved, so concurrent sync cannot finalize a live capture. Legacy ownerless rows or a reused process ID need manual review rather than a destructive guess.

```powershell
node $memvoraCli sync
node $memvoraCli status
```

An unavailable API during auto-sync does not discard finalized local evidence. First binding/session creation still requires the API. If a command fails, the wrapper preserves its failure status where representable even if capture succeeded.

Current conservative capture limits are 128 KiB persisted output per command, 32 KiB per before/after tracked diff, a bounded output-chunk count and a 16 KiB line buffer. Overlong lines are suppressed and count toward truncation; output loss makes capture incomplete. The local database has a 500 MiB admission cap. Output continues draining after persistence caps. Unsynced data is not silently evicted. File capture does not include untracked contents; tracked sensitive paths are excluded from diff snapshots.

Known credential patterns, the local token, password/token arguments and private-key blocks are redacted before local storage/display. Redaction is imperfect; avoid commands that print private credentials. Capture children do not inherit Memvora's `MEMVORA_LOCAL_TOKEN`, `AI_API_KEY`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET` or `GITHUB_PRIVATE_KEY` variables. The child's own application credentials require its usual explicit configuration.

## 6. Website routes

| Route                | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `/`                  | Counts and recent recorded work in the local workspace.                   |
| `/repositories`      | Explicit local registration plus optional GitHub browsing/import.         |
| `/repositories/[id]` | Repository details, imported context and relevant sessions.               |
| `/sessions`          | Investigation list.                                                       |
| `/sessions/[id]`     | Captured attempts and generated/observed memories.                        |
| `/events/[id]`       | Original command, outcome, output and tracked diffs.                      |
| `/memories/[id]`     | Summary, mode, steps, uncertainty and source links.                       |
| `/ask`               | Source-linked recall with repository filtering.                           |
| `/settings`          | Actual local storage/enrichment settings and supported lifecycle actions. |

The first-run workspace is empty. Counts and memories reflect stored data, not showcase samples. Processing may briefly lag ingestion. A failed provider job must leave raw event detail available.

## 7. Optional GitHub context

Use your existing `gh auth login` identity. The repository page can browse accessible repositories and explicitly import a bounded snapshot: up to 20 supported small text files, 256 KiB total, recent issue/PR metadata and commit provenance. Large repositories are intentionally partial. Import does not run repository code.

This manual local bridge is not continuous GitHub App synchronization or production installation authorization. A private App manifest is drafted, but callback, installation and webhook flows require their own implementation/owner setup. See [GITHUB_SETUP.md](GITHUB_SETUP.md). Do not paste a GitHub token into the website.

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

Host configuration details vary by client. Available tools: `memvora_status`, `search_memory(query, repositoryIds?, limit?)`, `get_memory(id)` and `get_session_context(id, limit?)`. They use the API, retain source IDs and return bounded excerpts. Session tools report total event count separately from the latest-100-event window. No tool runs commands or edits code. Diagnostic output uses stderr. See [the adapter guide](../apps/mcp/README.md).

## 10. Current local routes versus hosted target

The current API implements `/health`, `/v1/system/status`, `/ready`, `/v1/me`, dashboard/settings, repository registration/list/detail, session creation/list/detail/close, event batch/detail, memory search/detail, ask and guarded local deletion actions. GitHub integration adds status, paginated repository browsing, explicit import and stored-context detail. Exact schemas are in `packages/contracts/src/local.ts`; route behavior is in `apps/api/src/app.ts` and `apps/api/src/integrations/github.ts`.

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
| No memory immediately after capture | Allow local background processing; inspect session/raw event and failure state.                                                    |
| Ask finds nothing                   | Use distinctive recorded text; verify the bound repo/session and that evidence synced.                                             |
| GitHub unavailable                  | Verify `gh` is installed/authenticated and network is available; restart after changing GitHub identity.                           |
| AI job fails                        | Confirm deliberate enablement and provider parameter support; raw history should remain.                                           |
| npm/batch launch differs on Windows | Use Node/npm direct mode or one explicit quoted shell command; interactive programs are unsupported.                               |

Do not delete local data as a routine troubleshooting step. Export/backup useful evidence first and use the intended deletion controls for destructive actions.
