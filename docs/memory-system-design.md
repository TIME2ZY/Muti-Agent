# 记忆系统设计（Memory System Design）

| 字段 | 值 |
|------|-----|
| 状态 | Draft · **已与对齐总览同步** |
| 日期 | 2026-07-16 |
| 对齐权威 | **[design-alignment.md](./design-alignment.md)**（冲突时以对齐文档为准） |
| 范围 | **Wave M**：写入 / 生命周期 / **最小** recency 注入 |
| 明确不做（本篇） | 分层检索大改、handoff policy、完整 `retrieveForTurn`（见检索篇 Wave R） |
| 代码改动 | **本文件仅设计，不实施** |

---

## 1. 问题陈述

SHIFT 对外承诺「会话持久化 + 回忆检索，跨轮不丢线」，但当前后端把三件事混为一谈：

| 概念 | 实现 | 实际作用 |
|------|------|----------|
| 原始日志 | `transcript` JSONL + SQLite `invocation_events` / `messages` | 证据源 |
| 检索投影 | `recall_items` + FTS5 | 可搜流水账 |
| **结构化记忆** | `memory_entries` 表 + `memory-repository` | **生产路径从不写入** |

结果：

1. Agent 被教导「先 `session-search` 再行动」，但系统**从不**把决策沉淀成记忆，也**从不**在新一轮自动注入相关记忆。
2. Context seal 后会 `abandonProviderSession`，CLI 侧上下文归零；bootstrap digest 只有 invocation 元数据目录，**没有「遗书」**。
3. 合格 A2A handoff 只进 transcript / SSE，不进 `memory_entries`，接力信息是一次性的。
4. 检索命中以事件 JSON 为主，噪声大；回调文案提到的「记忆命中」在运行时几乎不可能出现。

**一句话：** 现有系统擅长**存日志、搜日志**；缺少**可晋升、可注入、可过期的决策级记忆**。

---

## 2. 设计目标与非目标

### 2.1 目标

1. **会写**：生产路径稳定产生 `memory_entries`（至少：合格 handoff、窗口 seal 遗书）。
2. **会用**：同一 thread 的后续 turn / 新 generation / A2A 后继 Agent 能**被动**看到 active memories。
3. **会旧**：`superseded` / `invalidated` 生效；过期决策不再被优先注入或优先检索。
4. **会用（Wave M 最小集）**：bootstrap 能注入 **recency** active memories；完整 related 检索见 Wave R。
5. **可降级**：`storageMode=files` 或 SQLite 失败时，行为可降级且不阻断 chat；有明确日志。

> **「会查」分层排序** 归 [memory-retrieval-design.md](./memory-retrieval-design.md)（Wave R），本篇只保证 memory 可被 index 且 listActive 正确。

### 2.2 非目标（本设计 / Wave M）

- 重写 `handoff.js` 协议；**不**引入 handoff policy / hard-block（Wave H，见交接篇）
- 完整 `retrieveForTurn` 双通道、session-search 分层配额（Wave R）
- 重写 dual-write / 废弃 JSONL transcript
- Embedding / 向量检索 / 跨项目全局记忆
- 前端「记忆编辑器」完整产品（可预留 API，UI 后置）
- 用 LLM 做重型摘要流水线作为硬依赖（seal 遗书 **规则模板优先**）

### 2.3 成功标准（可验收）

