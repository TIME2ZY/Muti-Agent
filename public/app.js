  (function() {
    "use strict";

    /* ═══════════════════════════════════════════════════════════
       DOM REFS
       ═══════════════════════════════════════════════════════════ */

    const $ = (sel) => document.querySelector(sel);

    const messagesEl   = $("#messages");
    const promptEl     = $("#prompt");
    const btnSend      = $("#btn-send");
    const btnClear     = $("#btn-clear");
    const skillsBarEl  = $("#skills-bar");
    const statusEl     = $("#status");
    const sidebarEl    = $("#sidebar");
    const sidebarToggle = $("#sidebar-toggle");
    const sidebarOverlay = $("#sidebar-overlay");
    const sessionListEl = $("#session-list");
    const btnNewChat   = $("#btn-new-chat");
    const agentTabsEl  = $("#agent-tabs");
    const emptyStateEl = $("#empty-state");
    const spacerEl     = messagesEl.querySelector(".messages-spacer");
    const skillsLabel  = skillsBarEl.querySelector(".skills-bar-label");
    const themeToggle  = $("#theme-toggle");
    const projectDirEl = $("#project-dir");
    const projectDirPath = $("#project-dir-path");
    const worktreeStatusEl = $("#worktree-status");
    const mentionMenuEl = $("#mention-menu");
    const memoryToggle = $("#memory-toggle");
    const memoryPanel = $("#memory-panel");
    const memoryOverlay = $("#memory-overlay");
    const memoryClose = $("#memory-close");
    const memoryRefresh = $("#memory-refresh");
    const memorySearchInput = $("#memory-search-input");
    const memoryList = $("#memory-list");
    const memoryBody = $("#memory-body");

    /* ═══════════════════════════════════════════════════════════
       THEME
       ═══════════════════════════════════════════════════════════ */

    const THEME_KEY = "agent-chat-theme";

    function initTheme() {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved) document.documentElement.setAttribute("data-theme", saved);
    }

    themeToggle.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      // P3-7 fix: when no saved theme, flip based on current system preference
      const next = current === "dark" ? "light"
                 : current === "light" ? "dark"
                 : window.matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem(THEME_KEY, next);
    });

    /* ═══════════════════════════════════════════════════════════
       PROJECT DIRECTORY
       ═══════════════════════════════════════════════════════════ */

    async function loadProjectDir() {
      try {
        const res = await fetch("/api/project");
        const data = await jsonOrThrow(res);
        state.projectDir = data.dir || "";
        projectDirPath.textContent = state.projectDir || "(当前目录)";
      } catch {
        projectDirPath.textContent = "(当前目录)";
      }
    }

    async function loadWorktreeStatus() {
      if (!state.currentSessionId) {
        state.worktreeStatus = null;
        renderWorktreeStatus();
        return;
      }
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/worktree/status`);
        if (!res.ok) {
          state.worktreeStatus = null;
          renderWorktreeStatus();
          return;
        }
        state.worktreeStatus = await jsonOrThrow(res);
        renderWorktreeStatus();
      } catch {
        state.worktreeStatus = null;
        renderWorktreeStatus();
      }
    }

    function renderWorktreeStatus() {
      const wt = state.worktreeStatus;
      if (!wt) {
        worktreeStatusEl.textContent = "";
        worktreeStatusEl.className = "worktree-status";
        worktreeStatusEl.title = "当前对话尚未创建修改 worktree";
        return;
      }
      const marker = wt.clean ? "clean" : "dirty";
      worktreeStatusEl.textContent = `${wt.branch || "(worktree)"} · ${marker}`;
      worktreeStatusEl.className = "worktree-status" + (wt.clean ? "" : " dirty");
      worktreeStatusEl.title = wt.worktreeDir || wt.branch || "";
    }

    projectDirEl.addEventListener("click", () => {
      if (projectDirEl.classList.contains("editing")) return;
      // Enter edit mode
      const input = document.createElement("input");
      input.className = "project-dir-input";
      input.value = state.projectDir;
      input.placeholder = "/path/to/project";
      projectDirEl.classList.add("editing");
      projectDirEl.appendChild(input);
      input.focus();
      input.select();

      const done = async (save) => {
        const val = input.value.trim();
        input.remove();
        projectDirEl.classList.remove("editing");

        if (save && val && val !== state.projectDir) {
          try {
            const res = await fetch("/api/project", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ dir: val }),
            });
            const data = await jsonOrThrow(res);
            state.projectDir = data.dir;
            projectDirPath.textContent = data.dir;
          } catch (e) {
            alert("设置失败: " + e.message);
          }
        }
      };

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); done(true); }
        if (e.key === "Escape") { done(false); }
      });
      input.addEventListener("blur", () => done(true));
    });

    /* ═══════════════════════════════════════════════════════════
       STATE
       ═══════════════════════════════════════════════════════════ */

    const state = {
      agents: [],
      selectedAgent: "architect",
      currentSessionId: null,
      controller: null,
      skillsMetadata: [],
      lastPrompt: "",
      lastAgent: "architect",
      doneReceived: false,
      liveMessages: new Map(),   // agent → { wrapper, bubble, rawText }
      skillDebounce: null,
      projectDir: "",
      worktreeStatus: null,
      mentionOpen: false,
      mentionIndex: 0,
      mentionMatches: [],
      mentionRange: null,
    };

    /* ═══════════════════════════════════════════════════════════
       HELPERS
       ═══════════════════════════════════════════════════════════ */

    function escHtml(text) {
      const el = document.createElement("span");
      el.textContent = text;
      return el.innerHTML;
    }

    function fmtTime(iso) {
      if (!iso) return "";
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return "刚刚";
      if (mins < 60) return `${mins}m`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h`;
      return `${Math.floor(hrs / 24)}d`;
    }

    function agentLabel(id) {
      return state.agents.find((a) => a.id === id)?.label || id;
    }

    function agentMention(agent) {
      return agent.label || agent.id;
    }

    function agentMeta(agent) {
      const cliLabel = agent.cli === "opencode" ? "opencode go" : agent.cli;
      if (agent.cli === "opencode") return `${cliLabel} · ${agent.model}`;
      return agent.reasoningEffort
        ? `${cliLabel} · ${agent.model} · ${agent.reasoningEffort}`
        : `${cliLabel} · ${agent.model}`;
    }

    function resolvePromptAgent(prompt) {
      const text = prompt.trimStart();
      const agents = [...state.agents].sort((a, b) => agentMention(b).length - agentMention(a).length);
      for (const agent of agents) {
        const labels = [agentMention(agent), agent.id].filter(Boolean);
        for (const label of labels) {
          const token = `@${label}`;
          if (text === token || text.startsWith(`${token} `) || text.startsWith(`${token}\n`)) {
            return agent;
          }
        }
      }
      return null;
    }

    function scrollDown() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function ensureSpacer() {
      if (!messagesEl.contains(spacerEl)) messagesEl.appendChild(spacerEl);
    }

    function hideEmpty() {
      if (emptyStateEl.parentNode) emptyStateEl.remove();
    }

    function showEmpty() {
      ensureSpacer();
      if (!emptyStateEl.parentNode) {
        messagesEl.insertBefore(emptyStateEl, spacerEl);
      }
    }

    async function jsonOrThrow(res) {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `${res.status} ${res.statusText}`);
      }
      return data;
    }

    /* ═══════════════════════════════════════════════════════════
       MARKDOWN
       ═══════════════════════════════════════════════════════════ */

    // A small, dependency-free GFM-ish renderer.
    // Pipeline:
    //   1. Protect fenced code blocks with placeholders
    //   2. Process block-level patterns line-by-line (tables, lists, quotes, hr, headers)
    //   3. Process inline patterns (code, bold, italic, strike, links, autolinks)
    //   4. Restore code blocks with a header bar (language + copy button)
    function renderMd(text) {
      if (!text) return "";

      const MARKER = "\uE000";
      const codeBlocks = [];
      let html = escHtml(text);

      // 1. Fenced code blocks — store with language label
      html = html.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        codeBlocks.push({ lang: lang || "", code: code.replace(/\n$/, "") });
        return `${MARKER}${idx}${MARKER}`;
      });

      // Also handle inline code blocks first to protect them from later replacements
      const inlineCodes = [];
      html = html.replace(/`([^`\n]+)`/g, (_, code) => {
        const idx = inlineCodes.length;
        inlineCodes.push(code);
        return `${MARKER}i${idx}${MARKER}`;
      });

      // 2. Block-level patterns (line-by-line)
      const lines = html.split("\n");
      const out = [];
      let i = 0;
      let inList = null; // "ul" | "ol"
      let listType = null; // tracks GFM task list
      const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; listType = null; } };

      while (i < lines.length) {
        const raw = lines[i];

        // Horizontal rule
        if (/^---+\s*$/.test(raw) || /^\*\*\*+\s*$/.test(raw)) {
          closeList();
          out.push("<hr>");
          i++;
          continue;
        }

        // Table — header row + alignment row + body
        // Format: | col1 | col2 | followed by | --- | :---: | etc.
        if (/^\|.*\|\s*$/.test(raw) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
          closeList();
          const headerCells = splitTableRow(raw);
          const alignCells = splitTableRow(lines[i + 1]);
          const aligns = alignCells.map((c) => {
            const left = c.trim().startsWith(":");
            const right = c.trim().endsWith(":");
            if (left && right) return "center";
            if (right) return "right";
            if (left) return "left";
            return "";
          });
          const bodyRows = [];
          let j = i + 2;
          while (j < lines.length && /^\|.*\|\s*$/.test(lines[j]) && lines[j].trim()) {
            bodyRows.push(splitTableRow(lines[j]));
            j++;
          }
          out.push("<table class=\"md-table\"><thead><tr>");
          headerCells.forEach((c, k) => {
            const align = aligns[k] ? ` style="text-align:${aligns[k]}"` : "";
            out.push(`<th${align}>${c}</th>`);
          });
          out.push("</tr></thead><tbody>");
          bodyRows.forEach((row) => {
            out.push("<tr>");
            row.forEach((c, k) => {
              const align = aligns[k] ? ` style="text-align:${aligns[k]}"` : "";
              out.push(`<td${align}>${c}</td>`);
            });
            out.push("</tr>");
          });
          out.push("</tbody></table>");
          i = j;
          continue;
        }

        // Headers: ###, ##, #
        const h = raw.match(/^(#{1,3})\s+(.+)/);
        if (h) {
          closeList();
          const level = h[1].length;
          out.push(`<h${level} class="md-h md-h${level}">${h[2]}</h${level}>`);
          i++;
          continue;
        }

        // Task list item: - [ ] or - [x]
        const task = raw.match(/^[-*]\s+\[([ xX])\]\s+(.+)/);
        if (task) {
          if (inList !== "ul" || listType !== "task") {
            closeList();
            out.push("<ul class=\"md-task\">");
            inList = "ul";
            listType = "task";
          }
          const checked = task[1] !== " ";
          out.push(`<li><input type="checkbox" disabled${checked ? " checked" : ""}><span>${task[2]}</span></li>`);
          i++;
          continue;
        }

        // Unordered list: - or *
        const ul = raw.match(/^[-*]\s+(.+)/);
        if (ul) {
          if (inList !== "ul" || listType !== "ul") {
            closeList();
            out.push("<ul>");
            inList = "ul";
            listType = "ul";
          }
          out.push(`<li>${ul[1]}</li>`);
          i++;
          continue;
        }

        // Ordered list: 1.
        const ol = raw.match(/^\d+\.\s+(.+)/);
        if (ol) {
          if (inList !== "ol") { closeList(); out.push("<ol>"); inList = "ol"; listType = "ol"; }
          out.push(`<li>${ol[1]}</li>`);
          i++;
          continue;
        }

        // Blockquote: > (allow consecutive lines to merge)
        if (/^>\s?/.test(raw)) {
          closeList();
          const quoteLines = [];
          while (i < lines.length && /^>\s?/.test(lines[i])) {
            quoteLines.push(lines[i].replace(/^>\s?/, ""));
            i++;
          }
          out.push(`<blockquote class="md-quote">${quoteLines.join("<br>")}</blockquote>`);
          continue;
        }

        // Blank line
        if (raw.trim() === "") {
          closeList();
          out.push("");
          i++;
          continue;
        }

        closeList();
        out.push(raw);
        i++;
      }
      closeList();

      html = out.join("\n");

      // 3. Inline patterns (safe order: code > autolink > links > bold > italic > strike)
      html = html.replace(/<(http[^>\s]+)>/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_, label, url) => `<a href="${escHtml(url)}" target="_blank" rel="noopener">${escHtml(label)}</a>`);
      html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
      // bold then italic (italic uses single * that is not part of **)
      html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

      // 4. Restore inline code placeholders
      html = html.replace(new RegExp(`${MARKER}i(\\d+)${MARKER}`, "g"), (_, k) =>
        `<code class="md-code-inline">${inlineCodes[+k]}</code>`);

      // 5. Restore code block placeholders — wrap in a container with header bar
      html = html.replace(new RegExp(`${MARKER}(\\d+)${MARKER}`, "g"), (_, k) => {
        const { lang, code } = codeBlocks[+k];
        const langLabel = lang || "text";
        return `<div class="md-code"><div class="md-code-head"><span class="md-code-lang">${escHtml(langLabel)}</span><button type="button" class="md-code-copy" data-copy="1">Copy</button></div><pre><code class="lang-${escHtml(lang)}">${code}</code></pre></div>`;
      });

      return html;
    }

    function splitTableRow(line) {
      // Trim leading/trailing pipe, then split. Empty cells preserved.
      const inner = line.replace(/^\||\|$/g, "");
      return inner.split("|").map((c) => c.trim());
    }

    // Wire up copy buttons on every code block after render.
    // Delegated handler — robust to re-renders.
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".md-code-copy");
      if (!btn) return;
      const code = btn.closest(".md-code")?.querySelector("code");
      if (!code) return;
      const text = code.textContent;
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1200);
      }).catch(() => {
        btn.textContent = "Failed";
        setTimeout(() => { btn.textContent = "Copy"; }, 1200);
      });
    });

    /* ═══════════════════════════════════════════════════════════
       STATUS
       ═══════════════════════════════════════════════════════════ */

    function setStatus(text, cls) {
      if (!text || text === "就绪") {
        statusEl.style.display = "none";
        return;
      }
      statusEl.style.display = "";
      statusEl.textContent = text;
      statusEl.className = "main-status" + (cls ? " " + cls : "");
    }

    /* ═══════════════════════════════════════════════════════════
       SIDEBAR
       ═══════════════════════════════════════════════════════════ */

    function toggleSidebar() {
      sidebarEl.classList.toggle("open");
    }

    sidebarToggle.addEventListener("click", toggleSidebar);
    sidebarOverlay.addEventListener("click", toggleSidebar);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && sidebarEl.classList.contains("open")) {
        toggleSidebar();
      }
    });

    function closeSidebarIfMobile() {
      if (window.innerWidth <= 700) sidebarEl.classList.remove("open");
    }

    async function refreshSessionList() {
      try {
        const res = await fetch("/api/sessions");
        const data = await jsonOrThrow(res);
        const sessions = data.sessions || [];
        renderSessionList(sessions);
        return sessions;
      } catch {
        // Session list load failure is non-critical
        return [];
      }
    }

    async function loadSessions() {
      const sessions = await refreshSessionList();
      if (!state.currentSessionId && sessions.length > 0) {
        try {
          await switchSession(sessions[0].id);
        } catch {
          // Initial history load failure is non-critical
        }
      }
    }

    function renderSessionList(sessions) {
      if (sessions.length === 0) {
        sessionListEl.innerHTML = '<div class="session-empty">暂无对话</div>';
        return;
      }
      sessionListEl.replaceChildren(...sessions.map((s) => {
        const item = document.createElement("div");
        item.className = "session-item" + (s.id === state.currentSessionId ? " active" : "");
        item.innerHTML = `
          <div class="session-info">
            <div class="session-title">${escHtml(s.title || "(空对话)")}</div>
            <div class="session-meta">${s.messageCount || 0} 条 · ${fmtTime(s.createdAt)}</div>
          </div>`;

        item.addEventListener("click", (e) => {
          if (e.target.closest(".btn-delete-session")) return;
          switchSession(s.id);
          closeSidebarIfMobile();
        });

        const del = document.createElement("button");
        del.className = "btn-delete-session";
        del.textContent = "×";
        del.title = "删除对话";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteSession(s.id);
        });
        item.appendChild(del);

        return item;
      }));
    }

    async function switchSession(id) {
      if (id === state.currentSessionId) return;
      const previousSessionId = state.currentSessionId;
      state.currentSessionId = id;
      state.liveMessages.clear();
      messagesEl.replaceChildren();
      try {
        const res = await fetch(`/api/messages?sessionId=${id}`);
        const data = await jsonOrThrow(res);
        if (!data.messages || data.messages.length === 0) {
          ensureSpacer();
          showEmpty();
        } else {
          for (const msg of data.messages) {
            createMessage({
              role: msg.role,
              agent: msg.agent,
              content: msg.content || "",
              variant: msg.exitCode && msg.exitCode !== 0 ? "error" : "",
            });
          }
          ensureSpacer();
        }
      } catch (e) {
        state.currentSessionId = previousSessionId;
        addSystem("加载消息失败: " + e.message, "error");
        ensureSpacer();
      }
      await refreshSessionList();
      await loadWorktreeStatus();
      if (!memoryPanel.hidden) refreshMemoryList();
    }

    async function newSession() {
      try {
        const res = await fetch("/api/sessions", { method: "POST" });
        const data = await jsonOrThrow(res);
        state.currentSessionId = data.session.id;
        state.liveMessages.clear();
        messagesEl.replaceChildren();
        ensureSpacer();
        showEmpty();
        state.worktreeStatus = null;
        renderWorktreeStatus();
        setStatus("就绪");
        await refreshSessionList();
        promptEl.focus();
        closeSidebarIfMobile();
      } catch (e) {
        addSystem("创建会话失败: " + e.message, "error");
      }
    }

    async function deleteSession(id) {
      try {
        await jsonOrThrow(await fetch(`/api/sessions/${id}`, { method: "DELETE" }));
        if (state.currentSessionId === id) {
          state.currentSessionId = null;
          state.liveMessages.clear();
          messagesEl.replaceChildren();
          ensureSpacer();
          showEmpty();
          state.worktreeStatus = null;
          renderWorktreeStatus();
          setStatus("就绪");
        }
        await refreshSessionList();
        if (!memoryPanel.hidden) refreshMemoryList();
        closeSidebarIfMobile();
      } catch (e) {
        addSystem("删除会话失败: " + e.message, "error");
      }
    }

    btnNewChat.addEventListener("click", newSession);

    /* ═══════════════════════════════════════════════════════════
       MESSAGES
       ═══════════════════════════════════════════════════════════ */

    function createMessage({ role, agent, content = "", variant = "" }) {
      hideEmpty();
      ensureSpacer();

      const wrapper = document.createElement("article");
      wrapper.className = ["message", role, variant].filter(Boolean).join(" ");

      // Meta
      const meta = document.createElement("div");
      meta.className = "msg-meta";
      const metaLabel = document.createElement("span");
      metaLabel.textContent = role === "user" ? "You" : agentLabel(agent);
      meta.appendChild(metaLabel);

      // Copy button (assistant only)
      if (role === "assistant" && content) {
        const copy = document.createElement("button");
        copy.className = "msg-copy";
        copy.textContent = "⎘";
        copy.title = "复制";
        copy.addEventListener("click", () => {
          navigator.clipboard.writeText(content).then(() => {
            copy.textContent = "✓";
            setTimeout(() => { copy.textContent = "⎘"; }, 1200);
          }).catch(() => {});
        });
        meta.appendChild(copy);
      }

      // Bubble
      const bubble = document.createElement("div");
      bubble.className = "msg-bubble";
      bubble.innerHTML = renderMd(content);

      wrapper.append(meta, bubble);
      messagesEl.insertBefore(wrapper, spacerEl);
      scrollDown();

      return { wrapper, bubble };
    }

    function showThinking(agent) {
      hideEmpty();
      ensureSpacer();

      const existing = messagesEl.querySelector(`.thinking[data-agent="${agent}"]`);
      if (existing) return;

      const wrapper = document.createElement("article");
      wrapper.className = "message assistant";

      const meta = document.createElement("div");
      meta.className = "msg-meta";
      meta.textContent = agentLabel(agent);

      const bubble = document.createElement("div");
      bubble.className = "thinking";
      bubble.setAttribute("data-agent", agent);
      bubble.innerHTML = `
        <span class="thinking-text">思考中</span>
        <span class="thinking-dots"><span></span><span></span><span></span></span>`;

      wrapper.append(meta, bubble);
      messagesEl.insertBefore(wrapper, spacerEl);
      scrollDown();
    }

    function stopThinking(agent) {
      const el = messagesEl.querySelector(`.thinking[data-agent="${agent}"]`);
      if (el) el.closest(".message").remove();
    }

    /* rAF batch — coalesce multiple SSE tokens into one render frame */
    let _rafId = null;
    let _rafPending = new Map(); // agent → rawText

    function _flushRaf() {
      for (const [agent, raw] of _rafPending) {
        const item = state.liveMessages.get(agent);
        if (item) item.bubble.innerHTML = renderMd(raw);
      }
      _rafPending.clear();
      _rafId = null;
    }

    function appendLive(agent, text) {
      hideEmpty();
      ensureSpacer();

      if (!state.liveMessages.has(agent)) {
        stopThinking(agent);
        const item = createMessage({ role: "assistant", agent });
        item.rawText = "";
        state.liveMessages.set(agent, item);
      }
      const item = state.liveMessages.get(agent);
      item.rawText += text;

      // Batch renders: at most one renderMd per animation frame
      _rafPending.set(agent, item.rawText);
      if (!_rafId) _rafId = requestAnimationFrame(_flushRaf);
      scrollDown();
    }

    function finalizeLiveMessages() {
      if (_rafId) {
        cancelAnimationFrame(_rafId);
        _flushRaf();
      }
      for (const [, item] of state.liveMessages) {
        item.bubble.innerHTML = renderMd(item.rawText || "");
        if (!item.wrapper.querySelector(".msg-copy")) {
          const copy = document.createElement("button");
          copy.className = "msg-copy";
          copy.textContent = "⎘";
          copy.title = "复制";
          copy.addEventListener("click", () => {
            navigator.clipboard.writeText(item.rawText || "").then(() => {
              copy.textContent = "✓";
              setTimeout(() => { copy.textContent = "⎘"; }, 1200);
            }).catch(() => {});
          });
          const meta = item.wrapper.querySelector(".msg-meta");
          if (meta) meta.appendChild(copy);
        }
      }
    }

    function finishStream(statusText) {
      state.doneReceived = true;
      finalizeLiveMessages();
      setStatus(statusText || "就绪");
      loadSessions();
      loadWorktreeStatus();
      if (!memoryPanel.hidden) refreshMemoryList();
    }

    function addSystem(text, variant = "") {
      hideEmpty();
      ensureSpacer();
      createMessage({ role: "system", agent: "system", content: text, variant });

      // Retry button
      if (variant === "error" && state.lastPrompt) {
        const wrapper = document.createElement("article");
        wrapper.className = "message system";
        const meta = document.createElement("div");
        meta.className = "msg-meta";
        meta.textContent = "system";
        const bubble = document.createElement("div");
        bubble.className = "msg-bubble";
        const retry = document.createElement("button");
        retry.className = "btn-retry";
        retry.textContent = "↻ 重试";
        retry.addEventListener("click", () => {
          promptEl.value = state.lastPrompt;
          state.selectedAgent = state.lastAgent;
          renderAgentTabs();
          sendPrompt();
        });
        bubble.appendChild(retry);
        wrapper.append(meta, bubble);
        messagesEl.insertBefore(wrapper, spacerEl);
        scrollDown();
      }
    }

    /* ═══════════════════════════════════════════════════════════
       SKILLS
       ═══════════════════════════════════════════════════════════ */

    function renderSkillTags(active) {
      const set = new Set(active || []);
      const tags = state.skillsMetadata.map((s) => {
        const tag = document.createElement("span");
        tag.className = "skill-tag" + (set.has(s.name) ? "" : " inactive");
        tag.textContent = s.name;
        tag.title = s.description;
        return tag;
      });
      skillsBarEl.replaceChildren(skillsLabel, ...tags);
    }

    function updateActiveSkills(prompt) {
      clearTimeout(state.skillDebounce);
      state.skillDebounce = setTimeout(() => {
        fetch(`/api/skills?prompt=${encodeURIComponent(prompt || "")}`)
          .then(jsonOrThrow)
          .then((d) => renderSkillTags(d.active))
          .catch(() => {});
      }, 300);
    }

    /* ═══════════════════════════════════════════════════════════
       AGENT TABS
       ═══════════════════════════════════════════════════════════ */

    function renderAgentTabs() {
      agentTabsEl.replaceChildren(...state.agents.map((a) => {
        const item = document.createElement("article");
        item.className = "agent-tab";
        item.setAttribute("role", "button");
        item.tabIndex = 0;
        item.title = `插入 @${agentMention(a)}`;
        item.innerHTML = `
          <span class="agent-tab-name"></span>
          <span class="agent-tab-model"></span>`;
        item.querySelector(".agent-tab-name").textContent = `@${agentMention(a)}`;
        item.querySelector(".agent-tab-model").textContent = agentMeta(a);
        item.addEventListener("click", () => insertAgentMention(a));
        item.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            insertAgentMention(a);
          }
        });
        return item;
      }));
    }

    function insertAgentMention(agent) {
      const mention = `@${agentMention(agent)} `;
      const current = promptEl.value;
      const leadingAgent = resolvePromptAgent(current);

      if (!current.trim()) {
        promptEl.value = mention;
      } else if (leadingAgent) {
        const trimmedStart = current.match(/^\s*/)?.[0] || "";
        const start = trimmedStart.length;
        const afterStart = current.slice(start);
        const token = `@${agentMention(leadingAgent)}`;
        const idToken = `@${leadingAgent.id}`;
        const oldToken = afterStart.startsWith(token) ? token : idToken;
        promptEl.value = trimmedStart + mention + afterStart.slice(oldToken.length).trimStart();
      } else {
        promptEl.value = mention + current;
      }

      state.selectedAgent = agent.id;
      promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
      updateActiveSkills(promptEl.value);
      hideMentionMenu();
      promptEl.focus();
    }

    function getMentionTrigger() {
      const pos = promptEl.selectionStart || 0;
      const before = promptEl.value.slice(0, pos);
      const match = before.match(/(^|\s)@([^\s@]*)$/);
      if (!match) return null;
      return {
        start: before.length - match[2].length - 1,
        end: pos,
        query: match[2].toLowerCase(),
      };
    }

    function hideMentionMenu() {
      state.mentionOpen = false;
      state.mentionMatches = [];
      state.mentionRange = null;
      mentionMenuEl.hidden = true;
      mentionMenuEl.replaceChildren();
    }

    function renderMentionMenu() {
      mentionMenuEl.replaceChildren(...state.mentionMatches.map((agent, index) => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "mention-option" + (index === state.mentionIndex ? " active" : "");
        option.innerHTML = `<span class="mention-option-name"></span><span class="mention-option-meta"></span>`;
        option.querySelector(".mention-option-name").textContent = `@${agentMention(agent)}`;
        option.querySelector(".mention-option-meta").textContent = agentMeta(agent);
        option.addEventListener("mousedown", (e) => {
          e.preventDefault();
          selectMention(index);
        });
        return option;
      }));
      mentionMenuEl.hidden = state.mentionMatches.length === 0;
      state.mentionOpen = state.mentionMatches.length > 0;
    }

    function updateMentionMenu() {
      const trigger = getMentionTrigger();
      if (!trigger) {
        hideMentionMenu();
        return;
      }

      const matches = state.agents.filter((agent) => {
        const label = agentMention(agent).toLowerCase();
        const id = agent.id.toLowerCase();
        return label.includes(trigger.query) || id.includes(trigger.query);
      });
      if (matches.length === 0) {
        hideMentionMenu();
        return;
      }

      state.mentionRange = trigger;
      state.mentionMatches = matches;
      state.mentionIndex = Math.min(state.mentionIndex, matches.length - 1);
      renderMentionMenu();
    }

    function selectMention(index = state.mentionIndex) {
      const agent = state.mentionMatches[index];
      if (!agent || !state.mentionRange) return;

      const before = promptEl.value.slice(0, state.mentionRange.start);
      const after = promptEl.value.slice(state.mentionRange.end);
      const insert = `@${agentMention(agent)} `;
      promptEl.value = before + insert + after;
      const cursor = (before + insert).length;
      promptEl.setSelectionRange(cursor, cursor);
      hideMentionMenu();
      updateActiveSkills(promptEl.value);
      promptEl.focus();
    }

    async function loadAgents() {
      try {
        const res = await fetch("/api/agents");
        const data = await jsonOrThrow(res);
        state.agents = data.agents;
        if (!state.agents.find(a => a.id === state.selectedAgent)) {
          state.selectedAgent = state.agents[0]?.id || "architect";
        }
        renderAgentTabs();
      } catch (e) {
        addSystem("加载 Agent 列表失败: " + e.message, "error");
        setStatus("加载 Agent 失败", "error");
      }
    }

    /* ═══════════════════════════════════════════════════════════
       SSE PARSER
       ═══════════════════════════════════════════════════════════ */

    function parseSse(buffer, onEvent) {
      let rest = buffer;
      let idx;
      while ((idx = rest.indexOf("\n\n")) !== -1) {
        const frame = rest.slice(0, idx);
        rest = rest.slice(idx + 2);
        const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
        const dataLine  = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!eventLine || !dataLine) continue;
        onEvent(eventLine.slice(7), JSON.parse(dataLine.slice(6)));
      }
      return rest;
    }

    function handleSseEvent(event, data) {
      switch (event) {
        case "session":
          state.currentSessionId = data.sessionId;
          loadSessions();
          loadWorktreeStatus();
          break;
        case "skills-active":
          renderSkillTags(data.skills);
          break;
        case "agent-start":
          showThinking(data.agent);
          break;
        case "message":
          appendLive(data.agent, data.text);
          break;
        case "stderr":
          createMessage({ role: "assistant", agent: data.agent, content: data.text, variant: "stderr" });
          break;
        case "error":
          addSystem(data.message, "error");
          break;
        case "context-warning":
          setStatus("上下文接近上限");
          break;
        case "sealed":
          if (data.agent) stopThinking(data.agent);
          finishStream("上下文已封存");
          addSystem(`context overflow: 已停止继续路由`);
          break;
        case "agent-exit":
          if (data.code !== 0) {
            stopThinking(data.agent);
            addSystem(`${agentLabel(data.agent)} exited with ${data.code ?? data.signal}`, "error");
          }
          break;
        case "a2a-route":
          addSystem(`🔄 ${agentLabel(data.from)} → ${agentLabel(data.to)}`);
          break;
        case "done":
          finishStream("就绪");
          break;
      }
    }

    /* ═══════════════════════════════════════════════════════════
       MEMORY PANEL
       ═══════════════════════════════════════════════════════════ */

    const memoryState = {
      invocations: [],
      expandedIds: new Set(),
      loading: false,
    };

    function openMemoryPanel() {
      memoryPanel.hidden = false;
      memoryOverlay.hidden = false;
      refreshMemoryList();
      setTimeout(() => memorySearchInput.focus(), 50);
    }

    function closeMemoryPanel() {
      memoryPanel.hidden = true;
      memoryOverlay.hidden = true;
    }

    memoryToggle.addEventListener("click", openMemoryPanel);
    memoryClose.addEventListener("click", closeMemoryPanel);
    memoryRefresh.addEventListener("click", () => {
      if (memoryState.loading) return;
      refreshMemoryList();
    });
    memoryOverlay.addEventListener("click", closeMemoryPanel);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !memoryPanel.hidden) {
        closeMemoryPanel();
      }
    });

    async function refreshMemoryList() {
      memoryState.loading = true;
      memoryRefresh.classList.add("spinning");

      if (!state.currentSessionId) {
        renderMemoryEmpty("没有当前对话", "先在主界面发一条消息，或在左侧选一个对话");
        memoryState.loading = false;
        memoryRefresh.classList.remove("spinning");
        return;
      }

      const url = `/api/sessions/${encodeURIComponent(state.currentSessionId)}/transcript/invocations`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          const errText = `${res.status} ${res.statusText}`;
          renderMemoryEmpty(`加载失败 (${errText})`, `URL: ${url}`, true);
          memoryState.loading = false;
          memoryRefresh.classList.remove("spinning");
          return;
        }
        const data = await res.json();
        memoryState.invocations = data.invocations || [];
        if (memoryState.invocations.length === 0) {
          renderMemoryEmpty(
            "这个对话还没有 invocation",
            `sessionId: ${state.currentSessionId}\n（需要先发一条消息，等 CLI 跑完才会出现记录）`
          );
        } else {
          renderMemoryList();
        }
      } catch (e) {
        renderMemoryEmpty("网络错误", `${e.message}\nURL: ${url}`, true);
      } finally {
        memoryState.loading = false;
        memoryRefresh.classList.remove("spinning");
      }
    }

    function renderMemoryEmpty(text, detail, isError) {
      memoryList.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "memory-empty" + (isError ? " memory-empty-error" : "");
      empty.textContent = text;
      if (detail) {
        const d = document.createElement("div");
        d.className = "memory-empty-detail";
        d.textContent = detail;
        empty.appendChild(d);
      }
      memoryList.appendChild(empty);
    }

    function renderMemoryList() {
      if (memoryState.invocations.length === 0) {
        renderMemoryEmpty("这个对话还没有 invocation");
        return;
      }
      memoryList.replaceChildren(...memoryState.invocations.map((inv) => {
        const wrapper = document.createElement("div");
        wrapper.className = "memory-invocation";

        const header = document.createElement("div");
        header.className = "memory-invocation-header";

        const info = document.createElement("div");
        info.className = "memory-invocation-info";

        const title = document.createElement("div");
        title.className = "memory-invocation-title";
        title.textContent = inv.invocationId;
        title.title = inv.invocationId;

        const meta = document.createElement("div");
        meta.className = "memory-invocation-meta";
        meta.textContent = `${agentLabel(inv.agent)} · ${fmtTime(inv.startedAt)} · ${inv.eventCount} events`;

        info.append(title, meta);

        const state = document.createElement("span");
        const stateText = inv.state || "in-flight";
        state.className = `memory-invocation-state ${stateText}`;
        state.textContent = stateText;

        header.append(info, state);
        wrapper.appendChild(header);
        header.addEventListener("click", () => toggleInvocation(inv.invocationId));

        if (memoryState.expandedIds.has(inv.invocationId)) {
          const eventsDiv = document.createElement("div");
          eventsDiv.className = "memory-invocation-events";
          eventsDiv.dataset.invId = inv.invocationId;
          wrapper.appendChild(eventsDiv);
          loadInvocationEvents(inv.invocationId);
        }

        return wrapper;
      }));
    }

    function toggleInvocation(invId) {
      if (memoryState.expandedIds.has(invId)) {
        memoryState.expandedIds.delete(invId);
      } else {
        memoryState.expandedIds.add(invId);
      }
      renderMemoryList();
    }

    async function loadInvocationEvents(invId) {
      const container = memoryList.querySelector(`[data-inv-id="${CSS.escape(invId)}"]`);
      if (!container) return;
      container.replaceChildren();
      const loading = document.createElement("div");
      loading.className = "memory-empty";
      loading.textContent = "加载中…";
      container.appendChild(loading);

      try {
        const res = await fetch(
          `/api/sessions/${state.currentSessionId}/transcript/invocations/${encodeURIComponent(invId)}?limit=200`
        );
        if (!res.ok) {
          container.textContent = "加载失败";
          return;
        }
        const data = await res.json();
        container.replaceChildren(...data.events.map(renderMemoryEvent));
      } catch (e) {
        container.textContent = "加载失败: " + e.message;
      }
    }

    function renderMemoryEvent(ev) {
      const div = document.createElement("div");
      div.className = "memory-event";

      const kind = document.createElement("span");
      kind.className = "memory-event-kind";
      kind.textContent = ev.kind;

      const meta = document.createElement("span");
      meta.className = "memory-event-meta";
      meta.textContent = " · " + fmtTime(ev.ts);

      div.append(kind, meta);

      if (ev.payload && Object.keys(ev.payload).length > 0) {
        const text = document.createElement("div");
        text.className = "memory-event-text";
        const preview = JSON.stringify(ev.payload);
        text.textContent = preview.length > 200 ? preview.slice(0, 200) + "…" : preview;
        div.appendChild(text);
      }

      return div;
    }

    let _memorySearchDebounce = null;
    memorySearchInput.addEventListener("input", () => {
      clearTimeout(_memorySearchDebounce);
      _memorySearchDebounce = setTimeout(
        () => doMemorySearch(memorySearchInput.value.trim()),
        300
      );
    });

    async function doMemorySearch(query) {
      if (!query) {
        renderMemoryList();
        return;
      }
      if (!state.currentSessionId) {
        renderMemoryEmpty("选择一个对话后查看记忆");
        return;
      }
      try {
        const res = await fetch(
          `/api/sessions/${state.currentSessionId}/transcript/search?q=${encodeURIComponent(query)}&limit=20`
        );
        if (!res.ok) {
          renderMemoryEmpty("搜索失败");
          return;
        }
        const data = await res.json();
        renderSearchResults(data.hits || [], query);
      } catch (e) {
        renderMemoryEmpty("搜索失败: " + e.message);
      }
    }

    function renderSearchResults(hits, query) {
      if (hits.length === 0) {
        renderMemoryEmpty(
          `无匹配 "${query}" 的结果`,
          "试试别的关键词，或先让 agent 跑出记录再搜"
        );
        return;
      }
      memoryList.replaceChildren(...hits.map((hit) => {
        const div = document.createElement("div");
        div.className = "memory-search-hit";

        const snippet = document.createElement("div");
        snippet.className = "memory-search-hit-snippet";
        snippet.innerHTML = highlightQuery(hit.snippet, query);

        const meta = document.createElement("div");
        meta.className = "memory-search-hit-meta";
        meta.textContent = `${hit.invocationId.slice(0, 16)}… · ${hit.kind} · ${fmtTime(hit.ts)}`;

        div.append(snippet, meta);
        div.addEventListener("click", () => {
          memorySearchInput.value = "";
          memoryState.expandedIds.add(hit.invocationId);
          renderMemoryList();
          // Scroll the expanded card into view
          setTimeout(() => {
            const el = memoryList.querySelector(`[data-inv-id="${CSS.escape(hit.invocationId)}"]`);
            if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
          }, 50);
        });

        return div;
      }));
    }

    function highlightQuery(text, query) {
      if (!query) return escHtml(text);
      const escaped = escHtml(text);
      const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return escaped.replace(new RegExp(pattern, "gi"), (m) => `<mark>${m}</mark>`);
    }

    /* ═══════════════════════════════════════════════════════════
       SEND
       ═══════════════════════════════════════════════════════════ */

    async function sendPrompt() {
      const prompt = promptEl.value.trim();
      if (!prompt || state.controller) return;

      const targetAgent = resolvePromptAgent(prompt);
      if (!targetAgent) {
        addSystem("请先输入 @ 选择一个模型", "error");
        setStatus("请选择模型", "error");
        promptEl.focus();
        updateMentionMenu();
        return;
      }

      // Create session if needed
      if (!state.currentSessionId) {
        try {
          const res = await fetch("/api/sessions", { method: "POST" });
          const data = await jsonOrThrow(res);
          state.currentSessionId = data.session.id;
        } catch (e) {
          addSystem(e.message, "error");
          return;
        }
      }

      state.lastPrompt = prompt;
      state.lastAgent = targetAgent.id;
      state.selectedAgent = targetAgent.id;
      state.doneReceived = false;
      state.liveMessages.clear();

      createMessage({ role: "user", agent: targetAgent.id, content: prompt });
      promptEl.value = "";
      hideMentionMenu();

      state.controller = new AbortController();
      promptEl.disabled = true;
      btnSend.textContent = "Stop";
      btnSend.classList.add("danger");
      setStatus("运行中…");

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: targetAgent.id,
            prompt,
            sessionId: state.currentSessionId,
            projectDir: state.projectDir || undefined,
          }),
          signal: state.controller.signal,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          addSystem(err.error || `${res.status} ${res.statusText}`, "error");
          setStatus("错误", "error");
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          buf = parseSse(buf, handleSseEvent);
        }
      } catch (err) {
        if (_rafId) { cancelAnimationFrame(_rafId); _flushRaf(); }
        if (err.name === "AbortError") {
          setStatus("已停止");
          addSystem("已停止", "error");
        } else {
          setStatus("错误", "error");
          addSystem(err.message || "连接中断", "error");
        }
        // Clean thinking indicators
        messagesEl.querySelectorAll(".thinking").forEach((el) => el.closest(".message")?.remove());
        // Final render live messages
        for (const [, item] of state.liveMessages) {
          item.bubble.innerHTML = renderMd(item.rawText || "");
        }
      } finally {
        // Detect unexpected disconnect
        if (!state.doneReceived && !(state.controller && state.controller.signal.aborted)) {
          setStatus("错误", "error");
          addSystem("连接意外中断", "error");
        }
        state.controller = null;
        promptEl.disabled = false;
        btnSend.textContent = "Send";
        btnSend.classList.remove("danger");
      }
    }

    /* ═══════════════════════════════════════════════════════════
       EVENT BINDINGS
       ═══════════════════════════════════════════════════════════ */

    btnSend.addEventListener("click", () => {
      if (state.controller) { state.controller.abort(); return; }
      sendPrompt();
    });

    btnClear.addEventListener("click", async () => {
      // P2-4 方案 A: 真正丢弃当前对话 — DELETE session + 清屏
      if (state.currentSessionId) {
        try { await jsonOrThrow(await fetch(`/api/sessions/${state.currentSessionId}`, { method: "DELETE" })); } catch {}
        state.currentSessionId = null;
      }
      state.liveMessages.clear();
      messagesEl.replaceChildren();
      ensureSpacer();
      showEmpty();
      setStatus("就绪");
      renderSkillTags([]);
      loadSessions();
    });

    promptEl.addEventListener("input", () => {
      updateActiveSkills(promptEl.value);
      updateMentionMenu();
    });

    promptEl.addEventListener("click", updateMentionMenu);
    promptEl.addEventListener("keyup", (e) => {
      if (["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) return;
      updateMentionMenu();
    });

    promptEl.addEventListener("keydown", (e) => {
      if (state.mentionOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          state.mentionIndex = (state.mentionIndex + 1) % state.mentionMatches.length;
          renderMentionMenu();
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          state.mentionIndex = (state.mentionIndex - 1 + state.mentionMatches.length) % state.mentionMatches.length;
          renderMentionMenu();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          selectMention();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          hideMentionMenu();
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
      }
    });

    /* ═══════════════════════════════════════════════════════════
       INIT
       ═══════════════════════════════════════════════════════════ */

    initTheme();
    loadProjectDir();

    fetch("/api/skills")
      .then(jsonOrThrow)
      .then((d) => {
        state.skillsMetadata = d.skills || [];
        renderSkillTags([]);
      })
      .catch(() => {});

    Promise.all([loadAgents(), loadSessions()]).catch((e) => {
      setStatus("加载失败", "error");
    });
  })();
