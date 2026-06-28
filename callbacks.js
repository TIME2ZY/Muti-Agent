const { parseA2AMentions, getMaxA2ADepth } = require("./a2a-routing");

// Active chat threads that can receive MCP-style HTTP callbacks.
// Map<sessionId, ThreadContext>
// ThreadContext = {
//   res,              // active SSE response
//   worklist,         // shared string[] mutated by A2A loop and callbacks
//   controller,       // AbortController for the whole chain
//   a2aCount,         // number used as shared mutable counter
//   sessionsFile,     // path used to persist messages
//   tokens,           // Map<invocationId, { agentId, callbackToken }>
// }
const activeThreads = new Map();

function generateToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function sendSse(res, event, data) {
  if (!res || res.destroyed || res.writableEnded) return false;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  return true;
}

function registerThread(sessionId, ctx) {
  activeThreads.set(sessionId, ctx);
}

function unregisterThread(sessionId) {
  activeThreads.delete(sessionId);
}

function getThread(sessionId) {
  return activeThreads.get(sessionId);
}

/**
 * Create an invocation identity for a single agent run within a thread.
 * Returns { invocationId, callbackToken } and records them for later validation.
 */
function createInvocation(sessionId, agentId) {
  const thread = activeThreads.get(sessionId);
  const invocationId = generateToken();
  const callbackToken = generateToken();

  if (thread) {
    if (!thread.tokens) thread.tokens = new Map();
    thread.tokens.set(invocationId, { agentId, callbackToken, createdAt: Date.now() });
  }

  return { invocationId, callbackToken };
}

function validateToken(sessionId, invocationId, callbackToken) {
  const thread = activeThreads.get(sessionId);
  if (!thread || !thread.tokens) return false;
  const record = thread.tokens.get(invocationId);
  return !!record && record.callbackToken === callbackToken;
}

/**
 * Post a message from a running agent back to the chat.
 * The message is:
 *  - persisted to the session file
 *  - broadcast as an SSE message event
 *  - scanned for @mentions; any new target agents are appended to the worklist
 */
function postMessage(sessionId, invocationId, content, { appendToSession, readSessions } = {}) {
  const thread = activeThreads.get(sessionId);
  if (!thread) return false;

  const record = thread.tokens && thread.tokens.get(invocationId);
  const agent = record ? record.agentId : "unknown";

  if (appendToSession && thread.sessionsFile) {
    appendToSession(thread.sessionsFile, sessionId, {
      role: "assistant",
      agent,
      content,
      source: "callback",
    });
  }

  sendSse(thread.res, "message", { agent, role: "assistant", text: content });

  const mentions = parseA2AMentions(content, agent);
  const maxDepth = getMaxA2ADepth();
  for (const target of mentions) {
    if (thread.controller && thread.controller.signal.aborted) break;
    if (thread.a2aCount >= maxDepth) break;
    if (!thread.worklist.includes(target)) {
      thread.worklist.push(target);
      thread.a2aCount += 1;
      sendSse(thread.res, "a2a-route", { from: agent, to: target });
    }
  }

  return true;
}

/**
 * Build the HTTP callback instruction block that gets injected into agent prompts.
 * This teaches agents without native dynamic MCP support (Codex, opencode, etc.)
 * how to call back into the Cat Café server via curl.
 */
function buildCallbackInstructions(apiUrl) {
  return `<!-- ═══════════════════════════════════════════════════════════ -->
<!-- MCP 回调工具说明（通过 HTTP 调用）                            -->
<!-- 你可以在执行过程中主动发消息到聊天室，不需要等执行结束        -->
<!-- 环境变量已注入：$CAT_CAFE_INVOCATION_ID 和 $CAT_CAFE_CALLBACK_TOKEN -->
<!-- ═══════════════════════════════════════════════════════════ -->

## 发送消息到聊天室

\`\`\`bash
curl -X POST ${apiUrl}/api/callbacks/post-message -H "Content-Type: application/json" -d "{\\"invocationId\\": \\"$CAT_CAFE_INVOCATION_ID\\", \\"callbackToken\\": \\"$CAT_CAFE_CALLBACK_TOKEN\\", \\"content\\": \\"你的消息\\"}"
\`\`\`

用法示例：
- 发现需要别人处理的问题 → 发消息并 @ 对方
- 想主动汇报进度 → 直接发消息
- 需要更多上下文 → 发消息询问

注意：
- @mention 必须单独出现在行首才会触发路由（例如 \`@Codex 请 review\`）
- 代码块内的 @mention 不会被路由
- 不要 @ 自己

## 获取当前对话上下文

\`\`\`bash
curl -G ${apiUrl}/api/callbacks/thread-context -H "X-Callback-Token: $CAT_CAFE_CALLBACK_TOKEN" --data-urlencode "invocationId=$CAT_CAFE_INVOCATION_ID"
\`\`\`
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
