const assert = require("node:assert/strict");
const test = require("node:test");

const {
  openMemoryDatabase,
  withTransaction,
  checkpointMemoryDatabase,
} = require("../../src/storage/database");
const { applyMigrations, validateMigrations } = require("../../src/storage/migrations");
const { MIGRATIONS } = require("../../src/storage/schema");

test("memory database applies schema and safety pragmas", () => {
  const db = openMemoryDatabase({ file: ":memory:" });
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .all()
        .map((row) => row.name)
    );

    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);
    assert.equal(
      db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,
      4
    );
    for (const name of [
      "threads",
      "context_windows",
      "messages",
      "invocations",
      "invocation_events",
      "memory_entries",
      "recall_items",
      "recall_fts",
    ]) {
      assert.ok(tables.has(name), `expected ${name} table`);
    }

    assert.equal(applyMigrations(db), 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 4);
    const memoryColumns = new Set(
      db
        .prepare("PRAGMA table_info(memory_entries)")
        .all()
        .map((column) => column.name)
    );
    for (const column of ["metadata_json", "window_id", "capture_key", "supersession_key"]) {
      assert.ok(memoryColumns.has(column), `expected memory_entries.${column}`);
    }
    const windowColumns = new Set(
      db
        .prepare("PRAGMA table_info(context_windows)")
        .all()
        .map((column) => column.name)
    );
    for (const column of [
      "reserve_ratio",
      "context_used_tokens",
      "context_usage_source",
      "billing_total_tokens",
      "billing_cost_usd",
    ]) {
      assert.ok(windowColumns.has(column), `expected context_windows.${column}`);
    }
  } finally {
    db.close();
  }
});

test("database quick check and WAL checkpoint report healthy state", () => {
  const db = openMemoryDatabase({ file: ":memory:" });
  try {
    assert.equal(db.pragma("quick_check", { simple: true }), "ok");
    assert.ok(Array.isArray(checkpointMemoryDatabase(db, "PASSIVE")));
    assert.throws(() => checkpointMemoryDatabase(db, "invalid"), /Unsupported WAL checkpoint/);
  } finally {
    db.close();
  }
});

test("storage migrations require contiguous immutable versions", () => {
  assert.throws(
    () => validateMigrations([{ version: 2, name: "bad", sql: "SELECT 1" }]),
    /Expected storage migration version 1/
  );
  assert.throws(
    () => validateMigrations([{ version: 1, name: "", sql: "SELECT 1" }]),
    /migration 1 is incomplete/
  );
});

test("storage refuses a database created by newer code", () => {
  const db = openMemoryDatabase({ file: ":memory:" });
  try {
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, 'future', 'now')"
    ).run();
    assert.throws(() => applyMigrations(db), /newer than supported version 4/);
  } finally {
    db.close();
  }
});

test("later migrations upgrade a version 2 database without losing memory rows", () => {
  const db = openMemoryDatabase({ file: ":memory:", migrations: MIGRATIONS.slice(0, 2) });
  try {
    db.prepare(
      "INSERT INTO threads (id, created_at, updated_at) VALUES ('thread-1', 'now', 'now')"
    ).run();
    db.prepare(
      `
      INSERT INTO memory_entries
        (id, thread_id, kind, status, content, created_by, created_at)
      VALUES ('memory-1', 'thread-1', 'decision', 'captured', 'keep me', 'test', 'now')
    `
    ).run();

    assert.equal(applyMigrations(db), 4);
    const memory = db.prepare("SELECT * FROM memory_entries WHERE id = 'memory-1'").get();
    assert.equal(memory.content, "keep me");
    assert.equal(memory.capture_key, null);
    assert.equal(memory.supersession_key, null);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 3").get().count,
      1
    );
  } finally {
    db.close();
  }
});

test("context usage migration rebases only legacy active model capacities", () => {
  const db = openMemoryDatabase({ file: ":memory:", migrations: MIGRATIONS.slice(0, 3) });
  try {
    db.prepare("INSERT INTO threads (id, created_at, updated_at) VALUES ('t', 'now', 'now')").run();
    const insert = db.prepare(`
      INSERT INTO context_windows
        (id, thread_id, agent_id, provider_key, workspace_key, generation, state,
         capacity_tokens, created_at)
      VALUES (?, 't', ?, ?, 'base', 1, ?, ?, 'now')
    `);
    insert.run("active-codex", "codex", "codex", "active", 200000);
    insert.run("sealed-gemini", "gemini", "antigravity", "sealed", 200000);

    assert.equal(applyMigrations(db), 4);
    assert.equal(
      db.prepare("SELECT capacity_tokens FROM context_windows WHERE id = 'active-codex'").get()
        .capacity_tokens,
      258000
    );
    assert.equal(
      db.prepare("SELECT capacity_tokens FROM context_windows WHERE id = 'sealed-gemini'").get()
        .capacity_tokens,
      200000
    );
  } finally {
    db.close();
  }
});

test("recall FTS triggers stay synchronized with their projection", () => {
  const db = openMemoryDatabase({ file: ":memory:" });
  try {
    db.prepare(
      "INSERT INTO threads (id, created_at, updated_at) VALUES ('thread-1', 'now', 'now')"
    ).run();
    db.prepare(
      `
      INSERT INTO recall_items
        (thread_id, source_kind, source_id, title, content, created_at)
      VALUES
        ('thread-1', 'message', 'message-1', 'SQLite decision', 'Keep raw evidence', 'now')
    `
    ).run();

    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM recall_fts WHERE recall_fts MATCH 'evidence'").get()
        .count,
      1
    );
    db.prepare(
      "UPDATE recall_items SET content = 'Replaced text' WHERE source_id = 'message-1'"
    ).run();
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM recall_fts WHERE recall_fts MATCH 'evidence'").get()
        .count,
      0
    );
    db.prepare("DELETE FROM recall_items WHERE source_id = 'message-1'").run();
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM recall_fts").get().count, 0);
  } finally {
    db.close();
  }
});

test("withTransaction rolls back the complete unit of work", () => {
  const db = openMemoryDatabase({ file: ":memory:" });
  try {
    assert.throws(() =>
      withTransaction(db, () => {
        db.prepare(
          "INSERT INTO threads (id, created_at, updated_at) VALUES ('thread-1', 'now', 'now')"
        ).run();
        throw new Error("stop");
      })
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM threads").get().count, 0);
  } finally {
    db.close();
  }
});
