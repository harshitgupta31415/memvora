# Domain core

The module registry names the domain boundaries: identity, GitHub access, capture ingestion, memory, and retrieval. `LocalMemvora` coordinates the working personal local mode through an explicit `LocalEvidenceStore` port. `prepareEvents` enforces capture limits and immutable digests; observed enrichment produces cited observations and uncertainty. `getSystemStatus({local:true})` describes this limited local implementation; no-argument scaffold metadata remains available for an unconfigured adapter.

Keep domain policy independent from Fastify, Next.js, Commander, the MCP SDK, and queue handlers. Adapters should call shared use cases with a trusted server-derived access context. Do not implement each client's own repository authorization, filtering, or summary interpretation.
