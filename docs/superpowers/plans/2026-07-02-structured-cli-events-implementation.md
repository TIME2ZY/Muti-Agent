# Structured CLI Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace text-only CLI stream parsing with a normalized `AgentEvent` pipeline that powers structured server events, transcript recall, and invocation-level frontend rendering.

**Architecture:** Keep the existing Node + static frontend app structure, but move provider-specific parsing behind a shared event protocol. `src/agents/invoke-cli.js` becomes a normalized NDJSON event emitter, the server consumes `agent-event` records as the canonical runtime stream, and the frontend renders one structured run card per invocation instead of flattening everything into one assistant text bubble.

**Tech Stack:** Node.js built-in test runner, existing `spawn`-based CLI runtime, JSONL transcript storage, SSE, vanilla JavaScript frontend

---

## File Structure

- Create: `src/agents/event-protocol.js`
  Responsibility: Define helpers for normalized event creation, provider names, and minimal shape validation used by provider transformers and tests.

- Create: `src/agents/providers/index.js`
  Responsibility: Select the correct provider runtime for `codex` and `opencode`.

- Create: `src/agents/providers/codex.js`
  Responsibility: Transform Codex CLI JSON events into normalized `AgentEvent[]`.

- Create: `src/agents/providers/opencode.js`
  Responsibility: Transform OpenCode CLI JSON events into normalized `AgentEvent[]`, including part-based text delta de-duplication.

- Modify: `src/agents/invoke-cli.js`
  Responsibility: Replace plain-text extraction with provider parser/transformer dispatch, persist session IDs, and emit normalized NDJSON events to stdout.

- Modify: `src/server/index.js`
  Responsibility: Upgrade `runChildStream()` from raw text chunk transport to NDJSON event transport.

- Modify: `src/server/chat-routes.js`
  Responsibility: Consume normalized events, broadcast `agent-event`, derive legacy compatibility events, persist semantic transcript events, and keep chat history text-only.

- Modify: `src/session/transcript.js`
  Responsibility: Keep JSONL storage but store semantic event kinds and preserve search/read semantics for structured events.

- Modify: `src/server/invocation-store.js`
  Responsibility: Keep invocation summaries and store structured event metadata without assuming stdout/stderr are the primary event types.

- Modify: `public/chat-client.js`
  Responsibility: Consume `agent-event` as the canonical stream and keep legacy SSE handling during migration.

- Modify: `public/app.js`
  Responsibility: Replace agent-keyed live message state with invocation-keyed run state and render structured sections for text, thinking, progress, tools, commands, file changes, and debug output.

- Modify: `tests/agents/invoke-cli.test.js`
  Responsibility: Lock provider transformation and NDJSON emission behavior.

- Modify: `tests/server.test.js`
  Responsibility: Lock server-side `agent-event` SSE, transcript semantics, and chat-history behavior.

- Modify: `tests/chat-client.test.js`
  Responsibility: Lock client-side `agent-event` parsing and dispatch behavior.

### Task 1: Define the event protocol and provider runtimes

**Files:**
- Create: `src/agents/event-protocol.js`
- Create: `src/agents/providers/index.js`
- Create: `src/agents/providers/codex.js`
- Create: `src/agents/providers/opencode.js`
- Modify: `tests/agents/invoke-cli.test.js`
- Test: `tests/agents/invoke-cli.test.js`

- [ ] **Step 1: Write the failing tests**

```js
const {
  createProviderRuntime,
} = require("../../src/agents/providers");

test("codex runtime maps agent_message and todo_list into normalized events", () => {
  const runtime = createProviderRuntime({ name: "codex", id: "architect", model: "gpt-5.5" });
  const invocationId = "inv-1";

  const started = runtime.transform({
    type: "thread.started",
    thread_id: "codex-session-1",
  }, { invocationId, agent: "architect" });

  const todo = runtime.transform({
    type: "item.completed",
    item: {
      type: "todo_list",
      items: [
        { text: "Inspect parser", done: true },
        { text: "Render timeline", done: false },
      ],
    },
  }, { invocationId, agent: "architect" });

  const text = runtime.transform({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "Hello from Codex",
    },
  }, { invocationId, agent: "architect" });

  assert.equal(started[0].type, "run.started");
  assert.equal(todo[0].type, "progress.update");
  assert.equal(text[0].type, "text.delta");
  assert.equal(text[0].text, "Hello from Codex");
});

test("opencode runtime emits incremental text deltas from repeated parts", () => {
  const runtime = createProviderRuntime({ name: "opencode", id: "planner", model: "mimo-v2.5-pro" });
  const ctx = { invocationId: "inv-2", agent: "planner" };

  const first = runtime.transform({
    type: "message.part.updated",
    part: { id: "p1", type: "text", text: "hello" },
  }, ctx);

  const second = runtime.transform({
    type: "message.part.updated",
    part: { id: "p1", type: "text", text: "hello world" },
  }, ctx);

  assert.deepEqual(first.map((event) => event.text), ["hello"]);
  assert.deepEqual(second.map((event) => event.text), [" world"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "runtime maps|incremental text deltas" tests/agents/invoke-cli.test.js`

