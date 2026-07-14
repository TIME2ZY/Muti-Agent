const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AGENTS, invoke } = require("../../src/agents/invoke-cli");

/** Regex-safe binary prefix in mock stdout (e.g. opencode.exe:run or opencode:run). */
const OPENCODE_BIN_RE = process.platform === "win32" ? "opencode\\.exe" : "opencode";

function installFakeOpencodeBin(tmpDir) {
  const fakeOpencodeDir = path.join(tmpDir, "node_modules", "opencode-ai", "bin");
  fs.mkdirSync(fakeOpencodeDir, { recursive: true });
  // Seed both names so PATH-based Windows resolution and Linux basename checks stay happy.
  fs.writeFileSync(path.join(fakeOpencodeDir, "opencode.exe"), "");
  fs.writeFileSync(path.join(fakeOpencodeDir, "opencode"), "");
}

const PROXY_ENV_KEYS = [
  "INVOKE_CLI_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

function withoutAmbientProxy(env, keepKeys = {}) {
  const next = { ...env };
  for (const key of PROXY_ENV_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(keepKeys, key)) {
      delete next[key];
    }
  }
  return next;
}

function runScript(args) {
  return runScriptWithEnv(args, {});
}

function runScriptWithEnv(args, extraEnv) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimal-codex-test-"));
  const hookPath = path.join(tmpDir, "spawn-hook.js");
  const sessionPath = path.join(tmpDir, "sessions.json");
  installFakeOpencodeBin(tmpDir);

  fs.writeFileSync(
    hookPath,
    `
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

function commandBase(command) {
  const raw = String(command || "");
  const parts = raw.split(/[\\\\/]/);
  return parts[parts.length - 1] || raw;
}

function isOpencodeCommand(command) {
  return /^opencode(\\.exe)?$/i.test(commandBase(command));
}

childProcess.spawn = function spawn(command, args, options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  process.nextTick(() => {
    if (isOpencodeCommand(command)) {
      child.stdout.write(JSON.stringify({
        type: "session.updated",
        session: { id: "opencode-session-1" }
      }) + "\\n");
      child.stdout.write(JSON.stringify({
        type: "message.part.updated",
        part: { type: "text", text: commandBase(command) + ":" + args.join(" ") + ":" + options.env.HTTP_PROXY }
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

  const env = withoutAmbientProxy(
    {
      ...process.env,
      PATH: `${tmpDir}${path.delimiter}${process.env.PATH}`,
      NODE_OPTIONS: `--require ${hookPath}`,
      INVOKE_SESSION_FILE: sessionPath,
      ...extraEnv,
    },
    extraEnv
  );

  const result = spawnSync(process.execPath, ["src/agents/invoke-cli.js", ...args], {
    cwd: path.resolve(__dirname, "../.."),
    env,
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
  installFakeOpencodeBin(tmpDir);

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
    env: withoutAmbientProxy({
      ...process.env,
      PATH: `${tmpDir}${path.delimiter}${process.env.PATH}`,
      NODE_OPTIONS: `--require ${hookPath}`,
      INVOKE_SESSION_FILE: sessionPath,
      INVOKE_SESSION_ID: resumeSessionId,
    }),
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
    env: withoutAmbientProxy({
      ...process.env,
      NODE_OPTIONS: `--require ${hookPath}`,
      INVOKE_SESSION_FILE: sessionPath,
    }),
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
  assert.match(
    parseOutputEvents(result.stdout)[1].text,
    new RegExp(
      `${OPENCODE_BIN_RE}:run --format json --thinking --model opencode-go\\/deepseek-v4-pro hello:undefined`
    )
  );
  assert.equal(result.stderr, "");
});

test("uses frontend agent for glm 5.2", () => {
  const result = runScript(["--agent=frontend", "hello"]);

  assert.equal(result.status, 0);
  assert.deepEqual(
    parseOutputEvents(result.stdout).map((event) => event.type),
    ["run.started", "text.delta", "run.finished"]
  );
  assert.match(
    parseOutputEvents(result.stdout)[1].text,
    new RegExp(
      `${OPENCODE_BIN_RE}:run --format json --thinking --model opencode-go\\/glm-5.2 hello:undefined`
    )
  );
  assert.equal(result.stderr, "");
});

test("uses planner agent for mimo v2.5 pro", () => {
  const result = runScript(["--agent", "planner", "hello"]);

  assert.equal(result.status, 0);
  assert.deepEqual(
    parseOutputEvents(result.stdout).map((event) => event.type),
    ["run.started", "text.delta", "run.finished"]
  );
  assert.match(
    parseOutputEvents(result.stdout)[1].text,
    new RegExp(
      `${OPENCODE_BIN_RE}:run --format json --thinking --model opencode-go\\/mimo-v2\\.5-pro hello:undefined`
    )
  );
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
  assert.deepEqual(Object.keys(AGENTS).sort(), [
    "architect",
    "coder",
    "critic",
    "frontend",
    "gemini",
    "grok",
    "orchestrator",
    "planner",
  ]);
  assert.equal(AGENTS.architect.model, "gpt-5.6-sol");
  assert.equal(AGENTS.architect.reasoningEffort, "medium");
  assert.equal(AGENTS.orchestrator.model, "deepseek-v4-pro");
  assert.equal(AGENTS.planner.model, "mimo-v2.5-pro");
  assert.equal(AGENTS.coder.model, "minimax-m3");
  assert.equal(AGENTS.coder.reasoningEffort, "high");
  assert.equal(AGENTS.grok.model, "grok-4.5");
  assert.equal(AGENTS.grok.reasoningEffort, "high");
  assert.equal(AGENTS.grok.name, "grok");
  assert.equal(AGENTS.gemini.model, "gemini-3.5-flash");
  assert.equal(AGENTS.gemini.reasoningEffort, "high");
  assert.equal(AGENTS.gemini.name, "antigravity");
  assert.equal(AGENTS.frontend.model, "glm-5.2");
  assert.equal(AGENTS.critic.model, "qwen3.7-plus");
});

test("codex runtime maps agent_message and todo_list into normalized events", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({ name: "codex", id: "architect", model: "gpt-5.6-sol" });
  const invocationId = "inv-1";

  const started = runtime.transform(
    {
      type: "thread.started",
      thread_id: "codex-session-1",
    },
    { invocationId, agent: "architect" }
  );

  const todo = runtime.transform(
    {
      type: "item.completed",
      item: {
        type: "todo_list",
        items: [
          { text: "Inspect parser", done: true },
          { text: "Render timeline", done: false },
        ],
      },
    },
    { invocationId, agent: "architect" }
  );

  const text = runtime.transform(
    {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Hello from Codex",
      },
    },
    { invocationId, agent: "architect" }
  );

  assert.equal(started[0].type, "run.started");
  assert.equal(todo[0].type, "progress.update");
  assert.equal(text[0].type, "text.delta");
  assert.equal(text[0].text, "Hello from Codex");
});

test("codex runtime maps mcp tools and subagent task lifecycle events", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({ name: "codex", id: "architect", model: "gpt-5.6-sol" });
  const ctx = { invocationId: "inv-tool", agent: "architect" };

  const toolStarted = runtime.transform(
    {
      type: "item.started",
      item: {
        id: "call-1",
        type: "mcp_tool_call",
        tool: "web_search",
        arguments: { query: "codex events" },
        status: "in_progress",
      },
    },
    ctx
  );

  const subStarted = runtime.transform(
    {
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
    },
    ctx
  );

  const subDone = runtime.transform(
    {
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
    },
    ctx
  );

  const subFailed = runtime.transform(
    {
      type: "item.completed",
      item: {
        id: "call-3",
        type: "function_call",
        name: "spawn_agent",
        arguments: { agent: "general-purpose", prompt: "do work" },
        error: "timeout",
        status: "failed",
      },
    },
    ctx
  );

  assert.deepEqual(
    toolStarted.find((event) => event.type === "tool.started"),
    {
      type: "tool.started",
      protocolVersion: 1,
      agent: "architect",
      invocationId: "inv-tool",
      toolName: "web_search",
      args: { query: "codex events" },
      toolId: "call-1",
      state: "running",
    }
  );

  assert.equal(subStarted.length, 2);
  assert.equal(subStarted[0].type, "tool.started");
  assert.equal(subStarted[1].type, "subagent.started");
  assert.equal(subStarted[1].name, "explore");
  assert.match(subStarted[1].task, /session runtime/);

  assert.equal(
    subDone.some((e) => e.type === "subagent.completed"),
    true
  );
  assert.equal(
    subDone.find((e) => e.type === "subagent.completed").summary.includes("session-runtime"),
    true
  );

  assert.equal(
    subFailed.some((e) => e.type === "subagent.failed"),
    true
  );
  assert.equal(subFailed.find((e) => e.type === "subagent.failed").error, "timeout");
});

test("opencode runtime maps tool/task parts into tool and subagent events", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({
    name: "opencode",
    id: "planner",
    model: "mimo-v2.5-pro",
  });
  const ctx = { invocationId: "inv-oc", agent: "planner" };

  const started = runtime.transform(
    {
      type: "message.part.updated",
      part: {
        id: "part-1",
        type: "tool",
        tool: "task",
        status: "running",
        arguments: { subagent_type: "explore", prompt: "scan providers" },
      },
    },
    ctx
  );

  const done = runtime.transform(
    {
      type: "message.part.updated",
      part: {
        id: "part-1",
        type: "tool",
        tool: "task",
        status: "completed",
        arguments: { subagent_type: "explore", prompt: "scan providers" },
        output: "found codex + opencode",
      },
    },
    ctx
  );

  assert.equal(
    started.some((e) => e.type === "tool.started"),
    true
  );
  assert.equal(
    started.some((e) => e.type === "subagent.started"),
    true
  );
  assert.equal(
    done.some((e) => e.type === "tool.finished"),
    true
  );
  assert.equal(
    done.some((e) => e.type === "subagent.completed"),
    true
  );
});

test("opencode runtime maps real tool_use events from current CLI schema", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({
    name: "opencode",
    id: "planner",
    model: "mimo-v2.5-pro",
  });
  const ctx = { invocationId: "inv-oc-tool-use", agent: "planner" };

  const events = runtime.transform(
    {
      type: "tool_use",
      timestamp: 1783690684796,
      sessionID: "ses_sample",
      part: {
        type: "tool",
        tool: "task",
        callID: "call_424f09b8b6e04590b7a594f5",
        state: {
          status: "completed",
          input: {
            description: "查看git状态和最近提交",
            subagent_type: "general",
            prompt: "请执行 git status 与 git log",
          },
          output: "<task_result>git status ok</task_result>",
          title: "查看git状态和最近提交",
          time: { start: 1, end: 2 },
        },
        id: "prt_sample",
        sessionID: "ses_sample",
        messageID: "msg_sample",
      },
    },
    ctx
  );

  assert.equal(
    events.some((e) => e.type === "tool.started" && e.toolName === "task"),
    true
  );
  assert.equal(
    events.some((e) => e.type === "tool.finished" && e.status === "ok"),
    true
  );
  assert.equal(
    events.some((e) => e.type === "subagent.started" && e.name === "general"),
    true
  );
  assert.equal(
    events.some((e) => e.type === "subagent.completed"),
    true
  );
  assert.equal(
    events.find((e) => e.type === "tool.started").toolId,
    "call_424f09b8b6e04590b7a594f5"
  );
  assert.match(events.find((e) => e.type === "subagent.completed").summary, /git status ok/);
});

test("opencode runtime maps read/bash tools and nests state.input", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({
    name: "opencode",
    id: "planner",
    model: "mimo-v2.5-pro",
  });
  const ctx = { invocationId: "inv-oc-tools", agent: "planner" };

  const readStarted = runtime.transform(
    {
      type: "message.part.updated",
      part: {
        id: "t-read",
        type: "tool",
        tool: "read",
        state: {
          status: "running",
          input: { path: "public/app.js" },
        },
      },
    },
    ctx
  );

  const bashDone = runtime.transform(
    {
      type: "message.part.updated",
      part: {
        id: "t-bash",
        type: "tool",
        tool: "bash",
        status: "completed",
        arguments: { command: "npm test" },
        output: "ok",
      },
    },
    ctx
  );

  assert.equal(
    readStarted.some((e) => e.type === "tool.started" && e.toolName === "read"),
    true
  );
  assert.equal(readStarted.find((e) => e.type === "tool.started").args.path, "public/app.js");
  assert.equal(
    bashDone.some((e) => e.type === "tool.started" && e.toolName === "bash"),
    true
  );
  assert.equal(
    bashDone.some((e) => e.type === "command.started" && e.command === "npm test"),
    true
  );
  assert.equal(
    bashDone.some((e) => e.type === "command.finished" && e.exitCode === 0),
    true
  );
  assert.equal(
    bashDone.some((e) => e.type === "tool.finished"),
    true
  );
});

test("opencode runtime emits a single run.started and step progress updates", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({
    name: "opencode",
    id: "planner",
    model: "mimo-v2.5-pro",
  });
  const ctx = { invocationId: "inv-oc-steps", agent: "planner" };

  const firstSession = runtime.transform(
    {
      type: "session.updated",
      session: { id: "ses_steps" },
    },
    ctx
  );
  const secondSession = runtime.transform(
    {
      type: "session.updated",
      session: { id: "ses_steps" },
    },
    ctx
  );
  const step0 = runtime.transform(
    {
      type: "step_start",
      sessionID: "ses_steps",
      step: 0,
    },
    ctx
  );
  const step1 = runtime.transform(
    {
      type: "step_start",
      sessionID: "ses_steps",
      step: 1,
    },
    ctx
  );
  const step1Again = runtime.transform(
    {
      type: "step_start",
      sessionID: "ses_steps",
      step: 1,
    },
    ctx
  );

  assert.deepEqual(
    firstSession.map((e) => e.type),
    ["run.started"]
  );
  assert.deepEqual(secondSession, []);
  assert.equal(
    step0.some((e) => e.type === "run.started"),
    false
  );
  assert.equal(
    step0.some((e) => e.type === "progress.update"),
    true
  );
  assert.match(step0.find((e) => e.type === "progress.update").items[0].text, /第 0 步/);
  assert.equal(step1.find((e) => e.type === "progress.update").items[0].text, "第 1 步");
  assert.deepEqual(step1Again, []);
});

test("codex runtime maps command, file, and transport errors into normalized events", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({ name: "codex", id: "architect", model: "gpt-5.6-sol" });
  const ctx = { invocationId: "inv-1b", agent: "architect" };

  const commandStarted = runtime.transform(
    {
      type: "item.started",
      item: {
        id: "item-1",
        type: "command_execution",
        command: "Get-Content -Raw skill.md",
        status: "in_progress",
      },
    },
    ctx
  );

  const commandFinished = runtime.transform(
    {
      type: "item.completed",
      item: {
        id: "item-1",
        type: "command_execution",
        command: "Get-Content -Raw skill.md",
        aggregated_output: "skill body",
        exit_code: 0,
        status: "completed",
      },
    },
    ctx
  );

  const fileChanged = runtime.transform(
    {
      type: "item.completed",
      item: {
        id: "item-2",
        type: "file_change",
        changes: [{ path: "C:\\worktree\\temp.txt", kind: "add" }],
        status: "completed",
      },
    },
    ctx
  );

  const transportError = runtime.transform(
    {
      type: "error",
      message: "Reconnecting... 2/5 (request timed out)",
    },
    ctx
  );

  const itemError = runtime.transform(
    {
      type: "item.completed",
      item: {
        id: "item-3",
        type: "error",
        message: "Falling back from WebSockets to HTTPS transport. request timed out",
      },
    },
    ctx
  );

  assert.deepEqual(
    commandStarted.find((event) => event.type === "command.started"),
    {
      type: "command.started",
      protocolVersion: 1,
      agent: "architect",
      invocationId: "inv-1b",
      command: "Get-Content -Raw skill.md",
    }
  );
  assert.deepEqual(commandFinished, [
    {
      type: "command.finished",
      protocolVersion: 1,
      agent: "architect",
      invocationId: "inv-1b",
      command: "Get-Content -Raw skill.md",
      output: "skill body",
      exitCode: 0,
    },
  ]);
  assert.deepEqual(fileChanged, [
    {
      type: "file.changed",
      protocolVersion: 1,
      agent: "architect",
      invocationId: "inv-1b",
      path: "C:\\worktree\\temp.txt",
      changeType: "add",
    },
  ]);
  assert.deepEqual(transportError, [
    {
      type: "stderr",
      protocolVersion: 1,
      agent: "architect",
      invocationId: "inv-1b",
      text: "Reconnecting... 2/5 (request timed out)",
    },
  ]);
  assert.deepEqual(itemError, [
    {
      type: "stderr",
      protocolVersion: 1,
      agent: "architect",
      invocationId: "inv-1b",
      text: "Falling back from WebSockets to HTTPS transport. request timed out",
    },
  ]);
});

test("opencode runtime emits incremental text deltas from repeated parts", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({
    name: "opencode",
    id: "planner",
    model: "mimo-v2.5-pro",
  });
  const ctx = { invocationId: "inv-2", agent: "planner" };

  const first = runtime.transform(
    {
      type: "message.part.updated",
      part: { id: "p1", type: "text", text: "hello" },
    },
    ctx
  );

  const second = runtime.transform(
    {
      type: "message.part.updated",
      part: { id: "p1", type: "text", text: "hello world" },
    },
    ctx
  );

  assert.deepEqual(
    first.filter((event) => event.type === "text.delta").map((event) => event.text),
    ["hello"]
  );
  assert.deepEqual(
    second.map((event) => event.text),
    [" world"]
  );
});

test("opencode runtime reads text deltas from properties.part fallback", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({
    name: "opencode",
    id: "planner",
    model: "mimo-v2.5-pro",
  });
  const ctx = { invocationId: "inv-3", agent: "planner" };

  const events = runtime.transform(
    {
      type: "message.part.updated",
      properties: {
        part: { id: "p2", type: "text", text: "fallback text" },
      },
    },
    ctx
  );

  assert.deepEqual(
    events.filter((event) => event.type === "text.delta").map((event) => event.text),
    ["fallback text"]
  );
});

test("opencode runtime extracts sessionID and text events from current cli schema", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({
    name: "opencode",
    id: "planner",
    model: "mimo-v2.5-pro",
  });
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

  // First step may also open the run, but subsequent progress is not another run.started.
  assert.equal(started.filter((e) => e.type === "run.started").length, 1);
  assert.equal(started.find((e) => e.type === "run.started").sessionId, "ses_current_schema");
  assert.equal(
    started.some((e) => e.type === "progress.update"),
    true
  );
  assert.deepEqual(
    text.map((event) => event.text),
    ["Hello from current schema"]
  );
});

test("opencode runtime maps reasoning events (from --thinking) to thinking.delta", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({
    name: "opencode",
    id: "planner",
    model: "mimo-v2.5-pro",
  });
  const ctx = { invocationId: "inv-think", agent: "planner" };

  // Real CLI shape observed with: opencode run --format json --thinking
  const full = runtime.transform(
    {
      type: "reasoning",
      sessionID: "ses_think",
      part: {
        id: "prt_reason_1",
        type: "reasoning",
        text: "The user wants exactly one word.",
      },
    },
    ctx
  );

  const thinking = full.find((event) => event.type === "thinking.delta");
  assert.ok(thinking);
  assert.equal(thinking.text, "The user wants exactly one word.");
  assert.equal(thinking.agent, "planner");
  assert.equal(thinking.invocationId, "inv-think");

  // Streaming growth on the same part id should emit only the delta suffix.
  const more = runtime.transform(
    {
      type: "message.part.updated",
      part: {
        id: "prt_reason_1",
        type: "reasoning",
        text: "The user wants exactly one word. Keep it short.",
      },
    },
    ctx
  );
  assert.deepEqual(
    more.map((e) => e.type),
    ["thinking.delta"]
  );
  assert.deepEqual(
    more.map((e) => e.text),
    [" Keep it short."]
  );

  // Without text body, no event.
  const empty = runtime.transform(
    {
      type: "reasoning",
      part: { id: "prt_empty", type: "reasoning" },
    },
    ctx
  );
  assert.deepEqual(empty, []);
});

test("provider registry lists codex, grok, opencode, and antigravity", () => {
  const { listSupportedProviders, createProviderRuntime } = require("../../src/agents/providers");
  assert.deepEqual(listSupportedProviders().sort(), [
    "antigravity",
    "codex",
    "grok",
    "opencode",
  ]);
  assert.ok(createProviderRuntime({ name: "codex" }));
  assert.ok(createProviderRuntime({ name: "grok", model: "grok-4.5" }));
  assert.ok(
    createProviderRuntime({
      name: "antigravity",
      model: "gemini-3.5-flash",
      reasoningEffort: "high",
    })
  );
  assert.throws(() => createProviderRuntime({ name: "claude" }), /Unsupported provider/);
});

test("codex runtime reads text from content and properties.content fallbacks", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({ name: "codex", id: "architect", model: "gpt-5.6-sol" });
  const ctx = { invocationId: "inv-4", agent: "architect" };

  const direct = runtime.transform(
    {
      type: "response.output_text.delta",
      content: { type: "text", text: "direct content" },
    },
    ctx
  );

  const nested = runtime.transform(
    {
      type: "response.output_text.delta",
      properties: {
        content: { type: "text", text: "nested content" },
      },
    },
    ctx
  );

  assert.deepEqual(
    direct.filter((event) => event.type === "text.delta").map((event) => event.text),
    ["direct content"]
  );
  assert.deepEqual(
    nested.map((event) => event.text),
    ["nested content"]
  );
});

test("codex runtime maps agent message events to text.delta", () => {
  const { createProviderRuntime } = require("../../src/agents/providers");
  const runtime = createProviderRuntime({ name: "codex", id: "architect", model: "gpt-5.6-sol" });
  const events = runtime.transform(
    {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Hello from Codex",
      },
    },
    { agent: "architect", invocationId: "inv-legacy" }
  );
  const text = events.find((event) => event.type === "text.delta");
  assert.ok(text);
  assert.equal(text.text, "Hello from Codex");
});

test("resumes remembered codex session", () => {
  const result = runScriptWithSession(["hello again"], {
    architect: { sessionId: "codex-session-previous" },
  });

  assert.equal(result.status, 0);
  const events = parseOutputEvents(result.stdout);
  const text = events.find((event) => event.type === "text.delta");
  assert.ok(text);
  assert.match(text.text, /exec resume --json codex-session-previous hello again/);
  assert.equal(result.stderr, "");
});

test("resumes remembered opencode session", () => {
  const result = runScriptWithSession(["--agent", "orchestrator", "hello again"], {
    orchestrator: { sessionId: "opencode-session-previous" },
  });

  assert.equal(result.status, 0);
  const events = parseOutputEvents(result.stdout);
  const text = events.find((event) => event.type === "text.delta");
  assert.ok(text);
  assert.match(
    text.text,
    new RegExp(
      `${OPENCODE_BIN_RE}:run --format json --thinking --model opencode-go\\/deepseek-v4-pro --session opencode-session-previous hello again`
    )
  );
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
  assert.equal(
    parseOutputEvents(result.stdout).some((event) => event.type === "run.failed"),
    true
  );
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
  const text = events.find((event) => event.type === "text.delta");
  assert.ok(text);
  assert.equal(text.text, "done");
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
  const text = events.find((event) => event.type === "text.delta");
  assert.ok(text);
  assert.equal(text.text, "retry-success");
  // One invocation lifecycle across retries: single started + single finished.
  assert.equal(events.filter((event) => event.type === "run.started").length, 1);
  assert.equal(events.filter((event) => event.type === "run.finished").length, 1);
  assert.equal(
    events.some((event) => event.type === "run.failed"),
    false
  );
  assert.match(result.stderr, /temporary failure/);
  assert.match(result.stderr, /retrying 1\/1/);
});

test("retries keep a single lifecycle when first attempt already emitted content", () => {
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
      child.stdout.write(JSON.stringify({
        type: "thread.started",
        thread_id: "partial-session"
      }) + "\\n");
      child.stdout.write(JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "partial " }
      }) + "\\n");
      child.stderr.write("boom\\n");
      child.emit("close", 1, null);
      return;
    }

    child.stdout.write(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "recovered" }
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
  assert.equal(events.filter((e) => e.type === "run.started").length, 1);
  assert.equal(events.filter((e) => e.type === "run.finished").length, 1);
  assert.equal(events.filter((e) => e.type === "run.failed").length, 0);
  const texts = events.filter((e) => e.type === "text.delta").map((e) => e.text);
  assert.deepEqual(texts, ["partial ", "recovered"]);
});
