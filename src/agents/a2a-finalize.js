const agentHandoff = require("./handoff");
const { parseA2AMentions, getMaxA2ADepth } = require("./routing");
const {
  decidePolicy,
  canEnqueue,
  buildRepairPayload,
  resolveHandoffPolicyMode,
  DECISIONS,
} = require("./handoff-policy");
const {
  buildFinalizeMetrics,
  logFinalizeMetrics,
} = require("./handoff-metrics");

/**
 * Unified A2A route finalization for chat turn-end and callback postMessage.
 * Owns: extract → evaluate → policy → capture → enqueue / repair / skip.
 *
 * @param {object} input
 * @returns {{
 *   mentions: string[],
 *   enqueued: object[],
 *   skipped: object[],
 *   repairs: object[],
 *   handoffByTarget: Record<string, object|null>,
 *   handoffQualityByTarget: Record<string, object>,
 *   mode: string,
 *   metrics: object|null,
 * }}
 */
function finalizeA2ARoutes(input = {}) {
  const text = typeof input.text === "string" ? input.text : "";
  const fromAgent = String(input.fromAgent || "unknown");
  const threadId = input.threadId;
  const invocationId = input.invocationId;
  const windowId = input.windowId || null;
  const useWorktree = Boolean(input.useWorktree);
  const worklist = Array.isArray(input.worklist) ? input.worklist : null;
  const maxDepth =
    Number.isFinite(Number(input.maxDepth)) && Number(input.maxDepth) > 0
      ? Math.floor(Number(input.maxDepth))
      : getMaxA2ADepth();
  const memoryCapture = input.memoryCapture || null;
  const transcript = input.transcript || null;
  const durableRecorder = input.durableRecorder || null;
  const sendSse = typeof input.sendSse === "function" ? input.sendSse : null;
  const appendToSession = typeof input.appendToSession === "function" ? input.appendToSession : null;
  const sessionsFile = input.sessionsFile;
  const sessionId = input.sessionId || threadId;
  const agentLabels = input.agentLabels || {};
  const source = input.source || "chat";
  const logger = input.logger || console;
  const aborted =
    input.controller && input.controller.signal && input.controller.signal.aborted
      ? true
      : false;

  let a2aCount = Number.isFinite(Number(input.a2aCount)) ? Number(input.a2aCount) : 0;
  const mode = input.policyMode || resolveHandoffPolicyMode();
  const mentionParser =
    typeof input.parseMentions === "function" ? input.parseMentions : parseA2AMentions;
  const mentions = mentionParser(text, fromAgent);

  /** @type {Record<string, object|null>} */
  const handoffByTarget = {};
  /** @type {Record<string, object>} */
  const handoffQualityByTarget = {};
  const enqueued = [];
  const skipped = [];
  const repairs = [];
  let capturedCount = 0;

  for (const target of mentions) {
    if (aborted) break;

    const fromLabel = agentLabels[fromAgent] || fromAgent;
    const toLabel = agentLabels[target] || target;
    const handoffMatch = agentHandoff.extractPrimaryHandoffMatch(text, {
      currentAgentId: fromAgent,
      routedTo: target,
      mentionCount: mentions.length,
    });
    const handoff = handoffMatch.handoff;
    const quality = agentHandoff.evaluateHandoff(handoff, {
      routedTo: target,
      toAgentId: target,
      fromAgentId: fromAgent,
      useWorktree,
      riskFlags: [
        ...(mentions.length > 1 ? ["multi_target"] : []),
        ...(useWorktree ? ["worktree"] : []),
      ],
    });
    const decision = decidePolicy({ quality, useWorktree, mode });
    quality.policy = decision;
    handoffByTarget[target] = handoff;
    handoffQualityByTarget[target] = quality;

    const summary = {
      ...agentHandoff.summarizeHandoff(handoff, quality),
      from: fromAgent,
      to: target,
      policy: decision,
      handoffPolicy: mode,
      source,
    };

    emitHandoffParsed({
      summary,
      threadId: sessionId,
      invocationId,
      transcript,
      sendSse,
    });

    // Memory capture: only when hasBlock (Wave M rules). Policy does not change capture.
    if (memoryCapture && typeof memoryCapture.captureHandoff === "function") {
      const capture = memoryCapture.captureHandoff({
        threadId: sessionId,
        invocationId,
        windowId,
        fromAgent,
        toAgent: target,
        handoff,
        quality,
        blockIndex: handoffMatch.blockIndex,
      });
      if (capture?.captured) {
        capturedCount += 1;
        if (sendSse && capture.event) {
          sendSse("memory-captured", capture.event);
        }
      }
    }

    if (a2aCount >= maxDepth) {
      const skip = {
        from: fromAgent,
        to: target,
        reason: "max_depth",
        maxDepth,
        policy: DECISIONS.REJECT,
      };
      skipped.push(skip);
      emitSkip({
        skip,
        fromLabel,
        toLabel,
        sessionId,
        sessionsFile,
        invocationId,
        transcript,
        durableRecorder,
        sendSse,
        appendToSession,
        source,
      });
      continue;
    }

    if (!canEnqueue(decision)) {
      const repair = buildRepairPayload({
        fromAgent,
        toAgent: target,
        quality,
        mode,
      });
      repairs.push(repair);
      emitRepair({
        repair,
        sessionId,
        sessionsFile,
        invocationId,
        transcript,
        durableRecorder,
        sendSse,
        appendToSession,
        source,
      });
      continue;
    }

    // Enqueue
    if (worklist) worklist.push(target);
    a2aCount += 1;
    const reentry = worklist ? worklist.filter((id) => id === target).length > 1 : false;
    const entry = {
      from: fromAgent,
      to: target,
      policy: decision,
      handoffOk: quality.ok,
      handoffDegraded: quality.degraded,
      emptyPacket: quality.emptyPacket,
      toMismatch: quality.toMismatch,
      reentry,
    };
    enqueued.push(entry);
    emitRoute({
      entry,
      fromLabel,
      toLabel,
      sessionId,
      sessionsFile,
      invocationId,
      transcript,
      durableRecorder,
      sendSse,
      appendToSession,
      source,
    });
  }

  if (typeof input.onA2ACount === "function") {
    input.onA2ACount(a2aCount);
  } else if (input.a2aState && typeof input.a2aState === "object") {
    input.a2aState.a2aCount = a2aCount;
  }

  const metrics = buildFinalizeMetrics({
    source,
    mode,
    threadId: sessionId,
    invocationId,
    mentions,
    enqueued,
    repairs,
    skipped,
    handoffQualityByTarget,
    capturedCount,
  });
  if (metrics) {
    logFinalizeMetrics(metrics, logger);
    if (sendSse) sendSse("handoff-metrics", metrics);
  }

  return {
    mentions,
    enqueued,
    skipped,
    repairs,
    handoffByTarget,
    handoffQualityByTarget,
    mode,
    a2aCount,
    metrics,
    capturedCount,
  };
}

