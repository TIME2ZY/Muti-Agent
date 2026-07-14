const { makeEvent } = require("../event-protocol");
const fs = require("node:fs");
const path = require("node:path");
const { resolveProxy } = require("../proxy");
const {
  toolNameFromItem,
  toolArgsFromItem,
  toolResultFromItem,
  isFailedItem,
  isSubagentTool,
  subagentDisplayName,
  summarizeTask,
  summarizeResult,
  toolItemId,
} = require("../tool-classification");

function createOpencodeRuntime(cli) {
  const parts = new Map();
  const reasoningParts = new Map();
  const toolStates = new Map();
  let emittedRunStarted = false;
  let lastStep = -1;

  function isReasoningPartType(type) {
    const t = String(type || "").toLowerCase();
    return t === "reasoning" || t === "thinking" || t === "thought" || t === "reason";
  }

  function reasoningTextFromPart(part) {
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
    if (typeof part.reasoning === "string") return part.reasoning;
    if (typeof part.thinking === "string") return part.thinking;
    return "";
  }

  /**
   * Map OpenCode reasoning/thinking parts into thinking.delta events.
   * Real CLI (with --thinking) emits: { type: "reasoning", part: { type: "reasoning", text } }
   * Streaming builds may also push message.part.updated with growing part.text.
   */
  function thinkingEventsFromPart(part, base) {
    if (!part || !isReasoningPartType(part.type)) return [];
    const next = reasoningTextFromPart(part);
    if (!next) return [];
    const id = part.id || "_reasoning";
    const prev = reasoningParts.get(id) || "";
    reasoningParts.set(id, next);
    if (!next.startsWith(prev)) {
      // Non-monotonic update: emit full snapshot as a delta replacement for the UI.
      return [makeEvent("thinking.delta", { ...base, text: next })];
    }
    const delta = next.slice(prev.length);
    return delta ? [makeEvent("thinking.delta", { ...base, text: delta })] : [];
  }

  function normalizePart(event) {
    const part = event.part || (event.properties && event.properties.part) || null;
    if (!part || typeof part !== "object") return null;
    // Some OpenCode builds nest live tool state under part.state.
    const state = part.state && typeof part.state === "object" ? part.state : null;
    if (state) {
      return {
        ...part,
        status: part.status || state.status || state.state || "",
        arguments:
          part.arguments || part.args || part.input || state.input || state.arguments || state.args,
        args: part.args || state.args,
        input: part.input || state.input,
        output: part.output !== undefined ? part.output : state.output,
        result: part.result !== undefined ? part.result : state.result,
        error: part.error !== undefined ? part.error : state.error,
        title: part.title || state.title || "",
      };
    }
    return part;
  }

  function extractStepNumber(event, part) {
    const candidates = [
      event && event.step,
      event && event.stepIndex,
      event && event.step_index,
      part && part.step,
      part && part.index,
    ];
    for (const value of candidates) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
  }

  function commandFromArgs(toolName, args) {
    if (!args || typeof args !== "object") return "";
    if (typeof args.command === "string" && args.command.trim()) return args.command.trim();
    if (typeof args.cmd === "string" && args.cmd.trim()) return args.cmd.trim();
    if (Array.isArray(args.command)) return args.command.map(String).join(" ");
    if (typeof args.pattern === "string" && /bash|shell|exec/i.test(toolName)) {
      return args.pattern.trim();
    }
    return "";
  }

  function toolLabelArgs(toolName, args) {
    if (!args || typeof args !== "object") return args || {};
    // Prefer compact labels for live UI / recall.
    if (typeof args.path === "string") return { path: args.path, ...args };
    if (typeof args.file === "string") return { path: args.file, ...args };
    if (typeof args.pattern === "string" && !args.command)
      return { pattern: args.pattern, ...args };
    return args;
  }

  function isBashLike(toolName) {
    const name = String(toolName || "").toLowerCase();
    return name === "bash" || name === "shell" || name === "exec" || name.endsWith(".bash");
  }

  function taskLabel(part, args) {
    if (part && typeof part.title === "string" && part.title.trim()) {
      return part.title.trim().slice(0, 120);
    }
    return summarizeTask(args);
  }

  function toolEventsFromPart(part, base) {
    if (!part || typeof part !== "object") return [];
    const type = String(part.type || "").toLowerCase();
    if (!(
      type === "tool" ||
      type === "tool_call" ||
      type === "toolcall" ||
      type === "mcp" ||
      type === "task" ||
      type === "bash" ||
      type === "read" ||
      type === "glob" ||
      type === "grep" ||
      type === "write" ||
      type === "edit"
    )) {
      if (!part.tool && !part.name && !part.toolName && !part.tool_name) return [];
    }

    const toolName = toolNameFromItem(part) || part.tool || part.name || type || "tool";
    const args = toolLabelArgs(toolName, toolArgsFromItem(part));
    const toolId = toolItemId(part, toolName);
    const status = String(part.status || part.state || "").toLowerCase();
    const prev = toolStates.get(toolId) || { started: false, finished: false };
    const events = [];

    const looksRunning =
      !status ||
      ["pending", "running", "in_progress", "start", "started", "call", "partial"].includes(status);
    const looksDone =
      [
        "completed",
        "complete",
        "done",
        "success",
        "ok",
        "error",
        "failed",
        "cancelled",
        "canceled",
      ].includes(status) ||
      part.output != null ||
      part.result != null ||
      part.error != null;

    if (!prev.started && (looksRunning || looksDone)) {
      events.push(
        makeEvent("tool.started", {
          ...base,
          toolName,
          args,
          toolId,
        })
      );
      const command = commandFromArgs(toolName, args);
      if (isBashLike(toolName) && command) {
        events.push(
          makeEvent("command.started", {
            ...base,
            command,
          })
        );
      }
      if (isSubagentTool(toolName, args) || type === "task") {
        events.push(
          makeEvent("subagent.started", {
            ...base,
            subagentId: toolId,
            name: subagentDisplayName(toolName, args),
            task: taskLabel(part, args),
            toolName,
          })
        );
      }
      prev.started = true;
    }

    if (
      !prev.finished &&
      looksDone &&
      status !== "running" &&
      status !== "in_progress" &&
      status !== "pending" &&
      status !== "partial"
    ) {
      const result = toolResultFromItem(part);
      const failed = isFailedItem(part) || status === "error" || status === "failed";
      events.push(
        makeEvent("tool.finished", {
          ...base,
          toolName,
          args,
          result,
          status: failed ? "error" : "ok",
          toolId,
        })
      );
      const command = commandFromArgs(toolName, args);
      if (isBashLike(toolName) && command) {
        events.push(
          makeEvent("command.finished", {
            ...base,
            command,
            output: typeof result === "string" ? result : summarizeResult(result),
            exitCode: failed ? 1 : 0,
          })
        );
      }
      if (isSubagentTool(toolName, args) || type === "task") {
        if (failed) {
          events.push(
            makeEvent("subagent.failed", {
              ...base,
              subagentId: toolId,
              name: subagentDisplayName(toolName, args),
              task: taskLabel(part, args),
              error: summarizeResult(result) || "subagent failed",
              toolName,
            })
          );
        } else {
          events.push(
            makeEvent("subagent.completed", {
              ...base,
              subagentId: toolId,
              name: subagentDisplayName(toolName, args),
              task: taskLabel(part, args),
              summary: summarizeResult(result),
              toolName,
            })
          );
        }
      }
      prev.finished = true;
    } else if (
      prev.started &&
      !prev.finished &&
      (part.output || part.result || part.title || part.text)
    ) {
      if (isSubagentTool(toolName, args) || type === "task") {
        events.push(
          makeEvent("subagent.progress", {
            ...base,
            subagentId: toolId,
            name: subagentDisplayName(toolName, args),
            text: summarizeResult(part.output || part.result || part.title || part.text),
            toolName,
          })
        );
      }
    }

    toolStates.set(toolId, prev);
    return events;
  }

  function maybeRunStarted(base, sessionId) {
    if (emittedRunStarted) return [];
    emittedRunStarted = true;
    return [
      makeEvent("run.started", {
        ...base,
        sessionId: sessionId || "",
        provider: cli.providerId,
        model: cli.model || "",
      }),
    ];
  }

  function progressForStep(base, stepNumber) {
    const step = stepNumber == null ? lastStep + 1 : stepNumber;
    if (step === lastStep) return [];
    lastStep = step;
    const label = `第 ${step} 步`;
    return [
      makeEvent("progress.update", {
        ...base,
        items: [{ text: label, done: false, step }],
      }),
    ];
  }

  return {
    extractSessionId(event) {
      if (
        event &&
        event.type === "session.updated" &&
        event.session &&
        typeof event.session.id === "string"
      ) {
        return event.session.id;
      }
      if (event && typeof event.sessionID === "string") {
        return event.sessionID;
      }
      if (event && typeof event.session_id === "string") {
        return event.session_id;
      }
      return "";
    },
    transform(event, ctx) {
      const base = {
        agent: ctx.agent,
        invocationId: ctx.invocationId,
      };

      const part = normalizePart(event);

      // Thinking / reasoning (requires `opencode run --thinking` on the CLI).
      if (
        event.type === "reasoning" ||
        event.type === "thinking" ||
        (part && isReasoningPartType(part.type))
      ) {
        const thinkingPart =
          part && isReasoningPartType(part.type)
            ? part
            : {
                type: event.type || "reasoning",
                id: (part && part.id) || event.id || "_reasoning",
                text: reasoningTextFromPart(part) || reasoningTextFromPart(event),
              };
        const thinking = thinkingEventsFromPart(thinkingPart, base);
        if (thinking.length) return thinking;
      }

      if (event.type === "message.part.updated" && part && part.type === "text") {
        const id = part.id || "_default";
        const next = typeof part.text === "string" ? part.text : "";
        const prev = parts.get(id) || "";
        parts.set(id, next);
        if (!next.startsWith(prev)) {
          return [makeEvent("text.delta", { ...base, text: next })];
        }
        const delta = next.slice(prev.length);
        return delta ? [makeEvent("text.delta", { ...base, text: delta })] : [];
      }

      if (event.type === "message.part.updated" && part && isReasoningPartType(part.type)) {
        const thinking = thinkingEventsFromPart(part, base);
        if (thinking.length) return thinking;
      }

      if (event.type === "message.part.updated" && part) {
        const toolEvents = toolEventsFromPart(part, base);
        if (toolEvents.length) return toolEvents;
      }

      // OpenCode current schema: top-level type is "tool_use" with part.type="tool".
      // Older builds may emit tool / tool_call / tool.updated instead.
      if (
        event.type === "tool_use" ||
        event.type === "tool-use" ||
        event.type === "tool" ||
        event.type === "tool_call" ||
        event.type === "tool.updated"
      ) {
        const toolPart = part || event;
        const toolEvents = toolEventsFromPart(
          {
            ...toolPart,
            type: toolPart.type || "tool",
            tool: toolPart.tool || toolPart.name,
            callID: toolPart.callID || toolPart.callId || toolPart.call_id,
          },
          base
        );
        if (toolEvents.length) return toolEvents;
      }

      if (event.type === "session.updated") {
        const sessionId = event.session && event.session.id ? event.session.id : "";
        return maybeRunStarted(base, sessionId);
      }

      if (event.type === "step_start" || event.type === "step.start" || event.type === "loop") {
        const sessionId =
          typeof event.sessionID === "string"
            ? event.sessionID
            : typeof event.session_id === "string"
              ? event.session_id
              : "";
        const stepNumber = extractStepNumber(event, part);
        const out = [];
        out.push(...maybeRunStarted(base, sessionId));
        out.push(...progressForStep(base, stepNumber));
        return out;
      }

      if (
        event.type === "step_finish" ||
        event.type === "step.finish" ||
        event.type === "step-finish"
      ) {
        const reason = (part && part.reason) || event.reason || "";
        const label =
          reason === "tool-calls"
            ? "步骤完成（已调用工具）"
            : reason === "stop"
              ? "步骤完成"
              : reason
                ? `步骤完成: ${reason}`
                : "步骤完成";
        return [
          makeEvent("progress.update", {
            ...base,
            items: [{ text: label, done: true, reason }],
          }),
        ];
      }

      // part.type === "step-start" nested under other envelopes
      if (part && (part.type === "step-start" || part.type === "step_start")) {
        const sessionId = typeof event.sessionID === "string" ? event.sessionID : "";
        const stepNumber = extractStepNumber(event, part);
        const out = [];
        out.push(...maybeRunStarted(base, sessionId));
        out.push(...progressForStep(base, stepNumber));
        return out;
      }

      if (event.type === "assistant") {
        const content =
          event.message && Array.isArray(event.message.content) ? event.message.content : [];
        const text = content
          .filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("");
        return text ? [makeEvent("text.delta", { ...base, text })] : [];
      }

      if (event.type === "text" && part && part.type === "text" && typeof part.text === "string") {
        return [
          makeEvent("text.delta", {
            ...base,
            text: part.text,
          }),
        ];
      }

      return [];
    },
  };
}

