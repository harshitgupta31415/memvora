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
CREATE INDEX IF NOT EXISTS local_jobs_scope ON local_jobs(workspace_id,status,available_at);
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

/** Version 3 preserves explicit manual retry history separately from each attempt budget. */
export const localRetryMigrationSql = `
ALTER TABLE local_jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0);
PRAGMA user_version = 3;
`;

/** Version 4 immutable imported snapshots, with search membership limited to current heads. */
export const localRepositorySourcesMigrationSql = `
CREATE TABLE IF NOT EXISTS local_repository_context_scope (
  repository_id TEXT PRIMARY KEY REFERENCES local_repository_context(repository_id) ON DELETE CASCADE,
  workspace_generation INTEGER NOT NULL,
  repository_generation INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS local_repository_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES local_workspaces(id),
  repository_id TEXT NOT NULL REFERENCES local_repositories(id) ON DELETE CASCADE,
  workspace_generation INTEGER NOT NULL,
  repository_generation INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  path TEXT NOT NULL,
  commit_sha TEXT,
  commit_key TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  line_count INTEGER NOT NULL CHECK(line_count >= 1),
  imported_at TEXT NOT NULL,
  UNIQUE(repository_id,workspace_generation,repository_generation,full_name,path,commit_key,blob_sha,content_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS local_repository_sources_scope ON local_repository_sources(workspace_id,repository_id,id);
CREATE TABLE IF NOT EXISTS local_repository_source_heads (
  repository_id TEXT NOT NULL REFERENCES local_repositories(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES local_repository_sources(id) ON DELETE CASCADE,
  PRIMARY KEY(repository_id,path)
) STRICT;
CREATE VIRTUAL TABLE IF NOT EXISTS local_repository_source_fts USING fts5(source_id UNINDEXED,searchable_text,tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS local_repository_source_immutable BEFORE UPDATE ON local_repository_sources BEGIN
  SELECT RAISE(ABORT,'REPOSITORY_SOURCE_IMMUTABLE');
END;
CREATE TRIGGER IF NOT EXISTS local_repository_source_head_insert AFTER INSERT ON local_repository_source_heads BEGIN
  INSERT INTO local_repository_source_fts(source_id,searchable_text)
    SELECT id,full_name || char(10) || path || char(10) || text FROM local_repository_sources WHERE id=new.source_id;
END;
CREATE TRIGGER IF NOT EXISTS local_repository_source_head_delete AFTER DELETE ON local_repository_source_heads BEGIN
  DELETE FROM local_repository_source_fts WHERE source_id=old.source_id;
END;
CREATE TRIGGER IF NOT EXISTS local_repository_source_head_update AFTER UPDATE OF source_id ON local_repository_source_heads BEGIN
  DELETE FROM local_repository_source_fts WHERE source_id=old.source_id;
  INSERT INTO local_repository_source_fts(source_id,searchable_text)
    SELECT id,full_name || char(10) || path || char(10) || text FROM local_repository_sources WHERE id=new.source_id;
END;
`;

/** Version 5 assigns durable intake membership independently from command sequence or rowid reuse. */
export const localSessionHistoryMigrationSql = `
CREATE TABLE IF NOT EXISTS local_event_intakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE REFERENCES local_events(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS local_history_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  cursor_secret TEXT NOT NULL CHECK(length(cursor_secret)=64)
) STRICT;
INSERT INTO local_event_intakes(event_id)
  SELECT e.id FROM local_events e WHERE NOT EXISTS(SELECT 1 FROM local_event_intakes i WHERE i.event_id=e.id) ORDER BY e.rowid ASC;
`;

/** Version 6 keeps OAuth state and encrypted GitHub credentials on the local server. */
export const localGitHubConnectionMigrationSql = `
CREATE TABLE IF NOT EXISTS local_github_connections (
  workspace_id TEXT PRIMARY KEY REFERENCES local_workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  workspace_generation INTEGER NOT NULL CHECK(workspace_generation >= 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  github_user_id INTEGER,
  github_user_json TEXT,
  config_hash TEXT,
  encrypted_tokens TEXT,
  expires_at INTEGER,
  updated_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS local_github_oauth_attempts (
  workspace_id TEXT PRIMARY KEY REFERENCES local_workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  workspace_generation INTEGER NOT NULL CHECK(workspace_generation >= 1),
  state_hash TEXT NOT NULL UNIQUE,
  browser_hash TEXT NOT NULL,
  encrypted_verifier TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0)
) STRICT;
`;

/** Version 7 records immutable, explicitly user-authored investigation context. */
export const localSessionNotesMigrationSql = `
CREATE TABLE IF NOT EXISTS local_session_notes (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES local_workspaces(id),
  repository_id TEXT NOT NULL REFERENCES local_repositories(id),
  session_id TEXT NOT NULL REFERENCES local_sessions(id),
  workspace_generation INTEGER NOT NULL,
  repository_generation INTEGER NOT NULL,
  session_generation INTEGER NOT NULL,
  digest TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('note','decision','resolution')),
  body TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  event_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS local_session_notes_session ON local_session_notes(workspace_id,session_id,ordinal DESC);
CREATE INDEX IF NOT EXISTS local_session_notes_repository ON local_session_notes(workspace_id,repository_id,ordinal DESC);
CREATE INDEX IF NOT EXISTS local_session_notes_recent ON local_session_notes(workspace_id,created_at DESC,ordinal DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS local_session_note_fts USING fts5(note_id UNINDEXED,body,tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS local_session_note_immutable BEFORE UPDATE ON local_session_notes BEGIN
  SELECT RAISE(ABORT,'SESSION_NOTE_IMMUTABLE');
END;
CREATE TRIGGER IF NOT EXISTS local_session_note_fts_insert AFTER INSERT ON local_session_notes BEGIN
  INSERT INTO local_session_note_fts(note_id,body) VALUES(new.id,new.body);
END;
CREATE TRIGGER IF NOT EXISTS local_session_note_fts_delete AFTER DELETE ON local_session_notes BEGIN
  DELETE FROM local_session_note_fts WHERE note_id=old.id;
END;
INSERT INTO local_session_note_fts(note_id,body)
  SELECT n.id,n.body FROM local_session_notes n WHERE NOT EXISTS(SELECT 1 FROM local_session_note_fts f WHERE f.note_id=n.id);
`;
