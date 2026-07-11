const CANONICAL_EVENT_FIELDS = {
  "run.started": ["agent", "invocationId", "provider", "model"],
  "run.finished": ["agent", "invocationId", "exitCode"],
  "run.failed": ["agent", "invocationId", "error"],
  "text.delta": ["agent", "invocationId", "text"],
  "thinking.delta": ["agent", "invocationId", "text"],
  "thinking.final": ["agent", "invocationId", "text"],
  stderr: ["agent", "invocationId", "text"],
  "command.started": ["agent", "invocationId", "command"],
  "command.finished": ["agent", "invocationId", "command"],
  "file.changed": ["agent", "invocationId", "path"],
  "progress.update": ["agent", "invocationId", "items"],
  "tool.started": ["agent", "invocationId", "toolName", "toolId"],
  "tool.finished": ["agent", "invocationId", "toolName", "toolId"],
  "subagent.started": ["agent", "invocationId", "subagentId"],
  "subagent.progress": ["agent", "invocationId", "subagentId", "text"],
  "subagent.completed": ["agent", "invocationId", "subagentId"],
  "subagent.failed": ["agent", "invocationId", "subagentId", "error"],
};

const CANONICAL_EVENT_TYPES = new Set(Object.keys(CANONICAL_EVENT_FIELDS));

function normalizeProgressItem(item, index) {
  const source = item && typeof item === "object" ? item : { text: String(item || "") };
  const label = source.label || source.text || source.title || source.description || "";
  let status = source.status || "";
  if (!status) status = source.done === true ? "completed" : "pending";
  if (status === "done" || status === "success" || status === "ok") status = "completed";
  if (status === "running") status = "in_progress";
  return {
    ...source,
    id: source.id ?? source.step ?? `step-${index + 1}`,
    label,
    status,
    text: source.text || label,
    done: status === "completed",
  };
}

function normalizeCanonicalEvent(event) {
  if (!event || typeof event !== "object") return event;
  if (event.type === "progress.update") {
    return {
      ...event,
      items: Array.isArray(event.items) ? event.items.map(normalizeProgressItem) : [],
    };
  }
  if (event.type === "tool.started") {
    return { ...event, state: "running" };
  }
  if (event.type === "tool.finished") {
    const failed = event.status === "error" || event.status === "failed";
    return { ...event, state: failed ? "failed" : "completed" };
  }
  return event;
}

function validateCanonicalEvent(event) {
  if (!event || typeof event !== "object") return ["event must be an object"];
  if (!CANONICAL_EVENT_TYPES.has(event.type)) {
    return [`unsupported event type "${event.type}"`];
  }
  return CANONICAL_EVENT_FIELDS[event.type]
    .filter((field) => event[field] === undefined || event[field] === null)
    .map((field) => `${event.type}.${field} is required`);
}

function assertCanonicalEvent(event) {
  const errors = validateCanonicalEvent(event);
  if (errors.length) throw new Error(`Invalid canonical event: ${errors.join("; ")}`);
  return event;
}

function makeEvent(type, fields) {
  return { type, ...fields };
}

module.exports = {
  CANONICAL_EVENT_FIELDS,
  CANONICAL_EVENT_TYPES,
  normalizeProgressItem,
  normalizeCanonicalEvent,
  validateCanonicalEvent,
  assertCanonicalEvent,
  makeEvent,
};
