# Optional AI enrichment

The local product works without an AI account: it derives explicitly labeled observations from real captured events. This mode never claims that an AI model inferred a root cause.

An optional HTTP enrichment adapter is implemented for providers supporting `/chat/completions`, JSON-object responses, and `max_completion_tokens`. Enable it deliberately in the ignored root `.env`:

```dotenv
MEMVORA_AI_ENABLED=true
AI_BASE_URL=https://your-provider.example/v1
AI_API_KEY=your-key
AI_MODEL=your-supported-model
```

Restart the API/worker after configuration. Existing observed summaries are not silently rewritten. New jobs call the provider only after evidence commits. One job runs at a time. Calls have bounded input/output, an output-token limit and a 30-second timeout. HTTPS is required except for a deliberately configured loopback provider. No GPU model is started or downloaded.

The adapter checks the generated JSON and every citation before storing it. A malformed response, unknown citation, truncated completion or provider error fails the job; raw evidence remains available. Source IDs, observed outcomes and event identity stay under application control. Summaries include provider/model/prompt provenance without storing the API credential.

Tests use a labeled fake HTTP transport to verify validation and failure behavior. No real provider has been exercised until a user-configured credential and model are available. Check your selected provider's parameter support before enabling it. Enabling the provider sends bounded redacted engineering evidence to that configured endpoint; review that provider's data handling for private repositories.

Protocol reference: [Chat Completions request fields](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create). This generic adapter does not select a vendor or model for you.
