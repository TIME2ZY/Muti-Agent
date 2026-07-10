# Frontend Modularization & UX Hardening Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox (`- [ ]`) syntax. Prefer small commits per task. Do **not** introduce Vue/React or a bundler unless a later task explicitly says so.

**Goal:** 在保持静态 vanilla 前端的前提下，完成 P0 视图拆分、P1 渲染/状态/流式体验、P2 样式/a11y/依赖本地化，使 `app.js` 降为编排层，并提升工作区与流式可读性。

**Architecture:** 延续 dual-export IIFE（browser global + CommonJS）。按视图边界抽出 `createX(deps)` 工厂；`state` 只存可序列化 UI 选择，`runtimeStore` 存 per-session live；DOM 纯派生。契约测试从「锁 app.js 全文」迁移到「锁拥有逻辑的模块 + app 接线」。

**Tech Stack:** Static HTML, vanilla JS, CSS, Node.js built-in test runner, existing SSE / worktree / recall APIs

**Design doc:** `docs/superpowers/specs/2026-07-10-frontend-modularization-design.md`

---

## File Structure (target)

| File | Action | Responsibility |
|------|--------|----------------|
| `public/display-helpers.js` | Create | `roleDisplayName`, `roleBadgeLabel`, `agentLabel`, `agentMeta`, `agentMention`, `agentRoleSummary`, `fmtTime` |
| `public/theme.js` | Create | system/light/dark cycle + localStorage |
| `public/message-view.js` | Create | createMessage, live stream rAF, process trace, thinking/progress UI, finalize |
| `public/workspace-panel.js` | Create | load workspace, shell + partial updates, discard |
| `public/recall-panel.js` | Create | session recall list/search + per-message toggle helpers |
| `public/mention-composer.js` | Create | @ menu open/nav/select |
| `public/session-list-view.js` | Create | session list render + runtime status dots |
| `public/virtual-list.js` | Create | fixed-row virtual list for diff lines |
| `public/ui-confirm.js` | Create | modal confirm replacing `window.confirm` |
| `public/styles/*.css` | Create | domain-split styles |
| `public/vendor/prism/*` | Create | vendored Prism assets |
| `public/app.js` | Modify | orchestration only (~300–500 lines) |
| `public/styles.css` | Modify | become aggregator or thin re-export |
| `index.html` | Modify | script/link order, a11y attrs, local Prism |
| `package.json` | Modify | `check` script includes new public modules |
| `tests/*.js` | Create/Modify | unit tests for new modules + migrate server.test contracts |

**Invariant during all tasks:** `npm test` / `node --test tests/**/*.js` stays green before merge of each milestone.

---

# Milestone M1 — P0: Split `app.js` (behavior-preserving)

---

### Task 1: Extract pure display helpers

**Files:**
- Create: `public/display-helpers.js`
- Create: `tests/display-helpers.test.js`
- Modify: `public/app.js` (use helpers)
- Modify: `index.html` (script tag before app.js)
- Modify: `tests/server.test.js` (point identity assertions at new file)
- Modify: `package.json` (`node --check public/display-helpers.js`)

- [ ] **Step 1: Write failing unit tests**

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  roleDisplayName,
  roleBadgeLabel,
  agentLabel,
  agentMention,
  agentMeta,
  agentRoleSummary,
  fmtTime,
} = require("../public/display-helpers.js");

test("roleDisplayName maps user and agent", () => {
  assert.equal(roleDisplayName("user"), "用户");
  assert.equal(
    roleDisplayName("assistant", "architect", [{ id: "architect", name: "Architect" }]),
    "Architect"
  );
});

