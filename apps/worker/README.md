# Local enrichment worker

The API includes a low-frequency worker for the local MVP. `npm run start --workspace=@memvora/worker` can also run a separate worker against the same SQLite store. Each process claims one job at a time with a bounded lease, attempts, and retry backoff. Completed summaries must cite their immutable input event and pass a final generation fence. There are no placeholder consumers that acknowledge work without processing it.

By default summaries report deterministic observations, clearly labeled as not AI-generated; they do not infer a confirmed root cause or resolution from an exit code. An explicitly configured provider may enrich the same bounded evidence through the shared service boundary. Failed processing remains visible in dashboard counts and keeps raw evidence available.

`npm run check-config --workspace=@memvora/worker` checks the local data path without opening the database; it does not establish readiness. The SQLite worker refuses production mode. The unused `queue.ts` pg-boss factory is retained only for the future PostgreSQL adapter and is not part of the local execution path.
