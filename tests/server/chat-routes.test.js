const assert = require("node:assert/strict");
const test = require("node:test");

const chatRoutes = require("../../src/server/chat-routes.js");

function makeReq(method, headers = {}) {
  return { method, headers, once() {} };
}

function makeRes() {
  return {
    statusCode: 0,
    body: null,
    writableEnded: false,
    destroyed: false,
    writeHead() {},
    end() {},
    once() {},
  };
}

function makeSendJson(res) {
  return (response, status, value) => {
    assert.equal(response, res);
    res.statusCode = status;
    res.body = value;
  };
}

function baseDeps(res, overrides = {}) {
  return {
    rootDir: "/root",
    selfGitRoot: null,
    options: {},
    AGENTS: { architect: { id: "architect", label: "Architect" } },
    callbacks: {
      buildCallbackInstructions: () => "",
      registerThread() {},
      getThread: () => null,
      unregisterThread() {},
      createInvocation: () => ({ invocationId: "inv1", callbackToken: "tok" }),
    },
    transcript: {
      appendEvent() {},
      flush: async () => {},
    },
    contextHealth: { makeTracker: () => ({ addInput() {}, addOutput() {}, getFillRatio: () => 0 }) },
    sessionSealer: { makeSealer: () => ({ isSealed: () => false, update: () => "active", getState: () => "active", thresholds: { warn: 0.8 } }) },
    sessionBootstrap: {
      buildBootstrapPacket: async () => "",
      buildIdentity: () => "<!-- Session Identity -->\n",
    },
    agentIdentity: {
      renderIdentityBlock: (agentId) => `<!-- Agent Identity: ${agentId} -->\n`,
    },
    agentHandoff: {
      extractPrimaryHandoff: () => null,
      evaluateHandoff: () => ({
        ok: false,
        degraded: true,
        missing: ["what", "why", "next_action"],
        missingRecommended: [],
        score: 0,
        hasBlock: false,
      }),
      renderHandoffTask: () => "[任务交接]\n",
      summarizeHandoff: () => ({ hasBlock: false, ok: false, degraded: true, score: 0, missing: [] }),
      normalizeTo: (v) => String(v || "").toLowerCase(),
    },
    worktreeManager: {},
    worktreeManagerModule: { ensureGitRoot: () => null },
    activeInvocations: new Map(),
    sendJson: makeSendJson(res),
    sendSse() {},
    readJsonBody: async () => ({}),
    buildInvokeArgs: () => [],
    buildChatArgs: () => [],
    augmentPrompt: () => ({ augmentedPrompt: "", skillNames: [] }),
    getMaxA2ADepth: () => 0,
    parseA2AMentions: () => [],
    filterBenignStderr: (text) => text,
    runChildStream: async () => ({ code: 0, signal: null }),
    getSession: () => ({ worktree: null, projectDir: "/root" }),
    createSession: () => ({ id: "s1" }),
    setSessionProjectDir: () => ({ worktree: null, projectDir: "/root" }),
    validateProjectDir: (dir) => dir,
    setSessionWorktree: () => ({ worktree: null, projectDir: "/root" }),
    appendToSession() {},
    getSessionMapPath: () => "/tmp/session-map.json",
    readSessionMap: () => ({}),
    recordInvocationEvent() {},
    finalizeInvocationEvent() {},
    persistInvocations() {},
    ...overrides,
  };
}

test("handleChatRoutes returns 400 when /api/invoke body parsing fails", async () => {
  const res = makeRes();
  const handle = chatRoutes.createChatRoutes(baseDeps(res, {
    readJsonBody: async () => { throw new Error("bad json"); },
  }));

  const handled = await handle(makeReq("POST"), res, new URL("http://127.0.0.1/api/invoke"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "bad json" });
});

test("handleChatRoutes rejects unsupported agents before starting chat", async () => {
  const res = makeRes();
  const handle = chatRoutes.createChatRoutes(baseDeps(res, {
    readJsonBody: async () => ({ agent: "unknown", prompt: "hi" }),
  }));

  const handled = await handle(makeReq("POST", { host: "127.0.0.1:8787" }), res, new URL("http://127.0.0.1/api/chat"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Unsupported agent "unknown".' });
});