Expected: FAIL with `Cannot find module '../../src/agents/providers'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/agents/event-protocol.js
function makeEvent(type, fields) {
  return { type, ...fields };
}

module.exports = { makeEvent };
```

```js
// src/agents/providers/index.js
const { createCodexRuntime } = require("./codex");
const { createOpencodeRuntime } = require("./opencode");

function createProviderRuntime(cli) {
  if (cli.name === "codex") return createCodexRuntime(cli);
  if (cli.name === "opencode") return createOpencodeRuntime(cli);
  throw new Error(`Unsupported provider "${cli.name}"`);
}

module.exports = { createProviderRuntime };
```

```js
// src/agents/providers/codex.js
const { makeEvent } = require("../event-protocol");

function createCodexRuntime(cli) {
  return {
    extractSessionId(event) {
      return event.type === "thread.started" ? event.thread_id || "" : "";
    },
    transform(event, ctx) {
      const base = { agent: ctx.agent, invocationId: ctx.invocationId };
      if (event.type === "thread.started") {
        return [makeEvent("run.started", { ...base, sessionId: event.thread_id || "", provider: cli.name, model: cli.model || "" })];
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        return [makeEvent("text.delta", { ...base, text: event.item.text })];
      }
      if (event.type === "item.completed" && event.item?.type === "todo_list") {
        return [makeEvent("progress.update", { ...base, items: event.item.items || [] })];
      }
      return [];
    },
  };
}

module.exports = { createCodexRuntime };
```

```js
// src/agents/providers/opencode.js
const { makeEvent } = require("../event-protocol");

function createOpencodeRuntime(cli) {
  const parts = new Map();

  return {
    extractSessionId(event) {
      return event.type === "session.updated" ? event.session?.id || "" : "";
    },
    transform(event, ctx) {
      const base = { agent: ctx.agent, invocationId: ctx.invocationId };
      if (event.type === "message.part.updated" && event.part?.type === "text") {
        const id = event.part.id || "_default";
        const next = String(event.part.text || "");
        const prev = parts.get(id) || "";
        parts.set(id, next);
        if (!next.startsWith(prev)) return [makeEvent("text.delta", { ...base, text: next })];
        const delta = next.slice(prev.length);
        return delta ? [makeEvent("text.delta", { ...base, text: delta })] : [];
      }
      return [];
    },
  };
}

module.exports = { createOpencodeRuntime };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern "runtime maps|incremental text deltas" tests/agents/invoke-cli.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/event-protocol.js src/agents/providers/index.js src/agents/providers/codex.js src/agents/providers/opencode.js tests/agents/invoke-cli.test.js
git commit -m "feat: add structured provider runtimes"
```

### Task 2: Make `invoke-cli.js` emit NDJSON `AgentEvent`

**Files:**
- Modify: `src/agents/invoke-cli.js`
- Modify: `tests/agents/invoke-cli.test.js`
- Test: `tests/agents/invoke-cli.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("invoke-cli writes normalized NDJSON events instead of plain assistant text", () => {
  const result = runScript(["hello"]);

  assert.equal(result.status, 0);
  const lines = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(lines[0].type, "run.started");
  assert.equal(lines[1].type, "text.delta");
  assert.equal(lines[1].text.includes("codex:-s danger-full-access"), true);
});

test("invoke-cli persists provider session IDs while emitting NDJSON", () => {
  const result = runScript(["--agent", "orchestrator", "hello"]);

  assert.equal(result.status, 0);
  const events = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "text.delta"));
  const sessionFile = JSON.parse(fs.readFileSync(result.sessionPath, "utf8"));
  assert.equal(sessionFile.orchestrator.sessionId, "opencode-session-1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "normalized NDJSON events|persists provider session IDs while emitting NDJSON" tests/agents/invoke-cli.test.js`

Expected: FAIL because stdout is currently plain text and cannot be parsed as JSON lines.

- [ ] **Step 3: Write minimal implementation**

