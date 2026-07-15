(function initRecallPanel(globalScope) {
  "use strict";

  function setRecallEmpty(targetEl, msg, isError, escHtml) {
    const cls = isError ? "recall-empty recall-empty-error" : "recall-empty";
    targetEl.innerHTML = `<div class="${cls}">${escHtml(msg)}</div>`;
  }

  function fmtEventTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /** Debug-only body text for raw event dump (not the primary process UI). */
  function eventBodyText(evt) {
    const p = evt.payload || {};
    if (
      evt.kind === "stdout" ||
      evt.kind === "stderr" ||
      evt.kind === "text.delta" ||
      evt.kind === "text.final"
    )
      return p.text || "";
    if (evt.kind === "thinking.delta" || evt.kind === "thinking.final") return p.text || "";
    if (evt.kind === "tool.started")
      return `${p.toolName || "tool"} ${JSON.stringify(p.args || {})}`;
    if (evt.kind === "tool.finished")
      return `${p.toolName || "tool"} -> ${JSON.stringify(p.result || {})}`;
    if (evt.kind === "subagent.started")
      return `${p.name || p.toolName || "subagent"} · ${p.task || "started"}`;
    if (evt.kind === "subagent.progress") return `${p.name || "subagent"} · ${p.text || "running"}`;
    if (evt.kind === "subagent.completed")
      return `${p.name || "subagent"} · ${p.summary || "done"}`;
    if (evt.kind === "subagent.failed") return `${p.name || "subagent"} · ${p.error || "failed"}`;
    if (evt.kind === "command.started") return p.command || "";
    if (evt.kind === "command.finished")
      return `${p.command || ""}${p.exitCode !== undefined ? ` -> exit ${p.exitCode}` : ""}${p.output ? `\n${p.output}` : ""}`;
    if (evt.kind === "file.changed") return `${p.changeType || "modified"} ${p.path || ""}`.trim();
    if (evt.kind === "progress.update") return JSON.stringify(p.items || [], null, 2);
    if (evt.kind === "invocation-start")
      return `agent: ${p.agent || "?"}${p.shouldResume ? " · resume" : ""}`;
    if (evt.kind === "invocation-end")
      return `code: ${p.code ?? "?"}${p.signal ? ` · signal: ${p.signal}` : ""}`;
    return JSON.stringify(p, null, 2);
  }

  function resolveProcessHelpers() {
    if (globalScope.MessageProcessHelpers) return globalScope.MessageProcessHelpers;
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./message-process-helpers.js");
      } catch {
        /* ignore */
      }
    }
    return {};
  }

  function resolveRecallLocale(localePack) {
    const defaults = {
      toggle: "回忆",
      toggleTitle: "定位到本次调用的执行过程",
      noEvents: "无事件记录",
      noTools: "无工具调用",
      rawEvents: (n) => `原始事件 · ${n}`,
      pageTruncated: (shown, total) => `仅显示前 ${shown} 条事件，完整记录共 ${total} 条`,
      loading: "加载中…",
      loadFailed: (msg) => `加载失败: ${msg}`,
      searching: "搜索中…",
      searchFailed: (msg) => `搜索失败: ${msg}`,
      noSession: "暂无会话",
      emptyList: "本会话暂无调用记录",
      noHits: "无匹配结果",
    };
    const pack = localePack && typeof localePack === "object" ? localePack : null;
    const fromLocale =
      pack && pack.recall && typeof pack.recall === "object"
        ? pack.recall
        : pack && pack.locale && pack.locale.recall
          ? pack.locale.recall
          : null;
    return { ...defaults, ...(fromLocale || {}) };
  }

  /**
   * Phase B: highlight process row or raw event for a focus eventNo.
   * Pure DOM helper — exported for tests.
   */
  function focusEventInTrace(root, eventNo, events, helpers) {
    if (!root) return false;
    const no = Number(eventNo);
    if (!Number.isFinite(no)) return false;
    const processHelpers = helpers || resolveProcessHelpers();

    root.querySelectorAll(".is-event-focus").forEach((el) => {
      el.classList.remove("is-event-focus");
    });

    function flash(el) {
      if (!el) return false;
      el.classList.add("is-event-focus");
      try {
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch {
        /* ignore */
      }
      setTimeout(() => el.classList.remove("is-event-focus"), 1800);
      return true;
    }

    // 1) Process row tagged with this eventNo
    for (const row of root.querySelectorAll(".live-tool-row, .live-subagent")) {
      const nos = String(row.dataset.eventNos || "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
      if (nos.includes(no)) {
        const process = row.closest(".msg-process");
        if (process) process.open = true;
        return flash(row);
      }
    }

    // 2) Map event → process row via shared anchor helper
    const list = Array.isArray(events) ? events : [];
    const evt =
      list.find((e) => e && Number(e.eventNo) === no) ||
      (list[no] && Number(list[no].eventNo) === no ? list[no] : null) ||
      list[no] ||
      null;
    if (evt && typeof processHelpers.processAnchorFromEvent === "function") {
      const anchor = processHelpers.processAnchorFromEvent(evt);
      if (anchor && anchor.rowId) {
        const match = [...root.querySelectorAll(`[data-trace-kind="${anchor.rowKind}"]`)].find(
          (el) => el.dataset.traceId === anchor.rowId
        );
        if (match) {
          const process = match.closest(".msg-process");
          if (process) process.open = true;
          return flash(match);
        }
      }
    }

    // 3) Fallback: open raw dump and highlight the event row
    const raw = root.querySelector(".recall-raw-events");
    if (raw) raw.open = true;
    const rawRow = root.querySelector(`.recall-event[data-event-no="${no}"]`);
    return flash(rawRow);
  }

  function createRecallPanel(deps) {
    const {
      bodyEl,
      searchInputEl,
      state,
      recallApi,
      agentLabel,
      fmtTime,
      escHtml,
      // Shared with message hydrate: events → .msg-process DOM
      buildProcessPanelFromEvents,
      locale: localePack,
      // Optional: message-view focusProcessPanel for in-message anchor
      focusProcessPanel,
    } = deps;
    const R = resolveRecallLocale(
      localePack || globalScope.Locale || globalScope.LocaleZhCN || null
    );
    const processHelpers = resolveProcessHelpers();

    function setRecallEmptyAll(msg, isError = false) {
      if (bodyEl) setRecallEmpty(bodyEl, msg, isError, escHtml);
    }

    function renderEventList(events) {
      const container = document.createElement("div");
      container.className = "recall-events";
      if (!events || events.length === 0) {
        setRecallEmpty(container, R.noEvents, false, escHtml);
        return container;
      }
      for (const evt of events) {
        const row = document.createElement("div");
        row.className = `recall-event kind-${evt.kind}`;
        if (evt.eventNo != null) row.dataset.eventNo = String(evt.eventNo);
        const head = document.createElement("div");
        head.className = "recall-event-head";
        const tag = document.createElement("span");
        tag.className = "recall-event-tag";
        tag.textContent = evt.kind;
        const time = document.createElement("span");
        time.className = "recall-event-time";
        time.textContent = fmtEventTime(evt.ts);
        head.append(tag, time);
        const body = document.createElement("div");
        body.className = "recall-event-body";
        body.textContent = eventBodyText(evt);
        row.append(head, body);
        container.append(row);
      }
      return container;
    }

    /**
     * Primary UI: process panel (same as message hydrate).
     * Debug: raw event dump in a collapsed <details>.
     * @param {Array} events
     * @param {{ focusEventNo?: number }} [options]
     */
    function renderInvocationTrace(events, options = {}) {
      const root = document.createElement("div");
      root.className = "recall-process-root";

      let processEl = null;
      if (typeof buildProcessPanelFromEvents === "function") {
        processEl = buildProcessPanelFromEvents(events, {
          open: true,
          emptyFallback: true,
        });
      }
      if (processEl) {
        root.appendChild(processEl);
      } else {
        // Fallback if renderer not wired (tests / partial boot).
        const empty = document.createElement("div");
        empty.className = "recall-process-empty";
        empty.textContent = R.noTools;
        root.appendChild(empty);
      }

      const raw = document.createElement("details");
      raw.className = "recall-raw-events";
      // Open raw when we need a non-process event focus fallback later.
      const summary = document.createElement("summary");
      summary.className = "recall-raw-events-summary";
      const n = Array.isArray(events) ? events.length : 0;
      summary.textContent =
        typeof R.rawEvents === "function" ? R.rawEvents(n) : `原始事件 · ${n}`;
      raw.append(summary, renderEventList(events));
      root.appendChild(raw);

      if (options.focusEventNo != null) {
        // Defer until attached to document so scrollIntoView works.
        const focusNo = options.focusEventNo;
        const run = () => focusEventInTrace(root, focusNo, events, processHelpers);
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
        else setTimeout(run, 0);
      }
      return root;
    }

    async function fetchInvocationEvents(invocationId) {
      const sid = state.currentSessionId;
      if (!sid || !invocationId) return { events: [], total: 0, from: 0 };
      const data = await recallApi.readInvocation(sid, invocationId, { from: 0, limit: 200 });
      const from = Number(data.from) || 0;
      const rawEvents = data.events || [];
      const events =
        typeof processHelpers.stampEventNos === "function"
          ? processHelpers.stampEventNos(rawEvents, from)
          : rawEvents;
      return {
        events,
        total: Number(data.total) || 0,
        from,
      };
    }

    function renderRecallPageMeta(total, shown) {
      if (!(total > shown)) return null;
      const note = document.createElement("div");
      note.className = "workspace-summary-meta";
      note.textContent =
        typeof R.pageTruncated === "function"
          ? R.pageTruncated(shown, total)
          : `仅显示前 ${shown} 条事件，完整记录共 ${total} 条`;
      return note;
    }

    function fillInvocationBody(target, page, options = {}) {
      const children = [];
      const meta = renderRecallPageMeta(page.total, page.events.length);
      if (meta) children.push(meta);
      children.push(
        renderInvocationTrace(page.events, {
          focusEventNo: options.focusEventNo,
        })
      );
      target.replaceChildren(...children);
    }

    /** In-message: open + scroll existing process panel (Phase B anchor). */
    function focusInlineProcess(wrapper) {
      if (typeof focusProcessPanel === "function") {
        return focusProcessPanel(wrapper);
      }
      const process =
        wrapper.querySelector(".msg-process") || wrapper.querySelector(".live-subagents");
      if (!process) return false;
      if (process.tagName === "DETAILS" || process.classList.contains("msg-process")) {
        process.open = true;
      }
      process.classList.add("is-recall-focus");
      try {
        process.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch {
        /* ignore */
      }
      setTimeout(() => process.classList.remove("is-recall-focus"), 1600);
      return true;
    }

    function attachRecallToggle(wrapper, invocationId) {
      if (!invocationId) return;
      const meta = wrapper.querySelector(".msg-meta");
      if (!meta || meta.querySelector(".msg-recall")) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "msg-recall";
      btn.textContent = R.toggle;
      btn.title = R.toggleTitle;
      btn.addEventListener("click", () => toggleMessageRecall(wrapper, invocationId, btn));
      meta.appendChild(btn);
    }

    async function toggleMessageRecall(wrapper, invocationId, btn) {
      // Close expanded dump if open.
      let panel = wrapper.querySelector(".msg-recall-panel");
      if (panel) {
        panel.remove();
        btn.classList.remove("open");
        return;
      }

      // Phase B: prefer navigate to hydrated process panel on the message.
      if (focusInlineProcess(wrapper)) {
        btn.classList.add("open");
        setTimeout(() => btn.classList.remove("open"), 1200);
        return;
      }

      // Fallback: no process card yet (text-only / hydrate pending) → inline dump.
      panel = document.createElement("div");
      panel.className = "msg-recall-panel";
      setRecallEmpty(panel, R.loading, false, escHtml);
      wrapper.appendChild(panel);
      btn.classList.add("open");
      try {
        const page = await fetchInvocationEvents(invocationId);
        fillInvocationBody(panel, page);
      } catch (e) {
        const err =
          typeof R.loadFailed === "function" ? R.loadFailed(e.message) : `加载失败: ${e.message}`;
        setRecallEmpty(panel, err, true, escHtml);
      }
    }

    async function loadRecallList() {
      if (searchInputEl) searchInputEl.value = "";
      setRecallEmptyAll(R.loading);
      const sid = state.currentSessionId;
      if (!sid) {
        setRecallEmptyAll(R.noSession);
        return;
      }
      try {
        renderRecallList(await recallApi.listInvocations(sid));
      } catch (e) {
        const err =
          typeof R.loadFailed === "function" ? R.loadFailed(e.message) : `加载失败: ${e.message}`;
        setRecallEmptyAll(err, true);
      }
    }

    function renderRecallList(invocations) {
      if (!bodyEl) return;
      if (invocations.length === 0) {
        setRecallEmptyAll(R.emptyList);
        return;
      }
      bodyEl.replaceChildren(
        ...invocations.map((inv) => {
          const row = document.createElement("div");
          row.className = "recall-item";
          row.dataset.invocationId = inv.invocationId;
          const head = document.createElement("div");
          head.className = "recall-item-head";
          const agent = document.createElement("span");
          agent.className = "recall-item-agent";
          agent.textContent = agentLabel(inv.agent);
          const st = document.createElement("span");
          st.className = `recall-item-state state-${inv.state}`;
          st.textContent = inv.state;
          const meta = document.createElement("span");
          meta.className = "recall-item-meta";
          meta.textContent = `${inv.eventCount} 事件 · ${fmtTime(inv.startedAt)}`;
          const caret = document.createElement("span");
          caret.className = "recall-item-caret";
          caret.textContent = "▸";
          head.append(agent, st, meta, caret);
          // Toggle only on head — body hosts nested <details> (过程/原始事件).
          // Row-level click would steal summary clicks and collapse the panel.
          head.addEventListener("click", () => toggleRecallItem(row, inv.invocationId));
          head.style.cursor = "pointer";
          row.append(head);
          return row;
        })
      );
    }

    function bindBodyInteractionGuard(body) {
      if (!body || body.dataset.guardBound === "1") return;
      body.dataset.guardBound = "1";
      // Defense in depth: never let body clicks bubble to an ancestor toggle.
      body.addEventListener("click", (e) => e.stopPropagation());
    }

    async function toggleRecallItem(row, invocationId) {
      let body = row.querySelector(".recall-item-body");
      if (body) {
        body.remove();
        row.classList.remove("expanded");
        return;
      }
      row.classList.add("expanded");
      body = document.createElement("div");
      body.className = "recall-item-body";
      setRecallEmpty(body, R.loading, false, escHtml);
      bindBodyInteractionGuard(body);
      row.append(body);
      try {
        const page = await fetchInvocationEvents(invocationId);
        fillInvocationBody(body, page);
      } catch (e) {
        const err =
          typeof R.loadFailed === "function" ? R.loadFailed(e.message) : `加载失败: ${e.message}`;
        setRecallEmpty(body, err, true, escHtml);
      }
    }

    async function runRecallSearch(query) {
      setRecallEmptyAll(R.searching);
      const sid = state.currentSessionId;
      if (!sid) {
        setRecallEmptyAll(R.noSession);
        return;
      }
      try {
        renderRecallHits(await recallApi.searchSession(sid, query, { limit: 30 }));
      } catch (e) {
        const err =
          typeof R.searchFailed === "function"
            ? R.searchFailed(e.message)
            : `搜索失败: ${e.message}`;
        setRecallEmptyAll(err, true);
      }
    }

    function renderRecallHits(hits) {
      if (!bodyEl) return;
      if (hits.length === 0) {
        setRecallEmptyAll(R.noHits);
        return;
      }
      bodyEl.replaceChildren(
        ...hits.map((hit) => {
          const row = document.createElement("div");
          row.className = "recall-hit";
          if (hit.invocationId) row.dataset.invocationId = hit.invocationId;
          if (hit.eventNo != null) row.dataset.eventNo = String(hit.eventNo);
          const head = document.createElement("div");
          head.className = "recall-hit-head";
          const kind = document.createElement("span");
          kind.className = "recall-hit-kind";
          // kind · #eventNo · agent (when known) · source
          const parts = [hit.kind];
          if (hit.eventNo != null && hit.sourceKind === "invocation-event") {
            parts[0] = `${hit.kind} · #${hit.eventNo}`;
          } else if (hit.eventNo != null && hit.invocationId) {
            parts.push(`#${hit.eventNo}`);
          }
          if (hit.agent) parts.push(agentLabel(hit.agent));
          kind.textContent = parts.join(" · ");
          const time = document.createElement("span");
          time.className = "recall-hit-time";
          time.textContent = fmtTime(hit.ts);
          head.append(kind, time);
          const snip = document.createElement("div");
          snip.className = "recall-hit-snippet";
          snip.textContent = hit.snippet;
          row.append(head, snip);
          // No invocationId (message / formal memory) → static snippet only.
          if (hit.invocationId) {
            // Head + snippet expand; expanded body must not re-trigger toggle.
            const openHit = () => toggleRecallHit(row, hit);
            head.addEventListener("click", openHit);
            snip.addEventListener("click", openHit);
            head.style.cursor = "pointer";
            snip.style.cursor = "pointer";
          } else {
            row.classList.add("recall-hit-static");
          }
          return row;
        })
      );
    }

    async function toggleRecallHit(row, hit) {
      let body = row.querySelector(".recall-item-body");
      if (body) {
        body.remove();
        return;
      }
      const invocationId = hit && hit.invocationId;
      if (!invocationId) return;
      body = document.createElement("div");
      body.className = "recall-item-body";
      setRecallEmpty(body, R.loading, false, escHtml);
      bindBodyInteractionGuard(body);
      row.append(body);
      try {
        const page = await fetchInvocationEvents(invocationId);
        fillInvocationBody(body, page, {
          focusEventNo: hit.eventNo != null ? hit.eventNo : undefined,
        });
      } catch (e) {
        const err =
          typeof R.loadFailed === "function" ? R.loadFailed(e.message) : `加载失败: ${e.message}`;
        setRecallEmpty(body, err, true, escHtml);
      }
    }

    function bindSearch() {
      if (!searchInputEl) return;
      searchInputEl.addEventListener("input", () => {
        clearTimeout(state.recallSearchDebounce);
        const q = searchInputEl.value.trim();
        if (!q) {
          loadRecallList();
          return;
        }
        state.recallSearchDebounce = setTimeout(() => runRecallSearch(q), 250);
      });
    }

    return {
      eventBodyText,
      fetchInvocationEvents,
      attachRecallToggle,
      attachMessageToggle: attachRecallToggle,
      loadRecallList,
      loadList: loadRecallList,
      runRecallSearch,
      bindSearch,
      setRecallEmptyAll,
      renderInvocationTrace,
      focusEventInTrace: (root, eventNo, events) =>
        focusEventInTrace(root, eventNo, events, processHelpers),
    };
  }

  const api = { createRecallPanel, eventBodyText, fmtEventTime, focusEventInTrace };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.RecallPanel = api;
})(typeof window !== "undefined" ? window : globalThis);
