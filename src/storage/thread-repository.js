function createThreadRepository(db) {
  const insert = db.prepare(`
    INSERT INTO threads
      (id, title, project_dir, last_agent_id, created_at, updated_at)
    VALUES
      (@id, @title, @projectDir, @lastAgentId, @createdAt, @updatedAt)
  `);
  const upsert = db.prepare(`
    INSERT INTO threads
      (id, title, project_dir, last_agent_id, created_at, updated_at)
    VALUES
      (@id, @title, @projectDir, @lastAgentId, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      project_dir = excluded.project_dir,
      last_agent_id = excluded.last_agent_id,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `);
  const findById = db.prepare("SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL");
  const listActive = db.prepare(
    "SELECT * FROM threads WHERE deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC"
  );
  const listWithMessageCounts = db.prepare(`
    SELECT t.*, COUNT(m.id) AS message_count
    FROM threads t
    LEFT JOIN messages m ON m.thread_id = t.id
    WHERE t.deleted_at IS NULL
    GROUP BY t.id
    ORDER BY t.updated_at DESC, t.created_at DESC
  `);
  const remove = db.prepare("DELETE FROM threads WHERE id = ?");

  return {
    create(input) {
      insert.run(normalizeThread(input));
      return this.get(input.id);
    },

    upsert(input) {
      upsert.run(normalizeThread(input));
      return this.get(input.id);
    },

    get(id) {
      return mapThread(findById.get(id));
    },

    list() {
      return listActive.all().map(mapThread);
    },

    listWithMessageCounts() {
      return listWithMessageCounts.all().map((row) => ({
        ...mapThread(row),
        messageCount: Number(row.message_count || 0),
      }));
    },

    delete(id) {
      return remove.run(id).changes > 0;
    },
  };
}

function normalizeThread(input) {
  const now = input.createdAt || new Date().toISOString();
  return {
    id: requiredString(input.id, "thread id"),
    title: stringOrEmpty(input.title),
    projectDir: stringOrEmpty(input.projectDir),
    lastAgentId: nullableString(input.lastAgentId),
    createdAt: now,
    updatedAt: input.updatedAt || now,
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
    nextMessageSequence: row.next_message_sequence,
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
