const { makeEvent } = require("../event-protocol");
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
  const toolStates = new Map();

  function toolEventsFromPart(part, base) {
    if (!part || typeof part !== "object") return [];
    const type = String(part.type || "").toLowerCase();
    if (!(type === "tool" || type === "tool_call" || type === "toolcall" || type === "mcp" || type === "task")) {
      // Some OpenCode builds use part.tool / part.name without type=tool.
      if (!part.tool && !part.name && !part.toolName) return [];
    }

    const toolName = toolNameFromItem(part) || part.tool || part.name || "tool";
    const args = toolArgsFromItem(part);
    const toolId = toolItemId(part, toolName);
    const status = String(part.status || part.state || "").toLowerCase();
    const prev = toolStates.get(toolId) || { started: false, finished: false };
    const events = [];

    const looksRunning = !status || ["pending", "running", "in_progress", "start", "started"].includes(status);
    const looksDone = ["completed", "complete", "done", "success", "ok", "error", "failed", "cancelled", "canceled"].includes(status)
      || part.output != null
      || part.result != null
      || part.error != null;

    if (!prev.started && looksRunning) {
      events.push(makeEvent("tool.started", {
        ...base,
        toolName,
        args,
        toolId,
      }));
      if (isSubagentTool(toolName, args) || type === "task") {
        events.push(makeEvent("subagent.started", {
          ...base,
          subagentId: toolId,
          name: subagentDisplayName(toolName, args),
          task: summarizeTask(args),
          toolName,
        }));
      }
      prev.started = true;
    }

    if (!prev.finished && looksDone && status !== "running" && status !== "in_progress" && status !== "pending") {
      const result = toolResultFromItem(part);
      const failed = isFailedItem(part) || status === "error" || status === "failed";
      events.push(makeEvent("tool.finished", {
        ...base,
        toolName,
        result,
        status: failed ? "error" : "ok",
        toolId,
      }));
      if (isSubagentTool(toolName, args) || type === "task") {
        if (failed) {
          events.push(makeEvent("subagent.failed", {
            ...base,
            subagentId: toolId,
            name: subagentDisplayName(toolName, args),
            task: summarizeTask(args),
            error: summarizeResult(result) || "subagent failed",
            toolName,
          }));
        } else {
          events.push(makeEvent("subagent.completed", {
            ...base,
            subagentId: toolId,
            name: subagentDisplayName(toolName, args),
            task: summarizeTask(args),
            summary: summarizeResult(result),
            toolName,
          }));
        }
      }
      prev.finished = true;
    } else if (prev.started && !prev.finished && (part.output || part.result || part.title || part.text)) {
      if (isSubagentTool(toolName, args) || type === "task") {
        events.push(makeEvent("subagent.progress", {
          ...base,
          subagentId: toolId,
          name: subagentDisplayName(toolName, args),
          text: summarizeResult(part.output || part.result || part.title || part.text),
          toolName,
        }));
      }
    }

    toolStates.set(toolId, prev);
    return events;
  }

  return {
    extractSessionId(event) {
      if (event && event.type === "session.updated" && event.session && typeof event.session.id === "string") {
        return event.session.id;
      }
      if (event && typeof event.sessionID === "string") {
        return event.sessionID;
      }
      return "";
    },
    transform(event, ctx) {
      const base = {
        agent: ctx.agent,
        invocationId: ctx.invocationId,
      };

      const part = event.part || (event.properties && event.properties.part);
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

      if (event.type === "message.part.updated" && part) {
        const toolEvents = toolEventsFromPart(part, base);
        if (toolEvents.length) return toolEvents;
      }

      if (event.type === "session.updated") {
        return [makeEvent("run.started", {
          ...base,
          sessionId: event.session && event.session.id ? event.session.id : "",
          provider: cli.name,
          model: cli.model || "",
        })];
      }

      if (event.type === "step_start") {
        return [makeEvent("run.started", {
          ...base,
          sessionId: typeof event.sessionID === "string" ? event.sessionID : "",
          provider: cli.name,
          model: cli.model || "",
        })];
      }

      if (event.type === "assistant") {
        const content = event.message && Array.isArray(event.message.content)
          ? event.message.content
          : [];
        const text = content
          .filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("");
        return text ? [makeEvent("text.delta", { ...base, text })] : [];
      }

      if (event.type === "text" && part && part.type === "text" && typeof part.text === "string") {
        return [makeEvent("text.delta", {
          ...base,
          text: part.text,
        })];
      }

      return [];
    },
  };
}

module.exports = {
  createOpencodeRuntime,
};
