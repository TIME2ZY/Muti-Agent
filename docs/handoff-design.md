# A2A 交接设计（Handoff Design）

| 字段 | 值 |
|------|-----|
| 状态 | Draft · **已与对齐总览同步** |
| 日期 | 2026-07-16 |
| 对齐权威 | **[design-alignment.md](./design-alignment.md)** |
| 相关文档 | [memory-system-design.md](./memory-system-design.md) · [memory-retrieval-design.md](./memory-retrieval-design.md) |
| 范围 | **Wave H**：协议增强、policy、Receive Bundle、多目标、回调统一 |
| 前置依赖 | Wave M（capture API）+ Wave R（`retrieveForTurn` / Memory Card） |
| 代码改动 | **仅文档，不实施** |

---

## 1. 现状：已经能用，但「假交接」成本很高

### 1.1 现有链路

```text
Agent 输出
  │
  ├─ parseA2AMentions：去 code fence 后，行首 @id|@label → 最多 2 个目标
  │     （路由的唯一硬开关）
  │
  └─ extractPrimaryHandoff / evaluateHandoff
        │  ```handoff 解析 + 软评分
        ▼
  soft：无论 handoff 是否完整，一律 worklist.push(target)
        │
        ▼
  下一 Agent prompt =
        identity
      + collaboration rules
      + light session header（无 full digest/memory）
      + renderA2AHandoffCard（精简模板提醒）
      + renderHandoffTask（结构化字段 或 degraded 附录截断）
      + 条件 receiving-review skill
      + callback instructions
