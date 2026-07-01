const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5000;
const STDERR_BUFFER_LIMIT = 8192;
const SUPPORTED_CODEX_MODELS = new Set(["gpt-5.5", "gpt-5.4"]);
const OPENCODE_GO_MODEL_PREFIX = "opencode-go/";
const SUPPORTED_OPENCODE_GO_MODELS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5.1",
  "glm-5.2",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "minimax-m2.7",
  "minimax-m3",
  "qwen3.6-plus",
  "qwen3.7-max",
  "qwen3.7-plus",
]);
const AGENTS = {
  architect: {
    id: "architect",
    label: "Codex",
    name: "codex",
    model: "gpt-5.5",
    reasoningEffort: "high",
  },
  forge: {
    id: "forge",
    label: "小虎鲸",
    name: "opencode",
    model: "deepseek-v4-pro",
  },
  sage: {
    id: "sage",
    label: "小智",
    name: "opencode",
    model: "glm-5.2",
  },
  reviewer: {
    id: "reviewer",
    label: "M-M",
    name: "opencode",
    model: "minimax-m3",
  },
};

function parseArgs(argv) {
  const args = [...argv];
  let agentName = "architect";
  const options = {
    proxy: process.env.INVOKE_CLI_PROXY || "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    killGraceMs: DEFAULT_KILL_GRACE_MS,
    retries: 0,
  };

  while (args.length > 0) {
    const arg = args[0];

    if (arg === "--") {
      args.shift();
      break;
    }

    if (arg === "--agent") {
      agentName = args[1];
      args.splice(0, 2);
      continue;
    }

    if (arg.startsWith("--agent=")) {
      agentName = arg.slice("--agent=".length);
      args.shift();
      continue;
    }

    if (arg === "--proxy") {
      options.proxy = args[1];
      args.splice(0, 2);
      continue;
    }

    if (arg.startsWith("--proxy=")) {
      options.proxy = arg.slice("--proxy=".length);
      args.shift();
      continue;
    }

    if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(args[1], "--timeout-ms");
      args.splice(0, 2);
      continue;
    }

    if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = parsePositiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
      args.shift();
      continue;
    }

    if (arg === "--kill-grace-ms") {
      options.killGraceMs = parsePositiveInteger(args[1], "--kill-grace-ms");
      args.splice(0, 2);
      continue;
    }

    if (arg.startsWith("--kill-grace-ms=")) {
      options.killGraceMs = parsePositiveInteger(arg.slice("--kill-grace-ms=".length), "--kill-grace-ms");
      args.shift();
      continue;
    }

    if (arg === "--retries") {
      options.retries = parseNonNegativeInteger(args[1], "--retries");
      args.splice(0, 2);
      continue;
    }

    if (arg.startsWith("--retries=")) {
      options.retries = parseNonNegativeInteger(arg.slice("--retries=".length), "--retries");
      args.shift();
      continue;
    }

    break;
  }

  const agent = AGENTS[agentName];
  if (!agent) {
    throw new Error(`Unsupported agent "${agentName}". Use one of: ${Object.keys(AGENTS).join(", ")}.`);
  }

  return {
    cli: {
      ...agent,
    },
    options,
    prompt: args.join(" "),
  };
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return parsed;
}

function buildInvocation(cli, prompt) {
  const config = typeof cli === "string" ? { name: cli } : cli;

  if (config.name === "opencode") {
    validateModel(config.name, config.model);

    const args = ["run", "--format", "json"];
    if (config.model) {
      const fullModel = config.model.startsWith(OPENCODE_GO_MODEL_PREFIX)
        ? config.model
        : `${OPENCODE_GO_MODEL_PREFIX}${config.model}`;
      args.push("--model", fullModel);
    }
    if (config.resumeSessionId) args.push("--session", config.resumeSessionId);
    args.push(prompt);

    return {
      command: resolveOpencodeCommand(),
      args,
    };
  }

  validateModel(config.name, config.model);

  const args = ["-s", "danger-full-access", "-a", "never"];
  if (config.reasoningEffort) args.push("-c", `model_reasoning_effort="${config.reasoningEffort}"`);
  if (config.model) args.push("-m", config.model);
  if (config.resumeSessionId) {
    args.push("exec", "resume", "--json", config.resumeSessionId, prompt);
  } else {
    args.push("exec", "--json", prompt);
  }

  return {
    command: "codex",
    args,
  };
}

function validateModel(cliName, model) {
  if (!model) return;

  if (cliName === "codex" && !SUPPORTED_CODEX_MODELS.has(model)) {
    throw new Error(
      `Unsupported codex model "${model}". Supported models: ${[...SUPPORTED_CODEX_MODELS].join(", ")}.`
    );
  }

  if (cliName === "opencode" && !SUPPORTED_OPENCODE_GO_MODELS.has(model)) {
    throw new Error(
      `Unsupported opencode model "${model}". Supported Go subscription models: ${[...SUPPORTED_OPENCODE_GO_MODELS].join(", ")}.`
    );
  }
}

function resolveOpencodeCommand() {
  if (process.platform !== "win32") return "opencode";

  const pathEntries = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);

  for (const entry of pathEntries) {
    const command = path.join(entry, "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (fs.existsSync(command)) return command;
  }

  return "opencode.exe";
}

function extractAssistantText(event, state) {
  if (event.type === "assistant") {
    const content = event.message && Array.isArray(event.message.content)
      ? event.message.content
      : [];

    return content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("");
  }

  if (event.item && event.item.type === "agent_message" && typeof event.item.text === "string") {
    return event.item.text;
  }

  const part = event.part || (event.properties && event.properties.part);
  if (part && part.type === "text" && typeof part.text === "string") {
    const partId = part.id || "_default";
    const previous = state.opencodeParts.get(partId) || "";
    state.opencodeParts.set(partId, part.text);

    return part.text.startsWith(previous)
      ? part.text.slice(previous.length)
      : part.text;
  }

  const content = event.content || (event.properties && event.properties.content);
  if (content && content.type === "text" && typeof content.text === "string") {
    return content.text;
  }

  return "";
}