test("roleBadgeLabel covers roles", () => {
  assert.equal(roleBadgeLabel("user"), "发起者");
  assert.equal(roleBadgeLabel("assistant"), "Agent");
  assert.equal(roleBadgeLabel("system"), "系统");
});
```

- [ ] **Step 2: Run test — expect FAIL (module missing)**

```bash
node --test tests/display-helpers.test.js
```

- [ ] **Step 3: Implement `display-helpers.js`**

Move from `app.js` without behavior change. Agents list is passed in (or bound via `createDisplayHelpers({ getAgents })`) so the module stays pure.

Recommended API:

```js
function createDisplayHelpers({ getAgents }) {
  function agentLabel(id) { /* find in getAgents() */ }
  // ...
  return { roleDisplayName, roleBadgeLabel, agentLabel, agentMention, agentMeta, agentRoleLabel, agentRoleSummary, fmtTime };
}
// Also export pure functions that accept agents array for tests.
```

- [ ] **Step 4: Wire in `app.js` + `index.html`; update server.test identity contracts**

```js
// server.test.js — prefer:
const js = fs.readFileSync(path.join(__dirname, "../public/display-helpers.js"), "utf8");
assert.match(js, /roleDisplayName/);
// app.js still must call helpers when building meta:
assert.match(appJs, /roleDisplayName\(/);
```

- [ ] **Step 5: Run full frontend-related tests**

```bash
node --test tests/display-helpers.test.js tests/server.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/display-helpers.js public/app.js index.html tests/display-helpers.test.js tests/server.test.js package.json
git commit -m "refactor(frontend): extract display-helpers from app.js"
```

---

### Task 2: Extract theme module

**Files:**
- Create: `public/theme.js`
- Create: `tests/theme.test.js`
- Modify: `public/app.js`, `index.html`, `package.json`

- [ ] **Step 1: Tests for cycle and apply**

```js
const { createThemeController } = require("../public/theme.js");

test("theme cycles system → light → dark → system", () => {
  const storage = new Map();
  const doc = { documentElement: { attributes: {}, setAttribute(k,v){ this.attributes[k]=v; }, removeAttribute(k){ delete this.attributes[k]; } } };
  // inject localStorage-like + toggle element mock
  const theme = createThemeController({
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v) },
    root: doc.documentElement,
    toggleEl: { textContent: "", title: "", setAttribute() {} },
    key: "agent-chat-theme",
  });
  theme.init();
  assert.equal(theme.current(), "system");
  theme.cycle();
  assert.equal(theme.current(), "light");
});
```

- [ ] **Step 2: Implement + wire; remove theme block from app.js**

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(frontend): extract theme controller"
```

---

### Task 3: Extract mention composer

**Files:**
- Create: `public/mention-composer.js`
- Create: `tests/mention-composer.test.js`
- Modify: `public/app.js`, `index.html`

**API sketch:**

```js
createMentionComposer({
  promptEl, menuEl, state, getAgents, setDefaultAgent, agentMention, agentMeta, updateActiveSkills,
})
// returns: { update, hide, handleKeydown, isOpen }
```

- [ ] **Step 1: Unit-test pure trigger parsing**

Export `getMentionTrigger(value, cursorPos)` for Node tests (no DOM).

```js
test("getMentionTrigger detects @query at cursor", () => {
  const t = getMentionTrigger("hello @arc", 10);
  assert.equal(t.query, "arc");
  assert.equal(t.start, 6);
});
```

- [ ] **Step 2: Move menu render/select/hide from app.js**

- [ ] **Step 3: app.js keydown delegates to `mention.handleKeydown(e)` before send shortcut**

Preserve IME guard in app or mention module (must keep `e.isComposing || e.keyCode === 229`).

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(frontend): extract mention composer"
```

---

### Task 4: Extract session list view

**Files:**
- Create: `public/session-list-view.js`
- Modify: `public/app.js`, `index.html`
- Modify: `tests/server.test.js` (session list / status contracts if any)

**API:**

```js
createSessionListView({
  sessionListEl,
  getCurrentSessionId,
  getRuntimeStatus, // (sessionId) => 'idle'|'running'|'done'|'error'
  onSelect, onDelete,
})
// returns { render(sessions) }
```

- [ ] **Step 1: Replace `renderSessionList` body with module call**

Rules:

- No business strings via unescaped `innerHTML` for titles; use `textContent`.
- Delete button remains keyboard-focusable (existing CSS contract).

- [ ] **Step 2: Add placeholder for status dot element** (class only; fill in P1 Task 10)

```html
<span class="session-run-dot" data-status="idle" hidden></span>
```

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(frontend): extract session list view"
```

