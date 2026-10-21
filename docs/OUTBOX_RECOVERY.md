# Inspect and selectively sync local capture

This is a manual local recovery workflow. The `/capture-recovery` website guide generates copyable Windows PowerShell commands from a capture folder and original UUIDs. Its fields stay in the browser, are not saved, and do not open files or call an upload endpoint. Build the compiled CLI first using [LOCAL_MVP.md](LOCAL_MVP.md).

The **capture folder** is the target repository containing `.memvora/config.json` and `.memvora/outbox.sqlite`. It is different from the server data directory. Preserve this private binding/outbox; do not delete or rewrite it to clear an upload problem. A [server backup](BACKUPS.md) excludes these repository-local files.

## Read the outbox without an API

This example uses the actual application entry on this machine and prompts for the target folder. Replace the application path if you moved Memvora. No example UUID is presented as real evidence.

```powershell
$memvoraRoot = 'C:\Users\victus\Desktop\hackathon\vips-cosmic'
$memvoraCli = Join-Path $memvoraRoot 'apps/cli/dist/index.js'
$captureDirectory = Read-Host 'Absolute local capture repository folder'
node $memvoraCli outbox list --directory $captureDirectory --state unsynced --limit 20
```

`outbox list` uses the explicit folder to open an existing local outbox logically read-only. It does not need a token, binding configuration or running API, and does not initialize, migrate, recover unfinished captures or change acknowledgements. SQLite can still manage locking sidecars. A missing outbox is reported without creating one; an unreadable or unsupported database fails without pretending to be empty. The website never opens this SQLite file.

The output identifies `source: local_outbox`, `exists`, `readOnly`, the effective filter, totals, bounded metadata items and page information. It excludes command output and diff text. Each item includes its local row ID, original event/session IDs where valid, sequence, state and metadata-validity flag. A bounded sanitized executable name is context, not a command to execute. Invalid metadata must be reviewed rather than reassigned to another identity.

| State        | Meaning                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `unsynced`   | Finalized pending rows plus unfinished captures; the default.                                                                       |
| `pending`    | A finalized local event without its durable acknowledgement recorded locally.                                                       |
| `incomplete` | An unfinished execution. Its capture process may still be running.                                                                  |
| `synced`     | The outbox recorded an exact API acknowledgement. Later server deletion or access changes can still make that evidence unavailable. |
| `all`        | Every local row in the selected session scope.                                                                                      |

Totals cover the optional session selection before the state filter, cursor and page limit. The page defaults to 20 metadata rows, supports 1–50, and is ordered by oldest local row ID. `page.nextAfter` is a positive row ID or null. Pages are live rather than a fixed snapshot; concurrent capture/finalization/upload can change membership. Keep the same filters when continuing.

```powershell
$sessionId = Read-Host 'Original session UUID from the local list'
node $memvoraCli outbox list --directory $captureDirectory --state unsynced --session $sessionId --limit 20

# Only if the previous result returned a non-null page.nextAfter:
$afterRowId = Read-Host 'Exact positive page.nextAfter value'
node $memvoraCli outbox list --directory $captureDirectory --state unsynced --session $sessionId --limit 20 --after $afterRowId
```

## Upload one deliberate selection

An older rejected event can block a mixed unfiltered sync batch. `sync --session <UUID>` and `sync --event <UUID>` select finalized pending evidence without changing event identities. These selectors are mutually exclusive. Run the command from its original bound capture folder, using the API origin, server data directory and credential for that binding. The website guide preserves the current validated non-secret API/home values; no credential is included in generated commands.

For ordinary local defaults or matching root `.env` configuration:

```powershell
$sessionId = Read-Host 'Exact original session UUID to sync'
& {
  Push-Location -LiteralPath $captureDirectory -ErrorAction Stop
  try {
    node "--env-file-if-exists=$memvoraRoot\.env" $memvoraCli sync --session $sessionId
  } finally { Pop-Location }
}
```

To select one event instead, substitute `--event` and its original `eventId`; do not combine selectors. If the server uses environment overrides outside that root file, use the guide’s explicit `--api-url` and `--home` arguments and supply any external credential privately through the terminal environment. Do not paste secrets into chat, URLs, documentation or Git.

Selected sync **does not recover or finalize unfinished captures**. It reports them as remaining. Read the result’s scope, `acknowledgedEvents`, `recoveredIncompleteCaptures`, selected `remaining`, `totalRemaining`, start-row boundary and `stopReason`. Later-created rows remain outside that attempt; an existing row finalized during the operation can still become eligible. A batch limit or remaining count is a reason to inspect another local page and retry the intended selection, not to mark rows acknowledged manually.

Ordinary unfiltered `sync` retains confirmed-dead process recovery. Listing and selected sync leave incomplete execution state unchanged. Running/inaccessible owners and ambiguous process identity must not be treated as proof that a capture has died. Auto-sync after `run` targets the new event, rather than retrying unrelated old sessions.

## Limits and preservation

- Selected sync does not recreate deleted repositories/sessions/events, bypass authorization, fix invalid payloads, reassign a row or force an acknowledgement. Preserve original UUIDs, sequence and sent content.
- Keep a rejected older capture for review. Do not delete the outbox, edit its rows or erase the binding to make a newer upload appear successful.
- The raw outbox may contain private terminal/code evidence. Keep it excluded from Git, restrict Windows access and retain it separately from server-only snapshots when it contains unsynced work.
- A local acknowledgement is a stored acceptance record, not a guarantee that a later API read still has access or that a reported fix is correct. Inspect original evidence in the website after upload.
- Event intake now preserves nullable fields without scalar conversion. If an earlier release accepted a converted payload but its acknowledgement was lost, retrying the original capture can produce an immutable-event conflict. Existing stored rows are deliberately preserved; retain the original evidence and use a different session/event selection for unrelated pending work. Do not replace either copy automatically.
- This guide does not add a browser filesystem interface, upload endpoint, automatic deletion or local-data restoration feature. Rebuild/restart adapters when changing their code, and record verification results separately from these instructions.
