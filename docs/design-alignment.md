# 三份设计对齐总览（Canonical）

| 字段 | 值 |
|------|-----|
| 状态 | **Aligned** · 2026-07-16 |
| 子文档 | [memory-system-design.md](./memory-system-design.md) · [memory-retrieval-design.md](./memory-retrieval-design.md) · [handoff-design.md](./handoff-design.md) |
| 效力 | **本文裁定冲突**；子文档与本文矛盾时以本文为准，并应回写子文档 |

---

## 1. 一句话分工

| 文档 | 唯一职责 | 不负责 |
|------|----------|--------|
| **记忆系统** | 记忆 **写什么、何时写、生命周期、表/service** | 分层 FTS 排序细节；handoff policy / 路由门禁 |
| **记忆检索** | **如何找、如何排、如何被动注入**（`retrieveForTurn` / `search`） | capture 规则；handoff 协议字段 |
| **交接 handoff** | **@ 路由 + packet 协议 + policy + Receive Bundle 任务侧** | 发明第二套 memory 存储；重做 FTS |

```text
Evidence (transcript/events/messages)
        │ project
        ▼
   Recall Index  ←── 检索篇治理（score/quota/plainText）
        ▲
        │ index
   Memory Entries ←── 记忆篇治理（capture/status/fingerprint）
        │
        ▼ retrieveForTurn / listActive
   Prompt 注入    ←── 检索篇产出卡片；记忆篇定义条目语义
        │
   Handoff Packet ←── 交接篇：当棒契约 + policy
        │ promote (最小钩子在 Wave M，完整 finalize 在 Wave H)
        ▼
   Memory (kind=handoff)
```

---

## 2. 已裁定的统一决策（消除矛盾）

### 2.1 三层语义（三文档共用）

| 层 | 名称 | 存什么 |
|----|------|--------|
| L1 | Evidence | transcript / messages / invocation_events |
| L2 | Recall Index | `recall_items` + FTS（投影，非真相源） |
| L3 | Memory | `memory_entries`（决策资产） |

检索侧对外 hit 的 `layer` 枚举：`memory` | `message` | `evidence`（与 L3/消息/L1 过程证据对应）。

### 2.2 Handoff → Memory 晋升（唯一规则）

| 条件 | 写 memory？ | kind | status |
|------|-------------|------|--------|
| `hasBlock && ok` | 是 | `handoff` | `confirmed` |
| `hasBlock && !ok` | 是 | `handoff` | `captured` |
| `!hasBlock`（emptyPacket） | **否** | — | — |
| 同 thread + 同 fingerprint（MVP：`handoff:{from}:{to}`） | supersede 旧 active | | |

- **路由目标 `toAgentId` 以行首 @ 为准**（不是 packet.to）。  
- **Wave M 即可接线**：用**现有** `extractPrimaryHandoff` / `evaluateHandoff`，**不**引入 policy 门禁。  
- **Wave H** 再改 policy / Receive Bundle / 多目标选包；capture 规则不变，只换调用点到 `finalizeA2ARoutes`。

### 2.3 Window-seal → Memory（唯一规则）

- seal 成功且 abandon provider 前：`kind=window-seal`，`status=captured`，fingerprint `window-seal:{windowId}` 幂等。  
- 规则模板摘要，**不**默认调 LLM。  
- 属 **Wave M**，与 handoff 增强无关。

### 2.4 注入预算（唯一数字）

| 场景 | 配置键 | 默认 |
|------|--------|------|
| 用户 turn bootstrap Memory Card | `SHIFT_RETRIEVE_BUDGET_CHARS` | **4000** |
| A2A 后继 Compact Memory Card | `SHIFT_RETRIEVE_A2A_BUDGET_CHARS` | **2000** |
| 单条 memory.content 建议上限 | — | **2048** |
| retrieveForTurn recency 条数 | `SHIFT_RETRIEVE_RECENT_LIMIT` | **6** |
| retrieveForTurn related 条数 | `SHIFT_RETRIEVE_RELATED_LIMIT` | **5** |
| 主动 search memory 配额 | `SHIFT_SEARCH_MEMORY_QUOTA` | **8** |
| 主动 search message 配额 | `SHIFT_SEARCH_MESSAGE_QUOTA` | **4** |

> 作废：记忆篇旧文「3000～6000」模糊区间；一律以本表为准。

### 2.5 谁渲染 Memory Card（唯一归属）

