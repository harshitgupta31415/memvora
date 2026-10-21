import { describe, expect, it, vi } from 'vitest';

type Schema = { safeParse(value: unknown): { success: boolean; data?: unknown } };
const registrations = vi.hoisted(() => new Map<string, Schema>());
vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: class {
    registerTool(name: string, definition: { inputSchema: Schema }) {
      registrations.set(name, definition.inputSchema);
    }
  },
}));
vi.mock('@modelcontextprotocol/server/stdio', () => ({
  serveStdio(factory: () => unknown) {
    factory();
  },
}));
import './index.js';

const id = '11111111-1111-4111-8111-111111111111';
const valid: Record<string, Record<string, unknown>> = {
  memvora_status: {},
  find_sessions: {
    query: 'migration',
    repositoryId: id,
    status: 'open',
    limit: 3,
    cursor: 'opaque-directory-cursor',
  },
  search_memory: { query: 'failure', repositoryIds: [], limit: 2 },
  search_repository_sources: { query: 'failure', repositoryIds: [id], limit: 2 },
  get_repository_source: { id, startLine: 3, limit: 20 },
  get_memory: { id },
  search_session_notes: { query: 'decision', repositoryIds: [], limit: 2 },
  get_session_note: { id },
  get_session_notes: { id, before: id, limit: 2 },
  get_session_handover: { id },
  get_session_recap: { id },
  get_session_synthesis: { id, requestId: id },
  get_session_context: { id, cursor: 'opaque-history-cursor', limit: 2 },
};

describe('registered MCP input boundaries', () => {
  it('rejects unrecognized selectors on every tool instead of stripping them into a wider request', () => {
    expect([...registrations.keys()].sort()).toEqual(Object.keys(valid).sort());
    for (const [name, schema] of registrations) {
      expect(schema.safeParse({ ...valid[name], repositories: [id] }).success, name).toBe(false);
      expect(schema.safeParse({ ...valid[name], includeAll: true }).success, name).toBe(false);
    }
  });

  it('preserves every known optional field and explicit empty repository filter', () => {
    for (const [name, input] of Object.entries(valid)) {
      const result = registrations.get(name)!.safeParse(input);
      expect(result.success, name).toBe(true);
      expect(result.data, name).toEqual(input);
    }
  });
});
