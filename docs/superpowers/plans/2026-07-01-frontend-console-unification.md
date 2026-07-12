# Frontend Console Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the chat UI into a single Chinese-first console style so header copy, message roles, and agent cards feel like one product instead of mixed demo fragments.

**Architecture:** Keep the existing static frontend structure (`index.html` + `public/app.js` + `public/styles.css`) and tighten the presentation layer around a shared role-display model. Use small JS helpers for display names/role chips, then align CSS tokens and component classes so messages and agent cards share one visual language.

**Tech Stack:** Static HTML, vanilla JavaScript, CSS, Node.js built-in test runner

---

### Task 1: Lock the new product language with failing tests

**Files:**
- Modify: `tests/server.test.js`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("frontend uses unified Chinese console copy in the main shell", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /Shift/);
  assert.match(html, /已激活能力/);
  assert.match(html, /参与 Agent/);
  assert.match(html, />清空</);
  assert.match(html, />发送</);
  assert.doesNotMatch(html, />Agent Chat</);
  assert.doesNotMatch(html, />Rules</);
  assert.doesNotMatch(html, />Models</);
});

test("frontend app.js defines unified display helpers for user and agent identities", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /function roleDisplayName\(role, agentId\)/);
  assert.match(js, /return role === "user" \? "用户"/);
  assert.match(js, /function roleBadgeLabel\(role\)/);
});

test("frontend styles define card-based role presentation for both user and assistant messages", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public", "styles.css"), "utf8");
  assert.match(css, /\.msg-card/);
  assert.match(css, /\.message\.user \.msg-card/);
  assert.match(css, /\.message\.assistant \.msg-card/);
  assert.match(css, /\.agent-tab-role/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server.test.js`

Expected: FAIL because the current UI still contains `Agent Chat`, `Rules`, `Models`, `Send`, `Clear`, and the JS/CSS helpers/classes do not exist yet.

- [ ] **Step 3: Write minimal implementation to satisfy the new shell contract**

```js
// index.html
<span class="main-title">Shift</span>
<span class="skills-bar-label">已激活能力</span>
<div class="agent-panel-title">参与 Agent</div>
<button id="btn-clear" class="btn-cmd" type="button">清空</button>
<button id="btn-send" class="btn-cmd primary" type="button">发送</button>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/server.test.js`

Expected: the new frontend-copy assertions pass, while unrelated failures must be investigated immediately.

- [ ] **Step 5: Commit**

```bash
git add tests/server.test.js index.html public/app.js public/styles.css
git commit -m "test: lock unified frontend console language"
```

### Task 2: Unify role naming and message metadata

**Files:**
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write the failing test for role display**

```js
test("frontend message rendering uses unified role display names and badges", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /metaLabel\.textContent = roleDisplayName\(role, agent\)/);
  assert.match(js, /metaRole\.textContent = roleBadgeLabel\(role\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server.test.js`

Expected: FAIL because `createMessage()` currently writes `You` directly and has no role badge element.

- [ ] **Step 3: Implement the minimal role-display helpers**

```js
function roleDisplayName(role, agentId) {
  return role === "user" ? "用户" : agentLabel(agentId);
}

function roleBadgeLabel(role) {
  if (role === "user") return "发起者";
  if (role === "assistant") return "Agent";
  return "系统";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/server.test.js`

Expected: PASS for the role-display test and no regressions in existing frontend assertions.

- [ ] **Step 5: Commit**

```bash
git add tests/server.test.js public/app.js public/styles.css
git commit -m "feat: unify frontend role naming"
```

### Task 3: Convert messages and agent panel to one card system

**Files:**
- Modify: `index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write the failing test for shared card styling**

```js
test("frontend agent cards and messages share a console card visual system", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public", "styles.css"), "utf8");
  assert.match(css, /\.message \.msg-card/);
  assert.match(css, /\.agent-tab \{/);
  assert.match(css, /\.agent-tab-role \{/);
  assert.match(css, /\.agent-tab-name \{/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server.test.js`

Expected: FAIL because messages do not use `.msg-card` and agent cards do not expose a role line.

- [ ] **Step 3: Implement the minimal shared card structure**

```js
const card = document.createElement("div");
card.className = "msg-card";
card.append(bubble);
wrapper.append(meta, card);
```

```js
item.innerHTML = `
  <span class="agent-tab-role">Agent</span>
  <span class="agent-tab-name"></span>
  <span class="agent-tab-model"></span>`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/server.test.js`

Expected: PASS for the card-system assertions.

- [ ] **Step 5: Commit**

```bash
git add tests/server.test.js index.html public/app.js public/styles.css
git commit -m "feat: unify message cards and agent panel"
```

### Task 4: Full verification for the frontend refresh

**Files:**
- Modify: `public/app.js` (only if verification exposes issues)
- Modify: `public/styles.css` (only if verification exposes issues)
- Test: `tests/server.test.js`

- [ ] **Step 1: Run the focused frontend/server regression suite**

Run: `node --test tests/server.test.js`

Expected: PASS with `0 fail`.

- [ ] **Step 2: Run the project syntax check**

Run: `npm run check`

Expected: exit code `0` with no syntax errors in server and agent files.

- [ ] **Step 3: Review the diff for scope**

Run: `git diff -- index.html public/app.js public/styles.css tests/server.test.js docs/superpowers/plans/2026-07-01-frontend-console-unification.md`

Expected: only the planned UI-copy, role-display, styling, and test changes appear.

- [ ] **Step 4: If needed, apply the smallest follow-up fix and re-run verification**

```bash
node --test tests/server.test.js
npm run check
```

- [ ] **Step 5: Commit**

```bash
git add index.html public/app.js public/styles.css tests/server.test.js docs/superpowers/plans/2026-07-01-frontend-console-unification.md
git commit -m "feat: unify frontend console design"
```
