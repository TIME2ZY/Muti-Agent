const LAYERS = Object.freeze({
  CONVERSATION: "conversation",
  WORKFLOW: "workflow",
  DIAGNOSTIC: "diagnostic",
  SYSTEM: "system",
});

const WORKFLOW_KINDS = new Set([
  "a2a-route",
  "a2a-skipped",
  "handoff-repair-needed",
  "callback-outcome",
  "review-state",
]);

const DIAGNOSTIC_KINDS = new Set(["stderr", "error", "diagnostic"]);

/**
 * Assign a stable presentation/retention layer without changing message roles.
 * Old callers may omit kind/layer; role remains the compatibility fallback.
 */
function classifyMessageLayer(message = {}) {
  if (Object.values(LAYERS).includes(message.layer)) return message.layer;
  const kind = String(message.kind || "")
    .trim()
    .toLowerCase();
  if (WORKFLOW_KINDS.has(kind)) return LAYERS.WORKFLOW;
  if (DIAGNOSTIC_KINDS.has(kind) || message.variant === "error") return LAYERS.DIAGNOSTIC;
  if (message.role === "user" || message.role === "assistant") return LAYERS.CONVERSATION;
  return LAYERS.SYSTEM;
}

function withMessageLayer(message = {}) {
  return { ...message, layer: classifyMessageLayer(message) };
}

module.exports = {
  LAYERS,
  WORKFLOW_KINDS,
  DIAGNOSTIC_KINDS,
  classifyMessageLayer,
  withMessageLayer,
};
