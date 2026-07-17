const { assertValidOpaqueId } = require("./id-policy");
const { resolveResumeSessionId, abandonProviderSession } = require("./session-map-store");
const {
  createStreamDeltaCoalescer,
  resolveCoalesceOptionsFromEnv,
} = require("./stream-delta-coalescer");
const { ENV } = require("../shared/brand");
const { renderCollaborationRules } = require("../agents/collaboration-rules");

const NOOP_DURABLE_RECORDER = Object.freeze({
  ensureWindow: () => null,
  sealWindow: () => null,
  sealAndRotateWindow: () => null,
  startInvocation: () => null,
  appendInvocationEvent: () => false,
  finishInvocation: () => null,
  bindProviderSession: () => false,
  addWindowUsage: () => false,
});

const NOOP_MEMORY_CAPTURE = Object.freeze({
  captureHandoff: () => ({ captured: false }),
  captureWindowSeal: () => ({ captured: false }),
  replayThread: async () => ({ replayed: 0, existing: 0, failed: 0, available: false }),
});

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
  recallService,
  memoryService,
  agentIdentity,
  agentHandoff,
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
  getSession,
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
  durableRecorder,
  memoryCapture,
}) {
  const durable = durableRecorder || NOOP_DURABLE_RECORDER;
  const memories = memoryCapture || NOOP_MEMORY_CAPTURE;
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

    const requestedAgent = typeof body.agent === "string" ? body.agent : "codex";
    const rawPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const useWorktree = body.useWorktree === true;
    let sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null;

    if (!AGENTS[requestedAgent]) {
      sendJson(res, 400, { error: `Unsupported agent "${requestedAgent}".` });
      return true;
    }
    if (!rawPrompt) {
      sendJson(res, 400, { error: "Prompt is required." });
      return true;
    }

    let session;
    if (!sessionId) {
      session = createSession(options.sessionsFile || undefined);
      sessionId = session.id;
    } else {
      try {
        assertValidOpaqueId(sessionId, "sessionId");
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
      session = getSession(options.sessionsFile || undefined, sessionId);
      if (!session) {
        sendJson(res, 404, { error: "Session not found." });
        return true;
      }
    }
    if (typeof body.projectDir === "string" && body.projectDir.trim()) {
      let resolvedProjectDir;
      try {
        resolvedProjectDir = validateProjectDir(body.projectDir);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
      session = setSessionProjectDir(
        options.sessionsFile || undefined,
        sessionId,
        resolvedProjectDir
      );
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

    if (
      useWorktree &&
      sessionWorktree &&
      !sessionWorktree.previewPid &&
      !process.env[ENV.PREVIEW]
    ) {
      let targetGitRoot = null;
      try {
        targetGitRoot = worktreeManagerModule.ensureGitRoot(sessionProjectDir);
      } catch {
        targetGitRoot = null;
      }
      if (targetGitRoot && targetGitRoot === selfGitRoot) {
        try {
          sessionWorktree = await worktreeManager.startPreview(sessionId);
          session = setSessionWorktree(
            options.sessionsFile || undefined,
            sessionId,
            sessionWorktree
          );
        } catch (error) {
          console.warn("Preview server failed to start:", error.message);
        }
      }
    }

    const activeWorktree = useWorktree ? sessionWorktree : null;
    const runWorkspace = activeWorktree || {
      sessionId,
      baseDir: sessionProjectDir,
      worktreeDir: sessionProjectDir,
      branch: "",
    };
    const workspaceKey = `${activeWorktree ? "worktree" : "base"}:${runWorkspace.worktreeDir}`;
    const requestedAgentConfig = AGENTS[requestedAgent];
    const requestedProviderId = requestedAgentConfig.providerId || "";
    const requestedProviderKey =
      requestedProviderId && requestedAgentConfig.model
        ? `${requestedProviderId}:${requestedAgentConfig.model}`
        : requestedProviderId;
    const initialWindow = durable.ensureWindow({
      session,
      threadId: sessionId,
      agentId: requestedAgent,
      providerKey: requestedProviderKey,
      workspaceKey,
      capacityTokens: contextHealth.getAgentCapacity(requestedAgent),
    });
    await memories.replayThread(sessionId);

    const existing = activeInvocations.get(sessionId);
    if (existing) existing.abort();
    const invocationController = new AbortController();
    activeInvocations.set(sessionId, invocationController);

    const { augmentedPrompt, skillNames } = augmentPrompt(rawPrompt, useWorktree);
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const apiUrl = process.env[ENV.API_URL] || `${protocol}://${req.headers.host}`;
    const callbackInstructions = callbacks.buildCallbackInstructions(apiUrl, sessionId);
    const worklist = [requestedAgent];
    const maxDepth = getMaxA2ADepth();

    appendToSession(
      options.sessionsFile || undefined,
      sessionId,
      {
        role: "user",
        agent: requestedAgent,
        content: rawPrompt,
        augmentedPrompt,
        activeSkills: skillNames,
      },
      { allowCreate: false, windowId: initialWindow?.id }
    );
    transcript.appendEvent(sessionId, "_user_prompt", "user-prompt", {
      agent: requestedAgent,
      content: rawPrompt,
      activeSkills: skillNames,
    });

    // Session bootstrap (coords + digest + recall) is built once for the first turn.
    // Agent persona identity is re-rendered every turn so A2A handoffs still know "who I am".
    // Wave R: Memory Card uses retrieveForTurn(recency + related) when recallService supports it.
    const bootstrapPacket = await sessionBootstrap.buildBootstrapPacket({
      threadId: sessionId,
      sessionId,
      agent: AGENTS[requestedAgent],
      generation: initialWindow?.generation || 1,
      prompt: rawPrompt,
      invocationSource: recallService || transcript,
      retrieveSource: recallService || null,
      memorySource: memoryService || null,
    });

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
    const threadCtx = {
      sessionId,
      res,
      worklist,
      controller: invocationController,
      a2aCount: 0,
      sessionsFile: options.sessionsFile,
      tokens: new Map(),
      currentInvocationId: null,
      windowId: null,
      sealer: null,
    };
    callbacks.registerThread(sessionId, threadCtx);

    try {
      for (let i = 0; i < worklist.length && threadCtx.a2aCount < maxDepth; i++) {
        if (invocationController.signal.aborted || res.destroyed || res.writableEnded) {
          aborted = true;
          break;
        }
        const agent = worklist[i];
        const agentConfig = AGENTS[agent] || { id: agent, label: agent, description: "" };
        const sessionMap = readSessionMap(sessionId, sessionMapRoot);
        const providerId = agentConfig.providerId || "";
        const providerKey =
          providerId && agentConfig.model ? `${providerId}:${agentConfig.model}` : providerId;
        const resumeSessionId = resolveResumeSessionId(
          sessionMap,
          agent,
          workspaceKey,
          providerKey
        );
        let assistantContent = "";
        let contextWarned = false;
        let contextSealedSseSent = false;
        let contextSealHandled = false;

        const { invocationId, callbackToken } = callbacks.createInvocation(sessionId, agent);
        const startedAt = new Date().toISOString();
        invocationEvents.set(invocationId, {
          invocationId,
          sessionId,
          agent,
          startedAt,
          endedAt: null,
          state: "active",
          events: [
            {
              ts: startedAt,
              kind: "invocation-start",
              payload: { agent, resumeSessionId: resumeSessionId || null },
            },
          ],
        });
        const durableRun = durable.startInvocation({
          session,
          invocationId,
          threadId: sessionId,
          agentId: agent,
          providerKey,
          workspaceKey,
          capacityTokens: contextHealth.getAgentCapacity(agent),
          resumeSessionId,
          startedAt,
        });
        const healthTracker = contextHealth.makeTracker(agent, {
          capacityTokens: durableRun?.window?.capacityTokens,
          inputChars: durableRun?.window?.inputChars,
          outputChars: durableRun?.window?.outputChars,
        });
        const sealer = sessionSealer.makeSealer();
        threadCtx.sealer = sealer;
        sendSse(res, "agent-start", { agent, invocationId });

        let agentPrompt;
        /** @type {string[]} */
        let turnSkillNames = skillNames;
        if (i === 0) {
          agentPrompt = rawPrompt;
        } else {
          const prev = a2aHistory[a2aHistory.length - 1];
          const prevLabel = AGENTS[prev.agent]?.label || prev.agent;
          // Prefer structured handoff for this target; soft-degrade if missing.
          const handoff =
            prev.handoffByTarget && prev.handoffByTarget[agent]
              ? prev.handoffByTarget[agent]
              : prev.handoff || null;
          const quality =
            prev.handoffQualityByTarget && prev.handoffQualityByTarget[agent]
              ? prev.handoffQualityByTarget[agent]
              : prev.handoffQuality || agentHandoff.evaluateHandoff(handoff);
          const handoffTask = agentHandoff.renderHandoffTask({
            handoff,
            quality,
            fromAgent: prev.agent,
            fromLabel: prevLabel,
            toAgentId: agent,
            toLabel: agentConfig.label || agent,
            fromContent: prev.content,
            userPrompt: rawPrompt,
          });
          // A2A: compact handoff card (not full always-on a2a-handoff body) +
          // optional receiving-review when an implementer is fixing after review.
          const a2aSkillNames = [];
          if (
            agentHandoff.shouldInjectReceivingReview({
              targetAgentId: agent,
              fromAgentId: prev.agent,
              handoff,
              text: handoffTask,
            })
          ) {
            a2aSkillNames.push("receiving-review");
          }
          const a2aSkills = augmentPrompt(handoffTask, useWorktree, {
            skillNames: a2aSkillNames,
          });
          const compactCard = agentHandoff.renderA2AHandoffCard();
          const a2aMemoryCard = await sessionBootstrap.buildActiveMemoryCard({
            threadId: sessionId,
            prompt: [rawPrompt, handoffTask].filter(Boolean).join("\n"),
            retrieveSource: recallService || null,
            memorySource: memoryService || null,
            budgetChars: sessionBootstrap.resolveA2AMemoryBudget
              ? sessionBootstrap.resolveA2AMemoryBudget()
              : undefined,
          });
          agentPrompt = [compactCard, a2aMemoryCard, a2aSkills.augmentedPrompt]
            .filter(Boolean)
            .join("\n\n");
          turnSkillNames = ["a2a-handoff-card", ...a2aSkills.skillNames];
        }

        // Prompt layout (top → bottom):
        //   1. Agent identity (every turn, including A2A)
        //   2. Collaboration rules (every turn: soft ban nested subagents)
        //   3. Session bootstrap (first turn only: coords + digest + recall)
        //   4. Light session header on later turns (correct agent label)
        //   5. Task body (user/skills or compact card + handoff [+ receiving-review])
        //   6. Callback instructions
        const identityBlock = agentIdentity.renderIdentityBlock(agent, agentConfig);
        const collaborationBlock = renderCollaborationRules(agent, AGENTS);
        const promptParts = [identityBlock, collaborationBlock];
        if (i === 0) {
          promptParts.push(bootstrapPacket, augmentedPrompt);
        } else {
          promptParts.push(
            sessionBootstrap.buildIdentity({
              threadId: sessionId,
              sessionId,
              agent: agentConfig,
              generation: durableRun?.window?.generation || 1,
            }),
            agentPrompt
          );
          if (turnSkillNames.length > 0) {
            sendSse(res, "skills-active", { skills: turnSkillNames, agent, a2a: true });
          }
        }
        promptParts.push(callbackInstructions);
        const promptForAgent = promptParts.filter(Boolean).join("\n\n");
        healthTracker.addInput(promptForAgent.length);
        threadCtx.currentInvocationId = invocationId;
        threadCtx.windowId = durableRun?.window?.id || null;
        const invocationEnv = {
          [ENV.API_URL]: apiUrl,
          [ENV.THREAD_ID]: sessionId,
          [ENV.INVOCATION_ID]: invocationId,
          [ENV.CALLBACK_TOKEN]: callbackToken,
          [ENV.WORKTREE]: activeWorktree ? "1" : "0",
          [ENV.BASE_DIR]: runWorkspace.baseDir,
          [ENV.WORKTREE_DIR]: runWorkspace.worktreeDir,
          [ENV.BRANCH]: runWorkspace.branch || "",
          INVOKE_SESSION_ID: resumeSessionId,
          INVOKE_SESSION_FILE: getSessionMapPath(sessionId, sessionMapRoot),
          INVOKE_WORKSPACE_KEY: workspaceKey,
        };

        transcript.appendEvent(sessionId, invocationId, "invocation-start", {
          agent,
          resumeSessionId: resumeSessionId || null,
          promptBytes: promptForAgent.length,
          fillRatioAtStart: healthTracker.getFillRatio(),
        });

        // Live SSE stays fine-grained; only durable sinks (transcript / registry /
        // SQLite+recall) go through the coalescer so recall and logs are not
        // flooded with micro text.delta / thinking.delta fragments.
        const persistDurableEvent = (kind, payload) => {
          transcript.appendEvent(sessionId, invocationId, kind, payload);
          recordInvocationEvent(invocationEvents, invocationId, kind, payload);
          durable.appendInvocationEvent(invocationId, kind, payload);
        };
        const durableCoalescer = createStreamDeltaCoalescer({
          ...resolveCoalesceOptionsFromEnv(),
          write: persistDurableEvent,
        });
        const sealContextWindow = (ratio) => {
          if (contextSealHandled) return;
          contextSealHandled = true;
          durableCoalescer.flushAll();
          if (durableRun?.window?.id) {
            const contextRotated = Boolean(
              durable.sealAndRotateWindow({
                session,
                threadId: sessionId,
                agentId: agent,
                providerKey,
                workspaceKey,
                capacityTokens: durableRun.window.capacityTokens,
                windowId: durableRun.window.id,
                reason: "context overflow",
              })
            );
            if (!contextRotated) {
              durable.sealWindow(durableRun.window.id, "context overflow");
            }
          }
          const capture = memories.captureWindowSeal({
            threadId: sessionId,
            invocationId,
            windowId: durableRun?.window?.id || null,
            agentId: agent,
            generation: durableRun?.window?.generation || null,
            ratio,
            reason: "context overflow",
            assistantContent,
            invocationState: "sealed",
          });
          if (capture?.captured) {
            sendSse(res, "memory-captured", capture.event);
          }
          abandonProviderSession(sessionId, sessionMapRoot, agent, workspaceKey);
        };

        const { code, signal } = await runChildStream({
          spawnRunner,
          args: buildChatArgs(agent, agentPrompt, promptForAgent),
          res,
          cwd: runWorkspace.worktreeDir,
          killGraceMs: options.killGraceMs,
          timeoutMs: options.timeoutMs,
          signal: invocationController.signal,
          env: invocationEnv,
          onEvent(event) {
            // Realtime path first — UI should not wait on durable batching.
            sendSse(res, "agent-event", event);
            if (event.type === "text.delta") {
              const text = typeof event.text === "string" ? event.text : "";
              assistantContent += text;
              sendSse(res, "message", { agent, role: "assistant", text });
            }
            durableCoalescer.accept(event);
          },
          onStderr(text) {
            durableCoalescer.flushAll();
            persistDurableEvent("stderr", { agent, text });
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
              sealContextWindow(ratio);
            }
          },
          shouldStop: () => sealer.isSealed(),
        });

        // Always drain residual deltas before end markers / finishInvocation.
        durableCoalescer.flushAll();

        if (durableRun) {
          durable.addWindowUsage(durableRun.window.id, {
            inputChars: promptForAgent.length,
            outputChars: assistantContent.length,
          });
        }
        if (sealer.isSealed()) {
          sealContextWindow(healthTracker.getFillRatio());
        } else if (durableRun) {
          const updatedSessionMap = readSessionMap(sessionId, sessionMapRoot);
          const persistedProviderSessionId = resolveResumeSessionId(
            updatedSessionMap,
            agent,
            workspaceKey,
            providerKey
          );
          durable.bindProviderSession(durableRun.window.id, persistedProviderSessionId);
        }

        finalizeInvocationEvent(invocationEvents, invocationId, code, signal);
        persistInvocations();
        durable.finishInvocation(invocationId, code, signal);

        if (invocationController.signal.aborted || res.destroyed || res.writableEnded) {
          aborted = true;
          break;
        }

        appendToSession(
          options.sessionsFile || undefined,
          sessionId,
          {
            role: "assistant",
            agent,
            content: assistantContent,
            exitCode: code,
            signal,
            invocationId,
          },
          { allowCreate: false, windowId: durableRun?.window.id }
        );
        transcript.appendEvent(sessionId, invocationId, "invocation-end", {
          agent,
          code,
          signal,
          contentBytes: assistantContent.length,
          fillRatioAtEnd: healthTracker.getFillRatio(),
          sealerState: sealer.getState(),
        });
        sendSse(res, "agent-exit", { agent, code, signal, invocationId });

        // Parse structured handoff once per turn (soft — never blocks routing).
        const primaryHandoff = agentHandoff.extractPrimaryHandoff(assistantContent, {
          currentAgentId: agent,
        });
        const primaryQuality = agentHandoff.evaluateHandoff(primaryHandoff);
        const handoffByTarget = Object.create(null);
        const handoffQualityByTarget = Object.create(null);

        a2aHistory.push({
          agent,
          content: assistantContent,
          handoff: primaryHandoff,
          handoffQuality: primaryQuality,
          handoffByTarget,
          handoffQualityByTarget,
        });

        if (sealer.isSealed()) {
          aborted = true;
          break;
        }

        // Parse mentions every turn. Allow the same agent to re-enter the
        // worklist (review → fix → re-review). Depth is the only hard cap.
        const mentions = parseA2AMentions(assistantContent, agent);
        for (const m of mentions) {
          const handoffMatch = agentHandoff.extractPrimaryHandoffMatch(assistantContent, {
            currentAgentId: agent,
            routedTo: m,
            mentionCount: mentions.length,
          });
          const targetHandoff = handoffMatch.handoff;
          const targetQuality = agentHandoff.evaluateHandoff(targetHandoff, {
            routedTo: m,
            toAgentId: m,
            fromAgentId: agent,
            useWorktree: Boolean(useWorktree),
            riskFlags: mentions.length > 1 ? ["multi_target"] : [],
          });
          handoffByTarget[m] = targetHandoff;
          handoffQualityByTarget[m] = targetQuality;

          const summary = agentHandoff.summarizeHandoff(targetHandoff, targetQuality);

          // Route target `m` wins over handoff.to (which may be missing/mismatched).
          transcript.appendEvent(sessionId, invocationId, "handoff", {
            ...summary,
            from: agent,
            to: m,
          });
          sendSse(res, "handoff-parsed", {
            ...summary,
            from: agent,
            to: m,
          });

          const fromLabel = AGENTS[agent]?.label || agent;
          const toLabel = AGENTS[m]?.label || m;

          // Capture before routing decisions: max_depth soft-skips enqueue only.
          const capture = memories.captureHandoff({
            threadId: sessionId,
            invocationId,
            windowId: durableRun?.window?.id || null,
            fromAgent: agent,
            toAgent: m,
            handoff: targetHandoff,
            quality: targetQuality,
            blockIndex: handoffMatch.blockIndex,
          });
          if (capture?.captured) {
            sendSse(res, "memory-captured", capture.event);
          }

          if (threadCtx.a2aCount >= maxDepth) {
            const skipText = `⏭ ${fromLabel} → ${toLabel}（已达 A2A 深度上限 ${maxDepth}，未入队）`;
            appendToSession(
              options.sessionsFile || undefined,
              sessionId,
              {
                role: "system",
                agent: "system",
                content: skipText,
                kind: "a2a-skipped",
                from: agent,
                to: m,
                reason: "max_depth",
                maxDepth,
              },
              { allowCreate: false }
            );
            sendSse(res, "a2a-skipped", {
              from: agent,
              to: m,
              reason: "max_depth",
              maxDepth,
            });
            transcript.appendEvent(sessionId, invocationId, "a2a-skipped", {
              from: agent,
              to: m,
              reason: "max_depth",
              maxDepth,
            });
            continue;
          }

          // Re-entry allowed: push even if `m` already ran earlier in this request.
          worklist.push(m);
          threadCtx.a2aCount += 1;
          const routeText = targetQuality.degraded
            ? `🔄 ${fromLabel} → ${toLabel}（交接包不完整）`
            : `🔄 ${fromLabel} → ${toLabel}`;
          // Persist so session switch / reload keeps the handoff marker.
          appendToSession(
            options.sessionsFile || undefined,
            sessionId,
            {
              role: "system",
              agent: "system",
              content: routeText,
              kind: "a2a-route",
              from: agent,
              to: m,
              handoffOk: targetQuality.ok,
              handoffDegraded: targetQuality.degraded,
              reentry: worklist.filter((id) => id === m).length > 1,
            },
            { allowCreate: false }
          );
          sendSse(res, "a2a-route", {
            from: agent,
            to: m,
            handoffOk: targetQuality.ok,
            handoffDegraded: targetQuality.degraded,
            reentry: worklist.filter((id) => id === m).length > 1,
          });
          transcript.appendEvent(sessionId, invocationId, "a2a-route", {
            from: agent,
            to: m,
            handoffOk: targetQuality.ok,
            handoffDegraded: targetQuality.degraded,
            reentry: worklist.filter((id) => id === m).length > 1,
          });
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
    threadCtx.windowId = null;
    if (!aborted) {
      sendSse(res, "done", {});
    }
    res.end();
    return true;
  };
}

module.exports = {
  createChatRoutes,
  resolveResumeSessionId,
};
