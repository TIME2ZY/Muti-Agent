(function initSessionController(globalScope) {
  "use strict";

  function createSessionController(deps) {
    const {
      state,
      runtimeStore,
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
      applySessionAgent,
      remountLiveMessages,
      syncComposerControls,
    } = deps;
    let switchToken = 0;

    function store() {
      return runtimeStore || state.runtimeStore;
    }

    function notifySessionAgent(sessionId, sessions, messages) {
      if (typeof applySessionAgent !== "function") return;
      const meta = Array.isArray(sessions) ? sessions.find((s) => s && s.id === sessionId) : null;
      let lastAgent = meta && typeof meta.lastAgent === "string" ? meta.lastAgent : "";
      if (!lastAgent && Array.isArray(messages)) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const msg = messages[i];
          if (msg && msg.role === "user" && typeof msg.agent === "string" && msg.agent) {
            lastAgent = msg.agent;
            break;
          }
        }
      }
      applySessionAgent(sessionId, lastAgent || "");
    }

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

      // Do not abort the previous session's background run. Only change the
      // display target; each session keeps its own controller/live state.
      const previousSessionId = state.currentSessionId;
      state.currentSessionId = id;
      messagesEl.replaceChildren();

      let loadedMessages = null;
      try {
        const messages = await sessionApi.readMessages(id);
        loadedMessages = messages;
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

      const rt = store() ? store().get(id) : null;
      if (rt && rt.status === "running" && typeof remountLiveMessages === "function") {
        // Rebuild live bubbles for an in-flight background stream.
        // Detached placeholders are upgraded by remount helpers / later events.
        for (const [agent, item] of rt.liveMessages) {
          if (item && item.detached) {
            rt.liveMessages.delete(agent);
          }
        }
        // Re-create live UI from accumulated text when we only had placeholders.
        for (const [agent, item] of [...rt.liveMessages.entries()]) {
          if (item && item.wrapper) continue;
          // Drop empty placeholders; showThinking will recreate if events continue.
          if (!item || !item.rawText) {
            rt.liveMessages.delete(agent);
            continue;
          }
        }
        // Create visible live nodes for any remaining text buffers without wrappers.
        for (const [agent, item] of [...rt.liveMessages.entries()]) {
          if (item && !item.wrapper && item.rawText) {
            const rebuilt = createMessage({ role: "assistant", agent, content: "" });
            rebuilt.rawText = item.rawText;
            rebuilt.invocationId = item.invocationId || rt.liveInvocations.get(agent) || null;
            if (rebuilt._liveTextEl) rebuilt._liveTextEl.textContent = item.rawText;
            rebuilt.setBadge("writing");
            if (rebuilt.bubble) rebuilt.bubble.classList.remove("msg-bubble-live-pending");
            rt.liveMessages.set(agent, rebuilt);
          }
        }
        remountLiveMessages(id);
      }

      const sessions = await refreshSessionList();
      if (token !== switchToken || state.currentSessionId !== id) return;
      notifySessionAgent(id, sessions, loadedMessages);
      if (token !== switchToken || state.currentSessionId !== id) return;
      await loadProjectDir(id);
      if (token !== switchToken || state.currentSessionId !== id) return;
      await loadWorktreeStatus();
      if (token !== switchToken || state.currentSessionId !== id) return;
      if (state.rightPanelTab === "workspace") {
        await loadWorkspaceState();
      }
      if (typeof syncComposerControls === "function") syncComposerControls();
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
        // Intentionally do not abort other sessions' runtimes.
        store()?.getOrCreate(session.id);
        messagesEl.replaceChildren();
        ensureSpacer();
        showEmpty();
        state.worktreeStatus = null;
        renderWorktreeStatus();
        state.workspace = emptyWorkspaceState();
        renderWorkspacePanel();
        state.projectDir = "";
        if (typeof applySessionAgent === "function") {
          applySessionAgent(session.id, state.selectedAgent || "architect");
        }
        await loadProjectDir(session.id);
        setStatus("就绪");
        await refreshSessionList();
        if (typeof syncComposerControls === "function") syncComposerControls();
        promptEl.focus();
        closeSidebarIfMobile();
      } catch (error) {
        addSystem("创建会话失败: " + error.message, "error");
      }
    }

    async function deleteSession(id) {
      try {
        await sessionApi.deleteSession(id);
        if (store()) store().dispose(id);
        if (state.currentSessionId === id) {
          state.currentSessionId = null;
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
          if (typeof syncComposerControls === "function") syncComposerControls();
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