---

### Task 5: Extract workspace panel module (behavior-preserving move)

**Files:**
- Create: `public/workspace-panel.js`
- Create: `tests/workspace-panel.test.js` (logic that does not need full DOM if possible)
- Modify: `public/app.js`, `index.html`, `tests/server.test.js`

Move intact:

- `emptyWorkspaceState`
- `loadWorkspaceState`
- `discardWorkspace`
- `renderWorkspaceFileList` / `renderWorkspaceDiff` / `renderWorkspacePanel`
- right-tab integration stays in app: `setRightPanelTab` calls `workspace.render()` / `workspace.load()`

**API:**

```js
createWorkspacePanel({
  panelEl, state, worktreeApi, confirmImpl, // confirm still window.confirm until P2
  WorkspaceDiff: window.WorkspaceDiff,
  escHtml,
  onAfterDiscard, // refresh header worktree status
})
// returns {
//   emptyState, load, render, discard,
//   // P1 will add: updateSelection(path)
// }
```

- [ ] **Step 1: Migrate server.test workspace contracts to `workspace-panel.js`**

```js
test("frontend workspace panel loads status and diff", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public/workspace-panel.js"), "utf8");
  assert.match(js, /readStatus/);
  assert.match(js, /readDiff/);
  assert.match(js, /parseUnifiedDiff/);
  assert.match(js, /discard/);
});
```

Keep a thin app.js contract:

```js
assert.match(appJs, /createWorkspacePanel/);
```

- [ ] **Step 2: Move code; app only constructs and calls**

- [ ] **Step 3: Manual smoke checklist (document in commit body)**

1. Open 工作区 tab → loading → empty/missing worktree  
2. Dirty worktree → file list + diff colors  
3. Select second file → diff changes  
4. 丢弃 worktree → confirm → clean  

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(frontend): extract workspace-panel module"
```

---

### Task 6: Extract recall panel module

**Files:**
- Create: `public/recall-panel.js`
- Modify: `public/app.js`, `index.html`, `tests/server.test.js`

Move:

- `eventBodyText`, `renderEventList`, `fetchInvocationEvents`, `renderRecallPageMeta`
- `loadRecallList`, `renderRecallList`, `toggleRecallItem`, search hits
- `attachRecallToggle`, `toggleMessageRecall` (or export attach for message-view)

**API:**

```js
createRecallPanel({
  bodyEl, searchInputEl, state, recallApi, agentLabel, fmtTime,
})
// returns { loadList, runSearch, attachMessageToggle(wrapper, invocationId), eventBodyText }
```

- [ ] **Step 1: Move semantic event body contracts to recall-panel.js**

Existing test:

```js
assert.match(js, /tool\.started/);
assert.match(js, /subagent\.completed/);
// etc. — retarget file path
```

- [ ] **Step 2: Wire recall tab `setRightPanelTab("recall")` → `recall.loadList()`**

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(frontend): extract recall-panel module"
```

---

### Task 7: Extract message view + live pipeline

**Files:**
- Create: `public/message-view.js`
- Modify: `public/app.js`, `public/chat-client.js` (deps only if needed), `index.html`
- Modify: `tests/server.test.js` (live stream / process contracts)

This is the largest P0 task. Move as a cohesive unit:

- `createMessage`, `showThinking`, `stopThinking`, `appendLive`, rAF flush
- `applyAgentEvent`, `ensureLiveRun`, process/subagent panels
- `finalizeLiveMessages`, `finishStream`, `hydrateProcessTrace`
- `addSystem`, `addDebug`, `remountLiveMessages`
- badge helpers, scroll/spacer/empty helpers used only by messages