| ID | 标准 | 波次 |
|----|------|------|
| S1 | 含 ````handoff` 块的 A2A 后 `memory_entries` +1，且可被既有 FTS/`listActive` 看到 | **M** |
| S2 | seal 后存在 `kind=window-seal`；下一轮 bootstrap 含其摘要 | **M** |
| S3a | Bootstrap 含 recency Memory Card（非仅 invocation 目录） | **M** |
| S3b | Bootstrap 含 related 通道（`retrieveForTurn`） | **R** |
| S4 | retired 默认不注入 / 不进默认 search | **R**（M 的 listActive 已排除 retired） |
| S5 | `storageMode=files` 下 chat 不因记忆模块失败 | **M** |
| S6 | 单测：写入、晋升、listActive、seal；检索排序测在 R | **M/R** |

---

## 3. 现状锚点（保留什么）

### 3.1 可保留

| 组件 | 路径 | 理由 |
|------|------|------|
| `memory_entries` 表骨架 | `src/storage/schema.js` | status 四态、thread 外键、superseded_by 已够 MVP |
| `createMemoryRepository` | `src/storage/memory-repository.js` | create / get / list / transition + recall 索引钩子 |
| dual-write 投影 | `src/storage/dual-write-recorder.js` | 继续作为 evidence 写入 messages/events/recall |
| FTS 管道 | `src/storage/recall-repository.js` | exact → FTS → contains 分层可复用 |
| recall 双源服务 | `src/storage/recall-service.js` | 合并逻辑短期保留，检索排序层改造 |
| bootstrap 注入点 | `src/session/bootstrap.js` + `chat-routes.js` | 已有 packet 拼装位置 |
| seal 钩子 | `chat-routes.js` 内 `sealAndRotateWindow` / `sealWindow` | 已有「窗口死亡」时刻 |

### 3.2 必须改变（语义，而非推倒存储）

```text
旧语义：Memory ≈ 能搜的 transcript 投影 + 一纸「请自己 curl」
新语义：Memory = 经规则/事件晋升的结构化条目；transcript 仅 evidence
```

---

## 4. 概念模型

### 4.1 三层职责（强制分离）

```text
┌─────────────────────────────────────────────────────────┐
│  L3  Memory（决策层）                                     │
│  memory_entries · 注入 bootstrap · 优先检索               │
│  「Agent 应该相信并遵守什么」                              │
└──────────────────────────▲──────────────────────────────┘
                           │ promote / capture
┌──────────────────────────┴──────────────────────────────┐
│  L2  Recall Index（检索层）                               │
│  recall_items + FTS · 统一查询 API                        │
│  索引 memory / message / event，但排序与过滤按策略不同      │
└──────────────────────────▲──────────────────────────────┘
                           │ project
┌──────────────────────────┴──────────────────────────────┐
│  L1  Evidence（证据层）                                   │
│  transcript JSONL · messages · invocation_events          │
│  「发生过什么」——完整、嘈杂、默认不直接塞进 prompt          │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Memory 条目语义

一条 memory 表示 **thread 范围内、可复用的短事实或约束**，不是对话全文。

**内容原则：**

- 短：建议 `content` 主体 ≤ 2KB；过长则写摘要 + 在 metadata 挂 evidence 指针
- 可执行：优先「决定了什么 / 约束是什么 / 下一步是什么」，少堆过程叙述
- 可溯源：尽量带 `source_invocation_id` / `source_message_id`
- 可替代：同一主题更新时 supersede 旧条，而不是无限追加矛盾句

### 4.3 Kind 字典（第一阶段固定集合）

| kind | 含义 | 典型来源 | 默认初始 status |
|------|------|----------|-----------------|
| `handoff` | 结构化交接要点 | A2A 解析成功的 handoff | `captured`；完整度 ok → `confirmed` |
| `window-seal` | 窗口密封遗书 | context overflow seal | `captured` |
| `decision` | 明确决策/约定 | 后续：用户确认、agent 显式标记 | `captured` 或 `confirmed` |
| `constraint` | 硬约束（只读、目录、禁止项等） | 后续扩展 | `confirmed` 优先 |
| `fact` | 稳定事实（端口、路径、结论） | 后续扩展 | `captured` |

第一阶段 **强制实现** `handoff` + `window-seal`。  
`decision` / `constraint` / `fact` 在模型与写入 API 中预留，可不接自动源。

### 4.4 Status 生命周期

沿用现有 CHECK 约束：

```text
captured ──confirm──► confirmed ──supersede──► superseded
    │                      │
    └────invalidate────────┴──► invalidated
```

| status | 注入？ | 默认检索？ |
|--------|--------|------------|
| `captured` | 是（权重中） | 是 |
| `confirmed` | 是（权重高） | 是 |
| `superseded` | **否** | 默认否（`includeRetired=true` 可查） |
| `invalidated` | **否** | 默认否 |

**晋升规则（MVP）：**

- handoff `evaluateHandoff().ok === true` → 直接 `confirmed`
- handoff degraded 但仍有 block → `captured`（可注入，提示「未完整」）
- window-seal → `captured`（自动生成，未人工确认）
- 同 fingerprint 的新 handoff/decision 写入时，将旧 active 条 `transition(..., 'superseded', newId)`

---

## 5. 数据模型

### 5.1 复用现表 + 轻量迁移

**尽量不破坏** `memory_entries` 现有列。MVP 可通过 **content 结构化约定** 或 **可选 migration** 增强。

#### 方案 A（推荐 MVP）：零破坏 / 最小迁移

