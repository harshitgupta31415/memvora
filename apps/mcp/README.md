# Local read-only MCP adapter

This uses the official TypeScript MCP server SDK v2 and stdio transport. Registered tools:

- `memvora_status`: reads current API capability metadata.
- `search_memory`: searches authorized stored memory with optional `repositoryIds` and `limit`.
- `get_memory`: reads one authorized memory by `id`, retaining observed-evidence labels, citations and uncertainty.
- `search_repository_sources`: searches the latest bounded imported files; returns immutable IDs, commit/hash provenance and stored line excerpts. Optional repository IDs narrow access; an empty list returns no files.
- `get_repository_source`: reads a current or earlier retained source by `id`, with optional `startLine` and `limit` (up to 200 lines before tool excerpt limits).
- `get_session_context`: reads bounded ordered execution/output/diff excerpts by session `id`; optional `cursor` and `limit` (1–10, default 5). Returns snapshot page metadata for older/newer navigation across the accepted history.

After the root build, configure your MCP host to launch `node` with the absolute path to `apps/mcp/dist/index.js`. Use the direct executable rather than npm wrappers because stdout is reserved for protocol traffic. No tool executes commands or edits code. All retrieval calls use the same authenticated HTTP API as the website and CLI; the adapter never opens the database directly.

The API must be running. The adapter defaults to `http://127.0.0.1:4000`; override `MEMVORA_API_URL` only with a loopback origin. It reads `MEMVORA_LOCAL_TOKEN`, or `.memvora/local-token` under the application root, or `MEMVORA_DATA_DIR/local-token`. Never paste real tokens into a committed MCP configuration. This local trusted-machine credential is not production pairing, organization authorization or remote MCP OAuth.

`hasBefore` and `hasAfter` refer to stored lines. An overlong individual line can be truncated even when `hasAfter` is false; always honor `excerptTruncated`. There is currently no character-offset continuation within one overlong line. The API caps a source window at 16 KiB, and MCP shortens it further for the assistant context.

The local token must contain at least 32 characters. Requests reject redirects and API origins containing embedded credentials, query strings or fragments.

`get_session_context` calls `GET /v1/sessions/:id/events` rather than the legacy latest-100 session route. Its first result opens a fixed accepted-event snapshot and contains the latest requested events in ascending session-sequence order. Pass `page.olderCursor` unchanged with the same `id` to retrieve earlier work, or `page.newerCursor` to move forward. A null cursor marks the end in that direction. Optional cursor length is at most 2,048 characters; the adapter URL-encodes it for the API.

The returned `page` includes `snapshotEventCount`, `returnedEvents`, nullable first/last sequence and older/newer cursors. The session's live `eventCount` may increase while `snapshotEventCount` stays fixed. Later uploads cannot enter an existing snapshot, including late uploads with an earlier sequence. Start again without a cursor to refresh. Memories correspond to returned page events and can finish processing while the event snapshot stays fixed.

Session context uses a shared 96 KiB serialized UTF-8 budget within the transport's 128 KiB limit. It retains every page event/memory ID, recorded sequence, outcome kind/exit code, linked citation IDs and both navigation cursors while adapting text, arguments, output, diffs and summaries to fit. These results are excerpted views rather than full event/memory DTOs. Total argument/chunk/step/uncertainty counts and excerpt notices describe omitted detail; omitted uncertainty never implies resolution. Open the original event for full retained evidence. Source citations outside the returned page are rejected rather than silently rewritten.

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
