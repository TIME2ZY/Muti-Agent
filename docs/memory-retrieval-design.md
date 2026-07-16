# 记忆检索设计（Memory Retrieval Design）

| 字段 | 值 |
|------|-----|
| 状态 | Draft · **已与对齐总览同步** |
| 日期 | 2026-07-16 |
| 对齐权威 | **[design-alignment.md](./design-alignment.md)** |
| 父文档 | [memory-system-design.md](./memory-system-design.md) |
| 范围 | **Wave R**：query → rank → return / **完整** inject（`retrieveForTurn`） |
| 前置依赖 | **Wave M** 已提供 `memory-service` / capture / `listActive` |
| 不含 | capture 规则、handoff policy |
| 代码改动 | **仅文档，不实施** |

---

## 1. 先钉死：今天的「检索」在解决什么、又做错了什么

### 1.1 现状链路

```text
Agent / UI
  │  GET session-search?query=
  ▼
callback-routes
  ▼
recall-service.searchTranscript
  ├─ SQLite: recall_items + FTS5 (exact → FTS → LIKE)
  │    sources: message | invocation-event | memory-entry(几乎永远为空)
  └─ File: 全量扫 JSONL，JSON.stringify 子串匹配
  ▼
hits[] 扁平列表（先 SQLite 再 file 去重截断）
```

另有一条**非检索**路径：bootstrap 只塞 RECALL_RULE + invocation 目录，**零召回结果注入**。

### 1.2 问题清单（按危害排序）

| # | 问题 | 表现 | 根因 |
|---|------|------|------|
| R1 | **搜的是日志，不是记忆** | 命中 text.delta / stderr / 工具噪声 | memory 无写入；索引以 event 为主 |
| R2 | **只有主动搜，没有被动召回** | Agent 不 curl 就等于失忆 | 缺 server-side retrieve-for-turn |
| R3 | **无分层、无预算** | top-20 可能全是碎片事件 | 单列表、FIFO 合并截断 |
| R4 | **事件索引内容脏** | content = 整包 `payload_json` | dual-write / eventToRecall 未抽正文 |
| R5 | **排序≈写入顺序/拼接顺序** | exact 先填满后 FTS 几乎进不来 | `append until limit` 无统一 score |
| R6 | **过期/替代记忆不可区分** | 将来有 memory 后 superseded 仍可命中 | 缺 status 过滤与 re-rank |
| R7 | **双源合并特判多** | user message vs `_user_prompt` 去重 | service 层 ad-hoc，难扩展 |
| R8 | **文件 fallback O(全量)** | 长会话 search 变慢 | 无索引、无窗限制 |
| R9 | **证据与结论同权** | 决策句与思考过程并列 | 缺 source / kind 权重 |
| R10 | **下钻路径与检索脱节** | 有 hit 仍要人肉拼 read-invocation | hit 契约偏弱，缺「下一步动作」 |

**设计原则一句话：**

> 检索要服务两种调用方——**系统注入（被动）** 与 **Agent/UI 下钻（主动）**；  
> 两者共享同一检索核心，但 **query 形态、层配额、返回形状** 不同。

---

## 2. 目标与非目标

### 2.1 目标

1. **双通道召回**：`retrieveForTurn`（被动注入）+ `search`（主动查询）共用核心。
2. **分层结果**：Memory → 关键 Message → Evidence Event，各有配额，避免事件挤爆记忆。
3. **可排序**：统一 `score`，可测、可调，不靠「谁先 append」。
4. **可过滤**：默认只返回 active memory；retired 需显式打开。
5. **可下钻**：每个 hit 带齐 `sourceKind/sourceId` 与跳转线索（invocationId/eventNo 或 memoryId）。
6. **可降级**：无 SQLite 时仍能（弱）搜文件；失败不阻断 chat。
7. **索引可读**：入库文本是自然语言正文，不是原始 JSON 壳。

### 2.2 非目标（检索篇）

- 向量 / embedding / hybrid semantic search（可预留接口，第一期不做）
- 跨 thread / 全局用户记忆检索
- 替换 transcript 作为审计真相源
- 重做前端回忆面板交互（契约可兼容扩展）

### 2.3 验收（检索专用）

