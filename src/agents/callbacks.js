const { parseA2AMentions, getMaxA2ADepth } = require("./routing");
const transcript = require("../session/transcript");
const { ENV } = require("../shared/brand");

// Default token TTL: 30 minutes. Long enough for most invocations, short
// enough to prevent stale tokens from accumulating after the worklist exits.
// Override via SHIFT_TOKEN_TTL_MS (positive integer ms).
const DEFAULT_TOKEN_TTL_MS = 30 * 60 * 1000;

// Active chat threads that can receive MCP-style HTTP callbacks.
// Map<threadId, ThreadContext>
// ThreadContext = {
//   threadId,         // explicit binding (defense against drift, see lesson 08)
//   sessionId,        // chat session id (same as threadId in current data model)
//   res,              // active SSE response
//   worklist,         // shared string[] mutated by A2A loop and callbacks
//   controller,       // AbortController for the whole chain
//   a2aCount,         // number used as shared mutable counter
//   sessionsFile,     // path used to persist messages
//   tokens,           // Map<invocationId, { agentId, callbackToken, createdAt, expiresAt }>
// }
const activeThreads = new Map();

function generateToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function getTokenTtlMs() {
  const env = Number(process.env[ENV.TOKEN_TTL_MS]);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TOKEN_TTL_MS;
}

function sendSse(res, event, data) {
  if (!res || res.destroyed || res.writableEnded) return false;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  return true;
}

function registerThread(threadId, ctx) {
  // Stamp threadId on the context in place so callers that kept a reference
  // to ctx (mutating a2aCount, etc.) still see the changes. The Thread
  // Affinity guard in postMessage reads this field.
  ctx.threadId = threadId;
  activeThreads.set(threadId, ctx);
  return ctx;
}

function unregisterThread(threadId) {
  activeThreads.delete(threadId);
}

function getThread(threadId) {
  return activeThreads.get(threadId);
}

/**
 * Lazily remove expired tokens from a thread's token map.
 * Mutates thread.tokens in place. Safe to call on a thread with no tokens.
 * Tokens without an `expiresAt` field are treated as non-expiring (legacy
 * entries that predate TTL).
 */
function cleanExpiredTokens(thread) {
  if (!thread || !thread.tokens) return;
  const now = Date.now();
  for (const [id, record] of thread.tokens) {
    if (record && typeof record.expiresAt === "number" && record.expiresAt <= now) {
      thread.tokens.delete(id);
    }
  }
}

/**
 * Create an invocation identity for a single agent run within a thread.
 * Returns { invocationId, callbackToken, expiresAt } and records them for
 * later validation. The token expires after getTokenTtlMs(); validateToken()
 * will reject it after that.
 */
function createInvocation(threadId, agentId) {
  const thread = activeThreads.get(threadId);
  const invocationId = generateToken();
  const callbackToken = generateToken();
  const now = Date.now();
  const expiresAt = now + getTokenTtlMs();

  if (thread) {
    if (!thread.tokens) thread.tokens = new Map();
    thread.tokens.set(invocationId, {
      agentId,
      callbackToken,
      createdAt: now,
      expiresAt,
    });
  }

  return { invocationId, callbackToken, expiresAt };
}

function validateToken(threadId, invocationId, callbackToken) {
  const thread = activeThreads.get(threadId);
  if (!thread || !thread.tokens) return false;
  cleanExpiredTokens(thread);
  const record = thread.tokens.get(invocationId);
  if (!record) return false;
  if (typeof record.expiresAt === "number" && record.expiresAt <= Date.now()) {
    thread.tokens.delete(invocationId);
    return false;
  }
  return record.callbackToken === callbackToken;
}

/**
 * Post a message from a running agent back to the chat.
 * Enforces Thread Affinity: if the registered thread has an explicit
 * `threadId` field (set by registerThread), it must match the caller's
 * `threadId`, otherwise the message is rejected (returns false).
 *
 * The message is:
 *  - persisted to the session file
 *  - broadcast as an SSE message event
 *  - scanned for @mentions; any new target agents are appended to the worklist
 */
