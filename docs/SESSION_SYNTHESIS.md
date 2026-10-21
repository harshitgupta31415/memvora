# Optional investigation interpretation

Memvora can submit a bounded investigation snapshot to an explicitly configured AI provider. The saved result contains an overview, cited hypotheses, unresolved questions, suggested checks and uncertainty. It is labeled **AI interpretation — unverified**, separate from captured events, observed recaps and author-reported decisions. A citation establishes the input source, not that the model's explanation is true. Suggestions are inert text and never execute commands.

## Enable deliberately

Keep credentials in ignored local configuration. The default is disabled:

```dotenv
MEMVORA_SESSION_SYNTHESIS_ENABLED=false
# AI_BASE_URL=https://your-provider.example/v1
# AI_API_KEY=
# AI_MODEL=
```

To test with a chosen provider, set its existing compatible HTTP endpoint, key and model, then set `MEMVORA_SESSION_SYNTHESIS_ENABLED=true` and restart the API and any standalone worker. This flag is independent of `MEMVORA_AI_ENABLED`, which controls automatic per-command enrichment. Session synthesis alone does not enable automatic per-command provider calls. Ask, recap, preview, status and MCP reads never queue synthesis or call a model.

Only HTTPS endpoints or loopback HTTP are accepted; redirects are refused. The adapter uses a bounded request, a default 30-second timeout (maximum 60 seconds) and a 256 KiB response-transport cap. Selected evidence is normalized/redacted, but redaction cannot recognize every possible secret. Review the repository and provider before sending evidence. The product does not run a local model or use the GPU.

## Website flow

Open an investigation and choose **AI interpretation**. The page shows the provider/model, selected and omitted event/note counts, prepared input size, excerpt limit and reviewed input hash. Fewer than two accepted commands cannot be submitted. Disabled and unavailable states remain explicit.

**Request AI interpretation** submits one durable request. Refresh status manually to see queued, running, ready, failed or superseded state. Status reads do not create another request. Before sending, the browser saves only the unconfirmed submission's scoped session/repository UUIDs, request UUID and input hash in tab session storage. A reload in that tab restores the same identity without automatically submitting it. Once an accepted response or authorized status read confirms the same UUID/hash, the pending metadata is cleared; the durable request remains discoverable in history. If storage is unavailable, the page reports that its in-memory retry identity must be copied before leaving. This is metadata recovery, not an offline evidence outbox or guaranteed browser-crash recovery.

**Review latest input** deliberately clears the retry identity and prepares a different attempt without submitting it. An earlier accepted request may still be processing; only one active request per investigation is admitted. Invalid, oversized or foreign-scope browser storage is not submitted. Recovery and normal status refresh remain separate actions when the displayed historical request differs from the unconfirmed submission.

Ready results retain their original source links, input hash, provider/model and coverage. New commands, notes, closure or configuration changes mark earlier results stale. A request whose input changes before publication becomes superseded; it does not silently analyze the new evidence. A link containing `?requestId=<UUID>` selects a historical request rather than the latest one.

The retained-history panel lists every current-scope request, newest requested first, including an older ready result after a newer failed request. It shows state, staleness, time, provider/model, coverage, UUID and hash, with links and explicit identity copying. Selecting a row actually switches the displayed request; **Open latest request** returns to the newest one. The list reports the retained count against the session's 32-request limit. More than six rows start collapsed. Request discovery does not retry failed work, transmit evidence to a provider or remove a retained version.

## CLI and MCP

From a source checkout after building:

```powershell
node apps/cli/dist/index.js session synthesis-preview <session-id>
node apps/cli/dist/index.js session synthesize <session-id> --input-hash <reviewed-hash>
node apps/cli/dist/index.js session synthesis <session-id>
node apps/cli/dist/index.js session synthesis <session-id> --request-id <request-uuid>
node apps/cli/dist/index.js session synthesis-history <session-id>
```

The private installed `memvora` command supports the same arguments. With a local binding, the session ID may be omitted. `synthesize` prints the request UUID and pinned hash to stderr before submitting. Preserve both after a timeout:

```powershell
memvora session synthesize <session-id> --input-hash <original-hash> --request-id <original-request-uuid>
```

The same UUID and hash replay the original request, even if configuration or evidence has since changed; they never create another attempt. Reusing the UUID with a different hash is a conflict. Check status before choosing a new identity. There is no automatic retry after a failed or interrupted provider attempt.

MCP `get_session_synthesis({id, requestId?})` only reads the latest or specified request. It retains request identity, state, staleness, provider/model, coverage, all source IDs and claim citations within a 96 KiB escaped envelope. Text may be shortened with an explicit flag. No synthesis creation, retry or command-execution MCP tool is exposed.

MCP `get_session_synthesis_history({id})` and CLI `session synthesis-history [id]` read the protected history endpoint. They preserve all at-most-32 metadata records without pagination or automatic detail expansion. The API list is bounded to 64 KiB and excludes submitted input, generated text and citation arrays (`analysisIncluded: false`, `sourcesIncluded: false`). The MCP content envelope is separately capped at 96 KiB; oversized or invalid metadata fails closed rather than dropping IDs. Use the existing detail command/tool with an exact returned UUID for its full saved interpretation and citations. History is a fresh read, not a frozen snapshot across later requests or state transitions.

## Evidence and durability

Selection uses the recap's all-through-40 or first-20/last-20 events, the latest ten authored notes, and every original event those notes cite. At most 140 events and ten notes are included. Input retains identity, order, outcome, commit, capture/excerpt flags and adaptively shortened command/output/diff/note text under 64 KiB of UTF-8 JSON. Process startup errors and termination signals appear in the output projection when present. Imported repository files and derived memories are excluded. Coverage explicitly reports omissions; this is not full-history reasoning.

Generated analysis must fit 24 KiB and the strict response schema. Every claim requires unique citations to submitted event/note IDs; foreign, missing or duplicate claim citations are rejected. Provider-generated text is normalized/redacted before storage. Semantic correctness and usefulness still require human evaluation with a real model.

SQLite schema 9 stores requests independently from event memories. A request's input hash pins the snapshot, intake/note revision, live parent generations and provider descriptor. Request admission, claim and publication are atomic. A worker claims at most one provider attempt, then publishes only if its lease, persisted snapshot, current revision and live scope still agree. API and standalone worker alternate synthesis and event enrichment without concurrent provider work in each process. Existing per-event retries retain their separate policy.

Queued work survives restart and may be claimed once. Expired running work fails as interrupted instead of being retried automatically, because a timed-out provider call may already have incurred cost. Configuration is a process startup snapshot; workers must use the same configuration. Claim maintenance supersedes queued/running requests whose descriptor differs. Publication fences the stored descriptor and lease but cannot read another process's private environment before maintenance observes it.

There is one active request per investigation and admission caps of 32 requests per investigation and 512 per workspace, counting terminal history. Replays do not consume another slot. No pruning control is provided yet. Deleting a session, repository or workspace removes its synthesis records in the parent transaction and prevents delayed completion from recreating them. Already transmitted provider input cannot be recalled. Saved external copies also remain outside later deletion.

## Verification

`npm run acceptance:synthesis` uses a disposable API database, compiled website/CLI/MCP and a clearly synthetic loopback HTTP provider. It does not load real credentials, user evidence or a real model. It also compares complete metadata history across clients, selects an earlier ready result after a newer failed request and checks read-only counters. Focused tests cover browser retry storage/reload boundaries, schema 8→9 migration, schemas 7/8/9 backup rehearsal, idempotency, quotas, interruption, late lower-sequence uploads, closure, scope/deletion, configuration changes, malformed/oversized/cross-source responses and bounded transport failures. History/recovery adds no database migration. See [STATUS.md](STATUS.md) for checks actually completed.

Real provider compatibility, model usefulness, semantic correctness, automatic history synthesis, imported-code reasoning and hosted multiuser authorization remain separate work.