| ID | 标准 |
|----|------|
| T1 | 存在 active `memory-entry` 且 query 命中其 content 时，hit[0] 的 `layer=memory`（或 sourceKind=memory-entry 且 score 最高档） |
| T2 | 同 query 下，在 memory 未满配额前，不得被 invocation-event 占满 limit |
| T3 | `status=superseded\|invalidated` 默认不出现在 search / retrieveForTurn |
| T4 | `retrieveForTurn(prompt)` 在无 agent curl 时仍能为 bootstrap 产出 ≤ budget 的注入块 |
| T5 | 事件索引文本不含无意义的 JSON 键噪声（至少 text.delta 只索引 text） |
| T6 | files mode 或 SQLite 失败时 search 返回 [] 或 file-only，不抛 500 |

---

## 3. 检索对象分层（核心模型）

不要再把一切摊平成「transcript hit」。引入 **layer**：

| Layer | 含义 | 主存 | 默认角色 |
|-------|------|------|----------|
| **L_memory** | 结构化记忆 | `memory_entries` → recall 投影 | 结论 / 约束 / 交接 / 遗书 |
| **L_message** | 对话消息 | `messages`（尤其 user / 无 invocation 的 system） | 用户原话、钉选说明 |
| **L_evidence** | 过程证据 | `invocation_events`（及文件 JSONL） | 下钻、核对、debug |

```text
置信与注入优先级（默认）:

  L_memory (confirmed)  >  L_memory (captured)
       >  L_message (user)
       >  L_evidence (text.delta / handoff 事件)
       >  L_evidence (thinking / tool / stderr)   // 默认可降权或排除
```

**UI / Agent 主动搜索**：三层都可返回，但必须 **带 layer + score**，并 **按层填满配额**。  
**系统被动注入**：默认 **几乎只用 L_memory**，不足时少量 L_message.user；**不**把 L_evidence 直接塞进 bootstrap（避免 prompt 爆炸）。

---

## 4. 两种 API 形态

### 4.1 `search` — 主动检索（兼容并演进现有 session-search）

**调用方：** Agent curl、前端回忆面板、调试。

**语义：** 「在本 thread 里找与 query 相关的条目，给我可浏览/可下钻的列表」。

```http
GET /api/callbacks/session-search
  ?sessionId=
  &query=
  &limit=20
  &layers=memory,message,evidence   # 可选，默认全开
  &includeRetired=0
  &kinds=handoff,window-seal        # 仅对 memory 生效，可选
```

**响应（演进，向后兼容字段保留）：**

```json
{
  "query": "JWT 过期",
  "limit": 20,
  "hits": [
    {
      "layer": "memory",
      "sourceKind": "memory-entry",
      "sourceId": "mem_…",
      "kind": "memory.handoff",
      "snippet": "…",
      "score": 12.4,
      "ts": "…",
      "memoryId": "mem_…",
      "memoryStatus": "confirmed",
      "memoryKind": "handoff",
      "invocationId": "inv_…",
      "eventNo": null
    },
    {
      "layer": "evidence",
      "sourceKind": "invocation-event",
      "sourceId": "inv_…:12",
      "kind": "text.delta",
      "snippet": "…",
      "score": 3.1,
      "ts": "…",
      "invocationId": "inv_…",
      "eventNo": 12
    }
  ],
  "layers": { "memory": 3, "message": 2, "evidence": 15 },
  "truncated": false
}
```

旧客户端只读 `hits[].snippet/kind/invocationId` 仍可工作；新字段渐进增加。

### 4.2 `retrieveForTurn` — 被动召回（新，内部优先）

**调用方：** `bootstrap` / A2A inject（**不**依赖 Agent 自觉）。

**语义：** 「为这一轮 prompt 准备一小包高置信上下文」。

```js
// 默认数字与 design-alignment.md §2.4 一致
retrieveForTurn({
  threadId,
  prompt,                 // 本轮用户原文或 handoff task 摘要
  budgetChars: 4000,      // SHIFT_RETRIEVE_BUDGET_CHARS；A2A 调用传 2000
  recentLimit: 6,         // SHIFT_RETRIEVE_RECENT_LIMIT
  relatedLimit: 5,        // SHIFT_RETRIEVE_RELATED_LIMIT
  layers: ["memory"],     // 默认仅 memory；可选加 message
})
→ {
  items: MemoryHit[],     // 已去重、已排序、已截断
  rendered: string,       // 可直接拼进 prompt 的卡片
  stats: { usedChars, truncated, byKind }
}
```

**双通道合并（去重 by memoryId）：**