**API:**

```js
createMessageView({
  messagesEl, emptyStateEl, spacerEl, state, runtimeStore,
  renderMd, escHtml, writeClipboard / copy helper,
  recall: { attachMessageToggle },
  display: { roleDisplayName, roleBadgeLabel, agentLabel },
  scrollParent: messagesEl,
})
// returns {
//   createMessage, showThinking, stopThinking, appendLive, applyAgentEvent,
//   flushPendingLiveRender, finalizeLiveMessages, finishStream,
//   remountLiveMessages, addSystem, addDebug, ensureSpacer, showEmpty, hideEmpty,
// }
```

- [ ] **Step 1: Update contracts that grep app.js for live streaming**

Retarget to `message-view.js`:

- plain-text live streaming (`_liveTextEl`, `requestAnimationFrame`)
- thinking badge-only (until P1 expands UI — keep current behavior in this task)
- progress before first text
- live subagent cards
- process panel rebuild on finalize

app.js contract becomes dependency injection into `ChatClient` / `SessionController`.

- [ ] **Step 2: Implement extraction with zero UX change**

Do **not** add thinking panel UI in this task.

- [ ] **Step 3: Run**

```bash
node --test tests/server.test.js tests/chat-client.test.js tests/session-controller.test.js tests/session-runtime.test.js
```

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(frontend): extract message-view live pipeline"
```

---

### Task 8: Slim `app.js` to orchestrator + lock size budget

**Files:**
- Modify: `public/app.js`
- Modify: `tests/server.test.js` or `tests/app-orchestrator.test.js`
- Modify: `package.json` check list complete for all new files

- [ ] **Step 1: app.js should only contain**

1. DOM refs  
2. `state` object  
3. Module construction (`createX`)  
4. `setRightPanelTab`, project-dir edit, skills bar  
5. Event bindings + `init`  
6. Thin wrappers if session-controller still needs callbacks  

Target: **≤ 500 lines** (soft gate).

- [ ] **Step 2: Add regression test**

```js
test("app.js stays an orchestrator under line budget", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const lines = js.split(/\r?\n/).length;
  assert.ok(lines <= 550, `app.js has ${lines} lines; expected <= 550 after P0 split`);
  assert.match(js, /createMessageView/);
  assert.match(js, /createWorkspacePanel/);
  assert.match(js, /createRecallPanel/);
  assert.match(js, /createMentionComposer/);
  assert.match(js, /createSessionListView/);
  assert.match(js, /createThemeController/);
});
```

- [ ] **Step 3: Verify index.html script order**

Recommended order:

```html
api-client.js
display-helpers.js
agent-routing.js
session-runtime.js
session-api.js
session-controller.js
worktree-api.js
recall-api.js
chat-client.js
markdown-lite.js
clipboard.js
latest-request.js
workspace-diff.js
virtual-list.js        <!-- may land in P1; stub ok -->
theme.js
mention-composer.js
session-list-view.js
message-view.js
workspace-panel.js
recall-panel.js
ui-confirm.js          <!-- P2; stub optional -->
app.js
```

- [ ] **Step 4: Full test suite**

```bash
npm test
npm run check
```

- [ ] **Step 5: Commit — M1 complete**

```bash
git commit -m "refactor(frontend): complete P0 app.js orchestrator split"
```

---

# Milestone M2 — P1: Render performance, state rules, streaming UX

---

### Task 9: Workspace partial updates (no full panel rebuild on select)

**Files:**
- Modify: `public/workspace-panel.js`
- Create/Modify: `tests/workspace-panel.test.js`
- Modify: `public/styles.css` or `styles/workspace.css` (only if needed)

- [ ] **Step 1: Refactor render into shell + regions**

```js
// Internal structure after ensureShell():
// .workspace-panel-body
//   .workspace-summary-host
//   .workspace-actions-host
//   .workspace-files-host
//   .workspace-diff-host
```

Rules:

| Event | DOM ops |
|-------|---------|
| `load()` start/end | update hosts; may rebuild files if `files` identity/paths changed |
| `selectedPath` change | toggle `.selected` on file buttons; **only** re-render diff host |
| refresh same files | update summary meta; diff if selection still valid |

- [ ] **Step 2: Test with minimal DOM mock or jsdom-free instrumentation**

If full DOM is hard, expose:

```js
function shouldRebuildFileList(prevFiles, nextFiles) { /* path+status equality */ }
```

and unit-test that.

Optional DOM integration: mark `data-render-gen` on file list; assert unchanged after selection-only update.

- [ ] **Step 3: Commit**

```bash
git commit -m "perf(frontend): partial updates for workspace panel selection"
```

---

### Task 10: Virtual list utility + large diff rendering

**Files:**
- Create: `public/virtual-list.js`
- Create: `tests/virtual-list.test.js`
- Modify: `public/workspace-panel.js`
- Modify: `index.html`, `package.json`

**API:**

```js
createVirtualList({
  containerEl,
  rowHeight,      // e.g. 18
  overscan,       // e.g. 8
  getCount,       // () => number
  renderRow,      // (index, rowEl) => void
})
// returns { refresh, scrollTo(index), destroy }
```

- [ ] **Step 1: Unit-test window calculation**

```js
const { visibleRange } = require("../public/virtual-list.js");
assert.deepEqual(visibleRange({ scrollTop: 180, viewport: 200, rowHeight: 18, count: 1000, overscan: 2 }), {
  start: 8, // floor(180/18)-2
  end: 22,  // ceil((180+200)/18)+2
});
```

- [ ] **Step 2: Workspace diff integration**

- If `lines.length <= DIFF_VIRTUAL_THRESHOLD` (e.g. 400): keep simple full render (current).  
- If above: use virtual list; row class still `workspace-diff-line-added|removed`.  
- Show truncation banner if `diffTruncated` (already exists).

- [ ] **Step 3: Optional collapse for huge single files**

If `lines.length > 2000`, default collapse to first/last 100 + button「展开全部（可能卡顿）」.

- [ ] **Step 4: Commit**

```bash
git commit -m "perf(frontend): virtualize large workspace diffs"
```

---

### Task 11: Document and enforce state ownership

**Files:**
- Modify: `public/app.js` (comment block + fix duplicate assignments)
- Modify: `public/workspace-panel.js`, `public/session-list-view.js`, `public/message-view.js` as needed
- Create: `docs/superpowers/specs/2026-07-10-frontend-modularization-design.md` already has §4.1 — link from app.js header

- [ ] **Step 1: Fix known smell**

`panelTabWorkspace` click currently sets `state.rightPanelTab` then calls `setRightPanelTab` — single path only:

```js
panelTabWorkspaceEl.addEventListener("click", async () => {
  setRightPanelTab("workspace");
  await workspacePanel.load();
});
```

- [ ] **Step 2: Expand state shape comments**

```js
const state = {
  // UI selection (serializable)
  currentSessionId: null,
  selectedAgent: "architect",
  rightPanelTab: "agents", // agents | workspace | recall
  workspace: emptyWorkspaceState(),
  // ...
  // NOT live run data — see runtimeStore
};
```

- [ ] **Step 3: Commit**

```bash
git commit -m "docs(frontend): clarify state vs runtimeStore ownership"
```

---

### Task 12: Thinking block + progress checklist in message view

**Files:**
- Modify: `public/message-view.js`
- Modify: `public/styles.css` or `styles/messages.css`
- Modify: `tests/server.test.js` / `tests/message-view.test.js`

**Behavior:**

1. On `thinking.delta` / `thinking.final`: accumulate `run.thinking` (already) **and** update a collapsed panel in the live bubble:

```html
<details class="msg-thinking">
  <summary>思考过程</summary>
  <pre class="msg-thinking-body"></pre>