function emitHandoffParsed({ summary, threadId, invocationId, transcript, sendSse }) {
  if (transcript && typeof transcript.appendEvent === "function" && threadId && invocationId) {
    transcript.appendEvent(threadId, invocationId, "handoff", summary);
  }
  if (sendSse) sendSse("handoff-parsed", summary);
}

function emitSkip({
  skip,
  fromLabel,
  toLabel,
  sessionId,
  sessionsFile,
  invocationId,
  transcript,
  durableRecorder,
  sendSse,
  appendToSession,
  source,
}) {
  const skipText = `⏭ ${fromLabel} → ${toLabel}（已达 A2A 深度上限 ${skip.maxDepth}，未入队）`;
  if (appendToSession && sessionsFile && sessionId) {
    appendToSession(
      sessionsFile,
      sessionId,
      {
        role: "system",
        agent: "system",
        content: skipText,
        kind: "a2a-skipped",
        from: skip.from,
        to: skip.to,
        reason: skip.reason,
        maxDepth: skip.maxDepth,
        source,
      },
      { allowCreate: false }
    );
  }
  if (sendSse) {
    sendSse("a2a-skipped", {
      from: skip.from,
      to: skip.to,
      reason: skip.reason,
      maxDepth: skip.maxDepth,
    });
  }
  if (transcript && sessionId && invocationId) {
    transcript.appendEvent(sessionId, invocationId, "a2a-skipped", {
      from: skip.from,
      to: skip.to,
      reason: skip.reason,
      maxDepth: skip.maxDepth,
    });
  }
  if (durableRecorder && invocationId) {
    durableRecorder.appendInvocationEvent?.(invocationId, "a2a-skipped", {
      from: skip.from,
      to: skip.to,
      reason: skip.reason,
      maxDepth: skip.maxDepth,
    });
  }
}

