# Workspace Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a right-side workspace panel that unifies worktree status and git diff preview, with diff-first navigation and preview/discard as secondary actions.

**Architecture:** Keep the current static frontend architecture and extend the existing right-side panel into a tabbed surface with `参与 Agent` and `工作区`. Use one shared browser/Node-compatible diff parser so the frontend can split unified diff text into file entries without requiring a new backend response shape.

**Tech Stack:** Static HTML, vanilla JavaScript, CSS, Node.js built-in test runner, existing `/api/sessions/:id/worktree/{status,diff,discard}` endpoints

---

## File Structure

- Create: `public/workspace-diff.js`
  Responsibility: Parse unified diff text into file-level entries, expose a browser global and CommonJS exports so frontend code and Node tests share the same parser.

- Modify: `index.html`
  Responsibility: Add right-panel tab buttons, workspace panel container, and load the shared diff helper before `public/app.js`.

- Modify: `public/app.js`
  Responsibility: Add panel-tab state, workspace data loading, workspace rendering, file selection, refresh/discard actions, and empty/error handling.

- Modify: `public/styles.css`
  Responsibility: Style the tabbed right panel, workspace summary, file list, diff view, and semantic diff colors within the existing console design system.

- Modify: `tests/server.test.js`
  Responsibility: Lock the new panel markup, parser behavior, and workspace JS/CSS contract with focused regression tests.

### Task 1: Add a shared unified-diff parser

**Files:**
- Create: `public/workspace-diff.js`
- Modify: `tests/server.test.js`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write the failing tests**

```js
const { parseUnifiedDiff, summarizeUnifiedDiff } = require("../public/workspace-diff.js");

test("parseUnifiedDiff splits multi-file patches into file entries", () => {
  const diff = [
    "diff --git a/public/app.js b/public/app.js",
    "--- a/public/app.js",
    "+++ b/public/app.js",
    "@@ -1,2 +1,3 @@",
    " line 1",
    "+line 2",
    "diff --git a/public/new-file.js b/public/new-file.js",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/public/new-file.js",
    "@@ -0,0 +1,2 @@",
    "+export const ok = true;",
    "+console.log(ok);",
  ].join("\\n");

  const files = parseUnifiedDiff(diff);
  assert.deepEqual(
    files.map((file) => ({ path: file.path, status: file.status })),
    [
      { path: "public/app.js", status: "modified" },
      { path: "public/new-file.js", status: "untracked" },
    ]
  );
  assert.match(files[1].patch, /new file mode 100644/);
});

test("summarizeUnifiedDiff counts total and untracked files", () => {
  const files = [
    { path: "public/app.js", status: "modified", patch: "@@ -1 +1,2 @@\n line 1\n+line 2" },
    { path: "public/new-file.js", status: "untracked", patch: "new file mode 100644\n+console.log('ok');" },
  ];

  assert.deepEqual(summarizeUnifiedDiff(files), {
    totalFiles: 2,
    untrackedFiles: 1,
    hasDiff: true,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "parseUnifiedDiff|summarizeUnifiedDiff" tests/server.test.js`

Expected: FAIL with `Cannot find module '../public/workspace-diff.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
(function initWorkspaceDiff(globalScope) {
  function normalizePath(line) {
    return String(line || "").replace(/^a\//, "").replace(/^b\//, "").trim();
  }

  function parseUnifiedDiff(diffText) {
    const text = String(diffText || "");
    if (!text.trim()) return [];

    const blocks = text.split(/^diff --git /m).filter(Boolean).map((block) => `diff --git ${block}`);
    return blocks.map((block) => {
      const lines = block.split("\\n");
      const header = lines[0] || "";
      const match = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const pathFromHeader = match ? match[2] : "";
      const newFile = lines.some((line) => line.startsWith("new file mode "));
      const deletedFile = lines.some((line) => line.startsWith("deleted file mode "));
      const pathLine = lines.find((line) => line.startsWith("+++ "));
      const resolvedPath = pathLine && !pathLine.includes("/dev/null")
        ? normalizePath(pathLine.slice(4))
        : normalizePath(pathFromHeader);

      return {
        path: resolvedPath,
        status: newFile ? "untracked" : deletedFile ? "deleted" : "modified",
        patch: block.trim(),
      };
    }).filter((entry) => entry.path);
  }

  function summarizeUnifiedDiff(files) {
    const list = Array.isArray(files) ? files : [];
    return {
      totalFiles: list.length,
      untrackedFiles: list.filter((file) => file.status === "untracked").length,
      hasDiff: list.length > 0,
    };
  }

  const api = { parseUnifiedDiff, summarizeUnifiedDiff };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.WorkspaceDiff = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern "parseUnifiedDiff|summarizeUnifiedDiff" tests/server.test.js`

Expected: PASS for both parser tests.

- [ ] **Step 5: Commit**