- 表结构保持 `id, thread_id, kind, status, content, source_*, created_by, created_at, superseded_by`
- `content` 存 **人类可读正文**（注入与 FTS 主字段）
- 扩展字段放进 **可选 migration v3**：`metadata_json TEXT`、`window_id TEXT`、`fingerprint TEXT`

```sql
-- migration v3 (memory_enrichment) — 实施阶段再加
ALTER TABLE memory_entries ADD COLUMN metadata_json TEXT;
ALTER TABLE memory_entries ADD COLUMN window_id TEXT
  REFERENCES context_windows(id) ON DELETE SET NULL;
ALTER TABLE memory_entries ADD COLUMN fingerprint TEXT;
CREATE INDEX memory_entries_thread_fingerprint
  ON memory_entries(thread_id, fingerprint)
  WHERE fingerprint IS NOT NULL;
CREATE INDEX memory_entries_thread_active
  ON memory_entries(thread_id, created_at)
  WHERE status IN ('captured', 'confirmed');
```

若希望第一刀零 migration：fingerprint 可暂用 `kind + 规范化标题` 在应用层去重，metadata 先塞进 content 前置 YAML/JSON 头——**不推荐长期**，仅应急。

#### 方案 B：content 正文约定（与 metadata 并存）

注入与展示使用统一可读格式：

```text
[handoff] grok → opencode
what: 新增 POST /api/login …
why: 无状态鉴权 …
next_action: 审查 JWT 与错误码
files: src/server/auth.js, tests/auth.test.js
```

`metadata_json` 示例：

```json
{
  "fromAgent": "grok",
  "toAgent": "opencode",
  "score": 1,
  "degraded": false,
  "files": ["src/server/auth.js"],
  "evidenceInvocationIds": ["…"],
  "windowId": "…",
  "generation": 2,
  "sealReason": "context overflow"
}
```

### 5.2 Fingerprint（去重 / 替代）

用于「同一主题只保留最新 active」：

| 来源 | fingerprint 建议 |
|------|------------------|
| handoff | `handoff:{from}:{to}:{hash(what|goal 规范化前 200 字)}` 或更粗 `handoff:{from}:{to}:latest`（MVP 可用粗粒度：同一 from→to 只保留最新 confirmed/captured） |
| window-seal | `window-seal:{windowId}`（每窗至多一条） |
| decision | `decision:{slug}`（后续） |

MVP 推荐 **粗粒度 supersede**：

- 同一 thread + 同一 `kind=handoff` + 同一 `(fromAgent,toAgent)` → 新条 supersede 旧 active
- `window-seal` 按 `windowId` 幂等（同窗重复 seal 不双写）

### 5.3 与 recall 投影

写入 memory 后继续走现有 `indexMemory`：

- `sourceKind: "memory-entry"`
- `sourceId: memory.id`
- `title: `${kind}:${status}``
- `content: memory.content`
- metadata 含 kind/status/createdBy/sourceInvocationId 等

**检索过滤：** `recall.search` 或 service 层对 `memory-entry` 读取 metadata.status，过滤 retired（需确保 transition 后 **re-index title/content/metadata**——现有 `transition` 已调用 `indexMemory`，需在 metadata 中带 status，并在 search 路径使用）。

---

## 6. 架构与模块边界

### 6.1 新增核心模块（建议）

```text
src/storage/memory-service.js      # 领域服务：capture / confirm / supersede / listActive / render
src/session/memory-inject.js       # bootstrap / A2A 注入卡片渲染与 budget
（可选）src/storage/memory-sources/  # handoff / seal 适配器，避免 chat-routes 臃肿
```

**不**把业务规则继续堆进 `memory-repository.js`（保持薄仓储）。  
**不**在 `recall-repository` 里写 handoff/seal 逻辑。

### 6.2 依赖方向

```text
chat-routes（现有 handoff 解析结果 / seal）
        │
        ▼
  memory-service  ──writes──►  memory-repository ──► recall upsert
        │
        ▼
  memory-inject.render(listActive(...))   // Wave M：仅 recency
        │
        ▼
  bootstrap.js / A2A（临时）
```

Wave R 起：bootstrap / A2A 改为调用 `recall-service.retrieveForTurn`（内部仍用 `listActive` + memory search + `memory-inject` 渲染）。  
**禁止**长期维持两套互不相通的拼装逻辑（见对齐总览 §2.5）。

### 6.3 与 storageMode 的关系

