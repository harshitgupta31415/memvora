# Retrieval evaluation

This evaluation checks a declared set of retrieval questions against disposable, explicitly synthetic engineering evidence. It is separate from the real-command capture demo and from provider/model assessment. It does not seed the application's live database, execute captured commands, or call GitHub or an AI provider.

## Run the fixed corpus

Build shared packages and services first, then run from the repository root:

```powershell
.\scripts\with-resource-limits.ps1 npm.cmd run build:packages
.\scripts\with-resource-limits.ps1 npm.cmd run build:services
.\scripts\with-resource-limits.ps1 npm.cmd run evaluate:retrieval
```

The fixture module declares questions and relevant records before retrieval. The evaluator uses the actual authenticated API, with representative compiled CLI Ask and MCP stdio checks. Expected results are original event, note and immutable file-source identities, rather than a prewritten answer. Reports disclose synthetic data, corpus version, runtime, case-level results and the distinction between retrieval ranking and Ask's nearby context.

Before changing retrieval, run the evaluator against the existing compiled implementation with `node scripts/evaluate-retrieval.mjs --baseline`. Only the six declared cases and their explicit failure classes may record known baseline quality failures without a nonzero exit. Undeclared misses/false positives and all scope, schema, citation, read-only, provider and cleanup failures still fail baseline execution. The report marks those allowed failures; it does not call them passing checks. Preserve that report before rebuilding, then run the default gate on the same corpus. Baseline mode is for comparison; CI uses the default gate.

## What is measured

Search results are scored by original returned identities at cutoffs 1, 3 and 5. Hit rate asks whether any declared relevant result was returned; recall measures the fraction of relevant records recovered; reciprocal rank measures the position of the first relevant result. Precision@K divides relevant returned records by K, including unfilled slots. Empty-result cases and access-denial checks are separate from positive-query averages. Ask evidence may include authorized neighboring commands; those context records are not mislabeled as direct search hits.

The corpus covers older attempts beyond the newest timeline page, similar errors in different repositories, noisy and late output, argument/diff matches, summary availability, long questions, authored reports, imported files, unrelated questions and bounded context selection. It also checks original citation identity, empty/denied scope, duplicates and retrieval without enrichment or data writes. Scores describe this small declared corpus. They do not establish semantic understanding, universal search accuracy or the PRD's 10,000-event latency target. No sustained benchmark is part of this check.

## Implemented retrieval bounds

Command memories, imported files and journal notes share one bounded literal-query parser. It accepts at most 2,000 characters and retains the first 64 distinct whitespace-separated literals after the existing small stopword list, rather than dropping useful text after twelve terms. Literals stay quoted in FTS expressions; punctuation may become a token sequence under [SQLite's FTS5 phrase rules](https://www.sqlite.org/fts5.html#fts5_phrases). This is lexical OR matching, not an exact-substring or semantic search. Very word-dense queries can still exceed the 64-literal budget; use distinctive error text or an identifier.

Authorization and repository/session restrictions remain inside both raw and summary candidate queries before their separate 100-result caps. Reciprocal-rank fusion and event-ID deduplication remain unchanged. A stored summary takes precedence for an accepted event even when only its raw evidence matched. Search reads do not create summaries or jobs.

Ask considers the first ten ranked search hits across at most three investigations and selects at most ten command records including nearby context. It reserves those matching commands before admitting nearby commands, shares remaining context slots across selected investigations, and shows each investigation in sequence order. Its 30-step limit reserves a cited step for every selected command before adding more detail; up to five notes and five file excerpts retain their separate slots. Notes also retain links to their original attached commands, so the citation manifest can include additional event IDs outside the ten selected command records. Omitted matches/context and shortened steps are disclosed. Open the paged history and original event to inspect evidence outside those limits. If a current detail read reports unavailable evidence, Ask propagates that failure instead of reconstructing a previously read command.

## Recorded local comparison

On 21 October 2026, Windows with Node 26.2.0 evaluated corpus version 1 against the preceding compiled implementation and then the rebuilt fixes. Both reports record corpus SHA-256 `90ca0389b3fa5f6a09108ed9c0e65917cfd1a078cff8e38732e3b75cdc19d07c` and separate hashes of the actual compiled core/DB modules. The corpus retained the same 20 cases and 162 authorized synthetic events; a separate foreign-workspace fixture tests denial. No captured fixture command or external provider was executed.

| Measure                                                               | Before | After  |
| --------------------------------------------------------------------- | ------ | ------ |
| Cases satisfying all declared quality expectations                    | 14/20  | 20/20  |
| Positive-query hit rate at 1, 3 and 5 (17 queries)                    | 76.47% | 100%   |
| Macro recall at 3 and 5                                               | 76.47% | 100%   |
| Macro recall at 1                                                     | 66.67% | 90.20% |
| Correct empty results (three negative/boundary cases)                 | 3/3    | 3/3    |
| Quality assertions failing across the six affected cases              | 18     | 0      |
| Scope, schema, citation, no-write/provider and client agreement gates | Passed | Passed |

The six affected cases are four long-question searches (two command, one journal, one code) and two Ask anchor-coverage checks. At K=1, questions with multiple relevant records cannot recover them all. Precision@5 after the fix is 24.71% because most questions have only one relevant record and precision counts all five slots; this is not a claim that the API returned five unrelated records. Per-case IDs and all K values remain in `.memvora/retrieval-baseline.json` and `.memvora/retrieval-evaluation.json`. Actual compiled CLI Ask and MCP search agreed with the API; MCP paged through twelve history pages to resolve the older event. These are correctness observations, not a throughput or model-quality benchmark.

## Work that remains

Expand relevance judgments using actual developer questions, with private data kept out of committed fixtures. Investigate generic-word false positives, summary-availability ranking bias, repeated attempts crowding search results and source-excerpt selection before changing scoring. Embeddings and investigation-level model reasoning need separate evaluation, provenance and lifecycle controls. A passing lexical corpus does not satisfy those release gates.
