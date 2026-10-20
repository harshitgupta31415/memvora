# GitHub during local development

The local MVP can browse and explicitly import repositories using your existing `gh auth login` identity. The API invokes `gh api` with fixed arguments; it does not export the keyring token or send it to the browser. The app's local bearer credential remains a separate credential.

The repository page lists accessible repositories. Choose a repository to import a bounded snapshot: up to 20 small supported text files, 256 KiB total, recent issue/pull-request metadata, default branch and immutable commit SHA. The importer excludes sensitive/generated paths, applies known-pattern redaction, reports partial results, and stores snapshots under the repository's ownership. This is a manual local import, not continuous GitHub App synchronization. Large repositories are intentionally partial.

## Recall imported code

Imported text files are searchable evidence alongside captured investigations. Ask a question containing an imported identifier, filename, path or code phrase; recall can return both command-history and file sources. Code is labeled as an imported snapshot, not a recorded fix or an executed check. Explicit requests to resume the last investigation continue to use command history. Optional per-event AI enrichment still receives execution evidence; this code-retrieval slice does not silently widen its provider inputs.

File citations carry an immutable source ID, repository/path, redacted-content hash, available commit SHA and bounded line range. A source detail view opens the stored text. Line numbers refer to the stored redacted snapshot; secret removal can make them differ from the original GitHub file. An unknown commit remains unknown, without a fabricated commit or external GitHub line anchor.

A later import changes the current searchable snapshot without rewriting an older cited source. Historical source IDs remain readable while the repository/workspace remains active, and are marked noncurrent. A file omitted from a bounded/partial import is not proven deleted from GitHub. A search miss is not proof that the symbol or behavior is absent from the complete codebase.

Identical immutable versions may reuse their IDs; a source's `importedAt` records its first observation separately from the latest import time. Retained history has a per-repository admission cap of 32 MiB of stored file text or 2,000 file versions. Exceeding the cap rejects the new import rather than silently evicting cited versions. Repository/workspace deletion removes current and historical source access and search entries; a stale import cannot recreate a deleted repository.

The read paths are `POST /v1/repository-sources/search` and `GET /v1/repository-sources/:id?startLine=1&limit=100`. Ask and read-only MCP retrieval use the same scoped API. Provider credentials, vector search and GitHub OAuth are not prerequisites for this lexical code-retrieval slice.

If the CLI is unavailable, install the official GitHub CLI and sign in yourself. Restart the API after changing accounts. Do not paste a GitHub token into the website.

## OAuth and a private GitHub App

App registration and browser consent may need the account owner. The local `gh` bridge lets implementation and testing continue while those steps are pending. It must not be described as the product's future OAuth or installation-based authorization.

`config/github-app-manifest.json` is a draft private App registration with read-only contents, metadata, issues and pull-request permissions. The callback/webhook addresses describe the planned routes; do not submit the manifest until the callback exchange, stable identity, installation verification and durable webhook handlers are implemented and tested. Webhooks are disabled in the draft because GitHub cannot deliver to a loopback address on your laptop.

The eventual setup is:

1. Register a private GitHub App, verify callback ownership, and store its client ID, secret, app ID and private key outside Git.
2. Implement callback state/PKCE, stable numeric identity and a secure browser session. Installation credentials are distinct from the sign-in session.
3. Install the app for selected repositories and verify user authority plus installation access on the server before binding them.
4. Configure a reachable webhook URL only after raw HMAC verification, durable delivery intake, reconciliation and revocation are implemented.
5. Keep the project repository and the App private unless the owner explicitly changes that requirement.

No OAuth app, new account, public deployment or expanded GitHub authorization is required to run the local MVP.

References: [GitHub App manifests](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), [OAuth state and PKCE](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