</details>
```

Default **closed**. While streaming thinking, optional `data-live="true"` on details.

2. On `progress.update`: render checklist above live text:

```html
<ul class="msg-progress">
  <li class="is-done|is-active|is-pending">...</li>
</ul>
```

Map item fields defensively (`label` / `text` / `status` / `done` — match actual server payload in `event-protocol` / fixtures).

3. Finalize:

- Keep thinking `<details>` if non-empty (still collapsed).  
- Keep or clear progress list (prefer keep completed checklist until hydrate from transcript decides otherwise).  
- Final markdown content in `.msg-final-content` unchanged.

- [ ] **Step 1: Inspect real progress payload**

```bash
# sample from data/runtime/raw-events or tests
rg "progress.update" -n src tests data/runtime/raw-events | head
```

Align field names before coding.

- [ ] **Step 2: Update obsolete contract**

Current test may say “thinking and writing as badge-only”. Replace with:

```js
test("frontend surfaces thinking in a collapsed details block", () => {
  const js = fs.readFileSync(..., "message-view.js");
  assert.match(js, /msg-thinking/);
  assert.match(js, /thinking\.delta/);
});
```

- [ ] **Step 3: CSS for muted thinking / progress**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(frontend): show collapsible thinking and progress checklist"
```

---

### Task 13: Sidebar runtime status indicators

