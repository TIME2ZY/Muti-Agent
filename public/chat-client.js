(function initChatClient(globalScope) {
  "use strict";

  function createChatClient(deps) {
    const {
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
      fetchImpl,
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
    } = deps;

    function store() {
      return runtimeStore || state.runtimeStore;
    }

    function isActiveSession(sessionId) {
      return !state.currentSessionId || state.currentSessionId === sessionId;
    }

    function notifyStatus(sessionId) {
      if (typeof onRuntimeStatusChange === "function") onRuntimeStatusChange(sessionId);
    }

    function syncComposer(sessionId) {
      if (typeof syncComposerControls === "function" && isActiveSession(sessionId)) {
        syncComposerControls();
      }
    }

    function parseSse(buffer, onEvent) {
      let rest = String(buffer || "").replace(/\r\n/g, "\n");
      let idx;
      while ((idx = rest.indexOf("\n\n")) !== -1) {
        const frame = rest.slice(0, idx);
        rest = rest.slice(idx + 2);
        const lines = frame.split("\n");
        const eventLine = lines.find((line) => line.startsWith("event: "));
        const dataLines = lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6));
        if (!eventLine || dataLines.length === 0) continue;
        onEvent(eventLine.slice(7), JSON.parse(dataLines.join("\n")));
      }
      return rest;
    }

    function handleSseEvent(event, data, ctx = {}) {
      const sessionId = (ctx && ctx.sessionId) || state.currentSessionId || "_pending";
      const rt = store().getOrCreate(sessionId);
      const active = isActiveSession(sessionId);

      switch (event) {
        case "session": {
          const nextId = data && data.sessionId ? data.sessionId : "";
          if (nextId && nextId !== sessionId) {
            store().rekey(sessionId, nextId);
            if (ctx) ctx.sessionId = nextId;
          }
          const boundId = (ctx && ctx.sessionId) || nextId || sessionId;
          if (active || !state.currentSessionId) {
            state.currentSessionId = boundId;
            sessionController.loadSessions();
            loadProjectDir(boundId);
            loadWorktreeStatus();
            if (state.rightPanelTab === "workspace") {
              loadWorkspaceState();
            }
          } else if (typeof sessionController.refreshSessionList === "function") {
            sessionController.refreshSessionList();
          }
          break;
        }
        case "skills-active":
          if (active) renderSkillTags(data.skills);
          break;
        case "agent-start":
          if (data.invocationId) rt.liveInvocations.set(data.agent, data.invocationId);
          showThinking(data.agent, sessionId);
          break;
        case "agent-event":
          rt.hasStructuredEvents = true;
          applyAgentEvent(data, sessionId);
          break;
        case "message":
          if (rt.hasStructuredEvents) break;
          appendLive(data.agent, data.text, sessionId);
          break;
        case "stderr":
          if (active) addDebug(data.agent, data.text);
          break;
        case "error":
          rt.status = "error";
          rt.lastError = data.message || "error";
          notifyStatus(sessionId);
          if (active) addSystem(data.message, "error");
          break;
        case "context-warning":
          if (active) setStatus("上下文接近上限");
          break;
        case "sealed":
          finishStream("上下文已封存", sessionId);
          if (active) addSystem("context overflow: 已停止继续路由");
          break;
        case "agent-exit":
          if (data.code !== 0) {
            const item = rt.liveMessages.get(data.agent);
            if (item && item.setBadge) item.setBadge("error");
            rt.status = "error";
            notifyStatus(sessionId);
            if (active) {
              addSystem(`${agentLabel(data.agent)} exited with ${data.code ?? data.signal}`, "error");
            }
          }
          break;
        case "a2a-route":
          if (active) addSystem(`🔄 ${agentLabel(data.from)} → ${agentLabel(data.to)}`);
          break;
        case "done":
          finishStream("就绪", sessionId);
          break;
      }
    }

    async function sendPrompt() {
      const prompt = promptEl.value.trim();
      if (!prompt) return;

      const activeRt = store().getOrCreate(state.currentSessionId || "_pending");
      if (activeRt.controller) return;

      const resolved = resolvePromptAgent(prompt);
      const targetAgent = resolved && resolved.agent ? resolved.agent : resolved;
      if (!targetAgent || !targetAgent.id) {
        addSystem("没有可用的 Agent，请先加载模型列表", "error");
        setStatus("无可用模型", "error");
        promptEl.focus();
        return;
      }

      if (!state.currentSessionId) {
        try {
          const session = await sessionApi.createSession();
          state.currentSessionId = session.id;
        } catch (error) {
          addSystem(error.message, "error");
          return;
        }
      }

      const sid = state.currentSessionId;
      if (!state.sessions) state.sessions = {};
      if (!state.sessions[sid]) state.sessions[sid] = { lastPrompt: "", lastAgent: "architect" };
      state.sessions[sid].lastPrompt = prompt;
      state.sessions[sid].lastAgent = targetAgent.id;
      state.lastPrompt = prompt;
      state.lastAgent = targetAgent.id;
      state.selectedAgent = targetAgent.id;

      const controller = new AbortController();
      const rt = store().beginRun(sid, controller);
      const streamCtx = { sessionId: sid };

      createMessage({ role: "user", agent: targetAgent.id, content: prompt });
      promptEl.value = "";
      hideMentionMenu();
      notifyStatus(sid);
      syncComposer(sid);

      try {
        const res = await fetchImpl("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: targetAgent.id,
            prompt,
            sessionId: sid,
            projectDir: state.projectDir || undefined,
            useWorktree: useWorktreeInput.checked,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          store().endRun(sid, { controller, status: "error", error: err.error || res.statusText });
          notifyStatus(sid);
          if (isActiveSession(sid)) {
            addSystem(err.error || `${res.status} ${res.statusText}`, "error");
            setStatus("错误", "error");
          }
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          buf = parseSse(buf, (event, data) => handleSseEvent(event, data, streamCtx));
        }
      } catch (error) {
        flushPendingLiveRender(sid);
        if (error.name === "AbortError") {
          store().endRun(sid, { controller, status: "idle", aborted: true });
          if (isActiveSession(sid)) {
            setStatus("已停止");
            addSystem("已停止", "error");
          }
        } else {
          store().endRun(sid, { controller, status: "error", error: error.message || "连接中断" });
          if (isActiveSession(sid)) {
            setStatus("错误", "error");
            addSystem(error.message || "连接中断", "error");
          }
        }
        for (const [, item] of rt.liveMessages) {
          if (item.setBadge) item.setBadge("done");
          if (item.bubble) item.bubble.innerHTML = renderMd(item.rawText || "");
        }
        notifyStatus(sid);
      } finally {
        const current = store().get(sid);
        const stillOwnController = current && current.controller === controller;
        if (stillOwnController) {
          if (!current.doneReceived && !controller.signal.aborted) {
            store().endRun(sid, { controller, status: "error", error: "连接意外中断" });
            if (isActiveSession(sid)) {
              setStatus("错误", "error");
              addSystem("连接意外中断", "error");
            }
          } else if (controller.signal.aborted) {
            store().endRun(sid, { controller, status: "idle", aborted: true });
          } else {
            store().endRun(sid, {
              controller,
              status: current.status === "error" ? "error" : "done",
            });
          }
          notifyStatus(sid);
        }
        syncComposer(sid);
      }
    }

    return {
      parseSse,
      handleSseEvent,
      sendPrompt,
    };
  }

  const api = { createChatClient };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.ChatClient = api;
})(typeof window !== "undefined" ? window : globalThis);
