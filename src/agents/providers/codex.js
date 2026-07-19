const { makeEvent } = require("../event-protocol");
const { makeUsageEvent } = require("../usage");
const { resolveProxy } = require("../proxy");
const {
  toolNameFromItem,
  toolArgsFromItem,
  toolResultFromItem,
  isFailedItem,
  toolItemId,
} = require("../tool-classification");

function createCodexRuntime(cli) {
  function fileChangeEvents(base, item) {
    const changes = item && Array.isArray(item.changes) ? item.changes : [];
    return changes
      .filter((change) => change && typeof change.path === "string")
      .map((change) =>
        makeEvent("file.changed", {
          ...base,
          path: change.path,
          changeType: change.kind || "",
        })
      );
  }

  function isToolLikeItem(item) {
    if (!item || typeof item !== "object") return false;
    const type = String(item.type || "").toLowerCase();
    return (
      type === "mcp_tool_call" ||
      type === "mcptoolcall" ||
      type === "function_call" ||
      type === "functioncall" ||
      type === "tool_call" ||
      type === "toolcall" ||
      type === "web_search" ||
      type === "websearch" ||
      Boolean(toolNameFromItem(item))
    );
  }

  function reasoningTextFromItem(item) {
    if (!item || typeof item !== "object") return "";
    if (typeof item.text === "string" && item.text) return item.text;
    if (typeof item.content === "string" && item.content) return item.content;
    if (typeof item.summary === "string" && item.summary) return item.summary;
    if (Array.isArray(item.summary) && item.summary.length) {
      return item.summary
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part.text === "string") return part.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  function toolLifecycleEvents(base, item, phase) {
    if (!isToolLikeItem(item)) return [];
    const toolName = toolNameFromItem(item) || String(item.type || "tool");
    const args = toolArgsFromItem(item);
    const toolId = toolItemId(item, toolName);

    if (phase === "started") {
      return [
        makeEvent("tool.started", {
          ...base,
          toolName,
          args,
          toolId,
        }),
      ];
    }

    const result = toolResultFromItem(item);
    const failed = isFailedItem(item);
    return [
      makeEvent("tool.finished", {
        ...base,
        toolName,
        result,
        status: failed ? "error" : "ok",
        toolId,
      }),
    ];
  }

  return {
    extractSessionId(event) {
      return event && event.type === "thread.started" && typeof event.thread_id === "string"
        ? event.thread_id
        : "";
    },
    transform(event, ctx) {
      const base = {
        agent: ctx.agent,
        invocationId: ctx.invocationId,
      };

      if (event.type === "thread.started") {
        return [
          makeEvent("run.started", {
            ...base,
            sessionId: event.thread_id || "",
            provider: cli.providerId,
            model: cli.model || "",
          }),
        ];
      }

      if (event.type === "error" && typeof event.message === "string") {
        return [
          makeEvent("stderr", {
            ...base,
            text: event.message,
          }),
        ];
      }

      if (event.type === "item.started" && event.item && event.item.type === "command_execution") {
        const command = event.item.command || "";
        const toolId = toolItemId(event.item, "command_execution");
        return [
          makeEvent("tool.started", {
            ...base,
            toolName: "command_execution",
            toolId,
            args: { command },
          }),
        ];
      }

      if (
        event.type === "item.completed" &&
        event.item &&
        event.item.type === "command_execution"
      ) {
        const command = event.item.command || "";
        const toolId = toolItemId(event.item, "command_execution");
        const exitCode = event.item.exit_code;
        const failed = typeof exitCode === "number" ? exitCode !== 0 : isFailedItem(event.item);
        return [
          makeEvent("tool.finished", {
            ...base,
            toolName: "command_execution",
            toolId,
            args: { command },
            result: event.item.aggregated_output || "",
            output: event.item.aggregated_output || "",
            exitCode,
            status: failed ? "error" : "ok",
          }),
        ];
      }

      if (
        (event.type === "item.started" || event.type === "item.completed") &&
        event.item &&
        event.item.type === "file_change"
      ) {
        return fileChangeEvents(base, event.item);
      }

      if (
        event.type === "item.completed" &&
        event.item &&
        event.item.type === "error" &&
        typeof event.item.message === "string"
      ) {
        return [
          makeEvent("stderr", {
            ...base,
            text: event.item.message,
          }),
        ];
      }

      // Reasoning / thinking (Codex item.type === "reasoning")
      if (
        (event.type === "item.completed" ||
          event.type === "item.started" ||
          event.type === "item.updated") &&
        event.item &&
        String(event.item.type || "").toLowerCase() === "reasoning"
      ) {
        const text = reasoningTextFromItem(event.item);
        if (!text) return [];
        return [makeEvent("thinking.delta", { ...base, text })];
      }

      if (
        event.type === "item.completed" &&
        event.item &&
        event.item.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        return [
          makeEvent("text.delta", {
            ...base,
            text: event.item.text,
          }),
        ];
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

      if (event.type === "turn.completed" && event.usage) {
        const usage = makeUsageEvent(base, event.usage, {
          scope: "turn",
          mode: "cumulative",
        });
        return usage ? [usage] : [];
      }

      const content = event.content || (event.properties && event.properties.content);
      if (content && content.type === "text" && typeof content.text === "string") {
        return [
          makeEvent("text.delta", {
            ...base,
            text: content.text,
          }),
        ];
      }

      if (event.type === "item.completed" && event.item && event.item.type === "todo_list") {
        return [
          makeEvent("progress.update", {
            ...base,
            items: Array.isArray(event.item.items) ? event.item.items : [],
          }),
        ];
      }

      if (event.type === "item.started" && event.item) {
        const toolEvents = toolLifecycleEvents(base, event.item, "started");
        if (toolEvents.length) return toolEvents;
      }

      if (event.type === "item.completed" && event.item) {
        const toolEvents = toolLifecycleEvents(base, event.item, "completed");
        if (toolEvents.length) return toolEvents;
      }

      // Intentionally silent provider noise (partial updates, etc.).
      const silentTypes = new Set([
        "item.updated",
        "item.started",
        "item.completed",
        "turn.started",
        "turn.completed",
        "task_started",
        "task_complete",
      ]);
      if (event && event.type && !silentTypes.has(String(event.type))) {
        return [
          makeEvent("diagnostic", {
            ...base,
            code: "unmapped_event",
            rawType: String(event.type),
            message: "Codex event type not mapped to canonical protocol",
          }),
        ];
      }
      return [];
    },
  };
}

const codexProvider = {
  id: "codex",
  capabilities: {
    resume: true,
    thinking: true,
    tools: true,
    usage: true,
    reasoning: "levels",
  },
  allowedProviderOptions: ["sandbox", "approvalPolicy"],
  createRuntime: createCodexRuntime,
  resolveProxy,
  buildInvocation(config, prompt) {
    const providerOptions = config.providerOptions || {};
    const args = [
      "-s",
      providerOptions.sandbox || "danger-full-access",
      "-a",
      providerOptions.approvalPolicy || "never",
    ];
    if (config.reasoningEffort) {
      args.push("-c", `model_reasoning_effort="${config.reasoningEffort}"`);
    }
    if (config.model) args.push("-m", config.model);
    if (config.resumeSessionId) {
      args.push("exec", "resume", "--json", config.resumeSessionId, prompt);
    } else {
      args.push("exec", "--json", prompt);
    }
    return { command: "codex", args };
  },
};

module.exports = {
  createCodexRuntime,
  codexProvider,
};
