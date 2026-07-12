const ALLOWED_STATES = new Set(["active", "sealing", "sealed"]);

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
  const maxGeneration = db.prepare(`
    SELECT COALESCE(MAX(generation), 0) AS max_generation
    FROM context_windows
    WHERE thread_id = ? AND agent_id = ? AND provider_key = ? AND workspace_key = ?
  `);
  const bindProvider = db.prepare(`
    UPDATE context_windows
    SET provider_session_id = ?
    WHERE id = ? AND state IN ('active', 'sealing')
  `);
  const clearProvider = db.prepare(`
    UPDATE context_windows
    SET provider_session_id = NULL
    WHERE id = ?
  `);
  const addUsage = db.prepare(`
    UPDATE context_windows
    SET input_chars = input_chars + ?, output_chars = output_chars + ?
    WHERE id = ? AND state IN ('active', 'sealing')
  `);
  const markSealing = db.prepare(`
    UPDATE context_windows
    SET state = 'sealing'
    WHERE id = ? AND state = 'active'
  `);
  const sealOpen = db.prepare(`
    UPDATE context_windows
    SET state = 'sealed',
        seal_reason = ?,
        sealed_at = ?,
        provider_session_id = NULL
    WHERE id = ? AND state IN ('active', 'sealing')
  `);

  function coordinateArgs(coordinate) {
    return [
      requiredString(coordinate.threadId, "thread id"),
      requiredString(coordinate.agentId, "agent id"),
      requiredString(coordinate.providerKey, "provider key"),
      requiredString(coordinate.workspaceKey, "workspace key"),
    ];
  }

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
        state: normalizeState(input.state),
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

    nextGeneration(coordinate) {
      const row = maxGeneration.get(...coordinateArgs(coordinate));
      return Number(row?.max_generation || 0) + 1;
    },

    bindProviderSession(id, providerSessionId) {
      return (
        bindProvider.run(requiredString(providerSessionId, "provider session id"), id).changes > 0
      );
    },

    clearProviderSession(id) {
      return clearProvider.run(id).changes > 0;
    },

    addUsage(id, { inputChars = 0, outputChars = 0 } = {}) {
      const input = nonNegativeInteger(inputChars, "input chars");
      const output = nonNegativeInteger(outputChars, "output chars");
      return addUsage.run(input, output, id).changes > 0;
    },

    markSealing(id) {
      return markSealing.run(id).changes > 0;
    },

    /**
     * Seal an open window and abandon its provider session id.
     * Returns the sealed window, or null if it was not open.
     */
    seal(id, { reason = null, sealedAt = null } = {}) {
      const sealedTimestamp = sealedAt || new Date().toISOString();
      const changes = sealOpen.run(nullableString(reason), sealedTimestamp, id).changes;
      if (changes === 0) return null;
      return this.get(id);
    },

    /**
     * Atomically seal the open window for a coordinate (if any) and open the
     * next generation with a clean provider session. Original sealed rows stay.
     */
    sealAndRotate(input) {
      return db.transaction(() => {
        const coordinate = {
          threadId: requiredString(input.threadId, "thread id"),
          agentId: requiredString(input.agentId, "agent id"),
          providerKey: requiredString(input.providerKey, "provider key"),
          workspaceKey: requiredString(input.workspaceKey, "workspace key"),
        };
        const open = this.getOpen(coordinate);
        let sealed = null;
        if (open) {
          sealed = this.seal(open.id, {
            reason: input.reason,
            sealedAt: input.sealedAt,
          });
        } else if (input.windowId) {
          sealed = this.seal(input.windowId, {
            reason: input.reason,
            sealedAt: input.sealedAt,
          });
        }

        const next = this.create({
          id: requiredString(input.nextId, "next window id"),
          ...coordinate,
          generation: this.nextGeneration(coordinate),
          capacityTokens: positiveInteger(input.capacityTokens, "capacity tokens"),
          providerSessionId: null,
          state: "active",
          createdAt: input.createdAt,
        });
        return { sealed, next };
      })();
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

function normalizeState(value) {
  const state = typeof value === "string" && value ? value : "active";
  if (!ALLOWED_STATES.has(state)) {
    throw new Error(`window state must be one of ${[...ALLOWED_STATES].join(", ")}.`);
  }
  return state;
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

module.exports = { createWindowRepository, ALLOWED_STATES };
