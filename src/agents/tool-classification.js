const SUBAGENT_NAME_RE = /^(spawn[_-]?agent|spawn[_-]?subagent|wait[_-]?agent|subagent|task|agent[_-]?tool)\b/i;

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function parseMaybeJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toolNameFromItem(item) {
  if (!item || typeof item !== "object") return "";
  return String(
    item.tool
    || item.tool_name
    || item.toolName
    || item.name
    || item.function
    || ""
  ).trim();
}

function toolArgsFromItem(item) {
  if (!item || typeof item !== "object") return {};
  const direct = asObject(item.arguments)
    || asObject(item.args)
    || asObject(item.input)
    || asObject(item.params)
    || parseMaybeJson(item.arguments)
    || parseMaybeJson(item.args)
    || parseMaybeJson(item.input);
  return direct || {};
}

function toolResultFromItem(item) {
  if (!item || typeof item !== "object") return item?.result ?? item?.output ?? item?.content ?? null;
  if (item.result !== undefined) return item.result;
  if (item.output !== undefined) return item.output;
  if (item.content !== undefined) return item.content;
  if (item.error !== undefined) return { error: item.error };
  return null;
}

function isFailedItem(item) {
  if (!item || typeof item !== "object") return false;
  const status = String(item.status || item.state || "").toLowerCase();
  if (["failed", "error", "errored", "cancelled", "canceled"].includes(status)) return true;
  if (item.error || item.is_error === true || item.success === false) return true;
  return false;
}

function isSubagentTool(toolName, args = {}) {
  const name = String(toolName || "").trim();
  if (!name) return false;
  if (SUBAGENT_NAME_RE.test(name)) return true;
  const lower = name.toLowerCase();
  if (lower.includes("subagent") || lower.includes("spawn_agent") || lower.includes("wait_agent")) {
    return true;
  }
  const obj = asObject(args) || {};
  if (obj.subagent_type || obj.subagentType || obj.agent_type || obj.agentType) return true;
  if ((lower === "task" || lower.endsWith(".task") || lower.includes("task"))
    && (obj.prompt || obj.description || obj.agent || obj.subagent_type || obj.subagentType)) {
    return true;
  }
  return false;
}

function subagentDisplayName(toolName, args = {}) {
  const obj = asObject(args) || {};
  const typed = obj.subagent_type || obj.subagentType || obj.agent_type || obj.agentType || obj.agent || obj.name;
  if (typed) return String(typed);
  return String(toolName || "subagent");
}

function summarizeTask(args = {}, max = 180) {
  const obj = asObject(args) || {};
  const candidates = [
    obj.prompt,
    obj.task,
    obj.description,
    obj.message,
    obj.query,
    obj.instruction,
    obj.goal,
  ];
  let text = "";
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      text = value.trim();
      break;
    }
  }
  if (!text) {
    try {
      text = JSON.stringify(obj);
    } catch {
      text = "";
    }
  }
  text = String(text || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function summarizeResult(result, max = 220) {
  if (result == null) return "";
  if (typeof result === "string") {
    const text = result.replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
  if (typeof result === "object") {
    if (typeof result.error === "string" && result.error.trim()) {
      return summarizeResult(result.error, max);
    }
    if (typeof result.message === "string" && result.message.trim()) {
      return summarizeResult(result.message, max);
    }
    if (typeof result.summary === "string" && result.summary.trim()) {
      return summarizeResult(result.summary, max);
    }
    if (typeof result.text === "string" && result.text.trim()) {
      return summarizeResult(result.text, max);
    }
    if (typeof result.output === "string" && result.output.trim()) {
      return summarizeResult(result.output, max);
    }
    try {
      const text = JSON.stringify(result);
      return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    } catch {
      return "";
    }
  }
  return String(result);
}

function toolItemId(item, toolName) {
  if (item && typeof item.id === "string" && item.id) return item.id;
  if (item && typeof item.call_id === "string" && item.call_id) return item.call_id;
  if (item && typeof item.callId === "string" && item.callId) return item.callId;
  return `${toolName || "tool"}-${Date.now()}`;
}

module.exports = {
  SUBAGENT_NAME_RE,
  toolNameFromItem,
  toolArgsFromItem,
  toolResultFromItem,
  isFailedItem,
  isSubagentTool,
  subagentDisplayName,
  summarizeTask,
  summarizeResult,
  toolItemId,
};
