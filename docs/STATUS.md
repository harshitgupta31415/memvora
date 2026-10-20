# Verified local MVP checkpoint

Updated: 21 October 2026. Owner: harshitgupta31415.

The first connected local product is implemented. The original hosted PRD remains the target for later authentication, installation authorization, PostgreSQL and organization features. Read this checkpoint before choosing the next task; do not restart from the scaffold description.

## Working locally

- Responsive Next.js website: overview, repository registration and detail, investigations, original command evidence and diffs, memory detail, cited Ask, GitHub browsing/import and settings.
- Loopback Fastify API with a separate local bearer credential, stable SQLite ownership, runtime contracts, Host/Origin checks and consistent errors.
- Windows-first explicit CLI capture with fresh execution UUIDs, literal argument handling, streaming known-pattern redaction, bounded output/diffs, local SQLite outbox, exact durable ACKs and safe retries.
- PID-aware crash recovery preserves active captures. Oversized command metadata is rejected before execution; encoded event JSON is bounded so valid later evidence is not blocked by an oversized event.
- Transactional evidence/job intake, serial enrichment, leases, bounded retries, deletion fences and persistent deletion tombstones.
- SQLite FTS5 recall with repository scope inside queries, original source links, nearby recorded attempts even for old errors, and a bounded recent-investigation context mode.
- Read-only MCP `search_memory`, `get_memory`, `get_session_context`, and status over actual stdio JSON-RPC.
- Explicit GitHub imports through the account's existing local `gh` authorization. The old `harshitgupta31415/memvora-cli` snapshot was imported at commit `a79e5c6b78810f449234e6f5b3c89072b6c8e651`: six retained files, correctly marked partial.
- Optional HTTP AI enrichment with bounded structured output, citation validation and provenance. The current running mode uses deterministic observations; no real provider credential was configured or exercised.

## Verification completed

| Check                                  | Result                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Lint and strict workspace types        | Passed                                                                                                                                         |
| Regression suite                       | 40 tests in eight files passed; one test worker                                                                                                |
| Shared packages and all service builds | Passed                                                                                                                                         |
| Optimized Next.js build                | Passed using two page workers                                                                                                                  |
| Web build artifact guard               | 18 server traces checked; local evidence, credential and environment files excluded                                                            |
| Dependency audit                       | Zero known vulnerabilities at this checkpoint                                                                                                  |
| Actual local acceptance                | Two independent failing checks, source edits, passing checks, repeated executions, exact retry ACK, scoped recall and no-evidence query passed |
| MCP integration                        | Initialize, tool listing, search, memory detail and session context passed with protocol-only stdout                                           |
| Website integration                    | Real cited recall and recent-context query passed; hostile-origin write returned 403                                                           |
| Visual review                          | Desktop layout and narrow mobile navigation inspected                                                                                          |
| GitHub integration                     | Authenticated status, repository browsing, bounded import and persisted source context passed                                                  |
| Resource limits                        | Web and API listeners verified below-normal priority with Windows affinity mask 3: two logical processors                                      |

The local acceptance report is `.memvora/local-acceptance.json`. Its two repository records are explicitly named `Local lab: email-normalization` and `Local lab: port-validation`. They contain real recorded executions of labeled test fixtures; no recall answer was inserted. The current data includes six events and six linked observed memories from these fixtures. Earlier test records were removed through the scoped deletion API.

CPU temperature is not exposed by the available monitoring interfaces. Load is constrained, but no temperature ceiling was measured or guaranteed. No GPU workload or sustained benchmark was run.

## Running and continuing

The compiled web and API can run with:

```powershell
.\scripts\with-resource-limits.ps1 npm.cmd run start:local
```

This requires `npm run build` first. Open `http://127.0.0.1:3000`; API port is 4000. Use `npm run dev` through the same wrapper for source changes. Keep intensive commands sequential. An existing listener must be stopped before starting another copy on the same ports.

Local database, credential and captured fixtures live in the ignored `.memvora` folder. Do not delete it to resolve an unrelated build issue. Rebuilding leaves history intact. CLI captures another repository using the direct Node entry point described in `LOCAL_MVP.md`.

Private backup destination: [harshitgupta31415/memvora-vips-cosmic](https://github.com/harshitgupta31415/memvora-vips-cosmic). Keep this repository private. The development branch is `harshitgupta31415/memvora-starter` and commits use the existing developer identity.

## Next implementation work

1. Implement and test the GitHub App/OAuth callback, state/PKCE, stable browser identity, installation authority checks and revocation. The App manifest is a draft; the current connection uses `gh`, and callback/webhook routes are not implemented. Finish those paths before requesting the owner's browser registration/consent. See `GITHUB_SETUP.md`.
2. Exercise the optional enrichment adapter against an explicitly configured provider/model. Keep credentials in ignored local configuration. Verify provider outage and citation failures using actual HTTP behavior, then consider richer investigation-level summaries.
3. Add visible job retry controls and cursor-based older timeline browsing. Direct sources and indexed search already retrieve old evidence; the main session view currently displays the latest 100 events.
4. Implement the hosted PostgreSQL/Drizzle/pg-boss adapter with reviewed migrations and scoped constraints, then real browser/device sessions and OS credential storage. Local bearer access must never become an implicit hosted auth bypass.
5. Add optional vector retrieval, interactive PTY capture and company-owned handover only after their own requirements and acceptance gates are met.

Production browser/device authentication, continuous GitHub App sync/webhooks, installed-repository revocation, multiuser/company roles, vector retrieval and interactive PTY are not complete. Do not advertise them as working based on the local MVP.
