const { makeEvent } = require("../event-protocol");

/**
 * Grok Build CLI provider.
 *
 * Child process is the local `grok` binary (same pattern as codex / opencode):
 *   grok -p "..." --output-format streaming-json -m grok-4.5 --reasoning-effort high ...
 *
 * Observed streaming-json lines (headless):
 *   { "type": "thought", "data": "..." }   // often 1 word / few chars each
 *   { "type": "text", "data": "..." }
 *   { "type": "end", "stopReason": "EndTurn", "sessionId": "...", "requestId": "..." }
 *
 * Without coalescing, a short reply with high reasoning can emit 200+ NDJSON
 * lines → 200+ SSE/agent-events. We batch consecutive thought/text chunks.
 */

/** Flush thinking when buffered length reaches this many characters. */
const THINKING_FLUSH_CHARS = 80;
/** Flush assistant text a bit more eagerly for responsive UI. */
const TEXT_FLUSH_CHARS = 40;

function createGrokRuntime(cli) {
  let emittedRunStarted = false;
  let thinkingBuf = "";
  let textBuf = "";

  function eventText(event) {
    if (typeof event.data === "string") return event.data;
    if (typeof event.text === "string") return event.text;
    if (typeof event.delta === "string") return event.delta;
    return "";
  }

  return {
    extractSessionId(event) {
      if (!event || typeof event !== "object") return "";
      if (event.type === "end" && typeof event.sessionId === "string" && event.sessionId) {
        return event.sessionId;
      }
      if (typeof event.sessionId === "string" && event.sessionId) {
        return event.sessionId;
      }
      if (event.type === "session" && typeof event.id === "string") {
        return event.id;
      }
      return "";
    },
    transform(event, ctx) {
      const base = {
        agent: ctx.agent,
        invocationId: ctx.invocationId,
      };
      if (!event || typeof event !== "object") return [];

      const out = [];

      const ensureStarted = (sessionId) => {
        if (emittedRunStarted) return;
        emittedRunStarted = true;
        out.push(makeEvent("run.started", {
          ...base,
          sessionId: sessionId || "",
          provider: "grok",
          model: (cli && cli.model) || "grok-4.5",
        }));
      };

      const flushThinking = (force = false) => {
        if (!thinkingBuf) return;
        if (!force && thinkingBuf.length < THINKING_FLUSH_CHARS) return;
        out.push(makeEvent("thinking.delta", { ...base, text: thinkingBuf }));
        thinkingBuf = "";
      };

      const flushText = (force = false) => {
        if (!textBuf) return;
        if (!force && textBuf.length < TEXT_FLUSH_CHARS) return;
        out.push(makeEvent("text.delta", { ...base, text: textBuf }));
        textBuf = "";
      };

      const flushAll = () => {
        flushThinking(true);
        flushText(true);
      };

      switch (event.type) {
        case "thought":
        case "thinking":
        case "reasoning": {
          ensureStarted(event.sessionId);
          // Switching stream kind: emit pending assistant text first.
          flushText(true);
          const text = eventText(event);
          if (text) {
            thinkingBuf += text;
            flushThinking(false);
          }
          return out;
        }

        case "text":
        case "message":
        case "assistant": {
          ensureStarted(event.sessionId);
          // Leaving thought stream: emit pending thinking first.
          flushThinking(true);
          const text = eventText(event);
          if (text) {
            textBuf += text;
            flushText(false);
          }
          return out;
        }

        case "end":
        case "done": {
          ensureStarted(event.sessionId);
          flushAll();
          return out;
        }

        case "error": {
          ensureStarted();
          flushAll();
          const message = event.message || event.data || event.error || "Grok CLI error";
          out.push(makeEvent("run.failed", { ...base, error: String(message) }));
          return out;
        }

        case "tool":
        case "tool_use":
        case "tool_result": {
          ensureStarted(event.sessionId);
          // Tools interrupt streaming prose — flush so UI stays ordered.
          flushAll();
          return out;
        }

        default:
          ensureStarted(event.sessionId);
          return out;
      }
    },
  };
}

module.exports = {
  createGrokRuntime,
  THINKING_FLUSH_CHARS,
  TEXT_FLUSH_CHARS,
};
