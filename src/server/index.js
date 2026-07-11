const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { AGENTS } = require("../agents/invoke-cli");
const { parseA2AMentions, getMaxA2ADepth } = require("../agents/routing");
const { resolveProxy, resolveProviderProxy } = require("../agents/proxy");
const agentIdentity = require("../agents/identity");
const agentHandoff = require("../agents/handoff");
const callbacks = require("../agents/callbacks");
const transcript = require("../session/transcript");
const contextHealth = require("../session/health");
const sessionSealer = require("../session/sealer");
const sessionBootstrap = require("../session/bootstrap");
const worktreeManagerModule = require("../worktree/manager");
const runtimePaths = require("./runtime-paths");
const sessionStore = require("./session-store");
const sessionMapStore = require("./session-map-store");
const projectDirService = require("./project-dir");
const invocationStore = require("./invocation-store");
const uiSecurity = require("./ui-security");
const sessionRoutes = require("./session-routes");
const callbackRoutes = require("./callback-routes");
const chatRoutes = require("./chat-routes");
const skills = require("./skills");
const {
  ROOT,
  DEFAULT_SESSIONS_FILE,
  DEFAULT_INVOCATIONS_FILE,
  DEFAULT_SESSION_MAP_ROOT,
  DEFAULT_WORKTREE_STATE_FILE,
} = runtimePaths;
const {
  getSkills,
  publicSkills,
  matchSkills,
  loadSkills,
  augmentPrompt,
  parseSkillFrontmatter,
  buildAugmentedPrompt,
} = skills;
const {
  readSessions,
  writeSessions,
  createSession,
  ensureSession,
  listSessions,
  getSession,
  setSessionProjectDir,
  setSessionWorktree,
  deleteSession,
  appendToSession,
} = sessionStore;
const {
  getSessionMapPath,
  readSessionMap,
  deleteSessionMap,
} = sessionMapStore;
const { validateProjectDir } = projectDirService;
const { createSessionRoutes } = sessionRoutes;
const { createCallbackRoutes } = callbackRoutes;
const { createChatRoutes } = chatRoutes;
const {
  readInvocationsFile,
  writeInvocationsFile,
  recordInvocationEvent,
  finalizeInvocationEvent,
  listInvocationsFromMap,
  searchInvocationsInMap,
  readInvocationFromMap,
} = invocationStore;
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
const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_SERVER_TIMEOUT_MS = 30 * 60 * 1000; // 30 min, mirrors invoke-cli default

// ── Session map: per-chat-session agent → CLI session ID ──────
// Server manages session persistence across agent invocations within
// the same chat session. Each agent gets its own CLI session that
// survives across A2A handoffs, so agent internal memory (tool calls,
// file reads, exploration) is preserved on subsequent turns.
// Session IDs are opaque strings — the server doesn't care about format.

// Active invocations per session. Used to prevent concurrent runs on the same
// session and to let new requests abort stale ones.
const activeInvocations = new Map();

// ── Public helpers ────────────────────────────────────────────

