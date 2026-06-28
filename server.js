const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { AGENTS } = require("./invoke-cli");
const { parseA2AMentions, getMaxA2ADepth } = require("./a2a-routing");
const callbacks = require("./callbacks");

const ROOT = __dirname;
const SKILLS_DIR = path.join(ROOT, "skills");
const DEFAULT_PORT = Number(process.env.PORT || 8787);
const DEFAULT_SESSIONS_FILE = path.join(ROOT, ".invoke-chat-sessions.json");
const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_SERVER_TIMEOUT_MS = 30 * 60 * 1000; // 30 min, mirrors invoke-cli default

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

function augmentPrompt(rawPrompt) {
  const skills = getSkills();
  const matched = matchSkills(rawPrompt, skills);
  return buildAugmentedPrompt(rawPrompt, matched);
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
  const session = { id, title: "", createdAt: new Date().toISOString(), messages: [] };
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
  const resume = body.resume === true;

  if (!AGENTS[agent]) {
    throw new Error(`Unsupported agent "${agent}".`);
  }

  if (!prompt) {
    throw new Error("Prompt is required.");
  }

  const finalPrompt = augmentedPrompt || prompt;
  const args = ["invoke-cli.js", "--agent", agent];
  if (resume) args.push("--resume");
  args.push(finalPrompt);
  return args;
}

function buildChatArgs(agent, prompt, resume, augmentedPrompt) {
  return buildInvokeArgs({ agent, prompt, resume }, augmentedPrompt);
}

function runChildStream({ spawnRunner, args, res, cwd, onStdout, onStderr, killGraceMs, signal, timeoutMs, env }) {
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

    // Server-side safety net: even if invoke-cli.js is stuck, kill the child
    // if neither stdout nor stderr has produced data for too long.
    const activityTimer = setInterval(() => {
      if (closed) return;
      if (Date.now() - lastActivity > serverTimeoutMs) {
        stopChild(`Server timeout: no stdout/stderr activity for ${serverTimeoutMs}ms.`);
      }
    }, Math.max(1000, Math.floor(serverTimeoutMs / 10)));

    child.stdout.on("data", (chunk) => {
      markActivity();
      onStdout(chunk.toString());
    });

    child.stderr.on("data", (chunk) => {
      markActivity();
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
  let projectDir = ROOT;

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
      const resume = body.resume === true;
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

      // Per-session concurrency guard: abort any previous invocation on this
      // session before starting a new one.
      const existing = activeInvocations.get(sessionId);
      if (existing) {
        existing.abort();
      }
      const invocationController = new AbortController();
      activeInvocations.set(sessionId, invocationController);

      // Augment prompt with matched application skills
      const { augmentedPrompt, skillNames } = augmentPrompt(rawPrompt);

      // Callback URL for this request. Agents will use it to post messages
      // back to the chat room while they are still executing.
      const protocol = req.headers["x-forwarded-proto"] || "http";
      const apiUrl = process.env.CAT_CAFE_API_URL || `${protocol}://${req.headers.host}`;
      const callbackInstructions = callbacks.buildCallbackInstructions(apiUrl);

      const worklist = [requestedAgent];
      const maxDepth = getMaxA2ADepth();

      appendToSession(sessionsFile, sessionId, {
        role: "user",
        agent: requestedAgent,
        content: rawPrompt,
        augmentedPrompt,
        activeSkills: skillNames,
      });

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
      const threadCtx = {
        res,
        worklist,
        controller: invocationController,
        a2aCount: 0,
        sessionsFile,
        tokens: new Map(),
      };
      callbacks.registerThread(sessionId, threadCtx);

      try {
        for (let i = 0; i < worklist.length && threadCtx.a2aCount < maxDepth; i++) {
          if (invocationController.signal.aborted || res.destroyed || res.writableEnded) {
            aborted = true;
            break;
          }

          const agent = worklist[i];
          // Only the first agent (explicitly requested) gets --resume
          const shouldResume = i === 0 && resume;
          let assistantContent = "";
          sendSse(res, "agent-start", { agent });

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
          const promptForAgent = (i === 0 ? augmentedPrompt : agentPrompt)
            + "\n\n" + callbackInstructions;

          // Create per-invocation credentials for MCP-style HTTP callbacks.
          const { invocationId, callbackToken } = callbacks.createInvocation(sessionId, agent);
          const invocationEnv = {
            CAT_CAFE_API_URL: apiUrl,
            CAT_CAFE_INVOCATION_ID: invocationId,
            CAT_CAFE_CALLBACK_TOKEN: callbackToken,
          };

          const args = buildChatArgs(agent, agentPrompt, shouldResume, promptForAgent);
          const killGraceMs = options.killGraceMs;
          const timeoutMs = options.timeoutMs;
          const { code, signal } = await runChildStream({
            spawnRunner,
            args,
            res,
            cwd: projectDir,
            killGraceMs,
            timeoutMs,
            signal: invocationController.signal,
            env: invocationEnv,
            onStdout(text) {
              assistantContent += text;
              sendSse(res, "message", { agent, role: "assistant", text });
            },
            onStderr(text) {
              const visible = filterBenignStderr(text);
              if (visible) sendSse(res, "stderr", { agent, text: visible });
            },
          });

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
          });
          sendSse(res, "agent-exit", { agent, code, signal });

          // Record for A2A context
          a2aHistory.push({ agent, content: assistantContent });

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
              }
            }
          }
        }
      } finally {
        activeInvocations.delete(sessionId);
        callbacks.unregisterThread(sessionId);
      }

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
  listSessions,
  getSession,
  deleteSession,
  appendToSession,
};