**Files:**
- Modify: `public/session-list-view.js`
- Modify: `public/app.js` (`onRuntimeStatusChange`)
- Modify: styles
- Modify: tests

- [ ] **Step 1: Map status → dot**

| status | class | visible |
|--------|-------|---------|
| running | `session-run-dot is-running` | yes |
| done | `is-done` | yes until session opened? **yes for 1 session view cycle; clear when user selects session** optional — simpler: show done/error until next run |
| error | `is-error` | yes |
| idle | hidden | no |

- [ ] **Step 2: `onRuntimeStatusChange` re-renders list dots without full session fetch**

Prefer `sessionListView.updateStatus(sessionId, status)` over full `refreshSessionList`.

- [ ] **Step 3: CSS pulse for running (`prefers-reduced-motion` → static)**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(frontend): session list runtime status dots"
```

---

### Task 14: Message history threshold hook (lightweight)

**Files:**
- Modify: `public/message-view.js`
- Optional test

- [ ] **Step 1: Add constant and guard comment**

```js
const MESSAGE_VIRTUAL_THRESHOLD = 250;
// When messagesEl child count exceeds threshold on history load,
// future: windowed render. For now, only log-once or skip heavy hydrate.
```

- [ ] **Step 2: On history load path in session-controller / message-view**

If `messages.length > MESSAGE_VIRTUAL_THRESHOLD`, still render all (behavior preserve) but:

- defer `hydrateProcessTrace` with `requestIdleCallback` / chunked `setTimeout` to avoid main-thread long tasks.

- [ ] **Step 3: Commit**

```bash
git commit -m "perf(frontend): chunk process-trace hydrate for long histories"
```

---

# Milestone M3 — P2: CSS split, a11y, confirm, Prism vendor

---

### Task 15: Split CSS by domain

**Files:**
- Create: `public/styles/tokens.css`
- Create: `public/styles/base.css`
- Create: `public/styles/shell.css`
- Create: `public/styles/messages.css`
- Create: `public/styles/workspace.css`
- Create: `public/styles/recall.css`
- Create: `public/styles/composer.css`
- Create: `public/styles/a11y.css`
- Modify: `public/styles.css` → aggregator
- Modify: `tests/server.test.js` (read aggregator or multi-file join)

**Aggregator strategy (pick one, document in styles.css header):**

**Option A (recommended, zero server change):**

```css
/* public/styles.css */
@import url("./styles/tokens.css");
@import url("./styles/base.css");
/* ... */
```

**Option B:** multiple `<link>` in `index.html`.

- [ ] **Step 1: Move blocks without selector renames**

Keep class names stable so visual + contract tests still pass.

- [ ] **Step 2: Update tests that `readFileSync(styles.css)`**

```js
function readFrontendCss() {
  const root = path.join(__dirname, "../public");
  const main = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  if (!main.includes("@import")) return main;
  return main.replace(/@import url\("\.\/styles\/([^"]+)"\);/g, (_, name) =>
    fs.readFileSync(path.join(root, "styles", name), "utf8")
  );
}
```

- [ ] **Step 3: Manual theme/responsive smoke**

- light / dark / system  
- width 1024 / 700  
- workspace diff colors  

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(frontend): split styles.css into domain sheets"
```

