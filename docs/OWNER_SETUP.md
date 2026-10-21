# Owner setup and live integration checks

Local capture, cited raw recall, observed summaries, journal, handover and backups work without an AI account or a registered GitHub App. These steps cover actions that require the owner's private configuration, browser consent or choice of MCP host. Automated fixture checks are separate from exercising a real external service or end-user host; record actual outcomes in [STATUS.md](STATUS.md), without credentials or private transcripts.

## Start with the working local path

- [ ] Follow [LOCAL_MVP.md](LOCAL_MVP.md) to install/build and start the app through `scripts/with-resource-limits.ps1`. Open `http://127.0.0.1:3000`; keep the API running on `http://127.0.0.1:4000`.
- [ ] Open `/setup` for this installation's actual CLI commands and MCP configuration. In a chosen local repository, initialize once, capture a real command and confirm its event/citations in the website. Ask for distinctive recorded error text; a queued/failed summary does not prevent accepted raw evidence recall.
- [ ] Keep `.env`, `.memvora`, repository outboxes and credentials private. Preserve useful evidence with the [backup operator](BACKUPS.md) before a database upgrade; snapshots exclude external secrets and unsynced outboxes and do not perform live restore.

For GitHub import without App registration, leave **all four** App settings below unset and use the existing `gh auth login` identity. Verify the intended account locally, restart the API after account changes, then explicitly select/import a repository. Capture binding is not GitHub authorization. Import is a bounded manual snapshot, not continuous synchronization or a complete large-codebase copy.

## Connect a real private GitHub App

Follow the full [GitHub setup guide](GITHUB_SETUP.md) for lifecycle and error behavior. GitHub's [registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) describes the owner controls.

- [ ] Under GitHub **Settings → Developer settings → GitHub Apps**, register a private App owned by `harshitgupta31415`; choose an available developer-owned name such as `Memvora-harshitgupta31415`. Keep the project repository private.
- [ ] Set homepage `http://127.0.0.1:3000`, exact callback `http://127.0.0.1:3000/api/github/oauth/callback` and setup URL `http://127.0.0.1:3000/settings`. Disable callback wildcards and Redirect on update. Do not use the API port for the callback.
- [ ] Enable expiring user authorization tokens. Leave authorization during installation and Device Flow disabled. Keep webhooks inactive. Grant only read access for Metadata, Contents, Issues and Pull requests; other permissions remain unset. Choose **Only on this account**.
- [ ] Record App ID and Client ID, then generate the client secret. This connection uses App user access tokens; no App private key is required. [Install the App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app) on the owner's account and select the intended demo repositories explicitly.
- [ ] Add the following to the existing ignored root `.env`, creating it from `.env.example` only if absent. Never overwrite existing configuration or put credentials in `NEXT_PUBLIC_*`, committed JSON, screenshots or chat.

```dotenv
GITHUB_APP_ID=YOUR_NUMERIC_APP_ID
GITHUB_CLIENT_ID=YOUR_APP_CLIENT_ID
GITHUB_CLIENT_SECRET=YOUR_APP_CLIENT_SECRET
GITHUB_CALLBACK_URL=http://127.0.0.1:3000/api/github/oauth/callback
```

- [ ] Restart API and website. Open the website using `127.0.0.1`, start Connect from Settings and complete consent in that same browser within ten minutes. Select the verified installation/repository, import it and inspect a file citation against its retained snapshot. Record the date, account, selected repository and result without tokens.
- [ ] Check cancel/retry and local disconnect when convenient. Disconnect clears local credentials and pending flows while retained evidence remains readable. It does **not** revoke the GitHub grant or uninstall the App; those are separate owner actions in GitHub Settings → Applications.

Any nonempty App setting requests App mode. Missing configuration, disconnection or provider failure does not silently use `gh`. To return deliberately to the GitHub CLI path, remove all four values and restart. A failed setup does not block local capture or retained history. The callback uses the protected local API through the website server; it is not hosted product login. Token encryption depends on this instance's external local server secret; losing/rotating it requires reconnecting. [Expiring-token behavior](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens) is handled by the connection adapter; webhooks, continuous sync and hosted revocation reconciliation remain separate work.

## Optional real AI enrichment

Keep observed mode unless deliberately testing a selected provider. The [AI setup guide](AI_SETUP.md) describes the exact adapter and evidence limits.

- [ ] Choose a provider/model supporting `/chat/completions`, JSON-object responses and `max_completion_tokens`. Confirm its parameter support, usage budget and handling of private engineering evidence before enabling it.
- [ ] Set these values privately in root `.env`, then restart the API/worker. No local model or GPU is needed.

```dotenv
MEMVORA_AI_ENABLED=true
AI_BASE_URL=https://your-provider.example/v1
AI_API_KEY=YOUR_PRIVATE_API_KEY
AI_MODEL=YOUR_SUPPORTED_MODEL
```

- [ ] Capture a new safe command so a new enrichment job uses this configuration. Existing observed summaries are not automatically regenerated. Confirm the job result, stored summary's provider/model provenance and every cited original event. Record endpoint/model/date/result without the key or private evidence text.
- [ ] Confirm an unavailable/malformed provider leaves a truthful failed/retry state and original evidence remains searchable. Use supported failed-job retry controls after correcting configuration; ready jobs are not regenerated by retry.

Enabling sends bounded redacted command evidence to the configured endpoint; redaction cannot guarantee removal of every secret. The adapter currently enriches one event at a time, not a full repository/session. Ask remains cited evidence composition; enabling a provider does not add cross-event model reasoning, embeddings or semantic search. Disable with `MEMVORA_AI_ENABLED=false` and restart to use observed enrichment for future jobs. A loopback test provider is not evidence of real model quality or vendor compatibility.

## Connect the chosen MCP host

- [ ] Build the app through the resource wrapper and keep its API running. Open `/setup` and copy its generated stdio configuration into the chosen MCP-enabled editor/host's private settings. It uses direct Node and the absolute compiled `apps/mcp/dist/index.js` path; host JSON keys can vary. Follow [the adapter guide](../apps/mcp/README.md).
- [ ] Match `MEMVORA_API_URL` and any absolute `MEMVORA_DATA_DIR` to the running API. Direct Node does not automatically read root `.env`; the setup-generated arguments explicitly load that optional file. If an external local-token override is used, supply it through private host environment/secret settings, never committed JSON.
- [ ] Restart/reconnect the host. Confirm tool discovery shows the twelve documented read-only tools and call `memvora_status`. File presence in `/setup` alone does not prove a host connection.
- [ ] Call `search_memory` with distinctive captured error text and explicit `repositoryIds`, then `get_memory` using a returned event UUID. Confirm the same original citation in the website, including raw evidence when its summary is pending/failed. Use `find_sessions` to locate an older investigation and `get_session_context` cursors for history outside one page.
- [ ] Record host name/version, date, tool discovery and one successful cited retrieval without tokens or raw private evidence. Check that inaccessible/deleted selectors return no evidence rather than a wider search.

All tools use the same authenticated local API. They read evidence; none executes commands, edits code or grants new repository access. This is trusted-machine stdio, not remote MCP OAuth/device pairing. Keep the full report downloads and live database backups separate from bounded tool previews.
