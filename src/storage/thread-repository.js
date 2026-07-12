function createThreadRepository(db) {
  const insert = db.prepare(`
    INSERT INTO threads
      (id, title, project_dir, last_agent_id, created_at, updated_at)
    VALUES
      (@id, @title, @projectDir, @lastAgentId, @createdAt, @updatedAt)
  `);
  const findById = db.prepare("SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL");
  const listActive = db.prepare(
    "SELECT * FROM threads WHERE deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC"
  );
  const remove = db.prepare("DELETE FROM threads WHERE id = ?");

  return {
    create(input) {
      const now = input.createdAt || new Date().toISOString();
      insert.run({
        id: requiredString(input.id, "thread id"),
        title: stringOrEmpty(input.title),
        projectDir: stringOrEmpty(input.projectDir),
        lastAgentId: nullableString(input.lastAgentId),
        createdAt: now,
        updatedAt: input.updatedAt || now,
      });
      return this.get(input.id);
    },

    get(id) {
      return mapThread(findById.get(id));
    },

    list() {
      return listActive.all().map(mapThread);
    },

    delete(id) {
      return remove.run(id).changes > 0;
    },
  };
}

function mapThread(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    projectDir: row.project_dir,
    lastAgentId: row.last_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

module.exports = { createThreadRepository };
