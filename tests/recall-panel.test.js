const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  eventBodyText,
  createRecallPanel,
  focusEventInTrace,
  groupHitsByLayer,
  layerFromHit,
  normalizeSearchResult,
} = require("../public/recall-panel.js");
const helpers = require("../public/message-process-helpers.js");
const { locale } = require("../public/locale-zh-CN.js");

test("eventBodyText smoke: stdout and text.delta return payload text", () => {
  assert.equal(eventBodyText({ kind: "stdout", payload: { text: "hello" } }), "hello");
  assert.equal(eventBodyText({ kind: "text.delta", payload: { text: "partial" } }), "partial");
});

test("eventBodyText smoke: tool.started includes name and args", () => {
  const out = eventBodyText({
    kind: "tool.started",
    payload: { toolName: "read", args: { path: "a.js" } },
  });
  assert.match(out, /read/);
  assert.match(out, /a\.js/);
});

test("eventBodyText smoke: tool.finished and command.finished shapes", () => {
  assert.match(
    eventBodyText({
      kind: "tool.finished",
      payload: { toolName: "grep", result: { n: 1 } },
    }),
    /grep/
  );
  assert.match(
    eventBodyText({
      kind: "command.finished",
      payload: { command: "npm test", exitCode: 0 },
    }),
    /npm test/
  );
  assert.match(
    eventBodyText({
      kind: "command.finished",
      payload: { command: "npm test", exitCode: 0 },
    }),
    /exit 0/
  );
});

test("groupHitsByLayer orders memory before message and evidence", () => {
  const groups = groupHitsByLayer([
    { sourceKind: "invocation-event", kind: "text.delta" },
    { layer: "memory", kind: "memory.handoff" },
    { sourceKind: "message", kind: "message.user" },
  ]);
  assert.equal(groups.memory.length, 1);
  assert.equal(groups.message.length, 1);
  assert.equal(groups.evidence.length, 1);
  assert.equal(layerFromHit({ sourceKind: "memory-entry" }), "memory");
});

test("normalizeSearchResult accepts legacy hit arrays", () => {
  const result = normalizeSearchResult([{ layer: "memory", kind: "memory.decision" }]);
  assert.equal(result.hits.length, 1);
  assert.equal(result.layers.memory, 1);
});

test("createRecallPanel uses locale.recall for toggle label", () => {
  // Minimal DOM stubs for Node.
  const meta = {
    querySelector: () => null,
    appendChild: () => {},
  };
  const wrapper = {
    querySelector: (sel) => (sel === ".msg-meta" ? meta : null),
  };
  let appended;
  meta.appendChild = (btn) => {
    appended = btn;
  };

  // Provide a fake document.createElement when attach runs.
  const g = globalThis;
  const prevDoc = g.document;
  g.document = {
    createElement: (tag) => {
      const el = {
        tagName: String(tag).toUpperCase(),
        type: "",
        className: "",
        textContent: "",
        title: "",
        addEventListener: () => {},
      };
      return el;
    },
  };

  try {
    const panel = createRecallPanel({
      bodyEl: null,
      searchInputEl: null,
      state: {},
      recallApi: {},
      agentLabel: (a) => a,
      fmtTime: () => "",
      escHtml: (s) => s,
      locale: { locale },
    });
    panel.attachRecallToggle(wrapper, "inv-1");
    assert.ok(appended, "button should be appended");
    assert.equal(appended.textContent, locale.recall.toggle);
    assert.equal(appended.title, locale.recall.toggleTitle);
  } finally {
    if (prevDoc === undefined) delete g.document;
    else g.document = prevDoc;
  }
});

test("focusEventInTrace highlights process row by data-event-nos", () => {
  const row = {
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
      contains(c) {
        return this._set.has(c);
      },
    },
    dataset: { eventNos: "2,5", traceKind: "tool", traceId: "t1" },
    closest: () => ({ open: false }),
    scrollIntoView: () => {},
  };
  const root = {
    querySelectorAll(sel) {
      if (sel === ".is-event-focus") return [];
      if (sel === ".live-tool-row, .live-subagent") return [row];
      return [];
    },
    querySelector: () => null,
  };
  assert.equal(focusEventInTrace(root, 5, [], helpers), true);
  assert.ok(row.classList.contains("is-event-focus"));
});

test("recall list toggle is bound on head not whole row (raw details click safety)", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../public/recall-panel.js"),
    "utf8"
  );
  // Expand/collapse must be head-scoped so nested details (原始事件) work.
  assert.match(src, /head\.addEventListener\("click",\s*\(\)\s*=>\s*toggleRecallItem/);
  assert.doesNotMatch(
    src,
    /row\.addEventListener\("click",\s*\(\)\s*=>\s*toggleRecallItem/
  );
  assert.match(src, /stopPropagation/);
});

test("focusEventInTrace falls back to raw event row", () => {
  const rawRow = {
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
      contains(c) {
        return this._set.has(c);
      },
    },
    scrollIntoView: () => {},
  };
  const rawDetails = { open: false };
  const root = {
    querySelectorAll(sel) {
      if (sel === ".is-event-focus") return [];
      if (sel === ".live-tool-row, .live-subagent") return [];
      if (String(sel).includes("data-trace-kind")) return [];
      return [];
    },
    querySelector(sel) {
      if (sel === ".recall-raw-events") return rawDetails;
      if (String(sel).includes("data-event-no")) return rawRow;
      return null;
    },
  };
  assert.equal(
    focusEventInTrace(
      root,
      7,
      [{ eventNo: 7, kind: "text.delta", payload: { text: "hi" } }],
      helpers
    ),
    true
  );
  assert.equal(rawDetails.open, true);
  assert.ok(rawRow.classList.contains("is-event-focus"));
});
