import type { SystemStatus } from '@memvora/contracts';

export * from './local-service.js';
export * from './github-connection.js';

/** Domain boundaries, not independently deployed services. */
export const moduleNames = ['identity', 'github', 'capture', 'memory', 'retrieval'] as const;
export type ModuleName = (typeof moduleNames)[number];

/** Public scaffold metadata only. Never infer readiness or user access from this. */
export function getSystemStatus(options: { local?: boolean } = {}): SystemStatus {
  if (options.local)
    return {
      product: 'Memvora',
      stage: 'local_mvp',
      capabilities: [
        {
          id: 'github',
          label: 'Repository context',
          status: 'limited',
          detail:
            'Explicit bounded imports through a configured private GitHub App or local CLI access; continuous synchronization remains separate.',
        },
        {
          id: 'capture',
          label: 'Command evidence',
          status: 'implemented',
          detail: 'Immutable finalized events are durably accepted with exact acknowledgements.',
        },
        {
          id: 'memory',
          label: 'Evidence summaries',
          status: 'implemented',
          detail: 'Cited observed summaries, or an explicitly configured enrichment provider.',
        },
        {
          id: 'retrieval',
          label: 'Memory retrieval',
          status: 'limited',
          detail: 'Local workspace-scoped lexical search, cited recall, and raw timelines.',
        },
        {
          id: 'mcp',
          label: 'MCP adapter',
          status: 'implemented',
          detail: 'Read-only tools call the same protected API.',
        },
      ],
    };
  return {
    product: 'Memvora',
    stage: 'scaffold',
    capabilities: [
      {
        id: 'github',
        label: 'GitHub connection',
        status: 'planned',
        detail: 'GitHub App installation and repository authorization are not implemented.',
      },
      {
        id: 'capture',
        label: 'Command capture',
        status: 'planned',
        detail: 'No terminal command is executed, recorded, or uploaded by this starter.',
      },
      {
        id: 'memory',
        label: 'Evidence and summaries',
        status: 'planned',
        detail: 'Durable evidence ingestion and cited summaries are not implemented.',
      },
      {
        id: 'retrieval',
        label: 'Memory retrieval',
        status: 'planned',
        detail: 'Authenticated, repository-scoped retrieval is not implemented.',
      },
      {
        id: 'mcp',
        label: 'MCP adapter',
        status: 'scaffold',
        detail: 'A stdio status tool is available; memory retrieval tools are not exposed.',
      },
    ],
  };
}
export * from './source-excerpts.js';
export * from './session-recap.js';
