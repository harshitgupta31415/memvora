# Durable local journal recovery

The CLI can opt a user-authored note into a local retry queue before contacting the API. This preserves its original UUID, prepared body, kind and linked event IDs across process exits and uncertain network responses. It is separate from captured execution events and from optional AI interpretation requests. See [STATUS.md](STATUS.md) for verification actually completed.

Ordinary `session note` still submits directly. Only `--queue` saves a durable local note. The browser's journal composer keeps its draft and UUID in the current page's memory; it does not use this queue or retain note text across reloads.

## 1. Save a note offline

Use a built source CLI or version 0.7.0 of the private installed client. The [setup guide](http://127.0.0.1:3000/setup) and [installation instructions](CLIENT_INSTALLATION.md) explain executable paths. In PowerShell, set `$memvora` to the actual installed command, then enter the original capture repository:

```powershell
$memvora = 'C:\absolute\client-installation\node_modules\.bin\memvora.cmd'
Set-Location -LiteralPath 'C:\Projects\your-repository'
& $memvora session note --kind decision --text 'Replace this example with your own report.' --queue
```

The folder must already have a valid local binding and current investigation. Initialization requires the API; queuing does not create a binding or investigation. An optional explicit session UUID must equal the binding's current `sessionId`. Queueing for an unrelated or older session is rejected. Starting a separate investigation later does not rewrite notes already queued for the earlier one.

The usual note limits apply: 1–4,000 text characters and up to ten unique repeatable `--event <UUID>` links. Known-pattern redaction and canonical text preparation happen before persistence. The saved record pins the canonical API origin, repository and session, original note UUID and prepared payload. No server request, credential lookup or command execution is required to queue it. Event membership is verified by the server during retry, not proved by offline acceptance.

The JSON result is `{mode, serverContacted:false, item}`. `mode: "queued_locally"` means the local note was retained; it does **not** mean the server accepted it. Repeating an already acknowledged local identity returns `"already_acknowledged"`. A fresh note receives a fresh UUID; deliberate `--note-id` reuse requires the original content and scope.

The separate file is `<capture-root>/.memvora/journal-outbox.sqlite`. It admits at most 1,000 retained notes, including acknowledged records, and a prepared scope/input envelope of at most 32 KiB per note. It never silently evicts another note to admit new work. There is no queue editing, dropping, automatic flush or forced acknowledgement command.

## 2. Inspect metadata without the API

```powershell
& $memvora journal list --directory 'C:\Projects\your-repository' --state pending --limit 20
```

`journal list` reads an existing queue logically read-only. It does not load a credential or binding configuration, contact the API, initialize/migrate a queue, recover executions or open the server database. An absent queue remains absent. An active/nonempty rollback journal is refused rather than recovered. The website's generated offline command uses the absolute CLI entry directly without loading the server environment file.

Choose `pending`, `synced` or `all`; the default is `pending`. The page size is 1–50, default 20. Results are bounded metadata, without note bodies, citation payloads or pinned principal IDs. Copy the selected row's `noteId`. To continue, pass the returned positive `page.nextAfter` as `--after`, retaining the same folder and state:

```powershell
& $memvora journal list --directory 'C:\Projects\your-repository' --state pending --limit 20 --after 20
```

The numeric cursor above is illustrative; use the actual returned value. Pages are live and ordered by oldest local row ID, so later acknowledgement or new notes can change membership. `totals` counts the entire file before state and cursor filters; `page.returnedItems` counts this page.

## 3. Retry exactly one retained note

Start the authorized local API, configure the same API origin and private credential as the original binding, and run from that bound capture folder:

```powershell
& $memvora journal retry --note '<UUID copied from item.noteId>'
```

`--note` is required; there is no bulk flush. The selection can target an older queued investigation after a newer session becomes current, provided the original API/repository binding still matches. `--api-url` and `--home` use the normal global client options. Select the server data directory, not the capture folder, for `--home`. Portable-client credential requirements apply only when a pending retry needs the API.

Before POST, retry verifies the authenticated user, workspace and workspace generation and checks the saved parent investigation/repository. It pins that first verified peer before attempting submission. A later retry cannot silently move the saved report to another identity, workspace, origin or repository.

Only an acknowledgement matching the saved UUID, session, repository, author, kind, prepared body and complete event-link membership marks the local row `synced`. The result is `{mode, submissionPerformed, item}`: `"confirmed"` follows verified acceptance; `"already_acknowledged"` reports a retained local receipt with `submissionPerformed:false`, without HTTP or credential lookup. This receipt does not establish that the server still retains the note.

If the response is lost after acceptance, repeat the same selected retry. Another identical POST returns the original immutable note rather than duplicating it. A timeout, mismatch, denied/deleted parent or changed peer leaves the original local note retained for review. Do not change its UUID, reassign its scope, rewrite sent text or force a synced state to bypass rejection. Retry does not recreate deleted server data. Ordinary command `run`/`sync` never flushes the journal queue.

## Keep the local original private

The queue stores plaintext note bodies and citation IDs. Known-pattern redaction is not complete privacy protection; do not deliberately put secrets into a report. Keep the repository's `.memvora` directory ignored by Git and restrict it to your account. A synced row is a historical acknowledgement, not a retention, backup or access guarantee. Server deletion does not delete independent local copies.

[Server backups](BACKUPS.md) exclude repository-local bindings, capture outboxes and this journal queue. Preserve private local evidence separately when needed; the installed client package contains none of it. No live restore, queue deletion or pruning workflow is supplied here.

The [manual recovery guide](http://127.0.0.1:3000/capture-recovery#journal-recovery) generates copyable PowerShell listing and selected-retry commands. It does not read client files, collect note bodies, write a queue or submit a note. Review the folder and UUID before running a copied command, then inspect the local state and original server note after a confirmed retry. MCP remains fourteen read-only tools and cannot enqueue, retry or execute a journal report.
