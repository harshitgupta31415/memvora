# Local read-only MCP adapter

This uses the official TypeScript MCP server SDK v2 and stdio transport. Registered tools:

- `memvora_status`: reads current API capability metadata.
- `search_memory`: searches authorized stored memory with optional `repositoryIds` and `limit`.
- `get_memory`: reads one authorized memory by `id`, retaining observed-evidence labels, citations and uncertainty.
- `search_repository_sources`: searches the latest bounded imported files; returns immutable IDs, commit/hash provenance and stored line excerpts. Optional repository IDs narrow access; an empty list returns no files.
- `get_repository_source`: reads a current or earlier retained source by `id`, with optional `startLine` and `limit` (up to 200 lines before tool excerpt limits).
- `get_session_context`: reads bounded ordered execution/output/diff excerpts by session `id`; optional `limit` up to 10.

After the root build, configure your MCP host to launch `node` with the absolute path to `apps/mcp/dist/index.js`. Use the direct executable rather than npm wrappers because stdout is reserved for protocol traffic. No tool executes commands or edits code. All retrieval calls use the same authenticated HTTP API as the website and CLI; the adapter never opens the database directly.

The API must be running. The adapter defaults to `http://127.0.0.1:4000`; override `MEMVORA_API_URL` only with a loopback origin. It reads `MEMVORA_LOCAL_TOKEN`, or `.memvora/local-token` under the application root, or `MEMVORA_DATA_DIR/local-token`. Never paste real tokens into a committed MCP configuration. This local trusted-machine credential is not production pairing, organization authorization or remote MCP OAuth.

`hasBefore` and `hasAfter` refer to stored lines. An overlong individual line can be truncated even when `hasAfter` is false; always honor `excerptTruncated`. There is currently no character-offset continuation within one overlong line. The API caps a source window at 16 KiB, and MCP shortens it further for the assistant context.

The local token must contain at least 32 characters. Requests reject redirects and API origins containing embedded credentials, query strings or fragments. Session context reports the actual session event count separately from its bounded latest-100-event window and tool excerpts.

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