| 能力 | 模块 | 波次 |
|------|------|------|
| `listActive` / capture / transition | `memory-service` | Wave M |
| 卡片字符串渲染（纯函数） | `memory-inject.js` | Wave M 可先做最小版 |
| `retrieveForTurn`（recency + related + budget） | **扩展 `recall-service`（或 retrieve-service）** | **Wave R 完整实现** |
| bootstrap / A2A 调用注入 | `bootstrap.js` / `chat-routes` | M：仅 listActive 最小注入；R：换 `retrieveForTurn` |

**Wave M 注入 = 仅时间维 listActive（recency-only）。**  
**Wave R 注入 = 完整 `retrieveForTurn`（recency + related）。**  
禁止两套并行「各写各的 bootstrap 拼装逻辑」长期共存；R 落地后 M 的临时路径删除或薄封装转发。

### 2.6 Handoff 路由策略（分波次，禁止文档互斥）

| 波次 | 路由行为 |
|------|----------|
| **Wave M / R** | **保持现状 soft**：有 @ 就入队；缺包 → degraded 渲染（现有 `renderHandoffTask`） |
| **Wave H** | 引入 `SHIFT_HANDOFF_POLICY`：默认 **`balanced`**；`soft` 可回滚；worktree 无 fence → `request_repair` |

记忆篇**不得**再写「永远不改 soft」为终态；应写「Wave M/R 保持 soft，policy 见 handoff 篇 Wave H」。  
交接篇 **G4** 用语统一为 policy=`balanced`/`strict`，**不用**模糊词 `harden`。

### 2.7 主动搜索 vs 被动注入（唯一产品语义）

| API | 调用方 | 默认 layers | 波次 |
|-----|--------|-------------|------|
| `retrieveForTurn` | 系统 bootstrap / A2A | **仅 memory**（memory 极少时可附带 ≤2 user message，见检索篇） | R 完整；M 可用 listActive 子集 |
| `search` / session-search | Agent / UI | memory+message+evidence 分层配额 | R |
| `read-invocation` | 下钻 evidence | — | 已有 |

### 2.8 失败降级（共用）

- SQLite / capture / retrieve 失败 → **log + 空结果**，**永不阻断** chat / 路由（除 Wave H 的显式 `request_repair`）。  
- `storageMode=files`：无 memory 闭环；依赖 handoff 正文 + 有限文件 search。

### 2.9 非目标（三文档一致）

- 不做向量检索（远期可选，非前置）  
- 不推倒 dual-write / JSONL  
- 不重写 @ 行首路由模型  
- Wave M **不**做 handoff hard-block / balanced policy  
- 不做跨 thread 全局画像  

---

## 3. 推荐执行顺序（回答：对，但有精确切分）

### 结论

**是的：先记忆 → 再检索 → 最后补强 handoff。**  
这是依赖方向正确的顺序。但必须采用下面的 **Wave 切分**，避免「记忆波次做完检索/交接」或「交接波次才第一次写 memory」。

```text
Wave M  记忆系统（写 + 生命周期 + 最小注入）
   │
   ▼
Wave R  记忆检索（分层 search + retrieveForTurn 完整注入）
   │
   ▼
Wave H  交接补强（policy + Receive Bundle + 多目标 + 回调统一）
```

### 3.1 Wave M — 记忆系统（先做）

**目标：** 生产环境 `memory_entries` 不再长期为 0；seal 后有遗书；bootstrap 至少能塞最近记忆。

| 做 | 不做 |
|----|------|
| `memory-service` + repo `listActive` / fingerprint / migration v3（建议） | 分层 FTS score/quota 大改 |
| **最小** handoff capture（现有 parser，规则 §2.2） | handoff policy / repair / 改 soft |
| window-seal capture | Receive Bundle 重做 |
| bootstrap **recency-only** Memory Card（budget 4000） | related 检索通道（留给 R） |
| A2A **可选**塞 listActive 截断 2000 字（临时） | 完整 compact retrieveForTurn |
| `memory-captured` SSE/transcript（建议） | session-search 响应 layer 字段大改 |
| 单测 S1/S2 + 最小 S3（仅 recency） | T1–T5 全套检索验收 |

**验收锚点：** 记忆篇 S1、S2、S5；S3 按 recency 部分满足。

### 3.2 Wave R — 记忆检索（第二）

**依赖：** Wave M 已有可注入数据（否则管道正确但效果空）。