```

关键实现：

| 模块 | 路径 | 现状评价 |
|------|------|----------|
| 解析 / 评分 / 渲染 | `src/agents/handoff.js` | **最成熟**：字段解析、degraded、appendix anchor、摘要 SSE |
| 路由 | `src/agents/routing.js` | 行首 @、去 fence、防自 @、每轮最多 2 目标、depth 上限 |
| 编排 | `src/server/chat-routes.js` | soft 永不拦路由；route 胜于 `to`；re-entry 允许 |
| 纪律注入 | `collaboration-rules.js` + skills | 每轮软提示 + always-on a2a-handoff；A2A 改用 compact card |
| 落库 | transcript `handoff` 事件 + SSE | **无** `memory_entries`；无一等 handoff 记录表 |

### 1.2 问题清单（按危害）

| # | 问题 | 表现 | 根因 |
|---|------|------|------|
| H1 | **路由与交接包解耦过狠** | 只写 `@Grok` 无 fence 也进队 | soft-only 产品选择，缺分场景策略 |
| H2 | **degraded 仍像正常接力** | 下一棒吃 8KB 原文附录，噪声大、要点丢 | `renderDegradedHandoff` 把全文当 payload |
| H3 | **A2A 后继无 thread 记忆/digest** | 只靠 handoff 正文 + 截断附录 | bootstrap 仅首棒；与记忆系统断裂 |
| H4 | **交接是一次性 prompt，不是资产** | 再往后一轮 / seal 后要点蒸发 | 不写 memory；无 handoff 实体持久化 |
| H5 | **`to` 与 @ 不一致只打标** | `toMismatch` 记日志，不纠正、不提示接收方 | 路由以 @ 为准，接收侧未必知情 |
| H6 | **多 block / 多目标配对弱** | 取 last 或 matched `to`；多 @ 共用劣质块 | 缺「每目标一份 handoff」强约束与校验 |
| H7 | **协议只有一种「出站包」** | review 结论硬塞 what；无类型区分 | 无 `intent` / profile，全员同一模板 |
| H8 | **附录截断可能砍掉 P0** | 虽有 anchor，仍可能 5k 窗口外 | 依赖字符串启发式，非结构化优先 |
| H9 | **破坏性场景无加严** | worktree 改代码链路与纯讨论同 soft | 缺 policy by risk |
| H10 | **提示重复、互相打架** | collaboration + skill + A2A card + handoff task 多层 | 注入叠床架屋，占预算 |
| H11 | **回调 mid-flight @ 与主循环双路径** | `postMessage` 也能入队 | 两套路径的 handoff 解析/落库一致性弱 |
| H12 | **无闭环质量信号** | 只有 degraded 文案，无重试/补全请求 | soft 到底，无「请补 handoff」协议 |

**一句话：**

> 解析器是 B+，编排策略是「能转就转」；  
> 缺的是 **分风险门禁、接收侧上下文包、持久化与记忆晋升、多目标配对与可观测闭环**。

---

## 2. 目标与非目标

### 2.1 目标

1. **交接 = 一等对象**：可解析、可评分、可路由、可注入、可落库、可晋升为 memory。  
2. **路由仍以行首 @ 为触发**（保持可发现、与 skill 一致），但 **接收侧上下文以 structured handoff 为主**。  
3. **分策略 soft / balanced / strict**，不搞一刀切 hard-block 全站。  
4. **接收包标准化**：下一棒拿到的是「任务卡 + 记忆卡 + 可控附录」，不是随机长文。  
5. **与记忆系统对齐**：合格 handoff → `memory_entries(kind=handoff)`；degraded 有明确处置。  
6. **可观测**：SSE/transcript 能看出 ok / degraded / mismatch / skipped 原因。  
7. **提示精简**：A2A 路径减少重复 skill 正文。

### 2.2 非目标（本设计第一阶段）

- 重写 @ 路由为 JSON-RPC / MCP 工具调用（可远期）
- 强制全站「无 handoff 不许 @」（讨论场景会伤体验）
- 改变 agent catalog 或 CLI provider
- 用 LLM 二次改写 handoff（可选增强，非默认依赖）
- 多 agent 并行 fan-out 编排（仍保持串行 worklist；每轮最多 2 @ 可保留）

### 2.3 验收标准

| ID | 标准 |
|----|------|
| G1 | 有完整 fence 的 A2A：接收 prompt 含 Structured Handoff，且 `交接包完整度: ok` |
| G2 | 无 fence 仅有 @：行为符合 **policy**（见 §5）；至少接收侧有 degraded 标记 + 补全指引 |
| G3 | `to`≠@目标：接收侧 prompt **显式**写清「路由目标以 @ 为准」 |
| G4 | `SHIFT_HANDOFF_POLICY=balanced` 且 worktree 时：无 fence → **`request_repair`（不入队）**；`soft` 档可回滚为 degraded 放行 |
| G5 | 合格 handoff 写入 memory — **由 Wave M 实现**；本波次回归锁定（finalize 复用同一 capture） |
| G6 | A2A 含 compact memory — **由 Wave R 实现**；本波次 Receive Bundle **槽位**正式化 |
| G7 | 讨论场景（无 worktree）在 balanced 下为 `allow_degraded`，不无故打断 |
| G8 | 单测：多 block 选主、多目标配对、policy 矩阵、渲染契约 |

---

## 3. 概念模型

### 3.1 三个角色分离

```text
┌─────────────┐     emit      ┌──────────────┐     route      ┌─────────────┐
│  Sender     │ ───────────► │  Handoff     │ ─────────────► │  Receiver   │
│  Agent 输出 │  @ + fence     │  Record      │  worklist      │  任务上下文  │
└─────────────┘              └──────┬───────┘                └─────────────┘
                                    │
                                    ▼ persist / promote
                             transcript + memory
```

| 概念 | 定义 |
|------|------|
| **Route Intent** | 行首 `@Target`：要不要叫人、叫谁（平台路由输入） |
| **Handoff Packet** | ````handoff` 结构化包：交给对方什么（接收上下文主源） |
| **Handoff Record** | 平台规范化后的对象：解析结果 + quality + policy 决策 + ids |
| **Receive Bundle** | 实际注入下一棒的 prompt 片段集合 |

**铁律：** Route 决定 **谁跑**；Packet 决定 **跑什么**。二者缺一时应按 policy 处理，而不是静默假装都有。

### 3.2 Handoff Record（平台内部）

```ts
type HandoffRecord = {
  id: string;                    // 新：稳定 id，便于 memory/SSE
  threadId: string;
  invocationId: string;
  fromAgentId: string;
  toAgentId: string;             // 以路由 @ 为准（不是 handoff.to 原文）
  packet: HandoffPacket | null;  // 解析结果；无 fence 则为 null
  quality: HandoffQuality;       // 扩展见下
  policy: PolicyDecision;        // allow | allow_degraded | reject | request_repair
  toMismatch: boolean;
  reentry: boolean;
  createdAt: string;
};
```

### 3.3 Packet 字段（协议层：渐进演进，不破兼容）

**保持现有共用字段（已落地）：**

