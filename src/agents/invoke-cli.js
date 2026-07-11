const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { AGENTS, MODEL_PROFILES } = require("./catalog");
const {
  createProviderRuntime,
  buildProviderInvocation,
  resolveProviderRunOptions,
} = require("./providers");
const { normalizeRunOptions } = require("./run-options");
const { SUPPORTED_GROK_EFFORTS, resolveGrokCommand } = require("./providers/grok");
const { resolveProxy, resolveProviderProxy, proxyEnvVars } = require("./proxy");

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5000;
const STDERR_BUFFER_LIMIT = 8192;
const SUPPORTED_GROK_MODELS = new Set(
  MODEL_PROFILES.filter((model) => model.providerId === "grok").map((model) => model.id)
);

function parseArgs(argv) {
  const args = [...argv];
  let agentName = "architect";
  const options = {
    // Provider adapters resolve environment-specific proxy fallbacks.
    proxy: "",
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
      options.killGraceMs = parsePositiveInteger(
        arg.slice("--kill-grace-ms=".length),
        "--kill-grace-ms"
      );
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
    throw new Error(
      `Unsupported agent "${agentName}". Use one of: ${Object.keys(AGENTS).join(", ")}.`
    );
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
  return buildProviderInvocation(config, prompt);
}

function extractAssistantText(event, state) {
  if (event.type === "assistant") {
    const content =
      event.message && Array.isArray(event.message.content) ? event.message.content : [];

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

    return part.text.startsWith(previous) ? part.text.slice(previous.length) : part.text;
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
  const providerId = cli.providerId || cli.name || "";
  const providerKey = providerId && cli.model ? `${providerId}:${cli.model}` : providerId;
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
  upsertAgentProviderSession(sessions, key, sessionId, workspaceKey, providerKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
}

function invoke(cli, prompt, options = {}) {
  const baseConfig = typeof cli === "string" ? { name: cli } : cli;
  const runOptions = normalizeRunOptions(options, {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    killGraceMs: DEFAULT_KILL_GRACE_MS,
    retries: 0,
  });
  const config = {
    ...baseConfig,
    providerOptions: {
      ...(baseConfig.providerOptions || {}),
      ...runOptions.providerOptions,
    },
  };
  const providerId = config.providerId || config.name;
  // Read session ID from env (set by server). If present, resume the previous
  // CLI session; if absent, cold start.
  const resumeSessionId = process.env.INVOKE_SESSION_ID || "";
  const resolvedCli = resumeSessionId ? { ...config, resumeSessionId } : config;
  const { command, args } = buildInvocation(resolvedCli, prompt);
  const runtime = resolveProviderRunOptions(config, runOptions);

  const invocationId = process.env.CAT_CAFE_INVOCATION_ID || "standalone";
  const rawEventLogEnabled = /^(1|true|yes|on)$/i.test(
    String(process.env.INVOKE_RAW_EVENT_LOG || "")
  );
  let rawEventLogPath = "";
  if (rawEventLogEnabled) {
    try {
      const { RUNTIME_DATA_DIR } = require("../server/runtime-paths");
      const rawDir = path.join(RUNTIME_DATA_DIR, "raw-events");
      fs.mkdirSync(rawDir, { recursive: true });
      const safeId =
        String(invocationId)
          .replace(/[^a-zA-Z0-9._-]/g, "_")
          .slice(0, 120) || "standalone";
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
        `${JSON.stringify({ ts: new Date().toISOString(), provider: providerId, raw })}\n`,
        "utf8"
      );
    } catch {
      // ignore logging failures
    }
  };

  const startAttempt = () => {
    attempt += 1;
    const providerRuntime = createProviderRuntime(config);
    const eventContext = {
      agent: config.id || providerId,
      invocationId,
    };

    // Avoid noisy stderr on every invoke (tests assert empty stderr). Log only
    // when explicitly requested, or when Grok is likely to hang without a proxy.
    if (
      runtime.proxy &&
      /^(1|true|yes|on)$/i.test(String(process.env.INVOKE_CLI_PROXY_LOG || ""))
    ) {
      console.error(`[invoke-cli] proxy for ${providerId || "cli"}: ${runtime.proxy}`);
    } else if (!runtime.proxy && providerId === "grok") {
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
    if (providerId === "grok" && process.env.GROK_PROXY && !childEnv.GROK_PROXY) {
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

    const activityTimer = setInterval(
      () => {
        if (Date.now() - lastActivity <= runtime.timeoutMs) return;

        timedOut = true;
        process.exitCode = 1;
        terminate(
          "SIGTERM",
          `${command} timed out after ${runtime.timeoutMs}ms of no stdout/stderr activity.`
        );
      },
      Math.max(10, Math.min(1000, Math.floor(runtime.timeoutMs / 2)))
    );

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

      const sessionId = providerRuntime.extractSessionId(event);
      if (sessionId) persistSessionId(config, sessionId);

      const events = providerRuntime.transform(event, eventContext);
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

      const finishProvider = (outcome) => {
        for (const outEvent of providerRuntime.finish(eventContext, outcome)) {
          emitEvent(outEvent);
        }
      };

      if (failedToStart) {
        finishProvider({
          terminal: true,
          ok: false,
          exitCode: code,
          signal,
          error: `Failed to start ${command}.`,
        });
        return;
      }

      if (signal) {
        finishProvider({
          terminal: true,
          ok: false,
          exitCode: code,
          signal,
          error: `${command} was killed by signal ${signal}.`,
        });
        console.error(`\n${command} process was killed by signal ${signal}`);
        process.exitCode = 1;
        return;
      }

      if (code !== 0) {
        if (!timedOut && attempt <= runtime.retries) {
          finishProvider({ terminal: false });
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
        finishProvider({
          terminal: true,
          ok: false,
          exitCode: code,
          signal: null,
          error: stderrTail.trim() || `${command} exited with code ${code}.`,
        });
        process.exitCode = code;
        return;
      }

      if (timedOut) {
        finishProvider({
          terminal: true,
          ok: false,
          exitCode: code,
          signal: null,
          error: `${command} timed out.`,
        });
        return;
      }

      finishProvider({ terminal: true, ok: true, exitCode: 0, signal: null });
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