| mode | 行为 |
|------|------|
| `dual` / `sqlite` | 完整记忆闭环 |
| `files` | memory-service no-op 或内存可选；bootstrap 退回今日 digest；日志 warning 一次 |

记忆失败 **不得** 抛穿打断 agent 主路径（与 dual-write `attempt` 同风格）。

---

## 7. 写入路径（Capture Pipeline）

### 7.1 总览

```text
                    ┌─ handoff ok/degraded ──► captureHandoffMemory
  agent turn end ───┤
                    └─ (future) explicit decision tag

  context seal ──────────────► captureWindowSealMemory（幂等 per window）

  (future) user / API ───────► captureDecisionMemory
```

### 7.2 Source A — Structured Handoff（P0）

**触发点：** `chat-routes.js` 在解析 `extractPrimaryHandoff` / per-target handoff 并 `handoff-parsed` SSE 之后（routing 入队前后均可，建议 **成功解析后立即写**，不依赖下游 agent 是否跑完）。

**输入：**

- `threadId`, `invocationId`, `fromAgent`, `toAgent`（路由目标优先于 handoff.to）
- `Handoff` 对象 + `HandoffQuality`
- 可选 `windowId`

**规则：**

| 条件 | 动作 |
|------|------|
| `!quality.hasBlock` | **不写** memory（degraded 无块只有附录，避免把整篇 output 当记忆） |
| `hasBlock && ok` | create `kind=handoff`, `status=confirmed` |
| `hasBlock && !ok` | create `kind=handoff`, `status=captured`，content 标注缺失字段 |
| 同 from→to 已有 active | supersede 旧条 |

**content 模板（稳定、可测）：**

```text
交接 ${from} → ${to}
完整度: ${ok ? "ok" : "degraded; missing=" + missing}
goal: …
what: …
why: …
next_action: …
files: …
open_questions: …
```

**created_by：** `fromAgent` 或 `system:handoff-capture`。

### 7.3 Source B — Window Seal 遗书（P0，最关键）

**触发点：** 在 `sealAndRotateWindow` / `sealWindow` **成功且即将 abandon provider session 之前**（`chat-routes` onHealth SEALED 分支与 turn 结束 seal 分支统一走一个 helper，避免双写）。

**目标：** 解决「provider 上下文归零 + digest 无内容」的丢线峰值。

**生成策略（MVP = 规则模板，不强制 LLM）：**

从当前 turn / window 收集：

1. 本窗最近 1 条 assistant 最终文本的截断摘要（例如头尾各 1.5KB 或 anchor 窗口，可复用 `selectAppendix` 思想）
2. 本窗已产生的 handoff 记忆要点（若有）
3. seal 元数据：`agentId`, `generation`, `ratio`, `reason`

合成单条：

```text
[window-seal] agent=${agent} generation=${gen} reason=${reason}
摘要:
…
关键交接:
…
说明: provider session 已放弃；请以下列记忆与 session-search 为准，勿假设 CLI 仍持有上文。
```

**幂等：** `fingerprint = window-seal:{windowId}`；已存在则 update content 或跳过。

**status：** `captured`。  
**created_by：** `system:window-seal`。

**明确不做（MVP）：** seal 时再调一次外部 LLM 写漂亮遗书（可作为 P2 增强开关）。

### 7.4 Source C — 预留

| 源 | 说明 | 阶段 |
|----|------|------|
| 用户「钉选」消息 | UI/API → confirmed decision | P2 |
| Agent 回调 `post-memory` | 经 token 校验的显式写入 | P2 |
| 定期压缩 | 多条 captured 合并 | P3 |

---

## 8. 注入路径（Inject Pipeline）

### 8.1 原则

> **被动注入优先，curl 回忆兜底。**  
> RECALL_RULE 保留，但不再是唯一手段。

### 8.2 Bootstrap 改造

`buildBootstrapPacket` 扩展为：

```text
1. Identity（现有）
2. Active Memory Card（新，核心）
3. Invocation Digest（现有，可压缩为最近 K 条）
4. RECALL_RULE（现有，文案微调：先看 Memory Card，不够再 search）
```

#### Active Memory Card 规格

- **Wave M 数据源**：仅 `listActive(threadId, { limit })`（recency）
- **Wave R 数据源**：`retrieveForTurn`（recency + related），见检索专篇
- 排序：`confirmed` 先于 `captured`；同 status 按 `created_at DESC`
- **Budget（对齐裁定）**：用户 turn **4000** 字符（`SHIFT_RETRIEVE_BUDGET_CHARS`）；A2A **2000**（`SHIFT_RETRIEVE_A2A_BUDGET_CHARS`）
- 超出截断并注明 `truncated: true`
- 渲染示例：

