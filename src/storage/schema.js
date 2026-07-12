const PRAGMAS = Object.freeze({
  journalMode: "WAL",
  foreignKeys: true,
  busyTimeoutMs: 5000,
});

const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: "memory_foundation",
    sql: `
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        project_dir TEXT NOT NULL DEFAULT '',
        last_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE context_windows (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        provider_session_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('active', 'sealing', 'sealed')),
        capacity_tokens INTEGER NOT NULL CHECK (capacity_tokens > 0),
        input_chars INTEGER NOT NULL DEFAULT 0 CHECK (input_chars >= 0),
        output_chars INTEGER NOT NULL DEFAULT 0 CHECK (output_chars >= 0),
        seal_reason TEXT,
        created_at TEXT NOT NULL,
        sealed_at TEXT,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        UNIQUE (thread_id, agent_id, provider_key, workspace_key, generation)
      );

      CREATE UNIQUE INDEX context_windows_one_open
        ON context_windows(thread_id, agent_id, provider_key, workspace_key)
        WHERE state IN ('active', 'sealing');
      CREATE INDEX context_windows_thread_generation
        ON context_windows(thread_id, generation);

      CREATE TABLE invocations (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        window_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'failed', 'aborted')),
        exit_code INTEGER,
        signal TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY (window_id) REFERENCES context_windows(id) ON DELETE CASCADE
      );

      CREATE INDEX invocations_thread_started
        ON invocations(thread_id, started_at);
      CREATE INDEX invocations_window_started
        ON invocations(window_id, started_at);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        window_id TEXT,
        invocation_id TEXT,
        sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
        role TEXT NOT NULL,
        agent_id TEXT,
        content TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY (window_id) REFERENCES context_windows(id) ON DELETE SET NULL,
        FOREIGN KEY (invocation_id) REFERENCES invocations(id) ON DELETE SET NULL,
        UNIQUE (thread_id, sequence_no)
      );

      CREATE INDEX messages_thread_created
        ON messages(thread_id, created_at);
      CREATE INDEX messages_window_sequence
        ON messages(window_id, sequence_no);

      CREATE TABLE invocation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invocation_id TEXT NOT NULL,
        sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (invocation_id) REFERENCES invocations(id) ON DELETE CASCADE,
        UNIQUE (invocation_id, sequence_no)
      );

      CREATE INDEX invocation_events_invocation_sequence
        ON invocation_events(invocation_id, sequence_no);

      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('captured', 'confirmed', 'superseded', 'invalidated')),
        content TEXT NOT NULL,
        source_message_id TEXT,
        source_invocation_id TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        superseded_by TEXT,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (source_invocation_id) REFERENCES invocations(id) ON DELETE SET NULL,
        FOREIGN KEY (superseded_by) REFERENCES memory_entries(id) ON DELETE SET NULL
      );

      CREATE INDEX memory_entries_thread_created
        ON memory_entries(thread_id, created_at);
      CREATE INDEX memory_entries_thread_status
        ON memory_entries(thread_id, status);

      CREATE TABLE recall_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        window_id TEXT,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        agent_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
        FOREIGN KEY (window_id) REFERENCES context_windows(id) ON DELETE SET NULL,
        UNIQUE (source_kind, source_id)
      );

      CREATE INDEX recall_items_thread_created
        ON recall_items(thread_id, created_at);

      CREATE VIRTUAL TABLE recall_fts USING fts5(
        title,
        content,
        content='recall_items',
        content_rowid='id'
      );

      CREATE TRIGGER recall_items_ai AFTER INSERT ON recall_items BEGIN
        INSERT INTO recall_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;

      CREATE TRIGGER recall_items_ad AFTER DELETE ON recall_items BEGIN
        INSERT INTO recall_fts(recall_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
      END;

      CREATE TRIGGER recall_items_au AFTER UPDATE ON recall_items BEGIN
        INSERT INTO recall_fts(recall_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
        INSERT INTO recall_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;
    `,
  },
]);

module.exports = { PRAGMAS, MIGRATIONS };
