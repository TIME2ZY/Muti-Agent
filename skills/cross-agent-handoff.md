---
name: cross-agent-handoff
description: 交接必须写 WHY — 标准 handoff 五件套（机器可读）
triggers:
  - "交给"
  - "handoff"
  - "接手"
  - "交接"
  - "帮我 review"
---

# 交接必须写 WHY

**针对的弱点**：AI 缺乏持久记忆 — 每次对话从零开始，接手方不知道为什么这样改。

平台会解析 ` ```handoff ` 块；缺字段会标记 degraded，但不阻断路由。

## 核心规则：五件套

| # | 字段 | 说明 | 为什么必须有 |
|---|------|------|-------------|
| 1 | **what** | 具体改了什么 / 交什么 | 接手方知道看什么 |
| 2 | **why** | 为什么这样做 | **最重要**：没有 why = 无法判断对错 |
| 3 | **tradeoff** | 放弃了什么方案 | 避免接手方重复调研 |
| 4 | **open_questions** | 不确定的点 | 知道哪里需要特别关注 |
| 5 | **next_action** | 希望对方做什么 | 明确期望，避免误解 |

另建议写：`to`、`goal`、`files`、`evidence`。

## 机器格式（与平台解析器一致）

````markdown
```handoff
to: opencode
goal: review CAS 乐观锁
what: 给用户模块加了 CAS 乐观锁
why: 高并发下出现数据覆写，需要防竞态
tradeoff: 放弃悲观锁方案，因为读多写少
open_questions:
  - 锁重试次数是否需要可配置？
next_action: 请 review 锁的使用是否正确
files:
  - src/user/repo.js
```
````

## 检查流程

```
BEFORE 发送交接消息:
  1. 行首 @目标Agent
  2. CHECK: handoff 是否包含 what / why / next_action？
  3. BLOCK（自检）: 如果缺少 why，补齐后再发
  4. PASS: 五项齐全（至少必填三项）才发送
```

## 为什么 WHY 最重要

只看 What 会导致：

- Review 时不知道改动要解决什么问题
- 提出与原始约束冲突的建议
- 无法判断 tradeoff 是否合理

没有 Why = 接手方无法判断 = 低效协作。

## 反例 / 正例

```
❌ "@OpenCode 我改了三个文件，帮我看看"
   → 无 handoff 块、无 Why

✅ 行首 @OpenCode + handoff 含 what/why/next_action
```
