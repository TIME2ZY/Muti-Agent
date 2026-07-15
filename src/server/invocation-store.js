const fs = require("node:fs");
const path = require("node:path");

function readInvocationsFile(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && parsed.invocations && typeof parsed.invocations === "object"
      ? parsed.invocations
      : {};
  } catch {
    return {};
  }
}

function writeInvocationsFile(file, invocations) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify({ invocations }, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, file);
}

function recordInvocationEvent(map, invocationId, kind, payload) {
  const record = map.get(invocationId);
  if (!record) return;
  record.events.push({ ts: new Date().toISOString(), kind, payload: payload || {} });
}

function finalizeInvocationEvent(map, invocationId, code, signal) {
  const record = map.get(invocationId);
  if (!record) return null;
  record.endedAt = new Date().toISOString();
  record.state = code === 0 ? "completed" : signal ? "aborted" : "failed";
  record.events.push({
    ts: record.endedAt,
    kind: "invocation-end",
    payload: { code, signal },
  });
  return record;
}

function listInvocationsFromMap(map, sessionId) {
  const result = [];
  for (const record of map.values()) {
    if (record.sessionId !== sessionId) continue;
    result.push({
      invocationId: record.invocationId,
      agent: record.agent,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      state: record.state,
      eventCount: record.events.length,
    });
  }
  result.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  return result;
}

function searchInvocationsInMap(map, sessionId, query, limit) {
  const q = String(query || "").toLowerCase();
  const max = Math.max(1, Math.min(Number(limit) || 50, 200));
  const hits = [];
  for (const record of map.values()) {
    if (record.sessionId !== sessionId) continue;
    record.events.forEach((evt, idx) => {
      const hay = `${evt.kind} ${JSON.stringify(evt.payload || {})}`.toLowerCase();
      if (q && hay.includes(q)) {
        hits.push({
          invocationId: record.invocationId,
          eventNo: idx,
          kind: evt.kind,
          ts: evt.ts,
          snippet: JSON.stringify(evt.payload || {}).slice(0, 200),
        });
      }
    });
  }
  hits.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  return hits.slice(0, max);
}

function readInvocationFromMap(map, sessionId, invocationId, from, limit) {
  const record = map.get(invocationId);
  if (!record || record.sessionId !== sessionId) return null;
  const start = Math.max(0, Number(from) || 0);
  const lim = Math.max(1, Math.min(Number(limit) || 200, 1000));
  return {
    invocationId: record.invocationId,
    agent: record.agent,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    state: record.state,
    events: record.events.slice(start, start + lim).map((evt, i) =>
      evt && typeof evt === "object" && !Number.isInteger(evt.eventNo)
        ? { ...evt, eventNo: start + i }
        : evt
    ),
    total: record.events.length,
    from: start,
    limit: lim,
  };
}

module.exports = {
  readInvocationsFile,
  writeInvocationsFile,
  recordInvocationEvent,
  finalizeInvocationEvent,
  listInvocationsFromMap,
  searchInvocationsInMap,
  readInvocationFromMap,
};
