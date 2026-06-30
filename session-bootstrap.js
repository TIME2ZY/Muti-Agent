const transcript = require("./transcript");

// Recall rule injected into the first agent's prompt of each session. Modeled
// after cat-cafe-tutorials lesson 08 "Session Chain" — the goal is to prevent
// the "濒死猫写不好遗书" failure mode by teaching the new cat to search before
// guessing.
const RECALL_RULE = `<!-- ═══════════════════════════════════════════════════════════ -->
<!-- 回忆铁律 (Recall Rule)                                         -->
<!-- 当你不确定"之前做了什么、为什么那样做、某个文件/决策从哪来"时： -->
<!--   1. 先用 session-search 搜（curl 模板见下方回调说明）            -->
<!--   2. 找到命中点后用 read-invocation 看详细记录                    -->
<!--   3. 不要凭印象猜 — 先查再说                                      -->
<!-- 新 session 默认不知道上个 session 发生了什么。                  -->
<!-- 如果不查就猜，多半会错。                                          -->
<!-- ═══════════════════════════════════════════════════════════ -->`;

function buildIdentity({ threadId, sessionId, agent, generation = 1 }) {
  const agentName = (agent && (agent.label || agent.id)) || String(agent || "unknown");
  return [
    `<!-- Session Identity -->`,
    `Thread: ${threadId}`,
    `Session: ${sessionId}`,
    `Generation: ${generation}`,
    `Agent: ${agentName}`,
    ``,
  ].join("\n");
}

async function buildDigest({ threadId, sessionId }) {
  const invocations = await transcript.listInvocationsWithMeta(sessionId);
  if (invocations.length === 0) {
    return [
      `<!-- Digest -->`,
      `这是这个 thread 的第一个 invocation。尚无历史记录可回忆。`,
      `如果需要之前 chat 的信息，问用户，或建议开新 thread。`,
      ``,
    ].join("\n");
  }
  const lines = [
    `<!-- Digest (${invocations.length} invocations in this session so far) -->`,
    `本 session 已有以下 invocation：`,
    ``,
  ];
  for (const inv of invocations) {
    const dur = (inv.startedAt && inv.endedAt)
      ? `duration=${new Date(inv.endedAt) - new Date(inv.startedAt)}ms`
      : "in-flight";
    lines.push(`- ${inv.invocationId} | ${inv.agent} | started=${inv.startedAt || "?"} | state=${inv.state || "in-flight"} | events=${inv.eventCount} | ${dur}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function buildBootstrapPacket(opts) {
  const { threadId, sessionId, agent, generation = 1 } = opts;
  if (!threadId) throw new Error("threadId is required");
  if (!sessionId) throw new Error("sessionId is required");
  if (!agent) throw new Error("agent is required");
  const identity = buildIdentity({ threadId, sessionId, agent, generation });
  const digest = await buildDigest({ threadId, sessionId });
  return [identity, digest, RECALL_RULE, ""].join("\n");
}

module.exports = {
  buildBootstrapPacket,
  buildIdentity,
  buildDigest,
  RECALL_RULE,
};
