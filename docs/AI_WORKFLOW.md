# Building Memvora with coding assistants

This repository includes a working agreement in `AGENTS.md` and three project-local skills in `.agents/skills`. The skills carry product-specific instructions; they do not implement the pipeline or replace engineering review. Tools that support project-local skill discovery can discover these folders. For other tools, provide the applicable `SKILL.md` path in the task and ask the assistant to read it.

## Start from a bounded outcome

Use `docs/ROADMAP.md` to choose the next dependency and `docs/PRD.md` to identify its acceptance criteria. Ask for a working vertical slice with clear evidence, rather than an entire product in one prompt. The architecture and API documents describe the intended boundaries; inspect actual code to establish what exists now.

Example feature task:

> Use `.agents/skills/memvora-feature-delivery/SKILL.md`. Read the ingestion acceptance criteria and current contracts. Implement the smallest connected path for accepting one authenticated command batch and returning its durable acceptance result. Describe assumptions first, preserve unrelated changes, and report behavior checks plus remaining limitations. Do not implement retrieval in this task.

Example pipeline review:

> Use `.agents/skills/memvora-evidence-pipeline/SKILL.md`. Review the upload and retry path. Trace what happens if the database commits but the response is lost. Check that retries preserve event identity, ownership is server verified, and deletion blocks stale worker writes. Propose or implement only changes supported by the code you inspect.

Example frontend task:

> Use `.agents/skills/memvora-frontend/SKILL.md`. Implement the repository connection screen against the existing API contract. Include disconnected, loading, denied, and error states. Preserve the server/client boundary and label unconfigured integration states honestly. Verify keyboard navigation and the narrow layout.

## Keep context reliable

Include the user outcome, files or feature area, acceptance conditions, scope exclusions, and any observed error with its reproduction steps. Provide actual errors rather than describing a failure only as "broken." Share relevant redacted output; never paste access tokens or private captured sessions into a prompt.

Before accepting a suggested dependency or version-sensitive API, have the assistant inspect installed versions and the official documentation. A retrieved memory is a lead with provenance; its command may depend on an older environment. Check current conditions before reusing it.

## Review and verify a slice

1. Review the behavior and assumptions before implementation grows across boundaries.
2. Keep one owner for each edited file when using parallel agents. Split independent areas and agree on contracts before integrating them.
3. Inspect the diff for unintended files, credentials, placeholder successes, duplicated business logic, and changes outside the requested scope.
4. Run the relevant scripts listed in `package.json`. Exercise the actual boundary that changed, including one meaningful failure case when the feature has a failure mode.
5. Record the commands and outcomes. A generated test file is not a passed test; a started development server is not proof that the full product works.

Tests should verify meaningful behavior: event deduplication, access control, state transitions, source-backed retrieval, or command execution semantics. Small copy and styling changes usually need focused visual verification, not tests repeating markup.

## Finish with a useful handoff

Deliver changes through a feature branch and pull request into `main`. Use the developer's identity and keep the repository private. The user has authorized creating and merging these PRs without another approval request. Inspect the diff and complete applicable local validation, then create a PR with the concrete behavior, verification and remaining limits. Wait for the latest PR revision's required CI jobs to pass and merge that reviewed commit without bypassing protections or failed checks. Update local `main` safely and include the PR link in the handoff. These instructions also apply to documentation and workflow changes; do not resume direct feature pushes to `main`.

Ask the assistant to report the resulting behavior, changed interfaces, checks and outcomes, setup prerequisites, current limitations, and the next concrete task. Keep implemented behavior distinct from the roadmap. Update maintained documentation when a decision changes rather than accumulating contradictory notes in chat.

Use the developer's existing identity for branches, commits, and pull requests as described in `AGENTS.md`. The local skills do not introduce publishing permissions or approval gates for routine work already authorized by the user.
