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

  function eventBodyText(evt) {
    const p = evt.payload || {};
    if (evt.kind === "stdout" || evt.kind === "stderr" || evt.kind === "text.delta" || evt.kind === "text.final") return p.text || "";
    if (evt.kind === "thinking.delta" || evt.kind === "thinking.final") return p.text || "";
    if (evt.kind === "tool.started") return `${p.toolName || "tool"} ${JSON.stringify(p.args || {})}`;
    if (evt.kind === "tool.finished") return `${p.toolName || "tool"} -> ${JSON.stringify(p.result || {})}`;
    if (evt.kind === "subagent.started") return `${p.name || p.toolName || "subagent"} · ${p.task || "started"}`;
    if (evt.kind === "subagent.progress") return `${p.name || "subagent"} · ${p.text || "running"}`;
    if (evt.kind === "subagent.completed") return `${p.name || "subagent"} · ${p.summary || "done"}`;
    if (evt.kind === "subagent.failed") return `${p.name || "subagent"} · ${p.error || "failed"}`;
    if (evt.kind === "command.started") return p.command || "";
    if (evt.kind === "command.finished") return `${p.command || ""}${p.exitCode !== undefined ? ` -> exit ${p.exitCode}` : ""}${p.output ? `\n${p.output}` : ""}`;
    if (evt.kind === "file.changed") return `${p.changeType || "modified"} ${p.path || ""}`.trim();
    if (evt.kind === "progress.update") return JSON.stringify(p.items || [], null, 2);
    if (evt.kind === "invocation-start") return `agent: ${p.agent || "?"}${p.shouldResume ? " · resume" : ""}`;
    if (evt.kind === "invocation-end") return `code: ${p.code ?? "?"}${p.signal ? ` · signal: ${p.signal}` : ""}`;
    return JSON.stringify(p, null, 2);
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
    } = deps;

    function setRecallEmptyAll(msg, isError = false) {
      if (bodyEl) setRecallEmpty(bodyEl, msg, isError, escHtml);
    }

    function renderEventList(events) {
      const container = document.createElement("div");
      container.className = "recall-events";
      if (!events || events.length === 0) {
        setRecallEmpty(container, "无事件记录", false, escHtml);
        return container;
      }
      for (const evt of events) {
        const row = document.createElement("div");
        row.className = `recall-event kind-${evt.kind}`;
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

    async function fetchInvocationEvents(invocationId) {
      const sid = state.currentSessionId;
      if (!sid || !invocationId) return { events: [], total: 0 };
      const data = await recallApi.readInvocation(sid, invocationId, { from: 0, limit: 200 });
      return {
        events: data.events || [],
        total: Number(data.total) || 0,
      };
    }

    function renderRecallPageMeta(total, shown) {
      if (!(total > shown)) return null;
      const note = document.createElement("div");
      note.className = "workspace-summary-meta";
      note.textContent = `仅显示前 ${shown} 条事件，完整记录共 ${total} 条`;
      return note;
    }

    function attachRecallToggle(wrapper, invocationId) {
      if (!invocationId) return;
      const meta = wrapper.querySelector(".msg-meta");
      if (!meta || meta.querySelector(".msg-recall")) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "msg-recall";
      btn.textContent = "回忆";
      btn.title = "展开本次调用的执行记录";
      btn.addEventListener("click", () => toggleMessageRecall(wrapper, invocationId, btn));
      meta.appendChild(btn);
    }

    async function toggleMessageRecall(wrapper, invocationId, btn) {
      let panel = wrapper.querySelector(".msg-recall-panel");
      if (panel) {
        panel.remove();
        btn.classList.remove("open");
        return;
      }
      panel = document.createElement("div");
      panel.className = "msg-recall-panel";
      setRecallEmpty(panel, "加载中…", false, escHtml);
      wrapper.appendChild(panel);
      btn.classList.add("open");
      try {
        const page = await fetchInvocationEvents(invocationId);
        const children = [];
        const meta = renderRecallPageMeta(page.total, page.events.length);
        if (meta) children.push(meta);
        children.push(renderEventList(page.events));
        panel.replaceChildren(...children);
      } catch (e) {
        setRecallEmpty(panel, "加载失败: " + e.message, true, escHtml);
      }
    }

    async function loadRecallList() {
      if (searchInputEl) searchInputEl.value = "";
      setRecallEmptyAll("加载中…");
      const sid = state.currentSessionId;
      if (!sid) { setRecallEmptyAll("暂无会话"); return; }
      try {
        renderRecallList(await recallApi.listInvocations(sid));
      } catch (e) {
        setRecallEmptyAll("加载失败: " + e.message, true);
      }
    }

    function renderRecallList(invocations) {
      if (!bodyEl) return;
      if (invocations.length === 0) {
        setRecallEmptyAll("本会话暂无调用记录");
        return;
      }
      bodyEl.replaceChildren(...invocations.map((inv) => {
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
        row.append(head);
        row.addEventListener("click", () => toggleRecallItem(row, inv.invocationId));
        return row;
      }));
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
      setRecallEmpty(body, "加载中…", false, escHtml);
      row.append(body);
      try {
        const page = await fetchInvocationEvents(invocationId);
        const children = [];
        const meta = renderRecallPageMeta(page.total, page.events.length);
        if (meta) children.push(meta);
        children.push(renderEventList(page.events));
        body.replaceChildren(...children);
      } catch (e) {
        setRecallEmpty(body, "加载失败: " + e.message, true, escHtml);
      }
    }

    async function runRecallSearch(query) {
      setRecallEmptyAll("搜索中…");
      const sid = state.currentSessionId;
      if (!sid) { setRecallEmptyAll("暂无会话"); return; }
      try {
        renderRecallHits(await recallApi.searchSession(sid, query, { limit: 30 }));
      } catch (e) {
        setRecallEmptyAll("搜索失败: " + e.message, true);
      }
    }

    function renderRecallHits(hits) {
      if (!bodyEl) return;
      if (hits.length === 0) {
        setRecallEmptyAll("无匹配结果");
        return;
      }
      bodyEl.replaceChildren(...hits.map((hit) => {
        const row = document.createElement("div");
        row.className = "recall-hit";
        row.dataset.invocationId = hit.invocationId;
        const head = document.createElement("div");
        head.className = "recall-hit-head";
        const kind = document.createElement("span");
        kind.className = "recall-hit-kind";
        kind.textContent = `${hit.kind} · #${hit.eventNo}`;
        const time = document.createElement("span");
        time.className = "recall-hit-time";
        time.textContent = fmtTime(hit.ts);
        head.append(kind, time);
        const snip = document.createElement("div");
        snip.className = "recall-hit-snippet";
        snip.textContent = hit.snippet;
        row.append(head, snip);
        row.addEventListener("click", () => toggleRecallHit(row, hit.invocationId));
        return row;
      }));
    }

    async function toggleRecallHit(row, invocationId) {
      let body = row.querySelector(".recall-item-body");
      if (body) {
        body.remove();
        return;
      }
      body = document.createElement("div");
      body.className = "recall-item-body";
      setRecallEmpty(body, "加载中…", false, escHtml);
      row.append(body);
      try {
        const page = await fetchInvocationEvents(invocationId);
        const children = [];
        const meta = renderRecallPageMeta(page.total, page.events.length);
        if (meta) children.push(meta);
        children.push(renderEventList(page.events));
        body.replaceChildren(...children);
      } catch (e) {
        setRecallEmpty(body, "加载失败: " + e.message, true, escHtml);
      }
    }

    function bindSearch() {
      if (!searchInputEl) return;
      searchInputEl.addEventListener("input", () => {
        clearTimeout(state.recallSearchDebounce);
        const q = searchInputEl.value.trim();
        if (!q) { loadRecallList(); return; }
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
    };
  }

  const api = { createRecallPanel, eventBodyText, fmtEventTime };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.RecallPanel = api;
})(typeof window !== "undefined" ? window : globalThis);
