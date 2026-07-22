function createSessionReadService({ mode = "dual", storage, fileStore, logger = console } = {}) {
  if (!fileStore?.getSession || !fileStore?.listSessions) {
    throw new Error("File session store is required.");
  }

  function displayTitle(title) {
    if (!title) return "(空对话)";
    return typeof fileStore.buildSessionTitle === "function"
      ? fileStore.buildSessionTitle(title)
      : title;
  }

  function attempt(operation, work) {
    if (mode !== "sqlite" || !storage) return undefined;
    try {
      return work();
    } catch (error) {
      logger.error?.(`[sqlite-primary-read] ${operation} failed: ${error.message}`);
      return undefined;
    }
  }

  function getSession(file, sessionId) {
    const fileSession = fileStore.getSession(file, sessionId);
    const sqliteSession = attempt("get session", () => {
      const thread = storage.threads.get(sessionId);
      if (!thread) return null;
      const messages = storage.messages.listForThread(sessionId).map(messageFromSqlite);
      const selectedMessages =
        fileSession?.messages?.length > messages.length ? fileSession.messages : messages;
      return {
        ...(fileSession || {}),
        id: thread.id,
        title: thread.title || fileSession?.title || "",
        createdAt: thread.createdAt,
        messages: selectedMessages,
        worktree: fileSession?.worktree || null,
        projectDir: thread.projectDir || fileSession?.projectDir || "",
        lastAgent: thread.lastAgentId || fileSession?.lastAgent || "",
      };
    });
    return sqliteSession === undefined || sqliteSession === null ? fileSession : sqliteSession;
  }

  function listSessions(file) {
    const fileSessions = fileStore.listSessions(file);
    const sqliteSessions = attempt("list sessions", () =>
      storage.threads.listWithMessageCounts().map((thread) => ({
        id: thread.id,
        title: displayTitle(thread.title),
        createdAt: thread.createdAt,
        messageCount: thread.messageCount,
        lastAgent: thread.lastAgentId || "",
      }))
    );
    if (sqliteSessions === undefined) return fileSessions;

    const merged = new Map(fileSessions.map((session) => [session.id, session]));
    for (const session of sqliteSessions) {
      const fileSession = merged.get(session.id);
      if (!fileSession || session.messageCount >= fileSession.messageCount) {
        merged.set(session.id, session);
      }
    }
    return [...merged.values()].sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );
  }

  return { getSession, listSessions };
}

function messageFromSqlite(message) {
  return {
    ...(message.metadata && typeof message.metadata === "object" ? message.metadata : {}),
    id: message.id,
    createdAt: message.createdAt,
    role: message.role,
    agent: message.agentId || undefined,
    content: message.content,
    ...(message.invocationId ? { invocationId: message.invocationId } : {}),
  };
}

module.exports = { createSessionReadService, messageFromSqlite };
