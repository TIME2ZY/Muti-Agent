const fs = require("node:fs");
const path = require("node:path");
const { makeEvent } = require("../event-protocol");
const { resolveProxy } = require("../proxy");

/**
 * Google Antigravity CLI provider (`agy`).
 *
 * Local binary (Windows): `%LOCALAPPDATA%\agy\bin\agy.exe` (also on PATH as `agy`).
 *
 * Headless usage (verified locally):
 *   agy -p "..." --model "Gemini 3.5 Flash (High)" --dangerously-skip-permissions
 *
 * Available models (agy models):
 *   Gemini 3.5 Flash (Low|Medium|High)
 *   Gemini 3.1 Pro (Low|High)
 *   Claude Sonnet 4.6 (Thinking) / Claude Opus 4.6 (Thinking)
 *   GPT-OSS 120B (Medium)
 *
 * Notable flags (agy --help):
 *   -p / --print / --prompt   non-interactive single prompt
 *   --model                   model label (includes effort in the name)
 *   --conversation <id>       resume conversation
 *   --continue / -c           resume most recent
 *   --dangerously-skip-permissions
 *   --mode accept-edits|plan
 *   --sandbox
 *   --print-timeout
 *   --add-dir / --project / --agent
 *
 * Print mode writes **plain text** to stdout (not NDJSON). The runtime exposes
 * parseStdoutLine() so process-supervisor can wrap lines as synthetic events.
 */

const SUPPORTED_EFFORTS = new Set(["low", "medium", "high"]);
const SUPPORTED_MODES = new Set(["accept-edits", "plan"]);

/** Catalog model id → CLI family label prefix. */
const MODEL_FAMILY = {
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-3.1-pro": "Gemini 3.1 Pro",
};

/**
 * Map catalog model + reasoningEffort to the Antigravity CLI --model string.
 * Effort is embedded in the model label (not a separate flag).
 */
function resolveAgyModelLabel(modelId, reasoningEffort = "high") {
  const raw = String(modelId || "").trim();
  if (!raw) return "Gemini 3.5 Flash (High)";
  // Already a full CLI label, e.g. "Gemini 3.5 Flash (High)"
  if (/\(.*\)\s*$/.test(raw)) return raw;

  const family = MODEL_FAMILY[raw] || raw;
  const effortRaw = String(reasoningEffort || "high").toLowerCase();
  const effort = SUPPORTED_EFFORTS.has(effortRaw) ? effortRaw : "high";
  const effortLabel = effort.charAt(0).toUpperCase() + effort.slice(1);
  return `${family} (${effortLabel})`;
}

function resolveAgyCommand(env = process.env) {
  if (env.AGY_PATH && String(env.AGY_PATH).trim()) return String(env.AGY_PATH).trim();
  if (env.ANTIGRAVITY_PATH && String(env.ANTIGRAVITY_PATH).trim()) {
    return String(env.ANTIGRAVITY_PATH).trim();
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    if (local) {
      const candidate = path.join(local, "agy", "bin", "agy.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "agy";
}

function createAntigravityRuntime(cli) {
  let emittedRunStarted = false;
  const modelLabel = resolveAgyModelLabel(cli && cli.model, cli && cli.reasoningEffort);

  return {
    /**
     * Print mode does not emit conversation ids on stdout, so resume cannot be
     * wired through the normal session-map path.
     */
    extractSessionId() {
      return "";
    },
    /**
     * Convert a non-JSON stdout line into a synthetic event for transform().
     * @returns {{ type: string, text: string } | null}
     */
    parseStdoutLine(line) {
      if (typeof line !== "string" || !line.length) return null;
      return { type: "agy.stdout", text: line };
    },
    transform(event, ctx) {
      const base = {
        agent: ctx.agent,
        invocationId: ctx.invocationId,
      };
      if (!event || typeof event !== "object") return [];

      const out = [];
      const ensureStarted = () => {
        if (emittedRunStarted) return;
        emittedRunStarted = true;
        out.push(
          makeEvent("run.started", {
            ...base,
            sessionId: "",
            provider: "antigravity",
            model: modelLabel,
          })
        );
      };

      if (event.type === "agy.stdout") {
        ensureStarted();
        const text = typeof event.text === "string" ? event.text : "";
        if (text) {
          // Preserve line breaks so multi-line print output reconstructs cleanly.
          out.push(makeEvent("text.delta", { ...base, text: `${text}\n` }));
        }
        return out;
      }

      // Forward already-normalized or unexpected structured events best-effort.
      if (event.type === "text.delta" && typeof event.text === "string") {
        ensureStarted();
        out.push(makeEvent("text.delta", { ...base, text: event.text }));
        return out;
      }

      return out;
    },
    finish() {
      return [];
    },
  };
}

const antigravityProvider = {
  id: "antigravity",
  capabilities: {
    // --conversation works when a caller already has an id, but print mode never
    // emits session ids on stdout, so the server cannot persist resume handles.
    // Advertise false until extractSessionId has a real source.
    resume: false,
    thinking: false,
    tools: true,
    subagents: false,
    reasoning: "levels",
  },
  allowedProviderOptions: ["mode", "sandbox", "skipPermissions", "printTimeout", "addDirs"],
  createRuntime: createAntigravityRuntime,
  resolveProxy,
  validate(config) {
    const effort = config.reasoningEffort || "high";
    if (effort && !SUPPORTED_EFFORTS.has(effort)) {
      throw new Error(
        `Unsupported Antigravity reasoning effort "${effort}". Supported: ${[
          ...SUPPORTED_EFFORTS,
        ].join(", ")}.`
      );
    }
    const mode = config.providerOptions && config.providerOptions.mode;
    if (mode && !SUPPORTED_MODES.has(mode)) {
      throw new Error(
        `Unsupported Antigravity mode "${mode}". Supported: ${[...SUPPORTED_MODES].join(", ")}.`
      );
    }
  },
  buildInvocation(config, prompt) {
    const providerOptions = config.providerOptions || {};
    const modelLabel = resolveAgyModelLabel(config.model, config.reasoningEffort);
    const args = ["-p", prompt, "--model", modelLabel];

    // Headless default: auto-approve tool calls (same role as codex -a never).
    if (providerOptions.skipPermissions !== false) {
      args.push("--dangerously-skip-permissions");
    }
    // Brainstorming agent defaults to plan mode (ideas without silent writes).
    // Override with providerOptions.mode = "accept-edits" or "" to clear.
    const mode =
      providerOptions.mode === undefined || providerOptions.mode === null
        ? "plan"
        : providerOptions.mode;
    if (mode) args.push("--mode", mode);

    if (providerOptions.sandbox === true) args.push("--sandbox");
    if (providerOptions.printTimeout) {
      args.push("--print-timeout", String(providerOptions.printTimeout));
    }
    if (Array.isArray(providerOptions.addDirs)) {
      for (const dir of providerOptions.addDirs) {
        if (dir) args.push("--add-dir", String(dir));
      }
    }
    if (config.resumeSessionId) {
      args.push("--conversation", config.resumeSessionId);
    }

    return { command: resolveAgyCommand(), args };
  },
};

module.exports = {
  SUPPORTED_EFFORTS,
  SUPPORTED_MODES,
  MODEL_FAMILY,
  resolveAgyModelLabel,
  resolveAgyCommand,
  createAntigravityRuntime,
  antigravityProvider,
};
