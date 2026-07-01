const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { AGENTS } = require("../agents/invoke-cli");
const { parseA2AMentions, getMaxA2ADepth } = require("../agents/routing");
const callbacks = require("../agents/callbacks");
const transcript = require("../session/transcript");
const contextHealth = require("../session/health");
const sessionSealer = require("../session/sealer");
const sessionBootstrap = require("../session/bootstrap");
const worktreeManagerModule = require("../worktree/manager");

const ROOT = path.resolve(__dirname, "../..");
const SKILLS_DIR = path.join(ROOT, "skills");
const DEFAULT_PORT = Number(process.env.PORT || 8787);
// Git root of the chat app itself — used to detect self-modification
// (when projectDir points at this repo, we can preview modified code).
const SELF_GIT_ROOT = (() => {
  try { return worktreeManagerModule.ensureGitRoot(__dirname); }
  catch { return null; }
})();

// Track all worktree managers so preview servers can be cleaned up on exit.
const _previewManagers = new Set();
process.on("exit", () => {
  for (const mgr of _previewManagers) {
    try { mgr.stopAllPreviews(); } catch {}
  }
});
const DEFAULT_SESSIONS_FILE = path.join(ROOT, ".invoke-chat-sessions.json");
const DEFAULT_INVOCATIONS_FILE = path.join(ROOT, ".invoke-chat-invocations.json");
const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_SERVER_TIMEOUT_MS = 30 * 60 * 1000; // 30 min, mirrors invoke-cli default

/**
 * READONLY mode rule: injected into the agent prompt when worktree is not enabled.
 * This makes the worktree toggle an effective permission gate:
 *   - worktree on  → agent runs in isolated directory, can write files
 *   - worktree off → agent is told it's in read-only mode, must not write
 */
const READONLY_MODE_RULE = [
  "",
  "<!-- ═══════════════════════════════════════════════════════════ -->",
  "<!-- WORKTREE MODE: OFF (只读模式)                                  -->",
  "<!-- 当前未开启改代码模式，你处于只读模式。                          -->",
  "<!-- 禁止执行以下操作:                                              -->",
  "<!--   - write  / 创建新文件                                       -->",
  "<!--   - edit  / 修改现有文件                                      -->",
  "<!--   - bash  / 执行任何会产生文件副作用的命令                      -->",
  "<!-- 你可以: 查看代码、搜索、分析、回答问题、制定方案。              -->",
  "<!-- 如果需要修改代码，请告知用户: 请先开启改代码模式（勾选 worktree    -->",
  "<!-- 复选框），然后我会帮你实现。                                    -->",
  "<!-- ═══════════════════════════════════════════════════════════ -->",
  "",
].join("\n");

// ── Session map: per-chat-session agent → CLI session ID ──────
// Server manages session persistence across agent invocations within
// the same chat session. Each agent gets its own CLI session that
// survives across A2A handoffs, so agent internal memory (tool calls,
// file reads, exploration) is preserved on subsequent turns.
// Session IDs are opaque strings — the server doesn't care about format.

function getSessionMapPath(chatSessionId) {
  return path.join(ROOT, ".cat-cafe", sanitizeDir(chatSessionId), "sessions.json");
}

function sanitizeDir(id) {
  return (id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

function readSessionMap(chatSessionId) {
  const file = getSessionMapPath(chatSessionId);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// Active invocations per session. Used to prevent concurrent runs on the same
// session and to let new requests abort stale ones.
const activeInvocations = new Map();

// ── Skill loader ──────────────────────────────────────────────

/**
 * Parse YAML-like frontmatter from a markdown file.
 * Returns { meta: {}, body: "..." } or null if no frontmatter found.
 */
function parseSkillFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const rawMeta = match[1];
  const body = match[2].trim();
  const meta = {};
  let currentArrayKey = null;

  for (const line of rawMeta.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // YAML list item: "- value" or "- "value""
    if (trimmed.startsWith("- ") && currentArrayKey) {
      const item = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
      meta[currentArrayKey].push(item);
      continue;
    }

    // Key-only (start of a YAML list block): "key:"
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    // Key with no value → might start a YAML list block
    if (value === "") {
      meta[key] = [];
      currentArrayKey = key;
      continue;
    }

    // Key with value → reset list context
    currentArrayKey = null;

    // Boolean
    if (value === "true") { meta[key] = true; continue; }
    if (value === "false") { meta[key] = false; continue; }

    // JSON-style array: [item1, item2]
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1);
      meta[key] = inner
        ? inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
        : [];
      continue;
    }

    // String (strip optional quotes)
    meta[key] = value.replace(/^["']|["']$/g, "");
  }

  return { meta, body };
}

/**
 * Load all skill files from the skills directory.
 * Returns an array of { name, description, triggers, always, body }.
 */
function loadSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];

  const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  const skills = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(skillsDir, file), "utf8");
    const parsed = parseSkillFrontmatter(content);
    if (!parsed) continue;

    skills.push({
      name: parsed.meta.name || file.replace(".md", ""),
      description: parsed.meta.description || "",
      triggers: parsed.meta.triggers || [],
      always: parsed.meta.always === true,
      body: parsed.body,
    });
  }

  return skills;
}

