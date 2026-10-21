# Windows-first explicit command capture

After building, invoke `node <absolute-project-path>/apps/cli/dist/index.js --help`. During development, use the root `npm run cli -- <arguments>`. For external repositories use the direct absolute executable from that repository's terminal so the intended cwd is captured.

The API must already be running. Its local-development token is read from this application's `.memvora/local-token`, `MEMVORA_DATA_DIR/local-token`, or `MEMVORA_LOCAL_TOKEN`. `--home <directory>` overrides the server data directory. The token is never printed and is only sent to a loopback API. This trusted-machine mode is **not production device pairing or an OS credential-store implementation**. Restrict access to the data folder; never commit it. GitHub authentication and permission synchronization are separate integrations.

```text
memvora login
memvora init
memvora status
memvora run -- npm test
memvora run -- node script.js "literal argument"
memvora run --shell powershell -- "Get-ChildItem ."
memvora run --shell cmd -- "echo hello"
memvora sync
memvora ask "What happened in the earlier failing test?"
memvora ask "CodeIdentifier" --repository <authorized-repository-uuid>
memvora session start "Investigate startup failure"
memvora session list
memvora session list --query "migration" --repository <authorized-repository-uuid> --status closed --limit 10
memvora session list --all-repositories --query "migration" --limit 10 --cursor <nextCursor>
memvora session show
memvora session show <authorized-session-uuid> --limit 5
memvora session show <authorized-session-uuid> --limit 5 --cursor <older-or-newer-cursor>
memvora session recap
memvora session recap <authorized-session-uuid> --json
memvora session export
memvora session export <authorized-session-uuid> --format json --output <new-private-file.json>
memvora session export <authorized-session-uuid> --format markdown --output <new-private-file.md>
memvora session note --text "Investigated the startup failure" --kind note
memvora session note <authorized-session-uuid> --text "Chose this approach after the checks" --kind decision --event <event-uuid> --event <another-event-uuid>
memvora session note <authorized-session-uuid> --text "Same original text when retrying" --kind resolution --note-id <original-note-uuid>
memvora session notes
memvora session notes <authorized-session-uuid> --limit 10 --before <olderBeforeId>
memvora session end
```

Ask searches command memories and bounded imported code through the same protected API. The repository option uses the explicit `--api-url`/environment/default connection and the requested repository ID, independently of the current folder binding; the API still verifies access. Normal binding lookup stops at the current Git root, so unrelated ancestor settings cannot bind a new project. A corrupt binding inside the current repository remains an error. File citations include immutable source IDs and source-detail locators. Imported code is source content, not proof that a command ran or a fix worked.

`init` registers an explicit local repository with the authenticated API and creates an investigation session. An existing ID can be selected with `init --repository-id <id>`. This is local access, not evidence of GitHub App authorization. The repo binding and SQLite outbox live in `<repository>/.memvora`; keep that folder ignored. The server credential remains in the application data directory even when capturing an external repository.

`run` allocates a new execution UUID and session sequence, stores starting metadata, continuously drains/redacts stdout/stderr, persists bounded output, records exit/startup error/interruption and before/after Git diffs, then attempts upload. Repeated identical commands stay distinct. A failed upload keeps evidence pending. `sync` resends the same event IDs and marks only exact acknowledged IDs synced. Crash leftovers become explicitly incomplete attempts on the next run/sync.

Arguments are passed directly with `shell:false`. On Windows, npm/npx are resolved to their JavaScript entry points under Node so literal arguments do not pass through a batch string. Other `.cmd`/`.bat` files require the explicit `--shell cmd` mode with one quoted command string. Shell mode intentionally interprets that string; it is opt-in. No commands outside this wrapper are captured. stdin is disabled: prompts, full-screen tools and arbitrary interactive shells require future PTY support.

In local development, the capture child does not inherit Memvora's `MEMVORA_LOCAL_TOKEN`, `AI_API_KEY`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET` or `GITHUB_PRIVATE_KEY` environment variables. Configure a child program's own credentials explicitly through its normal application mechanism. API clients reject redirects and credential/query/fragment-bearing origin URLs, and require the same minimum 32-character local token as the API.

Initial conservative limits: 128 KiB persisted output per invocation, 32 KiB per diff, 500 output chunks, 16 KiB buffered line, and 500 MiB local database admission cap. Streams continue draining after output limits; truncation is recorded. Overlong lines and private-key blocks are suppressed. Common token/password patterns and the local API credential are redacted before persistence/display. Detection is imperfect; do not deliberately run commands that print sensitive data. Untracked file contents are not captured; tracked environment/key files are excluded from diffs.

Suppressed overlong-line bytes count toward truncation and make capture incomplete. Output truncation and externally signaled termination are also explicitly incomplete; a signaled process is recorded as interrupted rather than as a successful completion.

`session show` prints a validated JSON page containing original events, their linked memories and navigation cursors. With an explicit session UUID it uses the explicit/environment/default API connection independently of folder bindings; without one it uses the current bound session. The default page contains the latest 20 events in chronological order; limits from 1 to 50 are accepted. Follow `page.olderCursor` or `page.newerCursor` with the same limit to inspect a fixed intake snapshot, including histories longer than 100 commands. Omit the cursor to refresh membership. Summaries and current session counts can change as workers finish or new evidence arrives. Cursors remain valid across a server restart but never grant access to deleted or unavailable evidence.