function publicAgents() {
  return Object.values(AGENTS).map((agent) => {
    const identity = agentIdentity.getIdentity(agent.id);
    return {
      id: agent.id,
      label: agent.label,
      cli: agent.name,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort || "",
      description: agent.description || "",
      role: identity ? identity.role : "",
      duties: identity ? identity.duties.slice() : [],
      boundaries: identity ? identity.boundaries.slice() : [],
    };
  });
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

function serveIndex(res, uiToken) {
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
    const html = content.toString("utf8").replace("__CAT_CAFE_UI_TOKEN__", uiToken);
    res.end(html);
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
  // Per-provider proxy only. Grok can use GROK_PROXY without forcing --proxy
  // onto codex/opencode. Global INVOKE_CLI_PROXY still applies to all.
  const providerName = (AGENTS[agent] && AGENTS[agent].name) || agent;
  const proxy = resolveProviderProxy(providerName);
  if (proxy) {
    args.push("--proxy", proxy);
  }
  args.push(finalPrompt);
  return args;
}

function buildChatArgs(agent, prompt, augmentedPrompt) {
  return buildInvokeArgs({ agent, prompt }, augmentedPrompt);
}

function runChildStream({ spawnRunner, args, res, cwd, onStdout, onEvent, onStderr, onHealth, shouldStop, killGraceMs, signal, timeoutMs, env }) {
  const graceMs = killGraceMs || DEFAULT_KILL_GRACE_MS;
  const workDir = cwd || ROOT;
  const serverTimeoutMs = timeoutMs || DEFAULT_SERVER_TIMEOUT_MS;

  return new Promise((resolve) => {
    // Pass through GROK_PROXY (Grok-only) and optional global proxy env to the
    // invoke-cli process. Actual HTTP_PROXY injection for the *provider CLI*
    // happens inside invoke-cli based on agent name (so OpenCode is not forced
    // through GROK_PROXY).
    const mergedEnv = { ...process.env, ...(env || {}) };
    const child = spawnRunner(process.execPath, args, {
      cwd: workDir,
      env: mergedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let closed = false;
    let killTimer;
    let lastActivity = Date.now();
    let stdoutBuffer = "";

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
      if (typeof onEvent === "function") {
        stdoutBuffer += text;
        let idx;
        while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, idx).trim();
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          if (!line) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch (error) {
            sendSse(res, "error", { message: `Invalid agent event: ${error.message}` });
            continue;
          }
          onEvent(event);
          if (onHealth && event.type === "text.delta") {
            onHealth(String(event.text || "").length);
          }
        }
        return;
      }
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
  // Surface missing identity packs early so new agents aren't silent no-ops.
  agentIdentity.assertIdentitiesForAgents(Object.keys(AGENTS));
  const uiToken = uiSecurity.createUiToken(options.uiToken);
  const spawnRunner = options.spawnRunner || spawn;
  const sessionsFile = options.sessionsFile || DEFAULT_SESSIONS_FILE;
  const worktreeManager = options.worktreeManager || worktreeManagerModule.createWorktreeManager({
    rootDir: ROOT,
    stateFile: DEFAULT_WORKTREE_STATE_FILE,
  });
  const invocationsFile = options.invocationsFile || DEFAULT_INVOCATIONS_FILE;
  const sessionMapRoot = path.resolve(options.sessionMapRoot || DEFAULT_SESSION_MAP_ROOT);
  _previewManagers.add(worktreeManager);

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

  function deleteInvocationRecordsForSession(sessionId) {
    let changed = false;
    for (const [id, record] of invocationEvents) {
      if (record.sessionId === sessionId) {
        invocationEvents.delete(id);
        changed = true;
      }
    }
    if (changed) persistInvocations();
  }

  function cleanupSessionRuntime(sessionId) {
    const controller = activeInvocations.get(sessionId);
    if (controller) {
      controller.abort();
      activeInvocations.delete(sessionId);
    }

    const thread = callbacks.getThread(sessionId);
    if (thread) {
      try { thread.controller?.abort(); } catch {}
      callbacks.unregisterThread(sessionId);
    }

    try { worktreeManager.discardWorktree(sessionId); } catch {}
    deleteSessionMap(sessionId, sessionMapRoot);
    transcript.deleteSessionData(sessionId);
    deleteInvocationRecordsForSession(sessionId);
  }

  const handleSessionRoutes = createSessionRoutes({
    rootDir: ROOT,
    sessionsFile,
    worktreeManager,
    cleanupSessionRuntime,
    sendJson,
    readJsonBody,
    listSessions,
    createSession,
    getSession,
    deleteSession,
    setSessionWorktree,
    validateProjectDir,
    setSessionProjectDir,
  });
  const handleCallbackRoutes = createCallbackRoutes({
    callbacks,
    transcript,
    appendToSession,
    getSession,
    sessionsFile,
    sendJson,
    readJsonBody,
  });
  const handleChatRoutes = createChatRoutes({
    rootDir: ROOT,
    selfGitRoot: SELF_GIT_ROOT,
    sessionMapRoot,
    invocationEvents,
    options: { ...options, sessionsFile },
    AGENTS,
    callbacks,
    transcript,
    contextHealth,
    sessionSealer,
    sessionBootstrap,
    agentIdentity,
    agentHandoff,
    worktreeManager,
    worktreeManagerModule,
    activeInvocations,
    sendJson,
    sendSse,
    readJsonBody,
    buildInvokeArgs,
    buildChatArgs,
    augmentPrompt,
    getMaxA2ADepth,
    parseA2AMentions,
    filterBenignStderr,
    runChildStream,
    spawnRunner,
    getSession,
    createSession,
    setSessionProjectDir,
    validateProjectDir,
    setSessionWorktree,
    appendToSession,
    getSessionMapPath,
    readSessionMap,
    recordInvocationEvent,
    finalizeInvocationEvent,
    persistInvocations,
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/") {
      serveIndex(res, uiToken);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      const relative = url.pathname.slice("/public".length);
      serveStatic(res, relative, path.join(ROOT, "public"));
      return;
    }

    if (url.pathname.startsWith("/api/") && !uiSecurity.authorizeApiRequest(req, res, url, { uiToken, sendJson })) {
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agents") {
      sendJson(res, 200, { agents: publicAgents() });
      return;
    }

    if (await handleSessionRoutes(req, res, url)) {
      return;
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

    if (await handleCallbackRoutes(req, res, url)) {
      return;
    }

    if (await handleChatRoutes(req, res, url)) {
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(DEFAULT_PORT, "127.0.0.1", () => {
    console.log(`Invoke UI listening at http://127.0.0.1:${DEFAULT_PORT}`);
    const grokProxy = resolveProviderProxy("grok");
    const globalProxy = resolveProxy();
    if (grokProxy && grokProxy !== globalProxy) {
      console.log(`Grok proxy: ${grokProxy} (GROK_PROXY / INVOKE_GROK_PROXY)`);
    }
    if (globalProxy) {
      console.log(`CLI proxy: ${globalProxy} (INVOKE_CLI_PROXY / HTTPS_PROXY / HTTP_PROXY)`);
    } else if (!grokProxy) {
      console.log(
        "CLI proxy: (none) — if Grok hangs, set GROK_PROXY=http://127.0.0.1:7892 (Grok-only) before npm start"
      );
    }
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
