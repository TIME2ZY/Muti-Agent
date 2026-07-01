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
    const useWorktreeInput = $("#use-worktree");
    const skillsBarEl  = $("#skills-bar");
    const statusEl     = $("#status");
    const sidebarEl    = $("#sidebar");
    const sidebarToggle = $("#sidebar-toggle");
    const sidebarOverlay = $("#sidebar-overlay");
    const sessionListEl = $("#session-list");
    const btnNewChat   = $("#btn-new-chat");
    const panelTabAgentsEl = $("#panel-tab-agents");
    const panelTabWorkspaceEl = $("#panel-tab-workspace");
    const agentPanelEl = $("#agent-panel");
    const agentTabsEl  = $("#agent-tabs");
    const workspacePanelEl = $("#workspace-panel");
    const emptyStateEl = $("#empty-state");
    const spacerEl     = messagesEl.querySelector(".messages-spacer");
    const skillsLabel  = skillsBarEl.querySelector(".skills-bar-label");
    const themeToggle  = $("#theme-toggle");
    const projectDirEl = $("#project-dir");
    const projectDirPath = $("#project-dir-path");
    const worktreeStatusEl = $("#worktree-status");
    const mentionMenuEl = $("#mention-menu");
    const recallToggleEl = $("#recall-toggle");
    const recallPanelEl = $("#recall-panel");
    const recallCloseEl = $("#recall-close");
    const recallOverlayEl = $("#recall-overlay");
    const recallBodyEl = $("#recall-body");
    const recallSearchInputEl = $("#recall-search-input");
    const sessionApi = window.SessionApi.createSessionApi(window.fetch.bind(window));
    const worktreeApi = window.WorktreeApi.createWorktreeApi(window.fetch.bind(window));
    const recallApi = window.RecallApi.createRecallApi(window.fetch.bind(window));
    const escHtml = window.MarkdownLite.escHtml;
    const renderMd = window.MarkdownLite.renderMd;

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

    async function loadProjectDir(sessionId = state.currentSessionId) {
      if (!sessionId) {
        projectDirPath.textContent = state.projectDir || "(当前目录)";
        return;
      }
      try {
        state.projectDir = await sessionApi.readProjectDir(sessionId);
        projectDirPath.textContent = state.projectDir || "(当前目录)";
      } catch {
        state.projectDir = "";
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
        state.worktreeStatus = await worktreeApi.readStatus(state.currentSessionId, { allowMissing: true });
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
      worktreeStatusEl.textContent = "";
      const label = document.createElement("span");
      label.textContent = `${wt.branch || "(worktree)"} · ${marker}`;
      worktreeStatusEl.append(label);
      if (wt.previewUrl) {
        const link = document.createElement("a");
        link.href = wt.previewUrl;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "预览";
        link.className = "worktree-preview-link";
        link.title = `预览修改后的应用 (${wt.previewUrl})`;
        worktreeStatusEl.append(link);
      }
      worktreeStatusEl.className = "worktree-status" + (wt.clean ? "" : " dirty");
      worktreeStatusEl.title = wt.worktreeDir || wt.branch || "";
    }

    function emptyWorkspaceState() {
      return {
        status: null,
        diffText: "",
        files: [],
        selectedPath: "",
        loading: false,
        error: "",
      };
    }

    function renderWorkspaceFileList() {
      const list = document.createElement("div");
      list.className = "workspace-file-list";

      for (const file of state.workspace.files) {
        const path = file.path;
        const item = document.createElement("button");
        item.type = "button";
        item.className = "workspace-file" + (path === state.workspace.selectedPath ? " selected" : "");
        item.addEventListener("click", () => {
          state.workspace.selectedPath = path;
          renderWorkspacePanel();
        });

        const filePath = document.createElement("span");
        filePath.className = "workspace-file-path";
        filePath.textContent = path;

        const fileStatus = document.createElement("span");
        fileStatus.className = `workspace-file-status status-${file.status}`;
        fileStatus.textContent = file.status;

        item.append(filePath, fileStatus);
        list.appendChild(item);
      }

      return list;
    }

    function renderWorkspaceDiff() {
      const selected = state.workspace.files.find((file) => file.path === state.workspace.selectedPath);
      const panel = document.createElement("div");
      panel.className = "workspace-diff";

      if (!selected) {
        const empty = document.createElement("div");
        empty.className = "workspace-empty";
        empty.textContent = "当前无改动";
        panel.appendChild(empty);
        return panel;
      }

      const title = document.createElement("div");
      title.className = "workspace-diff-title";
      title.textContent = selected.path;
      panel.appendChild(title);

      const body = document.createElement("div");
      body.className = "workspace-diff-body";
      for (const line of selected.patch.split("\n")) {
        const row = document.createElement("div");
        row.className = "workspace-diff-line";
        if (line.startsWith("+") && !line.startsWith("+++")) {
          row.classList.add("workspace-diff-line-added");
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          row.classList.add("workspace-diff-line-removed");
        }
        row.textContent = line || " ";
        body.appendChild(row);
      }

      panel.appendChild(body);
      return panel;
    }

    function renderWorkspacePanel() {
      if (!workspacePanelEl) return;

      const { status, files, loading, error } = state.workspace;
      workspacePanelEl.textContent = "";

      const wrap = document.createElement("div");
      wrap.className = "workspace-panel-body";

      if (!state.currentSessionId) {
        setRecallEmpty(wrap, "暂无工作区");
        workspacePanelEl.append(wrap);
        return;
      }

      if (loading) {
        setRecallEmpty(wrap, "加载工作区中…");
        workspacePanelEl.append(wrap);
        return;
      }

      if (error) {
        setRecallEmpty(wrap, "工作区加载失败: " + error, true);
        workspacePanelEl.append(wrap);
        return;
      }

      if (!status) {
        setRecallEmpty(wrap, "当前会话尚未创建 worktree");
        workspacePanelEl.append(wrap);
        return;
      }

      const summary = document.createElement("div");
      summary.className = "workspace-summary";
      summary.innerHTML = `
        <div class="workspace-summary-branch">${escHtml(status.branch || "(worktree)")}</div>
        <div class="workspace-summary-meta">${status.clean ? "clean" : "dirty"} · ${escHtml(status.worktreeDir || "")}</div>
      `;

      if (status.previewUrl) {
        const preview = document.createElement("a");
        preview.className = "workspace-action-link";
        preview.href = status.previewUrl;
        preview.target = "_blank";
        preview.rel = "noopener";
        preview.textContent = "打开预览";
        summary.appendChild(preview);
      }

      const actions = document.createElement("div");
      actions.className = "workspace-actions";

      const refreshBtn = document.createElement("button");
      refreshBtn.type = "button";
      refreshBtn.className = "btn-cmd";
      refreshBtn.textContent = "刷新改动";
      refreshBtn.addEventListener("click", () => loadWorkspaceState());
      actions.appendChild(refreshBtn);

      const discardBtn = document.createElement("button");
      discardBtn.type = "button";
      discardBtn.className = "btn-cmd danger";
      discardBtn.textContent = "丢弃 worktree";
      discardBtn.addEventListener("click", () => discardWorkspace());
      actions.appendChild(discardBtn);

      wrap.append(summary, actions);

      if (status.clean) {
        const empty = document.createElement("div");
        empty.className = "workspace-empty";
        empty.textContent = "当前无改动";
        wrap.append(empty);
        workspacePanelEl.append(wrap);
        return;
      }

      if (files.length === 0) {
        const empty = document.createElement("div");
        empty.className = "workspace-empty";
        empty.textContent = "改动暂不可预览";
        wrap.append(empty);
        workspacePanelEl.append(wrap);
        return;
      }

      const summaryStats = window.WorkspaceDiff
        ? window.WorkspaceDiff.summarizeUnifiedDiff(files)
        : { totalFiles: files.length, untrackedFiles: 0 };
      const fileCount = document.createElement("div");
      fileCount.className = "workspace-summary-meta";
      fileCount.textContent = `共 ${summaryStats.totalFiles} 个改动文件 · 新增 ${summaryStats.untrackedFiles} 个`;
      wrap.append(fileCount);

      const content = document.createElement("div");
      content.className = "workspace-content";
      content.append(renderWorkspaceFileList(), renderWorkspaceDiff());
      wrap.append(content);

      workspacePanelEl.append(wrap);
    }

    async function loadWorkspaceState() {
      state.workspace.loading = true;
      state.workspace.error = "";
      renderWorkspacePanel();

      if (!state.currentSessionId) {
        state.workspace = emptyWorkspaceState();
        renderWorkspacePanel();
        return;
      }

      try {
        const status = await worktreeApi.readStatus(state.currentSessionId, { allowMissing: true });
        if (!status) {
          state.workspace = emptyWorkspaceState();
          renderWorkspacePanel();
          return;
        }
        const diffText = await worktreeApi.readDiff(state.currentSessionId, { allowMissing: true });
        const files = window.WorkspaceDiff
          ? window.WorkspaceDiff.parseUnifiedDiff(diffText)
          : [];

        state.workspace = {
          status,
          diffText,
          files,
          selectedPath: files[0]?.path || "",
          loading: false,
          error: "",
        };
      } catch (error) {
        state.workspace.loading = false;
        state.workspace.error = error.message || "未知错误";
      }

      renderWorkspacePanel();
    }

    async function discardWorkspace() {
      if (!state.currentSessionId || !confirm("确认丢弃当前 worktree 吗？")) return;
      await worktreeApi.discard(state.currentSessionId);
      await loadWorktreeStatus();
      await loadWorkspaceState();
    }

    function setRightPanelTab(nextTab) {
      state.rightPanelTab = nextTab;
      if (agentPanelEl) agentPanelEl.hidden = nextTab !== "agents";
      if (workspacePanelEl) workspacePanelEl.hidden = nextTab !== "workspace";
      if (panelTabAgentsEl) {
        panelTabAgentsEl.classList.toggle("is-active", nextTab === "agents");
        panelTabAgentsEl.setAttribute("aria-selected", nextTab === "agents" ? "true" : "false");
      }
      if (panelTabWorkspaceEl) {
        panelTabWorkspaceEl.classList.toggle("is-active", nextTab === "workspace");
        panelTabWorkspaceEl.setAttribute("aria-selected", nextTab === "workspace" ? "true" : "false");
      }
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
          if (!state.currentSessionId) {
            state.projectDir = val;
            projectDirPath.textContent = val;
            return;
          }
          try {
            state.projectDir = await sessionApi.updateProjectDir(state.currentSessionId, val);
            projectDirPath.textContent = state.projectDir;
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
      liveInvocations: new Map(), // agent → invocationId (captured from agent-start)
      recallOpen: false,
      recallSearchDebounce: null,
      rightPanelTab: "agents",
      workspace: emptyWorkspaceState(),
    };

    /* ═══════════════════════════════════════════════════════════
       HELPERS
       ═══════════════════════════════════════════════════════════ */

    function copyToClipboard(text, btn, okText = "✓", failText = "Failed") {
      const orig = btn.textContent;
      return navigator.clipboard.writeText(text).then(() => {
        btn.textContent = okText;
        btn.classList.add("copied");
      }).catch(() => {
        btn.textContent = failText;
      }).finally(() => {
        setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1200);
      });
    }

    function makeSetBadge(badgeEl) {
      return function setBadge(state) {
        if (!state) {
          badgeEl.style.display = "none";
          badgeEl.className = "msg-badge";
          return;
        }
        badgeEl.style.display = "";
        const configs = {
          thinking: { cls: "badge-thinking", text: "思考中", dot: true },
          writing:  { cls: "badge-writing",  text: "输出中", dot: true },
          done:     { cls: "badge-done",     text: "",        dot: false },
          error:    { cls: "badge-error",    text: "异常退出", dot: false },
        };
        const cfg = configs[state] || configs.thinking;
        badgeEl.className = "msg-badge " + cfg.cls;
        badgeEl.innerHTML = cfg.dot
          ? `<span class="badge-dot"></span>${cfg.text}`
          : cfg.text;
      };
    }

    function setRecallEmpty(targetEl, msg, isError = false) {
      const cls = isError ? "recall-empty recall-empty-error" : "recall-empty";
      targetEl.innerHTML = `<div class="${cls}">${escHtml(msg)}</div>`;
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

    function roleDisplayName(role, agentId) {
      if (role === "system") return "系统";
      return role === "user" ? "用户" : agentLabel(agentId);
    }

    function roleBadgeLabel(role) {
      if (role === "user") return "发起者";
      if (role === "assistant") return "Agent";
      return "系统";
    }

    function agentRoleLabel(agent) {
      return agent.id === "architect" ? "主控 Agent" : "协作 Agent";
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
      const text = await res.text();
      let data = {};
      try { data = JSON.parse(text); } catch { /* keep text for error context */ }
      if (!res.ok) {
        const err = new Error(data.error || `${res.status} ${res.statusText}`);
        err.body = text;
        throw err;
      }
      return data;
    }

    // Wire up copy buttons on every code block after render.
    // Delegated handler — robust to re-renders.
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".md-code-copy");
      if (!btn) return;
      const code = btn.closest(".md-code")?.querySelector("code");
      if (!code) return;
      const text = code.textContent;
      copyToClipboard(text, btn, "Copied");
    });

    // Wire up toggle buttons for collapsible code blocks.
    document.addEventListener("click", (e) => {
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
    let sessionController = null;

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
          sessionController.switchSession(s.id);
          closeSidebarIfMobile();
        });

        const del = document.createElement("button");
        del.className = "btn-delete-session";
        del.textContent = "×";
        del.title = "删除对话";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          sessionController.deleteSession(s.id);
        });
        item.appendChild(del);

        return item;
      }));
    }
    sessionController = window.SessionController.createSessionController({
      state,
      sessionApi,
      renderSessionList,
      addSystem,
      ensureSpacer,
      showEmpty,
      createMessage,
      messagesEl,
      promptEl,
      projectDirPath,
      closeSidebarIfMobile,
      loadProjectDir,
      loadWorktreeStatus,
      loadWorkspaceState,
      renderWorktreeStatus,
      renderWorkspacePanel,
      emptyWorkspaceState,
      setStatus,
    });

    btnNewChat.addEventListener("click", () => sessionController.newSession());
    panelTabAgentsEl.addEventListener("click", () => {
      setRightPanelTab("agents");
    });
    panelTabWorkspaceEl.addEventListener("click", async () => {
      state.rightPanelTab = "workspace";
      setRightPanelTab("workspace");
      await loadWorkspaceState();
    });

    /* ═══════════════════════════════════════════════════════════
       MESSAGES
       ═══════════════════════════════════════════════════════════ */

    function createMessage({ role, agent, content = "", variant = "", invocationId = null }) {
      hideEmpty();
      ensureSpacer();

      const wrapper = document.createElement("article");
      wrapper.className = ["message", role, variant].filter(Boolean).join(" ");

      // Meta
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

      // Status badge (hidden by default, shown only for live agents)
      const badge = document.createElement("span");
      badge.className = "msg-badge";
      badge.style.display = "none";
      meta.appendChild(badge);

      // Copy button (assistant only)
      if (role === "assistant" && content) {
        const copy = document.createElement("button");
        copy.className = "msg-copy";
        copy.textContent = "⎘";
        copy.title = "复制";
        copy.addEventListener("click", () => {
          copyToClipboard(content, copy);
        });
        meta.appendChild(copy);
      }

      // Bubble
      const card = document.createElement("div");
      card.className = "msg-card";
      const bubble = document.createElement("div");
      bubble.className = "msg-bubble";
      card.appendChild(bubble);

      // Live messages from showThinking: use dual-container for smooth streaming
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

        return { wrapper, bubble, meta, setBadge, _liveTextEl: liveText };
      }

      // Static message: standard rendering
      bubble.innerHTML = renderMd(content);

      wrapper.append(meta, card);
      messagesEl.insertBefore(wrapper, spacerEl);
      scrollDown();

      if (role === "assistant" && invocationId) {
        attachRecallToggle(wrapper, invocationId);
      }

      const setBadge = makeSetBadge(badge);

      return { wrapper, bubble, meta, setBadge };
    }

    function showThinking(agent) {
      // Prevent duplicate thinking entries for the same agent.
      if (state.liveMessages.has(agent)) return;

      const item = createMessage({ role: "assistant", agent, content: "" });
      item.setBadge("thinking");
      item.rawText = "";
      state.liveMessages.set(agent, item);
    }

    function stopThinking(agent) {
      const item = state.liveMessages.get(agent);
      if (!item) return;
      // Transition: thinking → done (will be overwritten if message arrives)
      item.setBadge("done");
    }

    /* rAF batch — coalesce multiple SSE tokens into one render frame. */
    let _rafId = null;
    let _rafPending = new Map(); // agent → rawText

    function _flushRaf() {
      for (const [agent, raw] of _rafPending) {
        const item = state.liveMessages.get(agent);
        if (!item || !item._liveTextEl) continue;
        item._liveTextEl.textContent = raw;
      }
      _rafPending.clear();
      _rafId = null;
      scrollDown();
    }

    function flushPendingLiveRender() {
      if (_rafId) {
        cancelAnimationFrame(_rafId);
        _flushRaf();
      }
    }

    function appendLive(agent, text) {
      hideEmpty();
      ensureSpacer();

      if (!state.liveMessages.has(agent)) {
        // Defensive: message arrived before agent-start (shouldn't happen, but handle gracefully)
        const item = createMessage({ role: "assistant", agent });
        item.rawText = "";
        item.invocationId = state.liveInvocations.get(agent) || null;
        item.setBadge("writing");
        state.liveMessages.set(agent, item);
      }
      const item = state.liveMessages.get(agent);
      item.rawText += text;

      // Switch from thinking to writing on first text
      item.bubble.classList.remove("msg-bubble-live-pending");
      item.setBadge("writing");

      // Batch renders: at most one renderMd per animation frame
      _rafPending.set(agent, item.rawText);
      if (!_rafId) _rafId = requestAnimationFrame(_flushRaf);
      scrollDown();
    }

    function finalizeLiveMessages() {
      flushPendingLiveRender();
      for (const [, item] of state.liveMessages) {
        item.bubble.innerHTML = renderMd(item.rawText || "");
        if (!item.wrapper.querySelector(".msg-copy")) {
          const copy = document.createElement("button");
          copy.className = "msg-copy";
          copy.textContent = "⎘";
          copy.title = "复制";
          copy.addEventListener("click", () => {
            copyToClipboard(item.rawText || "", copy);
          });
          const meta = item.wrapper.querySelector(".msg-meta");
          if (meta) meta.appendChild(copy);
        }
        if (item.invocationId) attachRecallToggle(item.wrapper, item.invocationId);
        // Clear the status badge (fade out)
        item.setBadge("done");
      }
    }

    function finishStream(statusText) {
      state.doneReceived = true;
      finalizeLiveMessages();
      sessionController.loadSessions();
      loadWorktreeStatus();
      if (state.rightPanelTab === "workspace") {
        loadWorkspaceState();
      }
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
          promptEl.value = state.lastPrompt;
          state.selectedAgent = state.lastAgent;
          renderAgentTabs();
          chatClient.sendPrompt();
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
          .catch((e) => console.warn("Active skills load failed:", e));
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
          <span class="agent-tab-role"></span>
          <span class="agent-tab-name"></span>
          <span class="agent-tab-model"></span>`;
        item.querySelector(".agent-tab-role").textContent = agentRoleLabel(a);
        item.querySelector(".agent-tab-name").textContent = agentLabel(a.id);
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
       RECALL (memory/回忆)
       Each assistant message is produced by an invocation. Invocations record
       an event stream (invocation-start / stdout / stderr / invocation-end)
       on the server, exposed via /api/callbacks/{list-invocations,
       session-search, read-invocation}. The recall panel lists & searches
       them; each assistant message also gets an inline "回忆" toggle that
       expands its own execution trace — this is the "点了会展开" the
       original design was missing.
       ═══════════════════════════════════════════════════════════ */

    function fmtEventTime(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function eventBodyText(evt) {
      const p = evt.payload || {};
      if (evt.kind === "stdout" || evt.kind === "stderr") return p.text || "";
      if (evt.kind === "invocation-start") return `agent: ${p.agent || "?"}${p.shouldResume ? " · resume" : ""}`;
      if (evt.kind === "invocation-end") return `code: ${p.code ?? "?"}${p.signal ? ` · signal: ${p.signal}` : ""}`;
      return JSON.stringify(p, null, 2);
    }

    function renderEventList(events) {
      const container = document.createElement("div");
      container.className = "recall-events";
      if (!events || events.length === 0) {
        setRecallEmpty(container, "无事件记录");
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
      if (!sid || !invocationId) return [];
      const data = await recallApi.readInvocation(sid, invocationId, { from: 0, limit: 500 });
      return data.events || [];
    }

    // ── Per-message inline expand ────────────────────────────

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
      setRecallEmpty(panel, "加载中…");
      wrapper.appendChild(panel);
      btn.classList.add("open");
      try {
        const events = await fetchInvocationEvents(invocationId);
        panel.replaceChildren(renderEventList(events));
      } catch (e) {
        setRecallEmpty(panel, "加载失败: " + e.message, true);
      }
    }

    // ── Session-level recall panel ───────────────────────────

    function openRecall() {
      recallPanelEl.hidden = false;
      recallOverlayEl.classList.add("show");
      state.recallOpen = true;
      loadRecallList();
    }

    function closeRecall() {
      recallPanelEl.hidden = true;
      recallOverlayEl.classList.remove("show");
      state.recallOpen = false;
    }

    recallToggleEl.addEventListener("click", () => {
      if (state.recallOpen) closeRecall(); else openRecall();
    });
    recallCloseEl.addEventListener("click", closeRecall);
    recallOverlayEl.addEventListener("click", closeRecall);

    async function loadRecallList() {
      recallSearchInputEl.value = "";
      setRecallEmpty(recallBodyEl, "加载中…");
      const sid = state.currentSessionId;
      if (!sid) { setRecallEmpty(recallBodyEl, "暂无会话"); return; }
      try {
        renderRecallList(await recallApi.listInvocations(sid));
      } catch (e) {
        setRecallEmpty(recallBodyEl, "加载失败: " + e.message, true);
      }
    }

    function renderRecallList(invocations) {
      if (invocations.length === 0) {
        setRecallEmpty(recallBodyEl, "本会话暂无调用记录");
        return;
      }
      recallBodyEl.replaceChildren(...invocations.map((inv) => {
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
      setRecallEmpty(body, "加载中…");
      row.append(body);
      try {
        const events = await fetchInvocationEvents(invocationId);
        body.replaceChildren(renderEventList(events));
      } catch (e) {
        setRecallEmpty(body, "加载失败: " + e.message, true);
      }
    }

    recallSearchInputEl.addEventListener("input", () => {
      clearTimeout(state.recallSearchDebounce);
      const q = recallSearchInputEl.value.trim();
      if (!q) { loadRecallList(); return; }
      state.recallSearchDebounce = setTimeout(() => runRecallSearch(q), 250);
    });

    async function runRecallSearch(query) {
      setRecallEmpty(recallBodyEl, "搜索中…");
      const sid = state.currentSessionId;
      if (!sid) { setRecallEmpty(recallBodyEl, "暂无会话"); return; }
      try {
        renderRecallHits(await recallApi.searchSession(sid, query, { limit: 30 }));
      } catch (e) {
        setRecallEmpty(recallBodyEl, "搜索失败: " + e.message, true);
      }
    }

    function renderRecallHits(hits) {
      if (hits.length === 0) {
        setRecallEmpty(recallBodyEl, "无匹配结果");
        return;
      }
      recallBodyEl.replaceChildren(...hits.map((hit) => {
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
      setRecallEmpty(body, "加载中…");
      row.append(body);
      try {
        const events = await fetchInvocationEvents(invocationId);
        body.replaceChildren(renderEventList(events));
      } catch (e) {
        setRecallEmpty(body, "加载失败: " + e.message, true);
      }
    }

    /* ═══════════════════════════════════════════════════════════
       SSE PARSER
       ═══════════════════════════════════════════════════════════ */

    const chatClient = window.ChatClient.createChatClient({
      state,
      promptEl,
      btnSend,
      useWorktreeInput,
      resolvePromptAgent,
      addSystem,
      setStatus,
      updateMentionMenu,
      sessionApi,
      createMessage,
      hideMentionMenu,
      fetchImpl: window.fetch.bind(window),
      flushPendingLiveRender,
      renderMd,
      sessionController,
      loadProjectDir,
      loadWorktreeStatus,
      loadWorkspaceState,
      renderSkillTags,
      showThinking,
      appendLive,
      addDebug,
      finishStream,
      agentLabel,
    });

    /* ═══════════════════════════════════════════════════════════
       EVENT BINDINGS
       ═══════════════════════════════════════════════════════════ */

    btnSend.addEventListener("click", () => {
      if (state.controller) { state.controller.abort(); return; }
      chatClient.sendPrompt();
    });

    btnClear.addEventListener("click", async () => {
      if (state.controller) {
        state.controller.abort();
      }
      await sessionController.newSession();
      renderSkillTags([]);
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
        chatClient.sendPrompt();
      }
    });

    /* ═══════════════════════════════════════════════════════════
       INIT
       ═══════════════════════════════════════════════════════════ */

    initTheme();
    setRightPanelTab("agents");
    loadProjectDir();
    renderWorkspacePanel();

    fetch("/api/skills")
      .then(jsonOrThrow)
      .then((d) => {
        state.skillsMetadata = d.skills || [];
        renderSkillTags([]);
      })
      .catch((e) => console.warn("Skills metadata load failed:", e));

    Promise.all([loadAgents(), sessionController.loadSessions()]).catch((e) => {
      setStatus("加载失败", "error");
    });
  })();
