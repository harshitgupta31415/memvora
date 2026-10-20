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
memvora session end
```

Ask searches command memories and bounded imported code through the same protected API. The repository option uses the explicit `--api-url`/environment/default connection and the requested repository ID, independently of the current folder binding; the API still verifies access. Normal binding lookup stops at the current Git root, so unrelated ancestor settings cannot bind a new project. A corrupt binding inside the current repository remains an error. File citations include immutable source IDs and source-detail locators. Imported code is source content, not proof that a command ran or a fix worked.

`init` registers an explicit local repository with the authenticated API and creates an investigation session. An existing ID can be selected with `init --repository-id <id>`. This is local access, not evidence of GitHub App authorization. The repo binding and SQLite outbox live in `<repository>/.memvora`; keep that folder ignored. The server credential remains in the application data directory even when capturing an external repository.

`run` allocates a new execution UUID and session sequence, stores starting metadata, continuously drains/redacts stdout/stderr, persists bounded output, records exit/startup error/interruption and before/after Git diffs, then attempts upload. Repeated identical commands stay distinct. A failed upload keeps evidence pending. `sync` resends the same event IDs and marks only exact acknowledged IDs synced. Crash leftovers become explicitly incomplete attempts on the next run/sync.

Arguments are passed directly with `shell:false`. On Windows, npm/npx are resolved to their JavaScript entry points under Node so literal arguments do not pass through a batch string. Other `.cmd`/`.bat` files require the explicit `--shell cmd` mode with one quoted command string. Shell mode intentionally interprets that string; it is opt-in. No commands outside this wrapper are captured. stdin is disabled: prompts, full-screen tools and arbitrary interactive shells require future PTY support.

In local development, the capture child does not inherit Memvora's `MEMVORA_LOCAL_TOKEN`, `AI_API_KEY`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET` or `GITHUB_PRIVATE_KEY` environment variables. Configure a child program's own credentials explicitly through its normal application mechanism. API clients reject redirects and credential/query/fragment-bearing origin URLs, and require the same minimum 32-character local token as the API.

Initial conservative limits: 128 KiB persisted output per invocation, 32 KiB per diff, 500 output chunks, 16 KiB buffered line, and 500 MiB local database admission cap. Streams continue draining after output limits; truncation is recorded. Overlong lines and private-key blocks are suppressed. Common token/password patterns and the local API credential are redacted before persistence/display. Detection is imperfect; do not deliberately run commands that print sensitive data. Untracked file contents are not captured; tracked environment/key files are excluded from diffs.

Suppressed overlong-line bytes count toward truncation and make capture incomplete. Output truncation and externally signaled termination are also explicitly incomplete; a signaled process is recorded as interrupted rather than as a successful completion.

`ask` prints the API's observed-evidence label, historical steps, source IDs and uncertainty. It does not invent an AI summary or run a recommended fix. Child failure status is preserved where representable. This local CLI is private and has not been published as an npm package.