function postMessage(threadId, invocationId, content, { appendToSession, durableRecorder } = {}) {
  const thread = activeThreads.get(threadId);
  if (!thread) return false;

  // Thread Affinity guard: the registered thread's bound threadId must match
  // the caller's threadId. This catches the "跨 thread 污染" pattern where
  // an in-flight callback drifts to a different active thread.
  if (thread.threadId && thread.threadId !== threadId) return false;

  const record = thread.tokens && thread.tokens.get(invocationId);
  const agent = record ? record.agentId : "unknown";

  if (appendToSession && thread.sessionsFile) {
    appendToSession(
      thread.sessionsFile,
      thread.sessionId || threadId,
      {
        role: "assistant",
        agent,
        content,
        source: "callback",
        invocationId,
      },
      { allowCreate: false }
    );
  }

  // Record the mid-execution callback in the transcript under the originating
  // invocation. We look up the current invocation from the worklist head.
  // For simplicity we use a synthetic "_callback" suffix per callback; the
  // full thread is searchable via searchTranscript().
  const currentInvocationId = thread.currentInvocationId;
  if (currentInvocationId) {
    transcript.appendEvent(thread.sessionId || threadId, currentInvocationId, "callback-post", {
      agent,
      content,
    });
    durableRecorder?.appendInvocationEvent(currentInvocationId, "callback-post", {
      agent,
      content,
    });
  }

  sendSse(thread.res, "message", { agent, role: "assistant", text: content });

  const mentions = parseA2AMentions(content, agent);
  const maxDepth = getMaxA2ADepth();
  for (const target of mentions) {
    if (thread.controller && thread.controller.signal.aborted) break;
    if (thread.a2aCount >= maxDepth) {
      const skipText = `⏭ ${agent} → ${target}（已达 A2A 深度上限 ${maxDepth}，未入队）`;
      if (appendToSession && thread.sessionsFile) {
        appendToSession(
          thread.sessionsFile,
          thread.sessionId || threadId,
          {
            role: "system",
            agent: "system",
            content: skipText,
            kind: "a2a-skipped",
            from: agent,
            to: target,
            reason: "max_depth",
            maxDepth,
            source: "callback",
          },
          { allowCreate: false }
        );
      }
      sendSse(thread.res, "a2a-skipped", {
        from: agent,
        to: target,
        reason: "max_depth",
        maxDepth,
      });
      if (currentInvocationId) {
        transcript.appendEvent(thread.sessionId || threadId, currentInvocationId, "a2a-skipped", {
          from: agent,
          to: target,
          reason: "max_depth",
          maxDepth,
        });
        durableRecorder?.appendInvocationEvent(currentInvocationId, "a2a-skipped", {
          from: agent,
          to: target,
          reason: "max_depth",
          maxDepth,
        });
      }
      continue;
    }
    // Re-entry allowed (same agent may run again after a teammate, e.g. fix loop).
    thread.worklist.push(target);
    thread.a2aCount += 1;
    const reentry = thread.worklist.filter((id) => id === target).length > 1;
    const routeText = `🔄 ${agent} → ${target}`;
    if (appendToSession && thread.sessionsFile) {
      appendToSession(
        thread.sessionsFile,
        thread.sessionId || threadId,
        {
          role: "system",
          agent: "system",
          content: routeText,
          kind: "a2a-route",
          from: agent,
          to: target,
          source: "callback",
          reentry,
        },
        { allowCreate: false }
      );
    }
    sendSse(thread.res, "a2a-route", { from: agent, to: target, reentry });
    if (currentInvocationId) {
      transcript.appendEvent(thread.sessionId || threadId, currentInvocationId, "a2a-route", {
        from: agent,
        to: target,
        reentry,
      });
      durableRecorder?.appendInvocationEvent(currentInvocationId, "a2a-route", {
        from: agent,
        to: target,
        reentry,
      });
    }
  }

  return true;
}

/**
 * Build the HTTP callback instruction block that gets injected into agent prompts.
 * This teaches agents without native dynamic MCP support (Codex, opencode, etc.)
 * how to call back into the Shift server via curl.
 *
 * sessionId is the active chat thread id. It is injected both into the curl
 * examples and (by the server) as the SHIFT_THREAD_ID env var, so agents can
 * quote $SHIFT_THREAD_ID instead of hard-coding it.
 */
