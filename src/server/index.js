const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { AGENTS, getAgentModelProfile } = require("../agents/catalog");
const {
  getProviderAdapter,
  collectProviderStartupDiagnostics,
} = require("../agents/providers");
const { parseA2AMentions, getMaxA2ADepth } = require("../agents/routing");
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
const { sendJson, sendSse, readJsonBody } = require("./http-transport");
const { serveIndex, serveStatic } = require("./static-assets");
const { createInvokeArgsBuilder } = require("./invoke-args");
const { createInvocationRegistry } = require("./invocation-registry");
const { runChildStream, filterBenignStderr } = require("./child-stream");
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
const { getSessionMapPath, readSessionMap, deleteSessionMap } = sessionMapStore;
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
  try {
    return worktreeManagerModule.ensureGitRoot(__dirname);
  } catch {
    return null;
  }
})();

// Track all worktree managers so preview servers can be cleaned up on exit.
const _previewManagers = new Set();
process.on("exit", () => {
  for (const mgr of _previewManagers) {
    try {
      mgr.stopAllPreviews();
    } catch {}
  }
});
// ── Public helpers ────────────────────────────────────────────

function publicAgents() {
  return Object.values(AGENTS).map((agent) => {
    const identity = agentIdentity.getIdentity(agent.id);
    const modelProfile = getAgentModelProfile(agent.id);
    const provider = getProviderAdapter(agent.providerId);
    return {
      id: agent.id,
      label: agent.label,
      providerId: agent.providerId,
      cli: agent.providerId,
      model: agent.model,
      modelVendor: modelProfile ? modelProfile.vendorId : "",
      contextTokens: modelProfile ? modelProfile.contextTokens : null,
      capabilities: { ...provider.capabilities },
      reasoningEffort: agent.reasoningEffort || "",
      description: agent.description || "",
      role: identity ? identity.role : "",
      duties: identity ? identity.duties.slice() : [],
      boundaries: identity ? identity.boundaries.slice() : [],
    };
  });
}

function createServer(options = {}) {
  // Surface missing identity packs early so new agents aren't silent no-ops.
  agentIdentity.assertIdentitiesForAgents(Object.keys(AGENTS));
  const uiToken = uiSecurity.createUiToken(options.uiToken);
  const spawnRunner = options.spawnRunner || spawn;
  const sessionsFile = options.sessionsFile || DEFAULT_SESSIONS_FILE;
  const worktreeManager =
    options.worktreeManager ||
    worktreeManagerModule.createWorktreeManager({
      rootDir: ROOT,
      stateFile: DEFAULT_WORKTREE_STATE_FILE,
    });
  const invocationsFile = options.invocationsFile || DEFAULT_INVOCATIONS_FILE;
  const sessionMapRoot = path.resolve(options.sessionMapRoot || DEFAULT_SESSION_MAP_ROOT);
  const activeInvocations = new Map();
  const invocationRegistry = createInvocationRegistry({
    file: invocationsFile,
    readFile: readInvocationsFile,
    writeFile: writeInvocationsFile,
  });
  const { buildInvokeArgs, buildChatArgs } = createInvokeArgsBuilder({
    agents: AGENTS,
  });
  _previewManagers.add(worktreeManager);

  function cleanupSessionRuntime(sessionId) {
    const controller = activeInvocations.get(sessionId);
    if (controller) {
      controller.abort();
      activeInvocations.delete(sessionId);
    }

    const thread = callbacks.getThread(sessionId);
    if (thread) {
      try {
        thread.controller?.abort();
      } catch {}
      callbacks.unregisterThread(sessionId);
    }

    try {
      worktreeManager.discardWorktree(sessionId);
    } catch {}
    deleteSessionMap(sessionId, sessionMapRoot);
    transcript.deleteSessionData(sessionId);
    invocationRegistry.deleteForSession(sessionId);
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
    invocationEvents: invocationRegistry.events,
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
    persistInvocations: invocationRegistry.persist,
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/") {
      serveIndex(res, { indexPath: path.join(ROOT, "index.html"), uiToken, sendJson });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      const relative = url.pathname.slice("/public".length);
      serveStatic(res, relative, path.join(ROOT, "public"), sendJson);
      return;
    }

    if (
      url.pathname.startsWith("/api/") &&
      !uiSecurity.authorizeApiRequest(req, res, url, { uiToken, sendJson })
    ) {
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
    for (const line of collectProviderStartupDiagnostics()) {
      console.log(line);
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
