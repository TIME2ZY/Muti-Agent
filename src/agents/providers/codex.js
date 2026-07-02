const { makeEvent } = require("../event-protocol");

function createCodexRuntime(cli) {
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
