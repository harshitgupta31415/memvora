# Local read-only MCP adapter

Adapter version 0.4.0 can be installed with the CLI from a private local tarball. See [CLIENT_INSTALLATION.md](../../docs/CLIENT_INSTALLATION.md) for the direct Node launcher and explicit server credential configuration. The package works independently of source workspace links; source-development instructions below retain their existing application-root fallback.

This uses the official TypeScript MCP server SDK v2 and stdio transport. Registered tools:

- `memvora_status`: reads current API capability metadata.
- `find_sessions`: finds authorized investigations by optional literal title `query`, `repositoryId`, open/closed `status`, `limit` (1–10, default 5) and opaque `cursor`. Returns a complete validated live directory page with effective filters, matching count and `nextCursor`.
- `search_memory`: searches authorized stored memory with optional `repositoryIds` and `limit`.
- `get_memory`: reads one authorized memory by `id`, retaining observed-evidence labels, citations and uncertainty.
- `search_repository_sources`: searches the latest bounded imported files; returns immutable IDs, commit/hash provenance and stored line excerpts. Optional repository IDs narrow access; an empty list returns no files.
- `get_repository_source`: reads a current or earlier retained source by `id`, with optional `startLine` and `limit` (up to 200 lines before tool excerpt limits).
- `get_session_context`: reads bounded ordered execution/output/diff excerpts by session `id`; optional `cursor` and `limit` (1–10, default 5). Returns snapshot page metadata for older/newer navigation across the accepted history.
- `get_session_recap`: reads a deterministic observed investigation recap by session `id`, with ordered command/outcome citations, coverage, counts, output/diff excerpts and uncertainty. It does not infer an engineer's intent, root cause or a causal fix.
- `get_session_handover`: reads a source manifest and compact handover preview by session `id`. `fullReportIncluded` is always false; use the website download or CLI export for the full portable report.
- `search_session_notes`: searches authorized user-authored notes, decisions and resolution claims with optional `repositoryIds` and `limit` (1–10, default 5). An empty repository list returns no notes.
- `get_session_note`: reads one authorized journal note by `id`, retaining its author, kind, timestamp, unverified label and linked event citations.
- `get_session_notes`: reads the latest chronological journal page for session `id`, with optional `limit` (1–10, default 5) and `before` UUID from the previous `olderBeforeId`.

After the root build, configure your MCP host to launch `node` with the absolute path to `apps/mcp/dist/index.js`. Use the direct executable rather than npm wrappers because stdout is reserved for protocol traffic. No tool executes commands or edits code. All retrieval calls use the same authenticated HTTP API as the website and CLI; the adapter never opens the database directly.

The API must be running. The adapter defaults to `http://127.0.0.1:4000`; override `MEMVORA_API_URL` only with a loopback origin. It reads `MEMVORA_LOCAL_TOKEN`, or `.memvora/local-token` under the application root, or `MEMVORA_DATA_DIR/local-token`. Never paste real tokens into a committed MCP configuration. This local trusted-machine credential is not production pairing, organization authorization or remote MCP OAuth.

`hasBefore` and `hasAfter` refer to stored lines. An overlong individual line can be truncated even when `hasAfter` is false; always honor `excerptTruncated`. There is currently no character-offset continuation within one overlong line. The API caps a source window at 16 KiB, and MCP shortens it further for the assistant context.

The local token must contain at least 32 characters. Requests reject redirects and API origins containing embedded credentials, query strings or fragments.

`find_sessions` calls `POST /v1/sessions/search`. Repository/status/title filtering occurs on the server before page limits, so older investigations remain findable beyond the newest global page. This is a literal case-insensitive title search, not command/error/journal/code-content recall. Omit `repositoryId` to search the currently authorized workspace; supplied IDs are filters, not authority. The adapter never reads a cwd repository binding. `displayLabel` and `evidenceNotice` disclose these semantics.

Directory results keep every page member, original API-provided title and `titleTruncated` flag unchanged within a 96 KiB escaped MCP content budget. A true flag means the full stored title matched while the bounded display may omit the matching text. The shared core validator checks response schema, effective filters, repository/status/title membership, cardinality, unique IDs, canonical creation times and newest-created/ID ordering. This order is independent of last command/note activity. Open/closed is a session state, not proof of a fix.

The returned `page` contains `limit`, `returnedItems`, `totalMatching`, `nextCursor`, `order: newest_created_first` and `consistency: live`. Pass `nextCursor` unchanged with the same effective filters; page size may change and null marks the end. Changing filters requires starting without the old cursor. No page is followed automatically or silently shortened. Totals and subsequent pages reflect current scoped data, separate from the fixed accepted-event snapshots used by `get_session_context`. Use the returned session UUID with recap/context/handover tools to inspect its evidence.

`get_session_context` calls `GET /v1/sessions/:id/events` rather than the legacy latest-100 session route. Its first result opens a fixed accepted-event snapshot and contains the latest requested events in ascending session-sequence order. Pass `page.olderCursor` unchanged with the same `id` to retrieve earlier work, or `page.newerCursor` to move forward. A null cursor marks the end in that direction. Optional cursor length is at most 2,048 characters; the adapter URL-encodes it for the API.

The returned `page` includes `snapshotEventCount`, `returnedEvents`, nullable first/last sequence and older/newer cursors. The session's live `eventCount` may increase while `snapshotEventCount` stays fixed. Later uploads cannot enter an existing snapshot, including late uploads with an earlier sequence. Start again without a cursor to refresh. Memories correspond to returned page events and can finish processing while the event snapshot stays fixed.

