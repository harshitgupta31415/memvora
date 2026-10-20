/** Local MVP storage. Future PostgreSQL migrations are a separate reviewed adapter. */
export const localSchemaSql = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS local_identity (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS local_workspaces (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deleted')),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS local_repositories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES local_workspaces(id),
  name TEXT NOT NULL,
  local_path TEXT,
  remote_url TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deleted')),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS local_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES local_workspaces(id),
  repository_id TEXT NOT NULL REFERENCES local_repositories(id),
  title TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed', 'deleted')),
  created_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS local_repository_context (
  repository_id TEXT PRIMARY KEY REFERENCES local_repositories(id) ON DELETE CASCADE,
  context_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS local_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES local_workspaces(id),
  repository_id TEXT NOT NULL REFERENCES local_repositories(id),
  session_id TEXT NOT NULL REFERENCES local_sessions(id),
  sequence INTEGER NOT NULL,
  digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE(session_id, sequence)
) STRICT;
CREATE INDEX IF NOT EXISTS local_events_scope ON local_events(workspace_id, repository_id, session_id, sequence);
CREATE INDEX IF NOT EXISTS local_events_recent ON local_events(workspace_id,received_at DESC);
CREATE TABLE IF NOT EXISTS local_jobs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES local_events(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  workspace_generation INTEGER NOT NULL,
  repository_generation INTEGER NOT NULL,
  session_generation INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'ready', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_until TEXT,
  lease_token TEXT,
  last_error TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS local_jobs_pending ON local_jobs(status, available_at);
CREATE TABLE IF NOT EXISTS local_memories (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES local_events(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  searchable_text TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS local_memories_scope ON local_memories(workspace_id, repository_id, created_at, id);
`;

/** Version 2: indexed lexical recall. This one-time backfill runs only on an older database. */
export const localFtsMigrationSql = `
CREATE VIRTUAL TABLE IF NOT EXISTS local_memory_fts USING fts5(memory_id UNINDEXED,searchable_text,tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS local_memory_fts_insert AFTER INSERT ON local_memories BEGIN
  INSERT INTO local_memory_fts(memory_id,searchable_text) VALUES(new.id,new.searchable_text);
END;
CREATE TRIGGER IF NOT EXISTS local_memory_fts_delete AFTER DELETE ON local_memories BEGIN
  DELETE FROM local_memory_fts WHERE memory_id=old.id;
END;
CREATE TRIGGER IF NOT EXISTS local_memory_fts_update AFTER UPDATE OF searchable_text ON local_memories BEGIN
  DELETE FROM local_memory_fts WHERE memory_id=old.id;
  INSERT INTO local_memory_fts(memory_id,searchable_text) VALUES(new.id,new.searchable_text);
END;
INSERT INTO local_memory_fts(memory_id,searchable_text)
  SELECT id,searchable_text FROM local_memories WHERE id NOT IN (SELECT memory_id FROM local_memory_fts);
PRAGMA user_version = 2;
`;
