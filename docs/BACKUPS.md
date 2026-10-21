# Verified local database backups

Memvora's local operator command creates and verifies a complete SQLite database snapshot. It runs on the machine that owns the data directory, separately from the normal API-backed website, capture CLI and MCP clients. It needs filesystem access to the existing database, not a new API permission or a network service. No browser download or MCP write tool exposes the raw database.

## Create a recovery point

Build the shared packages first. In PowerShell from the Memvora application folder:

```powershell
.\scripts\with-resource-limits.ps1 npm.cmd run build:packages
.\scripts\with-resource-limits.ps1 npm.cmd run backup:local -- create
```

The default data directory is the installation's `.memvora` folder; an absolute `MEMVORA_DATA_DIR` overrides it. The root npm command loads an optional private `.env`. With custom configuration, keep the operator and API data-directory settings consistent. The website's `/backups` guide supplies absolute commands for this installation and the current nonsecret configuration.

Default output is a new `snapshot-<timestamp>-<UUID>` directory beneath `<data-directory>/backups`. To choose a destination, pass a new absolute local directory whose parent already exists:

```powershell
.\scripts\with-resource-limits.ps1 npm.cmd run backup:local -- create --data-dir 'C:\Private Memvora data' --output 'D:\Private backups\memvora-recovery-2026-10-21'
```

The destination must not exist. Existing directories, files and links are refused. Missing data does not bootstrap a database or identity. Failure leaves any new partial directory in place for deliberate inspection; it does not overwrite, remove or silently reuse another backup. No automatic retention or upload runs.

A successful operation prints JSON with `status: created_and_verified`, the directory and a manifest. Each complete backup contains `server.sqlite`, `manifest.json` and a nested `.gitignore`. The manifest is written last after snapshot validation. An incomplete directory is not a verified backup, even if a database file exists.

The snapshot uses the [Node SQLite backup API](https://nodejs.org/download/release/v24.0.0/docs/api/sqlite.html#sqlitebackupsourceDb-path-options). The live database uses write-ahead logging; copying only its `server.sqlite` file can miss committed data in the WAL. SQLite's [online backup mechanism](https://www.sqlite.org/backup.html) produces a consistent database while other connections can remain open. Concurrent writes can restart copying, so the operator process has a two-minute deadline. It retains incomplete output if the deadline expires. Stop unnecessary writers before retrying a busy backup.

Source and snapshot admission are bounded to 512 MiB. Hashing streams the file instead of loading the whole database into memory. The resource wrapper limits this machine's Windows process tree to two logical processors with below-normal priority; it does not establish a measured temperature ceiling.

## Verify a saved snapshot

Use the directory returned by creation:

```powershell
.\scripts\with-resource-limits.ps1 npm.cmd run backup:local -- verify --input 'D:\Private backups\memvora-recovery-2026-10-21'
```

Verification is read-only. It requires the exact fixed backup files, a supported schema and manifest, matching byte length/SHA-256, SQLite integrity and foreign-key checks, and valid application ownership/history metadata. It does not instantiate the migrating application store, repair files, start jobs, connect providers or replace the live database. JSON `status: verified` confirms those checks; it does not claim that the backup is current or that every future application version can restore it.

The manifest identifies format version 1 and database schema 7, creation time, size, checksum, physical table counts and exclusions. Counts include retained deletion records; they are separate from the website's active-workspace totals. No event text, source content, owner UUID, credential, signing key or encrypted token appears in the manifest. A checksum detects accidental changes. Someone who can replace both database and manifest can replace their hashes; it is not an authenticity signature.

## What the snapshot preserves

The database includes accepted command evidence, memories, authored notes, immutable imported-file versions and current pointers, search indexes, identity, deletion tombstones/generations, durable intake ordinals and counters, cursor-signing state, queued-job/lease state and encrypted GitHub connection/OAuth state. These are the database contents at the snapshot's consistent point during creation, not a promise about the exact wall-clock time a command began.

It excludes the external `local-token`, environment files, provider configuration and repository-local bindings/outboxes. Unuploaded captures exist only in those separate outboxes and cannot appear in a server database snapshot. A source-code ZIP and a bounded Markdown/JSON handover are also different artifacts; neither is this database backup.

The external API server secret is also the input to GitHub credential encryption. It is intentionally not copied. Losing or rotating it requires reconnecting GitHub; a database snapshot does not recover that secret. Preserve external secrets separately through your existing private credential practices. Do not try copied OAuth attempts or credentials in a rehearsal.

The raw database and snapshot are not encrypted as a whole. They contain private evidence and signing material, and may contain free-page remnants of deleted records. Use a private local parent folder with appropriate Windows inherited access controls or Unix permissions. File mode bits alone do not configure Windows ACLs. The nested ignore file prevents routine source-control inclusion; it is not encryption or an access-control policy. A second copy on the same disk is useful before changes but does not protect against losing that disk.

## Recovery boundary

This release creates and verifies backups. It deliberately has no live restore, merge, replacement or automatic credential recovery command. Its acceptance check rehearses application reads only on a separate disposable synthetic copy, without API listeners, workers, GitHub or AI providers. This is evidence of recovery behavior for the supported schema, not permission to start a copied worker or expose a restored instance.

An older snapshot retains its earlier state after later live deletion or disconnection. Replacing live data could undo newer deletion generations, restore old jobs/OAuth attempts or lose post-backup evidence; already acknowledged client outboxes are not an automatic way to rebuild that missing history. A future live-restore workflow must stop all writers, preserve the original, reconcile these boundaries and deliberately reset external connection/job state before activation. Keep the original instance and verified snapshot separate until that workflow exists.

## Reproducible acceptance

After building, run `npm run acceptance:backup` through the resource wrapper. It creates only labeled synthetic data in guarded temporary folders, invokes the actual operator command, verifies the snapshot and rehearses reads in a different copied database. It tests committed WAL data, original evidence/citation IDs, lexical retrieval, durable cursor/counter behavior and deletion fences. It also exercises invalid or tampered snapshots and preservation of the source/outbox/credential fixtures. The result is recorded in ignored `.memvora/backup-acceptance.json`; the command does not load user history or call a provider.