```text
<!-- Active Memories (4) -->
## 本 thread 活跃记忆（系统注入，非猜测）

1. [confirmed][handoff] id=… · grok→opencode · 2026-07-16T…
   what: …
   next_action: …
2. [captured][window-seal] id=… · generation=2
   摘要: …
…
若与用户最新指令冲突，以用户指令为准，并考虑更新记忆。
<!-- /Active Memories -->
```

无记忆时：

```text
<!-- Active Memories (0) -->
尚无结构化记忆。需要历史细节时使用 session-search。
```

### 8.3 按需检索注入（**划归 Wave R**，本篇不实施）

双通道（recency + related）由 `retrieveForTurn` 统一实现，见 [memory-retrieval-design.md](./memory-retrieval-design.md)。  
Wave M **不要**在 bootstrap 里再手写一套 search 合并，以免与 R 重复。

### 8.4 A2A 后继 Agent

| 波次 | 行为 |
|------|------|
| **M** | 可选：`listActive` 截断至 2000 字临时塞入；或暂不塞，仅靠 handoff task（允许，因 R 很快补上） |
| **R** | 正式 `retrieveForTurn` compact card（2000 budget）+ 现有 handoff task |
| **H** | Receive Bundle 标准化（交接篇），复用 R 的 card |

### 8.5 与 RECALL_RULE / curl 的关系

- Wave M：可微调「先看 Memory Card」一句
- Wave R：完整改写 callback 文案（先卡后 search 后 read-invocation）

---

## 9. 检索路径（Search）

> **全部展开与实施归 Wave R：** [memory-retrieval-design.md](./memory-retrieval-design.md)  
> **数字与 API 以 [design-alignment.md](./design-alignment.md) §2.4–2.5 为准。**

本篇 memory-service **对外查询面**（供 R 与注入使用）：

```js
listActive(threadId, { limit, kinds, maxChars })
search(threadId, query, { limit, activeOnly })  // 可在 M 做简单实现，R 可换 FTS 增强
captureHandoff(...)
captureWindowSeal(...)
confirm(id) / invalidate(id) / supersede(oldId, newInput)
```

---

## 10. 与交接、密封的协作（边界）

| 系统 | 记忆系统如何协作 | 不做什么 |
|------|------------------|----------|
| Handoff | Wave M：消费**现有** parse/evaluate 做 capture（§7.2） | **不**改路由 soft/policy（Wave M/R 保持现状 soft；policy 见交接篇 Wave H） |
| Sealer / Health | SEALED 时强制 window-seal memory | 不改变阈值与阈值本身 |
| Dual-write | memory 写 SQLite；evidence 仍双写 | 不要求 JSONL 存 memory 副本（可选 `memory-captured` 事件） |
| Frontend recall panel | 后续可展示 memory-entry 命中 | 本设计不强制改 UI |
| 检索 | 提供 listActive / 可 index 的条目 | 不实现分层 search 编排 |

**可选 observability 事件（建议写 transcript + SSE）：**

- `memory-captured` `{ id, kind, status }`
- `memory-superseded` `{ oldId, newId }`

便于调试「有没有记住」。

---

## 11. 失败模式与降级

| 场景 | 行为 |
|------|------|
| SQLite 不可用 | capture no-op + error log；chat 继续；bootstrap 无 Memory Card |
| capture 抛错 | 吞掉并 log，不影响 handoff 路由 / seal 流程 |
| 注入超 budget | 截断 + `truncated` 标记 |
| 重复 seal | 幂等，不产生第二条 window-seal |
| 矛盾记忆 | 新条 supersede 同 fingerprint 旧条；残留矛盾靠 confirmed 优先 + 用户指令优先声明 |
| 超大 content | 截断存储 + metadata.truncated |

---

## 12. 安全与隐私

- 记忆仅 thread 作用域；删除 thread 时 FK CASCADE 清理（已有）
- 回调写入（若 P2 做 post-memory）必须校验 callback token + thread affinity
- session-search 现有 optional auth 行为 **本设计不扩大攻击面**；不在此改为完全开放新 API
- Memory Card 注入注意 prompt 注入：content 来自本系统生成或已存库文本，渲染时保持原样展示并标明「系统记忆」，不把记忆当 system 更高权威压过用户当前指令（卡片内声明冲突处理规则）

