/**
 * Soft collaboration rules injected every turn (including A2A handoffs).
 *
 * Goal: steer agents away from CLI-native nested subagents (Task / Agent /
 * spawn_subagent) and toward platform-visible line-start @mentions.
 *
 * Soft only — no tool deny / kill. Cross-provider portable.
 */

const { AGENTS } = require("./catalog");

/**
 * @param {Record<string, { id?: string, label?: string, description?: string }>} agents
 * @returns {string}
 */
function buildRosterTable(agents) {
  const rows = [];
  for (const [id, config] of Object.entries(agents || {})) {
    if (!config || typeof config !== "object") continue;
    const label = String(config.label || id).trim() || id;
    const desc = String(config.description || "").trim() || "（无描述）";
    rows.push(`| @${label} | ${desc} |`);
  }
  if (rows.length === 0) {
    return "| （无可用队友） | — |";
  }
  return rows.join("\n");
}

/**
 * Render the collaboration-rules block for prompt injection.
 *
 * @param {string} currentAgentId
 * @param {Record<string, { id?: string, label?: string, description?: string }>} [agents]
 * @returns {string}
 */
function renderCollaborationRules(currentAgentId, agents = AGENTS) {
  const selfId = String(currentAgentId || "").trim();
  const selfConfig = agents && selfId ? agents[selfId] : null;
  const selfLabel = selfConfig?.label || selfId || "（当前）";
  const roster = buildRosterTable(agents);

  return `<!-- Collaboration Rules -->
## 协作铁律（平台纪律）

你是多 Agent 团队中的一员。跨 Agent 协作由**平台**调度，不是你在 CLI 内部黑盒派生子代理。

### 禁止
- 不要使用 CLI 内嵌的 subagent / Task / Agent / spawn_subagent / 探索或计划子代理
- 不要在后台黑盒派生子会话去做调研、review 或实现
- 这些路径在本平台不可见、不可路由、不可审计，视为绕路

### 正确做法
需要其他 Agent 时：在回复中**另起一行、行首**写 \`@队友\`，并尽量附标准 \`\`\`handoff 块。
- 句中 @、代码块内 @ **不会**触发路由
- 禁止 @ 自己（你是 ${selfLabel} / ${selfId || "unknown"}）

**正确示例：**

    方案已定，交给实现。

    \`\`\`handoff
    to: Grok
    what: 给登录按钮加 loading + disabled
    why: 防重复提交
    next_action: 改组件并补单测
    \`\`\`

    @Grok

**错误示例：**
- \`请 @Grok 帮忙实现\` ← 句中 @，不路由
- 使用 Task / spawn_subagent 开探索子代理 ← 隐式 subagent，禁止

### 传球三选一（本轮结束前必选其一）
1. **自己能做完** → 直接做完，不 @
2. **另一只 Agent 更合适** → 行首 @对方 + handoff
3. **只有用户能决策** → 问用户（不要假装 @ 不存在的 agent）

### 队友花名册
| 提及 | 职责 |
|------|------|
${roster}

<!-- /Collaboration Rules -->`;
}

module.exports = {
  renderCollaborationRules,
  buildRosterTable,
};
