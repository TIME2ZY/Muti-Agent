(function initSessionListView(globalScope) {
  "use strict";

  function runStatusLabel(status) {
    if (status === "running") return "运行中";
    if (status === "done") return "完成";
    if (status === "error") return "失败";
    return "";
  }

  function applyDot(dot, status) {
    if (!dot) return;
    const st = status || "idle";
    dot.dataset.status = st;
    dot.className = "session-run-dot";
    if (st === "running") {
      dot.classList.add("is-running");
      dot.hidden = false;
      dot.title = "运行中";
    } else if (st === "done") {
      dot.classList.add("is-done");
      dot.hidden = false;
      dot.title = "已完成";
    } else if (st === "error") {
      dot.classList.add("is-error");
      dot.hidden = false;
      dot.title = "失败";
    } else {
      dot.hidden = true;
      dot.title = "";
    }
  }

  const GROUP_ORDER = ["today", "yesterday", "earlier"];
  const GROUP_LABEL = {
    today: "今天",
    yesterday: "昨天",
    earlier: "更早",
  };

  function startOfLocalDay(ms) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function dayBucket(iso, nowMs) {
    if (!iso) return "earlier";
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "earlier";
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    const today = startOfLocalDay(now);
    const yesterday = today - 24 * 60 * 60 * 1000;
    if (t >= today) return "today";
    if (t >= yesterday) return "yesterday";
    return "earlier";
  }

  /**
   * Group sessions into today / yesterday / earlier while preserving
   * relative order within each group (expects newest-first input).
   */
  function groupSessions(sessions, nowMs) {
    const buckets = { today: [], yesterday: [], earlier: [] };
    const list = Array.isArray(sessions) ? sessions : [];
    for (const s of list) {
      buckets[dayBucket(s && s.createdAt, nowMs)].push(s);
    }
    return GROUP_ORDER
      .filter((key) => buckets[key].length > 0)
      .map((key) => ({
        key,
        label: GROUP_LABEL[key],
        items: buckets[key],
      }));
  }

  function createSessionListView(deps) {
    const {
      sessionListEl,
      getCurrentSessionId,
      getRuntimeStatus,
      onSelect,
      onDelete,
      fmtTime,
      escHtml,
      now,
    } = deps;

    /** @type {Map<string, HTMLElement>} */
    const itemById = new Map();
    const nowOf = typeof now === "function" ? now : () => Date.now();

    function buildItem(s, currentId) {
      const runStatus = typeof getRuntimeStatus === "function" ? getRuntimeStatus(s.id) : "idle";
      const statusText = runStatusLabel(runStatus);
      const item = document.createElement("div");
      item.dataset.sessionId = s.id;
      item.className = "session-item"
        + (s.id === currentId ? " active" : "")
        + (runStatus === "running" ? " is-running" : "");

      const dot = document.createElement("span");
      applyDot(dot, runStatus);

      const info = document.createElement("div");
      info.className = "session-info";

      const title = document.createElement("div");
      title.className = "session-title";
      title.textContent = s.title || "(空对话)";

      const meta = document.createElement("div");
      meta.className = "session-meta";
      const time = typeof fmtTime === "function" ? fmtTime(s.createdAt) : "";
      meta.append(`${s.messageCount || 0} 条 · ${time}`);
      if (statusText) {
        meta.append(" · ");
        const statusEl = document.createElement("span");
        statusEl.className = `session-run-status status-${runStatus}`;
        statusEl.textContent = statusText;
        meta.appendChild(statusEl);
      }

      info.append(title, meta);
      item.append(dot, info);

      item.addEventListener("click", (e) => {
        if (e.target.closest(".btn-delete-session")) return;
        if (typeof onSelect === "function") onSelect(s.id);
      });

      const del = document.createElement("button");
      del.className = "btn-delete-session";
      del.type = "button";
      del.textContent = "×";
      del.title = "删除对话";
      del.setAttribute("aria-label", "删除对话");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (typeof onDelete === "function") onDelete(s.id);
      });
      item.appendChild(del);

      void escHtml;
      itemById.set(s.id, item);
      return item;
    }

    function render(sessions) {
      if (!sessionListEl) return;
      const list = Array.isArray(sessions) ? sessions : [];
      itemById.clear();

      if (list.length === 0) {
        sessionListEl.innerHTML = '<div class="session-empty">暂无对话</div>';
        return;
      }

      const currentId = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
      const groups = groupSessions(list, nowOf());
      const nodes = [];

      for (const group of groups) {
        const heading = document.createElement("div");
        heading.className = "session-group-label";
        heading.textContent = group.label;
        heading.setAttribute("role", "presentation");
        nodes.push(heading);
        for (const s of group.items) {
          nodes.push(buildItem(s, currentId));
        }
      }

      sessionListEl.replaceChildren(...nodes);
    }

    /**
     * Update a single session's runtime indicator without a network round-trip.
     */
    function updateStatus(sessionId, status) {
      if (!sessionId) return;
      let item = itemById.get(sessionId);
      if (!item && sessionListEl) {
        item = sessionListEl.querySelector(`[data-session-id="${CSS.escape ? CSS.escape(sessionId) : sessionId}"]`);
      }
      if (!item) return;

      const st = status || "idle";
      item.classList.toggle("is-running", st === "running");
      applyDot(item.querySelector(".session-run-dot"), st);

      const meta = item.querySelector(".session-meta");
      if (!meta) return;
      let statusEl = meta.querySelector(".session-run-status");
      const label = runStatusLabel(st);
      if (!label) {
        if (statusEl) statusEl.remove();
        return;
      }
      if (!statusEl) {
        meta.append(" · ");
        statusEl = document.createElement("span");
        meta.appendChild(statusEl);
      }
      statusEl.className = `session-run-status status-${st}`;
      statusEl.textContent = label;
    }

    return { render, updateStatus, runStatusLabel };
  }

  const api = {
    createSessionListView,
    runStatusLabel,
    dayBucket,
    groupSessions,
    GROUP_LABEL,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.SessionListView = api;
})(typeof window !== "undefined" ? window : globalThis);
