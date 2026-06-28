const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AGENTS, extractAssistantText, invoke } = require("./invoke-cli");

function runScript(args) {
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

  const result = spawnSync(process.execPath, ["invoke-cli.js", ...args], {
    cwd: __dirname,
    env: {
      ...process.env,
      PATH: `${tmpDir}${path.delimiter}${process.env.PATH}`,
      NODE_OPTIONS: `--require ${hookPath}`,
      INVOKE_CLI_SESSION_FILE: sessionPath,
    },
    encoding: "utf8",
  });

  result.sessionPath = sessionPath;
  return result;
}

function runScriptWithSession(args, sessions) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimal-codex-test-"));
  const sessionPath = path.join(tmpDir, "sessions.json");
  fs.writeFileSync(sessionPath, JSON.stringify(sessions), "utf8");

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

  const result = spawnSync(process.execPath, ["invoke-cli.js", ...args], {
    cwd: __dirname,
    env: {
      ...process.env,
      PATH: `${tmpDir}${path.delimiter}${process.env.PATH}`,
      NODE_OPTIONS: `--require ${hookPath}`,
      INVOKE_CLI_SESSION_FILE: sessionPath,
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

  const result = spawnSync(process.execPath, ["invoke-cli.js", ...args], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${hookPath}`,
      INVOKE_CLI_SESSION_FILE: sessionPath,
    },
    encoding: "utf8",
  });

  result.sessionPath = sessionPath;
  return result;
}

test("uses architect agent by default", () => {
  const result = runScript(["hello"]);

  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    "codex:-s danger-full-access -a never -c model_reasoning_effort=\"high\" -m gpt-5.5 exec --json hello:undefined\n"
  );
  assert.equal(result.stderr, "");
});

test("uses forge agent for deepseek v4 pro", () => {
  const result = runScript(["--agent", "forge", "hello"]);

  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    "opencode.exe:run --format json --model opencode-go/deepseek-v4-pro hello:undefined\n"
  );
  assert.equal(result.stderr, "");
});

test("uses sage agent for glm 5.2", () => {
  const result = runScript(["--agent=sage", "hello"]);

  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    "opencode.exe:run --format json --model opencode-go/glm-5.2 hello:undefined\n"
  );
  assert.equal(result.stderr, "");
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
  assert.deepEqual(Object.keys(AGENTS).sort(), ["architect", "forge", "reviewer", "sage"]);
  assert.equal(AGENTS.architect.model, "gpt-5.5");
  assert.equal(AGENTS.architect.reasoningEffort, "high");
  assert.equal(AGENTS.forge.model, "deepseek-v4-pro");
  assert.equal(AGENTS.sage.model, "glm-5.2");
  assert.equal(AGENTS.reviewer.model, "minimax-m3");
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
  const result = runScriptWithSession(["--resume", "hello again"], {
    architect: { sessionId: "codex-session-previous" },
  });

  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    "codex:-s danger-full-access -a never -c model_reasoning_effort=\"high\" -m gpt-5.5 exec resume --json codex-session-previous hello again\n"
  );
  assert.equal(result.stderr, "");
});

test("resumes remembered opencode session", () => {
  const result = runScriptWithSession(["--agent", "forge", "--resume", "hello again"], {
    forge: { sessionId: "opencode-session-previous" },
  });

  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    "opencode.exe:run --format json --model opencode-go/deepseek-v4-pro --session opencode-session-previous hello again\n"
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
  const result = runScript(["--agent", "forge", "hello"]);

  assert.equal(result.status, 0);
  const sessionFile = JSON.parse(fs.readFileSync(result.sessionPath, "utf8"));
  assert.equal(sessionFile.forge.sessionId, "opencode-session-1");
});

test("rejects resume without saved session", () => {
  const result = runScript(["--resume", "hello"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /No saved session for architect/);
  assert.equal(result.stdout, "");
});

test("supports configurable proxy", () => {
  const result = runScript(["--proxy", "http://127.0.0.1:9999", "hello"]);

  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    "codex:-s danger-full-access -a never -c model_reasoning_effort=\"high\" -m gpt-5.5 exec --json hello:http://127.0.0.1:9999\n"
  );
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
  assert.equal(result.stdout, "done\n");
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
  assert.equal(result.stdout, "retry-success\n");
  assert.match(result.stderr, /temporary failure/);
  assert.match(result.stderr, /retrying 1\/1/);
});
