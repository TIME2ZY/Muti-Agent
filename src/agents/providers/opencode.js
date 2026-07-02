const { makeEvent } = require("../event-protocol");

function createOpencodeRuntime(cli) {
  const parts = new Map();

  return {
    extractSessionId(event) {
      return event && event.type === "session.updated" && event.session && typeof event.session.id === "string"
        ? event.session.id
        : "";
    },
    transform(event, ctx) {
      const base = {
        agent: ctx.agent,
        invocationId: ctx.invocationId,
      };

      if (event.type === "message.part.updated" && event.part && event.part.type === "text") {
        const id = event.part.id || "_default";
        const next = typeof event.part.text === "string" ? event.part.text : "";
        const prev = parts.get(id) || "";
        parts.set(id, next);
        if (!next.startsWith(prev)) {
          return [makeEvent("text.delta", { ...base, text: next })];
        }
        const delta = next.slice(prev.length);
        return delta ? [makeEvent("text.delta", { ...base, text: delta })] : [];
      }

      if (event.type === "session.updated") {
        return [makeEvent("run.started", {
          ...base,
          sessionId: event.session && event.session.id ? event.session.id : "",
          provider: cli.name,
          model: cli.model || "",
        })];
      }

      return [];
    },
  };
}

module.exports = {
  createOpencodeRuntime,
};
