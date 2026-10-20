# GitHub connection for local development

Memvora supports a personal, local GitHub App connection and an explicit GitHub CLI fallback. The App connection code does not require a public deployment, but using it against GitHub requires the account owner to register a private App, install it and complete browser authorization. Implementation and fake-provider tests are separate from a live owner-authorized check; see [STATUS.md](STATUS.md) for verified results.

This connects the GitHub integration to the existing local workspace. It does not create a hosted account or replace Memvora's local API bearer credential.

## Choose the connection mode

| Configuration                                                                                            | Behavior                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None of `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` or `GITHUB_CALLBACK_URL` has a value | The existing `gh auth login` identity can browse and explicitly import repositories. The API runs fixed `gh api` arguments without exporting its token to the browser. Restart the API after changing the GitHub CLI account. |
| Complete, valid App configuration                                                                        | Use the GitHub App connection. Connect in Settings, then select an authorized installation and repository. The API does not fall back to `gh`, including when disconnected or temporarily unavailable.                        |
| Any App setting has a value, but configuration is incomplete or invalid                                  | GitHub App actions fail closed with a setup message. Local capture and retained evidence remain usable. Remove all four App values and restart to deliberately return to GitHub CLI mode.                                     |

Do not paste a GitHub token, client secret or local API bearer token into the website. The browser receives connection status and selected repository metadata, never the stored GitHub access/refresh credentials.

## Register a private GitHub App