/**
 * Match skills against a user prompt.
 * Returns skills whose triggers appear in the prompt, plus always-on skills.
 */
function matchSkills(prompt, skills) {
  const lowerPrompt = prompt.toLowerCase();
  const matched = [];

  for (const skill of skills) {
    if (skill.always) {
      matched.push(skill);
      continue;
    }

    for (const trigger of skill.triggers) {
      if (lowerPrompt.includes(trigger.toLowerCase())) {
        matched.push(skill);
        break;
      }
    }
  }

  return matched;
}

/**
 * Build an augmented prompt by prepending matched skill content as system instructions.
 * The skill content is wrapped in a clearly delineated block so the CLI tool
 * sees it as part of the user message, NOT as a CLI-native skill.
 *
 * This is the ISOLATION key: skills are plain text injected into the prompt,
 * never written to codex/opencode skill directories.
 */
function buildAugmentedPrompt(userPrompt, matchedSkills) {
  if (matchedSkills.length === 0) return { augmentedPrompt: userPrompt, skillNames: [] };

  const skillBlocks = matchedSkills.map((skill) => {
    return `<!-- APPLICATION SKILL: ${skill.name} -->\n${skill.body}`;
  });

  const header = [
    "<!-- ═══════════════════════════════════════════════════════════ -->",
    "<!-- 以下为应用层注入的元规则（System-level Meta-rules）           -->",
    "<!-- 这些不是 CLI 工具的原生 Skill，而是作为系统指令的一部分       -->",
    "<!-- 请严格遵循以下规则，它们针对 AI 常见弱点设计                  -->",
    "<!-- ═══════════════════════════════════════════════════════════ -->",
    "",
  ].join("\n");

  const augmentedPrompt = header + "\n" + skillBlocks.join("\n\n") + "\n\n---\n\n" + userPrompt;
  const skillNames = matchedSkills.map((s) => s.name);

  return { augmentedPrompt, skillNames };
}

/**
 * Load skills once at server start, then match + augment per request.
 */
let _skillsCache = null;
function getSkills() {
  if (!_skillsCache) _skillsCache = loadSkills(SKILLS_DIR);
  return _skillsCache;
}

function augmentPrompt(rawPrompt, useWorktree = true) {
  const skills = getSkills();
  const matched = matchSkills(rawPrompt, skills);
  const result = buildAugmentedPrompt(rawPrompt, matched);
  if (!useWorktree) {
    result.augmentedPrompt = READONLY_MODE_RULE + "\n" + result.augmentedPrompt;
  }
  return result;
}

// ── Public helpers ────────────────────────────────────────────

function publicSkills() {
  return getSkills().map((s) => ({
    name: s.name,
    description: s.description,
    triggers: s.triggers,
    always: s.always,
  }));
}

function publicAgents() {
  return Object.values(AGENTS).map((agent) => ({
    id: agent.id,
    label: agent.label,
    cli: agent.name,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort || "",
  }));
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Session store ─────────────────────────────────────────────

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readSessions(sessionsFile) {
  if (!fs.existsSync(sessionsFile)) return { sessions: {}, lastSessionId: null };

  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
    // Migrate old flat-messages format
    if (Array.isArray(parsed.messages) && !parsed.sessions) {
      const migratedId = generateId();
      return {
        sessions: { [migratedId]: { id: migratedId, title: "Migrated", createdAt: new Date().toISOString(), messages: parsed.messages } },
        lastSessionId: migratedId,
      };
    }
    return {
      sessions: parsed.sessions || {},
      lastSessionId: parsed.lastSessionId || null,
    };
  } catch {
    return { sessions: {}, lastSessionId: null };
  }
}

