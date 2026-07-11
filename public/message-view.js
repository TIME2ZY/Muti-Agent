(function initMessageView(globalScope) {
  "use strict";

  // When history has many assistant turns, defer process-trace hydrate
  // so the first paint stays responsive. Full virtualization is future work.
  const MESSAGE_VIRTUAL_THRESHOLD = 250;
  const HYDRATE_CHUNK_SIZE = 4;

  function resolveProcessHelpers() {
    if (globalScope.MessageProcessHelpers) return globalScope.MessageProcessHelpers;
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try { return require("./message-process-helpers.js"); } catch { /* ignore */ }
    }
    return null;
  }

  function resolveMsgLocale() {
    const pack = globalScope.Locale || globalScope.LocaleZhCN;
    if (pack && pack.locale && pack.locale.message) return pack.locale;
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try { return require("./locale-zh-CN.js").locale; } catch { /* ignore */ }
    }
    return {
      badge: { thinking: "思考中", writing: "输出中", error: "异常退出" },
      message: {
        copy: "复制消息",
        copyOk: "已复制",
        copyFail: "失败",
        thinkingProcess: "思考过程",
        thinkingProcessChars: (n) => `思考过程 · ${n} 字`,
        process: "执行过程",
        running: "运行中",
        done: "完成",
        success: "成功",
        failed: "失败",
        progressDone: (n) => `进度 · ${n} 步已完成`,
        progressPartial: (done, total) => `进度 · ${done}/${total}`,
      },
    };
  }

  function createMessageView(deps) {
    const {
      messagesEl,
      emptyStateEl,
      spacerEl,
      state,
      runtimeStore,
      renderMd,
      writeClipboard,
      ClipboardItem,
      getClipboard,
      roleDisplayName,
      roleBadgeLabel,
      agentColorIndex,
      attachRecallToggle,
      fetchInvocationEvents,
      onRuntimeStatusChange,
      setStatus,
      getSessionController,
      loadWorktreeStatus,
      loadWorkspaceState,
      syncComposerControls,
      getSessionSlot,
      renderAgentTabs,
      getChatClient,
      promptEl,
    } = deps;

    const processHelpers = resolveProcessHelpers() || {};
    const {
      truncateDisplay,
      toolDetailFromEvent,
      processSummaryFromEvent,
      isTaskLikeTool,
      progressItemLabel,
      progressItemDone,
    } = processHelpers;
    const L = resolveMsgLocale();
    const msg = L.message || {};
    const badgeText = L.badge || {};

    function sessionRuntime(sessionId) {
      return runtimeStore.getOrCreate(sessionId || state.currentSessionId || "_pending");
    }

    function isViewingSession(sessionId) {
      const sid = sessionId || "_pending";
      return !state.currentSessionId || state.currentSessionId === sid;
    }

    function scrollDown() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function ensureSpacer() {
      if (!messagesEl.contains(spacerEl)) messagesEl.appendChild(spacerEl);
    }

    function hideEmpty() {
      if (emptyStateEl && emptyStateEl.parentNode) emptyStateEl.remove();
    }

    function showEmpty() {
      ensureSpacer();
      if (emptyStateEl && !emptyStateEl.parentNode) {
        messagesEl.insertBefore(emptyStateEl, spacerEl);
      }
    }

    function copyToClipboard(text, btn, okText = "✓", failText = "Failed") {
      const orig = btn.textContent;
      const html = btn && btn.dataset && btn.dataset.copyHtml;
      const write = writeClipboard({
        clipboard: typeof getClipboard === "function" ? getClipboard() : navigator.clipboard,
        ClipboardItem: ClipboardItem || (typeof window !== "undefined" ? window.ClipboardItem : undefined),
      }, {
        text,
        html,
      });
      return write.then(() => {
        btn.textContent = okText;
        btn.classList.add("copied");
      }).catch(() => {
        btn.textContent = failText;
      }).finally(() => {
        setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1200);
      });
    }

    function makeSetBadge(badgeEl) {
      return function setBadge(badgeState) {
        if (!badgeState) {
          badgeEl.style.display = "none";
          badgeEl.className = "msg-badge";
          return;
        }
        badgeEl.style.display = "";
        const configs = {
          thinking: { cls: "badge-thinking", text: badgeText.thinking || "思考中", dot: true },
          writing:  { cls: "badge-writing",  text: badgeText.writing || "输出中", dot: true },
          done:     { cls: "badge-done",     text: "",        dot: false },
          error:    { cls: "badge-error",    text: badgeText.error || "异常退出", dot: false },
        };
        const cfg = configs[badgeState] || configs.thinking;
        badgeEl.className = "msg-badge " + cfg.cls;
        badgeEl.innerHTML = cfg.dot
          ? `<span class="badge-dot"></span>${cfg.text}`
          : cfg.text;
      };
    }

    function createMessage({ role, agent, content = "", variant = "", invocationId = null }) {
      hideEmpty();
      ensureSpacer();

      const wrapper = document.createElement("article");
      wrapper.className = ["message", role, variant].filter(Boolean).join(" ");
      if (role === "assistant" && agent && typeof agentColorIndex === "function") {
        wrapper.dataset.agentColor = String(agentColorIndex(agent));
        wrapper.dataset.agentId = String(agent);
      }

      const meta = document.createElement("div");
      meta.className = "msg-meta";
      const metaLabel = document.createElement("span");
      metaLabel.className = "msg-name";
      metaLabel.textContent = roleDisplayName(role, agent);
      meta.appendChild(metaLabel);
      const metaRole = document.createElement("span");
      metaRole.className = "msg-role-label";
      metaRole.textContent = roleBadgeLabel(role);
      meta.appendChild(metaRole);
      if (role === "assistant" && agent) {
        const metaAgent = document.createElement("span");
        metaAgent.className = "msg-agent-id";
        metaAgent.textContent = agent;
        meta.appendChild(metaAgent);
      }

      const badge = document.createElement("span");
      badge.className = "msg-badge";
      badge.style.display = "none";
      meta.appendChild(badge);

      if (role === "assistant" && content) {
        const copy = document.createElement("button");
        copy.className = "msg-copy";
        copy.textContent = "⎘";
        copy.title = msg.copy || "复制消息";
        copy.setAttribute("aria-label", msg.copy || "复制消息");
        copy.dataset.copyHtml = renderMd(content);
        copy.addEventListener("click", () => {
          copyToClipboard(content, copy, "✓", msg.copyFail || "失败");
        });
        meta.appendChild(copy);
      }

      const card = document.createElement("div");
      card.className = "msg-card";
      const bubble = document.createElement("div");
      bubble.className = "msg-bubble";
      card.appendChild(bubble);

      if (role === "assistant" && content === "") {
        bubble.classList.add("msg-bubble-live");
        bubble.classList.add("msg-bubble-live-pending");
        const liveText = document.createElement("div");
        liveText.className = "stream-live-text";
        bubble.append(liveText);
        wrapper.append(meta, card);
        messagesEl.insertBefore(wrapper, spacerEl);
        scrollDown();

        const setBadge = makeSetBadge(badge);
        return {
          wrapper,
          bubble,
          meta,
          setBadge,
          _liveTextEl: liveText,
          thinkingText: "",
          progressItems: [],
        };
      }

      const contentEl = document.createElement("div");
      contentEl.className = "msg-final-content";
      contentEl.innerHTML = renderMd(content);
      bubble.appendChild(contentEl);

      wrapper.append(meta, card);
      messagesEl.insertBefore(wrapper, spacerEl);
      scrollDown();

      if (role === "assistant" && invocationId) {
        if (typeof attachRecallToggle === "function") attachRecallToggle(wrapper, invocationId);
        scheduleHydrateProcessTrace(bubble, invocationId);
      }

      const setBadge = makeSetBadge(badge);
      return { wrapper, bubble, meta, setBadge };
    }

    function ensureThinkingPanel(liveItem) {
      if (!liveItem || !liveItem.bubble) return null;
      let details = liveItem.bubble.querySelector(".msg-thinking");
      if (details) return details;
      details = document.createElement("details");
      details.className = "msg-thinking";
      details.open = false;
      const summary = document.createElement("summary");
      summary.className = "msg-thinking-summary";
      summary.textContent = msg.thinkingProcess || "思考过程";
      const body = document.createElement("pre");
      body.className = "msg-thinking-body";
      details.append(summary, body);
      // Place thinking above progress / process / live text.
      liveItem.bubble.insertBefore(details, liveItem.bubble.firstChild);
      return details;
    }

    function updateThinkingPanel(liveItem, text) {
      if (!liveItem || !text) return;
      liveItem.thinkingText = text;
      if (!liveItem.bubble) return;
      const details = ensureThinkingPanel(liveItem);
      if (!details) return;
      details.dataset.live = "true";
      const body = details.querySelector(".msg-thinking-body");
      if (body) body.textContent = text;
      const summary = details.querySelector(".msg-thinking-summary");
      if (summary) {
        const chars = text.length;
        const base = msg.thinkingProcess || "思考过程";
        summary.textContent = chars > 0
          ? (typeof msg.thinkingProcessChars === "function"
            ? msg.thinkingProcessChars(chars)
            : `${base} · ${chars} 字`)
          : base;
      }
    }

    function ensureProgressList(liveItem) {
      if (!liveItem || !liveItem.bubble) return null;
      let list = liveItem.bubble.querySelector(".msg-progress");
      if (list) return list;
      list = document.createElement("ul");
      list.className = "msg-progress";
      const thinking = liveItem.bubble.querySelector(".msg-thinking");
      if (thinking && thinking.nextSibling) {
        liveItem.bubble.insertBefore(list, thinking.nextSibling);
      } else if (thinking) {
        thinking.after(list);
      } else if (liveItem._liveTextEl && liveItem._liveTextEl.parentNode === liveItem.bubble) {
        liveItem.bubble.insertBefore(list, liveItem._liveTextEl);
      } else {
        liveItem.bubble.insertBefore(list, liveItem.bubble.firstChild);
      }
      return list;
    }

    function updateProgressList(liveItem, items) {
      if (!liveItem) return;
      const listItems = Array.isArray(items) ? items : [];
      liveItem.progressItems = listItems;
      if (!liveItem.bubble || listItems.length === 0) {
        const existing = liveItem.bubble && liveItem.bubble.querySelector(".msg-progress");
        if (existing && listItems.length === 0) existing.remove();
        return;
      }
      const list = ensureProgressList(liveItem);
      if (!list) return;
      list.replaceChildren(...listItems.map((item, index) => {
        const li = document.createElement("li");
        const done = progressItemDone(item);
        const active = !done && listItems.findIndex((x) => !progressItemDone(x)) === index;
        li.className = done ? "is-done" : (active ? "is-active" : "is-pending");
        li.textContent = progressItemLabel(item) || "(step)";
        return li;
      }));
    }

    function showThinking(agent, sessionId) {
      const sid = sessionId || state.currentSessionId || "_pending";
      const rt = sessionRuntime(sid);
      if (rt.liveMessages.has(agent)) return;

      if (!isViewingSession(sid)) {
        rt.liveMessages.set(agent, {
          rawText: "",
          invocationId: rt.liveInvocations.get(agent) || null,
          detached: true,
          setBadge() {},
        });
        return;
      }

      const item = createMessage({ role: "assistant", agent, content: "" });
      item.setBadge("thinking");
      item.rawText = "";
      item.invocationId = rt.liveInvocations.get(agent) || null;
      rt.liveMessages.set(agent, item);
    }

    function stopThinking(agent, sessionId) {
      const rt = sessionRuntime(sessionId);
      const item = rt.liveMessages.get(agent);
      if (!item) return;
      item.setBadge("done");
    }

    function trimLiveStatus(text, max = 140) {
      const singleLine = String(text || "").replace(/\s+/g, " ").trim();
      if (!singleLine) return "";
      return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
    }

    function pendingTextForEvent(event) {
      if (!event || !event.type) return "";

      if (event.type === "run.started") return "正在执行…";
      if (event.type === "command.started") return `执行命令: ${trimLiveStatus(event.command || "")}`;
      if (event.type === "command.finished") return `命令完成: ${trimLiveStatus(event.command || "")}`;
      if (event.type === "file.changed") return `修改文件: ${trimLiveStatus(event.path || "")}`;
      if (event.type === "stderr") return trimLiveStatus(event.text || "");
      if (event.type === "tool.started") {
        const args = event.args && typeof event.args === "object" ? event.args : {};
        const detail = args.path || args.file || args.pattern || args.command || args.cmd || "";
        const label = detail
          ? `${event.toolName || "tool"} ${detail}`
          : (event.toolName || "tool");
        return `工具: ${trimLiveStatus(label)}`;
      }
      if (event.type === "tool.finished") {
        const status = event.status === "error" ? "失败" : "完成";
        const args = event.args && typeof event.args === "object" ? event.args : {};
        const detail = args.path || args.file || args.pattern || args.command || args.cmd || "";
        const label = detail
          ? `${event.toolName || "tool"} ${detail}`
          : (event.toolName || "tool");
        return `工具${status}: ${trimLiveStatus(label)}`;
      }
      if (event.type === "subagent.started") {
        return `子 Agent 启动: ${trimLiveStatus(event.name || event.toolName || "subagent")}`;
      }
      if (event.type === "subagent.progress") {
        return `子 Agent: ${trimLiveStatus(event.text || event.name || "运行中")}`;
      }
      if (event.type === "subagent.completed") {
        return `子 Agent 完成: ${trimLiveStatus(event.name || event.summary || "subagent")}`;
      }
      if (event.type === "subagent.failed") {
        return `子 Agent 失败: ${trimLiveStatus(event.error || event.name || "subagent")}`;
      }
      if (event.type === "progress.update") {
        const items = Array.isArray(event.items) ? event.items : [];
        const active = items.find((item) => item && item.done !== true) || items[items.length - 1];
        return active && active.text ? `进度: ${trimLiveStatus(active.text)}` : "";
      }
      return "";
    }

    function countProcessSteps(panel) {
      if (!panel || !panel.children) return 0;
      return panel.querySelectorAll
        ? panel.querySelectorAll(".live-tool-row, .live-subagent").length
        : panel.children.length;
    }

    function updateProcessDetailsLabel(details) {
      if (!details) return;
      const summary = details.querySelector(":scope > .msg-process-summary")
        || details.querySelector(".msg-process-summary");
      if (!summary) return;
      const panel = details.querySelector(".live-subagents");
      const n = countProcessSteps(panel);
      summary.textContent = n > 0 ? `执行过程 · ${n} 步` : "执行过程";
    }

    /**
     * Wrap a process-trace panel in <details>. Default collapsed when final;
     * open while live so the user can watch steps without losing the answer below.
     */
    function wrapProcessDetails(panel, { open = false, live = false } = {}) {
      if (!panel) return null;
      if (panel.classList && panel.classList.contains("msg-process")) {
        panel.open = open;
        if (!live) panel.removeAttribute("data-live");
        else panel.dataset.live = "true";
        updateProcessDetailsLabel(panel);
        return panel;
      }
      const details = document.createElement("details");
      details.className = "msg-process";
      details.open = open;
      if (live) details.dataset.live = "true";
      const summary = document.createElement("summary");
      summary.className = "msg-process-summary";
      summary.textContent = msg.process || "执行过程";
      // Move existing panel inside details.
      if (panel.parentNode) panel.parentNode.insertBefore(details, panel);
      details.append(summary, panel);
      updateProcessDetailsLabel(details);
      return details;
    }

    function ensureSubagentPanel(liveItem) {
      if (!liveItem || !liveItem.bubble) return null;
      let details = liveItem.bubble.querySelector(".msg-process");
      let panel = details
        ? details.querySelector(".live-subagents")
        : liveItem.bubble.querySelector(".live-subagents");
      if (panel) {
        if (!details) {
          wrapProcessDetails(panel, { open: true, live: true });
        }
        return panel;
      }

      panel = document.createElement("div");
      panel.className = "live-subagents";
      details = document.createElement("details");
      details.className = "msg-process";
      details.open = true;
      details.dataset.live = "true";
      const summary = document.createElement("summary");
      summary.className = "msg-process-summary";
      summary.textContent = msg.process || "执行过程";
      details.append(summary, panel);

      if (liveItem._liveTextEl && liveItem._liveTextEl.parentNode === liveItem.bubble) {
        liveItem.bubble.insertBefore(details, liveItem._liveTextEl);
      } else {
        const content = liveItem.bubble.querySelector(".msg-final-content");
        if (content) liveItem.bubble.insertBefore(details, content);
        else liveItem.bubble.appendChild(details);
      }
      return panel;
    }

    function ensureProcessPanel(liveItem) {
      return ensureSubagentPanel(liveItem);
    }

    function upsertProcessRow(agent, key, fields, sessionId) {
      const sid = sessionId || state.currentSessionId || "_pending";
      if (!isViewingSession(sid)) return;
      const rt = sessionRuntime(sid);
      if (!rt.liveMessages.has(agent)) showThinking(agent, sid);
      const liveItem = rt.liveMessages.get(agent);
      if (!liveItem || liveItem.detached || !liveItem.bubble) return;

      const panel = ensureProcessPanel(liveItem);
      if (!panel) return;

      const id = String(key || "process");
      let row = null;
      for (const child of panel.children) {
        if (child && child.dataset && child.dataset.processId === id) {
          row = child;
          break;
        }
      }
      if (!row) {
        row = document.createElement("div");
        row.className = "live-subagent live-tool-row";
        row.dataset.processId = id;
        row.innerHTML = `
          <div class="live-subagent-head">
            <span class="live-subagent-name"></span>
            <span class="live-subagent-status"></span>
          </div>
          <div class="live-subagent-task"></div>
          <div class="live-subagent-summary"></div>`;
        panel.appendChild(row);
      }

      const nameEl = row.querySelector(".live-subagent-name");
      const statusEl = row.querySelector(".live-subagent-status");
      const taskEl = row.querySelector(".live-subagent-task");
      const summaryEl = row.querySelector(".live-subagent-summary");

      nameEl.textContent = fields.name || "tool";
      const status = fields.status || "running";
      statusEl.textContent = fields.statusText || msg.running || "运行中";
      statusEl.className = `live-subagent-status status-${status}`;
      row.className = `live-subagent live-tool-row status-${status}`;
      taskEl.textContent = fields.task || "";
      summaryEl.textContent = fields.summary || "";
      const details = panel.closest && panel.closest(".msg-process");
      if (details) updateProcessDetailsLabel(details);
      scrollDown();
    }

    function upsertLiveSubagent(agent, event, sessionId) {
      let status = "running";
      let statusText = msg.running || "运行中";
      if (event.type === "subagent.completed") {
        status = "done";
        statusText = msg.success || "成功";
      } else if (event.type === "subagent.failed") {
        status = "error";
        statusText = msg.failed || "失败";
      } else if (event.type === "subagent.started") {
        status = "running";
        statusText = msg.running || "运行中";
      }
      const key = `subagent:${event.subagentId || event.toolId || event.name || "subagent"}`;
      upsertProcessRow(agent, key, {
        name: event.name || event.toolName || "subagent",
        status,
        statusText,
        task: truncateDisplay(event.task || "", 120),
        summary: processSummaryFromEvent(event),
      }, sessionId);
    }

    function upsertLiveTool(agent, event, sessionId) {
      if (isTaskLikeTool(event)) return;

      const detail = toolDetailFromEvent(event);
      const id = `tool:${event.toolId || event.toolName || detail || event.type}`;
      let status = "running";
      let statusText = msg.running || "运行中";
      if (event.type === "tool.finished" || event.type === "command.finished") {
        const failed = event.status === "error" || (event.exitCode !== undefined && event.exitCode !== 0);
        status = failed ? "error" : "done";
        statusText = failed ? (msg.failed || "失败") : (msg.done || "完成");
      }
      const name = event.type.startsWith("command.")
        ? "command"
        : (event.toolName || "tool");
      upsertProcessRow(agent, id, {
        name,
        status,
        statusText,
        task: detail || (event.toolName || ""),
        summary: processSummaryFromEvent(event),
      }, sessionId);
    }

    function setLivePending(agent, text, sessionId) {
      if (!text) return;
      const sid = sessionId || state.currentSessionId || "_pending";
      const rt = sessionRuntime(sid);
      if (!rt.liveMessages.has(agent)) showThinking(agent, sid);
      const item = rt.liveMessages.get(agent);
      if (!item) return;
      item.pendingStatus = text;
      if (!isViewingSession(sid)) return;
      if (item._liveTextEl && !item.rawText) {
        item._liveTextEl.textContent = text;
        scrollDown();
        return;
      }
      if (item.bubble) {
        let statusEl = item.bubble.querySelector(".live-process-status");
        if (!statusEl) {
          statusEl = document.createElement("div");
          statusEl.className = "live-process-status";
          if (item._liveTextEl && item._liveTextEl.parentNode === item.bubble) {
            item.bubble.insertBefore(statusEl, item._liveTextEl);
          } else {
            item.bubble.appendChild(statusEl);
          }
        }
        statusEl.textContent = text;
        scrollDown();
      }
    }

    let _rafId = null;
    let _rafPending = new Map();

    function _flushRaf() {
      for (const [key, raw] of _rafPending) {
        const sep = key.indexOf("::");
        const sid = sep === -1 ? state.currentSessionId : key.slice(0, sep);
        const agent = sep === -1 ? key : key.slice(sep + 2);
        if (!isViewingSession(sid)) continue;
        const item = sessionRuntime(sid).liveMessages.get(agent);
        if (!item || !item._liveTextEl) continue;
        item._liveTextEl.textContent = raw;
      }
      _rafPending.clear();
      _rafId = null;
      scrollDown();
    }

    function flushPendingLiveRender(sessionId) {
      if (_rafId) {
        cancelAnimationFrame(_rafId);
        _flushRaf();
      }
      void sessionId;
    }

    function appendLive(agent, text, sessionId) {
      const sid = sessionId || state.currentSessionId || "_pending";
      const rt = sessionRuntime(sid);
      const viewing = isViewingSession(sid);

      if (!rt.liveMessages.has(agent) || rt.liveMessages.get(agent)?.detached) {
        if (viewing) {
          const item = createMessage({ role: "assistant", agent });
          item.rawText = rt.liveMessages.get(agent)?.rawText || "";
          item.invocationId = rt.liveInvocations.get(agent) || null;
          item.setBadge("writing");
          rt.liveMessages.set(agent, item);
        } else {
          const prev = rt.liveMessages.get(agent);
          rt.liveMessages.set(agent, {
            rawText: (prev && prev.rawText) || "",
            invocationId: rt.liveInvocations.get(agent) || null,
            detached: true,
            setBadge() {},
          });
        }
      }

      const item = rt.liveMessages.get(agent);
      item.rawText = (item.rawText || "") + (text || "");

      if (!viewing) return;

      hideEmpty();
      ensureSpacer();
      if (item.bubble) item.bubble.classList.remove("msg-bubble-live-pending");
      if (item.setBadge) item.setBadge("writing");

      _rafPending.set(`${sid}::${agent}`, item.rawText);
      if (!_rafId) _rafId = requestAnimationFrame(_flushRaf);
      scrollDown();
    }

    function ensureLiveRun(event, sessionId) {
      const rt = sessionRuntime(sessionId);
      const invocationId = event && event.invocationId
        ? event.invocationId
        : rt.liveInvocations.get(event.agent) || event.agent;
      if (!rt.liveRuns.has(invocationId)) {
        rt.liveRuns.set(invocationId, {
          invocationId,
          agent: event.agent,
          text: "",
          thinking: "",
          progressItems: [],
          tools: [],
          subagents: [],
          commands: [],
          fileChanges: [],
          stderr: [],
          status: "thinking",
        });
      }
      return rt.liveRuns.get(invocationId);
    }

    function applyAgentEvent(event, sessionId) {
      if (!event || !event.type || !event.agent) return;
      const sid = sessionId || state.currentSessionId || "_pending";
      const run = ensureLiveRun(event, sid);

      if (event.type === "run.started") {
        run.status = "thinking";
        setLivePending(event.agent, pendingTextForEvent(event), sid);
        return;
      }

      if (event.type === "text.delta") {
        run.text += event.text || "";
        run.status = "writing";
        appendLive(event.agent, event.text || "", sid);
        return;
      }

      if (event.type === "thinking.delta" || event.type === "thinking.final") {
        run.thinking += event.text || "";
        const rt = sessionRuntime(sid);
        if (!rt.liveMessages.has(event.agent)) showThinking(event.agent, sid);
        const item = rt.liveMessages.get(event.agent);
        if (item && isViewingSession(sid)) {
          updateThinkingPanel(item, run.thinking);
        } else if (item) {
          item.thinkingText = run.thinking;
        }
        return;
      }

      if (event.type === "progress.update") {
        run.progressItems = Array.isArray(event.items) ? event.items : [];
        setLivePending(event.agent, pendingTextForEvent(event), sid);
        const rt = sessionRuntime(sid);
        if (!rt.liveMessages.has(event.agent)) showThinking(event.agent, sid);
        const item = rt.liveMessages.get(event.agent);
        if (item && isViewingSession(sid)) {
          updateProgressList(item, run.progressItems);
        } else if (item) {
          item.progressItems = run.progressItems;
        }
        return;
      }

      if (event.type === "tool.started" || event.type === "tool.finished") {
        run.tools.push(event);
        setLivePending(event.agent, pendingTextForEvent(event), sid);
        upsertLiveTool(event.agent, event, sid);
        return;
      }

      if (
        event.type === "subagent.started"
        || event.type === "subagent.progress"
        || event.type === "subagent.completed"
        || event.type === "subagent.failed"
      ) {
        if (!Array.isArray(run.subagents)) run.subagents = [];
        run.subagents.push(event);
        setLivePending(event.agent, pendingTextForEvent(event), sid);
        upsertLiveSubagent(event.agent, event, sid);
        return;
      }

      if (event.type === "command.started" || event.type === "command.finished") {
        run.commands.push(event);
        setLivePending(event.agent, pendingTextForEvent(event), sid);
        return;
      }

      if (event.type === "file.changed") {
        run.fileChanges.push({
          path: event.path || "",
          changeType: event.changeType || "",
        });
        setLivePending(event.agent, pendingTextForEvent(event), sid);
        return;
      }

      if (event.type === "stderr") {
        run.stderr.push(event.text || "");
        setLivePending(event.agent, pendingTextForEvent(event), sid);
        return;
      }

      if (event.type === "run.finished") {
        run.status = event.exitCode === 0 ? "done" : "error";
        if (run.status === "error") sessionRuntime(sid).status = "error";
      }
    }

    function appendTraceRow(panel, fields) {
      const row = document.createElement("div");
      row.className = "live-subagent live-tool-row status-" + (fields.status || "done");
      const head = document.createElement("div");
      head.className = "live-subagent-head";
      const name = document.createElement("span");
      name.className = "live-subagent-name";
      name.textContent = fields.name || "tool";
      const status = document.createElement("span");
      status.className = "live-subagent-status status-" + (fields.status || "done");
      status.textContent = fields.statusText || msg.done || "完成";
      head.append(name, status);
      row.appendChild(head);
      if (fields.task) {
        const task = document.createElement("div");
        task.className = "live-subagent-task";
        task.textContent = fields.task;
        row.appendChild(task);
      }
      if (fields.summary) {
        const summary = document.createElement("div");
        summary.className = "live-subagent-summary";
        summary.textContent = fields.summary;
        row.appendChild(summary);
      }
      panel.appendChild(row);
    }

    function renderProcessPanel(subById, toolById, commandByKey, options = {}) {
      if (subById.size === 0 && toolById.size === 0 && commandByKey.size === 0) return null;

      const panel = document.createElement("div");
      panel.className = "live-subagents live-subagents-final";

      const subagentToolIds = new Set();
      for (const evt of subById.values()) {
        if (evt.subagentId) subagentToolIds.add(String(evt.subagentId));
        if (evt.toolId) subagentToolIds.add(String(evt.toolId));
        const failed = evt.type === "subagent.failed";
        const done = evt.type === "subagent.completed" || failed;
        appendTraceRow(panel, {
          name: evt.name || evt.toolName || "subagent",
          status: failed ? "error" : (done ? "done" : "running"),
          statusText: failed ? (msg.failed || "失败") : (done ? (msg.success || "成功") : (msg.running || "运行中")),
          task: truncateDisplay(evt.task || "", 100),
          summary: processSummaryFromEvent(evt),
        });
      }

      for (const evt of toolById.values()) {
        if (isTaskLikeTool(evt)) continue;
        if (evt.toolId && subagentToolIds.has(String(evt.toolId))) continue;
        const detail = toolDetailFromEvent(evt);
        const failed = evt.status === "error";
        const done = evt.type === "tool.finished" || evt.result != null || evt.output != null;
        appendTraceRow(panel, {
          name: evt.toolName || "tool",
          status: failed ? "error" : (done ? "done" : "running"),
          statusText: failed ? (msg.failed || "失败") : (done ? (msg.done || "完成") : (msg.running || "运行中")),
          task: detail,
          // Final cards stay compact: only errors get a summary line.
          summary: failed ? processSummaryFromEvent(evt) : "",
        });
      }

      const toolDetails = new Set([...toolById.values()].map((t) => toolDetailFromEvent(t)).filter(Boolean));
      for (const evt of commandByKey.values()) {
        if (toolDetails.has(evt.command)) continue;
        const failed = evt.exitCode !== undefined && evt.exitCode !== 0;
        appendTraceRow(panel, {
          name: "command",
          status: failed ? "error" : "done",
          statusText: failed ? (msg.failed || "失败") : (msg.done || "完成"),
          task: truncateDisplay(evt.command, 120),
          summary: failed ? processSummaryFromEvent(evt) : "",
        });
      }

      if (!panel.childNodes.length) return null;
      const open = options.open === true;
      const live = options.live === true;
      return wrapProcessDetails(panel, { open, live });
    }

    function buildProcessTraceFromRun(agent, sid) {
      const rt = sessionRuntime(sid);
      const subById = new Map();
      const toolById = new Map();
      const commandByKey = new Map();
      for (const run of rt.liveRuns.values()) {
        if (!run || run.agent !== agent) continue;
        for (const evt of run.subagents || []) {
          if (!evt) continue;
          const id = String(evt.subagentId || evt.toolId || evt.name || subById.size);
          subById.set(id, evt);
        }
        for (const evt of run.tools || []) {
          if (!evt) continue;
          const detail = toolDetailFromEvent(evt);
          const id = String(evt.toolId || `${evt.toolName || "tool"}:${detail}`);
          const prev = toolById.get(id) || {};
          toolById.set(id, {
            ...prev,
            ...evt,
            args: evt.args || prev.args,
            toolName: evt.toolName || prev.toolName,
          });
        }
        for (const evt of run.commands || []) {
          if (!evt || !evt.command) continue;
          commandByKey.set(evt.command, evt);
        }
      }
      return renderProcessPanel(subById, toolById, commandByKey);
    }

    function buildProcessPanelFromTranscriptEvents(events) {
      const subById = new Map();
      const toolById = new Map();
      const commandByKey = new Map();

      for (const evt of events || []) {
        const kind = evt.kind || evt.type || "";
        const payload = evt.payload && typeof evt.payload === "object" ? evt.payload : {};
        const data = payload.type ? payload : { ...payload, type: kind };
        const type = data.type || kind;
        if (!type) continue;

        if (type.startsWith("subagent.")) {
          const id = String(data.subagentId || data.toolId || data.name || subById.size);
          subById.set(id, { ...data, type });
          continue;
        }
        if (type === "tool.started" || type === "tool.finished") {
          const detail = toolDetailFromEvent(data);
          const id = String(data.toolId || `${data.toolName || "tool"}:${detail}`);
          const prev = toolById.get(id) || {};
          toolById.set(id, {
            ...prev,
            ...data,
            type,
            args: data.args || prev.args,
            toolName: data.toolName || prev.toolName,
            result: data.result !== undefined ? data.result : prev.result,
            output: data.output !== undefined ? data.output : prev.output,
            status: data.status || prev.status,
          });
          continue;
        }
        if (type === "command.started" || type === "command.finished") {
          if (data.command) {
            const prev = commandByKey.get(data.command) || {};
            commandByKey.set(data.command, { ...prev, ...data, type });
          }
        }
      }

      return renderProcessPanel(subById, toolById, commandByKey);
    }

    async function hydrateProcessTrace(bubble, invocationId) {
      if (!bubble || !invocationId) return;
      if (bubble.querySelector(".msg-process, .live-subagents")) return;
      if (typeof fetchInvocationEvents !== "function") return;
      try {
        const page = await fetchInvocationEvents(invocationId);
        if (!page.events || page.events.length === 0) return;
        // History hydrate: always collapsed so the answer is primary.
        const panel = buildProcessPanelFromTranscriptEvents(page.events);
        if (!panel) return;
        if (bubble.querySelector(".msg-process, .live-subagents")) return;
        const content = bubble.querySelector(".msg-final-content");
        if (content) bubble.insertBefore(panel, content);
        else bubble.insertBefore(panel, bubble.firstChild);
      } catch (error) {
        console.warn("Process trace hydrate failed:", error);
      }
    }

    /** Queue of pending history hydrates; drained in idle chunks. */
    let _hydrateQueue = [];
    let _hydrateRunning = false;

    function drainHydrateQueue() {
      if (_hydrateRunning) return;
      _hydrateRunning = true;

      const step = () => {
        const batch = _hydrateQueue.splice(0, HYDRATE_CHUNK_SIZE);
        if (batch.length === 0) {
          _hydrateRunning = false;
          return;
        }
        Promise.all(batch.map((job) => hydrateProcessTrace(job.bubble, job.invocationId)))
          .catch(() => {})
          .finally(() => {
            if (_hydrateQueue.length === 0) {
              _hydrateRunning = false;
              return;
            }
            const ric = typeof requestIdleCallback === "function"
              ? requestIdleCallback
              : (cb) => setTimeout(cb, 16);
            ric(() => step());
          });
      };
      step();
    }

    function scheduleHydrateProcessTrace(bubble, invocationId) {
      if (!bubble || !invocationId) return;
      // Short histories hydrate immediately for snappy UX.
      const assistantCount = messagesEl
        ? messagesEl.querySelectorAll(".message.assistant").length
        : 0;
      if (assistantCount <= MESSAGE_VIRTUAL_THRESHOLD) {
        hydrateProcessTrace(bubble, invocationId);
        return;
      }
      _hydrateQueue.push({ bubble, invocationId });
      drainHydrateQueue();
    }

    function collapseProgressIntoDetails(progressEl) {
      if (!progressEl) return null;
      if (progressEl.classList && progressEl.classList.contains("msg-progress-wrap")) {
        progressEl.open = false;
        return progressEl;
      }
      const items = progressEl.querySelectorAll ? progressEl.querySelectorAll("li") : [];
      const n = items.length;
      if (n === 0) return null;
      const details = document.createElement("details");
      details.className = "msg-progress-wrap";
      details.open = false;
      const summary = document.createElement("summary");
      summary.className = "msg-progress-summary";
      const done = progressEl.querySelectorAll
        ? progressEl.querySelectorAll("li.is-done").length
        : 0;
      summary.textContent = done === n
        ? (typeof msg.progressDone === "function" ? msg.progressDone(n) : `进度 · ${n} 步已完成`)
        : (typeof msg.progressPartial === "function" ? msg.progressPartial(done, n) : `进度 · ${done}/${n}`);
      details.append(summary, progressEl);
      return details;
    }

    /**
     * Render a single live assistant bubble into its final form (markdown,
     * process trace, badge). Used both for whole-stream finish and per-agent
     * exit during A2A handoffs so the prior agent does not stay on "输出中".
     */
    function finalizeLiveItem(agent, item, sessionId, options = {}) {
      if (!item || item.detached || !item.bubble || !item.wrapper) return false;

      const sid = sessionId || state.currentSessionId || "_pending";
      const error = options.error === true;

      // Drop ephemeral live status chips — they don't belong on the final card.
      item.bubble.querySelectorAll(".live-process-status, .live-process-chips").forEach((el) => el.remove());

      const preservedProcess = item.bubble.querySelector(".msg-process");
      const preservedSubagents = item.bubble.querySelector(".live-subagents");
      if (preservedProcess) preservedProcess.remove();
      else if (preservedSubagents) preservedSubagents.remove();

      const preservedThinking = item.bubble.querySelector(".msg-thinking");
      if (preservedThinking) {
        preservedThinking.remove();
        preservedThinking.removeAttribute("data-live");
        preservedThinking.open = false;
      }
      const preservedProgress = item.bubble.querySelector(".msg-progress");
      if (preservedProgress) preservedProgress.remove();

      // Rebuild thinking from run state if panel was missing (detached remount).
      if (!preservedThinking && item.thinkingText) {
        updateThinkingPanel(item, item.thinkingText);
      }
      const thinkingEl = preservedThinking || item.bubble.querySelector(".msg-thinking");
      if (thinkingEl) {
        thinkingEl.removeAttribute("data-live");
        thinkingEl.open = false;
      }

      if (!preservedProgress && item.progressItems && item.progressItems.length) {
        updateProgressList(item, item.progressItems);
      }
      let progressEl = preservedProgress || item.bubble.querySelector(".msg-progress");
      if (progressEl) progressEl = collapseProgressIntoDetails(progressEl);

      const rendered = renderMd(item.rawText || "");
      const content = document.createElement("div");
      content.className = "msg-final-content";
      content.innerHTML = rendered;

      // Prefer a compact rebuilt process panel (collapsed) over the live expanded dump.
      let processEl = buildProcessTraceFromRun(agent, sid);
      if (!processEl && preservedProcess) {
        processEl = wrapProcessDetails(
          preservedProcess.classList.contains("msg-process")
            ? (preservedProcess.querySelector(".live-subagents") || preservedProcess)
            : preservedProcess,
          { open: false, live: false }
        );
      } else if (!processEl && preservedSubagents) {
        // Strip verbose summaries that may have been attached while live.
        preservedSubagents.querySelectorAll(".live-subagent-summary").forEach((el) => {
          el.textContent = "";
        });
        processEl = wrapProcessDetails(preservedSubagents, { open: false, live: false });
      }
      if (processEl && processEl.classList && processEl.classList.contains("msg-process")) {
        processEl.open = false;
        processEl.removeAttribute("data-live");
        updateProcessDetailsLabel(processEl);
      }

      item.bubble.replaceChildren();
      if (thinkingEl) item.bubble.appendChild(thinkingEl);
      if (progressEl) item.bubble.appendChild(progressEl);
      if (processEl) item.bubble.appendChild(processEl);
      item.bubble.appendChild(content);
      item.bubble.classList.remove("msg-bubble-live-pending");
      item.bubble.classList.remove("msg-bubble-live");

      if (!item.wrapper.querySelector(".msg-copy")) {
        const copy = document.createElement("button");
        copy.className = "msg-copy";
        copy.textContent = "⎘";
        copy.title = "复制消息";
        copy.setAttribute("aria-label", "复制消息");
        copy.dataset.copyHtml = rendered;
        copy.addEventListener("click", () => {
          copyToClipboard(item.rawText || "", copy, "✓", msg.copyFail || "失败");
        });
        const meta = item.wrapper.querySelector(".msg-meta");
        if (meta) meta.appendChild(copy);
      }
      if (item.invocationId && typeof attachRecallToggle === "function") {
        attachRecallToggle(item.wrapper, item.invocationId);
      }
      item.setBadge(error ? "error" : "done");
      item.finalized = true;
      return true;
    }

    /**
     * Finalize one agent after its invocation exits (A2A handoff path).
     * Removes it from liveMessages so session remount won't re-show "输出中"
     * and won't duplicate the history bubble loaded from /api/messages.
     */
    function finalizeLiveAgent(agent, sessionId, options = {}) {
      if (!agent) return;
      const sid = sessionId || state.currentSessionId || "_pending";
      flushPendingLiveRender(sid);
      const rt = sessionRuntime(sid);
      const invId = rt.liveInvocations.get(agent);
      if (invId && rt.liveRuns.has(invId)) {
        const run = rt.liveRuns.get(invId);
        run.status = options.error === true ? "error" : "done";
      }
      const item = rt.liveMessages.get(agent);
      if (!item) return;
      if (item.detached || !item.bubble || !item.wrapper) {
        // Background / non-viewing: session history is source of truth after exit.
        rt.liveMessages.delete(agent);
        return;
      }
      finalizeLiveItem(agent, item, sid, options);
      // Drop from live map so switchSession remount does not re-attach as writing.
      rt.liveMessages.delete(agent);
    }

    function finalizeLiveMessages(sessionId) {
      const sid = sessionId || state.currentSessionId || "_pending";
      flushPendingLiveRender(sid);
      const rt = sessionRuntime(sid);
      for (const [agent, item] of [...rt.liveMessages.entries()]) {
        if (!item) {
          rt.liveMessages.delete(agent);
          continue;
        }
        if (item.detached || !item.bubble || !item.wrapper) {
          // Completed-or-abandoned detached stubs: history will cover them.
          rt.liveMessages.delete(agent);
          continue;
        }
        finalizeLiveItem(agent, item, sid, { error: false });
        // Drop after finalize so a later switch while status is still settling
        // does not re-mount these as live "输出中" bubbles.
        rt.liveMessages.delete(agent);
      }
    }

    function finishStream(statusText, sessionId) {
      const sid = sessionId || state.currentSessionId || "_pending";
      const rt = sessionRuntime(sid);
      rt.doneReceived = true;
      if (rt.status !== "error") rt.status = "done";
      finalizeLiveMessages(sid);
      if (typeof onRuntimeStatusChange === "function") onRuntimeStatusChange(sid);
      if (!isViewingSession(sid)) return;
      if (statusText && typeof setStatus === "function") setStatus(statusText);
      const sessionController = typeof getSessionController === "function" ? getSessionController() : null;
      if (sessionController && typeof sessionController.loadSessions === "function") {
        sessionController.loadSessions();
      }
      if (typeof loadWorktreeStatus === "function") loadWorktreeStatus();
      if (state.rightPanelTab === "workspace" && typeof loadWorkspaceState === "function") {
        loadWorkspaceState();
      }
      if (typeof syncComposerControls === "function") syncComposerControls();
    }

    function addSystem(text, variant = "") {
      hideEmpty();
      ensureSpacer();
      createMessage({ role: "system", agent: "system", content: text, variant });

      const slot = typeof getSessionSlot === "function" ? getSessionSlot() : null;
      if (variant === "error" && slot && slot.lastPrompt) {
        const wrapper = document.createElement("article");
        wrapper.className = "message system";
        const meta = document.createElement("div");
        meta.className = "msg-meta";
        const metaLabel = document.createElement("span");
        metaLabel.className = "msg-name";
        metaLabel.textContent = roleDisplayName("system", "system");
        const metaRole = document.createElement("span");
        metaRole.className = "msg-role-label";
        metaRole.textContent = roleBadgeLabel("system");
        meta.append(metaLabel, metaRole);
        const card = document.createElement("div");
        card.className = "msg-card";
        const bubble = document.createElement("div");
        bubble.className = "msg-bubble";
        const retry = document.createElement("button");
        retry.className = "btn-retry";
        retry.textContent = "↻ 重试";
        retry.addEventListener("click", () => {
          const s = getSessionSlot();
          promptEl.value = s.lastPrompt;
          state.selectedAgent = s.lastAgent;
          if (typeof renderAgentTabs === "function") renderAgentTabs();
          const chatClient = typeof getChatClient === "function" ? getChatClient() : null;
          if (chatClient) chatClient.sendPrompt();
        });
        bubble.appendChild(retry);
        card.appendChild(bubble);
        wrapper.append(meta, card);
        messagesEl.insertBefore(wrapper, spacerEl);
        scrollDown();
      }
    }

    function addDebug(agent, text) {
      hideEmpty();
      ensureSpacer();
      createMessage({ role: "system", agent, content: text, variant: "stderr" });
    }

    /**
     * Re-attach or rebuild live agent bubbles after a session switch.
     * Handles: DOM wiped by switchSession, detached placeholders (updated while
     * background), and agents that only have thinking / pending status so far.
     */
    function remountLiveMessages(sessionId) {
      const rt = runtimeStore.get(sessionId);
      if (!rt || rt.liveMessages.size === 0) return;
      hideEmpty();
      ensureSpacer();

      for (const [agent, item] of [...rt.liveMessages.entries()]) {
        if (!item || item.finalized) {
          rt.liveMessages.delete(agent);
          continue;
        }

        const wrapperInDom = item.wrapper && messagesEl.contains(item.wrapper);
        if (wrapperInDom) continue;

        // Wrapper still held in memory (cleared from parent by replaceChildren).
        if (item.wrapper && !item.detached) {
          messagesEl.insertBefore(item.wrapper, spacerEl);
          continue;
        }

        // Detached / missing DOM: rebuild a live bubble from buffered state.
        // Keep empty rawText (thinking-only) so handoff targets stay visible.
        const rebuilt = createMessage({ role: "assistant", agent, content: "" });
        rebuilt.rawText = item.rawText || "";
        rebuilt.thinkingText = item.thinkingText || "";
        rebuilt.progressItems = Array.isArray(item.progressItems) ? item.progressItems : [];
        rebuilt.pendingStatus = item.pendingStatus || "";
        rebuilt.invocationId = item.invocationId || rt.liveInvocations.get(agent) || null;

        if (rebuilt.rawText && rebuilt._liveTextEl) {
          rebuilt._liveTextEl.textContent = rebuilt.rawText;
          if (rebuilt.bubble) rebuilt.bubble.classList.remove("msg-bubble-live-pending");
          rebuilt.setBadge("writing");
        } else {
          rebuilt.setBadge("thinking");
          if (rebuilt.pendingStatus && rebuilt._liveTextEl) {
            rebuilt._liveTextEl.textContent = rebuilt.pendingStatus;
          }
        }
        if (rebuilt.thinkingText) updateThinkingPanel(rebuilt, rebuilt.thinkingText);
        if (rebuilt.progressItems.length) updateProgressList(rebuilt, rebuilt.progressItems);

        rt.liveMessages.set(agent, rebuilt);
      }

      ensureSpacer();
      scrollDown();
    }

    function bindCodeBlockDelegates(documentRef) {
      const doc = documentRef || (typeof document !== "undefined" ? document : null);
      if (!doc || typeof doc.addEventListener !== "function") return;

      doc.addEventListener("click", (e) => {
        const btn = e.target.closest(".md-code-copy");
        if (!btn) return;
        const code = btn.closest(".md-code")?.querySelector("code");
        if (!code) return;
        // Plain code only — not the full message markdown.
        copyToClipboard(code.textContent, btn, msg.copyOk || "已复制", msg.copyFail || "失败");
      });

      doc.addEventListener("click", (e) => {
        const btn = e.target.closest(".md-code-toggle");
        if (!btn) return;
        const codeBlock = btn.closest(".md-code");
        if (!codeBlock) return;
        const pre = codeBlock.querySelector("pre");
        if (!pre) return;

        const isCollapsed = pre.classList.contains("md-code-pre-collapsed");
        if (isCollapsed) {
          pre.classList.remove("md-code-pre-collapsed");
          pre.classList.add("md-code-pre-expanded");
          btn.textContent = "▲";
          btn.title = "Collapse";
        } else {
          pre.classList.remove("md-code-pre-expanded");
          pre.classList.add("md-code-pre-collapsed");
          btn.textContent = "▼";
          btn.title = "Expand";
        }
      });
    }

    return {
      createMessage,
      showThinking,
      stopThinking,
      appendLive,
      applyAgentEvent,
      ensureLiveRun,
      flushPendingLiveRender,
      finalizeLiveAgent,
      finalizeLiveMessages,
      finishStream,
      remountLiveMessages,
      addSystem,
      addDebug,
      ensureSpacer,
      showEmpty,
      hideEmpty,
      scrollDown,
      setLivePending,
      pendingTextForEvent,
      upsertLiveSubagent,
      upsertLiveTool,
      buildProcessTraceFromRun,
      buildProcessPanelFromTranscriptEvents,
      hydrateProcessTrace,
      scheduleHydrateProcessTrace,
      updateThinkingPanel,
      updateProgressList,
      copyToClipboard,
      bindCodeBlockDelegates,
      isViewingSession,
      sessionRuntime,
      MESSAGE_VIRTUAL_THRESHOLD,
    };
  }

  const api = { createMessageView, MESSAGE_VIRTUAL_THRESHOLD };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.MessageView = api;
})(typeof window !== "undefined" ? window : globalThis);