Use GitHub **Settings → Developer settings → GitHub Apps → New GitHub App**, rather than registering an OAuth App. The account owner completes this step when ready. Keep the project repository private. The following values are the intended local registration; consult [GitHub's registration instructions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) for the settings screen.

| Registration field                             | Local value                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| Name                                           | `Memvora-harshitgupta31415` or another available name owned by the developer |
| Description                                    | `Private engineering memory with selected repository access.`                |
| Homepage URL                                   | `http://127.0.0.1:3000`                                                      |
| Callback URL                                   | `http://127.0.0.1:3000/api/github/oauth/callback`                            |
| Expire user authorization tokens               | Enabled                                                                      |
| Request user authorization during installation | Disabled; start authorization from Memvora                                   |
| Enable Device Flow                             | Disabled                                                                     |
| Setup URL                                      | `http://127.0.0.1:3000/settings`                                             |
| Redirect on update                             | Disabled                                                                     |
| Webhooks: Active                               | Disabled; no webhook URL or secret is needed for this slice                  |
| Repository permissions                         | Metadata, Contents, Issues and Pull requests: read-only                      |
| Other permissions                              | No access                                                                    |
| Installation availability                      | Only on this account                                                         |

Disable wildcard matching for the callback and register that exact URL, without a query string or fragment. Open Memvora at `http://127.0.0.1:3000` for this setup; `localhost` and `127.0.0.1` are different cookie hosts. The callback handles user authorization, while the plain Settings setup URL only returns to the app after installation. [GitHub callback matching](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url).

After creation, record the **App ID** and **Client ID**, then generate a **client secret**. These are distinct values. This slice uses GitHub App user access tokens; it does not require an App private key or an installation-token signing flow. Install the App on the owner's account, choose **Only select repositories**, and select the repository intended for the demo. An installation can also be configured for all repositories; Memvora still requires an explicit selection before importing. [Installing your own App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

`config/github-app-manifest.json` is a reference for these settings. Memvora does not implement the manifest submission/code-exchange registration flow. Register manually; do not use the old API-port callback or invent a manifest-exchange endpoint. Webhooks remain inactive in the reference.

## Configure and connect

Copy `.env.example` to the ignored project-root `.env` if it does not exist. Set all required values together, with the values from the App registration:

```dotenv
GITHUB_APP_ID=YOUR_NUMERIC_APP_ID
GITHUB_CLIENT_ID=YOUR_APP_CLIENT_ID
GITHUB_CLIENT_SECRET=YOUR_APP_CLIENT_SECRET
GITHUB_CALLBACK_URL=http://127.0.0.1:3000/api/github/oauth/callback
```

The first three values are required for App mode. The callback defaults to the URL shown, but explicitly setting it makes the registration easy to compare. Setting only the callback also requests App mode and therefore disables the GitHub CLI fallback. Keep secrets out of version control, screenshots, shell history and `NEXT_PUBLIC_*` variables.

Restart the API and website after changing configuration, using the resource-limited development command in [LOCAL_MVP.md](LOCAL_MVP.md). Open Settings and start the GitHub connection. Finish authorization in the same browser within ten minutes. Then open Repositories, select an installation, refresh its repository list if needed, and explicitly import the chosen repository. The server verifies the numeric GitHub user, App identity, active installation and repository membership; a public repository URL alone is insufficient authorization in App mode. The [installation APIs](https://docs.github.com/en/rest/apps/installations) expose the intersection of the App installation and the connected user's access.

Canceling consent, using another browser, replaying a callback, or returning after expiry does not establish a connection. Start a new attempt. If access or installation selection changes while importing, refresh the selection and retry; the old request must not save a snapshot after a disconnect or deletion.

## Authorization and credential lifecycle

The Next.js callback is a server-side browser adapter. Start creates a short-lived HttpOnly, SameSite=Lax nonce cookie and sends only its SHA-256 binding to the protected API. The API stores a single-use hashed state and encrypted PKCE verifier for ten minutes. On return, the adapter validates its local host and cookie, then forwards the authorization code, state and browser binding with the server's local API credential. Fastify has no unauthenticated OAuth callback exception. Responses redirect to a fixed Settings result with no-store and no-referrer policies.

The provider uses S256 PKCE and `offline_access`; the client secret remains server-side. [GitHub App user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) defines this exchange. Stored access and refresh tokens use AES-256-GCM, with an HKDF-derived key from the ignored local API server secret and authenticated user/workspace-generation/purpose binding. The encrypted database and its key are on the same trusted machine: this is local server-secret encryption, not Windows Credential Manager or a production credential vault. Rotating or losing that server secret requires reconnecting GitHub.

Near expiry, refresh is serialized within one API process and saved with a connection-revision compare-and-swap. A refresh replaces the token pair; [GitHub refresh semantics](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens) make old credentials unusable. This local design does not claim coordination across multiple API hosts. GitHub 401 authorization failures clear the current connection; 403/404 deny the operation, while rate limits and temporary provider failures preserve the credential for a later retry.

**Disconnect** deletes local GitHub credentials and pending authorization attempts and fences in-flight imports/refreshes. It does not uninstall the App or revoke the grant on GitHub. For remote revocation, use GitHub **Settings → Applications → Authorized GitHub Apps → Revoke**; installation management is separate. [Reviewing and revoking authorization](https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps).

Disconnecting keeps previously imported local evidence available for recall. New remote calls recheck authorization. Webhook-driven revocation, background synchronization and hosted access reconciliation are pending; do not describe this local connection as immediate cross-device revocation or automatic deletion of retained history.

## Bounded import and cited code recall

An import captures up to 20 small supported text files, 256 KiB total, recent issue/pull-request metadata, the default branch and an available immutable commit SHA. Sensitive/generated paths are excluded, known secret patterns are redacted and partial results are reported. Import is a manual snapshot, not continuous synchronization or a complete copy of a large repository.

In App mode the selected installation must belong to the configured App, be active and be accessible to the connected user. The selected repository's numeric ID and full name must still appear on the selected installation page both before and after fetch. The connection revision is checked again at the database save boundary, alongside repository/workspace generation fences.

Ask can retrieve imported identifiers, filenames, paths and code phrases alongside command history. Code is labeled as an imported snapshot, not a recorded fix or executed check. Explicit recent-investigation requests remain command-only. Optional per-event AI enrichment receives execution evidence; adding code retrieval does not widen those provider inputs.

File citations contain an immutable source ID, repository/path, redacted-content hash, available commit SHA and bounded line range. Lines refer to the stored redacted snapshot and may differ from GitHub's original file after secret removal. Unknown commits stay unknown. Reimport changes the current searchable snapshot without rewriting old cited versions; historical source IDs remain readable while their parent scope is active and are marked noncurrent. A path omitted from a partial import is not proven deleted remotely.

Identical versions can reuse IDs, and `importedAt` records first observation. Retained file history is capped per repository at 32 MiB of text or 2,000 versions; a new import exceeding either cap is rejected rather than evicting cited evidence. Repository/workspace deletion blocks current and historical reads, removes search entries and prevents stale work from restoring the deleted scope.

Read paths are `POST /v1/repository-sources/search` and `GET /v1/repository-sources/:id?startLine=1&limit=100`. Ask and read-only MCP tools share the same scoped API. Provider credentials and vector search are not prerequisites for this lexical retrieval. A search miss is not proof that the full remote codebase lacks a symbol or behavior.