```js
const { createProviderRuntime } = require("./providers");

function emitEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function invoke(cli, prompt, options = {}) {
  const config = typeof cli === "string" ? { name: cli } : cli;
  const provider = createProviderRuntime(config);
  // existing spawn setup unchanged...

  rl.on("line", (line) => {
    if (!line.trim()) return;

    let rawEvent;
    try {
      rawEvent = JSON.parse(line);
    } catch (error) {
      console.error("Failed to parse JSON line:", line);
      return;
    }

    const sessionId = provider.extractSessionId(rawEvent);
    if (sessionId) persistSessionId(config, sessionId);

    const events = provider.transform(rawEvent, {
      agent: config.id || config.name,
      invocationId: process.env.SHIFT_INVOCATION_ID || "standalone",
    });

    for (const event of events) emitEvent(event);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agents/invoke-cli.test.js`

Expected: PASS for the new NDJSON assertions and existing session persistence tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/invoke-cli.js tests/agents/invoke-cli.test.js
git commit -m "feat: emit structured cli events"
```

### Task 3: Teach the server to consume semantic events and keep chat history text-only

**Files:**
- Modify: `src/server/index.js`
- Modify: `src/server/chat-routes.js`
- Modify: `src/session/transcript.js`
- Modify: `src/server/invocation-store.js`
- Modify: `tests/server.test.js`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("chat endpoint emits canonical agent-event SSE frames", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write(JSON.stringify({ type: "run.started", agent: "planner", invocationId: "inv-1", provider: "opencode" }) + "\n");
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "planner", invocationId: "inv-1", text: "hello " }) + "\n");
          child.stdout.write(JSON.stringify({ type: "progress.update", agent: "planner", invocationId: "inv-1", items: [{ text: "done", done: true }] }) + "\n");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "planner", prompt: "hello" }),
      });
      const text = await response.text();
      assert.match(text, /event: agent-event/);
      assert.match(text, /"type":"text.delta"/);
      assert.match(text, /"type":"progress.update"/);
    }
  );
});

test("chat history stores only assistant text reconstructed from text.delta", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write(JSON.stringify({ type: "run.started", agent: "planner", invocationId: "inv-2", provider: "opencode" }) + "\n");
          child.stdout.write(JSON.stringify({ type: "thinking.delta", agent: "planner", invocationId: "inv-2", text: "inspect" }) + "\n");
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "planner", invocationId: "inv-2", text: "final answer" }) + "\n");
          child.stdout.write(JSON.stringify({ type: "run.finished", agent: "planner", invocationId: "inv-2", exitCode: 0, signal: null }) + "\n");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "planner", prompt: "hello" }),
      });
      const sse = await response.text();
      const sid = sse.match(/"sessionId":"([^"]+)"/)[1];
      const history = await (await fetch(`${baseUrl}/api/messages?sessionId=${sid}`)).json();
      const assistant = history.messages.find((msg) => msg.role === "assistant");
      assert.equal(assistant.content, "final answer");
    }
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "canonical agent-event SSE|stores only assistant text reconstructed" tests/server.test.js`

Expected: FAIL because the server currently expects raw stdout chunks instead of NDJSON events.

- [ ] **Step 3: Write minimal implementation**

```js
// src/server/index.js
function runChildStream({ spawnRunner, args, res, cwd, onEvent, onStderr, onHealth, shouldStop, killGraceMs, signal, timeoutMs, env }) {
  // existing spawn and timer setup...
  let stdoutBuffer = "";

  child.stdout.on("data", (chunk) => {
    markActivity();
    if (shouldStop && shouldStop()) {
      stopChild("Stop requested by caller (context sealed).");
      return;
    }

    stdoutBuffer += chunk.toString();
    let idx;
    while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, idx).trim();
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      onEvent(event);
      if (onHealth && event.type === "text.delta") onHealth(String(event.text || "").length);
    }
  });
}
```