function buildCallbackInstructions(apiUrl, _sessionId) {
  // Curl examples intentionally use $SHIFT_THREAD_ID so agents do not hard-code ids.
  return `<!-- ═══════════════════════════════════════════════════════════ -->
<!-- MCP 回调工具说明（通过 HTTP 调用）                            -->
<!-- 你可以在执行过程中主动发消息、查阅历史，不需要等执行结束      -->
<!-- 环境变量已注入：                                              -->
<!--   $SHIFT_THREAD_ID        标识当前对话（不要伪造）          -->
<!--   $SHIFT_INVOCATION_ID    标识本次调用                      -->
<!--   $SHIFT_CALLBACK_TOKEN   本次调用的密码                    -->
<!-- ═══════════════════════════════════════════════════════════ -->

## 发送消息到聊天室

\`\`\`bash
curl -X POST ${apiUrl}/api/callbacks/post-message -H "Content-Type: application/json" -d "{\\"sessionId\\": \\"$SHIFT_THREAD_ID\\", \\"invocationId\\": \\"$SHIFT_INVOCATION_ID\\", \\"callbackToken\\": \\"$SHIFT_CALLBACK_TOKEN\\", \\"content\\": \\"你的消息\\"}"
\`\`\`

用法示例：
- 发现需要别人处理的问题 → 发消息/回复，行首 @ 对方（不要 spawn 子代理）
- 想主动汇报进度 → 直接发消息
- 需要更多上下文 → 发消息询问
- 想"回忆"之前做过的决策 → 用下面的 session-search / read-invocation

注意：
- @mention 必须单独出现在行首才会触发路由（例如 \`@Codex 请 review\`）
- 代码块内的 @mention 不会被路由
- 跨 Agent 协作只用行首 @mention；禁止使用 CLI 内嵌 subagent / Task / Agent / spawn_subagent
- 需要别人做事：另起一行写 @对方，并尽量附 \`\`\`handoff 块
- 不要 @ 自己
- \`sessionId\` 必须使用 \`$SHIFT_THREAD_ID\`，不要伪造
- callbackToken 有 TTL（默认 30 分钟），过期会 401

## 获取当前对话上下文

\`\`\`bash
curl -G ${apiUrl}/api/callbacks/thread-context -H "X-Callback-Token: $SHIFT_CALLBACK_TOKEN" --data-urlencode "sessionId=$SHIFT_THREAD_ID" --data-urlencode "invocationId=$SHIFT_INVOCATION_ID"
\`\`\`

## 列出本会话所有 invocation（谁跑了什么、什么状态）

\`\`\`bash
curl -G ${apiUrl}/api/callbacks/list-invocations -H "X-Callback-Token: $SHIFT_CALLBACK_TOKEN" --data-urlencode "sessionId=$SHIFT_THREAD_ID" --data-urlencode "invocationId=$SHIFT_INVOCATION_ID"
\`\`\`

返回：\`{ invocations: [{ invocationId, agent, startedAt, endedAt, state, eventCount }] }\`

## 搜索本会话所有 invocation 的历史（按关键词）

\`\`\`bash
curl -G ${apiUrl}/api/callbacks/session-search \\
  -H "X-Callback-Token: $SHIFT_CALLBACK_TOKEN" \\
  --data-urlencode "sessionId=$SHIFT_THREAD_ID" \\
  --data-urlencode "invocationId=$SHIFT_INVOCATION_ID" \\
  --data-urlencode "query=redis 端口" \\
  --data-urlencode "limit=10"
\`\`\`

返回：\`{ hits: [{ invocationId, eventNo, kind, ts, snippet, sourceKind, sourceId }] }\`。消息或记忆命中可能没有 invocationId，此时 snippet 即为可回忆内容。

## 读取某次 invocation 的完整事件流

\`\`\`bash
curl -G ${apiUrl}/api/callbacks/read-invocation \\
  -H "X-Callback-Token: $SHIFT_CALLBACK_TOKEN" \\
  --data-urlencode "sessionId=$SHIFT_THREAD_ID" \\
  --data-urlencode "invocationId=$SHIFT_INVOCATION_ID" \\
  --data-urlencode "targetInvocationId=<invocationId>" \\
  --data-urlencode "from=0" \\
  --data-urlencode "limit=200"
\`\`\`

返回：\`{ invocationId, events: [...], total, from, limit }\`

回忆工作流建议：
1. 不确定"之前为什么这样做" → \`session-search query="关键词"\`
2. 找到命中点 → \`read-invocation targetInvocationId=<id>\` 看完整记录
3. 不要凭印象猜 — 先查再说
`;
}

module.exports = {
  registerThread,
  unregisterThread,
  getThread,
  createInvocation,
  validateToken,
  postMessage,
  buildCallbackInstructions,
  sendSse,
};
