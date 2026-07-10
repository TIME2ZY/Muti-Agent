const assert = require("node:assert/strict");
const test = require("node:test");

const sessionControllerModule = require("../public/session-controller.js");
const { createRuntimeStore } = require("../public/session-runtime.js");

function makeState(overrides = {}) {
  const runtimeStore = createRuntimeStore();
  return {
    currentSessionId: null,
    selectedAgent: "architect",
    rightPanelTab: "workspace",
    worktreeStatus: { branch: "x" },
    workspace: { old: true },
    projectDir: "/tmp/old",
    ...overrides,
    runtimeStore: overrides.runtimeStore || runtimeStore,
  };
}

function baseDeps(state, extra = {}) {
  return {
    state,
    runtimeStore: state.runtimeStore,
    sessionApi: {
      listSessions: async () => [{ id: "s1" }],
      readMessages: async () => [{ role: "user", agent: "architect", content: "hi" }],
      createSession: async () => ({ id: "s2" }),
      deleteSession: async () => ({ ok: true }),
    },
    renderSessionList() {},
    addSystem() {},
    ensureSpacer() {},
    showEmpty() {},
    createMessage() {},
    messagesEl: { replaceChildren() {} },
    promptEl: { focus() {} },
    projectDirPath: { textContent: "" },
    closeSidebarIfMobile() {},
    loadProjectDir: async () => {},
    loadWorktreeStatus: async () => {},
    loadWorkspaceState: async () => {},
    renderWorktreeStatus() {},
    renderWorkspacePanel() {},
    emptyWorkspaceState: () => ({ empty: true }),
    setStatus() {},
    syncComposerControls() {},
    remountLiveMessages() {},
    ...extra,
  };
}

test("loadSessions auto-switches to the first session when none is active", async () => {
  const state = makeState();
  const seenMessages = [];
  const deps = baseDeps(state, {
    sessionApi: {
      listSessions: async () => [{ id: "s1" }],
      readMessages: async () => [{ role: "user", agent: "architect", content: "hi" }],
    },
    createMessage(msg) { seenMessages.push(msg); },
  });

  const controller = sessionControllerModule.createSessionController(deps);
  await controller.loadSessions();

  assert.equal(state.currentSessionId, "s1");
  assert.deepEqual(seenMessages, [{
    role: "user",
    agent: "architect",
    content: "hi",
    variant: "",
    invocationId: null,
  }]);
});

test("newSession focuses the prompt without clearing other session runtimes", async () => {
  const state = makeState();
  state.runtimeStore.beginRun("s-old", { abort() { throw new Error("should not abort other session"); } });
  let focused = 0;
  const deps = baseDeps(state, {
    promptEl: { focus() { focused += 1; } },
  });

  const controller = sessionControllerModule.createSessionController(deps);
  await controller.newSession();

  assert.equal(state.currentSessionId, "s2");
  assert.equal(state.runtimeStore.getStatus("s-old"), "running");
  assert.deepEqual(state.workspace, { empty: true });
  assert.equal(focused, 1);
});

test("deleteSession aborts only the deleted session runtime", async () => {
  const state = makeState();
  state.currentSessionId = "s1";
  let aborted = 0;
  let otherAborted = 0;
  state.runtimeStore.beginRun("s1", { abort() { aborted += 1; } });
  state.runtimeStore.beginRun("s2", { abort() { otherAborted += 1; } });

  const deps = baseDeps(state);
  const controller = sessionControllerModule.createSessionController(deps);
  await controller.deleteSession("s1");

  assert.equal(aborted, 1);
  assert.equal(otherAborted, 0);
  assert.equal(state.currentSessionId, null);
  assert.equal(state.runtimeStore.get("s1"), null);
  assert.equal(state.runtimeStore.getStatus("s2"), "running");
  assert.deepEqual(state.workspace, { empty: true });
  assert.equal(deps.projectDirPath.textContent, "(当前目录)");
});

test("switchSession does not abort a running previous session", async () => {
  const state = makeState();
  state.currentSessionId = "s1";
  let aborted = 0;
  state.runtimeStore.beginRun("s1", { abort() { aborted += 1; } });
  state.runtimeStore.get("s1").liveMessages.set("architect", {
    rawText: "partial",
    wrapper: { id: "live-node" },
  });

  const remounted = [];
  const deps = baseDeps(state, {
    sessionApi: {
      listSessions: async () => [{ id: "s1" }, { id: "s2" }],
      readMessages: async () => [{ role: "assistant", agent: "architect", content: "history" }],
    },
    remountLiveMessages(id) { remounted.push(id); },
  });

  // Pretend s2 is also running so remount path is exercised when we switch to it.
  state.runtimeStore.beginRun("s2", { abort() {} });
  state.runtimeStore.get("s2").liveMessages.set("planner", {
    rawText: "bg",
    wrapper: { id: "bg-node" },
  });

  const controller = sessionControllerModule.createSessionController(deps);
  await controller.switchSession("s2");

  assert.equal(aborted, 0);
  assert.equal(state.currentSessionId, "s2");
  assert.equal(state.runtimeStore.getStatus("s1"), "running");
  assert.deepEqual(remounted, ["s2"]);
});

test("switchSession ignores stale async loads from an earlier session switch", async () => {
  const state = makeState();
  const seenMessages = [];
  let resolveFirstMessages;
  const firstMessages = new Promise((resolve) => {
    resolveFirstMessages = resolve;
  });
  const deps = baseDeps(state, {
    sessionApi: {
      listSessions: async () => [{ id: "s1" }, { id: "s2" }],
      readMessages: async (id) => {
        if (id === "s1") return firstMessages;
        return [{ role: "assistant", agent: "architect", content: "new" }];
      },
    },
    createMessage(msg) { seenMessages.push([state.currentSessionId, msg.content]); },
  });

  const controller = sessionControllerModule.createSessionController(deps);
  const firstSwitch = controller.switchSession("s1");
  const secondSwitch = controller.switchSession("s2");

  await secondSwitch;
  resolveFirstMessages([{ role: "assistant", agent: "architect", content: "old" }]);
  await firstSwitch;

  assert.equal(state.currentSessionId, "s2");
  assert.deepEqual(seenMessages, [["s2", "new"]]);
});

test("switchSession restores lastAgent from session metadata", async () => {
  const state = makeState({ selectedAgent: "architect" });
  const applied = [];
  const deps = baseDeps(state, {
    sessionApi: {
      listSessions: async () => [{ id: "s1", lastAgent: "planner" }],
      readMessages: async () => [
        { role: "user", agent: "planner", content: "hi" },
        { role: "assistant", agent: "planner", content: "hello" },
      ],
    },
    applySessionAgent(sessionId, lastAgent) {
      applied.push([sessionId, lastAgent]);
    },
  });

  const controller = sessionControllerModule.createSessionController(deps);
  await controller.switchSession("s1");

  assert.deepEqual(applied, [["s1", "planner"]]);
});
