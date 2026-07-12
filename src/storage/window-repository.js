function createWindowRepository(db) {
  const insert = db.prepare(`
    INSERT INTO context_windows
      (id, thread_id, agent_id, provider_key, workspace_key, generation,
       provider_session_id, state, capacity_tokens, input_chars, output_chars,
       seal_reason, created_at, sealed_at)
    VALUES
      (@id, @threadId, @agentId, @providerKey, @workspaceKey, @generation,
       @providerSessionId, @state, @capacityTokens, @inputChars, @outputChars,
       @sealReason, @createdAt, @sealedAt)
  `);
  const findById = db.prepare("SELECT * FROM context_windows WHERE id = ?");
  const findOpen = db.prepare(`
    SELECT * FROM context_windows
    WHERE thread_id = ? AND agent_id = ? AND provider_key = ? AND workspace_key = ?
      AND state IN ('active', 'sealing')
    LIMIT 1
  `);
  const listByThread = db.prepare(`
    SELECT * FROM context_windows
    WHERE thread_id = ?
    ORDER BY generation ASC, created_at ASC
  `);
  const bindProvider = db.prepare(`
    UPDATE context_windows
    SET provider_session_id = ?
    WHERE id = ? AND state IN ('active', 'sealing')
  `);
  const addUsage = db.prepare(`
    UPDATE context_windows
    SET input_chars = input_chars + ?, output_chars = output_chars + ?
    WHERE id = ? AND state IN ('active', 'sealing')
  `);

  return {
    create(input) {
      const now = input.createdAt || new Date().toISOString();
      insert.run({
        id: requiredString(input.id, "window id"),
        threadId: requiredString(input.threadId, "thread id"),
        agentId: requiredString(input.agentId, "agent id"),
        providerKey: requiredString(input.providerKey, "provider key"),
        workspaceKey: requiredString(input.workspaceKey, "workspace key"),
        generation: positiveInteger(input.generation, "generation"),
        providerSessionId: nullableString(input.providerSessionId),
        state: input.state || "active",
        capacityTokens: positiveInteger(input.capacityTokens, "capacity tokens"),
        inputChars: nonNegativeInteger(input.inputChars || 0, "input chars"),
        outputChars: nonNegativeInteger(input.outputChars || 0, "output chars"),
        sealReason: nullableString(input.sealReason),
        createdAt: now,
        sealedAt: nullableString(input.sealedAt),
      });
      return this.get(input.id);
    },

    get(id) {
      return mapWindow(findById.get(id));
    },

    getOpen({ threadId, agentId, providerKey, workspaceKey }) {
      return mapWindow(findOpen.get(threadId, agentId, providerKey, workspaceKey));
    },

    listForThread(threadId) {
      return listByThread.all(threadId).map(mapWindow);
    },

    bindProviderSession(id, providerSessionId) {
      return (
        bindProvider.run(requiredString(providerSessionId, "provider session id"), id).changes > 0
      );
    },

    addUsage(id, { inputChars = 0, outputChars = 0 } = {}) {
      const input = nonNegativeInteger(inputChars, "input chars");
      const output = nonNegativeInteger(outputChars, "output chars");
      return addUsage.run(input, output, id).changes > 0;
    },
  };
}

function mapWindow(row) {
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    agentId: row.agent_id,
    providerKey: row.provider_key,
    workspaceKey: row.workspace_key,
    generation: row.generation,
    providerSessionId: row.provider_session_id,
    state: row.state,
    capacityTokens: row.capacity_tokens,
    inputChars: row.input_chars,
    outputChars: row.output_chars,
    sealReason: row.seal_reason,
    createdAt: row.created_at,
    sealedAt: row.sealed_at,
  };
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

module.exports = { createWindowRepository };
