function createRecallService({ storage, transcript }) {
  if (!transcript) throw new Error("Transcript fallback is required.");

  async function listInvocationsWithMeta(threadId) {
    const fileRecords = await transcript.listInvocationsWithMeta(threadId);
    if (!storage) return fileRecords;

    const merged = new Map(fileRecords.map((record) => [record.invocationId, record]));
    for (const record of storage.invocations.listForThreadWithMeta(threadId)) {
      const sqliteRecord = {
        invocationId: record.id,
        agent: record.agentId,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        // Keep the callback API contract: an in-flight invocation has no
        // terminal state yet, even though SQLite tracks it as "active".
        state: record.state === "active" ? null : record.state,
        eventCount: record.eventCount,
      };
      const fileRecord = merged.get(record.id);
      if (!fileRecord || sqliteRecord.eventCount >= fileRecord.eventCount) {
        merged.set(record.id, sqliteRecord);
      }
    }
    return [...merged.values()].sort((a, b) =>
      String(b.startedAt || "").localeCompare(a.startedAt || "")
    );
  }

  async function searchTranscript(threadId, query, options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 20, 200));
    const fileHits = await transcript.searchTranscript(threadId, query, { limit });
    if (!storage) return fileHits;

    const sqliteHits = storage.recall
      .search(threadId, query, { limit, sourceKinds: ["invocation-event"] })
      .map(recallItemToTranscriptHit)
      .filter(Boolean);
    const merged = [];
    const seen = new Set();
    for (const hit of [...sqliteHits, ...fileHits]) {
      const key = `${hit.invocationId}:${hit.eventNo}:${hit.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hit);
      if (merged.length >= limit) break;
    }
    return merged;
  }

  async function readInvocationPage(threadId, invocationId, options = {}) {
    const filePage = await transcript.readInvocationPage(threadId, invocationId, options);
    if (!storage) return filePage;
    const invocation = storage.invocations.get(invocationId);
    if (!invocation || invocation.threadId !== threadId) return filePage;

    const sqlitePage = storage.invocations.readEventsPage(invocationId, options);
    if (sqlitePage.total < filePage.total) return filePage;
    return {
      ...sqlitePage,
      events: sqlitePage.events.map((event) => ({
        ts: event.createdAt,
        kind: event.kind,
        payload: event.payload,
      })),
    };
  }

  return { listInvocationsWithMeta, searchTranscript, readInvocationPage };
}

function recallItemToTranscriptHit(item) {
  const metadata = item.metadata || {};
  if (!metadata.invocationId || !Number.isInteger(metadata.eventNo) || !metadata.kind) return null;
  return {
    invocationId: metadata.invocationId,
    eventNo: metadata.eventNo,
    kind: metadata.kind,
    ts: item.createdAt,
    snippet: item.snippet,
  };
}

module.exports = { createRecallService, recallItemToTranscriptHit };
