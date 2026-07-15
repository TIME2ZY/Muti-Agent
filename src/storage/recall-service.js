function createRecallService({ storage, transcript, mode = "dual", logger = console } = {}) {
  if (!transcript) throw new Error("Transcript fallback is required.");

  function logSqliteFailure(operation, error) {
    logger.error?.(`[sqlite-recall] ${operation} failed: ${error.message}`);
  }

  /**
   * Run a SQLite branch; on failure return undefined so callers keep the file
   * result. Never treat a DB exception as "empty memory".
   */
  function trySqlite(operation, work) {
    if (!storage) return undefined;
    try {
      return work();
    } catch (error) {
      logSqliteFailure(operation, error);
      return undefined;
    }
  }

  async function tryFile(operation, work, fallback) {
    try {
      return await work();
    } catch (error) {
      logger.error?.(`[file-recall] ${operation} failed: ${error.message}`);
      return fallback;
    }
  }

  async function listInvocationsWithMeta(threadId) {
    const sqliteRecords = trySqlite("list invocations", () =>
      storage.invocations.listForThreadWithMeta(threadId)
    );
    const fileRecords = await tryFile(
      "list invocations",
      () => transcript.listInvocationsWithMeta(threadId),
      []
    );
    if (sqliteRecords === undefined) return fileRecords;

    const mappedSqlite = sqliteRecords.map(invocationFromSqlite);
    const merged = new Map();
    if (mode === "sqlite") {
      for (const record of mappedSqlite) merged.set(record.invocationId, record);
      for (const record of fileRecords) {
        if (!merged.has(record.invocationId)) merged.set(record.invocationId, record);
      }
    } else {
      for (const record of fileRecords) merged.set(record.invocationId, record);
      for (const record of mappedSqlite) {
        const fileRecord = merged.get(record.invocationId);
        if (!fileRecord || record.eventCount >= fileRecord.eventCount) {
          merged.set(record.invocationId, record);
        }
      }
    }
    return [...merged.values()].sort((a, b) =>
      String(b.startedAt || "").localeCompare(a.startedAt || "")
    );
  }

  async function searchTranscript(threadId, query, options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 20, 200));
    const sqliteHits = trySqlite("search transcript", () => {
      if (!storage.recall) return [];
      return (
        storage.recall
          .search(threadId, query, { limit: Math.min(200, limit * 3) })
          // Assistant messages tied to an invocation duplicate text.delta events.
          // Keep standalone user/system messages and curated memories searchable.
          .filter((item) => item.sourceKind !== "message" || !item.metadata?.invocationId)
          .map(recallItemToTranscriptHit)
          .filter(Boolean)
      );
    });
    if (mode === "sqlite" && sqliteHits !== undefined && sqliteHits.length >= limit) {
      return sqliteHits.slice(0, limit);
    }
    const fileHits = await tryFile(
      "search transcript",
      () => transcript.searchTranscript(threadId, query, { limit }),
      []
    );
    if (sqliteHits === undefined) return fileHits;

    const merged = [];
    const seen = new Set();
    const fileHasUserPrompt = fileHits.some((hit) => hit.invocationId === "_user_prompt");
    for (const hit of [...sqliteHits, ...fileHits]) {
      if (fileHasUserPrompt && hit.sourceKind === "message" && hit.kind === "message.user") {
        continue;
      }
      const key =
        hit.sourceKind && hit.sourceKind !== "invocation-event"
          ? `${hit.sourceKind}:${hit.sourceId}`
          : `${hit.invocationId}:${hit.eventNo}:${hit.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hit);
      if (merged.length >= limit) break;
    }
    return merged;
  }

  async function readInvocationPage(threadId, invocationId, options = {}) {
    const sqlitePage = trySqlite("read invocation page", () => {
      const invocation = storage.invocations.get(invocationId);
      if (!invocation || invocation.threadId !== threadId) return null;
      const page = storage.invocations.readEventsPage(invocationId, options);
      const start = Math.max(0, Number(options.from) || 0);
      return {
        ...page,
        events: page.events.map((event, i) => ({
          ts: event.createdAt,
          kind: event.kind,
          payload: event.payload,
          eventNo: Number.isInteger(event.sequenceNo) ? event.sequenceNo : start + i,
        })),
      };
    });
    if (mode === "sqlite" && sqlitePage !== undefined && sqlitePage !== null) return sqlitePage;
    const filePage = await tryFile(
      "read invocation page",
      () => transcript.readInvocationPage(threadId, invocationId, options),
      {
        events: [],
        total: 0,
        from: Math.max(0, Number(options.from) || 0),
        limit: options.limit || 200,
      }
    );
    if (sqlitePage === undefined || sqlitePage === null) return filePage;
    if (sqlitePage.total < filePage.total) return filePage;
    return sqlitePage;
  }

  return { listInvocationsWithMeta, searchTranscript, readInvocationPage };
}

function invocationFromSqlite(record) {
  return {
    invocationId: record.id,
    agent: record.agentId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    // Keep the callback API contract: an in-flight invocation has no
    // terminal state yet, even though SQLite tracks it as "active".
    state: record.state === "active" ? null : record.state,
    eventCount: record.eventCount,
  };
}

function recallItemToTranscriptHit(item) {
  const metadata = item.metadata || {};
  if (item.sourceKind === "invocation-event") {
    if (!metadata.invocationId || !Number.isInteger(metadata.eventNo) || !metadata.kind)
      return null;
    return {
      invocationId: metadata.invocationId,
      eventNo: metadata.eventNo,
      kind: metadata.kind,
      ts: item.createdAt,
      snippet: item.snippet,
      sourceKind: item.sourceKind,
      sourceId: item.sourceId,
    };
  }
  return {
    invocationId: metadata.invocationId || metadata.sourceInvocationId || "",
    eventNo: Number.isInteger(metadata.sequenceNo) ? metadata.sequenceNo : 0,
    kind:
      item.sourceKind === "message"
        ? `message.${metadata.role || "unknown"}`
        : `memory.${metadata.kind || "entry"}`,
    ts: item.createdAt,
    snippet: item.snippet,
    sourceKind: item.sourceKind,
    sourceId: item.sourceId,
  };
}

module.exports = { createRecallService, recallItemToTranscriptHit };
