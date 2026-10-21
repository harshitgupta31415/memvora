# Private CLI and MCP installation

The client release contains `memvora` and the read-only `memvora-mcp` adapter in one private local npm tarball. The website/API/worker remain separate. Run the API first, then give the clients its loopback origin and an explicit credential location. Installation does not register a GitHub App or enable an AI provider.

The release targets Node 24 or 26 and npm 11 or newer. It bundles client runtime dependencies, retains upstream notices and has no install/build hooks. The tarball is distributed through private local storage; it is not a published registry package or an encrypted backup. Keep captured data and credentials outside it.

## Build a release from this repository

After installing the repository dependencies, run these commands from its root:

```powershell
.\scripts\with-resource-limits.ps1 npm.cmd run package:clients
.\scripts\with-resource-limits.ps1 npm.cmd run acceptance:clients
```

The producer builds shared packages and writes a fresh staging directory under ignored `.memvora/client-packages`. Its `latest.json` identifies the tarball, version, SHA-256, byte length and packed file inventory. Packaging and acceptance are separate operations: a generated artifact is not a passing installation check. See [STATUS.md](STATUS.md) for recorded results.

## Install in a private folder

Use an empty installation folder with its own private `package.json`. This keeps package installation separate from a capture project's binding/outbox and avoids changing another installed command with the same name. For example, from the Memvora repository root:

```powershell
$release = Get-Content -LiteralPath '.memvora\client-packages\latest.json' -Raw | ConvertFrom-Json
$clientPrefix = Join-Path (Get-Location) '.memvora\installed-clients'
New-Item -ItemType Directory -Path $clientPrefix -Force | Out-Null
```

Create `package.json` inside that folder only when absent:

```json
{
  "name": "memvora-local-client-installation",
  "private": true
}
```

Then install the local artifact and inspect the client version:

```powershell
npm.cmd install --prefix $clientPrefix --workspaces=false --offline --ignore-scripts --no-audit --no-fund --update-notifier=false $release.tarball
& (Join-Path $clientPrefix 'node_modules\.bin\memvora.cmd') --version
```

The recipient needs the tarball and a supported Node/npm installation. They do not need this source checkout, workspace package links or a registry connection for the bundled client installation. Use the artifact's actual filename/path when copying it to another machine. An API at `127.0.0.1` still runs on the same machine; this release does not add remote hosting or remote authentication.

## Connect to the running local API

Set the actual server data directory explicitly. It is the directory containing the existing `local-token`, not a capture repository's outbox folder. Do not copy that credential into the package.

```powershell
$env:MEMVORA_API_URL = 'http://127.0.0.1:4000'
$env:MEMVORA_DATA_DIR = 'C:\absolute\path\to\server-data'
$memvora = Join-Path $clientPrefix 'node_modules\.bin\memvora.cmd'
& $memvora login
& $memvora status
```

CLI `--home <absolute-directory>` overrides `MEMVORA_DATA_DIR`. A privately supplied `MEMVORA_LOCAL_TOKEN` takes precedence and does not require reading a data directory. Never paste a token into a committed command file or chat. The portable clients require one of these explicit credential sources; they do not search ancestors or their installation folder for a server store and do not automatically load `.env`. Source-checkout entry points retain their existing development fallback.

Open the target code repository in PowerShell. Retain the absolute `$memvora` path and API/data-directory environment above, then use the normal capture flow:

```powershell
& $memvora init
& $memvora run -- npm test
& $memvora ask 'Distinctive error text from the recorded command'
```

Each capture project's `.memvora` retains its binding and SQLite outbox independently of the installed client package. Use [OUTBOX_RECOVERY.md](OUTBOX_RECOVERY.md) for offline inspection and selected retries. A successful package installation does not prove a command was captured or a fix was verified; follow the returned original event citation.

## Connect the installed MCP adapter

Use direct Node for MCP so stdout remains protocol-only. Configure the host with the absolute installed launcher and an explicit API/data directory:

```json
{
  "mcpServers": {
    "memvora": {
      "command": "node",
      "args": ["C:/absolute/client-installation/node_modules/@memvora/clients/bin/memvora-mcp.mjs"],
      "env": {
        "MEMVORA_API_URL": "http://127.0.0.1:4000",
        "MEMVORA_DATA_DIR": "C:/absolute/path/to/server-data"
      }
    }
  }
}
```

Host configuration keys can differ. Restart/reconnect the chosen host, call `memvora_status`, then retrieve an actual captured event through `search_memory` and `get_memory`. Version 0.6.0 exposes the same fourteen read-only tools and API authorization boundaries as the source adapter, including `get_session_synthesis` and `get_session_synthesis_history`. Synthesis creation remains an explicit website/CLI action; installation and reads do not enable a provider. See [the MCP guide](../apps/mcp/README.md), [SESSION_SYNTHESIS.md](SESSION_SYNTHESIS.md) and [OWNER_SETUP.md](OWNER_SETUP.md) for the real-host checks.

## Upgrade and remove

Install a newer reviewed tarball into the same installation prefix using the same offline/scripts-disabled flags. Package removal uses `npm.cmd uninstall --prefix <installation-folder> --workspaces=false --ignore-scripts --no-audit --no-fund @memvora/clients`. This removes client files, not server data or repository-local bindings/outboxes. Keep those data folders separate and use [BACKUPS.md](BACKUPS.md) for database snapshots.

The package's `private: true` setting blocks accidental npm publication. Anyone who receives the tarball can retain its code independently, so keep its distribution private. It contains neither an API server nor device pairing, an OS credential vault or remote MCP OAuth.
