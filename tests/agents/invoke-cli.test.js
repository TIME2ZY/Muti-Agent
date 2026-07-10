const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AGENTS, extractAssistantText, invoke } = require("../../src/agents/invoke-cli");

function runScript(args) {
  return runScriptWithEnv(args, {});
}

function runScriptWithEnv(args, extraEnv) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimal-codex-test-"));
  const hookPath = path.join(tmpDir, "spawn-hook.js");
  const sessionPath = path.join(tmpDir, "sessions.json");
  const fakeOpencodeDir = path.join(tmpDir, "node_modules", "opencode-ai", "bin");
  const fakeOpencodePath = path.join(fakeOpencodeDir, "opencode.exe");

  fs.mkdirSync(fakeOpencodeDir, { recursive: true });
  fs.writeFileSync(fakeOpencodePath, "");

  fs.writeFileSync(
    hookPath,
    `
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

childProcess.spawn = function spawn(command, args, options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  process.nextTick(() => {
    if (command.endsWith("opencode.exe")) {
      child.stdout.write(JSON.stringify({
        type: "session.updated",
        session: { id: "opencode-session-1" }
      }) + "\\n");
      child.stdout.write(JSON.stringify({
        type: "message.part.updated",
        part: { type: "text", text: "opencode.exe:" + args.join(" ") + ":" + options.env.HTTP_PROXY }
      }) + "\\n");
    } else {
      child.stdout.write(JSON.stringify({
        type: "thread.started",
        thread_id: "codex-session-1"
      }) + "\\n");
      child.stdout.write(JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "codex:" + args.join(" ") + ":" + options.env.HTTP_PROXY }
          ]
        }
      }) + "\\n");
    }

    child.stdout.end();
    child.emit("close", 0, null);
  });

  return child;
};
`,
    "utf8"
  );

  const result = spawnSync(process.execPath, ["src/agents/invoke-cli.js", ...args], {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      PATH: `${tmpDir}${path.delimiter}${process.env.PATH}`,
      NODE_OPTIONS: `--require ${hookPath}`,
      INVOKE_SESSION_FILE: sessionPath,
      ...extraEnv,
    },
    encoding: "utf8",
  });

  result.sessionPath = sessionPath;
  return result;
}

function runScriptWithSession(args, sessions) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimal-codex-test-"));
  const sessionPath = path.join(tmpDir, "sessions.json");

  // Determine which agent is being invoked to set the correct resume session.
  const agentIdx = args.indexOf("--agent");
  const agentId = agentIdx >= 0 ? args[agentIdx + 1] : "architect";
  const resumeSessionId = (sessions[agentId] && sessions[agentId].sessionId) || "";

  const hookPath = path.join(tmpDir, "spawn-hook.js");
  const fakeOpencodeDir = path.join(tmpDir, "node_modules", "opencode-ai", "bin");
  const fakeOpencodePath = path.join(fakeOpencodeDir, "opencode.exe");

  fs.mkdirSync(fakeOpencodeDir, { recursive: true });
  fs.writeFileSync(fakeOpencodePath, "");

  fs.writeFileSync(
    hookPath,
    `
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

childProcess.spawn = function spawn(command, args, options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  process.nextTick(() => {
    child.stdout.write(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: command.split(/[\\\\/]/).pop() + ":" + args.join(" ") }] }
    }) + "\\n");
    child.stdout.end();
    child.emit("close", 0, null);
  });

  return child;
};
`,
    "utf8"
  );

  const result = spawnSync(process.execPath, ["src/agents/invoke-cli.js", ...args], {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      PATH: `${tmpDir}${path.delimiter}${process.env.PATH}`,
      NODE_OPTIONS: `--require ${hookPath}`,
      INVOKE_SESSION_FILE: sessionPath,
      INVOKE_SESSION_ID: resumeSessionId,
    },
    encoding: "utf8",
  });

  result.sessionPath = sessionPath;
  return result;
}

