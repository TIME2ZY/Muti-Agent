const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { createProviderRuntime } = require("./providers");
const { resolveProxy, resolveProviderProxy, proxyEnvVars } = require("./proxy");

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
const SUPPORTED_GROK_MODELS = new Set(["grok-4.5"]);
const SUPPORTED_GROK_EFFORTS = new Set(["low", "medium", "high"]);
const AGENTS = {
  architect: {
    id: "architect",
    label: "Codex",
    name: "codex",
    model: "gpt-5.5",
    reasoningEffort: "high",
    description: "默认主控 Agent，负责规划与编排。",
  },
  orchestrator: {
    id: "orchestrator",
    label: "万事通",
    name: "opencode",
    model: "deepseek-v4-pro",
    description: "通才型助手，兜底各种杂活与跨领域问题。",
  },
  planner: {
    id: "planner",
    label: "小谋",
    name: "opencode",
    model: "mimo-v2.5-pro",
    description: "推理与规划专家，擅长任务拆解、方案设计与决策建议。",
  },
  coder: {
    id: "coder",
    label: "小码",
    name: "opencode",
    model: "minimax-m3",
    reasoningEffort: "high",
    description: "Coding 主力，负责服务端与通用代码实现与重构。",
  },
  /**
   * Grok 4.5 via local Grok Build CLI (same pattern as codex / opencode).
   * Requires `grok` on PATH (`curl -fsSL https://x.ai/cli/install.sh | bash`
   * or Windows: `irm https://x.ai/cli/install.ps1 | iex`), then `grok login`
   * or XAI_API_KEY.
   */
  grok: {
    id: "grok",
    label: "Grok",
    name: "grok",
    model: "grok-4.5",
    reasoningEffort: "high",
    // Grok 4.5 context window is 500k; use it for sealer thresholds.
    capacityTokens: 500_000,
    description: "Grok 4.5 high — 本地 Grok Build CLI 编码与硬推理主力。",
  },
  frontend: {
    id: "frontend",
    label: "小视",
    name: "opencode",
    model: "glm-5.2",
    description: "前端 Coding 专家，专注 UI、样式、交互与可访问性。",
  },
  critic: {
    id: "critic",
    label: "小评",
    name: "opencode",
    model: "qwen3.7-plus",
    description: "Review 专家，负责代码评审、问题诊断与质量把关。",
  },
};

