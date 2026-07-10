# 前端模块化与体验增强设计

**日期：** 2026-07-10  
**状态：** Proposed  
**范围：** P0 结构拆分 · P1 渲染/状态/流式体验 · P2 样式/a11y/依赖本地化  
**非目标：** 不迁移 Vue/React；不引入打包器作为前置条件；不改后端协议

---

## 1. 背景

当前前端是静态壳：

- `index.html` + `public/*.js` + `public/styles.css`
- 数据/客户端层已部分拆出：`api-client`、`session-api`、`session-controller`、`chat-client`、`session-runtime`、`workspace-diff` 等
- **视图编排仍高度集中在 `public/app.js`（≈2000+ 行）**，工作区整树重建、thinking 已采集未展示、CSS/依赖可维护性偏弱

产品定位是**本地多 Agent 协作台**，不是重型 SaaS。技术选型继续保持 **vanilla JS + 零构建可运行**，用模块边界和局部渲染换可维护性与体验，而不是换框架。

---

## 2. 目标

| 优先级 | 目标 | 成功标准 |
|--------|------|----------|
| **P0** | 按视图边界拆分 `app.js` | `app.js` ≤ ~500 行编排；新模块 dual-export（browser global + CommonJS）；现有行为与契约测试通过 |
| **P1** | 渲染性能 + 状态约定 + 流式体验 | 工作区选文件不全量重建；大 diff 有虚拟化/折叠；thinking/progress 可见；后台 session 侧栏有状态点 |
| **P2** | 样式拆分、无障碍、离线依赖 | CSS 按域拆分可维护；tab/mention 键盘与 ARIA 完整；Prism 本地 vendor；危险操作用统一确认 |

## 3. 非目标

1. **不**重写为 Vue / React / Next / Nuxt。
2. **不**强制上 Vite/Webpack 作为本阶段交付条件（允许后续可选）。
3. **不**改 SSE / agent-event / worktree / recall API 形状（除非发现明确 bug）。
4. **不**做完整 Git 客户端、分屏 IDE、消息虚拟列表的「全会话无限滚动」首版（消息虚拟化仅做可插拔钩子或 >N 条时再启用）。
5. **不**在本阶段引入设计系统组件库（如 shadcn）。

---

## 4. 架构原则

### 4.1 三层状态

```
state (可序列化 UI 选择)
  - currentSessionId, selectedAgent, rightPanelTab
  - workspace: { files, selectedPath, loading, error, ... }
  - mention*, projectDir, skillsMetadata, sessions[sid].lastPrompt/lastAgent

runtimeStore (per-session 运行时，不可丢)
  - controller, status, liveMessages, liveRuns, liveInvocations

DOM (纯派生)
  - 禁止把「展开/选中」只存在 DOM 上当唯一真相
  - 允许短暂 UI 缓存（如 scrollTop），但刷新后应可从 state/runtime 重建
```

### 4.2 模块模式

延续现有 dual-export：

```js
(function initXxx(globalScope) {
  "use strict";
  function createXxx(deps) { /* ... */ return api; }
  const api = { createXxx };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.Xxx = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- **纯函数模块**（无 DOM）：可直接 `require` 单测。
- **视图模块**：`createX(deps)` 注入 DOM refs + state + api，返回 `{ render, destroy?, ... }`。
- `app.js` 只负责：DOM refs、组装 `state`、接线 deps、事件绑定、启动。

### 4.3 渲染策略

| 区域 | 策略 |
|------|------|
| 流式正文 | 继续 plain-text node + rAF 合批；结束时再 `renderMd` |
| 工作区 | 壳层一次挂载；summary / fileList / diff 分区 `update*` |
| Diff | 行数超阈值虚拟化或折叠；小文件全量 |
| 会话列表 | 避免整表 `innerHTML` 字符串拼业务数据；用 createElement + textContent |
| 消息历史 | 首版不强制虚拟列表；预留 `MESSAGE_VIRTUAL_THRESHOLD` |

### 4.4 契约测试迁移策略

大量 `tests/server.test.js` 用 `fs.readFileSync("public/app.js")` + 正则锁行为。拆分时：

1. **行为锁**迁移到**真正拥有逻辑的新文件**（例如 workspace 渲染 → `workspace-panel.js`）。
2. `app.js` 只锁「接线」：`createWorkspacePanel` / `createMessageView` 调用存在。
3. 禁止长期双写「逻辑既在 app 又在模块」。

---

## 5. 目标文件结构

```
public/
  theme.js                 # P0 主题三态
  ui-confirm.js            # P2 统一确认对话框
  message-view.js          # P0/P1 消息创建、live stream、process trace、thinking/progress
  workspace-panel.js       # P0/P1 工作区 load + 分区渲染 + 虚拟 diff
  recall-panel.js          # P0 回忆列表/搜索/inline toggle
  mention-composer.js      # P0 @ 菜单
  session-list-view.js     # P0 侧栏会话列表 + run status 点
  display-helpers.js       # P0 roleDisplayName / agentLabel 等纯展示
  virtual-list.js          # P1 通用虚拟列表（diff 行优先）
  styles/
    tokens.css
    base.css
    shell.css
    messages.css
    workspace.css
    recall.css
    composer.css
    a11y.css
  vendor/
    prism/                 # P2 本地化
  styles.css               # 可选：开发期 @import 聚合，或 server 拼接；见实现计划
  app.js                   # 编排 ≤ ~500 行