```bash
git add public/workspace-diff.js tests/server.test.js
git commit -m "feat: add shared workspace diff parser"
```

### Task 2: Add the tabbed right-panel shell

**Files:**
- Modify: `index.html`
- Modify: `tests/server.test.js`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("frontend exposes agent and workspace panel tabs", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /id="panel-tab-agents"/);
  assert.match(html, /id="panel-tab-workspace"/);
  assert.match(html, /id="workspace-panel"/);
  assert.match(html, /src="\/public\/workspace-diff\.js"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "agent and workspace panel tabs" tests/server.test.js`

Expected: FAIL because the current HTML has no panel tabs, no workspace panel container, and no shared diff script include.

- [ ] **Step 3: Write minimal implementation**

```html
<aside class="side-panel" aria-label="右侧面板">
  <div class="panel-tabs" role="tablist" aria-label="右侧面板标签">
    <button id="panel-tab-agents" class="panel-tab is-active" type="button" role="tab" aria-selected="true">参与 Agent</button>
    <button id="panel-tab-workspace" class="panel-tab" type="button" role="tab" aria-selected="false">工作区</button>
  </div>

  <section class="agent-panel" id="agent-panel" role="tabpanel"></section>
  <section class="workspace-panel" id="workspace-panel" role="tabpanel" hidden></section>
</aside>

<script src="/public/workspace-diff.js"></script>
<script src="/public/app.js"></script>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern "agent and workspace panel tabs" tests/server.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/server.test.js
git commit -m "feat: add workspace panel shell"
```

### Task 3: Load workspace state and cover empty/error flows

**Files:**
- Modify: `public/app.js`
- Modify: `tests/server.test.js`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("frontend app.js loads workspace status and diff for the workspace tab", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /rightPanelTab:\s*"agents"/);
  assert.match(js, /async function loadWorkspaceState\(\)/);
  assert.match(js, /\/worktree\/status/);
  assert.match(js, /\/worktree\/diff/);
  assert.match(js, /function renderWorkspacePanel\(\)/);
});

test("frontend app.js handles missing worktree and discard actions", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /当前会话尚未创建 worktree/);
  assert.match(js, /当前无改动/);
  assert.match(js, /async function discardWorkspace\(\)/);
  assert.match(js, /method:\s*"POST"[\s\S]*\/worktree\/discard/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "workspace status and diff|missing worktree and discard" tests/server.test.js`

Expected: FAIL because the current app state has no workspace tab state, no diff fetch, and no discard handler.

- [ ] **Step 3: Write minimal implementation**

```js
const panelTabAgentsEl = $("#panel-tab-agents");
const panelTabWorkspaceEl = $("#panel-tab-workspace");
const workspacePanelEl = $("#workspace-panel");

state.rightPanelTab = "agents";
state.workspace = {
  status: null,
  diffText: "",
  files: [],
  selectedPath: "",
  loading: false,
  error: "",
};

async function loadWorkspaceState() {
  if (!state.currentSessionId) {
    state.workspace = { status: null, diffText: "", files: [], selectedPath: "", loading: false, error: "" };
    renderWorkspacePanel();
    return;
  }

  state.workspace.loading = true;
  state.workspace.error = "";
  renderWorkspacePanel();

  try {
    const statusRes = await fetch(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/worktree/status`);
    if (!statusRes.ok) {
      state.workspace.status = null;
      state.workspace.diffText = "";
      state.workspace.files = [];
      state.workspace.selectedPath = "";
      renderWorkspacePanel();
      return;
    }

    state.workspace.status = await jsonOrThrow(statusRes);
    const diffRes = await fetch(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/worktree/diff`);
    const diffData = diffRes.ok ? await jsonOrThrow(diffRes) : { diff: "" };
    state.workspace.diffText = diffData.diff || "";
    state.workspace.files = window.WorkspaceDiff.parseUnifiedDiff(state.workspace.diffText);
    state.workspace.selectedPath = state.workspace.files[0]?.path || "";
  } catch (error) {
    state.workspace.error = error.message;
  } finally {
    state.workspace.loading = false;
    renderWorkspacePanel();
  }
}

async function discardWorkspace() {
  if (!state.currentSessionId || !confirm("确认丢弃当前 worktree 吗？")) return;
  await fetch(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/worktree/discard`, { method: "POST" });
  await loadWorktreeStatus();
  await loadWorkspaceState();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern "workspace status and diff|missing worktree and discard" tests/server.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/app.js tests/server.test.js
