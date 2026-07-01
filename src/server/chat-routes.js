function createChatRoutes({
  rootDir,
  selfGitRoot,
  sessionMapRoot,
  invocationEvents,
  options,
  AGENTS,
  callbacks,
  transcript,
  contextHealth,
  sessionSealer,
  sessionBootstrap,
  worktreeManager,
  worktreeManagerModule,
  activeInvocations,
  sendJson,
  sendSse,
  readJsonBody,
  buildInvokeArgs,
  buildChatArgs,
  augmentPrompt,
  getMaxA2ADepth,
  parseA2AMentions,
  filterBenignStderr,
  runChildStream,
  spawnRunner,
  ensureSession,
  createSession,
  setSessionProjectDir,
  validateProjectDir,
  setSessionWorktree,
  appendToSession,
  getSessionMapPath,
  readSessionMap,
  recordInvocationEvent,
  finalizeInvocationEvent,
  persistInvocations,
}) {
  return async function handleChatRoutes(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/invoke") {
      let args;
      try {
        const body = await readJsonBody(req);
        const rawPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        const { augmentedPrompt } = augmentPrompt(rawPrompt);
        args = buildInvokeArgs(body, augmentedPrompt);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });

      runChildStream({
        spawnRunner,
        args,
        res,
        cwd: rootDir,
        killGraceMs: options.killGraceMs,
        onStdout(text) {
          sendSse(res, "stdout", { text });
        },
        onStderr(text) {
          sendSse(res, "stderr", { text });
        },
      }).then(({ code, signal }) => {
        sendSse(res, "exit", { code, signal });
        res.end();
      });

      return true;
    }

    if (req.method !== "POST" || url.pathname !== "/api/chat") {
      return false;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return true;
    }

    const requestedAgent = typeof body.agent === "string" ? body.agent : "architect";
    const rawPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const useWorktree = body.useWorktree === true;
    let sessionId = typeof body.sessionId === "string" ? body.sessionId : null;

    if (!AGENTS[requestedAgent]) {
      sendJson(res, 400, { error: `Unsupported agent "${requestedAgent}".` });
      return true;
    }
    if (!rawPrompt) {
      sendJson(res, 400, { error: "Prompt is required." });
      return true;
    }

    if (!sessionId) {
      sessionId = createSession(options.sessionsFile || undefined).id;
    }

    let session = ensureSession(options.sessionsFile || undefined, sessionId);
    if (typeof body.projectDir === "string" && body.projectDir.trim()) {
      let resolvedProjectDir;
      try {
        resolvedProjectDir = validateProjectDir(body.projectDir);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
      session = setSessionProjectDir(options.sessionsFile || undefined, sessionId, resolvedProjectDir);
    }
    const sessionProjectDir = session && session.projectDir ? session.projectDir : rootDir;

    let sessionWorktree = session.worktree;
    if (useWorktree && !sessionWorktree) {
      try {
        sessionWorktree = worktreeManager.ensureWorktree({ baseDir: sessionProjectDir, sessionId });
        session = setSessionWorktree(options.sessionsFile || undefined, sessionId, sessionWorktree);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
    }

    if (useWorktree && sessionWorktree && !sessionWorktree.previewPid && !process.env.CAT_CAFE_PREVIEW) {
      let targetGitRoot = null;
      try { targetGitRoot = worktreeManagerModule.ensureGitRoot(sessionProjectDir); }
      catch { targetGitRoot = null; }
      if (targetGitRoot && targetGitRoot === selfGitRoot) {
        try {
          sessionWorktree = await worktreeManager.startPreview(sessionId);
          session = setSessionWorktree(options.sessionsFile || undefined, sessionId, sessionWorktree);
        } catch (error) {
          console.warn("Preview server failed to start:", error.message);
        }
      }
    }

    const runWorkspace = sessionWorktree || {
      sessionId,
      baseDir: sessionProjectDir,
      worktreeDir: sessionProjectDir,
      branch: "",
    };

    const existing = activeInvocations.get(sessionId);
    if (existing) existing.abort();
    const invocationController = new AbortController();
    activeInvocations.set(sessionId, invocationController);

    const { augmentedPrompt, skillNames } = augmentPrompt(rawPrompt, useWorktree);
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const apiUrl = process.env.CAT_CAFE_API_URL || `${protocol}://${req.headers.host}`;
    const callbackInstructions = callbacks.buildCallbackInstructions(apiUrl, sessionId);
    const worklist = [requestedAgent];
    const maxDepth = getMaxA2ADepth();

    appendToSession(options.sessionsFile || undefined, sessionId, {
      role: "user",
      agent: requestedAgent,
      content: rawPrompt,
      augmentedPrompt,
      activeSkills: skillNames,
    }, { allowCreate: false });
    transcript.appendEvent(sessionId, "_user_prompt", "user-prompt", {
      agent: requestedAgent,
      content: rawPrompt,
      activeSkills: skillNames,
    });

    const bootstrapPacket = await sessionBootstrap.buildBootstrapPacket({
      threadId: sessionId,
      sessionId,
      agent: AGENTS[requestedAgent],
    });
    const augmentedPromptWithBootstrap = bootstrapPacket + "\n" + augmentedPrompt;

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.once("close", () => {
      invocationController.abort();
    });
    sendSse(res, "session", { sessionId });
    sendSse(res, "skills-active", { skills: skillNames });

    const a2aHistory = [];
    let aborted = false;
    const healthTracker = contextHealth.makeTracker(requestedAgent);
    const sealer = sessionSealer.makeSealer();
    const threadCtx = {
      sessionId,
      res,
      worklist,
      controller: invocationController,
      a2aCount: 0,
      sessionsFile: options.sessionsFile,
      tokens: new Map(),
      currentInvocationId: null,
      sealer,
    };
    callbacks.registerThread(sessionId, threadCtx);

    try {
      for (let i = 0; i < worklist.length && threadCtx.a2aCount < maxDepth; i++) {
        if (invocationController.signal.aborted || res.destroyed || res.writableEnded) {
          aborted = true;
          break;
        }
        if (sealer.isSealed()) {
          sendSse(res, "sealed", { reason: "context overflow", ratio: healthTracker.getFillRatio() });
          aborted = true;
          break;
        }

        const agent = worklist[i];
        const sessionMap = readSessionMap(sessionId, sessionMapRoot);
        const resumeSessionId = sessionMap[agent]?.sessionId || "";
        let assistantContent = "";
        let contextWarned = false;
        let contextSealedSseSent = false;

        const { invocationId, callbackToken } = callbacks.createInvocation(sessionId, agent);
        invocationEvents.set(invocationId, {
          invocationId,
          sessionId,
          agent,
          startedAt: new Date().toISOString(),
          endedAt: null,
          state: "active",
          events: [
            {
              ts: new Date().toISOString(),
              kind: "invocation-start",
              payload: { agent, resumeSessionId: resumeSessionId || null },
            },
          ],
        });
        sendSse(res, "agent-start", { agent, invocationId });

        let agentPrompt;
        if (i === 0) {
          agentPrompt = rawPrompt;
        } else {
          const prev = a2aHistory[a2aHistory.length - 1];
          const prevLabel = AGENTS[prev.agent]?.label || prev.agent;
          const prevBlock = prev.content.slice(-4000);
          agentPrompt = [
            `[任务交接：由 ${prevLabel} 转交给你]`,
            "",
            `=== ${prevLabel} 的完整分析 ===`,
            prevBlock,
            "",
            "=== 用户原始请求 ===",
            rawPrompt,
            "",
            "请根据上述上下文继续执行任务。",
          ].join("\n");
        }

        const promptForAgent = (i === 0 ? augmentedPromptWithBootstrap : agentPrompt) + "\n\n" + callbackInstructions;
        healthTracker.addInput(promptForAgent.length);
        threadCtx.currentInvocationId = invocationId;
        const invocationEnv = {
          CAT_CAFE_API_URL: apiUrl,
          CAT_CAFE_THREAD_ID: sessionId,
          CAT_CAFE_INVOCATION_ID: invocationId,
          CAT_CAFE_CALLBACK_TOKEN: callbackToken,
          CAT_CAFE_WORKTREE: sessionWorktree ? "1" : "0",
          CAT_CAFE_BASE_DIR: runWorkspace.baseDir,
          CAT_CAFE_WORKTREE_DIR: runWorkspace.worktreeDir,
          CAT_CAFE_BRANCH: runWorkspace.branch || "",
          INVOKE_SESSION_ID: resumeSessionId,
          INVOKE_SESSION_FILE: getSessionMapPath(sessionId, sessionMapRoot),
        };

        transcript.appendEvent(sessionId, invocationId, "invocation-start", {
          agent,
          resumeSessionId: resumeSessionId || null,
          promptBytes: promptForAgent.length,
          fillRatioAtStart: healthTracker.getFillRatio(),
        });

        const { code, signal } = await runChildStream({
          spawnRunner,
          args: buildChatArgs(agent, agentPrompt, promptForAgent),
          res,
          cwd: runWorkspace.worktreeDir,
          killGraceMs: options.killGraceMs,
          timeoutMs: options.timeoutMs,
          signal: invocationController.signal,
          env: invocationEnv,
          onStdout(text) {
            assistantContent += text;
            transcript.appendEvent(sessionId, invocationId, "stdout", { agent, text });
            recordInvocationEvent(invocationEvents, invocationId, "stdout", { text });
            sendSse(res, "message", { agent, role: "assistant", text });
          },
          onStderr(text) {
            transcript.appendEvent(sessionId, invocationId, "stderr", { agent, text });
            recordInvocationEvent(invocationEvents, invocationId, "stderr", { text });
            const visible = filterBenignStderr(text);
            if (visible) sendSse(res, "stderr", { agent, text: visible });
          },
          onHealth(charCount) {
            healthTracker.addOutput(charCount);
            const ratio = healthTracker.getFillRatio();
            const state = sealer.update(ratio);
            if (state === sessionSealer.STATE.SEALING && !contextWarned) {
              sendSse(res, "context-warning", { agent, ratio, threshold: sealer.thresholds.warn });
              contextWarned = true;
            } else if (state === sessionSealer.STATE.SEALED && !contextSealedSseSent) {
              sendSse(res, "sealed", { agent, ratio, reason: "context overflow" });
              contextSealedSseSent = true;
            }
          },
          shouldStop: () => sealer.isSealed(),
        });

        finalizeInvocationEvent(invocationEvents, invocationId, code, signal);
        persistInvocations();

        if (invocationController.signal.aborted || res.destroyed || res.writableEnded) {
          aborted = true;
          break;
        }

        appendToSession(options.sessionsFile || undefined, sessionId, {
          role: "assistant",
          agent,
          content: assistantContent,
          exitCode: code,
          signal,
          invocationId,
        }, { allowCreate: false });
        transcript.appendEvent(sessionId, invocationId, "invocation-end", {
          agent,
          code,
          signal,
          contentBytes: assistantContent.length,
          fillRatioAtEnd: healthTracker.getFillRatio(),
          sealerState: sealer.getState(),
        });
        sendSse(res, "agent-exit", { agent, code, signal, invocationId });
        a2aHistory.push({ agent, content: assistantContent });

        if (sealer.isSealed()) {
          aborted = true;
          break;
        }

        if (threadCtx.a2aCount < maxDepth) {
          const mentions = parseA2AMentions(assistantContent, agent);
          for (const m of mentions) {
            if (!worklist.includes(m)) {
              worklist.push(m);
              threadCtx.a2aCount += 1;
              sendSse(res, "a2a-route", { from: agent, to: m });
              transcript.appendEvent(sessionId, invocationId, "a2a-route", {
                from: agent,
                to: m,
              });
            }
          }
        }
      }
    } finally {
      if (activeInvocations.get(sessionId) === invocationController) {
        activeInvocations.delete(sessionId);
      }
      if (callbacks.getThread(sessionId) === threadCtx) {
        callbacks.unregisterThread(sessionId);
      }
    }

    await transcript.flush();
    threadCtx.currentInvocationId = null;
    if (!aborted) {
      sendSse(res, "done", {});
    }
    res.end();
    return true;
  };
}

module.exports = {
  createChatRoutes,
};