| 字段 | 类型 | 策略 |
|------|------|------|
| `to` | scalar | 推荐；与 @ 对齐；冲突时以 @ 为准 |
| `goal` | scalar | 可选 |
| `what` | scalar | **尽量必填** |
| `why` | scalar | **尽量必填** |
| `tradeoff` | scalar | 可选 |
| `next_action` | scalar | **尽量必填** |
| `open_questions` | list | 可选 |
| `files` | list | 推荐（改代码/review） |
| `evidence` | list | 推荐 |

**建议新增（可选字段，解析器认识即可，旧 agent 不填不炸）：**

| 字段 | 含义 | 用途 |
|------|------|------|
| `intent` | `implement` \| `review` \| `discuss` \| `fix` \| `decide` | 接收侧选 skill / 检查清单；评分权重 |
| `priority` | `P0` \| `P1` \| `P2` | 附录与展示排序 |
| `verdict` | `approve` \| `approve-with-nits` \| `request-changes` | **仅 review 出口**；避免继续塞进 what 自由文本（兼容期：仍可从 what 启发式解析） |

兼容策略：

- 未知 key 仍丢弃（保持现逻辑，防污染 scalar）
- `verdict` 若出现在顶层则收录；skill 文案逐步引导从 what 迁出
- **第一期可不强制 agent 改模板**；平台侧 quality 可对 review 形状做启发式加分

### 3.4 Quality 扩展

现有：`ok / degraded / missing / missingRecommended / score / hasBlock`。

扩展建议：

```ts
type HandoffQuality = {
  ok: boolean;              // 必填字段齐
  degraded: boolean;        // !ok || !hasBlock 等
  hasBlock: boolean;
  missing: string[];
  missingRecommended: string[];
  score: number;            // 0..1
  toMismatch: boolean;
  intent?: string | null;
  // 新增
  emptyPacket: boolean;     // 无 block
  riskFlags: string[];      // e.g. ["worktree", "multi_target", "reentry"]
  repairHints: string[];    // 给 sender/receiver 的短提示
};
```

---

## 4. 协议与解析（保留优势，补缺口）

### 4.1 保留

- 行首 @ 触发（strip fence 防误触）
- 共用 ````handoff` fence，禁止私有顶层 key 污染
- multi-line scalar、list `-` / 逗号行
- `extractPrimaryHandoff(..., { routedTo })` 按目标匹配
- appendix anchor（P0/结论/handoff）
- soft 评分模型思想

### 4.2 解析增强

| 增强 | 说明 |
|------|------|
| **每目标一包** | 对每个 routed `m`，优先 `to` 匹配该目标的 **最后一个** block；若无匹配，用「未绑定 to 的最后 block」仅当 **本轮只 @ 一人**；多 @ 且无匹配 → 该目标 `packet=null`（避免两人抢同一烂包） |
| **block 位置提示** | 记录 block 在原文中的 offset（可选），便于 UI 高亮 |
| **intent 推断（弱）** | 无 intent 时：from∈reviewer & to∈implementer → `fix`；to∈reviewer → `review`；否则 `implement`/`discuss` 按 worktree |
| **verdict 抽取（弱）** | 从 `what` 中识别 `结论: request-changes` 等，填入 quality 旁路字段，不改 raw |

### 4.3 多 @ 规则（明确化）

现状：最多 2 个 mention / 轮。

设计：

1. 保持 cap=2（防扇出）。  
2. **理想**：两个 ````handoff` 或一个 block 内无法表达双目标时，要求两个 block 各写 `to`。  
3. **退化**：仅一个 block 且 `to` 只指向其中一个 → 另一目标记 `packet=null` + degraded + repairHint。  
4. **禁止**把同一份 what 静默复制给两个无关目标却显示 ok（今日可能发生）。

---

## 5. 策略矩阵（Policy）——取代「永远 soft」

### 5.1 输入信号

| 信号 | 来源 |
|------|------|
| `hasBlock` / `ok` | evaluateHandoff |
| `useWorktree` / 改代码开关 | chat 请求 |
| `intent` | packet 或推断 |
| `from→to` 角色对 | catalog（implementer/reviewer） |
| `reentry` | worklist 历史 |
| env `SHIFT_HANDOFF_POLICY` | `soft` \| `balanced` \| `strict`（默认 **balanced**） |

### 5.2 决策

