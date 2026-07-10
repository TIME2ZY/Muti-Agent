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
    // The recall UI now lives exclusively inside the right-side panel
    // (third tab). The legacy standalone drawer and overlay were removed.
    const recallPanelInlineEl = $("#recall-panel-inline");
    const recallBodyEl = recallPanelInlineEl ? recallPanelInlineEl.querySelector(".recall-body") : null;
    const recallSearchInputEl = recallPanelInlineEl ? recallPanelInlineEl.querySelector(".recall-search input") : null;
    const apiFetch = window.ApiClient.apiFetch;
    const sessionApi = window.SessionApi.createSessionApi(apiFetch);
    const worktreeApi = window.WorktreeApi.createWorktreeApi(apiFetch);
    const recallApi = window.RecallApi.createRecallApi(apiFetch);
    const escHtml = window.MarkdownLite.escHtml;
    const renderMd = window.MarkdownLite.renderMd;
    const writeClipboard = window.ClipboardUtils.writeClipboard;
    const runLatestSkillsRequest = window.LatestRequest.createLatestRequestRunner();
    const agentRouting = window.AgentRouting;
    const runtimeStore = window.SessionRuntime.createRuntimeStore();
    const currentAgentEl = $("#current-agent");
    const currentAgentNameEl = $("#current-agent-name");

    /* ═══════════════════════════════════════════════════════════
       THEME
       Three-state cycle: system → light → dark → system.
       "system" means no data-theme attribute; light-dark() in CSS
       follows prefers-color-scheme. Explicit "light"/"dark" pins
       the data-theme attribute.
       ═══════════════════════════════════════════════════════════ */

    const THEME_KEY = "agent-chat-theme";
    const THEME_CYCLE = ["system", "light", "dark"];
    const THEME_ICON = { system: "◐", light: "☀", dark: "☾" };
    const THEME_LABEL = { system: "跟随系统", light: "浅色", dark: "深色" };

    function currentTheme() {
      const saved = localStorage.getItem(THEME_KEY);
      return THEME_CYCLE.includes(saved) ? saved : "system";
    }

    function applyTheme(theme) {
      if (theme === "system") {
        document.documentElement.removeAttribute("data-theme");
      } else {
        document.documentElement.setAttribute("data-theme", theme);
      }
      themeToggle.textContent = THEME_ICON[theme];
      themeToggle.title = `主题：${THEME_LABEL[theme]}（点击切换）`;
      themeToggle.setAttribute("aria-label", `切换主题，当前：${THEME_LABEL[theme]}`);
    }

    function initTheme() {
      applyTheme(currentTheme());
    }

    themeToggle.addEventListener("click", () => {
      const idx = THEME_CYCLE.indexOf(currentTheme());
      const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
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
        diffTruncated: false,
        diffTotalChars: 0,
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

      if (state.workspace.diffTruncated) {
        const warning = document.createElement("div");
        warning.className = "workspace-summary-meta";
        warning.textContent = `仅显示前 ${state.workspace.diffText.length} 个字符，原始 diff 共 ${state.workspace.diffTotalChars} 个字符`;
        wrap.append(warning);
      }

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
        const diffData = await worktreeApi.readDiff(state.currentSessionId, { allowMissing: true });
        const diffText = diffData.diff || "";
        const files = window.WorkspaceDiff
          ? window.WorkspaceDiff.parseUnifiedDiff(diffText)
          : [];

        state.workspace = {
          status,
          diffText,
          diffTruncated: diffData.truncated === true,
          diffTotalChars: diffData.totalChars || diffText.length,
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

    const panelTabRecallEl = $("#panel-tab-recall");

    function setRightPanelTab(nextTab) {
      state.rightPanelTab = nextTab;
      if (agentPanelEl) agentPanelEl.hidden = nextTab !== "agents";
      if (workspacePanelEl) workspacePanelEl.hidden = nextTab !== "workspace";
      if (recallPanelInlineEl) recallPanelInlineEl.hidden = nextTab !== "recall";
      if (panelTabAgentsEl) {
        panelTabAgentsEl.classList.toggle("is-active", nextTab === "agents");
        panelTabAgentsEl.setAttribute("aria-selected", nextTab === "agents" ? "true" : "false");
      }
      if (panelTabWorkspaceEl) {
        panelTabWorkspaceEl.classList.toggle("is-active", nextTab === "workspace");
        panelTabWorkspaceEl.setAttribute("aria-selected", nextTab === "workspace" ? "true" : "false");
      }
      if (panelTabRecallEl) {
        panelTabRecallEl.classList.toggle("is-active", nextTab === "recall");
        panelTabRecallEl.setAttribute("aria-selected", nextTab === "recall" ? "true" : "false");
        if (nextTab === "recall") loadRecallList();
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
      runtimeStore,
      skillsMetadata: [],
      // Per-session retry state. Keyed by currentSessionId so that
      // switching sessions doesn't accidentally replay the previous
      // session's prompt into the new one.
      sessions: {},
      lastPrompt: "",
      lastAgent: "architect",
      skillDebounce: null,
      projectDir: "",
      worktreeStatus: null,
      mentionOpen: false,
      mentionIndex: 0,
      mentionMatches: [],
      mentionRange: null,
      recallSearchDebounce: null,
      rightPanelTab: "agents",
      workspace: emptyWorkspaceState(),
    };

    function sessionRuntime(sessionId) {
      return runtimeStore.getOrCreate(sessionId || state.currentSessionId || "_pending");
    }

    function isViewingSession(sessionId) {
      const sid = sessionId || "_pending";
      return !state.currentSessionId || state.currentSessionId === sid;
    }

    function syncComposerControls() {
      const rt = runtimeStore.get(state.currentSessionId || "_pending");
      const running = !!(rt && rt.controller);
      promptEl.disabled = running;
      btnSend.textContent = running ? "停止" : "发送";
      if (running) btnSend.classList.add("danger");
      else btnSend.classList.remove("danger");
    }

    function runStatusLabel(status) {
      if (status === "running") return "运行中";
      if (status === "done") return "完成";
      if (status === "error") return "失败";
      return "";
    }

    function sessionSlot() {
      const sid = state.currentSessionId || "_pending";
      if (!state.sessions[sid]) {
        state.sessions[sid] = { lastPrompt: "", lastAgent: state.selectedAgent || "architect" };
      }
      return state.sessions[sid];
    }

    function applySessionAgent(sessionId, lastAgent) {
      const sid = sessionId || state.currentSessionId || "_pending";
      if (!state.sessions[sid]) {
        state.sessions[sid] = { lastPrompt: "", lastAgent: "" };
      }
      const agentId = lastAgent || state.selectedAgent || "architect";
      const known = state.agents.find((a) => a.id === agentId);
      const resolvedId = known ? known.id : (state.agents[0]?.id || "architect");
      state.sessions[sid].lastAgent = resolvedId;
      if (sid === state.currentSessionId || !state.currentSessionId) {
        state.selectedAgent = resolvedId;
        state.lastAgent = resolvedId;
        renderAgentTabs();
        renderCurrentAgent();
      }
    }

    function setDefaultAgent(agentId, options = {}) {
      const known = state.agents.find((a) => a.id === agentId);
      if (!known) return;
      state.selectedAgent = known.id;
      state.lastAgent = known.id;
      const slot = sessionSlot();
      slot.lastAgent = known.id;
      if (options.render !== false) {
        renderAgentTabs();
        renderCurrentAgent();
      }
    }

    function renderCurrentAgent() {
      const agent = state.agents.find((a) => a.id === state.selectedAgent)
        || state.agents[0]
        || { id: state.selectedAgent || "architect", label: state.selectedAgent || "architect" };
      const label = agentLabel(agent.id);
      if (currentAgentNameEl) currentAgentNameEl.textContent = label;
      if (currentAgentEl) {
        currentAgentEl.title = `当前默认 Agent：${label}（${agent.id}）。右侧卡片点击切换默认；消息行首 @ 可单次覆盖。`;
      }
    }

    /* ═══════════════════════════════════════════════════════════
       HELPERS
       ═══════════════════════════════════════════════════════════ */

    function copyToClipboard(text, btn, okText = "✓", failText = "Failed") {
      const orig = btn.textContent;
      // Write both formats: HTML for editors that honor text/html (with
      // syntax-highlight tokens), plain text for everything else. The
      // browser's clipboard API lets us mark up rich content without
      // forcing the user to re-paste it as HTML.
      const html = btn && btn.dataset && btn.dataset.copyHtml;
      const write = writeClipboard({
        clipboard: navigator.clipboard,
        ClipboardItem: window.ClipboardItem,
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

    // Broadcast a recall-body state to every mounted panel (currently
    // only one — the inline right-side panel). Left as a function so
    // a future second mount point can be added without touching
    // every call site.
    function setRecallEmptyAll(msg, isError = false) {
      if (recallBodyEl) setRecallEmpty(recallBodyEl, msg, isError);
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
      return agent.description || "";
    }

    // Render a one-line summary of the role description. Anything past the
    // first line-clamp is available in the agent-tab's title attribute
    // (set in renderAgentTabs) and in the existing tooltip on hover.
    function agentRoleSummary(agent) {
      const desc = agent.description || "";
      const max = 32;
      return desc.length > max ? desc.slice(0, max) + "…" : desc;
    }

    function resolvePromptAgent(prompt) {
      const slot = sessionSlot();
      const resolved = agentRouting.resolvePromptAgent({
        prompt,
        agents: state.agents,
        selectedAgent: state.selectedAgent,
        lastAgent: slot.lastAgent || state.lastAgent,
        defaultAgent: "architect",
      });
      // Chat client accepts either { agent } or a bare agent object.
      return resolved.agent;
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
        const runStatus = runtimeStore.getStatus(s.id);
        const statusText = runStatusLabel(runStatus);
        item.className = "session-item"
          + (s.id === state.currentSessionId ? " active" : "")
          + (runStatus === "running" ? " is-running" : "");
        item.innerHTML = `
          <div class="session-info">
            <div class="session-title">${escHtml(s.title || "(空对话)")}</div>
            <div class="session-meta">${s.messageCount || 0} 条 · ${fmtTime(s.createdAt)}${
              statusText ? ` · <span class="session-run-status status-${runStatus}">${statusText}</span>` : ""
            }</div>
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

    function onRuntimeStatusChange() {
      // Refresh list badges without forcing a network round-trip when possible.
      if (typeof sessionController?.refreshSessionList === "function") {
        sessionController.refreshSessionList();
      }
    }

    function remountLiveMessages(sessionId) {
      const rt = runtimeStore.get(sessionId);
      if (!rt || rt.liveMessages.size === 0) return;
      hideEmpty();
      ensureSpacer();
      for (const [, item] of rt.liveMessages) {
        if (item && item.wrapper && !messagesEl.contains(item.wrapper)) {
          messagesEl.insertBefore(item.wrapper, spacerEl);
        }
      }
      ensureSpacer();
      scrollDown();
    }
    sessionController = window.SessionController.createSessionController({
      state,
      runtimeStore,
      sessionApi,
      renderSessionList,
      addSystem,
      ensureSpacer,
      showEmpty,
      createMessage,
      messagesEl,
      spacerEl,
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
      applySessionAgent,
      remountLiveMessages,
      syncComposerControls,
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
        copy.title = "复制（含 Markdown 与代码高亮）";
        copy.dataset.copyHtml = renderMd(content);
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

    function showThinking(agent, sessionId) {
      const sid = sessionId || state.currentSessionId || "_pending";
      const rt = sessionRuntime(sid);
      // Prevent duplicate thinking entries for the same agent in this session.
      if (rt.liveMessages.has(agent)) return;

      if (!isViewingSession(sid)) {
        // Keep a lightweight placeholder until the user reopens the session.
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
      if (event.type === "tool.started") return `工具: ${trimLiveStatus(event.toolName || "tool")}`;
      if (event.type === "tool.finished") {
        const status = event.status === "error" ? "失败" : "完成";
        return `工具${status}: ${trimLiveStatus(event.toolName || "tool")}`;
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

    function ensureSubagentPanel(liveItem) {
      if (!liveItem || !liveItem.bubble) return null;
      let panel = liveItem.bubble.querySelector(".live-subagents");
      if (panel) return panel;
      panel = document.createElement("div");
      panel.className = "live-subagents";
      // Prefer placing before streaming text so status stays visible.
      if (liveItem._liveTextEl && liveItem._liveTextEl.parentNode === liveItem.bubble) {
        liveItem.bubble.insertBefore(panel, liveItem._liveTextEl);
      } else {
        liveItem.bubble.appendChild(panel);
      }
      return panel;
    }

    function upsertLiveSubagent(agent, event, sessionId) {
      const sid = sessionId || state.currentSessionId || "_pending";
      if (!isViewingSession(sid)) return;
      const rt = sessionRuntime(sid);
      if (!rt.liveMessages.has(agent)) showThinking(agent, sid);
      const liveItem = rt.liveMessages.get(agent);
      if (!liveItem || liveItem.detached || !liveItem.bubble) return;

      const panel = ensureSubagentPanel(liveItem);
      if (!panel) return;

      const id = String(event.subagentId || event.toolId || event.name || "subagent");
      let row = null;
      for (const child of panel.children) {
        if (child && child.dataset && child.dataset.subagentId === id) {
          row = child;
          break;
        }
      }
      if (!row) {
        row = document.createElement("div");
        row.className = "live-subagent";
        row.dataset.subagentId = id;
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

      const name = event.name || event.toolName || "subagent";
      nameEl.textContent = name;

      let status = "running";
      let statusText = "运行中";
      if (event.type === "subagent.completed") {
        status = "done";
        statusText = "成功";
      } else if (event.type === "subagent.failed") {
        status = "error";
        statusText = "失败";
      } else if (event.type === "subagent.progress") {
        status = "running";
        statusText = "运行中";
      } else if (event.type === "subagent.started") {
        status = "running";
        statusText = "已创建";
      }
      statusEl.textContent = statusText;
      statusEl.className = `live-subagent-status status-${status}`;
      row.className = `live-subagent status-${status}`;

      if (event.task) taskEl.textContent = event.task;
      if (event.type === "subagent.progress" && event.text) {
        summaryEl.textContent = event.text;
      } else if (event.type === "subagent.completed" && event.summary) {
        summaryEl.textContent = event.summary;
      } else if (event.type === "subagent.failed" && event.error) {
        summaryEl.textContent = event.error;
      }
      scrollDown();
    }

    function setLivePending(agent, text, sessionId) {
      if (!text) return;
      const sid = sessionId || state.currentSessionId || "_pending";
      const rt = sessionRuntime(sid);
      if (!rt.liveMessages.has(agent)) showThinking(agent, sid);
      const item = rt.liveMessages.get(agent);
      if (!item) return;
      if (!item.rawText) item.pendingStatus = text;
      if (!isViewingSession(sid)) return;
      if (!item._liveTextEl || item.rawText) return;
      item._liveTextEl.textContent = text;
      scrollDown();
    }

    /* rAF batch — coalesce multiple SSE tokens into one render frame. */
    let _rafId = null;
    let _rafPending = new Map(); // `${sessionId}::${agent}` → rawText

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
      // sessionId kept for API compatibility with chat-client
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
        return;
      }

      if (event.type === "progress.update") {
        run.progressItems = Array.isArray(event.items) ? event.items : [];
        setLivePending(event.agent, pendingTextForEvent(event), sid);
        return;
      }

      if (event.type === "tool.started" || event.type === "tool.finished") {
        run.tools.push(event);
        setLivePending(event.agent, pendingTextForEvent(event), sid);
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

    function finalizeLiveMessages(sessionId) {
      const sid = sessionId || state.currentSessionId || "_pending";
      flushPendingLiveRender(sid);
      const rt = sessionRuntime(sid);
      for (const [, item] of rt.liveMessages) {
        if (!item || item.detached || !item.bubble || !item.wrapper) continue;
        const rendered = renderMd(item.rawText || "");
        item.bubble.innerHTML = rendered;
        if (!item.wrapper.querySelector(".msg-copy")) {
          const copy = document.createElement("button");
          copy.className = "msg-copy";
          copy.textContent = "⎘";
          copy.title = "复制（含 Markdown 与代码高亮）";
          copy.dataset.copyHtml = rendered;
          copy.addEventListener("click", () => {
            copyToClipboard(item.rawText || "", copy);
          });
          const meta = item.wrapper.querySelector(".msg-meta");
          if (meta) meta.appendChild(copy);
        }
        if (item.invocationId) attachRecallToggle(item.wrapper, item.invocationId);
        item.setBadge("done");
      }
    }

    function finishStream(statusText, sessionId) {
      const sid = sessionId || state.currentSessionId || "_pending";
      const rt = sessionRuntime(sid);
      rt.doneReceived = true;
      if (rt.status !== "error") rt.status = "done";
      finalizeLiveMessages(sid);
      onRuntimeStatusChange(sid);
      if (!isViewingSession(sid)) return;
      if (statusText) setStatus(statusText);
      sessionController.loadSessions();
      loadWorktreeStatus();
      if (state.rightPanelTab === "workspace") {
        loadWorkspaceState();
      }
      syncComposerControls();
    }

    function addSystem(text, variant = "") {
      hideEmpty();
      ensureSpacer();
      createMessage({ role: "system", agent: "system", content: text, variant });

      // Retry button
      const slot = sessionSlot();
      if (variant === "error" && slot.lastPrompt) {
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
          const s = sessionSlot();
          promptEl.value = s.lastPrompt;
          state.selectedAgent = s.lastAgent;
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
      state.skillDebounce = setTimeout(async () => {
        try {
          const result = await runLatestSkillsRequest.run(
            () => apiFetch(`/api/skills?prompt=${encodeURIComponent(prompt || "")}`).then(jsonOrThrow)
          );
          if (result.applied) renderSkillTags(result.value.active);
        } catch (error) {
          console.warn("Active skills load failed:", error);
        }
      }, 300);
    }

    /* ═══════════════════════════════════════════════════════════
       AGENT TABS
       ═══════════════════════════════════════════════════════════ */

    function renderAgentTabs() {
      agentTabsEl.replaceChildren(...state.agents.map((a) => {
        const item = document.createElement("article");
        const isSelected = a.id === state.selectedAgent;
        item.className = "agent-tab" + (isSelected ? " is-selected" : "");
        item.setAttribute("role", "button");
        item.tabIndex = 0;
        item.setAttribute("aria-pressed", isSelected ? "true" : "false");
        item.title = a.description
          ? `${a.label} (${a.id}) — ${a.description}\n点击设为默认 Agent · Shift+点击插入 @${agentMention(a)}`
          : `点击设为默认 Agent · Shift+点击插入 @${agentMention(a)}`;
        item.innerHTML = `
          <span class="agent-tab-role"></span>
          <span class="agent-tab-name"></span>
          <span class="agent-tab-model"></span>`;
        item.querySelector(".agent-tab-role").textContent = agentRoleSummary(a);
        item.querySelector(".agent-tab-name").textContent = agentLabel(a.id);
        item.querySelector(".agent-tab-model").textContent = agentMeta(a);
        item.addEventListener("click", (e) => {
          if (e.shiftKey) {
            insertAgentMention(a);
            return;
          }
          setDefaultAgent(a.id);
          promptEl.focus();
        });
        item.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (e.shiftKey) insertAgentMention(a);
            else {
              setDefaultAgent(a.id);
              promptEl.focus();
            }
          }
        });
        return item;
      }));
      renderCurrentAgent();
    }

    function insertAgentMention(agent) {
      const mention = `@${agentMention(agent)} `;
      const current = promptEl.value;
      const leadingAgent = agentRouting.findExplicitLeadingAgent(current, state.agents);

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

      setDefaultAgent(agent.id, { render: true });
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
      setDefaultAgent(agent.id);
      hideMentionMenu();
      updateActiveSkills(promptEl.value);
      promptEl.focus();
    }

    async function loadAgents() {
      try {
        const res = await apiFetch("/api/agents");
        const data = await jsonOrThrow(res);
        state.agents = data.agents;
        if (!state.agents.find(a => a.id === state.selectedAgent)) {
          state.selectedAgent = state.agents[0]?.id || "architect";
        }
        state.lastAgent = state.selectedAgent;
        renderAgentTabs();
        renderCurrentAgent();
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
        const page = await fetchInvocationEvents(invocationId);
        const children = [];
        const meta = renderRecallPageMeta(page.total, page.events.length);
        if (meta) children.push(meta);
        children.push(renderEventList(page.events));
        panel.replaceChildren(...children);
      } catch (e) {
        setRecallEmpty(panel, "加载失败: " + e.message, true);
      }
    }

    // ── Session-level recall panel ───────────────────────────

    if (panelTabRecallEl) {
      panelTabRecallEl.addEventListener("click", () => setRightPanelTab("recall"));
    }

    async function loadRecallList() {
      if (recallSearchInputEl) recallSearchInputEl.value = "";
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
      if (!recallBodyEl) return;
      if (invocations.length === 0) {
        setRecallEmptyAll("本会话暂无调用记录");
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
        const page = await fetchInvocationEvents(invocationId);
        const children = [];
        const meta = renderRecallPageMeta(page.total, page.events.length);
        if (meta) children.push(meta);
        children.push(renderEventList(page.events));
        body.replaceChildren(...children);
      } catch (e) {
        setRecallEmpty(body, "加载失败: " + e.message, true);
      }
    }

    if (recallSearchInputEl) {
      recallSearchInputEl.addEventListener("input", () => {
        clearTimeout(state.recallSearchDebounce);
        const q = recallSearchInputEl.value.trim();
        if (!q) { loadRecallList(); return; }
        state.recallSearchDebounce = setTimeout(() => runRecallSearch(q), 250);
      });
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
      if (!recallBodyEl) return;
      if (hits.length === 0) {
        setRecallEmptyAll("无匹配结果");
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
        const page = await fetchInvocationEvents(invocationId);
        const children = [];
        const meta = renderRecallPageMeta(page.total, page.events.length);
        if (meta) children.push(meta);
        children.push(renderEventList(page.events));
        body.replaceChildren(...children);
      } catch (e) {
        setRecallEmpty(body, "加载失败: " + e.message, true);
      }
    }

    /* ═══════════════════════════════════════════════════════════
       SSE PARSER
       ═══════════════════════════════════════════════════════════ */

    const chatClient = window.ChatClient.createChatClient({
      state,
      runtimeStore,
      promptEl,
      btnSend,
      useWorktreeInput,
      resolvePromptAgent,
      addSystem,
      setStatus,
      sessionApi,
      createMessage,
      hideMentionMenu,
      fetchImpl: apiFetch,
      flushPendingLiveRender,
      renderMd,
      sessionController,
      loadProjectDir,
      loadWorktreeStatus,
      loadWorkspaceState,
      renderSkillTags,
      showThinking,
      appendLive,
      applyAgentEvent,
      addDebug,
      finishStream,
      agentLabel,
      syncComposerControls,
      onRuntimeStatusChange,
    });

    /* ═══════════════════════════════════════════════════════════
       EVENT BINDINGS
       ═══════════════════════════════════════════════════════════ */

    btnSend.addEventListener("click", () => {
      const rt = runtimeStore.get(state.currentSessionId || "_pending");
      if (rt && rt.controller) {
        runtimeStore.abort(state.currentSessionId);
        return;
      }
      chatClient.sendPrompt();
    });

    btnClear.addEventListener("click", async () => {
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
      // IME (Chinese / Japanese / Korean) composition: don't hijack keys
      // while the user is mid-typing a candidate. The browser fires
      // compositionstart/end on the textarea, and the keydown that
      // confirms a candidate also fires with isComposing=true on some
      // platforms (e.g. Safari). Skip all shortcuts while composing.
      if (e.isComposing || e.keyCode === 229) return;

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

    apiFetch("/api/skills")
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
