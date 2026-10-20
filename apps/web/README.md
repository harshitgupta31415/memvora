# Memvora web

Next.js App Router interface for the local engineering-memory workflow. Follow the root README for local initialization and run commands. The API must be available and the server must be able to read the local workspace credential before protected data can load.

## Routes

- `/`: actual workspace counts, recent investigations, and capture instructions.
- `/repositories`: local project bindings and explicit GitHub CLI repository browse/import.
- `/repositories/[id]`: project investigations and retained imported source context.
- `/sessions`: investigation list with title and repository filters.
- `/sessions/[id]`: command timeline, original outcomes, and linked memories.
- `/events/[id]`: original stdout/stderr, captured diffs, execution metadata, and capture limits.
- `/memories/[id]`: summary steps, source links, mode, and uncertainty.
- `/ask`: repository-scoped recall with links to original evidence.
- `/settings`: sanitized workspace, storage, processing, and limit configuration.

Capture belongs to the CLI. The website does not execute commands or apply earlier fixes. Actual counts come from the API; the interface contains no seeded activity or successful-looking integration fixtures. Loading, missing evidence, access denial, unavailable API, and unsuccessful mutations have visible states. Summary labels identify the processing mode returned by the API.

## Server and browser boundary

`src/lib/api.ts` is server-only. It reads `MEMVORA_LOCAL_TOKEN`, or the `local-token` file under the root `.memvora` directory. `MEMVORA_DATA_DIR` can override that directory. Relative paths resolve from the project root. The token is added to upstream API requests and never returned to the browser.

Protected reads accept loopback Host headers only. BFF mutations also require an exact same-origin loopback Origin. Only narrow repository, GitHub-import, and ask routes are proxied; the browser cannot choose an arbitrary upstream destination. Inputs and responses are checked against runtime contracts. Local mode requires a loopback `MEMVORA_API_URL`.

Optional web-specific overrides belong in `apps/web/.env.local`; Next.js loads environment files from this workspace. The default API URL is `http://127.0.0.1:4000`. Do not use `NEXT_PUBLIC_` for credentials. Root `.env` values are not automatically loaded into the web workspace.

## Development

Use the root checks after a change. Page rendering and API reads stay on the server; forms, copying, filtering controls, and navigation use client components where interaction is needed. Shared contracts come from `@memvora/contracts`. Sensitive output remains inert text; source links use application event IDs rather than generated arbitrary URLs.

The local GitHub bridge uses existing GitHub CLI authorization. It is distinct from GitHub App installation, browser OAuth, background synchronization, and production authentication. Repository imports are bounded and may be partial.
