function createMemoryRepository(db, recall = null) {
  const insert = db.prepare(`
    INSERT INTO memory_entries
      (id, thread_id, kind, status, content, source_message_id,
       source_invocation_id, created_by, created_at, superseded_by,
       metadata_json, window_id, capture_key, supersession_key)
    VALUES
      (@id, @threadId, @kind, @status, @content, @sourceMessageId,
       @sourceInvocationId, @createdBy, @createdAt, @supersededBy,
       @metadataJson, @windowId, @captureKey, @supersessionKey)
  `);
  const findById = db.prepare("SELECT * FROM memory_entries WHERE id = ?");
  const findByCaptureKey = db.prepare(`
    SELECT * FROM memory_entries WHERE thread_id = ? AND capture_key = ? LIMIT 1
  `);
  const listByThread = db.prepare(`
    SELECT * FROM memory_entries
    WHERE thread_id = ?
    ORDER BY created_at ASC
  `);
  const listActiveBySupersessionKey = db.prepare(`
    SELECT * FROM memory_entries
    WHERE thread_id = ? AND supersession_key = ?
      AND status IN ('captured', 'confirmed')
    ORDER BY created_at DESC, id DESC
  `);
  const transition = db.prepare(`
    UPDATE memory_entries
    SET status = @status,
        superseded_by = @supersededBy,
        metadata_json = @metadataJson
    WHERE id = @id
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
          metadataJson: serializeMetadata(input.metadata),
          windowId: nullableString(input.windowId),
          captureKey: nullableString(input.captureKey),
          supersessionKey: nullableString(input.supersessionKey),
        });
        const memory = this.get(input.id);
        indexMemory(recall, memory);
        return memory;
      })();
    },

    get(id) {
      return mapMemory(findById.get(id));
    },

    getByCaptureKey(threadId, captureKey) {
      if (!threadId || !captureKey) return null;
      return mapMemory(findByCaptureKey.get(threadId, captureKey));
    },

    listForThread(threadId) {
      return listByThread.all(threadId).map(mapMemory);
    },

    listActive(threadId, options = {}) {
      const kinds = normalizeKinds(options.kinds);
      const kindClause = kinds.length ? `AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
      const rows = db
        .prepare(
          `
          SELECT * FROM memory_entries
          WHERE thread_id = ? AND status IN ('captured', 'confirmed')
          ${kindClause}
          ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END,
                   created_at DESC,
                   id DESC
          LIMIT ?
        `
        )
        .all(threadId, ...kinds, normalizeLimit(options.limit));
      return rows.map(mapMemory);
    },

    listActiveBySupersessionKey(threadId, supersessionKey) {
      if (!threadId || !supersessionKey) return [];
      return listActiveBySupersessionKey.all(threadId, supersessionKey).map(mapMemory);
    },

    transition(id, status, options = null) {
      return db.transaction(() => {
        const existing = this.get(id);
        if (!existing) return false;
        const normalized = normalizeTransitionOptions(options);
        const metadata =
          normalized.metadata === undefined ? existing.metadata : normalized.metadata;
        const supersededBy =
          normalized.supersededBy === undefined ? existing.supersededBy : normalized.supersededBy;
        const changed =
          transition.run({
            id,
            status: requiredString(status, "memory status"),
            supersededBy: nullableString(supersededBy),
            metadataJson: serializeMetadata(metadata),
          }).changes > 0;
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
    windowId: memory.windowId,
    sourceKind: "memory-entry",
    sourceId: memory.id,
    title: `${memory.kind}:${memory.status}`,
    content: memory.content,
    createdAt: memory.createdAt,
    metadata: {
      ...(memory.metadata && typeof memory.metadata === "object" ? memory.metadata : {}),
      kind: memory.kind,
      status: memory.status,
      createdBy: memory.createdBy,
      sourceInvocationId: memory.sourceInvocationId,
      sourceMessageId: memory.sourceMessageId,
      captureKey: memory.captureKey,
      supersessionKey: memory.supersessionKey,
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
    metadata: parseMetadata(row.metadata_json),
    windowId: row.window_id,
    captureKey: row.capture_key,
    supersessionKey: row.supersession_key,
  };
}

function normalizeTransitionOptions(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      supersededBy: Object.prototype.hasOwnProperty.call(value, "supersededBy")
        ? value.supersededBy
        : undefined,
      metadata: value.metadata,
    };
  }
  return { supersededBy: value, metadata: undefined };
}

function serializeMetadata(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseMetadata(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeKinds(value) {
  return Array.isArray(value) ? value.filter((kind) => typeof kind === "string" && kind) : [];
}

function normalizeLimit(value) {
  const number = Number(value) || 100;
  return Math.max(1, Math.min(Math.floor(number), 1000));
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

module.exports = { createMemoryRepository };
