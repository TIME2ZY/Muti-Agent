function createMemoryRepository(db, recall = null) {
  const insert = db.prepare(`
    INSERT INTO memory_entries
      (id, thread_id, kind, status, content, source_message_id,
       source_invocation_id, created_by, created_at, superseded_by)
    VALUES
      (@id, @threadId, @kind, @status, @content, @sourceMessageId,
       @sourceInvocationId, @createdBy, @createdAt, @supersededBy)
  `);
  const findById = db.prepare("SELECT * FROM memory_entries WHERE id = ?");
  const listByThread = db.prepare(`
    SELECT * FROM memory_entries
    WHERE thread_id = ?
    ORDER BY created_at ASC
  `);
  const transition = db.prepare(`
    UPDATE memory_entries SET status = ?, superseded_by = ? WHERE id = ?
  `);

  return {
    create(input) {
      return db.transaction(() => {
        insert.run({
          id: requiredString(input.id, "memory id"),
          threadId: requiredString(input.threadId, "thread id"),
          kind: requiredString(input.kind, "memory kind"),
          status: input.status || "captured",
          content: requiredString(input.content, "memory content"),
          sourceMessageId: nullableString(input.sourceMessageId),
          sourceInvocationId: nullableString(input.sourceInvocationId),
          createdBy: requiredString(input.createdBy, "memory creator"),
          createdAt: input.createdAt || new Date().toISOString(),
          supersededBy: nullableString(input.supersededBy),
        });
        const memory = this.get(input.id);
        indexMemory(recall, memory);
        return memory;
      })();
    },

    get(id) {
      return mapMemory(findById.get(id));
    },

    listForThread(threadId) {
      return listByThread.all(threadId).map(mapMemory);
    },

    transition(id, status, supersededBy = null) {
      return db.transaction(() => {
        const changed = transition.run(status, nullableString(supersededBy), id).changes > 0;
        if (changed) indexMemory(recall, this.get(id));
        return changed;
      })();
    },
  };
}

function indexMemory(recall, memory) {
  if (!recall || !memory) return;
  recall.upsert({
    threadId: memory.threadId,
    sourceKind: "memory-entry",
    sourceId: memory.id,
    title: `${memory.kind}:${memory.status}`,
    content: memory.content,
    createdAt: memory.createdAt,
    metadata: {
      kind: memory.kind,
      status: memory.status,
      createdBy: memory.createdBy,
      sourceInvocationId: memory.sourceInvocationId,
      sourceMessageId: memory.sourceMessageId,
    },
  });
}

function mapMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    kind: row.kind,
    status: row.status,
    content: row.content,
    sourceMessageId: row.source_message_id,
    sourceInvocationId: row.source_invocation_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    supersededBy: row.superseded_by,
  };
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

module.exports = { createMemoryRepository };
