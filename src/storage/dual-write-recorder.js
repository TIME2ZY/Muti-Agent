const crypto = require("node:crypto");

function createDualWriteRecorder({ storage, logger = console } = {}) {
  const eventSequences = new Map();
  const unavailableInvocations = new Set();
  const invocationThreads = new Map();

  function attempt(operation, work) {
    if (!storage) return null;
    try {
      return work();
    } catch (error) {
      logger.error(`[sqlite-dual-write] ${operation} failed: ${error.message}`);
      return null;
    }
  }

  function mirrorThread(session) {
    if (!session) return null;
    return attempt("mirror thread", () =>
      storage.threads.upsert({
        id: session.id,
        title: session.title || "",
        projectDir: session.projectDir || "",
        lastAgentId: session.lastAgent || null,
        createdAt: session.createdAt,
        updatedAt: new Date().toISOString(),
      })
    );
  }

  function ensureWindow(input) {
    if (!storage) return null;
    mirrorThread(input.session);
    return attempt("ensure context window", () => {
      const coordinate = {
        threadId: input.threadId,
        agentId: input.agentId,
        providerKey: input.providerKey,
        workspaceKey: input.workspaceKey,
      };
      const existing = storage.windows.getOpen(coordinate);
      if (existing) return existing;
      return storage.windows.create({
        id: crypto.randomUUID(),
        ...coordinate,
        generation: 1,
        capacityTokens: input.capacityTokens,
      });
    });
  }

  function mirrorLastMessage(session, context = {}) {
    if (!storage || !session || !Array.isArray(session.messages) || session.messages.length === 0) {
      return null;
    }
    mirrorThread(session);
    return attempt("mirror message", () => {
      const message = session.messages[session.messages.length - 1];
      const invocation = context.invocationId
        ? storage.invocations.get(context.invocationId)
        : null;
      return storage.messages.append({
        id: message.id,
        threadId: session.id,
        windowId: context.windowId || invocation?.windowId || null,
        invocationId: invocation?.id || null,
        sequenceNo: session.messages.length - 1,
        role: message.role || "system",
        agentId: message.agent || null,
        content: typeof message.content === "string" ? message.content : "",
        metadata: durableMessageMetadata(message),
        createdAt: message.createdAt,
      });
    });
  }

  function startInvocation(input) {
    if (!storage) return null;
    const window = ensureWindow(input);
    if (!window) {
      unavailableInvocations.add(input.invocationId);
      return null;
    }
    const invocation = attempt("start invocation", () => {
      const started = storage.transaction(() => {
        if (input.resumeSessionId) {
          storage.windows.bindProviderSession(window.id, input.resumeSessionId);
        }
        const record = storage.invocations.start({
          id: input.invocationId,
          threadId: input.threadId,
          windowId: window.id,
          agentId: input.agentId,
          startedAt: input.startedAt,
        });
        storage.invocations.appendEvent({
          invocationId: input.invocationId,
          sequenceNo: 0,
          kind: "invocation-start",
          payload: {
            agent: input.agentId,
            resumeSessionId: input.resumeSessionId || null,
          },
          createdAt: input.startedAt,
        });
        return record;
      });
      return started;
    });
    if (!invocation) unavailableInvocations.add(input.invocationId);
    else {
      eventSequences.set(input.invocationId, 1);
      invocationThreads.set(input.invocationId, input.threadId);
    }
    return invocation ? { invocation, window } : null;
  }

  function appendInvocationEvent(invocationId, kind, payload) {
    if (!storage || unavailableInvocations.has(invocationId)) return false;
    const result = attempt("append invocation event", () => {
      const sequenceNo = eventSequences.get(invocationId) ?? nextEventSequence(invocationId);
      storage.invocations.appendEvent({ invocationId, sequenceNo, kind, payload });
      eventSequences.set(invocationId, sequenceNo + 1);
      return true;
    });
    return result === true;
  }

  function finishInvocation(invocationId, code, signal) {
    if (!storage || unavailableInvocations.has(invocationId)) return null;
    const state = code === 0 ? "completed" : signal ? "aborted" : "failed";
    const result = attempt("finish invocation", () =>
      storage.transaction(() => {
        const record = storage.invocations.finish(invocationId, {
          state,
          exitCode: code,
          signal,
        });
        if (!record) throw new Error(`Invocation ${invocationId} is not active.`);
        const sequenceNo = eventSequences.get(invocationId) ?? nextEventSequence(invocationId);
        storage.invocations.appendEvent({
          invocationId,
          sequenceNo,
          kind: "invocation-end",
          payload: { code, signal },
          createdAt: record.endedAt,
        });
        return record;
      })
    );
    eventSequences.delete(invocationId);
    unavailableInvocations.delete(invocationId);
    invocationThreads.delete(invocationId);
    return result;
  }

  function bindProviderSession(windowId, providerSessionId) {
    if (!providerSessionId) return false;
    return (
      attempt("bind provider session", () =>
        storage.windows.bindProviderSession(windowId, providerSessionId)
      ) === true
    );
  }

  function addWindowUsage(windowId, usage) {
    return attempt("update window usage", () => storage.windows.addUsage(windowId, usage)) === true;
  }

  function deleteThread(threadId) {
    for (const [invocationId, ownerThreadId] of invocationThreads) {
      if (ownerThreadId !== threadId) continue;
      unavailableInvocations.add(invocationId);
      eventSequences.delete(invocationId);
      invocationThreads.delete(invocationId);
    }
    return attempt("delete thread", () => storage.threads.delete(threadId));
  }

  function close() {
    eventSequences.clear();
    unavailableInvocations.clear();
    invocationThreads.clear();
  }

  function nextEventSequence(invocationId) {
    const row = storage.db
      .prepare(
        "SELECT COALESCE(MAX(sequence_no), -1) + 1 AS sequence_no FROM invocation_events WHERE invocation_id = ?"
      )
      .get(invocationId);
    return row.sequence_no;
  }

  return {
    enabled: Boolean(storage),
    mirrorThread,
    ensureWindow,
    mirrorLastMessage,
    startInvocation,
    appendInvocationEvent,
    finishInvocation,
    bindProviderSession,
    addWindowUsage,
    deleteThread,
    close,
  };
}

function durableMessageMetadata(message) {
  const excluded = new Set(["id", "role", "agent", "content", "createdAt"]);
  const metadata = {};
  for (const [key, value] of Object.entries(message)) {
    if (!excluded.has(key)) metadata[key] = value;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

module.exports = { createDualWriteRecorder, durableMessageMetadata };