```js
// src/server/chat-routes.js
let assistantContent = "";

const { code, signal } = await runChildStream({
  spawnRunner,
  args: buildChatArgs(agent, agentPrompt, promptForAgent),
  res,
  cwd: runWorkspace.worktreeDir,
  killGraceMs: options.killGraceMs,
  timeoutMs: options.timeoutMs,
  signal: invocationController.signal,
  env: invocationEnv,
  onEvent(event) {
    transcript.appendEvent(sessionId, invocationId, event.type, event);
    recordInvocationEvent(invocationEvents, invocationId, event.type, event);
    sendSse(res, "agent-event", event);

    if (event.type === "text.delta") {
      assistantContent += event.text || "";
      sendSse(res, "message", { agent, role: "assistant", text: event.text || "" });
    }
    if (event.type === "stderr") {
      sendSse(res, "stderr", { agent, text: event.text || "" });
    }
    if (event.type === "run.finished") {
      sendSse(res, "agent-exit", { agent, code: event.exitCode ?? code, signal: event.signal ?? signal, invocationId });
    }
  },
  onStderr(text) {
    const event = { type: "stderr", agent, invocationId, text };
    transcript.appendEvent(sessionId, invocationId, "stderr", event);
    recordInvocationEvent(invocationEvents, invocationId, "stderr", event);
    const visible = filterBenignStderr(text);
    if (visible) sendSse(res, "stderr", { agent, text: visible });
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern "canonical agent-event SSE|stores only assistant text reconstructed" tests/server.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.js src/server/chat-routes.js src/session/transcript.js src/server/invocation-store.js tests/server.test.js
git commit -m "feat: stream semantic agent events through server"
```

### Task 4: Render invocation-level structured run cards in the frontend

**Files:**
- Modify: `public/chat-client.js`
- Modify: `public/app.js`
- Modify: `tests/chat-client.test.js`
- Modify: `tests/server.test.js`
- Test: `tests/chat-client.test.js`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("handleSseEvent routes canonical agent-event frames", () => {
  const seen = [];
  const client = createChatClient({
    state: { currentSessionId: null, rightPanelTab: "agents", liveInvocations: new Map(), liveMessages: new Map(), doneReceived: false },
    promptEl: { value: "", disabled: false, focus() {} },
    btnSend: { textContent: "", classList: { add() {}, remove() {} } },
    useWorktreeInput: { checked: false },
    resolvePromptAgent: () => ({ id: "planner" }),
    addSystem() {},
    setStatus() {},
    updateMentionMenu() {},
    sessionApi: { createSession: async () => ({ id: "s1" }) },
    createMessage() {},
    hideMentionMenu() {},
    fetchImpl: async () => ({}),
    flushPendingLiveRender() {},
    renderMd: (text) => text,
    sessionController: { loadSessions() {} },
    loadProjectDir() {},
    loadWorktreeStatus() {},
    loadWorkspaceState() {},
    renderSkillTags() {},
    showThinking() {},
    appendLive() {},
    addDebug() {},
    finishStream() {},
    agentLabel: (id) => id,
    applyAgentEvent(event) { seen.push(event.type); },
  });

  client.handleSseEvent("agent-event", { type: "progress.update", agent: "planner", invocationId: "inv-1", items: [] });
  assert.deepEqual(seen, ["progress.update"]);
});

