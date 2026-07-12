const { withTransaction } = require("./database");

function createInvocationRepository(db) {
  const insertInvocation = db.prepare(`
    INSERT INTO invocations
      (id, thread_id, window_id, agent_id, state, started_at)
    VALUES
      (@id, @threadId, @windowId, @agentId, 'active', @startedAt)
  `);
  const findById = db.prepare("SELECT * FROM invocations WHERE id = ?");
  const listByThread = db.prepare(`
    SELECT * FROM invocations WHERE thread_id = ? ORDER BY started_at ASC
  `);
  const insertEvent = db.prepare(`
    INSERT INTO invocation_events
      (invocation_id, sequence_no, kind, payload_json, created_at)
    VALUES
      (@invocationId, @sequenceNo, @kind, @payloadJson, @createdAt)
  `);
  const listEvents = db.prepare(`
    SELECT * FROM invocation_events
    WHERE invocation_id = ?
    ORDER BY sequence_no ASC
  `);
  const countEvents = db.prepare(
    "SELECT COUNT(*) AS count FROM invocation_events WHERE invocation_id = ?"
  );
  const readEventsPage = db.prepare(`
    SELECT * FROM invocation_events
    WHERE invocation_id = ?
    ORDER BY sequence_no ASC
    LIMIT ? OFFSET ?
  `);
  const listWithMeta = db.prepare(`
    SELECT i.*, COUNT(e.id) AS event_count
    FROM invocations i
    LEFT JOIN invocation_events e ON e.invocation_id = i.id
    WHERE i.thread_id = ?
    GROUP BY i.id
    ORDER BY i.started_at ASC
  `);
  const finalize = db.prepare(`
    UPDATE invocations
    SET state = @state, exit_code = @exitCode, signal = @signal, ended_at = @endedAt
    WHERE id = @id AND state = 'active'
  `);

  return {
    start(input) {
      insertInvocation.run({
        id: requiredString(input.id, "invocation id"),
        threadId: requiredString(input.threadId, "thread id"),
        windowId: requiredString(input.windowId, "window id"),
        agentId: requiredString(input.agentId, "agent id"),
        startedAt: input.startedAt || new Date().toISOString(),
      });
      return this.get(input.id);
    },

    get(id) {
      return mapInvocation(findById.get(id));
    },

    listForThread(threadId) {
      return listByThread.all(threadId).map(mapInvocation);
    },

    listForThreadWithMeta(threadId) {
      return listWithMeta.all(threadId).map((row) => ({
        ...mapInvocation(row),
        eventCount: row.event_count,
      }));
    },

    appendEvent(input) {
      insertEvent.run({
        invocationId: requiredString(input.invocationId, "invocation id"),
        sequenceNo: nonNegativeInteger(input.sequenceNo, "event sequence"),
        kind: requiredString(input.kind, "event kind"),
        payloadJson: JSON.stringify(input.payload || {}),
        createdAt: input.createdAt || new Date().toISOString(),
      });
    },

    listEvents(invocationId) {
      return listEvents.all(invocationId).map(mapEvent);
    },

    readEventsPage(invocationId, { from = 0, limit = 200 } = {}) {
      const start = Math.max(0, Number(from) || 0);
      const size = Math.max(1, Math.min(Number(limit) || 200, 2000));
      return {
        events: readEventsPage.all(invocationId, size, start).map(mapEvent),
        total: countEvents.get(invocationId).count,
        from: start,
        limit: size,
      };
    },

    finish(id, outcome) {
      const state = normalizeTerminalState(outcome.state);
      return withTransaction(db, () => {
        const changed = finalize.run({
          id,
          state,
          exitCode: Number.isInteger(outcome.exitCode) ? outcome.exitCode : null,
          signal: nullableString(outcome.signal),
          endedAt: outcome.endedAt || new Date().toISOString(),
        }).changes;
        return changed > 0 ? mapInvocation(findById.get(id)) : null;
      });
    },
  };
}

function mapInvocation(row) {
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    windowId: row.window_id,
    agentId: row.agent_id,
    state: row.state,
    exitCode: row.exit_code,
    signal: row.signal,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    invocationId: row.invocation_id,
    sequenceNo: row.sequence_no,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  };
}

function normalizeTerminalState(state) {
  if (!["completed", "failed", "aborted"].includes(state)) {
    throw new Error("Invocation terminal state must be completed, failed, or aborted.");
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

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

module.exports = { createInvocationRepository };
