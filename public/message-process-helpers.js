/**
 * Pure helpers for message process / tool / subagent cards.
 * Extracted from message-view so event rendering stays testable without DOM.
 */
(function initMessageProcessHelpers(globalScope) {
  "use strict";

  function collapseWs(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function truncateDisplay(text, max = 160) {
    const value = collapseWs(text);
    if (!value) return "";
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function cleanProcessOutput(text) {
    let value = String(text || "");
    if (!value) return "";
    const resultMatch = value.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/i);
    if (resultMatch && resultMatch[1]) value = resultMatch[1];
    value = value
      .replace(/<\/?task\b[^>]*>/gi, " ")
      .replace(/<\/?task_result\b[^>]*>/gi, " ")
      .replace(/<\/?[^>]+>/g, " ")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\|/g, " ");
    return collapseWs(value);
  }

  function toolDetailFromEvent(event) {
    if (!event) return "";
    if (typeof event.command === "string" && event.command.trim()) {
      return truncateDisplay(event.command, 140);
    }
    const args = event.args && typeof event.args === "object" ? event.args : {};
    const preferred = args.title || args.description || args.command || args.cmd
      || args.path || args.file || args.pattern || event.task || "";
    return truncateDisplay(preferred, 140);
  }

  function isContentDumpTool(event) {
    const name = String((event && event.toolName) || "").toLowerCase();
    return /^(read|glob|grep|list|search|find|cat|ls|dir|view|get)\b/.test(name)
      || name.includes("read")
      || name.includes("glob")
      || name.includes("grep")
      || name.includes("list_dir")
      || name.includes("list-dir");
  }

  function processSummaryFromEvent(event) {
    if (!event) return "";
    if (typeof event.error === "string" && event.error.trim()) {
      return truncateDisplay(cleanProcessOutput(event.error), 120);
    }
    if (event.status === "error") {
      if (typeof event.output === "string" && event.output.trim()) {
        return truncateDisplay(cleanProcessOutput(event.output), 120);
      }
      if (event.result != null) {
        const raw = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
        return truncateDisplay(cleanProcessOutput(raw), 120);
      }
    }
    if (typeof event.summary === "string" && event.summary.trim()) {
      const cleaned = cleanProcessOutput(event.summary);
      if (cleaned.length <= 80) return cleaned;
      return truncateDisplay(cleaned, 80);
    }
    if (
      event.type === "tool.finished"
      || event.type === "command.finished"
      || event.type === "tool.started"
      || event.type === "command.started"
      || isContentDumpTool(event)
    ) {
      return "";
    }
    if (typeof event.output === "string" && event.output.trim()) {
      return truncateDisplay(cleanProcessOutput(event.output), 80);
    }
    if (event.result != null) {
      const raw = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
      return truncateDisplay(cleanProcessOutput(raw), 80);
    }
    if (typeof event.text === "string" && event.text.trim()) {
      return truncateDisplay(cleanProcessOutput(event.text), 80);
    }
    return "";
  }

  function isTaskLikeTool(event) {
    const name = String((event && event.toolName) || "").toLowerCase();
    if (name === "task" || name.endsWith(".task")) return true;
    const args = event && event.args && typeof event.args === "object" ? event.args : {};
    return Boolean(args.subagent_type || args.subagentType);
  }

  function progressItemLabel(item) {
    if (!item || typeof item !== "object") return String(item || "");
    return item.text || item.label || item.title || item.description || "";
  }

  function progressItemDone(item) {
    if (!item || typeof item !== "object") return false;
    if (item.done === true || item.status === "done" || item.status === "completed") return true;
    if (item.done === false) return false;
    return false;
  }

  const api = {
    collapseWs,
    truncateDisplay,
    cleanProcessOutput,
    toolDetailFromEvent,
    isContentDumpTool,
    processSummaryFromEvent,
    isTaskLikeTool,
    progressItemLabel,
    progressItemDone,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.MessageProcessHelpers = api;
})(typeof window !== "undefined" ? window : globalThis);