```text
Channel A  Recency: listActive(thread) 按 status+time
Channel B  Relevance: search(memory only, query=prompt)
Merge → rank → fit budget → render
```

这直接消灭 R2（不 curl 就失忆）。

### 4.3 `read` — 下钻（已有，契约补强）

保持 `read-invocation`；memory 下钻可用：

- 短期：hit 已含 snippet + content 足够短则无需再读
- 中期：`GET .../memories/:id` 或 search 返回 full content 对 memory 层默认带 `content`（≤2KB）

Evidence 仍：`search` → `read-invocation(target, from=eventNo-ε)`。

---

## 5. 统一检索核心（算法）

### 5.1 流水线

```text
                  normalizeQuery(q)
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   searchMemory    searchMessage   searchEvidence
   (repo/FTS)      (repo/FTS)      (repo/FTS + file?)
        │               │               │
        └───────────────┼───────────────┘
                        ▼
              filter (retired, kinds, event kinds)
                        ▼
              score each hit
                        ▼
              allocate by layer quotas
                        ▼
              merge + stable sort by score
                        ▼
              map to public hit DTO
```

**禁止**再使用「单一 flat search 先塞满 limit」作为唯一策略（现状 R5）。

### 5.2 Query 规范化

| 步骤 | 规则 |
|------|------|
| trim | 去首尾空白 |
| 长度 | 注入用 prompt 截断至 ~500 字作 query；主动 search 用用户原串，上限 200 字 |
| FTS | 沿用 token 抽取 + `"token" AND "token"`（多词收紧） |
| 空 query | `search` → `[]`；`retrieveForTurn` → **仅 recency 通道**（仍可注入最近记忆） |

空 query 的 recency 注入很重要：seal 后用户只说「继续」时，相关维可能很弱，时间维要托底。

### 5.3 索引文本规范化（治 R4）

写入 `recall_items.content` 时：

| source | 索引正文 |
|--------|----------|
| memory-entry | `memory.content`（已是可读模板） |
| message | `message.content` |
| invocation-event | **抽取器** `eventPlainText(kind, payload)` |

`eventPlainText` 建议：

```text
text.delta / thinking.delta  → payload.text
handoff                      → 序列化 summary 字段（what/why/…）
callback-post                → payload.content
user-prompt                  → payload.content
stderr                       → payload.text（可默认不入 FTS 或降权）
tool.*                       → 短摘要 name + 截断 output
其它                         → 有限字段拼接；禁止整包 JSON.stringify 作为首选
```

存量：提供 `rebuildThread` 重投影（已有）在迁移后跑一次。

### 5.4 过滤

| 过滤 | 默认 | 说明 |
|------|------|------|
| memory status | active only (`captured\|confirmed`) | `includeRetired=1` 可开 |
| evidence kinds | 排除或深降权 `thinking.delta`（可选配置） | 减少思考链噪声 |
| message 与 event 重复 | 保留现逻辑：assistant message 若绑 invocationId 可滤掉 | 避免双份 |
| thread 隔离 | 强制 `thread_id = ?` | 不变 |

### 5.5 打分（可测、可调）

```text
score =
  source_boost
  + status_boost
  + match_boost
  + recency_boost
  - noise_penalty
```

| 因子 | 建议值（起点，可调） |
|------|----------------------|
| source_boost memory | +100 |
| source_boost message.user | +40 |
| source_boost message.other | +20 |
| source_boost evidence.text.delta | +10 |
| source_boost evidence.handoff 事件 | +15 |
| source_boost evidence.thinking/tool/stderr | +2 / 0 |
| status_boost confirmed | +20 |
| status_boost captured | +10 |
| status_boost retired | 不参与（已滤） |
| match_boost exact id/title | +50 |
| match_boost FTS（用 -bm25 映射到 0..30） | 高相关更高 |
| match_boost contains only | +5 |
| recency_boost | 近 24h +5 … 衰减到 0 |
| noise_penalty | 超短 snippet、纯标点等 -5 |

**层内**按 score 排序；**层间**靠配额保证 memory 不被淹没，而不是只靠绝对分（双保险）。

### 5.6 层配额（治 R3 / R9）

对 `limit=20` 的默认主动搜索：

| Layer | 默认配额 | 说明 |
|-------|----------|------|
| memory | min(8, limit) | 先填 |
| message | min(4, remaining) | 次填 |
| evidence | remaining | 最后填证据 |