---

## 13. 实施分期（映射 Wave；细节见对齐总览）

> 全局顺序：**Wave M（本篇）→ Wave R（检索篇）→ Wave H（交接篇）**。

### Wave M（本篇范围）

1. **地基**：`memory-service` + migration v3（建议）+ `listActive` / fingerprint / re-index status  
2. **会写**：handoff capture（现有 parser）+ window-seal capture + `memory-captured`  
3. **最小会用**：bootstrap recency Memory Card（budget 4000）；A2A 可选 2000 临时卡  
4. 验收 **S1、S2、S3a、S5**

### 划出本篇（勿在 M 做满）

| 项 | 去向 |
|----|------|
| `retrieveForTurn` related 通道、分层 search、eventPlainText | **Wave R** |
| handoff policy / Receive Bundle / finalize 统一 | **Wave H**（capture 调用点可迁入 finalize，规则不变） |
| 列表/钉选 API、post-memory | 产品化（M/R/H 之后可选） |

---

## 14. 测试计划

| 层 | 用例 |
|----|------|
| unit | content 模板；fingerprint supersede；listActive 排序；budget 截断 |
| unit | captureHandoff：无 block 不写 / ok→confirmed / degraded→captured |
| unit | captureWindowSeal 幂等 |
| integration | chat A2A 后 DB 有 memory-entry；search 可命中 |
| integration | 触发 seal 后 bootstrap 含 window-seal 文本 |
| integration | files mode 不崩溃 |
| regression | Wave M 期间 handoff **soft 路由**行为不变；无 SQLite 时 chat 仍通 |

---

## 15. 风险与开放问题

| 风险 / 问题 | 倾向决策 | 待定 |
|-------------|----------|------|
| seal 遗书无 LLM 是否太糙 | MVP 规则模板足够「不丢线」；P2 再增强 | 是否加 `SHIFT_SEAL_SUMMARY=llm` |
| handoff 每跳都写是否噪声大 | 要写；靠 supersede 控量 | 是否仅 ok 才写 |
| Memory Card 占 prompt 预算 | **已裁定** 4000 / A2A 2000 | 见对齐总览 |
| fingerprint 过粗误杀 | MVP 用 from→to；过粗再细化 | — |
| 双写时序：message 尚未 mirror 就写 source_message_id | source_message_id 可空；优先 invocation_id | — |
| 旧数据无 memory | 不强制 backfill；可选 rebuild 从历史 handoff 事件回放 | 是否提供一次性脚本 |

---

## 16. 关键文件地图（实施时）

| 文件 | 预期触点 |
|------|----------|
| `src/storage/schema.js` | migration v3（若采用） |
| `src/storage/memory-repository.js` | listActive / fingerprint / metadata |
| `src/storage/memory-service.js` | **新建** 领域服务 |
| `src/session/memory-inject.js` | **新建** 渲染与 budget |
| `src/session/bootstrap.js` | 接入 Memory Card |
| `src/server/chat-routes.js` | handoff 后 capture；seal 前 capture；A2A 注入 |
| `src/storage/recall-service.js` | 排序 / active memory 过滤 |
| `src/storage/recall-repository.js` | 可选：search 支持 status；事件正文规范化 |
| `src/agents/callbacks.js` | RECALL 文案微调 |
| `tests/storage/*` `tests/server.test.js` | 验收用例 |

---

## 17. 决策摘要（给评审）

1. **不推倒** SQLite / FTS / dual-write；**重建** Memory 生命周期与注入。  
2. **真正的记忆** = `memory_entries`；recall 是索引；transcript 是证据。  
3. **P0 写入源** = 合格/半合格 handoff + window-seal 遗书。  
4. **Wave M 注入** = bootstrap **recency-only**；完整 related 注入归 Wave R。  
5. **失败降级** = 与 dual-write 一致，永不阻断主聊天路径。  
6. **Wave M 不改** handoff soft 路由；policy 归 Wave H。  
7. 执行序见 [design-alignment.md](./design-alignment.md)：**M → R → H**。

---

## 18. 修订记录

| 日期 | 作者 | 说明 |
|------|------|------|
| 2026-07-16 | 设计草案 | 首版 |
| 2026-07-16 | 对齐 | 与检索/交接消歧：预算 4000/2000、Wave M 范围、注入/检索/policy 归属 |
