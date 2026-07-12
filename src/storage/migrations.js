const { MIGRATIONS } = require("./schema");

function validateMigrations(migrations) {
  let expected = 1;
  for (const migration of migrations) {
    if (!migration || migration.version !== expected) {
      throw new Error(`Expected storage migration version ${expected}.`);
    }
    if (!migration.name || !migration.sql) {
      throw new Error(`Storage migration ${expected} is incomplete.`);
    }
    expected += 1;
  }
}

function applyMigrations(db, migrations = MIGRATIONS) {
  validateMigrations(migrations);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Map(
    db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => [row.version, row.name])
  );
  const newestApplied = Math.max(0, ...applied.keys());
  if (newestApplied > migrations.length) {
    throw new Error(
      `Storage schema version ${newestApplied} is newer than supported version ${migrations.length}.`
    );
  }

  for (const migration of migrations) {
    const appliedName = applied.get(migration.version);
    if (appliedName) {
      if (appliedName !== migration.name) {
        throw new Error(
          `Storage migration ${migration.version} name mismatch: ${appliedName} != ${migration.name}.`
        );
      }
      continue;
    }

    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString()
      );
    })();
  }

  return migrations.length;
}

module.exports = { applyMigrations, validateMigrations };
