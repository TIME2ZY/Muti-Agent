const crypto = require("node:crypto");

function createDualWriteRecorder({ storage, logger = console } = {}) {
  const eventSequences = new Map();
  const unavailableInvocations = new Set();
  const invocationThreads = new Map();
  /** Thread ids that were deleted during this process — block resurrection. */
  const deletedThreads = new Set();

  function attempt(operation, work) {
    if (!storage) return null;
    try {
      return work();
    } catch (error) {
      logger.error(`[sqlite-dual-write] ${operation} failed: ${error.message}`);
      return null;
    }
  }

  function isThreadWritable(threadId) {
    return threadId && !deletedThreads.has(threadId);
  }

  function mirrorThread(session) {
    if (!session || !isThreadWritable(session.id)) return null;
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
    if (!storage || !isThreadWritable(input.threadId)) return null;
    mirrorThread(input.session);
    return attempt("ensure context window", () => {
      const coordinate = {
        threadId: input.threadId,
        agentId: input.agentId,
        providerKey: input.providerKey,
        workspaceKey: input.workspaceKey,
      };
      const existing = storage.windows.getOpen(coordinate);
      if (existing) {
        // Capacity is fixed at window creation; do not rewrite on re-entry.
        return existing;
      }
      return storage.windows.create({
        id: crypto.randomUUID(),
        ...coordinate,
        generation: storage.windows.nextGeneration(coordinate),
        capacityTokens: input.capacityTokens,
        providerSessionId: null,
      });
    });
  }

  function sealWindow(windowId, reason = "context overflow") {
    if (!storage || !windowId) return null;
    return attempt("seal context window", () =>
      storage.windows.seal(windowId, { reason, sealedAt: new Date().toISOString() })
    );
  }

  /**
   * Seal the open window for a coordinate and open generation N+1 in one
   * transaction. The new window never inherits the sealed provider session.
   */
  function sealAndRotateWindow(input) {
    if (!storage || !isThreadWritable(input.threadId)) return null;
    mirrorThread(input.session);
    return attempt("seal and rotate context window", () =>
      storage.windows.sealAndRotate({
        threadId: input.threadId,
        agentId: input.agentId,
        providerKey: input.providerKey,
        workspaceKey: input.workspaceKey,
        capacityTokens: input.capacityTokens,
        reason: input.reason || "context overflow",
        windowId: input.windowId || null,
        nextId: input.nextId || crypto.randomUUID(),
        sealedAt: input.sealedAt || new Date().toISOString(),
      })
    );
  }

  function mirrorLastMessage(session, context = {}) {
    if (!storage || !session || !isThreadWritable(session.id)) return null;
    if (!Array.isArray(session.messages) || session.messages.length === 0) return null;
    mirrorThread(session);
    const stored = attempt("mirror message", () => {
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
    if (stored) indexMessage(stored);
    return stored;
  }

  function startInvocation(input) {
    if (!storage || !isThreadWritable(input.threadId)) {
      if (input.invocationId) unavailableInvocations.add(input.invocationId);
      return null;
    }
    const window = ensureWindow(input);
    if (!window) {
      unavailableInvocations.add(input.invocationId);
      return null;
    }
    // Only bind resume when the open window already carries that provider
    // session, or when the caller is first-binding mid-window. Never attach a
    // resume id to a brand-new generation that has no provider session yet
    // unless the caller explicitly supplies one for this generation (cold
    // start after seal should pass empty resumeSessionId).
    const resumeSessionId =
      typeof input.resumeSessionId === "string" && input.resumeSessionId
        ? input.resumeSessionId
        : null;
    const invocation = attempt("start invocation", () => {
      const started = storage.transaction(() => {
        if (resumeSessionId) {
          storage.windows.bindProviderSession(window.id, resumeSessionId);
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
            resumeSessionId: resumeSessionId || null,
            windowGeneration: window.generation,
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
      const refreshed = storage.windows.get(window.id) || window;
      indexInvocationEvent({
        invocationId: input.invocationId,
        sequenceNo: 0,
        kind: "invocation-start",
        payload: {
          agent: input.agentId,
          resumeSessionId: resumeSessionId || null,
          windowGeneration: refreshed.generation,
        },
        threadId: input.threadId,
        windowId: refreshed.id,
        agentId: input.agentId,
        createdAt: input.startedAt,
      });
      return { invocation, window: refreshed };
    }
    return null;
  }

  function appendInvocationEvent(invocationId, kind, payload) {
    if (!storage || unavailableInvocations.has(invocationId)) return false;
    const ownerThread = invocationThreads.get(invocationId);
    if (ownerThread && deletedThreads.has(ownerThread)) return false;
    let indexedEvent = null;
    const result = attempt("append invocation event", () => {
      const invocation = storage.invocations.get(invocationId);
      if (!invocation || deletedThreads.has(invocation.threadId)) {
        unavailableInvocations.add(invocationId);
        return false;
      }
      const sequenceNo = eventSequences.get(invocationId) ?? nextEventSequence(invocationId);
      const createdAt = new Date().toISOString();
      storage.invocations.appendEvent({ invocationId, sequenceNo, kind, payload, createdAt });
      eventSequences.set(invocationId, sequenceNo + 1);
      indexedEvent = {
        invocationId,
        sequenceNo,
        kind,
        payload,
        threadId: invocation.threadId,
        windowId: invocation.windowId,
        agentId: invocation.agentId,
        createdAt,
      };
      return true;
    });
    if (indexedEvent) indexInvocationEvent(indexedEvent);
    return result === true;
  }

  function finishInvocation(invocationId, code, signal) {
    if (!storage || unavailableInvocations.has(invocationId)) return null;
    const ownerThread = invocationThreads.get(invocationId);
    if (ownerThread && deletedThreads.has(ownerThread)) return null;
    const state = code === 0 ? "completed" : signal ? "aborted" : "failed";
    let indexedEvent = null;
    const result = attempt("finish invocation", () =>
      storage.transaction(() => {
        const existing = storage.invocations.get(invocationId);
        if (!existing || deletedThreads.has(existing.threadId)) {
          unavailableInvocations.add(invocationId);
          return null;
        }
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
        indexedEvent = {
          invocationId,
          sequenceNo,
          kind: "invocation-end",
          payload: { code, signal },
          threadId: record.threadId,
          windowId: record.windowId,
          agentId: record.agentId,
          createdAt: record.endedAt,
        };
        return record;
      })
    );
    if (indexedEvent) indexInvocationEvent(indexedEvent);
    eventSequences.delete(invocationId);
    unavailableInvocations.delete(invocationId);
    invocationThreads.delete(invocationId);
    return result;
  }

  function bindProviderSession(windowId, providerSessionId) {
    if (!providerSessionId || !windowId) return false;
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
    if (!threadId) return null;
    deletedThreads.add(threadId);
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
    deletedThreads.clear();
  }

  function nextEventSequence(invocationId) {
    const row = storage.db
      .prepare(
        "SELECT COALESCE(MAX(sequence_no), -1) + 1 AS sequence_no FROM invocation_events WHERE invocation_id = ?"
      )
      .get(invocationId);
    return row.sequence_no;
  }

  function indexMessage(message) {
    if (!storage.recall || deletedThreads.has(message.threadId)) return;
    attempt("index message recall", () =>
      storage.recall.upsert({
        threadId: message.threadId,
        windowId: message.windowId,
        sourceKind: "message",
        sourceId: message.id,
        title: `${message.role}${message.agentId ? `:${message.agentId}` : ""}`,
        content: message.content,
        agentId: message.agentId,
        createdAt: message.createdAt,
        metadata: {
          invocationId: message.invocationId,
          sequenceNo: message.sequenceNo,
          role: message.role,
        },
      })
    );
  }

  function indexInvocationEvent(event) {
    if (!storage.recall || deletedThreads.has(event.threadId)) return;
    attempt("index invocation recall", () =>
      storage.recall.upsert({
        threadId: event.threadId,
        windowId: event.windowId,
        sourceKind: "invocation-event",
        sourceId: `${event.invocationId}:${event.sequenceNo}`,
        title: event.kind,
        content: JSON.stringify(event.payload || {}),
        agentId: event.agentId,
        createdAt: event.createdAt,
        metadata: {
          invocationId: event.invocationId,
          eventNo: event.sequenceNo,
          kind: event.kind,
        },
      })
    );
  }

  return {
    enabled: Boolean(storage),
    mirrorThread,
    ensureWindow,
    sealWindow,
    sealAndRotateWindow,
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
