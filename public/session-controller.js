(function initSessionController(globalScope) {
  "use strict";

  function createSessionController(deps) {
    const {
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
    } = deps;
    let switchToken = 0;

    async function refreshSessionList() {
      try {
        const sessions = await sessionApi.listSessions();
        renderSessionList(sessions);
        return sessions;
      } catch {
        return [];
      }
    }

    async function switchSession(id) {
      const token = ++switchToken;
      if (id === state.currentSessionId) return;
      if (state.controller) {
        state.controller.abort();
        state.controller = null;
      }
      const previousSessionId = state.currentSessionId;
      state.currentSessionId = id;
      state.liveMessages.clear();
      state.liveInvocations.clear();
      messagesEl.replaceChildren();

      try {
        const messages = await sessionApi.readMessages(id);
        if (token !== switchToken || state.currentSessionId !== id) return;
        if (!messages || messages.length === 0) {
          ensureSpacer();
          showEmpty();
        } else {
          for (const msg of messages) {
            createMessage({
              role: msg.role,
              agent: msg.agent,
              content: msg.content || "",
              variant: msg.exitCode && msg.exitCode !== 0 ? "error" : "",
              invocationId: msg.invocationId || null,
            });
          }
          ensureSpacer();
        }
      } catch (error) {
        state.currentSessionId = previousSessionId;
        addSystem("加载消息失败: " + error.message, "error");
        ensureSpacer();
      }

      if (token !== switchToken || state.currentSessionId !== id) return;
      await refreshSessionList();
      if (token !== switchToken || state.currentSessionId !== id) return;
      await loadProjectDir(id);
      if (token !== switchToken || state.currentSessionId !== id) return;
      await loadWorktreeStatus();
      if (token !== switchToken || state.currentSessionId !== id) return;
      if (state.rightPanelTab === "workspace") {
        await loadWorkspaceState();
      }
    }

    async function loadSessions() {
      const sessions = await refreshSessionList();
      if (!state.currentSessionId && sessions.length > 0) {
        try {
          await switchSession(sessions[0].id);
        } catch {}
      }
    }

    async function newSession() {
      try {
        const session = await sessionApi.createSession();
        state.currentSessionId = session.id;
        state.liveMessages.clear();
        state.liveInvocations.clear();
        messagesEl.replaceChildren();
        ensureSpacer();
        showEmpty();
        state.worktreeStatus = null;
        renderWorktreeStatus();
        state.workspace = emptyWorkspaceState();
        renderWorkspacePanel();
        state.projectDir = "";
        await loadProjectDir(session.id);
        setStatus("就绪");
        await refreshSessionList();
        promptEl.focus();
        closeSidebarIfMobile();
      } catch (error) {
        addSystem("创建会话失败: " + error.message, "error");
      }
    }

    async function deleteSession(id) {
      try {
        await sessionApi.deleteSession(id);
        if (state.currentSessionId === id) {
          if (state.controller) {
            state.controller.abort();
          }
          state.currentSessionId = null;
          state.liveMessages.clear();
          state.liveInvocations.clear();
          messagesEl.replaceChildren();
          ensureSpacer();
          showEmpty();
          state.projectDir = "";
          projectDirPath.textContent = "(当前目录)";
          state.worktreeStatus = null;
          renderWorktreeStatus();
          state.workspace = emptyWorkspaceState();
          renderWorkspacePanel();
          setStatus("就绪");
        }
        await refreshSessionList();
        closeSidebarIfMobile();
      } catch (error) {
        addSystem("删除会话失败: " + error.message, "error");
      }
    }

    return {
      refreshSessionList,
      loadSessions,
      switchSession,
      newSession,
      deleteSession,
    };
  }

  const api = { createSessionController };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.SessionController = api;
})(typeof window !== "undefined" ? window : globalThis);