| policy | 含义 |
|--------|------|
| `allow` | 正常入队；Receive Bundle 用 structured |
| `allow_degraded` | 入队；Bundle 强警告 + 更大附录/补全指引；SSE degraded |
| `request_repair` | **本轮不入队**；向用户/会话发 system：「请补 handoff 字段再 @」或要求 sender 重发（见 §5.3） |
| `reject` | 不入队；明确错误原因（depth、未知 agent 等已有场景） |

### 5.3 默认矩阵（balanced）

| 场景 | 无 block | hasBlock 缺必填 | hasBlock ok |
|------|----------|-----------------|-------------|
| 纯讨论（无 worktree） | `allow_degraded` | `allow_degraded` | `allow` |
| 改代码 / worktree | `request_repair` 或 `allow_degraded`+强警告* | `allow_degraded`+强警告 | `allow` |
| review→fix（opencode→grok） | `allow_degraded` | `allow_degraded` | `allow` + receiving-review |
| 用户消息里的 @（非 A2A） | N/A（用户路由） | — | — |

\* 开放问题：改代码缺 fence 是直接 `request_repair` 还是 degraded 放行。  
**建议默认：** `SHIFT_HANDOFF_POLICY=balanced` 时 worktree **缺 fence → `request_repair`**；`soft` 时全部 `allow_degraded`（兼容现状）。

### 5.4 `request_repair` 行为（推荐）

不静默吞掉 @：

1. **不** `worklist.push`  
2. SSE `handoff-repair-needed` + session system 消息：列出 missing、示例 fence  
3. transcript 事件 `handoff-repair-needed`  
4. 当前 turn 正常结束；用户或同一 agent 下一轮可补全后再 @  

避免「卡死在自动重试循环」；也不要 silent drop。

### 5.5 soft / strict 档位

| 档位 | 行为 |
|------|------|
| `soft` | 今日行为：几乎总是 `allow`/`allow_degraded`，永不因 handoff 拦路由 |
| `balanced` | §5.3 默认 |
| `strict` | 任意 A2A 无 ok handoff → `request_repair`（除用户显式强制？暂不提供） |

---

## 6. 接收侧：Receive Bundle 设计

### 6.1 目标形状（替换「任务体一团字」）

```text
Receive Bundle
├─ 1. Receiver Identity + Collaboration（精简，可去重）
├─ 2. Compact Memory Card          ← retrieveForTurn / listActive（新）
├─ 3. Structured Handoff Task      ← renderHandoffTask 升级版
├─ 4. Controlled Appendix          ← 结构化优先，原文兜底
├─ 5. Policy Banner                ← degraded / mismatch / repair 提示
├─ 6. Optional skill               ← receiving-review 等（条件）
└─ 7. Callback / Recall 说明       ← 精简
```

### 6.2 Structured Handoff Task 升级点

在现有 `renderHandoffTask` 上：

1. **路由行**：`to_routed: {id}` 始终打印；若 packet.to 不同，打印 `to_packet: …` + `⚠ 以路由目标为准`。  
2. **完整度**：ok / degraded / emptyPacket 三态文案。  
3. **intent / verdict** 若有则单独成行。  
4. **files / evidence / next_action** 置顶视觉顺序：`next_action` → `what` → `why` → `files` → 其余。  
5. **用户原始请求**：保留短窗（如 2KB），过长截断。  
6. **禁止**在 ok 包下再塞 8KB 全文；附录仅补洞。

### 6.3 Controlled Appendix

| 情况 | 附录策略 |
|------|----------|
| ok 且 files/next_action 充分 | 附录 ≤ 2KB 或不附 |
| ok 但缺 files、intent=review/fix | 附录用 anchor 窗 ≤ 4KB |
| degraded hasBlock | 附录 ≤ 5KB，anchor 优先 |
| emptyPacket | 附录 ≤ 6–8KB + **强制**「先 search/读记忆再改代码」 |
| 有 memory card 命中 | 附录再减（避免三重重复） |

优先附加顺序：

1. packet 字段（已在 structured 区）  
2. memory 卡  
3. 原文中 `## 评审` / P0 / 结论 窗口  
4. 原文 tail  

### 6.4 receiving-review

保留 `shouldInjectReceivingReview` 启发式；增强：

- `intent=fix` 或 `verdict=request-changes` → 注入  
- policy degraded 时仍注入（实现者更需要纪律）  
- skill 正文可继续独立文件；避免与 handoff card 重复「模板全文」

### 6.5 提示去重（治 H10）

A2A 路径建议：