git commit -m "feat: load workspace panel state"
```

### Task 4: Render file list, diff view, and workspace actions

**Files:**
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `tests/server.test.js`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("frontend app.js renders workspace file selection and diff output", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /function renderWorkspaceFileList\(\)/);
  assert.match(js, /function renderWorkspaceDiff\(\)/);
  assert.match(js, /workspace\.selectedPath = path/);
  assert.match(js, /打开预览/);
  assert.match(js, /刷新改动/);
});

test("frontend styles.css defines workspace panel layout and diff colors", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public", "styles.css"), "utf8");
  assert.match(css, /\.panel-tabs/);
  assert.match(css, /\.workspace-panel/);
  assert.match(css, /\.workspace-file-list/);
  assert.match(css, /\.workspace-diff/);
  assert.match(css, /\.workspace-diff-line-added/);
  assert.match(css, /\.workspace-diff-line-removed/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "workspace file selection and diff output|workspace panel layout and diff colors" tests/server.test.js`

Expected: FAIL because the renderer functions and CSS classes do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```js
function renderWorkspaceFileList() {
  const list = document.createElement("div");
  list.className = "workspace-file-list";

  for (const file of state.workspace.files) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "workspace-file" + (file.path === state.workspace.selectedPath ? " selected" : "");
    item.addEventListener("click", () => {
      state.workspace.selectedPath = file.path;
      renderWorkspacePanel();
    });
    item.innerHTML = `<span class="workspace-file-path">${escHtml(file.path)}</span><span class="workspace-file-status">${file.status}</span>`;
    list.appendChild(item);
  }

  return list;
}

function renderWorkspaceDiff() {
  const selected = state.workspace.files.find((file) => file.path === state.workspace.selectedPath);
  const panel = document.createElement("div");
  panel.className = "workspace-diff";
  if (!selected) {
    panel.innerHTML = `<div class="workspace-empty">当前无改动</div>`;
    return panel;
  }

  const lines = selected.patch.split("\\n");
  for (const line of lines) {
    const row = document.createElement("div");
    row.className =
      line.startsWith("+") && !line.startsWith("+++")
        ? "workspace-diff-line workspace-diff-line-added"
        : line.startsWith("-") && !line.startsWith("---")
          ? "workspace-diff-line workspace-diff-line-removed"
          : "workspace-diff-line";
    row.textContent = line;
    panel.appendChild(row);
  }
  return panel;
}
```

```css
.workspace-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
}

.workspace-file-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.workspace-diff {
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: var(--surface-inset);
  padding: var(--space-3);
  font-family: var(--font-mono);
  font-size: 12px;
  overflow: auto;
}

.workspace-diff-line-added { color: var(--success); }
.workspace-diff-line-removed { color: var(--danger); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern "workspace file selection and diff output|workspace panel layout and diff colors" tests/server.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/styles.css tests/server.test.js
git commit -m "feat: render workspace diff panel"
```

### Task 5: Integrate the tab behavior and verify the full feature

**Files:**
- Modify: `index.html` (only if review finds missing hooks)
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `tests/server.test.js`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write the failing integration test**

```js
test("frontend keeps right-side agent and workspace surfaces in a shared tab system", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /panelTabAgentsEl\.addEventListener\("click"/);
  assert.match(js, /panelTabWorkspaceEl\.addEventListener\("click"/);
  assert.match(js, /state\.rightPanelTab = "workspace"/);
  assert.match(js, /loadWorkspaceState\(\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern "shared tab system" tests/server.test.js`

Expected: FAIL until the click handlers and tab-render logic are wired.

- [ ] **Step 3: Write minimal implementation**

```js
function setRightPanelTab(nextTab) {
  state.rightPanelTab = nextTab;
  agentPanelEl.hidden = nextTab !== "agents";
  workspacePanelEl.hidden = nextTab !== "workspace";
  panelTabAgentsEl.classList.toggle("is-active", nextTab === "agents");
  panelTabWorkspaceEl.classList.toggle("is-active", nextTab === "workspace");
  panelTabAgentsEl.setAttribute("aria-selected", nextTab === "agents" ? "true" : "false");
  panelTabWorkspaceEl.setAttribute("aria-selected", nextTab === "workspace" ? "true" : "false");
}

panelTabAgentsEl.addEventListener("click", () => setRightPanelTab("agents"));
panelTabWorkspaceEl.addEventListener("click", async () => {
  setRightPanelTab("workspace");
  await loadWorkspaceState();
});
```

- [ ] **Step 4: Run full verification**

Run: `node --test tests/server.test.js`

Expected: PASS with `0 fail`.

Run: `npm run check`

Expected: exit code `0`.

Run: `git diff -- index.html public/app.js public/styles.css public/workspace-diff.js tests/server.test.js docs/superpowers/plans/2026-07-01-workspace-panel-implementation.md`

Expected: diff is limited to the workspace panel feature.

- [ ] **Step 5: Commit**

```bash
git add index.html public/app.js public/styles.css public/workspace-diff.js tests/server.test.js docs/superpowers/plans/2026-07-01-workspace-panel-implementation.md
git commit -m "feat: add diff-first workspace panel"
```