function parseArgs(argv) {
  const args = [...argv];
  let agentName = "architect";
  const options = {
    // Prefer explicit INVOKE_CLI_PROXY, else inherit shell HTTPS_PROXY/HTTP_PROXY.
    proxy: resolveProxy(),
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

    // --thinking: stream reasoning/thinking parts as JSON events (otherwise omitted).
    const args = ["run", "--format", "json", "--thinking"];
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

  if (config.name === "grok") {
    validateModel(config.name, config.model);
    const effort = config.reasoningEffort || "high";
    if (!SUPPORTED_GROK_EFFORTS.has(effort)) {
      throw new Error(
        `Unsupported Grok reasoning effort "${effort}". Supported: ${[...SUPPORTED_GROK_EFFORTS].join(", ")}.`
      );
    }
    // Local Grok Build CLI (same pattern as codex / opencode):
    //   grok -p "..." --output-format streaming-json -m grok-4.5 --reasoning-effort high
    // Auth: `grok login` or XAI_API_KEY in the environment.
    const args = [
      "-p",
      prompt,
      "--output-format",
      "streaming-json",
      "--always-approve",
      "--no-auto-update",
    ];
    if (config.model) args.push("-m", config.model);
    if (effort) args.push("--reasoning-effort", effort);
    if (config.resumeSessionId) {
      args.push("-r", config.resumeSessionId);
    }
    return {
      command: resolveGrokCommand(),
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

  if (cliName === "grok" && !SUPPORTED_GROK_MODELS.has(model)) {
    throw new Error(
      `Unsupported grok model "${model}". Supported models: ${[...SUPPORTED_GROK_MODELS].join(", ")}.`
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

/**
 * Resolve the local Grok Build CLI binary.
 * Default install paths: ~/.grok/bin/grok(.exe) or PATH.
 */
function resolveGrokCommand() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [];
  if (home) {
    candidates.push(path.join(home, ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok"));
  }
  for (const entry of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(entry, process.platform === "win32" ? "grok.exe" : "grok"));
  }
  for (const command of candidates) {
    try {
      if (fs.existsSync(command)) return command;
    } catch {
      // ignore
    }
  }
  return process.platform === "win32" ? "grok.exe" : "grok";
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

/**
 * Write the session ID for this agent to the per-chat-session file so the
 * server can read it back for the next invocation in the same chat session.
 * Provider sessions are stored per workspaceKey so base/worktree do not overwrite.
 */
function persistSessionId(cli, sessionId) {
  const file = process.env.INVOKE_SESSION_FILE;
  if (!file || !sessionId) return;
  const key = cli.id || cli.name;
  const workspaceKey = process.env.INVOKE_WORKSPACE_KEY || "";
  const { upsertAgentProviderSession } = require("../server/session-map-store");
  let sessions = {};
  try {
    if (fs.existsSync(file)) {
      sessions = JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    // corrupted file → start fresh
  }
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
    sessions = {};
  }
  upsertAgentProviderSession(sessions, key, sessionId, workspaceKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
}

function invoke(cli, prompt, options = {}) {
  const config = typeof cli === "string" ? { name: cli } : cli;
  const provider = createProviderRuntime(config);
  // Read session ID from env (set by server). If present, resume the previous
  // CLI session; if absent, cold start.
  const resumeSessionId = process.env.INVOKE_SESSION_ID || "";
  const resolvedCli = resumeSessionId ? { ...config, resumeSessionId } : config;
  const { command, args } = buildInvocation(resolvedCli, prompt);
  const runtime = {
    // Per-provider proxy: Grok can use GROK_PROXY only; codex/opencode use
    // shared INVOKE_CLI_PROXY / HTTPS_PROXY (and never pick GROK_PROXY alone).
    proxy: resolveProviderProxy(config.name, { proxy: options.proxy }),
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    killGraceMs: options.killGraceMs || DEFAULT_KILL_GRACE_MS,
    retries: options.retries || 0,
  };

  const invocationId = process.env.CAT_CAFE_INVOCATION_ID || "standalone";
  const rawEventLogEnabled = /^(1|true|yes|on)$/i.test(String(process.env.INVOKE_RAW_EVENT_LOG || ""));
  let rawEventLogPath = "";
  if (rawEventLogEnabled) {
    try {
      const { RUNTIME_DATA_DIR } = require("../server/runtime-paths");
      const rawDir = path.join(RUNTIME_DATA_DIR, "raw-events");
      fs.mkdirSync(rawDir, { recursive: true });
      const safeId = String(invocationId).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "standalone";
      rawEventLogPath = path.join(rawDir, `${safeId}.jsonl`);
    } catch {
      rawEventLogPath = "";
    }
  }

  let firstChild;
  let attempt = 0;

  const emitEvent = (event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };

  const logRawEvent = (raw) => {
    if (!rawEventLogPath) return;
    try {
      fs.appendFileSync(
        rawEventLogPath,
        `${JSON.stringify({ ts: new Date().toISOString(), provider: config.name, raw })}\n`,
        "utf8"
      );
    } catch {
      // ignore logging failures
    }
  };

  const startAttempt = () => {
    attempt += 1;

    // Avoid noisy stderr on every invoke (tests assert empty stderr). Log only
    // when explicitly requested, or when Grok is likely to hang without a proxy.
    if (runtime.proxy && /^(1|true|yes|on)$/i.test(String(process.env.INVOKE_CLI_PROXY_LOG || ""))) {
      console.error(`[invoke-cli] proxy for ${config.name || "cli"}: ${runtime.proxy}`);
    } else if (!runtime.proxy && config.name === "grok") {
      console.error(
        "[invoke-cli] no proxy for grok; if requests hang, set GROK_PROXY=http://127.0.0.1:7892 (Grok-only) or INVOKE_CLI_PROXY / HTTPS_PROXY"
      );
    }

    // Inject HTTP(S)_PROXY only into this CLI child. For Grok-only setups the
    // parent may have GROK_PROXY set without polluting codex/opencode.
    const childEnv = {
      ...process.env,
      ...proxyEnvVars(runtime.proxy),
    };
    // Keep GROK_PROXY visible to nested tools if user set it.
    if (config.name === "grok" && process.env.GROK_PROXY && !childEnv.GROK_PROXY) {
      childEnv.GROK_PROXY = process.env.GROK_PROXY;
    }

    const child = spawn(command, args, {
      env: childEnv,
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
        logRawEvent({ parseError: true, line });
        return;
      }

      logRawEvent(event);

      const sessionId = provider.extractSessionId(event);
      if (sessionId) persistSessionId(config, sessionId);

      const events = provider.transform(event, {
        agent: config.id || config.name,
        invocationId,
      });
      for (const outEvent of events) emitEvent(outEvent);
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

      emitEvent({
        type: "run.finished",
        agent: config.id || config.name,
        invocationId,
        exitCode: 0,
        signal: null,
      });
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
  SUPPORTED_GROK_MODELS,
  SUPPORTED_GROK_EFFORTS,
  invoke,
  parseArgs,
  buildInvocation,
  resolveGrokCommand,
  resolveProxy,
  resolveProviderProxy,
  proxyEnvVars,
  extractAssistantText,
};
