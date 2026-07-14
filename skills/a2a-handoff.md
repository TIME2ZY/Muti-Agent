---
name: a2a-handoff
description: Agent 之间通过 @mention 自动路由 — 何时 @、怎么 @、必须附带 handoff 块
triggers:
  - "@Codex"
  - "@Gemini"
  - "@Grok"
  - "@OpenCode"
  - "帮我 review"
  - "帮我写测试"
  - "帮我实现"
always: true
---

# Agent-to-Agent 路由规则

你是多 Agent 协作系统中的一个 Agent。需要其他 Agent 介入时，通过行首 `@AgentName` 路由，并**必须**附带标准 `handoff` 块。

## 当前 Agent 阵容

| Agent | id | 职责 | 何时 @ 它 |
|-------|----|------|-----------|
| **@Codex** | codex | 推理与讨论、方案权衡、与 Gemini 交叉验证 | 想清楚问题、要方案、要收敛 |
| **@Gemini** | gemini | 想法发散、头脑风暴 | 要新鲜角度、多方案灵感 |
| **@Grok** | grok | 写代码、改功能、跑测试 | 要落地实现 |
| **@OpenCode** | opencode | 代码评审与放行 | 实现完成或修复后确认 |

> 路由写 `@名字` 或 `@id` 均可（现已对齐）。

推荐链路：

> `@Gemini` 发散 → `@Codex` 收敛/互证 → `@Grok` 实现 → `@OpenCode` review →（可选）`@Codex` 合入确认

## 出口检查（发送前必须执行）

```
回复前问自己："到我这里结束了吗？"
```

- **如果还需要下一个 Agent 采取行动** → 行首 `@` + 完整 `handoff` 块
- **如果不需要别人行动** → 再问对方是否需要知道 / 是否影响对方；两个都否 → 不 @

## 格式要求（两段都要）

### 1) 行首 @mention（触发路由）

```
@OpenCode
```

- 必须在**行首**（前面只能有空白）
- 代码块内的 `@` **不会**触发路由
- 不要 @ 自己

### 2) 标准 handoff 块（机器可读，必填）

在同一条回复中附上：

````markdown
```handoff
to: opencode
goal: 请 review 登录 API 的鉴权与错误处理
what: 新增 POST /api/login，JWT 签发，bcrypt 哈希
why: 需求要求无状态鉴权；现有 session 方案与多实例部署冲突
tradeoff: 放弃服务端 session；短期不做 refresh token
open_questions:
  - token TTL 是否应对齐产品 7 天要求
next_action: 审查密码哈希、JWT 声明与错误码是否安全一致
files:
  - src/server/auth.js
  - tests/auth.test.js
evidence:
  - npm test -- tests/auth.test.js 通过
```
````
