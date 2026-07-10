const { makeEvent } = require("../event-protocol");

function createCodexRuntime(cli) {
  function fileChangeEvents(base, item) {
    const changes = item && Array.isArray(item.changes) ? item.changes : [];
    return changes
      .filter((change) => change && typeof change.path === "string")
      .map((change) => makeEvent("file.changed", {
        ...base,
        path: change.path,
        changeType: change.kind || "",
      }));
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
        return [makeEvent("run.started", {
          ...base,
          sessionId: event.thread_id || "",
          provider: cli.name,
          model: cli.model || "",
        })];
      }

      if (event.type === "error" && typeof event.message === "string") {
        return [makeEvent("stderr", {
          ...base,
          text: event.message,
        })];
      }

      if (event.type === "item.started" && event.item && event.item.type === "command_execution") {
        return [makeEvent("command.started", {
          ...base,
          command: event.item.command || "",
        })];
      }

      if (event.type === "item.completed" && event.item && event.item.type === "command_execution") {
        return [makeEvent("command.finished", {
          ...base,
          command: event.item.command || "",
          output: event.item.aggregated_output || "",
          exitCode: event.item.exit_code,
        })];
      }

      if (
        (event.type === "item.started" || event.type === "item.completed")
        && event.item
        && event.item.type === "file_change"
      ) {
        return fileChangeEvents(base, event.item);
      }

      if (event.type === "item.completed" && event.item && event.item.type === "error" && typeof event.item.message === "string") {
        return [makeEvent("stderr", {
          ...base,
          text: event.item.message,
        })];
      }

      if (event.type === "item.completed" && event.item && event.item.type === "agent_message" && typeof event.item.text === "string") {
        return [makeEvent("text.delta", {
          ...base,
          text: event.item.text,
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

      const content = event.content || (event.properties && event.properties.content);
      if (content && content.type === "text" && typeof content.text === "string") {
        return [makeEvent("text.delta", {
          ...base,
          text: content.text,
        })];
      }

      if (event.type === "item.completed" && event.item && event.item.type === "todo_list") {
        return [makeEvent("progress.update", {
          ...base,
          items: Array.isArray(event.item.items) ? event.item.items : [],
        })];
      }

      return [];
    },
  };
}

module.exports = {
  createCodexRuntime,
};