function extractSessionId(event) {
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    return event.thread_id;
  }

  if (event.session && typeof event.session.id === "string") {
    return event.session.id;
  }

  if (typeof event.sessionID === "string") {
    return event.sessionID;
  }

  if (typeof event.session_id === "string") {
    return event.session_id;
  }

  return "";
}

/**
 * Write the session ID for this agent to the per-chat-session file so the
 * server can read it back for the next invocation in the same chat session.
 */
function persistSessionId(cli, sessionId) {
  const file = process.env.INVOKE_SESSION_FILE;
  if (!file || !sessionId) return;
  const key = cli.id || cli.name;
  let sessions = {};
  try {
    if (fs.existsSync(file)) {
      sessions = JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    // corrupted file → start fresh
  }
  sessions[key] = {
    sessionId,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
}

function invoke(cli, prompt, options = {}) {
  const config = typeof cli === "string" ? { name: cli } : cli;
  // Read session ID from env (set by server). If present, resume the previous
  // CLI session; if absent, cold start.
  const resumeSessionId = process.env.INVOKE_SESSION_ID || "";
  const resolvedCli = resumeSessionId ? { ...config, resumeSessionId } : config;
  const { command, args } = buildInvocation(resolvedCli, prompt);
  const runtime = {
    proxy: options.proxy || process.env.INVOKE_CLI_PROXY || "",
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    killGraceMs: options.killGraceMs || DEFAULT_KILL_GRACE_MS,
    retries: options.retries || 0,
  };

  const state = {
    opencodeParts: new Map(),
  };

  let firstChild;
  let attempt = 0;

  const startAttempt = () => {
    attempt += 1;

    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...(runtime.proxy ? {
          HTTP_PROXY: runtime.proxy,
          HTTPS_PROXY: runtime.proxy,
          ALL_PROXY: runtime.proxy,
          http_proxy: runtime.proxy,
          https_proxy: runtime.proxy,
          all_proxy: runtime.proxy,
        } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (!firstChild) firstChild = child;

    let failedToStart = false;
    let timedOut = false;
    let closed = false;
    let lastActivity = Date.now();
    let stderrTail = "";
    let killTimer;

    const markActivity = () => {
      lastActivity = Date.now();
    };

    const appendStderr = (chunk) => {
      stderrTail += chunk.toString();
      if (stderrTail.length > STDERR_BUFFER_LIMIT) {
        stderrTail = stderrTail.slice(-STDERR_BUFFER_LIMIT);
      }
    };

    const cleanupHandlers = [];
    const clearTimers = () => {
      clearInterval(activityTimer);
      clearTimeout(killTimer);
    };

    const terminate = (signal, reason) => {
      if (closed) return;
      if (reason) console.error(reason);

      killTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, runtime.killGraceMs);

      child.kill(signal);
    };

    const activityTimer = setInterval(() => {
      if (Date.now() - lastActivity <= runtime.timeoutMs) return;

      timedOut = true;
      process.exitCode = 1;
      terminate(
        "SIGTERM",
        `${command} timed out after ${runtime.timeoutMs}ms of no stdout/stderr activity.`
      );
    }, Math.max(10, Math.min(1000, Math.floor(runtime.timeoutMs / 2))));

    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        process.exitCode = 1;
        terminate(signal, `${command} received ${signal}; forwarding to child process.`);
      };
      process.once(signal, handler);
      cleanupHandlers.push(() => process.removeListener(signal, handler));
    }

    child.stdout.on("data", markActivity);

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      if (!line.trim()) return;

      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        console.error("Failed to parse JSON line:", line);
        return;
      }

      const sessionId = extractSessionId(event);
      if (sessionId) persistSessionId(config, sessionId);

      const text = extractAssistantText(event, state);
      if (text) process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      markActivity();
      appendStderr(chunk);
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      failedToStart = true;
      console.error(`Failed to start ${command}:`, error.message);
      process.exitCode = 1;
    });

    child.on("close", (code, signal) => {
      closed = true;
      clearTimers();
      cleanupHandlers.forEach((cleanup) => cleanup());
      rl.close();

      if (failedToStart) return;

      if (signal) {
        console.error(`\n${command} process was killed by signal ${signal}`);
        process.exitCode = 1;
        return;
      }

      if (code !== 0) {
        if (!timedOut && attempt <= runtime.retries) {
          console.error(
            `${command} ${args.join(" ")} exited with code ${code}; retrying ${attempt}/${runtime.retries}.`
          );
          startAttempt();
          return;
        }

        console.error(`\n${command} ${args.join(" ")} exited with code ${code}`);
        if (stderrTail.trim()) {
          console.error(`Recent stderr:\n${stderrTail.trim()}`);
        }
        process.exitCode = code;
        return;
      }

      if (timedOut) return;

      process.stdout.write("\n");
    });

    return child;
  };

  startAttempt();
  return firstChild;
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (!parsed.prompt) {
    console.error(
      'Usage: node src/agents/invoke-cli.js [--agent architect|forge|sage|reviewer] [--timeout-ms ms] "你好，请用一句话介绍自己"'
    );
    process.exit(1);
  }

  try {
    invoke(parsed.cli, parsed.prompt, parsed.options);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  AGENTS,
  invoke,
  parseArgs,
  buildInvocation,
  extractAssistantText,
};