`session list` finds investigations through `POST /v1/sessions/search` and prints one validated JSON page. Optional `--query` searches a literal, case-insensitive title substring (up to 200 characters), `--status` accepts `open` or `closed`, and `--limit` accepts 1–50 (default 20). Filtering happens on the server before limiting, so an older match is not hidden by a newer unrelated page. This searches titles, not command, error, journal or imported-code text; use `ask` for content recall. Closing a session does not verify a fix.

With no explicit scope, `session list` uses the current repository binding and its API origin when available, otherwise all authorized repositories. `--query` and `--status` retain that default scope. `--repository <uuid>` and `--all-repositories` are mutually exclusive and bypass cwd binding lookup entirely, using the explicit/environment/default API connection; a corrupt unrelated binding cannot affect either explicit scope. A corrupt current binding remains an error for the default mode. Selectors narrow access, never grant it. The returned `filters` record the effective normalized query/repository/status.

Results are ordered by newest session creation time, then ID, rather than latest command/note activity. `page.returnedItems` counts this page and `page.totalMatching` counts all matching active investigations at that read; totals can change. Follow `page.nextCursor` unchanged using `--cursor` with the same effective filters; page size may change and null marks the end. Changing filters requires a fresh request without the old cursor. Pages are live views, distinct from the fixed event-intake snapshots in `session show`. No pages are fetched automatically. Returned titles are bounded to 200 characters; `titleTruncated` means the full stored title matched but its displayed prefix may omit the matching text. Open the investigation UUID for its recorded evidence, recap or handover.

`session recap [id]` reads `GET /v1/sessions/:id/recap` through that same protected API and uses the same explicit-ID versus current-binding connection rule as `session show`. It prints a deterministic observed recap: chronological command/outcome citations, bounded output/diff excerpts, coverage, counts and uncertainty. The recap includes all accepted events up to 40; longer investigations include the first 20 and last 20 and explicitly disclose omitted middle events. Counts describe only those included events. Human output further shortens output/diff text and removes terminal controls; `--json` prints the complete runtime-validated bounded recap without raw event payloads. Use `session show` for the remaining retained evidence. A passing command, a nearby diff and session closure do not establish a causal fix.

`session export [id]` downloads a self-contained handover through the same authenticated local API, using the same explicit-ID versus binding rule. Format defaults to `markdown`; `--format json` returns the versioned report. Without `--output`, the validated content goes to stdout unchanged. With `--output <path>`, the CLI exclusively creates a new private file and refuses an existing file or symlink. It does not create parent directories, overwrite, auto-open or upload. A failed write may leave its newly created partial file for manual review; the CLI does not risk deleting another process's replacement by pathname.

The download envelope must match the requested format, exact session filename and media type, and content must fit 8 MiB of UTF-8. JSON content also passes the shared handover report schema before output. Reports contain the up-to-40-event recap, latest ten authored notes, and every original event linked by those notes, deduplicated up to 140 events. Coverage distinguishes exported events from the recap's counts and discloses omitted history and shortened output/diff excerpts. Markdown keeps event/note anchors for offline citations and safely fences untrusted evidence; original localhost locators are secondary. Repository files and derived memories are excluded. A downloaded copy remains independent of later database deletion, disconnect or access changes; it grants no team access.

`session note [session-id]` submits a user-authored journal entry through the protected API. Supply `--text` (1–4,000 characters), optional `--kind note|decision|resolution` (default `note`) and up to ten unique repeatable `--event` UUIDs. Event links are validated by the server; note authorship comes from the authenticated local identity. Success prints the validated `{note}` response, including its UUID, label and linked event citations. The API normalizes/redacts stored text. A resolution entry records the author's claim and never independently verifies a fix.

The CLI generates a note UUID once before submission. If submission is not confirmed, it reports only a generic failure and that retry UUID, without echoing the body or raw remote error. Retry the **same text, kind and event IDs** with `--note-id <original-uuid>`; an identical accepted retry returns the existing note, while conflicting reuse is rejected. This journal write has no automatic retry or durable local outbox. For a new entry, omit `--note-id` to allocate a new identity.

`session notes [id]` prints a validated JSON page, latest 20 notes by default in chronological order; `--limit` accepts 1–50. Pass `olderBeforeId` unchanged as `--before` with the same session to read earlier notes; null means no older page. Journal pages are live scoped keyset views, separate from the fixed accepted-event snapshots used by `session show`. Both note commands use the explicit/environment/default API connection independently of the folder when a session UUID is supplied, and the bound session otherwise. Ask retains journal citations as user-authored claims with note kind, author and timestamp, distinct from observed event citations and imported code.

`ask` prints the API's evidence label, recalled steps, source IDs and uncertainty. Journal claims remain explicitly user-authored; recorded exits remain observations. It does not invent an AI summary or run a recommended fix. Child failure status is preserved where representable. This local CLI is private and has not been published as an npm package.