test("frontend app.js defines invocation-level live run state and renderer hooks", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /liveRuns:\s*new Map\(\)/);
  assert.match(js, /function applyAgentEvent\(event\)/);
  assert.match(js, /function ensureLiveRun\(event\)/);
  assert.match(js, /progressItems/);
  assert.match(js, /fileChanges/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "canonical agent-event frames|invocation-level live run state" tests/chat-client.test.js tests/server.test.js`

Expected: FAIL because the client has no `agent-event` branch and the app has no invocation-keyed run state.

- [ ] **Step 3: Write minimal implementation**

```js
// public/chat-client.js
function handleSseEvent(event, data) {
  switch (event) {
    case "agent-event":
      applyAgentEvent(data);
      break;
    // legacy branches remain below
  }
}
```

```js
// public/app.js
const state = {
  // existing fields...
  liveRuns: new Map(),
};

function ensureLiveRun(event) {
  const id = event.invocationId;
  if (!state.liveRuns.has(id)) {
    state.liveRuns.set(id, {
      invocationId: id,
      agent: event.agent,
      text: "",
      thinking: "",
      progressItems: [],
      tools: [],
      commands: [],
      fileChanges: [],
      stderr: [],
      status: "thinking",
      messageItem: createMessage({ role: "assistant", agent: event.agent, content: "", invocationId: id }),
    });
  }
  return state.liveRuns.get(id);
}

function applyAgentEvent(event) {
  const run = ensureLiveRun(event);

  if (event.type === "text.delta") {
    run.text += event.text || "";
    run.status = "writing";
    run.messageItem.rawText = run.text;
    appendLive(run.agent, event.text || "");
    return;
  }

  if (event.type === "thinking.delta") {
    run.thinking += event.text || "";
    return;
  }

  if (event.type === "progress.update") {
    run.progressItems = Array.isArray(event.items) ? event.items : [];
    return;
  }

  if (event.type === "file.changed") {
    run.fileChanges.push({ path: event.path, changeType: event.changeType });
    return;
  }

  if (event.type === "run.finished") {
    run.status = event.exitCode === 0 ? "done" : "error";
    finishStream("就绪");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/chat-client.test.js`

Expected: PASS.

Run: `node --test --test-name-pattern "invocation-level live run state" tests/server.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/chat-client.js public/app.js tests/chat-client.test.js tests/server.test.js
git commit -m "feat: render structured invocation events in chat"
```

### Task 5: Surface semantic recall output and run full verification

**Files:**
- Modify: `public/app.js`
- Modify: `tests/server.test.js`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("recall event rendering preserves semantic event kinds", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write(JSON.stringify({ type: "run.started", agent: "planner", invocationId: "inv-3", provider: "opencode" }) + "\n");
          child.stdout.write(JSON.stringify({ type: "thinking.delta", agent: "planner", invocationId: "inv-3", text: "inspect parser" }) + "\n");
          child.stdout.write(JSON.stringify({ type: "tool.started", agent: "planner", invocationId: "inv-3", toolName: "read_file", args: { path: "src/agents/invoke-cli.js" } }) + "\n");
          child.stdout.write(JSON.stringify({ type: "file.changed", agent: "planner", invocationId: "inv-3", path: "src/agents/invoke-cli.js", changeType: "modified" }) + "\n");
          child.stdout.write(JSON.stringify({ type: "run.finished", agent: "planner", invocationId: "inv-3", exitCode: 0, signal: null }) + "\n");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "planner", prompt: "hello" }),
      });
      const text = await response.text();
      const sid = text.match(/"sessionId":"([^"]+)"/)[1];
      const invId = text.match(/"invocationId":"([^"]+)"/)[1];
      const read = await (await fetch(`${baseUrl}/api/callbacks/read-invocation?sessionId=${sid}&targetInvocationId=${invId}`)).json();
      const kinds = read.events.map((event) => event.kind);
      assert.ok(kinds.includes("thinking.delta"));
      assert.ok(kinds.includes("tool.started"));
      assert.ok(kinds.includes("file.changed"));
    }
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "semantic event kinds" tests/server.test.js`

Expected: FAIL because transcript recall still mostly records stdout/stderr semantics.

- [ ] **Step 3: Write minimal implementation**

```js
// public/app.js
function eventBodyText(evt) {
  const p = evt.payload || {};
  if (evt.kind === "thinking.delta" || evt.kind === "thinking.final") return p.text || "";
  if (evt.kind === "tool.started") return `${p.toolName || "tool"} ${JSON.stringify(p.args || {})}`;
  if (evt.kind === "tool.finished") return `${p.toolName || "tool"} -> ${JSON.stringify(p.result || {})}`;
  if (evt.kind === "file.changed") return `${p.changeType || "modified"} ${p.path || ""}`.trim();
  if (evt.kind === "progress.update") return JSON.stringify(p.items || [], null, 2);
  if (evt.kind === "text.delta" || evt.kind === "stderr") return p.text || "";
  return JSON.stringify(p, null, 2);
}
```

- [ ] **Step 4: Run full verification**

Run: `node --test tests/agents/invoke-cli.test.js`

Expected: PASS.

Run: `node --test tests/chat-client.test.js`

Expected: PASS.

Run: `node --test tests/server.test.js`

Expected: PASS.

Run: `npm run check`

Expected: exit code `0`.

Run: `git diff -- src/agents src/server public tests docs/superpowers/plans/2026-07-02-structured-cli-events-implementation.md`

Expected: diff is limited to the structured CLI events feature.

- [ ] **Step 5: Commit**

```bash
git add public/app.js tests/server.test.js docs/superpowers/plans/2026-07-02-structured-cli-events-implementation.md
git commit -m "feat: complete structured cli event pipeline"
```

## Self-Review

Spec coverage:

- Event protocol and provider isolation are covered by Tasks 1 and 2.
- Server NDJSON transport, SSE, transcript semantics, and text-only chat history are covered by Task 3.
- Invocation-level frontend state and structured sections are covered by Task 4.
- Recall semantic rendering and final verification are covered by Task 5.

Placeholder scan:

- No `TODO`, `TBD`, or "similar to above" placeholders remain.
- Each task includes concrete files, commands, and code skeletons.

Type consistency:

- The plan consistently uses `AgentEvent`, `createProviderRuntime()`, `run.started`, `text.delta`, `progress.update`, `tool.started`, `file.changed`, and `run.finished`.
- The server callback contract consistently uses `onEvent(event)` after the runtime transport switch.