const OPENCODE_GO_MODEL_PREFIX = "opencode-go/";

function resolveOpencodeCommand() {
  if (process.platform !== "win32") return "opencode";
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const command = path.join(entry, "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (fs.existsSync(command)) return command;
  }
  return "opencode.exe";
}

const opencodeProvider = {
  id: "opencode",
  capabilities: {
    resume: true,
    thinking: true,
    tools: true,
    subagents: true,
    reasoning: "toggle",
  },
  allowedProviderOptions: ["thinking", "modelPrefix"],
  createRuntime: createOpencodeRuntime,
  resolveProxy,
  buildInvocation(config, prompt) {
    const providerOptions = config.providerOptions || {};
    const args = ["run", "--format", "json"];
    if (providerOptions.thinking !== false) args.push("--thinking");
    if (config.model) {
      const modelPrefix = providerOptions.modelPrefix ?? OPENCODE_GO_MODEL_PREFIX;
      const fullModel = config.model.startsWith(OPENCODE_GO_MODEL_PREFIX)
        ? config.model
        : `${modelPrefix}${config.model}`;
      args.push("--model", fullModel);
    }
    if (config.resumeSessionId) args.push("--session", config.resumeSessionId);
    args.push(prompt);
    return { command: resolveOpencodeCommand(), args };
  },
};

module.exports = {
  createOpencodeRuntime,
  opencodeProvider,
  OPENCODE_GO_MODEL_PREFIX,
  resolveOpencodeCommand,
};
