const assert = require("node:assert/strict");
const test = require("node:test");

const sessionControllerModule = require("../public/session-controller.js");

function makeState() {
  return {
    currentSessionId: null,
    controller: null,
    liveMessages: new Map([["architect", {}]]),
    liveInvocations: new Map([["architect", "inv1"]]),
    rightPanelTab: "workspace",
    worktreeStatus: { branch: "x" },
    workspace: { old: true },
    projectDir: "/tmp/old",
  };
}

test("loadSessions auto-switches to the first session when none is active", async () => {
  const state = makeState();
  const seenMessages = [];
  const deps = {
    state,
    sessionApi: {
      listSessions: async () => [{ id: "s1" }],
      readMessages: async () => [{ role: "user", agent: "architect", content: "hi" }],
    },
    renderSessionList() {},
    addSystem() {},
    ensureSpacer() {},
    showEmpty() {},
    createMessage(msg) { seenMessages.push(msg); },
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
  };

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

test("newSession resets live state and focuses the prompt", async () => {
  const state = makeState();
  let focused = 0;
  const deps = {
    state,
    sessionApi: {
      createSession: async () => ({ id: "s2" }),
    },
    renderSessionList() {},
    addSystem() {},
    ensureSpacer() {},
    showEmpty() {},
    createMessage() {},
    messagesEl: { replaceChildren() {} },
    promptEl: { focus() { focused += 1; } },
    projectDirPath: { textContent: "" },
    closeSidebarIfMobile() {},
    loadProjectDir: async () => {},
    loadWorktreeStatus: async () => {},
    loadWorkspaceState: async () => {},
    renderWorktreeStatus() {},
    renderWorkspacePanel() {},
    emptyWorkspaceState: () => ({ empty: true }),
    setStatus() {},
  };

  const controller = sessionControllerModule.createSessionController(deps);
  await controller.newSession();

  assert.equal(state.currentSessionId, "s2");
  assert.equal(state.liveMessages.size, 0);
  assert.equal(state.liveInvocations.size, 0);
  assert.deepEqual(state.workspace, { empty: true });
  assert.equal(focused, 1);
});

test("deleteSession clears the current session UI state when deleting the active session", async () => {
  const state = makeState();
  state.currentSessionId = "s1";
  let aborted = 0;
  state.controller = { abort() { aborted += 1; } };
  const deps = {
    state,
    sessionApi: {
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
  };

  const controller = sessionControllerModule.createSessionController(deps);
  await controller.deleteSession("s1");

  assert.equal(aborted, 1);
  assert.equal(state.currentSessionId, null);
  assert.equal(state.liveMessages.size, 0);
  assert.equal(state.liveInvocations.size, 0);
  assert.deepEqual(state.workspace, { empty: true });
  assert.equal(deps.projectDirPath.textContent, "(当前目录)");
});
