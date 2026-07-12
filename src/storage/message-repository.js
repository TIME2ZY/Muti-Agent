function createMessageRepository(db) {
  // Idempotent upsert: replaying dual-write / migration must not create
  // duplicate message rows (PRIMARY KEY id + UNIQUE thread/sequence).
  const insert = db.prepare(`
    INSERT INTO messages
      (id, thread_id, window_id, invocation_id, sequence_no, role,
       agent_id, content, metadata_json, created_at)
    VALUES
      (@id, @threadId, @windowId, @invocationId, @sequenceNo, @role,
       @agentId, @content, @metadataJson, @createdAt)
    ON CONFLICT(id) DO UPDATE SET
      thread_id = excluded.thread_id,
      window_id = excluded.window_id,
      invocation_id = excluded.invocation_id,
      sequence_no = excluded.sequence_no,
      role = excluded.role,
      agent_id = excluded.agent_id,
      content = excluded.content,
      metadata_json = excluded.metadata_json,
      created_at = excluded.created_at
  `);
  const findById = db.prepare("SELECT * FROM messages WHERE id = ?");
  const listByThread = db.prepare(`
    SELECT * FROM messages WHERE thread_id = ? ORDER BY sequence_no ASC
  `);

  return {
    append(input) {
      insert.run({
        id: requiredString(input.id, "message id"),
        threadId: requiredString(input.threadId, "thread id"),
        windowId: nullableString(input.windowId),
        invocationId: nullableString(input.invocationId),
        sequenceNo: nonNegativeInteger(input.sequenceNo, "message sequence"),
        role: requiredString(input.role, "message role"),
        agentId: nullableString(input.agentId),
        content: stringValue(input.content, "message content"),
        metadataJson: input.metadata === undefined ? null : JSON.stringify(input.metadata),
        createdAt: input.createdAt || new Date().toISOString(),
      });
      return this.get(input.id);
    },

    get(id) {
      return mapMessage(findById.get(id));
    },

    listForThread(threadId) {
      return listByThread.all(threadId).map(mapMessage);
    },
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    windowId: row.window_id,
    invocationId: row.invocation_id,
    sequenceNo: row.sequence_no,
    role: row.role,
    agentId: row.agent_id,
    content: row.content,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

function parseJson(value) {
  if (!value) return null;
  return JSON.parse(value);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function stringValue(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

module.exports = { createMessageRepository };
