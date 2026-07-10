(function initChatClient(globalScope) {
  "use strict";

  function createChatClient(deps) {
    const {
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
    } = deps;

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

    function handleSseEvent(event, data) {
      switch (event) {
        case "session":
          state.currentSessionId = data.sessionId;
          sessionController.loadSessions();
          loadProjectDir(data.sessionId);
          loadWorktreeStatus();
          if (state.rightPanelTab === "workspace") {
            loadWorkspaceState();
          }
          break;
        case "skills-active":
          renderSkillTags(data.skills);
          break;
        case "agent-start":
          if (data.invocationId) state.liveInvocations.set(data.agent, data.invocationId);
          showThinking(data.agent);
          break;
        case "agent-event":
          state.hasStructuredEvents = true;
          applyAgentEvent(data);
          break;
        case "message":
          if (state.hasStructuredEvents) break;
          appendLive(data.agent, data.text);
          break;
        case "stderr":
          addDebug(data.agent, data.text);
          break;
        case "error":
          addSystem(data.message, "error");
          break;
        case "context-warning":
          setStatus("上下文接近上限");
          break;
        case "sealed":
          finishStream("上下文已封存");
          addSystem("context overflow: 已停止继续路由");
          break;
        case "agent-exit":
          if (data.code !== 0) {
            const item = state.liveMessages.get(data.agent);
            if (item) item.setBadge("error");
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

      if (!state.currentSessionId) {
        try {
          const session = await sessionApi.createSession();
          state.currentSessionId = session.id;
        } catch (error) {
          addSystem(error.message, "error");
          return;
        }
      }

      // Per-session retry slot. Mutates the shared state object directly so
      // the retry button (in app.js) can read the same per-session record.
      const sid = state.currentSessionId || "_pending";
      if (!state.sessions) state.sessions = {};
      if (!state.sessions[sid]) state.sessions[sid] = { lastPrompt: "", lastAgent: "architect" };
      state.sessions[sid].lastPrompt = prompt;
      state.sessions[sid].lastAgent = targetAgent.id;
      // Legacy fields (kept for any other reader; mirror the active session).
      state.lastPrompt = prompt;
      state.lastAgent = targetAgent.id;
      state.selectedAgent = targetAgent.id;
      state.doneReceived = false;
      state.hasStructuredEvents = false;
      state.liveMessages.clear();
      state.liveInvocations.clear();
      if (state.liveRuns) state.liveRuns.clear();

      createMessage({ role: "user", agent: targetAgent.id, content: prompt });
      promptEl.value = "";
      hideMentionMenu();

      state.controller = new AbortController();
      promptEl.disabled = true;
      btnSend.textContent = "停止";
      btnSend.classList.add("danger");

      try {
        const res = await fetchImpl("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: targetAgent.id,
            prompt,
            sessionId: state.currentSessionId,
            projectDir: state.projectDir || undefined,
            useWorktree: useWorktreeInput.checked,
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
      } catch (error) {
        flushPendingLiveRender();
        if (error.name === "AbortError") {
          setStatus("已停止");
          addSystem("已停止", "error");
        } else {
          setStatus("错误", "error");
          addSystem(error.message || "连接中断", "error");
        }
        for (const [, item] of state.liveMessages) {
          item.setBadge("done");
          item.bubble.innerHTML = renderMd(item.rawText || "");
        }
      } finally {
        if (!state.doneReceived && !(state.controller && state.controller.signal.aborted)) {
          setStatus("错误", "error");
          addSystem("连接意外中断", "error");
        }
        state.controller = null;
        promptEl.disabled = false;
        btnSend.textContent = "发送";
        btnSend.classList.remove("danger");
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