```

`index.html` 按依赖顺序加载脚本；CSS 以「可拆可测」为准（见 P2 任务）。

---

## 6. 交互与体验规格（P1/P2 摘要）

### 6.1 Thinking / Progress

- `thinking.delta|final`：在 assistant 气泡内可折叠区块「思考过程」，默认**收起**；有内容时显示条数/字数提示。
- `progress.update`：渲染 checklist（`items[]` 的 label + status），替代仅 pending 单行文案。
- finalize 时：thinking 保留为折叠块（可选折叠进「过程」）；最终答案仍在 `.msg-final-content`。

### 6.2 后台 Session 状态

- `runtimeStore` 的 `status`（running / done / error / idle）映射到侧栏会话项指示点。
- 非当前 session 完成时：不抢焦点；仅更新点 + 可选 `title` 提示。

### 6.3 工作区局部更新

- `renderWorkspacePanel()` 拆为：
  - `ensureShell()` — 一次
  - `updateSummary(status)`
  - `updateFileList(files, selectedPath)` — 选中只改 class
  - `updateDiff(selectedFile)` — 仅 diff 区
- `selectedPath` 变更**不得**重建 file list DOM（除非 files 引用变化）。

### 6.4 无障碍（P2）

- 右侧 tab：`role="tablist"` 已有；补 `aria-controls`、方向键切换。
- mention：`role="listbox"` + `option` + `aria-activedescendant`。
- 发送按钮：running 时 `aria-busy="true"`，文案「停止」。
- 危险操作：`ui-confirm` 替代裸 `confirm()`（丢弃 worktree、删除会话）。

### 6.5 依赖

- Prism 从 jsDelivr CDN 迁到 `public/vendor/prism/`，`index.html` 改本地路径。
- 离线打开本地 UI 时高亮仍可用。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 拆分时契约测试大面积失败 | 先迁测试再迁代码；或同 PR 内同步改断言路径 |
| 分区渲染引入状态不同步 | workspace 单测覆盖 selectedPath 切换不重建 list |
| thinking UI 干扰阅读 | 默认折叠；样式弱化 |
| CSS 拆分导致加载顺序问题 | 首版用单一入口 `styles.css` 内 `@import` 或 server 顺序 serve；契约测 class 名不测文件物理位置 |
| 虚拟列表滚动跳动 | 固定行高估计 + overscan；超大 patch 优先「折叠 + 展开」 |

---

## 8. 里程碑

1. **M1 / P0**：模块拆完，行为不变，`app.js` 瘦身，测试绿。
2. **M2 / P1**：工作区局部更新 + 虚拟/折叠 diff + thinking/progress + 侧栏 status。
3. **M3 / P2**：CSS 域拆分 + a11y + confirm + Prism vendor。

每个里程碑可独立合并；不要求一次巨型 PR。

---

## 9. 决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 是否换 Vue | 否 | 成本高，核心资产是 runtime/SSE，不在模板语法 |
| 模块加载 | 继续 script 标签 + global | 零构建；与现有模块一致 |
| 状态库 | 不用 Redux/Pinia | 单页 + 已有 runtimeStore 足够 |
| 消息虚拟列表 | P1 仅预留阈值，默认不做 | 优先工作区 diff 卡顿 |
| 确认框 | 轻量自研 modal | 避免依赖；可测 |
