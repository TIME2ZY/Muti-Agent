(function () {
  "use strict";

  /* ═══════════════════════════════════════════════════════════
     DOM REFS + shared clients
     ═══════════════════════════════════════════════════════════ */

  const $ = (sel) => document.querySelector(sel);

  const messagesEl = $("#messages");
  const promptEl = $("#prompt");
  const btnSend = $("#btn-send");
  const btnClear = $("#btn-clear");
  const useWorktreeInput = $("#use-worktree");
  const skillsBarEl = $("#skills-bar");
  const statusEl = $("#status");
  const sidebarEl = $("#sidebar");
  const sidebarToggle = $("#sidebar-toggle");
  const sidebarOverlay = $("#sidebar-overlay");
  const sessionListEl = $("#session-list");
  const btnNewChat = $("#btn-new-chat");
  const panelTabAgentsEl = $("#panel-tab-agents");
  const panelTabWorkspaceEl = $("#panel-tab-workspace");
  const panelTabRecallEl = $("#panel-tab-recall");
  const agentPanelEl = $("#agent-panel");
  const agentTabsEl = $("#agent-tabs");
  const workspacePanelEl = $("#workspace-panel");
  const emptyStateEl = $("#empty-state");
  const spacerEl = messagesEl.querySelector(".messages-spacer");
  const skillsLabel = skillsBarEl.querySelector(".skills-bar-label");
  const themeToggle = $("#theme-toggle");
  const projectDirEl = $("#project-dir");
  const projectDirPath = $("#project-dir-path");
  const worktreeStatusEl = $("#worktree-status");
  const mentionMenuEl = $("#mention-menu");
  // The recall UI now lives exclusively inside the right-side panel
  // (third tab). The legacy standalone drawer and overlay were removed.
  const recallPanelInlineEl = $("#recall-panel-inline");
  const recallBodyEl = recallPanelInlineEl ? recallPanelInlineEl.querySelector(".recall-body") : null;
  const recallSearchInputEl = recallPanelInlineEl ? recallPanelInlineEl.querySelector(".recall-search input") : null;
  const currentAgentEl = $("#current-agent");
  const currentAgentNameEl = $("#current-agent-name");

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
  const confirmImpl = window.UiConfirm.createConfirm();
  const sidePanelEl = $("#side-panel");

  /* ═══════════════════════════════════════════════════════════
     STATE ownership (see design §4.1)
     - state: serializable UI selection only
     - runtimeStore: per-session live runs (not mirrored into state)
     - DOM: pure derived views; do not treat DOM as source of truth
     ═══════════════════════════════════════════════════════════ */

  const state = {
    // UI selection (serializable)
    agents: [],
    selectedAgent: "architect",
    currentSessionId: null,
    skillsMetadata: [],
    // Per-session UI slots (lastPrompt/lastAgent for retry) — not live run data
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
    rightPanelTab: "agents", // agents | workspace | recall
    workspace: window.WorkspacePanel.emptyWorkspaceState(),
    // NOT live run data — see runtimeStore
    runtimeStore,
  };

  const display = window.DisplayHelpers.createDisplayHelpers({
    getAgents: () => state.agents,
  });
  const {
    agentLabel,
    agentMention,
    agentMeta,
    agentRoleSummary,
    roleDisplayName,
    roleBadgeLabel,
    fmtTime,
  } = display;

  const theme = window.Theme.createThemeController({
    toggleEl: themeToggle,
    root: document.documentElement,
    storage: localStorage,
  });
  theme.init();
  theme.bindClick();

  /* ═══════════════════════════════════════════════════════════
     Orchestrator helpers
     ═══════════════════════════════════════════════════════════ */

  function sessionSlot() {
    const sid = state.currentSessionId || "_pending";
    if (!state.sessions[sid]) {
      state.sessions[sid] = { lastPrompt: "", lastAgent: state.selectedAgent || "architect" };
    }
    return state.sessions[sid];
  }

  function syncComposerControls() {
    const rt = runtimeStore.get(state.currentSessionId || "_pending");
    const running = !!(rt && rt.controller);
    promptEl.disabled = running;
    btnSend.textContent = running ? "停止" : "发送";
    btnSend.setAttribute("aria-busy", running ? "true" : "false");
    btnSend.setAttribute("aria-label", running ? "停止生成" : "发送");
    if (running) btnSend.classList.add("danger");
    else btnSend.classList.remove("danger");
  }

  function setStatus(text, cls) {
    if (!text || text === "就绪") {
      statusEl.style.display = "none";
      return;
    }
    statusEl.style.display = "";
    statusEl.textContent = text;
    statusEl.className = "main-status" + (cls ? " " + cls : "");
  }

  async function jsonOrThrow(res) {
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* keep text */ }
    if (!res.ok) {
      const err = new Error(data.error || `${res.status} ${res.statusText}`);
      err.body = text;
      throw err;
    }
    return data;
  }

  function resolvePromptAgent(prompt) {
    const slot = sessionSlot();
    return agentRouting.resolvePromptAgent({
      prompt,
      agents: state.agents,
      selectedAgent: state.selectedAgent,
      lastAgent: slot.lastAgent || state.lastAgent,
      defaultAgent: "architect",
    }).agent;
  }

  function setDefaultAgent(agentId, options = {}) {
    const known = state.agents.find((a) => a.id === agentId);
    if (!known) return;
    state.selectedAgent = known.id;
    state.lastAgent = known.id;
    sessionSlot().lastAgent = known.id;
    if (options.render !== false) {
      renderAgentTabs();
      renderCurrentAgent();
    }
  }

  function applySessionAgent(sessionId, lastAgent) {
    const sid = sessionId || state.currentSessionId || "_pending";
    if (!state.sessions[sid]) state.sessions[sid] = { lastPrompt: "", lastAgent: "" };
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

  /* ═══════════════════════════════════════════════════════════
     Feature modules
     ═══════════════════════════════════════════════════════════ */

  const projectHeader = window.ProjectHeader.createProjectHeader({
    projectDirEl,
    projectDirPath,
    worktreeStatusEl,
    state,
    sessionApi,
    worktreeApi,
  });
  projectHeader.bindProjectDirEdit();
  const { loadProjectDir, loadWorktreeStatus, renderWorktreeStatus } = projectHeader;

  const workspacePanel = window.WorkspacePanel.createWorkspacePanel({
    panelEl: workspacePanelEl,
    state,
    worktreeApi,
    escHtml,
    WorkspaceDiff: window.WorkspaceDiff,
    VirtualList: window.VirtualList,
    confirmImpl,
    onAfterDiscard: loadWorktreeStatus,
  });

  const recallPanel = window.RecallPanel.createRecallPanel({
    bodyEl: recallBodyEl,
    searchInputEl: recallSearchInputEl,
    state,
    recallApi,
    agentLabel,
    fmtTime,
    escHtml,
  });
  recallPanel.bindSearch();

  let sessionController = null;
  let chatClient = null;
  let renderAgentTabs = () => {};
  let renderCurrentAgent = () => {};

  const messageView = window.MessageView.createMessageView({
    messagesEl,
    emptyStateEl,
    spacerEl,
    state,
    runtimeStore,
    renderMd,
    writeClipboard,
    roleDisplayName,
    roleBadgeLabel,
    attachRecallToggle: recallPanel.attachRecallToggle,
    fetchInvocationEvents: recallPanel.fetchInvocationEvents,
    onRuntimeStatusChange,
    setStatus,
    getSessionController: () => sessionController,
    loadWorktreeStatus,
    loadWorkspaceState: () => workspacePanel.loadWorkspaceState(),
    syncComposerControls,
    getSessionSlot: sessionSlot,
    renderAgentTabs: () => renderAgentTabs(),
    getChatClient: () => chatClient,
    promptEl,
  });
  messageView.bindCodeBlockDelegates(document);

  const {
    createMessage,
    showThinking,
    appendLive,
    applyAgentEvent,
    flushPendingLiveRender,
    finishStream,
    remountLiveMessages,
    addSystem,
    addDebug,
    ensureSpacer,
    showEmpty,
  } = messageView;

  function onRuntimeStatusChange(sessionId) {
    const sid = sessionId || state.currentSessionId;
    if (sid && typeof sessionListView?.updateStatus === "function") {
      sessionListView.updateStatus(sid, runtimeStore.getStatus(sid));
      return;
    }
    if (typeof sessionController?.refreshSessionList === "function") {
      sessionController.refreshSessionList();
    }
  }

  function toggleSidebar() {
    const open = sidebarEl.classList.toggle("open");
    if (sidebarToggle) sidebarToggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeSidebarIfMobile() {
    if (window.innerWidth <= 700) sidebarEl.classList.remove("open");
  }

  sidebarToggle.addEventListener("click", toggleSidebar);
  sidebarOverlay.addEventListener("click", toggleSidebar);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sidebarEl.classList.contains("open")) toggleSidebar();
  });

  let sessionListView = null;

  function renderSessionList(sessions) {
    if (sessionListView) sessionListView.render(sessions);
  }

  sessionListView = window.SessionListView.createSessionListView({
    sessionListEl,
    getCurrentSessionId: () => state.currentSessionId,
    getRuntimeStatus: (id) => runtimeStore.getStatus(id),
    onSelect: (id) => {
      sessionController.switchSession(id);
      closeSidebarIfMobile();
    },
    onDelete: async (id) => {
      const ok = await confirmImpl("确认删除此对话？删除后无法恢复。", {
        title: "删除对话",
        danger: true,
        confirmLabel: "删除",
      });
      if (ok) sessionController.deleteSession(id);
    },
    fmtTime,
    escHtml,
  });

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
    loadWorkspaceState: () => workspacePanel.loadWorkspaceState(),
    renderWorktreeStatus,
    renderWorkspacePanel: () => workspacePanel.renderWorkspacePanel(),
    emptyWorkspaceState: () => window.WorkspacePanel.emptyWorkspaceState(),
    setStatus,
    applySessionAgent,
    remountLiveMessages,
    syncComposerControls,
  });

  const RIGHT_TABS = ["agents", "workspace", "recall"];
  const tabButtons = {
    agents: panelTabAgentsEl,
    workspace: panelTabWorkspaceEl,
    recall: panelTabRecallEl,
  };

  function setRightPanelTab(nextTab) {
    state.rightPanelTab = nextTab;
    if (agentPanelEl) agentPanelEl.hidden = nextTab !== "agents";
    if (workspacePanelEl) workspacePanelEl.hidden = nextTab !== "workspace";
    if (recallPanelInlineEl) recallPanelInlineEl.hidden = nextTab !== "recall";

    for (const id of RIGHT_TABS) {
      const btn = tabButtons[id];
      if (!btn) continue;
      const active = id === nextTab;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
    }

    // Mobile: expand side panel for workspace/recall density.
    if (sidePanelEl) {
      sidePanelEl.classList.toggle("is-expanded", nextTab === "workspace" || nextTab === "recall");
    }

    if (nextTab === "recall") recallPanel.loadRecallList();
  }

  async function activateRightTab(nextTab) {
    setRightPanelTab(nextTab);
    if (nextTab === "workspace") await workspacePanel.loadWorkspaceState();
  }

  panelTabAgentsEl.addEventListener("click", () => activateRightTab("agents"));
  panelTabWorkspaceEl.addEventListener("click", () => activateRightTab("workspace"));
  if (panelTabRecallEl) {
    panelTabRecallEl.addEventListener("click", () => activateRightTab("recall"));
  }

  const tablistEl = document.querySelector(".panel-tabs");
  if (tablistEl) {
    tablistEl.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
      const idx = RIGHT_TABS.indexOf(state.rightPanelTab);
      if (idx < 0) return;
      e.preventDefault();
      let next = idx;
      if (e.key === "ArrowRight") next = (idx + 1) % RIGHT_TABS.length;
      if (e.key === "ArrowLeft") next = (idx - 1 + RIGHT_TABS.length) % RIGHT_TABS.length;
      if (e.key === "Home") next = 0;
      if (e.key === "End") next = RIGHT_TABS.length - 1;
      activateRightTab(RIGHT_TABS[next]).then(() => {
        const btn = tabButtons[RIGHT_TABS[next]];
        if (btn) btn.focus();
      });
    });
  }

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
    mentionComposer.hide();
    promptEl.focus();
  }

  const agentPanelView = window.AgentPanelView.createAgentPanelView({
    agentTabsEl,
    currentAgentEl,
    currentAgentNameEl,
    state,
    agentLabel,
    agentMention,
    agentMeta,
    agentRoleSummary,
    setDefaultAgent,
    insertAgentMention,
    promptEl,
  });
  renderAgentTabs = agentPanelView.renderAgentTabs;
  renderCurrentAgent = agentPanelView.renderCurrentAgent;

  async function loadAgents() {
    try {
      const res = await apiFetch("/api/agents");
      const data = await jsonOrThrow(res);
      state.agents = data.agents;
      if (!state.agents.find((a) => a.id === state.selectedAgent)) {
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

  const mentionComposer = window.MentionComposer.createMentionComposer({
    promptEl,
    menuEl: mentionMenuEl,
    state,
    getAgents: () => state.agents,
    setDefaultAgent,
    agentMention,
    agentMeta,
    updateActiveSkills,
  });

  chatClient = window.ChatClient.createChatClient({
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
    hideMentionMenu: () => mentionComposer.hide(),
    fetchImpl: apiFetch,
    flushPendingLiveRender,
    renderMd,
    sessionController,
    loadProjectDir,
    loadWorktreeStatus,
    loadWorkspaceState: () => workspacePanel.loadWorkspaceState(),
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
     Event bindings + init
     ═══════════════════════════════════════════════════════════ */

  btnNewChat.addEventListener("click", () => sessionController.newSession());
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
    mentionComposer.update();
  });
  promptEl.addEventListener("click", () => mentionComposer.update());
  promptEl.addEventListener("keyup", (e) => {
    if (["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) return;
    mentionComposer.update();
  });
  promptEl.addEventListener("keydown", (e) => {
    // IME composition: skip shortcuts while composing CJK candidates.
    if (e.isComposing || e.keyCode === 229) return;
    if (mentionComposer.handleKeydown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      chatClient.sendPrompt();
    }
  });

  setRightPanelTab("agents");
  loadProjectDir();
  workspacePanel.renderWorkspacePanel();

  apiFetch("/api/skills")
    .then(jsonOrThrow)
    .then((d) => {
      state.skillsMetadata = d.skills || [];
      renderSkillTags([]);
    })
    .catch((e) => console.warn("Skills metadata load failed:", e));

  Promise.all([loadAgents(), sessionController.loadSessions()]).catch(() => {
    setStatus("加载失败", "error");
  });
})();
