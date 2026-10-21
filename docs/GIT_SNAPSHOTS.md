# Fixed-baseline Git evidence

Client 0.8.0 records both tracked diff snapshots against the exact commit resolved before the command starts. For example, if the captured command commits an existing edit, the after snapshot still shows that edit relative to the starting commit. Moving `HEAD` does not silently replace the comparison base.

## Recorded fields and execution order

1. Resolve starting `HEAD` and read the starting working-tree status.
2. Run the bounded, filtered `git diff <starting SHA>` probe and attach that SHA as `diffs[].baselineCommitSha`.
3. Persist the initial capture before launching the requested command.
4. Drain and redact command output, retaining its independent process outcome.
5. Observe `HEAD` again as `git.afterCommitSha`, then run the after diff against the same starting SHA.
6. Finalize and upload the immutable event through the existing outbox acknowledgement flow.

`git.commitSha` is the starting observation. `git.dirty` describes the starting status, subject to probe failure. `git.afterCommitSha` is a separate later observation, not an atomic snapshot with the diff and not proof that the captured command caused a change. A null after hash means that probe failed; an absent field means it was not recorded, including historical events or recovered initial captures.

If starting `HEAD` cannot be resolved, both diff probes are skipped. The command still runs and its exit outcome is retained; `capture.complete` is false and `git.error` identifies the failed stage safely. No empty-tree baseline or unborn-repository diagnosis is invented. A failed after-HEAD probe does not prevent an after diff against a valid pinned starting commit.

## What a comparison establishes

The observed recap compares the stored, redacted snapshot texts only when both phases explicitly carry the same valid baseline matching the starting commit, neither snapshot was truncated, and Git probing reported no error. It says whether those captured texts match or differ. Display normalization and handover excerpt clipping do not change that comparison.

Historical events remain byte-equivalent for retries. Their missing baselines are shown as **Baseline not recorded**, even if an old starting commit is present. New intake rejects mixed or contradictory explicit baselines. New baseline and after-HEAD fields accept exactly 40 or 64 hexadecimal characters.

Snapshots cover filtered tracked files under the capture directory and can contain pre-existing edits. Untracked contents are excluded at each probe; a command that stages a previously untracked file can make it eligible for the after probe. Staging alone may leave snapshot text unchanged. Concurrent processes can change files or `HEAD` between probes. These observations do not prove file-content equality, stage equality, engineer intent, a causal patch or a verified fix.

Existing external-driver suppression, environment isolation, secret path exclusions, 32 KiB diff limits, redaction and envelope bounds remain in force. The capture probes write neither the Git index nor object database. They do not subtract patches or execute recalled commands.

## Retrieval and optional interpretation

The raw API, website, CLI history/export, portable handover and read-only MCP preserve explicit hashes and distinguish absent from unavailable observations. MCP previews and synthesis input keep their existing byte limits; metadata is never shortened to make an oversized bundle fit, and an explicit size error can result.

Optional provider projections carry baseline provenance and separate HEAD observations. Current prompts are `event-summary-v2` and `session-analysis-v2`; stored v1 results remain readable with their original provenance. A different current session prompt/configuration makes retained older interpretations stale rather than rewriting them. Reads and deterministic recaps do not call a provider.

Run `npm run acceptance:git-baseline` after the release build for a disposable real-Git, compiled-CLI, API and MCP verification. Its commits, reset and staging operations occur only inside its temporary test repositories; no owner evidence or provider is used.