function emitRepair({
  repair,
  sessionId,
  sessionsFile,
  invocationId,
  transcript,
  durableRecorder,
  sendSse,
  appendToSession,
  source,
}) {
  if (appendToSession && sessionsFile && sessionId) {
    appendToSession(
      sessionsFile,
      sessionId,
      {
        role: "system",
        agent: "system",
        content: repair.message,
        kind: "handoff-repair-needed",
        from: repair.from,
        to: repair.to,
        reason: repair.reason,
        policy: repair.policy,
        source,
      },
      { allowCreate: false }
    );
  }
  if (sendSse) sendSse("handoff-repair-needed", repair);
  if (transcript && sessionId && invocationId) {
    transcript.appendEvent(sessionId, invocationId, "handoff-repair-needed", {
      from: repair.from,
      to: repair.to,
      reason: repair.reason,
      policy: repair.policy,
      missing: repair.missing,
      mode: repair.mode,
    });
  }
  if (durableRecorder && invocationId) {
    durableRecorder.appendInvocationEvent?.(invocationId, "handoff-repair-needed", {
      from: repair.from,
      to: repair.to,
      reason: repair.reason,
      policy: repair.policy,
    });
  }
}

function emitRoute({
  entry,
  fromLabel,
  toLabel,
  sessionId,
  sessionsFile,
  invocationId,
  transcript,
  durableRecorder,
  sendSse,
  appendToSession,
  source,
}) {
  const degraded =
    entry.policy === DECISIONS.ALLOW_DEGRADED || entry.handoffDegraded || entry.emptyPacket;
  const routeText = degraded
    ? `🔄 ${fromLabel} → ${toLabel}（交接包不完整 / ${entry.policy}）`
    : `🔄 ${fromLabel} → ${toLabel}`;
  if (appendToSession && sessionsFile && sessionId) {
    appendToSession(
      sessionsFile,
      sessionId,
      {
        role: "system",
        agent: "system",
        content: routeText,
        kind: "a2a-route",
        from: entry.from,
        to: entry.to,
        handoffOk: entry.handoffOk,
        handoffDegraded: entry.handoffDegraded,
        handoffPolicy: entry.policy,
        reentry: entry.reentry,
        source,
      },
      { allowCreate: false }
    );
  }
  if (sendSse) {
    sendSse("a2a-route", {
      from: entry.from,
      to: entry.to,
      handoffOk: entry.handoffOk,
      handoffDegraded: entry.handoffDegraded,
      handoffPolicy: entry.policy,
      reentry: entry.reentry,
    });
  }
  if (transcript && sessionId && invocationId) {
    transcript.appendEvent(sessionId, invocationId, "a2a-route", {
      from: entry.from,
      to: entry.to,
      handoffOk: entry.handoffOk,
      handoffDegraded: entry.handoffDegraded,
      handoffPolicy: entry.policy,
      reentry: entry.reentry,
    });
  }
  if (durableRecorder && invocationId) {
    durableRecorder.appendInvocationEvent?.(invocationId, "a2a-route", {
      from: entry.from,
      to: entry.to,
      handoffPolicy: entry.policy,
      reentry: entry.reentry,
    });
  }
}

module.exports = {
  finalizeA2ARoutes,
};
