---
name: memvora-feature-delivery
description: Deliver a Memvora feature across web, API, worker, CLI, or MCP boundaries using a small vertical slice and observable acceptance evidence. Use for feature implementation or integration, rather than isolated copy edits.
---

# Deliver a connected feature

Read the root `AGENTS.md` and the relevant sections of `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, and `docs/ROADMAP.md`. Inspect current code and workspace scripts before planning. A documented future design is not evidence that an implementation exists.

## Choose the slice

Define the user action, required preconditions, observable outcome, and failure behavior. Identify the smallest path that proves value end to end, such as one locally captured command becoming a scoped, retrievable memory. Separate prerequisites from later enhancements; do not turn a feature into a distributed-services rewrite.

Trace each boundary that the slice crosses. Keep shared input/output schemas in `packages/contracts`, reusable domain decisions in `packages/core`, and persistence concerns in `packages/db` as those packages become implemented. Confirm the actual exports and scripts before depending on them. Adapters may have separate processes without requiring separately owned data or duplicated logic.

## Implement and verify

- Check installed versions and official documentation when an API or runtime behavior is uncertain. Explain meaningful tradeoffs in the implementation note, not as decorative comments throughout the code.
- Validate untrusted inputs and explicitly model pending, accepted, failed, and unavailable states where relevant. A stub should return an honest unavailable result rather than a fabricated success.
- Add behavior-focused verification at the risk-bearing boundaries. Prefer one connected acceptance check plus targeted edge cases over many tests mirroring individual functions.
- Run the affected workspace's checks and root checks needed to detect integration breakage. Use existing scripts; report missing or failing prerequisites instead of claiming they passed.
- Update only documentation affected by actual changes. Record assumptions or unresolved product questions without silently redefining scope.

Handoff with the resulting behavior, files or interfaces changed, verification commands and outcomes, current limits, and next dependency. Distinguish tested functionality from the intended follow-up work.
