const { makeEvent } = require("../event-protocol");
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

  function toolLifecycleEvents(base, item, phase) {
    if (!isToolLikeItem(item)) return [];
    const toolName = toolNameFromItem(item) || String(item.type || "tool");
    const args = toolArgsFromItem(item);
    const toolId = toolItemId(item, toolName);
    const events = [];

    if (phase === "started") {
      events.push(
        makeEvent("tool.started", {
          ...base,
          toolName,
          args,
          toolId,
        })
      );
      if (isSubagentTool(toolName, args)) {
        events.push(
          makeEvent("subagent.started", {
            ...base,
            subagentId: toolId,
            name: subagentDisplayName(toolName, args),
            task: summarizeTask(args),
            toolName,
          })
        );
      }
      return events;
    }

    // completed
    const result = toolResultFromItem(item);
    const failed = isFailedItem(item);
    events.push(
      makeEvent("tool.finished", {
        ...base,
        toolName,
        result,
        status: failed ? "error" : "ok",
        toolId,
      })
    );
    if (isSubagentTool(toolName, args)) {
      if (failed) {
        events.push(
          makeEvent("subagent.failed", {
            ...base,
            subagentId: toolId,
            name: subagentDisplayName(toolName, args),
            task: summarizeTask(args),
            error: summarizeResult(result) || (item && item.message) || "subagent failed",
            toolName,
          })
        );
      } else {
        events.push(
          makeEvent("subagent.completed", {
            ...base,
            subagentId: toolId,
            name: subagentDisplayName(toolName, args),
            task: summarizeTask(args),
            summary: summarizeResult(result),
            toolName,
          })
        );
      }
    }
    return events;
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
            provider: cli.providerId || cli.name,
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
        return [
          makeEvent("command.started", {
            ...base,
            command: event.item.command || "",
          }),
        ];
      }

      if (
        event.type === "item.completed" &&
        event.item &&
        event.item.type === "command_execution"
      ) {
        return [
          makeEvent("command.finished", {
            ...base,
            command: event.item.command || "",
            output: event.item.aggregated_output || "",
            exitCode: event.item.exit_code,
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

      // item.updated with progress-ish payloads on tool/subagent items
      if (event.type === "item.updated" && event.item && isToolLikeItem(event.item)) {
        const toolName = toolNameFromItem(event.item) || String(event.item.type || "tool");
        const args = toolArgsFromItem(event.item);
        if (isSubagentTool(toolName, args)) {
          const progressText =
            summarizeResult(toolResultFromItem(event.item)) || summarizeTask(args) || toolName;
          return [
            makeEvent("subagent.progress", {
              ...base,
              subagentId: toolItemId(event.item, toolName),
              name: subagentDisplayName(toolName, args),
              text: progressText,
              toolName,
            }),
          ];
        }
      }

      return [];
    },
  };
}

const codexProvider = {
  id: "codex",
  capabilities: {
    resume: true,
    thinking: false,
    tools: true,
    subagents: true,
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
