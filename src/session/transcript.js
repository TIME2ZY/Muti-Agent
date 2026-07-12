const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_TRANSCRIPT_DIR } = require("../shared/runtime-paths");
const { isValidOpaqueId, resolveInside } = require("../server/id-policy");
const MAX_LINE_BYTES = 256 * 1024;

// Single global write queue. Serializing all appends through one chain
// eliminates mkdir/appendFile race conditions on Windows where two
// concurrent mkdir(recursive:true) calls on the same path can collide.
let writeChain = Promise.resolve();

function getTranscriptDir() {
  return process.env.CAT_CAFE_TRANSCRIPT_DIR || DEFAULT_TRANSCRIPT_DIR;
}

function setTranscriptDir(dir) {
  process.env.CAT_CAFE_TRANSCRIPT_DIR = dir;
}

function sanitizeId(id) {
  return isValidOpaqueId(id) ? id : "_invalid";
}

function getInvocationPath(sessionId, invocationId) {
  return resolveInside(
    getTranscriptDir(),
    sanitizeId(sessionId),
    "invocations",
    `${sanitizeId(invocationId)}.jsonl`
  );
}

function getSessionDir(sessionId) {
  return resolveInside(getTranscriptDir(), sanitizeId(sessionId));
}

function deleteSessionData(sessionId) {
  if (!sessionId) return;
  fs.rmSync(getSessionDir(sessionId), { recursive: true, force: true });
}

function enqueueWrite(filePath, content) {
  const next = writeChain
    .then(() => fs.promises.mkdir(path.dirname(filePath), { recursive: true }))
    .then(() => fs.promises.appendFile(filePath, content, "utf8"))
    .catch((err) => {
      console.error(`[transcript] write failed for ${filePath}: ${err.message}`);
    });
  writeChain = next;
  return next;
}

function truncatePayload(event, maxBytes) {
  const text = event.payload && typeof event.payload.text === "string"
    ? event.payload.text
    : null;
  return {
    ...event,
    payload: {
      _truncated: true,
      _originalBytes: JSON.stringify(event).length,
      ...(text !== null ? { text: text.slice(0, Math.max(0, maxBytes - 400)) } : {}),
    },
  };
}

function appendEvent(sessionId, invocationId, kind, payload) {
  if (!isValidOpaqueId(sessionId) || !isValidOpaqueId(invocationId)) return;
  if (typeof kind !== "string" || !kind) return;

  let event = {
    ts: new Date().toISOString(),
    kind,
    payload: payload || {},
  };
  let line = JSON.stringify(event);
  if (line.length > MAX_LINE_BYTES) {
    event = truncatePayload(event, MAX_LINE_BYTES);
    line = JSON.stringify(event);
  }
  const filePath = getInvocationPath(sessionId, invocationId);
  enqueueWrite(filePath, line + "\n");
}

async function flush() {
  await writeChain;
}

async function readInvocation(sessionId, invocationId) {
  const filePath = getInvocationPath(sessionId, invocationId);
  if (!fs.existsSync(filePath)) return [];
  const content = await fs.promises.readFile(filePath, "utf8");
  return parseJsonl(content);
}

function parseJsonl(content) {
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event !== null);
}

async function listInvocations(sessionId) {
  const dir = path.join(getSessionDir(sessionId), "invocations");
  if (!fs.existsSync(dir)) return [];
  const files = await fs.promises.readdir(dir);
  return files
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""));
}

// Read a single invocation's metadata (agent, timing, lifecycle state) by scanning
// its first/last events. Returns null if the invocation doesn't exist.
async function readInvocationMeta(sessionId, invocationId) {
  const events = await readInvocation(sessionId, invocationId);
  if (events.length === 0) return null;
  const start = events.find((e) => e.kind === "invocation-start");
  const end = events.find((e) => e.kind === "invocation-end");
  const code = end && end.payload ? end.payload.code : null;
  const signal = end && end.payload ? end.payload.signal : null;
  return {
    invocationId,
    agent: (start && start.payload && start.payload.agent) || "unknown",
    startedAt: (start && start.ts) || null,
    endedAt: (end && end.ts) || null,
    state: end ? (code === 0 ? "completed" : signal ? "aborted" : "failed") : null,
    eventCount: events.length,
  };
}

// List all invocations in a session with metadata. Excludes synthetic
// invocations (id starting with "_", e.g. "_user_prompt") which are chat-level
// events, not real CLI invocations.
async function listInvocationsWithMeta(sessionId) {
  const ids = await listInvocations(sessionId);
  const out = [];
  for (const id of ids) {
    if (id.startsWith("_")) continue;
    const meta = await readInvocationMeta(sessionId, id);
    if (meta) out.push(meta);
  }
  // Newest first
  out.sort((a, b) => {
    const at = a.startedAt || "";
    const bt = b.startedAt || "";
    return bt.localeCompare(at);
  });
  return out;
}

// Paginated read of a single invocation. Returns { events, total }.
async function readInvocationPage(sessionId, invocationId, opts = {}) {
  const { from = 0, limit = 200 } = opts;
  const events = await readInvocation(sessionId, invocationId);
  const total = events.length;
  const sliceEnd = limit > 0 ? Math.min(events.length, from + limit) : events.length;
  return {
    events: events.slice(from, sliceEnd),
    total,
    from,
    limit,
  };
}

function snippet(text, query) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, 200);
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + query.length + 60);
  return (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "");
}

async function searchTranscript(sessionId, query, opts = {}) {
  const { limit = 20 } = opts;
  if (!query || typeof query !== "string") return [];

  const sessionDir = getSessionDir(sessionId);
  const invDir = path.join(sessionDir, "invocations");
  if (!fs.existsSync(invDir)) return [];

  const invocations = await listInvocations(sessionId);
  const results = [];
  for (const invId of invocations) {
    const events = await readInvocation(sessionId, invId);
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const line = JSON.stringify(ev);
      if (line.toLowerCase().includes(query.toLowerCase())) {
        results.push({
          invocationId: invId,
          eventNo: i,
          kind: ev.kind,
          ts: ev.ts,
          snippet: snippet(line, query),
        });
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
}

async function getInvocationStats(sessionId) {
  const invocations = await listInvocations(sessionId);
  const stats = {
    invocationCount: invocations.length,
    totalEvents: 0,
    kinds: {},
    firstTs: null,
    lastTs: null,
  };
  for (const invId of invocations) {
    const events = await readInvocation(sessionId, invId);
    stats.totalEvents += events.length;
    for (const ev of events) {
      stats.kinds[ev.kind] = (stats.kinds[ev.kind] || 0) + 1;
      if (!stats.firstTs || ev.ts < stats.firstTs) stats.firstTs = ev.ts;
      if (!stats.lastTs || ev.ts > stats.lastTs) stats.lastTs = ev.ts;
    }
  }
  return stats;
}

module.exports = {
  appendEvent,
  deleteSessionData,
  readInvocation,
  readInvocationPage,
  readInvocationMeta,
  listInvocations,
  listInvocationsWithMeta,
  searchTranscript,
  getInvocationStats,
  flush,
  getTranscriptDir,
  setTranscriptDir,
  // exposed for tests
  _getInvocationPath: getInvocationPath,
  _sanitizeId: sanitizeId,
};