若 memory 不足，名额顺延给 message，再顺延 evidence。  
**禁止** evidence 先占满导致 memory 被截断——这是相对现状最重要的行为纠正。

`retrieveForTurn` 配额示例：

| 通道 | 条数 | 字符 |
|------|------|------|
| recency memory | ≤6 | 共享 budgetChars |
| related memory | ≤5 | 共享 budgetChars |
| optional user messages | ≤2 | 仅当 memory 极少时 |

---

## 6. 存储与查询实现策略

### 6.1 短期（与 memory 写入同步）

1. **Memory 查询权威源**：可直接 `memory_entries` +（可选）FTS 子查询，**不必**只经 flat `recall_items`。  
   - 优点：天然有 status/kind；supersede 语义清晰  
   - recall 投影仍用于统一 FTS 与 UI  
2. **Evidence/Message**：继续 `recall_items` search，但改 content 投影。  
3. **recall-service** 重构为编排器：`searchLayers` + score + quota，而不是单次 flat merge。

### 6.2 中期

- `recall_items` 增加生成列或 metadata 冗余：`layer`, `status`, `memory_kind` 便于 SQL 过滤  
- 或 FTS 分表 / 分 `source_kind` 权重查询（两次 query 再 merge）

### 6.3 文件 fallback（治 R8）

| 策略 | MVP |
|------|-----|
| 有 SQLite | **不扫文件**，除非 mode=files 或 sqlite 失败 |
| 仅 files | 限制：最近 N 个 invocation（如 20）或最近 M 分钟；仍子串匹配 |
| 双源 | dual 模式下以 SQLite 为准；file 只补 sqlite 没有的 invocationId |

逐步弱化「每次 search 都 merge 全文件」——这是性能与正确性双重负担。

### 6.4 mode 矩阵

| mode | search | retrieveForTurn |
|------|--------|-----------------|
| dual | SQLite 主 + 有限 file 补洞 | SQLite memory only |
| sqlite | 仅 SQLite | 仅 SQLite |
| files | 有限窗 JSONL | 空卡片 + 依赖 handoff 正文 |

---

## 7. 与注入、主动回忆的分工

```text
┌──────────────────────────────────────────────┐
│ Turn start                                   │
│  retrieveForTurn(prompt) → Memory Card       │  被动、高置信、有预算
└──────────────────────────────────────────────┘
                    │
                    │ 仍不够 / 要核对细节
                    ▼
┌──────────────────────────────────────────────┐
│ Agent: session-search (主动)                 │  可含 evidence
│ Agent: read-invocation (下钻)                │
└──────────────────────────────────────────────┘
```

**文案（callbacks / RECALL_RULE）应改为：**

1. 先阅读系统注入的 Active Memories  
2. 需要证据或 Memory 未覆盖 → `session-search`  
3. 命中 evidence → `read-invocation`  
4. 禁止在未检索时编造历史决策  

这样检索设计与 prompt 纪律一致，而不是只靠 curl 模板。

---

## 8. 命中契约（Hit DTO）

统一内部结构，对外兼容映射：

```ts
type RecallHit = {
  layer: "memory" | "message" | "evidence";
  sourceKind: "memory-entry" | "message" | "invocation-event";
  sourceId: string;
  kind: string;              // memory.handoff | message.user | text.delta | ...
  snippet: string;
  score: number;
  ts: string;
  // deep links
  memoryId?: string;
  memoryStatus?: "captured" | "confirmed" | "superseded" | "invalidated";
  memoryKind?: string;
  invocationId?: string;
  eventNo?: number | null;
  // optional payload for inject
  content?: string;          // memory 层建议带全文（短）
};
```

前端面板：可按 `layer` 分组展示。  
Agent：教其优先读 `layer=memory` 的 snippet/content。

---

## 9. 配置（建议 env，实施时再挂 brand.ENV）

| 配置 | 默认 | 含义 |
|------|------|------|
| `SHIFT_RETRIEVE_BUDGET_CHARS` | 4000 | 用户 turn 被动注入预算 |
| `SHIFT_RETRIEVE_A2A_BUDGET_CHARS` | 2000 | A2A compact Memory Card 预算 |
| `SHIFT_SEARCH_MEMORY_QUOTA` | 8 | 主动搜 memory 配额 |
| `SHIFT_SEARCH_MESSAGE_QUOTA` | 4 | message 配额 |
| `SHIFT_RETRIEVE_RECENT_LIMIT` | 6 | recency 条数 |
| `SHIFT_RETRIEVE_RELATED_LIMIT` | 5 | related 条数 |
| `SHIFT_SEARCH_INCLUDE_THINKING` | 0 | evidence 是否收录 thinking |
| `SHIFT_FILE_SEARCH_MAX_INVOCATIONS` | 20 | files fallback 窗 |

