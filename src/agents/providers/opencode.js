const { makeEvent } = require("../event-protocol");

function createOpencodeRuntime(cli) {
  const parts = new Map();

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