| 做 | 不做 |
|----|------|
| `retrieveForTurn` 完整双通道，替换 M 临时注入 | 改 handoff 字段协议 |
| 分层 search + score + 配额 | policy balanced |
| retired 过滤、session-search `layer`/`score` | intent/verdict 协议 |
| `eventPlainText` 投影 + rebuild（可拆 PR） | |
| RECALL_RULE / callback 文案对齐「先读卡再 search」 | |
| A2A 正式走 compact `retrieveForTurn` | |

**验收锚点：** 检索篇 T1–T6；记忆篇 S3 完整、S4。

### 3.3 Wave H — 交接补强（最后）

**依赖：** M 的 capture API、R 的 `retrieveForTurn` / Memory Card。

| 做 | 不做 |
|----|------|
| policy soft/balanced/strict | 再发明 memory 写入规则（复用 §2.2） |
| Receive Bundle（任务卡顺序、appendix、mismatch 横幅） | 重做 FTS |
| 多目标选包诚实化 | |
| `finalizeA2ARoutes` 统一主循环与 callback；**capture 迁入此处** | |
| 默认 balanced；soft 回滚开关 | 默认强制 strict |

**验收锚点：** 交接篇 G1–G8（G5/G6 应在 M/R 已满足，H 回归锁定）。

### 3.4 为什么不能颠倒

| 若先做… | 问题 |
|---------|------|
| 先 Handoff policy | 无 memory，Receive Bundle 的 memory 卡仍空；repair 体验好但跨轮仍丢线 |
| 先完整 Retrieval | 无写入，分层排序「正确但无货」；ROI 低 |
| 记忆不写 handoff capture、等 H3 | seal 有遗书但 A2A 要点仍不落库，M 的 S1 落空 |

**允许的唯一「交叉最小集」：** Wave M 调用**现有** handoff **解析**做 capture——这不是「做交接重构」，只是消费已有 API。

### 3.5 与子文档旧分期的映射

| 旧说法 | 归入 |
|--------|------|
| 记忆 Phase 0–1（地基+会写） | **Wave M** |
| 记忆 Phase 2 最小 listActive 注入 | **Wave M** |
| 记忆 Phase 2/3 相关检索合并、recall 排序 | **Wave R**（从记忆篇划出） |
| 检索 P0–P1 | **Wave R** |
| 交接 H0 可观测/选包 | **Wave H** 前部（可与 R 尾并行，但不阻塞 R） |
| 交接 H1 Receive Bundle + memory 卡 | **Wave H**（依赖 R） |
| 交接 H2 policy | **Wave H** |
| 交接 H3「记忆晋升」 | **晋升已在 Wave M**；H3 改为「finalize 复用 capture + 回调对齐」 |

---

## 4. 模块所有权（防重复实现）

| 模块 | Owner 文档 | 备注 |
|------|------------|------|
| `memory-repository` / `memory-service` | 记忆 | |
| `memory-inject.js` | 记忆定义格式；检索调用 | 渲染纯函数，两边可测 |
| `recall-repository` plainText / FTS | 检索 | |
| `recall-service` search + retrieveForTurn | 检索 | |
| `bootstrap.js` | 记忆定义卡片语义；检索提供 retrieve API | |
| `handoff.js` parse/evaluate/render | 交接 | Wave M 只读调用 evaluate |
| `handoff-policy.js` / `a2a-finalize.js` | 交接 | Wave H |
| dual-write evidence 投影 | 检索（plainText）+ 既有存储 | 不在此写 memory 业务 |

---

## 5. 开放问题（仅保留未裁定项）

以下已在对齐中 **拍板**：

- emptyPacket 不写 memory → **是**  
- 默认执行序 M→R→H → **是**  
- 注入预算 4000/2000 → **是**  
- Wave M/R 保持 soft 路由 → **是**  
- Wave H 默认 balanced → **是**  

仍可选产品微调（不阻塞开工）：

| ID | 问题 | 建议 |
|----|------|------|
| O1 | Wave H worktree 无 fence：repair vs degraded | repair（balanced） |
| O2 | 是否上 migration v3（fingerprint 列） | 建议上，Wave M |
| O3 | intent/verdict 协议何时进 skill | Wave H4 可选 |

---

## 6. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-16 | 首版对齐：职责、预算、晋升规则、Wave M→R→H、消解 soft/policy 与注入归属矛盾 |