Session context uses a shared 96 KiB serialized UTF-8 budget within the transport's 128 KiB limit. It retains every page event/memory ID, recorded sequence, outcome kind/exit code, linked citation IDs and both navigation cursors while adapting text, arguments, output, diffs and summaries to fit. These results are excerpted views rather than full event/memory DTOs. Total argument/chunk/step/uncertainty counts and excerpt notices describe omitted detail; omitted uncertainty never implies resolution. Open the original event for full retained evidence. Source citations outside the returned page are rejected rather than silently rewritten.

`get_session_recap` calls the same authenticated `GET /v1/sessions/:id/recap` route as the CLI and website. It includes all accepted session events up to 40, otherwise the first 20 and last 20 in chronological session-sequence order. `coverage` reports total, included and omitted counts and the selection policy; outcome/diff/capture counts cover the included selection only. The recap is generated from stored observations without an AI provider, and contains no raw event payload. Refreshing can include later accepted uploads; use `get_session_context` pagination for omitted middle evidence.

Recap output has a separate aggregate 96 KiB UTF-8 budget that also counts JSON escaping when carried inside the MCP text content item, leaving room beneath the 128 KiB tool limit. All step members, event IDs, sequences, citations/locators, coverage, counts, timestamps, observed label and uncertainty items remain present. If necessary, readable command/outcome/output/diff/summary text and uncertainty text are shortened at Unicode code-point boundaries; `excerpted` and the evidence notice disclose this adaptation. Ordinary bounded recaps retain their text. Contradictory citation membership or an unexpected API schema fails closed rather than returning rewritten provenance.

`get_session_handover` calls `GET /v1/sessions/:id/handover`. It preserves all included event/note IDs in their report order, recap event IDs, every event-source citation membership, complete coverage, authored labels/author/time, and compact outcome/git/capture/diff-phase metadata. Reports select the first/last recap attempts and every event linked by the latest ten notes, up to 140 events. Recap counts remain distinct from the larger exported event set.

The MCP result is explicitly a **preview**, with `fullReportIncluded`, `outputExcerptsIncluded` and `diffTextIncluded` all false. Output/diff text, event timestamps, cwd, signals and error details are omitted; readable command/body/summary/name/notice text is adapted at Unicode boundaries to a 96 KiB escaped transport budget. No event, note or citation is dropped to fit. `fullReportDownload` gives protected local API paths and a CLI command for the full JSON/Markdown report. The MCP tool creates no file, uploads nothing, executes no command and grants no new access. Offline source anchors live in the full Markdown download; already downloaded copies cannot be revoked by subsequent deletion or disconnect.

Journal tools call `POST /v1/session-notes/search`, `GET /v1/session-notes/:id` and `GET /v1/sessions/:id/notes`; none exposes note creation or mutation. Every note keeps the exact label `User-authored — not independently verified`. A linked execution is evidence the author selected, not confirmation of the claim. Resolution entries do not prove a fix. Observed recaps and execution memories remain separately labeled.

Journal detail, search and page results share a 96 KiB transported JSON budget, including escaping inside the MCP text content item. All returned notes, author/kind/timestamp metadata, note/event citation IDs and locators, total count and `olderBeforeId` remain present. Only note bodies may be shortened at Unicode code-point boundaries; per-note `bodyExcerpted`, result `excerpted` and the evidence notice disclose this. Read an individual note or use the website for the full retained body. Inconsistent repository/session citation provenance is rejected. Follow `olderBeforeId` unchanged as `before` with the same session; null marks the end. These journal pages are live views, not fixed event-intake snapshots, and every request still requires current access.

Cursors are signed scope-bound navigation, not credentials. Changing their contents, using another session's cursor or reusing deleted/stale scope is rejected. API restart does not intentionally discard a valid snapshot cursor because its signing key is persisted locally. Normal authentication and live workspace/repository/session checks run on every page. The old `GET /v1/sessions/:id` route remains a latest-100 window for compatibility; the MCP tool no longer uses it.

```json
{
  "mcpServers": {
    "memvora": {
      "command": "node",
      "args": ["C:/absolute/path/to/vips-cosmic/apps/mcp/dist/index.js"],
      "env": { "MEMVORA_API_URL": "http://127.0.0.1:4000" }
    }
  }
}
```

The host configuration key may vary by client; consult that client's documentation. Tool inputs are runtime-validated, responses checked against shared contracts, output bounded to 128 KiB, and session output/diffs explicitly excerpted. File tools further bound excerpts and update their returned line ranges when shortening text. Source IDs remain available for original detail in the website. A re-import updates searchable files while older cited versions remain readable until repository/workspace deletion. Missing files in a partial import are not proof of remote deletion. Stored redacted line numbers can differ from original repository lines. Retrieved text is untrusted evidence, never instructions or proof that a fix ran. Permission errors return no evidence. stdout contains protocol messages only; diagnostics belong on stderr. AI/provider enrichment is reported separately by the API and is not implied by a successful MCP call.

Every tool rejects unknown input properties before making an API request, including tools with no arguments. Use the exact input names from `tools/list`; misspelled repository selectors cannot silently become workspace-wide searches. The local website's `/setup` page generates configuration using this installation's absolute entry path, optional environment-file argument and validated nonsecret API/data-directory settings. It never includes token values. Restart the host and call `memvora_status` to verify the actual connection; build-file presence alone does not establish one.