function runScriptWithHook(args, hookSource) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimal-codex-test-"));
  const hookPath = path.join(tmpDir, "spawn-hook.js");
  const sessionPath = path.join(tmpDir, "sessions.json");

  fs.writeFileSync(hookPath, hookSource, "utf8");

  const result = spawnSync(process.execPath, ["src/agents/invoke-cli.js", ...args], {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${hookPath}`,
      INVOKE_SESSION_FILE: sessionPath,
    },
    encoding: "utf8",
  });

  result.sessionPath = sessionPath;
  return result;
}

function parseOutputEvents(stdout) {
  return String(stdout || "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("uses architect agent by default", () => {
  const result = runScript(["hello"]);

  assert.equal(result.status, 0);
  assert.deepEqual(
    parseOutputEvents(result.stdout).map((event) => event.type),
    ["run.started", "text.delta", "run.finished"]
  );
  assert.match(parseOutputEvents(result.stdout)[1].text, /codex:-s danger-full-access/);
  assert.equal(result.stderr, "");
});

test("uses orchestrator agent for deepseek v4 pro", () => {
  const result = runScript(["--agent", "orchestrator", "hello"]);

  assert.equal(result.status, 0);
  assert.deepEqual(
    parseOutputEvents(result.stdout).map((event) => event.type),
    ["run.started", "text.delta", "run.finished"]
  );
  assert.match(parseOutputEvents(result.stdout)[1].text, /opencode\.exe:run --format json --model opencode-go\/deepseek-v4-pro hello:undefined/);
  assert.equal(result.stderr, "");
});

test("uses frontend agent for glm 5.2", () => {
  const result = runScript(["--agent=frontend", "hello"]);

  assert.equal(result.status, 0);
  assert.deepEqual(
    parseOutputEvents(result.stdout).map((event) => event.type),
    ["run.started", "text.delta", "run.finished"]
  );
  assert.match(parseOutputEvents(result.stdout)[1].text, /opencode\.exe:run --format json --model opencode-go\/glm-5.2 hello:undefined/);
  assert.equal(result.stderr, "");
});

test("uses planner agent for mimo v2.5 pro", () => {
  const result = runScript(["--agent", "planner", "hello"]);

  assert.equal(result.status, 0);
  assert.deepEqual(
    parseOutputEvents(result.stdout).map((event) => event.type),
    ["run.started", "text.delta", "run.finished"]
  );
  assert.match(parseOutputEvents(result.stdout)[1].text, /opencode\.exe:run --format json --model opencode-go\/mimo-v2\.5-pro hello:undefined/);
  assert.equal(result.stderr, "");
});

test("invoke-cli writes normalized NDJSON events instead of plain assistant text", () => {
  const result = runScript(["hello"]);

  assert.equal(result.status, 0);
  const lines = parseOutputEvents(result.stdout);
  assert.equal(lines[0].type, "run.started");
  assert.equal(lines[1].type, "text.delta");
  assert.equal(lines[1].text.includes("codex:-s danger-full-access"), true);
});

test("invoke-cli persists provider session IDs while emitting NDJSON", () => {
  const result = runScript(["--agent", "orchestrator", "hello"]);

  assert.equal(result.status, 0);
  const events = parseOutputEvents(result.stdout);
  assert.ok(events.some((event) => event.type === "text.delta"));
  const sessionFile = JSON.parse(fs.readFileSync(result.sessionPath, "utf8"));
  assert.equal(sessionFile.orchestrator.sessionId, "opencode-session-1");
});

test("rejects unknown agent", () => {
  const result = runScript(["--agent", "unknown", "hello"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported agent "unknown"/);
  assert.equal(result.stdout, "");
});

test("exports invoke function", () => {
  assert.equal(typeof invoke, "function");
});

test("exports the fixed agents", () => {
  assert.deepEqual(Object.keys(AGENTS).sort(), ["architect", "coder", "critic", "frontend", "orchestrator", "planner"]);
  assert.equal(AGENTS.architect.model, "gpt-5.5");
  assert.equal(AGENTS.architect.reasoningEffort, "high");
  assert.equal(AGENTS.orchestrator.model, "deepseek-v4-pro");
  assert.equal(AGENTS.planner.model, "mimo-v2.5-pro");
  assert.equal(AGENTS.coder.model, "minimax-m3");
  assert.equal(AGENTS.coder.reasoningEffort, "high");
  assert.equal(AGENTS.frontend.model, "glm-5.2");
  assert.equal(AGENTS.critic.model, "qwen3.7-plus");
});

test("codex runtime maps agent_message and todo_list into normalized events", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
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

test("codex runtime maps mcp tools and subagent task lifecycle events", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({ name: "codex", id: "architect", model: "gpt-5.5" });
  const ctx = { invocationId: "inv-tool", agent: "architect" };

  const toolStarted = runtime.transform({
    type: "item.started",
    item: {
      id: "call-1",
      type: "mcp_tool_call",
      tool: "web_search",
      arguments: { query: "codex events" },
      status: "in_progress",
    },
  }, ctx);

  const subStarted = runtime.transform({
    type: "item.started",
    item: {
      id: "call-2",
      type: "mcp_tool_call",
      tool: "task",
      arguments: {
        subagent_type: "explore",
        prompt: "Find where session runtime is defined",
      },
      status: "in_progress",
    },
  }, ctx);

  const subDone = runtime.transform({
    type: "item.completed",
    item: {
      id: "call-2",
      type: "mcp_tool_call",
      tool: "task",
      arguments: {
        subagent_type: "explore",
        prompt: "Find where session runtime is defined",
      },
      result: { summary: "Defined in public/session-runtime.js" },
      status: "completed",
    },
  }, ctx);

  const subFailed = runtime.transform({
    type: "item.completed",
    item: {
      id: "call-3",
      type: "function_call",
      name: "spawn_agent",
      arguments: { agent: "general-purpose", prompt: "do work" },
      error: "timeout",
      status: "failed",
    },
  }, ctx);

  assert.deepEqual(toolStarted, [{
    type: "tool.started",
    agent: "architect",
    invocationId: "inv-tool",
    toolName: "web_search",
    args: { query: "codex events" },
    toolId: "call-1",
  }]);

  assert.equal(subStarted.length, 2);
  assert.equal(subStarted[0].type, "tool.started");
  assert.equal(subStarted[1].type, "subagent.started");
  assert.equal(subStarted[1].name, "explore");
  assert.match(subStarted[1].task, /session runtime/);

  assert.equal(subDone.some((e) => e.type === "subagent.completed"), true);
  assert.equal(subDone.find((e) => e.type === "subagent.completed").summary.includes("session-runtime"), true);

  assert.equal(subFailed.some((e) => e.type === "subagent.failed"), true);
  assert.equal(subFailed.find((e) => e.type === "subagent.failed").error, "timeout");
});

test("opencode runtime maps tool/task parts into tool and subagent events", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({ name: "opencode", id: "planner", model: "mimo-v2.5-pro" });
  const ctx = { invocationId: "inv-oc", agent: "planner" };

  const started = runtime.transform({
    type: "message.part.updated",
    part: {
      id: "part-1",
      type: "tool",
      tool: "task",
      status: "running",
      arguments: { subagent_type: "explore", prompt: "scan providers" },
    },
  }, ctx);

  const done = runtime.transform({
    type: "message.part.updated",
    part: {
      id: "part-1",
      type: "tool",
      tool: "task",
      status: "completed",
      arguments: { subagent_type: "explore", prompt: "scan providers" },
      output: "found codex + opencode",
    },
  }, ctx);

  assert.equal(started.some((e) => e.type === "tool.started"), true);
  assert.equal(started.some((e) => e.type === "subagent.started"), true);
  assert.equal(done.some((e) => e.type === "tool.finished"), true);
  assert.equal(done.some((e) => e.type === "subagent.completed"), true);
});

test("codex runtime maps command, file, and transport errors into normalized events", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({ name: "codex", id: "architect", model: "gpt-5.5" });
  const ctx = { invocationId: "inv-1b", agent: "architect" };

  const commandStarted = runtime.transform({
    type: "item.started",
    item: {
      id: "item-1",
      type: "command_execution",
      command: "Get-Content -Raw skill.md",
      status: "in_progress",
    },
  }, ctx);

  const commandFinished = runtime.transform({
    type: "item.completed",
    item: {
      id: "item-1",
      type: "command_execution",
      command: "Get-Content -Raw skill.md",
      aggregated_output: "skill body",
      exit_code: 0,
      status: "completed",
    },
  }, ctx);

  const fileChanged = runtime.transform({
    type: "item.completed",
    item: {
      id: "item-2",
      type: "file_change",
      changes: [
        { path: "C:\\worktree\\temp.txt", kind: "add" },
      ],
      status: "completed",
    },
  }, ctx);

  const transportError = runtime.transform({
    type: "error",
    message: "Reconnecting... 2/5 (request timed out)",
  }, ctx);

  const itemError = runtime.transform({
    type: "item.completed",
    item: {
      id: "item-3",
      type: "error",
      message: "Falling back from WebSockets to HTTPS transport. request timed out",
    },
  }, ctx);

  assert.deepEqual(commandStarted, [{
    type: "command.started",
    agent: "architect",
    invocationId: "inv-1b",
    command: "Get-Content -Raw skill.md",
  }]);
  assert.deepEqual(commandFinished, [{
    type: "command.finished",
    agent: "architect",
    invocationId: "inv-1b",
    command: "Get-Content -Raw skill.md",
    output: "skill body",
    exitCode: 0,
  }]);
  assert.deepEqual(fileChanged, [{
    type: "file.changed",
    agent: "architect",
    invocationId: "inv-1b",
    path: "C:\\worktree\\temp.txt",
    changeType: "add",
  }]);
  assert.deepEqual(transportError, [{
    type: "stderr",
    agent: "architect",
    invocationId: "inv-1b",
    text: "Reconnecting... 2/5 (request timed out)",
  }]);
  assert.deepEqual(itemError, [{
    type: "stderr",
    agent: "architect",
    invocationId: "inv-1b",
    text: "Falling back from WebSockets to HTTPS transport. request timed out",
  }]);
});

test("opencode runtime emits incremental text deltas from repeated parts", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
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

test("opencode runtime reads text deltas from properties.part fallback", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({ name: "opencode", id: "planner", model: "mimo-v2.5-pro" });
  const ctx = { invocationId: "inv-3", agent: "planner" };

  const events = runtime.transform({
    type: "message.part.updated",
    properties: {
      part: { id: "p2", type: "text", text: "fallback text" },
    },
  }, ctx);

  assert.deepEqual(events.map((event) => event.text), ["fallback text"]);
});

test("opencode runtime extracts sessionID and text events from current cli schema", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({ name: "opencode", id: "planner", model: "mimo-v2.5-pro" });
  const ctx = { invocationId: "inv-3b", agent: "planner" };

  const rawStart = {
    type: "step_start",
    sessionID: "ses_current_schema",
    part: { id: "prt1", type: "step-start" },
  };
  const rawText = {
    type: "text",
    sessionID: "ses_current_schema",
    part: { id: "prt2", type: "text", text: "Hello from current schema" },
  };

  assert.equal(runtime.extractSessionId(rawStart), "ses_current_schema");
  const started = runtime.transform(rawStart, ctx);
  const text = runtime.transform(rawText, ctx);

  assert.equal(started[0].type, "run.started");
  assert.equal(started[0].sessionId, "ses_current_schema");
  assert.deepEqual(text.map((event) => event.text), ["Hello from current schema"]);
});

test("codex runtime reads text from content and properties.content fallbacks", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({ name: "codex", id: "architect", model: "gpt-5.5" });
  const ctx = { invocationId: "inv-4", agent: "architect" };

  const direct = runtime.transform({
    type: "response.output_text.delta",
    content: { type: "text", text: "direct content" },
  }, ctx);

  const nested = runtime.transform({
    type: "response.output_text.delta",
    properties: {
      content: { type: "text", text: "nested content" },
    },
  }, ctx);

  assert.deepEqual(direct.map((event) => event.text), ["direct content"]);
  assert.deepEqual(nested.map((event) => event.text), ["nested content"]);
});

test("extracts codex agent message events", () => {
  const text = extractAssistantText(
    {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Hello from Codex",
      },
    },
    { opencodeParts: new Map() }
  );

  assert.equal(text, "Hello from Codex");
});

test("resumes remembered codex session", () => {
  const result = runScriptWithSession(["hello again"], {
    architect: { sessionId: "codex-session-previous" },
  });

  assert.equal(result.status, 0);
  const events = parseOutputEvents(result.stdout);
  assert.equal(events[0].type, "text.delta");
  assert.match(events[0].text, /exec resume --json codex-session-previous hello again/);
  assert.equal(result.stderr, "");
});

test("resumes remembered opencode session", () => {
  const result = runScriptWithSession(["--agent", "orchestrator", "hello again"], {
    orchestrator: { sessionId: "opencode-session-previous" },
  });

  assert.equal(result.status, 0);
  const events = parseOutputEvents(result.stdout);
  assert.equal(events[0].type, "text.delta");
  assert.match(events[0].text, /opencode\.exe:run --format json --model opencode-go\/deepseek-v4-pro --session opencode-session-previous hello again/);
  assert.equal(result.stderr, "");
});

test("remembers sessions from stream events", () => {
  const result = runScript(["hello"]);

  assert.equal(result.status, 0);
  const sessionFile = JSON.parse(fs.readFileSync(result.sessionPath, "utf8"));
  assert.equal(sessionFile.architect.sessionId, "codex-session-1");
});

test("remembers opencode sessions from stream events", () => {
  const result = runScript(["--agent", "orchestrator", "hello"]);

  assert.equal(result.status, 0);
  const sessionFile = JSON.parse(fs.readFileSync(result.sessionPath, "utf8"));
  assert.equal(sessionFile.orchestrator.sessionId, "opencode-session-1");
});

test("remembers workspace key from stream events when provided", () => {
  const result = runScriptWithEnv(["hello"], {
    INVOKE_WORKSPACE_KEY: "base:test-workspace",
  });

  assert.equal(result.status, 0);
  const sessionFile = JSON.parse(fs.readFileSync(result.sessionPath, "utf8"));
  assert.equal(sessionFile.architect.sessionId, "codex-session-1");
  assert.equal(sessionFile.architect.workspaceKey, "base:test-workspace");
  assert.equal(
    sessionFile.architect.byWorkspace["base:test-workspace"].sessionId,
    "codex-session-1"
  );
});

test("persists provider sessions per workspace without overwriting the other", () => {
  const first = runScriptWithEnv(["hello"], {
    INVOKE_WORKSPACE_KEY: "base:C:\\proj",
  });
  assert.equal(first.status, 0);

  // Second run reuses the same session file and writes a worktree slot.
  const second = runScriptWithEnv(["hello again"], {
    INVOKE_WORKSPACE_KEY: "worktree:C:\\proj.worktrees\\s1",
    INVOKE_SESSION_FILE: first.sessionPath,
  });
  assert.equal(second.status, 0);

  const sessionFile = JSON.parse(fs.readFileSync(first.sessionPath, "utf8"));
  assert.equal(sessionFile.architect.byWorkspace["base:C:\\proj"].sessionId, "codex-session-1");
  assert.equal(
    sessionFile.architect.byWorkspace["worktree:C:\\proj.worktrees\\s1"].sessionId,
    "codex-session-1"
  );
  assert.equal(sessionFile.architect.workspaceKey, "worktree:C:\\proj.worktrees\\s1");
});

test("cold starts when no saved session", () => {
  // No INVOYE_SESSION_ID set → cold start (no --resume needed)
  const result = runScript(["hello"]);

  assert.equal(result.status, 0);
  // Without INVOYE_SESSION_ID, the CLI runs without --session / resume args
  assert.match(result.stdout, /codex:-s danger-full-access/);
  assert.equal(result.stderr, "");
});

test("supports configurable proxy", () => {
  const result = runScript(["--proxy", "http://127.0.0.1:9999", "hello"]);

  assert.equal(result.status, 0);
  assert.match(parseOutputEvents(result.stdout)[1].text, /hello:http:\/\/127\.0\.0\.1:9999/);
  assert.equal(result.stderr, "");
});

test("kills inactive child after timeout", () => {
  const result = runScriptWithHook(
    ["--timeout-ms", "20", "--kill-grace-ms", "20", "hello"],
    `
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

childProcess.spawn = function spawn() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = function kill(signal) {
    child.stderr.write("killed:" + signal + "\\n");
    child.emit("close", null, signal);
    return true;
  };
  return child;
};
`
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /timed out after 20ms of no stdout\/stderr activity/);
  assert.match(result.stderr, /killed:SIGTERM/);
});

test("stderr activity prevents idle timeout", () => {
  const result = runScriptWithHook(
    ["--timeout-ms", "50", "--kill-grace-ms", "20", "hello"],
    `
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

childProcess.spawn = function spawn() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = function kill(signal) {
    child.stderr.write("unexpected-kill:" + signal + "\\n");
    child.emit("close", null, signal);
    return true;
  };

  setTimeout(() => child.stderr.write("thinking\\n"), 35);
  setTimeout(() => {
    child.stdout.write(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }] }
    }) + "\\n");
    child.stdout.end();
    child.emit("close", 0, null);
  }, 70);

  return child;
};
`
  );

  assert.equal(result.status, 0);
  const events = parseOutputEvents(result.stdout);
  assert.equal(events[0].type, "text.delta");
  assert.equal(events[0].text, "done");
  assert.match(result.stderr, /thinking/);
  assert.doesNotMatch(result.stderr, /unexpected-kill/);
});

test("retries failed child when configured", () => {
  const result = runScriptWithHook(
    ["--retries", "1", "hello"],
    `
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
let attempt = 0;

childProcess.spawn = function spawn() {
  attempt += 1;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = function kill(signal) {
    child.emit("close", null, signal);
    return true;
  };

  process.nextTick(() => {
    if (attempt === 1) {
      child.stderr.write("temporary failure\\n");
      child.emit("close", 2, null);
      return;
    }

    child.stdout.write(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "retry-success" }] }
    }) + "\\n");
    child.stdout.end();
    child.emit("close", 0, null);
  });

  return child;
};
`
  );

  assert.equal(result.status, 0);
  const events = parseOutputEvents(result.stdout);
  assert.equal(events[0].type, "text.delta");
  assert.equal(events[0].text, "retry-success");
  assert.match(result.stderr, /temporary failure/);
  assert.match(result.stderr, /retrying 1\/1/);
});
