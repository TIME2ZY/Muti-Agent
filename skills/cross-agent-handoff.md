---
name: cross-agent-handoff
description: 交接必须写 WHY — 五件套强制检查
triggers:
  - "交给"
  - "handoff"
  - "接手"
  - "交接"
  - "帮我 review"
---

# 交接必须写 WHY

**针对的弱点**：AI 缺乏持久记忆 — 每次对话从零开始，接手方不知道为什么这样改。

## 核心规则

每次 Agent 间交接必须包含**五件套**：

| # | 项目 | 说明 | 为什么必须有 |
|---|------|------|-------------|
| 1 | **What** | 具体改了什么 | 接手方需要知道看什么 |
| 2 | **Why** | 为什么这样做 | **最重要**：没有 why = 无法判断对错 |
| 3 | **Tradeoff** | 放弃了什么方案 | 避免接手方重复调研 |
| 4 | **Open Questions** | 不确定的点 | 知道哪里需要特别关注 |
| 5 | **Next Action** | 希望对方做什么 | 明确期望，避免误解 |

## 检查流程

```
BEFORE 发送交接消息:
  1. CHECK: 是否包含所有五项？
  2. BLOCK: 如果缺少 Why，阻止发送并提示补齐
  3. PASS: 五项齐全才允许发送
```

## 为什么 WHY 最重要

因为 AI 没有上下文，只看 What 会导致：
- Review 时不知道这个改动是解决什么问题
- 可能提出与原始约束冲突的建议
- 无法判断 tradeoff 是否合理

没有 Why = 接手方无法判断 = 低效协作。

## Block 场景

```
❌ "@M-M 我改了三个文件，帮我看看"
   → BLOCK: 没有 What/Why/Tradeoff/Open Questions/Next Action
   → 提示: 请补充五件套信息
```

## 通过场景

```
✅ "What: 给用户模块加了 CAS 乐观锁
    Why: 高并发下出现数据覆写，需要防竞态
    Tradeoff: 放弃悲观锁方案，因为读多写少
    Open Questions: 锁重试次数是否需要可配置？
    Next Action: @M-M 请 review 锁的使用是否正确"
```