---

## 10. 模块落点（实施时）

| 模块 | 职责 |
|------|------|
| `src/storage/memory-service.js` | listActive / searchMemories / status 语义 |
| `src/storage/recall-repository.js` | 规范化投影；按 sourceKinds 查；可选 status 过滤 |
| `src/storage/retrieve-service.js` **或** 扩展 `recall-service.js` | 分层 search、score、quota、`retrieveForTurn` |
| `src/session/memory-inject.js` | **渲染纯函数**（Wave M 可先有）；本波次 `retrieveForTurn` 调用它 |
| `src/session/bootstrap.js` | **替换** Wave M 的 listActive 临时路径 → `retrieveForTurn` |
| `src/server/callback-routes.js` | session-search 参数与响应扩展 |
| `src/server/chat-routes.js` | user turn + A2A 注入改走 retrieveForTurn |
| dual-write / eventToRecall | plain text 投影 |

**推荐：** 在 `recall-service` 上演进；对外可保留 `searchTranscript` 名，内部分层。  
**A2A budget：** 调用时传 `budgetChars: 2000`（`SHIFT_RETRIEVE_A2A_BUDGET_CHARS`）。

---

## 11. 分期（= 全局 Wave R）

> **前置：Wave M 完成。** 不与「记忆写入」并行作为主路径（对齐总览 §3）。  
> 全局顺序：M → **R（本篇）** → H。

### R0 — 行为纠正与完整注入

1. 分层配额 + 基础 score  
2. **完整** `retrieveForTurn`（recency + related）；**删除/转发** Wave M 临时 bootstrap 注入  
3. A2A compact card 正式接入（2000）  
4. 默认过滤 retired；dual 下 search 优先 SQLite  

### R1 — 索引与体验

1. `eventPlainText` + rebuild  
2. session-search 响应 `layer` / `score` / `layers`  
3. evidence kind 降权；空 query → recency-only  
4. RECALL_RULE / callback 文案对齐  

### R2 — 增强（可选）

1. 前端按层展示  
2. 检索指标日志  
3. 非向量的分词增强（可选）

---

## 12. 测试要点

| 类型 | 用例 |
|------|------|
| unit | score 单调性：confirmed memory > user message > text.delta |
| unit | 配额：8 memory 候选 + 50 evidence → limit 20 时 memory≥min(8,available) |
| unit | retired 过滤 |
| unit | eventPlainText 不落整包 JSON |
| unit | retrieveForTurn 去重与 budget 截断 |
| integration | 写入 handoff memory 后 search 置顶 |
| integration | bootstrap 含 Memory Card 且无 evidence 长文 |
| integration | sqlite down → file/limited 降级 |

---

## 13. 决策摘要

1. **检索不是「一个 FTS 表扫到底」**，而是 **分层召回 + 统一打分 + 配额合并**。  
2. **被动 `retrieveForTurn` 与主动 `search` 必须拆分产品语义**，共享核心实现。  
3. **Memory 层是一等公民**；evidence 只服务下钻，默认不进 bootstrap。  
4. **先有 Wave M 写入，再做本篇**；无货时管道可测但产品 ROI 低。  
5. **不做向量**也能明显好于现状。  
6. **不负责** handoff policy；A2A 只提供 Memory Card API 供 Wave H 的 Receive Bundle 使用。

---

## 14. 与其它文档的关系

| 文档 | 关系 |
|------|------|
| [design-alignment.md](./design-alignment.md) | 预算、Wave 顺序、模块所有权 |
| [memory-system-design.md](./memory-system-design.md) | 提供 listActive/capture；M 的 recency 注入由本篇 R0 接管 |
| [handoff-design.md](./handoff-design.md) | Wave H 消费 `retrieveForTurn`；本篇不改 @ 路由 |

---

## 15. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-16 | 首版 |
| 2026-07-16 | 对齐：Wave R 前置 M；注入归属与 4000/2000；取消「与写入并行」主路径表述 |
| 2026-07-16 | 对齐：Wave R 前置 M；注入归属与 4000/2000；取消「与写入并行」主路径表述 |
