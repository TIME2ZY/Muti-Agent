const assert = require("node:assert/strict");
const test = require("node:test");

const {
  openMemoryDatabase,
  withTransaction,
  checkpointMemoryDatabase,
} = require("../../src/storage/database");
const { applyMigrations, validateMigrations } = require("../../src/storage/migrations");

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
      2
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

    assert.equal(applyMigrations(db), 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 2);
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
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (3, 'future', 'now')"
    ).run();
    assert.throws(() => applyMigrations(db), /newer than supported version 2/);
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
