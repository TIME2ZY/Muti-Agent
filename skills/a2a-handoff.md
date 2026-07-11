---
name: a2a-handoff
description: Agent 之间通过 @mention 自动路由 — 何时 @、怎么 @、必须附带 handoff 块
triggers:
  - "@Codex"
  - "@万事通"
  - "@小谋"
  - "@小码"
  - "@小视"
  - "@小评"
  - "帮我 review"
  - "帮我写测试"
  - "帮我实现"
always: true
---

# Agent-to-Agent 路由规则

你是多 Agent 协作系统中的一个 Agent。需要其他 Agent 介入时，通过行首 `@AgentName` 路由，并**必须**附带标准 `handoff` 块。

## 当前 Agent 阵容

| Agent | id | 职责 | 何时 @ 它 |
|-------|----|----|-----------|
| **@Codex** | architect | 任务编排、架构设计、合入前最终检查 | 需要方案设计、任务拆分、合入前确认 |
| **@万事通** | orchestrator | 通才型兜底，跨领域杂活 | 需要通用脚本、跨模块辅助、兜底任务 |
| **@小谋** | planner | 推理与规划 | 需要任务拆解、方案设计、决策权衡 |
| **@小码** | coder | Coding 主力（服务端 / 通用） | 需要写后端代码、修 bug、重构、跑测试 |
| **@小视** | frontend | 前端 Coding 专家 | 需要写 UI、样式、交互、可访问性 |
| **@小评** | critic | Review 专家 | 代码写完了需要 review、修复后需要确认 |

> 路由既可以写 `@label`（中文名）也可以写 `@id`（英文 id），两者等价。

## 出口检查（发送前必须执行）

```
回复前问自己："到我这里结束了吗？"
```

- **如果还需要下一个 Agent 采取行动** → 行首 `@` + 完整 `handoff` 块
- **如果不需要别人行动** → 再问对方是否需要知道 / 是否影响对方；两个都否 → 不 @

## 格式要求（两段都要）

### 1) 行首 @mention（触发路由）

```
@小评
```

- 必须在**行首**（前面只能有空白）
- 代码块内的 `@` **不会**触发路由
- 不要 @ 自己

### 2) 标准 handoff 块（机器可读，必填）

在同一条回复中附上：

````markdown
```handoff
to: critic
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

| 字段 | 必填 | 说明 |
|------|------|------|
| `to` | 建议 | 目标 agent id 或 label |
| `goal` | 建议 | 一句话目标 |
| `what` | **是** | 做了什么 / 交给对方什么 |
| `why` | **是** | 为什么这样做（最重要） |
| `tradeoff` | 建议 | 放弃了什么方案 |
| `open_questions` | 建议 | 未决问题列表 |
| `next_action` | **是** | 希望对方具体做什么 |
| `files` | 可选 | 相关路径 |
| `evidence` | 可选 | 测试 / 日志 / 结论 |

没有 `handoff` 块仍可能被路由，但接手方会收到 **degraded** 警告，协作质量显著下降。

## 完整示例

```
登录后端已实现，请接手 review。

@小评

```handoff
to: critic
what: 实现 POST /api/login + JWT
why: 多实例部署不能用内存 session
tradeoff: 暂不做 refresh token
next_action: 审查哈希与 JWT 声明安全性
files:
  - src/server/auth.js
```
```

## 禁止行为

- ❌ 只写 `@小评` 不写 handoff / 上下文
- ❌ 在代码示例里依赖 `@` 触发路由
- ❌ 句子中间的 `@小评`（必须行首）
- ❌ 连续 @ 多个 Agent 做同一件事（选一个最合适的）