| 注入 | 首棒 user turn | A2A 后继 |
|------|----------------|----------|
| always-on a2a-handoff skill 全文 | 可保留（出站教育） | **不注入**（已有 compact card） |
| collaboration rules | 短版或全文 | 短版 |
| A2A handoff card | 否 | 是（再压缩） |
| Memory card | 是 | 是（更短 budget） |

---

## 7. 发送侧：如何提高「有包率」

平台不能只靠接收侧兜底。

### 7.1 已有杠杆

- collaboration rules 每轮模板  
- always-on `a2a-handoff` skill  
- A2A compact card（教育下一棒如何再传）

### 7.2 增强（低成本）

1. **出口检查短卡**（首棒与长讨论）：3 行 checklist 塞进 collaboration 或 card，避免 skill 全文重复。  
2. **degraded 事后反馈**：turn 结束后若 `allow_degraded`，可在 SSE/UI 显示「交接不完整」，培养发送习惯。  
3. **repair 示例** 固定可复制 fence（中英字段与现模板一致）。  
4. **不**在 mid-stream 打断模型输出（解析仍在 turn end）。

### 7.3 回调路径对齐（治 H11）

`callbacks.postMessage` 入队时：

- 同样跑 `parseA2AMentions` + per-target handoff extract  
- 同样 policy  
- 同样 transcript/SSE/memory capture  
- 避免「主循环有 handoff-parsed、回调只有 a2a-route」

抽取 `finalizeA2ARoutes({ text, fromAgent, ctx })` 供 chat-routes 与 callbacks 共用。

---

## 8. 持久化与记忆晋升

### 8.1 最小持久化（不新建表也可）

| 存储 | 内容 |
|------|------|
| transcript 事件 `handoff` | 现有 summarize + 扩展 id/policy/toMismatch/intent |
| SSE `handoff-parsed` | 同上，供 UI |
| session system 消息 | route 行已有；可加 short what 摘要 |

### 8.2 记忆晋升（**规则唯一，实现波次分离**）

规则与 [design-alignment.md](./design-alignment.md) §2.2 / 记忆篇 §7.2 **完全一致**：

| 条件 | memory |
|------|--------|
| hasBlock && ok | `kind=handoff`, `status=confirmed` |
| hasBlock && !ok | `kind=handoff`, `status=captured` |
| emptyPacket | **不写** |
| 同 fingerprint `handoff:{from}:{to}` | supersede 旧 active |

| 波次 | 谁做 |
|------|------|
| **Wave M** | 在 chat-routes 现有 handoff 解析点调用 `memory-service.captureHandoff`（**首次落地**） |
| **Wave H** | 抽到 `finalizeA2ARoutes`；主循环与 callback **共用**；**不改规则** |

content 模板与记忆篇 §7.2 一致。

### 8.3 可选：handoff_records 表（H 之后可选）

若事件 JSON 难查，可加表：

```text
id, thread_id, invocation_id, from_agent, to_agent,
quality_json, packet_json, policy, created_at
```

第一期 **非必须**；transcript + memory 足够闭环。

---

## 9. 路由细节（保持稳定的部分）

| 规则 | 设计 |
|------|------|
| 触发 | 行首 `@` only；fence 内不触发 |
| 自 @ | 禁止 |
| 每轮上限 | 2（可配置，默认不变） |
| 深度上限 | `MAX_A2A_DEPTH`（默认 15） |
| re-entry | 允许（fix loop） |
| 路由目标权威 | **@ 解析的 agent id** |
| packet.to | 校验与展示；不覆盖路由 |

### 9.1 用户 @ vs Agent @

- 用户消息里的 @：已有 agent 选择逻辑，**不**要求用户写 handoff。  
- 仅 **agent→agent** 应用 handoff policy。

---

## 10. 可观测性

| 事件 | 载荷要点 |
|------|----------|
| `handoff-parsed` | quality 全字段 + policy + toMismatch + intent |
| `a2a-route` | 已有 + `handoffPolicy` + `handoffId` |
| `a2a-skipped` | max_depth / reject |
| `handoff-repair-needed` | **新**：missing、example、from、attemptedTo |
| transcript | 与 SSE 对齐，保证 reload 可审计 |

UI（后置）：route 气泡上显示 ok/degraded/repair 徽章。

---

## 11. 与记忆 / 检索的边界

