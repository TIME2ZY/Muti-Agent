const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { DEFAULT_MEMORY_DB_FILE } = require("../shared/runtime-paths");
const { applyMigrations } = require("./migrations");
const { PRAGMAS } = require("./schema");

function openMemoryDatabase(options = {}) {
  const file = options.file || DEFAULT_MEMORY_DB_FILE;
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }

  const db = new Database(file);
  try {
    db.pragma(`journal_mode = ${PRAGMAS.journalMode}`);
    db.pragma(`foreign_keys = ${PRAGMAS.foreignKeys ? "ON" : "OFF"}`);
    db.pragma(`busy_timeout = ${PRAGMAS.busyTimeoutMs}`);
    applyMigrations(db, options.migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function withTransaction(db, work) {
  if (!db || typeof db.transaction !== "function") {
    throw new Error("An open SQLite database is required.");
  }
  if (typeof work !== "function") {
    throw new Error("Transaction work must be a function.");
  }
  return db.transaction(work)();
}

module.exports = { openMemoryDatabase, withTransaction };