---

### Task 16: Density token + component state naming pass

**Files:**
- Modify: `public/styles/tokens.css`, shell/messages as needed
- Modify: `public/app.js` or theme module for optional density toggle (optional UI; at least CSS hooks)

- [ ] **Step 1: Tokens**

```css
:root {
  --density: 1;
  --row-pad-y: calc(8px * var(--density));
}
:root[data-density="compact"] { --density: 0.85; }
```

- [ ] **Step 2: Prefer state classes**

- `.is-active` (tabs, mention option, agent card)  
- `.is-loading` / `.is-error`  
- Avoid new one-off `.active` if `.is-active` exists — migrate mention `.active` → `.is-active` with CSS dual-match during transition:

```css
.mention-option.active,
.mention-option.is-active { /* ... */ }
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(frontend): density token and is-* state class alignment"
```

---

### Task 17: Mobile side panel + icon hygiene (light)

**Files:**
- Modify: `public/styles/shell.css`
- Modify: `index.html` / session list (icons)

- [ ] **Step 1: Mobile**

On `max-width: 700px`:

- Default right panel collapsed height or tab-only bar; expand on tab click  
- Or: side-panel `max-height: min(28vh, 200px)` when on agents; allow `is-expanded` to `50vh` for workspace/recall  

Implement smallest useful change: **workspace/recall tabs set `side-panel.is-expanded`**.

- [ ] **Step 2: Replace critical emoji controls with inline SVG** (sidebar toggle, theme optional)

Keep text labels; SVG decorative `aria-hidden="true"`.

- [ ] **Step 3: Commit**

```bash
git commit -m "fix(frontend): mobile side-panel expand and svg icons"
```

---

### Task 18: Accessibility — tabs, mention listbox, composer busy

**Files:**
- Modify: `index.html`
- Modify: `public/app.js` (`setRightPanelTab`)
- Modify: `public/mention-composer.js`
- Modify: `public/message-view.js` or app `syncComposerControls`
- Modify: `public/styles/a11y.css`
- Create: `tests/a11y-contracts.test.js` (string contracts)

- [ ] **Step 1: Tablist**

```html
<button ... role="tab" aria-controls="agent-panel" id="panel-tab-agents">...
<section id="agent-panel" role="tabpanel" aria-labelledby="panel-tab-agents">
```

Keyboard on tablist: ArrowLeft/Right cycles tabs.

- [ ] **Step 2: Mention menu**

```html
<div id="mention-menu" role="listbox" hidden>
  <button role="option" aria-selected="true|false">...
```

`promptEl` gets `aria-activedescendant` when open.

- [ ] **Step 3: Send button**

```js
btnSend.setAttribute("aria-busy", running ? "true" : "false");
btnSend.setAttribute("aria-label", running ? "停止生成" : "发送");
```

- [ ] **Step 4: Commit**

```bash
git commit -m "a11y(frontend): tabs, mention listbox, send busy state"
```

---

### Task 19: `ui-confirm` replaces `window.confirm`

**Files:**
- Create: `public/ui-confirm.js`
- Create: `tests/ui-confirm.test.js` (pure open/close state if possible)
- Modify: `public/workspace-panel.js`, `public/session-list-view.js` / session-controller delete path
- Modify: styles
- Modify: `index.html`

**API:**