```text
Handoff 负责：这一棒「任务契约」
Memory  负责：跨棒仍成立的「决策资产」
Retrieve负责：下一棒自动看到哪些资产

handoff ok  ──promote──► memory(handoff)
receiver    ──retrieve──► memory card + handoff task
seal        ──capture───► memory(window-seal)  （可嵌入未完成 next_action）
```

Handoff **不**替代 memory；memory **不**替代当轮 next_action 的精确性。

---

## 12. 失败模式

| 场景 | 行为 |
|------|------|
| 无 @ | 不路由（不变） |
| 有 @ 无包 + soft | degraded bundle |
| 有 @ 无包 + balanced worktree | repair，不入队 |
| 解析异常 | 当 emptyPacket；不抛穿 chat |
| memory 写入失败 | 路由仍按 policy；log |
| 双 @ 抢包 | 见 §4.3；至少一人 degraded |
| depth 用尽 | 现有 skip（不变） |

---

## 13. 模块与文件地图（实施时）

| 文件 | 变化 |
|------|------|
| `src/agents/handoff.js` | quality 扩展、per-target 选包规则、render 升级、appendix 策略、policy 纯函数 |
| `src/agents/handoff-policy.js` **新** | `decidePolicy(ctx) → allow\|…` |
| `src/agents/a2a-finalize.js` **新** | 统一 turn-end / callback 路由+handoff 处理 |
| `src/agents/routing.js` | 基本不动；或导出 cap 配置 |
| `src/server/chat-routes.js` | 接 policy、Receive Bundle、memory capture |
| `src/agents/callbacks.js` | 走同一 finalize |
| `src/agents/collaboration-rules.js` | 可选压缩 A2A 短版 |
| `skills/a2a-handoff.md` | 可选增加 intent/verdict 说明（兼容旧模板） |
| `tests/agents/handoff*.test.js` | policy 矩阵、多目标、渲染 |

---

## 14. 分期（= 全局 Wave H；前置 M+R）

> **不要在 Wave H 才第一次写 memory**（已在 M）。  
> Wave M/R 期间路由保持 **soft**（对齐总览 §2.6）。

### H0 — 契约与可观测

- quality 扩展 + SSE/transcript  
- toMismatch 写入接收 prompt  
- per-target 选包规则  
- 单测  

### H1 — Receive Bundle

- 渲染顺序与 Controlled Appendix  
- **槽位接入** Wave R 的 compact `retrieveForTurn`（2000）  
- A2A skill 去重  

### H2 — Policy

- `handoff-policy` + `SHIFT_HANDOFF_POLICY`  
- 默认 **balanced**；worktree 无 fence → `request_repair`  
- `handoff-repair-needed`  
- `soft` 可回滚  

### H3 — 调用点统一（非「首次晋升」）

- `finalizeA2ARoutes`：主循环 + callback  
- **复用** Wave M 的 `captureHandoff`（迁入 finalize）  
- UI 徽章（可选）  

### H4 — 协议演进（可选）

- `intent` / `verdict`；handoff_records 表  

---

## 15. 开放问题

| # | 问题 | 状态 |
|---|------|------|
| O1 | worktree 无 fence：repair vs degraded | **建议 repair（balanced）**；可用 soft 回滚 |
| O2 | repair 是否自动重跑 agent | **否**（已裁定） |
| O3 | 顶层 `verdict` | 可选，H4 |
| O4 | 默认 policy | **balanced**（Wave H 启用后；M/R 期间等价 soft） |
| O5 | emptyPacket 写 memory | **否**（已裁定，与记忆篇一致） |
| O6 | 每轮 2 @ | **保持 2**，配对变严 |

---

## 16. 决策摘要

1. **不推倒** 现有 fence 协议与 @ 路由；它们是系统已验证的交互面。  
2. **把 soft-only 升级为分风险 policy**；讨论从宽，改代码收紧。  
3. **接收侧 Bundle 标准化**：structured 优先 + memory 卡 + 可控附录 + mismatch 明示。  
4. **交接落资产规则** 与记忆篇一致；**首次实现在 Wave M**，H3 只迁调用点。  
5. **多目标配对要诚实**。  
6. **主循环与 callback 共用 finalize**。  
7. **执行序 M → R → H**；本篇最后做。  
8. 冲突裁定见 [design-alignment.md](./design-alignment.md)。

---

## 17. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-16 | 首版 |
| 2026-07-16 | 对齐：Wave H 前置；G4/G5/G6 波次；H3 非首次写 memory；取消 harden 用语 |
