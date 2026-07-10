const assert = require("node:assert/strict");
const test = require("node:test");

const chatClientModule = require("../public/chat-client.js");

function makeDeps(overrides = {}) {
  const state = {
    currentSessionId: null,
    rightPanelTab: "agents",
    liveInvocations: new Map(),
    liveMessages: new Map(),
    controller: null,
    doneReceived: false,
    projectDir: "",
  };
  const promptEl = {
    value: "",
    disabled: false,
    focused: 0,
    focus() { this.focused += 1; },
  };
  const btnSend = {
    textContent: "发送",
    classList: { add() {}, remove() {} },
  };

  return {
    state,
    promptEl,
    btnSend,
    useWorktreeInput: { checked: false },
    resolvePromptAgent: () => null,
    addSystem() {},
    setStatus() {},
    updateMentionMenu() {},
    sessionApi: { createSession: async () => ({ id: "s1" }) },
    createMessage() {},
    hideMentionMenu() {},
    fetchImpl: async () => { throw new Error("should not fetch"); },
    flushPendingLiveRender() {},
    renderMd: (text) => text,
    sessionController: { loadSessions() {} },
    loadProjectDir() {},
    loadWorktreeStatus() {},
    loadWorkspaceState() {},
    renderSkillTags() {},
    showThinking() {},
    appendLive() {},
    applyAgentEvent() {},
    addDebug() {},
    finishStream() {},
    agentLabel: (id) => id,
    ...overrides,
  };
}

test("parseSse emits complete frames and preserves trailing partial data", () => {
  const client = chatClientModule.createChatClient(makeDeps());
  const seen = [];
  const rest = client.parseSse(
    "event: message\ndata: {\"text\":\"hi\"}\n\npartial",
    (event, data) => seen.push({ event, data })
  );

  assert.deepEqual(seen, [{ event: "message", data: { text: "hi" } }]);
  assert.equal(rest, "partial");
});

test("parseSse supports CRLF frames and multi-line data payloads", () => {
  const client = chatClientModule.createChatClient(makeDeps());
  const seen = [];
  const rest = client.parseSse(
    "event: message\r\ndata: {\"text\":\r\ndata: \"hi\"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n",
    (event, data) => seen.push({ event, data })
  );

  assert.deepEqual(seen, [
    { event: "message", data: { text: "hi" } },
    { event: "done", data: {} },
  ]);
  assert.equal(rest, "");
});

test("handleSseEvent session updates state and reloads session-scoped data", () => {
  const calls = [];
  const deps = makeDeps({
    loadProjectDir(id) { calls.push(["project", id]); },
    loadWorktreeStatus() { calls.push(["worktree"]); },
    loadWorkspaceState() { calls.push(["workspace"]); },
    sessionController: { loadSessions() { calls.push(["sessions"]); } },
  });
  deps.state.rightPanelTab = "workspace";
  const client = chatClientModule.createChatClient(deps);

  client.handleSseEvent("session", { sessionId: "s1" });

  assert.equal(deps.state.currentSessionId, "s1");
  assert.deepEqual(calls, [["sessions"], ["project", "s1"], ["worktree"], ["workspace"]]);
});

test("handleSseEvent routes canonical agent-event frames", () => {
  const seen = [];
  const deps = makeDeps({
    applyAgentEvent(event) {
      seen.push(event.type);
    },
  });
  const client = chatClientModule.createChatClient(deps);

  client.handleSseEvent("agent-event", {
    type: "progress.update",
    agent: "planner",
    invocationId: "inv-1",
    items: [],
  });

  assert.deepEqual(seen, ["progress.update"]);
});

test("sendPrompt rejects missing agent mention before creating a request", async () => {
  const calls = [];
  const deps = makeDeps({
    promptEl: {
      value: "hello",
      disabled: false,
      focused: 0,
      focus() { this.focused += 1; },
    },
    addSystem(text, variant) { calls.push(["system", text, variant]); },
    setStatus(text, variant) { calls.push(["status", text, variant]); },
    updateMentionMenu() { calls.push(["mention"]); },
  });
  const client = chatClientModule.createChatClient(deps);

  await client.sendPrompt();

  assert.deepEqual(calls, [
    ["system", "请先输入 @ 选择一个模型", "error"],
    ["status", "请选择模型", "error"],
    ["mention"],
  ]);
  assert.equal(deps.promptEl.focused, 1);
});