function writeSessions(sessionsFile, data) {
  fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
  const tempFile = `${sessionsFile}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, sessionsFile);
}

function createSession(sessionsFile) {
  const data = readSessions(sessionsFile);
  const id = generateId();
  const session = { id, title: "", createdAt: new Date().toISOString(), messages: [], worktree: null };
  data.sessions[id] = session;
  data.lastSessionId = id;
  writeSessions(sessionsFile, data);
  return session;
}

function listSessions(sessionsFile) {
  const data = readSessions(sessionsFile);
  return Object.values(data.sessions)
    .map(({ id, title, createdAt, messages }) => ({
      id,
      title: title || "(空对话)",
      createdAt,
      messageCount: Array.isArray(messages) ? messages.length : 0,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getSession(sessionsFile, sessionId) {
  const data = readSessions(sessionsFile);
  return data.sessions[sessionId] || null;
}

function ensureSession(sessionsFile, sessionId) {
  const data = readSessions(sessionsFile);
  let session = data.sessions[sessionId];
  if (!session) {
    session = { id: sessionId, title: "", createdAt: new Date().toISOString(), messages: [], worktree: null };
    data.sessions[sessionId] = session;
    data.lastSessionId = sessionId;
    writeSessions(sessionsFile, data);
  }
  return session;
}

function setSessionWorktree(sessionsFile, sessionId, worktree) {
  const data = readSessions(sessionsFile);
  const session = data.sessions[sessionId];
  if (!session) return null;
  session.worktree = worktree || null;
  data.lastSessionId = sessionId;
  writeSessions(sessionsFile, data);
  return session;
}

function deleteSession(sessionsFile, sessionId) {
  const data = readSessions(sessionsFile);
  if (!data.sessions[sessionId]) return false;
  delete data.sessions[sessionId];
  if (data.lastSessionId === sessionId) {
    const remaining = Object.keys(data.sessions);
    data.lastSessionId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }
  writeSessions(sessionsFile, data);
  return true;
}

function appendToSession(sessionsFile, sessionId, message) {
  const data = readSessions(sessionsFile);
  let session = data.sessions[sessionId];

  // Auto-create session if it doesn't exist
  if (!session) {
    session = { id: sessionId, title: "", createdAt: new Date().toISOString(), messages: [] };
    data.sessions[sessionId] = session;
  }

  const msg = {
    id: generateId(),
    createdAt: new Date().toISOString(),
    ...message,
  };
  session.messages.push(msg);

  // Auto-title from first user message
  if (!session.title && message.role === "user" && message.content) {
    session.title = message.content.slice(0, 40).replace(/\n/g, " ");
  }

  data.lastSessionId = sessionId;
  writeSessions(sessionsFile, data);
  return session;
}

// ── Invocation event store ────────────────────────────────────
//
// Each agent run inside /api chat is recorded as an "invocation" with a
// chronological list of events (invocation-start, stdout, stderr,
// invocation-end). This is the data source for the "memory/回忆" panel:
// the frontend (and agents, mid-run) can list, search and replay the
// execution trace of any invocation in the session.
//
// Records live in an in-memory Map per server instance (loaded from disk at
// startup, flushed to disk when an invocation finalises). Event records are
// kept lightweight so they can be streamed back in bulk.

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
    events: record.events.slice(start, start + lim),
    total: record.events.length,
    from: start,
    limit: lim,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 256 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function serveIndex(res) {
  const indexPath = path.join(ROOT, "index.html");
  fs.readFile(indexPath, (error, content) => {
    if (error) {
      sendJson(res, 500, { error: error.message });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(content);
  });
}

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
};

function serveStatic(res, relativePath, rootDir) {
  const safe = path.normalize(relativePath).replace(/^([\\/]\.\.)+/, "");
  const filePath = path.join(rootDir, safe);
  const resolvedRoot = path.resolve(rootDir);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedRoot + path.sep) && resolvedFile !== resolvedRoot) {
    sendJson(res, 403, { error: "Forbidden." });
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      sendJson(res, 404, { error: "Not found." });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = STATIC_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function buildInvokeArgs(body, augmentedPrompt) {
  const agent = typeof body.agent === "string" ? body.agent : "architect";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  if (!AGENTS[agent]) {
    throw new Error(`Unsupported agent "${agent}".`);
  }

  if (!prompt) {
    throw new Error("Prompt is required.");
  }

  const finalPrompt = augmentedPrompt || prompt;
  const args = ["src/agents/invoke-cli.js", "--agent", agent];
  args.push(finalPrompt);
  return args;
}

function buildChatArgs(agent, prompt, augmentedPrompt) {
  return buildInvokeArgs({ agent, prompt }, augmentedPrompt);
}

function runChildStream({ spawnRunner, args, res, cwd, onStdout, onStderr, onHealth, shouldStop, killGraceMs, signal, timeoutMs, env }) {
  const graceMs = killGraceMs || DEFAULT_KILL_GRACE_MS;
  const workDir = cwd || ROOT;
  const serverTimeoutMs = timeoutMs || DEFAULT_SERVER_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawnRunner(process.execPath, args, {
      cwd: workDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let closed = false;
    let killTimer;
    let lastActivity = Date.now();

    const stopChild = (reason) => {
      if (closed) return;
      if (reason) console.error(reason);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, graceMs);
    };

    const markActivity = () => {
      lastActivity = Date.now();
    };

    const abortHandler = () => {
      stopChild("Invocation aborted by client or session conflict.");
    };

    const onResClose = () => {
      // The response closed; stop the child. The upstream controller (if any)
      // is responsible for firing its own abort event.
      stopChild("Client disconnected.");
    };

    if (signal) {
      if (signal.aborted) {
        stopChild();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    res.once("close", onResClose);

    // Server-side safety net: even if invoke-cli is stuck, kill the child
    // if neither stdout nor stderr has produced data for too long.
    const activityTimer = setInterval(() => {
      if (closed) return;
      if (Date.now() - lastActivity > serverTimeoutMs) {
        stopChild(`Server timeout: no stdout/stderr activity for ${serverTimeoutMs}ms.`);
      }
    }, Math.max(1000, Math.floor(serverTimeoutMs / 10)));

    child.stdout.on("data", (chunk) => {
      markActivity();
      if (shouldStop && shouldStop()) {
        stopChild("Stop requested by caller (context sealed).");
        return;
      }
      const text = chunk.toString();
      onStdout(text);
      if (onHealth) onHealth(text.length);
    });

    child.stderr.on("data", (chunk) => {
      markActivity();
      if (shouldStop && shouldStop()) {
        stopChild("Stop requested by caller (context sealed).");
        return;
      }
      onStderr(chunk.toString());
    });

    child.on("error", (error) => {
      sendSse(res, "error", { message: error.message });
    });

    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(killTimer);
      clearInterval(activityTimer);
      if (signal) {
        try { signal.removeEventListener("abort", abortHandler); } catch { /* ignore */ }
      }
      res.removeListener("close", onResClose);
      resolve({ code, signal });
    });
  });
}

function filterBenignStderr(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed === "Reading additional input from stdin...") return false;
      if (/^\d{4}-\d{2}-\d{2}T.*\bWARN codex_core_plugins::manifest: ignoring /.test(trimmed)) return false;
      if (/^\d{4}-\d{2}-\d{2}T.*\bWARN codex_core_skills::loader: ignoring /.test(trimmed)) return false;
      if (/^\d{4}-\d{2}-\d{2}T.*\bWARN codex_core::shell_snapshot: Failed to create shell snapshot for powershell/.test(trimmed)) return false;
      return true;
    })
    .join("\n");
}

function createServer(options = {}) {
  const spawnRunner = options.spawnRunner || spawn;
  const sessionsFile = options.sessionsFile || DEFAULT_SESSIONS_FILE;
  const worktreeManager = options.worktreeManager || worktreeManagerModule.createWorktreeManager({ rootDir: ROOT });
  const invocationsFile = options.invocationsFile || DEFAULT_INVOCATIONS_FILE;
  _previewManagers.add(worktreeManager);
  let projectDir = ROOT;

  // Per-instance invocation event registry. Loaded from disk at startup so
  // that recall works across server restarts; updated as agents run and
  // flushed to disk whenever an invocation finalises.
  const invocationEvents = new Map();
  for (const [id, record] of Object.entries(readInvocationsFile(invocationsFile))) {
    if (record && record.invocationId && record.sessionId) {
      invocationEvents.set(id, record);
    }
  }

  function persistInvocations() {
    try {
      const obj = {};
      for (const [id, record] of invocationEvents) obj[id] = record;
      writeInvocationsFile(invocationsFile, obj);
    } catch (error) {
      console.error("Failed to persist invocations:", error.message);
    }
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/") {
      serveIndex(res);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      const relative = url.pathname.slice("/public".length);
      serveStatic(res, relative, path.join(ROOT, "public"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agents") {
      sendJson(res, 200, { agents: publicAgents() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/messages") {
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) {
        const session = getSession(sessionsFile, sessionId);
        if (!session) { sendJson(res, 404, { error: "Session not found." }); return; }
        sendJson(res, 200, { messages: session.messages });
      } else {
        // Default: return messages of the most recent session
        const sessions = listSessions(sessionsFile);
        if (sessions.length === 0) { sendJson(res, 200, { messages: [] }); return; }
        const session = getSession(sessionsFile, sessions[0].id);
        sendJson(res, 200, { messages: session ? session.messages : [] });
      }
      return;
    }

    // ── Session CRUD ─────────────────────────────────────────

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      sendJson(res, 200, { sessions: listSessions(sessionsFile) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const session = createSession(sessionsFile);
      sendJson(res, 201, { session });
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];

      if (req.method === "GET") {
        const session = getSession(sessionsFile, sessionId);
        if (!session) { sendJson(res, 404, { error: "Session not found." }); return; }
        sendJson(res, 200, { session });
        return;
      }

      if (req.method === "DELETE") {
        const deleted = deleteSession(sessionsFile, sessionId);
        if (!deleted) { sendJson(res, 404, { error: "Session not found." }); return; }
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    const worktreeMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/worktree\/(status|diff|discard)$/);
    if (worktreeMatch) {
      const sessionId = worktreeMatch[1];
      const action = worktreeMatch[2];
      const session = getSession(sessionsFile, sessionId);
      if (!session) { sendJson(res, 404, { error: "Session not found." }); return; }

      try {
        if (req.method === "GET" && action === "status") {
          sendJson(res, 200, worktreeManager.getStatus(sessionId));
          return;
        }
        if (req.method === "GET" && action === "diff") {
          sendJson(res, 200, { sessionId, diff: worktreeManager.getDiff(sessionId) });
          return;
        }
        if (req.method === "POST" && action === "discard") {
          const result = worktreeManager.discardWorktree(sessionId);
          setSessionWorktree(sessionsFile, sessionId, null);
          sendJson(res, 200, result);
          return;
        }
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/skills") {
      const prompt = url.searchParams.get("prompt") || "";
      const skills = getSkills();
      const matched = prompt ? matchSkills(prompt, skills) : [];
      sendJson(res, 200, {
        skills: publicSkills(),
        active: matched.map((s) => s.name),
      });
      return;
    }

    // ── MCP-style HTTP callbacks ─────────────────────────────

    if (req.method === "POST" && url.pathname === "/api/callbacks/post-message") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }

      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const invocationId = typeof body.invocationId === "string" ? body.invocationId : "";
      const callbackToken = typeof body.callbackToken === "string" ? body.callbackToken : "";
      const content = typeof body.content === "string" ? body.content : "";

      if (!sessionId || !invocationId || !callbackToken) {
        sendJson(res, 400, { error: "sessionId, invocationId, and callbackToken are required." });
        return;
      }

      if (!callbacks.validateToken(sessionId, invocationId, callbackToken)) {
        sendJson(res, 401, { error: "Invalid callback token." });
        return;
      }

      const ok = callbacks.postMessage(sessionId, invocationId, content, {
        appendToSession,
      });

      if (!ok) {
        sendJson(res, 410, { error: "Thread no longer active; message was not delivered." });
        return;
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/callbacks/thread-context") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const invocationId = url.searchParams.get("invocationId") || "";
      const callbackToken = req.headers["x-callback-token"] || "";

      if (!sessionId || !invocationId || !callbackToken) {
        sendJson(res, 400, { error: "sessionId, invocationId, and X-Callback-Token are required." });
        return;
      }

      if (!callbacks.validateToken(sessionId, invocationId, callbackToken)) {
        sendJson(res, 401, { error: "Invalid callback token." });
        return;
      }

      const session = getSession(sessionsFile, sessionId);
      if (!session) {
        sendJson(res, 404, { error: "Session not found." });
        return;
      }

      sendJson(res, 200, { messages: session.messages || [] });
      return;
    }

    // ── Recall routes (memory/回忆) ───────────────────────────
    // Read-only invocation history. Usable by the frontend (no token) and by
    // agents mid-run (token validated when present). This is the data source
    // for the expandable memory panel: list who ran what, search across all
    // invocations, and replay a single invocation's event stream.

    if (req.method === "GET" && url.pathname === "/api/callbacks/list-invocations") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const invocationId = url.searchParams.get("invocationId") || "";
      const callbackToken = req.headers["x-callback-token"] || "";

      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required." });
        return;
      }

      // If an agent supplies credentials, validate them; the frontend calls
      // without credentials and is allowed because these reads are read-only.
      if (invocationId || callbackToken) {
        if (!invocationId || !callbackToken) {
          sendJson(res, 400, { error: "invocationId and X-Callback-Token must be provided together." });
          return;
        }
        if (!callbacks.validateToken(sessionId, invocationId, callbackToken)) {
          sendJson(res, 401, { error: "Invalid callback token." });
          return;
        }
      }

      const invocations = await transcript.listInvocationsWithMeta(sessionId);
      sendJson(res, 200, { invocations });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/callbacks/session-search") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const invocationId = url.searchParams.get("invocationId") || "";
      const callbackToken = req.headers["x-callback-token"] || "";
      const query = url.searchParams.get("query") || "";
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 20)) : 20;

      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required." });
        return;
      }
      if (!query) {
        sendJson(res, 400, { error: "query is required." });
        return;
      }

      if (invocationId || callbackToken) {
        if (!invocationId || !callbackToken) {
          sendJson(res, 400, { error: "invocationId and X-Callback-Token must be provided together." });
          return;
        }
        if (!callbacks.validateToken(sessionId, invocationId, callbackToken)) {
          sendJson(res, 401, { error: "Invalid callback token." });
          return;
        }
      }

      const hits = await transcript.searchTranscript(sessionId, query, { limit });
      sendJson(res, 200, { hits, query, limit });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/callbacks/read-invocation") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const invocationId = url.searchParams.get("invocationId") || "";
      const targetInvocationId = url.searchParams.get("targetInvocationId") || "";
      const callbackToken = req.headers["x-callback-token"] || "";
      const fromRaw = url.searchParams.get("from");
      const limitRaw = url.searchParams.get("limit");
      const from = fromRaw ? Math.max(0, parseInt(fromRaw, 10) || 0) : 0;
      const limit = limitRaw ? Math.max(1, Math.min(2000, parseInt(limitRaw, 10) || 200)) : 200;

      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required." });
        return;
      }
      if (!targetInvocationId) {
        sendJson(res, 400, { error: "targetInvocationId is required." });
        return;
      }

      if (invocationId || callbackToken) {
        if (!invocationId || !callbackToken) {
          sendJson(res, 400, { error: "invocationId and X-Callback-Token must be provided together." });
          return;
        }
        if (!callbacks.validateToken(sessionId, invocationId, callbackToken)) {
          sendJson(res, 401, { error: "Invalid callback token." });
          return;
        }
      }

      const result = await transcript.readInvocationPage(sessionId, targetInvocationId, { from, limit });
      if (result.total === 0) {
        sendJson(res, 404, { error: "Invocation not found." });
        return;
      }
      sendJson(res, 200, { invocationId: targetInvocationId, ...result });
      return;
    }

    // ── Project directory ────────────────────────────────────

    if (req.method === "GET" && url.pathname === "/api/project") {
      sendJson(res, 200, { dir: projectDir });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/project") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }

      const dir = typeof body.dir === "string" ? body.dir.trim() : "";
      if (!dir) {
        sendJson(res, 400, { error: "dir is required." });
        return;
      }

      const resolved = path.resolve(dir);
      if (!fs.existsSync(resolved)) {
        sendJson(res, 400, { error: `Directory not found: ${resolved}` });
        return;
      }

      if (!fs.statSync(resolved).isDirectory()) {
        sendJson(res, 400, { error: `Not a directory: ${resolved}` });
        return;
      }

      projectDir = resolved;
      sendJson(res, 200, { dir: projectDir });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/invoke") {
      let args;
      try {
        const body = await readJsonBody(req);
        const rawPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        const { augmentedPrompt } = augmentPrompt(rawPrompt);
        args = buildInvokeArgs(body, augmentedPrompt);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });

      const killGraceMs = options.killGraceMs;

      runChildStream({
        spawnRunner,
        args,
        res,
        cwd: projectDir,
        killGraceMs,
        onStdout(text) {
          sendSse(res, "stdout", { text });
        },
        onStderr(text) {
          sendSse(res, "stderr", { text });
        },
      }).then(({ code, signal }) => {
        sendSse(res, "exit", { code, signal });
        res.end();
      });

      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }

      const requestedAgent = typeof body.agent === "string" ? body.agent : "architect";
      const rawPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      const useWorktree = body.useWorktree === true;
      let sessionId = typeof body.sessionId === "string" ? body.sessionId : null;

      // Update project directory if provided
      if (typeof body.projectDir === "string" && body.projectDir.trim()) {
        const dir = path.resolve(body.projectDir.trim());
        if (!fs.existsSync(dir)) {
          sendJson(res, 400, { error: `Directory not found: ${dir}` });
          return;
        }
        if (!fs.statSync(dir).isDirectory()) {
          sendJson(res, 400, { error: `Not a directory: ${dir}` });
          return;
        }
        projectDir = dir;
      }

      if (!AGENTS[requestedAgent]) {
        sendJson(res, 400, { error: `Unsupported agent "${requestedAgent}".` });
        return;
      }

      if (!rawPrompt) {
        sendJson(res, 400, { error: "Prompt is required." });
        return;
      }

      // Auto-create session if none provided
      if (!sessionId) {
        const session = createSession(sessionsFile);
        sessionId = session.id;
      }

      let session = ensureSession(sessionsFile, sessionId);

      let sessionWorktree = session.worktree;
      if (useWorktree && !sessionWorktree) {
        try {
          sessionWorktree = worktreeManager.ensureWorktree({ baseDir: projectDir, sessionId });
          session = setSessionWorktree(sessionsFile, sessionId, sessionWorktree);
        } catch (error) {
          sendJson(res, 400, { error: error.message });
          return;
        }
      }

      // Self-modification preview: if the agent is editing THIS project,
      // spawn a preview server in the worktree on a unique port.
      // Skip if we're already inside a preview server (prevent recursion).
      if (useWorktree && sessionWorktree && !sessionWorktree.previewPid && !process.env.CAT_CAFE_PREVIEW) {
        let targetGitRoot = null;
        try { targetGitRoot = worktreeManagerModule.ensureGitRoot(projectDir); }
        catch { targetGitRoot = null; }
        if (targetGitRoot && targetGitRoot === SELF_GIT_ROOT) {
          try {
            sessionWorktree = await worktreeManager.startPreview(sessionId);
            session = setSessionWorktree(sessionsFile, sessionId, sessionWorktree);
          } catch (error) {
            console.warn("Preview server failed to start:", error.message);
          }
        }
      }

      const runWorkspace = sessionWorktree || {
        sessionId,
        baseDir: projectDir,
        worktreeDir: projectDir,
        branch: "",
      };

      // Per-session concurrency guard: abort any previous invocation on this
      // session before starting a new one.
      const existing = activeInvocations.get(sessionId);
      if (existing) {
        existing.abort();
      }
      const invocationController = new AbortController();
      activeInvocations.set(sessionId, invocationController);

      // Augment prompt with matched application skills.
      // Pass useWorktree: when off, inject a read-only mode rule.
      const { augmentedPrompt, skillNames } = augmentPrompt(rawPrompt, useWorktree);

      // Callback URL for this request. Agents will use it to post messages
      // back to the chat room while they are still executing.
      const protocol = req.headers["x-forwarded-proto"] || "http";
      const apiUrl = process.env.CAT_CAFE_API_URL || `${protocol}://${req.headers.host}`;
      const callbackInstructions = callbacks.buildCallbackInstructions(apiUrl, sessionId);

      const worklist = [requestedAgent];
      const maxDepth = getMaxA2ADepth();

      appendToSession(sessionsFile, sessionId, {
        role: "user",
        agent: requestedAgent,
        content: rawPrompt,
        augmentedPrompt,
        activeSkills: skillNames,
      });
      // User prompt transcript is recorded against a synthetic "user" invocation
      // so it's searchable as part of the session's permanent record.
      transcript.appendEvent(sessionId, "_user_prompt", "user-prompt", {
        agent: requestedAgent,
        content: rawPrompt,
        activeSkills: skillNames,
      });

      // Build the bootstrap packet: identity + digest + recall rule. This is
      // prepended to the skills-augmented prompt so the first agent in this
      // session starts with full context (who it is, what's been done, how to
      // look things up). A2A-routed agents (i > 0) get the handoff block
      // instead, so the bootstrap is only injected once per chat.
      const bootstrapPacket = await sessionBootstrap.buildBootstrapPacket({
        threadId: sessionId,
        sessionId,
        agent: AGENTS[requestedAgent],
      });
      const augmentedPromptWithBootstrap = bootstrapPacket + "\n" + augmentedPrompt;

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });

      // If the client disconnects (e.g. Stop button), abort the entire A2A chain.
      res.once("close", () => {
        invocationController.abort();
      });

      // Inform frontend of session id and skills
      sendSse(res, "session", { sessionId });
      sendSse(res, "skills-active", { skills: skillNames });

      // A2A worklist loop — dynamic array, agents can @mention each other
      // Pattern from cat-cafe-tutorials lesson 04: routeSerial.
      // The thread context is shared with HTTP callbacks so that an agent can
      // post a message mid-execution and enqueue new agents into the worklist.
      const a2aHistory = []; // [{ agent, content }]
      let aborted = false;
      // Context health tracking — per-chat, cumulative across A2A invocations.
      // Single tracker so the sealer sees the running total of input + output.
      const healthTracker = contextHealth.makeTracker(requestedAgent);
      const sealer = sessionSealer.makeSealer();
      const threadCtx = {
        // threadId is stamped by registerThread; include sessionId explicitly
        // so postMessage persists to the right session file.
        sessionId,
        res,
        worklist,
        controller: invocationController,
        a2aCount: 0,
        sessionsFile,
        tokens: new Map(),
        // Stamped per-iteration so callbacks can attribute their transcript
        // events to the invocation that triggered them.
        currentInvocationId: null,
        sealer,
      };
      callbacks.registerThread(sessionId, threadCtx);

      try {
        for (let i = 0; i < worklist.length && threadCtx.a2aCount < maxDepth; i++) {
          if (invocationController.signal.aborted || res.destroyed || res.writableEnded) {
            aborted = true;
            break;
          }
          if (sealer.isSealed()) {
            // A previous invocation triggered the action threshold; stop the chain.
            sendSse(res, "sealed", { reason: "context overflow", ratio: healthTracker.getFillRatio() });
            aborted = true;
            break;
          }

          const agent = worklist[i];
          // Read this agent's saved CLI session from the per-chat map.
          // If present → resume; absent → cold start (handled by invoke-cli.js).
          const sessionMap = readSessionMap(sessionId);
          const resumeSessionId = sessionMap[agent]?.sessionId || "";
          let assistantContent = "";
          let contextWarned = false;
          let contextSealedSseSent = false;

          // Create per-invocation credentials for MCP-style HTTP callbacks.
          const { invocationId, callbackToken } = callbacks.createInvocation(sessionId, agent);

          // Register the invocation event record so the recall panel can
          // list/search/replay this run. invocation-start is the first event.
          invocationEvents.set(invocationId, {
            invocationId,
            sessionId,
            agent,
            startedAt: new Date().toISOString(),
            endedAt: null,
            state: "active",
            events: [
              {
                ts: new Date().toISOString(),
                kind: "invocation-start",
                payload: { agent, resumeSessionId: resumeSessionId || null },
              },
            ],
          });
          sendSse(res, "agent-start", { agent, invocationId });

          // Build prompt: A2A-routed agents get prior context
          let agentPrompt;
          if (i === 0) {
            agentPrompt = rawPrompt;
          } else {
            // Include previous agent's output as context for the handoff
            const prev = a2aHistory[a2aHistory.length - 1];
            const prevLabel = AGENTS[prev.agent]?.label || prev.agent;
            const prevBlock = prev.content.slice(-4000); // Last 4k chars to avoid blowup
            agentPrompt = [
              `[任务交接：由 ${prevLabel} 转交给你]`,
              "",
              `=== ${prevLabel} 的完整分析 ===`,
              prevBlock,
              "",
              "=== 用户原始请求 ===",
              rawPrompt,
              "",
              "请根据上述上下文继续执行任务。",
            ].join("\n");
          }

          // Inject callback instructions so the agent can speak mid-execution.
          const promptForAgent = (i === 0 ? augmentedPromptWithBootstrap : agentPrompt)
            + "\n\n" + callbackInstructions;

          // Charge the full prompt (what the CLI actually sees) to the
          // cumulative tracker before the CLI process starts. This includes
          // skills body, callback instructions, and any A2A handoff block.
          healthTracker.addInput(promptForAgent.length);
          threadCtx.currentInvocationId = invocationId;
          const invocationEnv = {
            CAT_CAFE_API_URL: apiUrl,
            CAT_CAFE_THREAD_ID: sessionId,
            CAT_CAFE_INVOCATION_ID: invocationId,
            CAT_CAFE_CALLBACK_TOKEN: callbackToken,
            CAT_CAFE_WORKTREE: sessionWorktree ? "1" : "0",
            CAT_CAFE_BASE_DIR: runWorkspace.baseDir,
            CAT_CAFE_WORKTREE_DIR: runWorkspace.worktreeDir,
            CAT_CAFE_BRANCH: runWorkspace.branch || "",
            // Agent session persistence: server manages CLI session IDs
            // per (chatSessionId, agentId). invoke-cli.js reads these to
            // resume or cold start.
            INVOKE_SESSION_ID: resumeSessionId,
            INVOKE_SESSION_FILE: getSessionMapPath(sessionId),
          };

          transcript.appendEvent(sessionId, invocationId, "invocation-start", {
            agent,
            resumeSessionId: resumeSessionId || null,
            promptBytes: promptForAgent.length,
            fillRatioAtStart: healthTracker.getFillRatio(),
          });

          const args = buildChatArgs(agent, agentPrompt, promptForAgent);
          const killGraceMs = options.killGraceMs;
          const timeoutMs = options.timeoutMs;

          const { code, signal } = await runChildStream({
            spawnRunner,
            args,
            res,
            cwd: runWorkspace.worktreeDir,
            killGraceMs,
            timeoutMs,
            signal: invocationController.signal,
            env: invocationEnv,
            onStdout(text) {
              assistantContent += text;
              transcript.appendEvent(sessionId, invocationId, "stdout", { agent, text });
              recordInvocationEvent(invocationEvents, invocationId, "stdout", { text });
              sendSse(res, "message", { agent, role: "assistant", text });
            },
            onStderr(text) {
              transcript.appendEvent(sessionId, invocationId, "stderr", { agent, text });
              recordInvocationEvent(invocationEvents, invocationId, "stderr", { text });
              const visible = filterBenignStderr(text);
              if (visible) sendSse(res, "stderr", { agent, text: visible });
            },
            onHealth(charCount) {
              healthTracker.addOutput(charCount);
              const ratio = healthTracker.getFillRatio();
              const state = sealer.update(ratio);
              if (state === sessionSealer.STATE.SEALING && !contextWarned) {
                sendSse(res, "context-warning", { agent, ratio, threshold: sealer.thresholds.warn });
                contextWarned = true;
              } else if (state === sessionSealer.STATE.SEALED && !contextSealedSseSent) {
                sendSse(res, "sealed", { agent, ratio, reason: "context overflow" });
                contextSealedSseSent = true;
              }
            },
            shouldStop: () => sealer.isSealed(),
          });

          // Finalise the invocation event record regardless of outcome, so the
          // recall panel can show completed/aborted state and persist to disk.
          finalizeInvocationEvent(invocationEvents, invocationId, code, signal);
          persistInvocations();

          // Client disconnected or session was aborted while this agent ran.
          if (invocationController.signal.aborted || res.destroyed || res.writableEnded) {
            aborted = true;
            break;
          }

          appendToSession(sessionsFile, sessionId, {
            role: "assistant",
            agent,
            content: assistantContent,
            exitCode: code,
            signal,
            invocationId,
          });
          transcript.appendEvent(sessionId, invocationId, "invocation-end", {
            agent,
            code,
            signal,
            contentBytes: assistantContent.length,
            fillRatioAtEnd: healthTracker.getFillRatio(),
            sealerState: sealer.getState(),
          });
          sendSse(res, "agent-exit", { agent, code, signal, invocationId });

          // Record for A2A context
          a2aHistory.push({ agent, content: assistantContent });

          // If this invocation pushed us into sealed, stop the chain here so
          // we don't spawn more agents on top of a full context.
          if (sealer.isSealed()) {
            aborted = true;
            break;
          }

          // Check for @mentions after agent finishes
          // Only check if there's still depth budget left
          if (threadCtx.a2aCount < maxDepth) {
            const mentions = parseA2AMentions(assistantContent, agent);
            for (const m of mentions) {
              // Don't re-add if already in worklist (prevents duplicate work)
              if (!worklist.includes(m)) {
                worklist.push(m);
                threadCtx.a2aCount += 1;
                sendSse(res, "a2a-route", { from: agent, to: m });
                transcript.appendEvent(sessionId, invocationId, "a2a-route", {
                  from: agent,
                  to: m,
                });
              }
            }
          }
        }
      } finally {
        if (activeInvocations.get(sessionId) === invocationController) {
          activeInvocations.delete(sessionId);
        }
        if (callbacks.getThread(sessionId) === threadCtx) {
          callbacks.unregisterThread(sessionId);
        }
      }

      // Wait for any pending transcript writes to flush before returning so
      // subsequent GET /api/callbacks/session-search calls see the full record.
      await transcript.flush();
      threadCtx.currentInvocationId = null;
      if (!aborted) {
        sendSse(res, "done", {});
      }
      res.end();
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(DEFAULT_PORT, "127.0.0.1", () => {
    console.log(`Invoke UI listening at http://127.0.0.1:${DEFAULT_PORT}`);
  });
}

module.exports = {
  createServer,
  publicAgents,
  publicSkills,
  loadSkills,
  matchSkills,
  augmentPrompt,
  parseSkillFrontmatter,
  buildAugmentedPrompt,
  // Session store
  readSessions,
  writeSessions,
  createSession,
  ensureSession,
  listSessions,
  getSession,
  setSessionWorktree,
  deleteSession,
  appendToSession,
  // Invocation event store
  readInvocationsFile,
  writeInvocationsFile,
  recordInvocationEvent,
  finalizeInvocationEvent,
  listInvocationsFromMap,
  searchInvocationsInMap,
  readInvocationFromMap,
};