```js
async function confirmDialog({ title, body, confirmLabel, danger }) {
  // returns Promise<boolean>
}
```

Focus trap: focus confirm button; Esc → false; restore focus to previous element.

- [ ] **Step 1: Implement modal**

- [ ] **Step 2: Replace**

- discard worktree  
- delete session  

Inject `confirmImpl` so tests can stub.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(frontend): accessible confirm dialog for destructive actions"
```

---

### Task 20: Vendor Prism locally

**Files:**
- Create: `public/vendor/prism/prism.min.js`
- Create: `public/vendor/prism/prism-tomorrow.min.css`
- Create: language components actually used (js/ts/python/bash/json/css/markup)
- Modify: `index.html`
- Modify: `tests/server.test.js` if it asserts CDN URLs

- [ ] **Step 1: Download matching Prism 1.29.0 assets into vendor** (same versions as current CDN)

- [ ] **Step 2: Point index.html to `/public/vendor/prism/...`**

- [ ] **Step 3: Contract test**

```js
assert.doesNotMatch(html, /cdn\.jsdelivr\.net\/npm\/prismjs/);
assert.match(html, /\/public\/vendor\/prism\//);
```

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(frontend): vendor Prism for offline syntax highlighting"
```

---

### Task 21: Copy UX polish + final regression

**Files:**
- Modify: `public/message-view.js`, `public/clipboard.js` if needed
- Modify: `tests/clipboard.test.js`

- [ ] **Step 1: Distinguish copy actions**

- Message meta: copy **markdown source** (existing)  
- Code block button: copy **plain code only** (if not already)

Titles: `复制消息` vs `复制代码`.

- [ ] **Step 2: Full suite + check**

```bash
npm test
npm run check
```

- [ ] **Step 3: Manual QA checklist**

- [ ] New chat / switch session / background run status dots  
- [ ] Stream text + thinking collapse + progress list  
- [ ] @ mention keyboard + screen reader attrs (spot check)  
- [ ] Workspace select file (no full flicker) + large diff scroll  
- [ ] Discard worktree + delete session via modal  
- [ ] Theme cycle + dark diff colors  
- [ ] Offline: disable network, reload UI, Prism still loads  
- [ ] Mobile width: panel expand  

- [ ] **Step 4: Final commit — M3 complete**

```bash
git commit -m "feat(frontend): complete P0-P2 modularization and UX hardening"
```

---

## Dependency graph (execution order)

```text
Task1 display-helpers
  └─ Task2 theme
  └─ Task3 mention
  └─ Task4 session-list
  └─ Task5 workspace-panel
  └─ Task6 recall-panel
  └─ Task7 message-view  (depends on 1, 6 attach toggle)
       └─ Task8 orchestrator budget     ===== M1 =====
            ├─ Task9 workspace partial
            ├─ Task10 virtual-list + diff
            ├─ Task11 state ownership
            ├─ Task12 thinking/progress   (message-view)
            ├─ Task13 status dots         (session-list)
            └─ Task14 hydrate chunking    ===== M2 =====
                 ├─ Task15 CSS split
                 ├─ Task16 density/is-*
                 ├─ Task17 mobile/icons
                 ├─ Task18 a11y
                 ├─ Task19 ui-confirm
                 ├─ Task20 Prism vendor
                 └─ Task21 copy + QA      ===== M3 =====
```

Tasks 2–6 after Task1 can be parallelized across agents if desired; Task7 should land after Task6’s `attachMessageToggle` API is stable.

---

## Out of scope reminders

- Vue/React migration  
- Bundler/Vite (optional follow-up)  
- Full message list virtualization  
- Git commit/push UI  
- Changing agent-event wire protocol  

---

## Rollback strategy

Each task is behavior-preserving until M2 UX features. If M2 thinking UI regresses readability, feature-flag:

```js
const ENABLE_THINKING_PANEL = true;
```

M1 pure refactors can be reverted file-by-file; keep dual-export modules even if app temporarily inlines again.
