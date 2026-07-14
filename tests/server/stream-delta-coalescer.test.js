const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createStreamDeltaCoalescer,
  resolveCoalesceOptionsFromEnv,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_MS,
} = require("../../src/server/stream-delta-coalescer");

function collectWrites(options = {}) {
  const writes = [];
  const coalescer = createStreamDeltaCoalescer({
    maxChars: 20,
    maxMs: 0, // size/boundary only unless a test injects schedule
    ...options,
    write: (kind, payload) => writes.push({ kind, payload }),
  });
  return { writes, coalescer };
}

test("coalesces consecutive text.delta under maxChars into one durable write", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 40, maxMs: 0 });
  coalescer.accept({ type: "text.delta", agent: "a", text: "partial " });
  coalescer.accept({ type: "text.delta", agent: "a", text: "answer" });
  assert.equal(writes.length, 0, "still buffered under threshold");
  coalescer.flushAll();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "text.delta");
  assert.equal(writes[0].payload.text, "partial answer");
});

test("flushes text.delta when maxChars is reached", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 10, maxMs: 0 });
  coalescer.accept({ type: "text.delta", agent: "a", text: "12345" });
  assert.equal(writes.length, 0);
  coalescer.accept({ type: "text.delta", agent: "a", text: "67890" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.text, "1234567890");
  coalescer.accept({ type: "text.delta", agent: "a", text: "x" });
  coalescer.flushAll();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].payload.text, "x");
});

test("boundary events flush pending deltas first", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 100, maxMs: 0 });
  coalescer.accept({ type: "text.delta", agent: "a", text: "hello" });
  coalescer.accept({
    type: "progress.update",
    agent: "a",
    items: [{ text: "step", done: true }],
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].kind, "text.delta");
  assert.equal(writes[0].payload.text, "hello");
  assert.equal(writes[1].kind, "progress.update");
});

test("interleaved thinking/text stay buffered until end (no kind-switch flush)", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 10_000, maxMs: 0 });
  // Mirrors Grok: think → text → think → text micro-interleave.
  coalescer.accept({ type: "thinking.delta", agent: "a", text: "plan " });
  coalescer.accept({ type: "text.delta", agent: "a", text: "hello " });
  coalescer.accept({ type: "thinking.delta", agent: "a", text: "more" });
  coalescer.accept({ type: "text.delta", agent: "a", text: "world" });
  assert.equal(writes.length, 0, "must not flush on every stream switch");
  coalescer.flushAll();
  assert.equal(writes.length, 2);
  assert.equal(writes[0].kind, "thinking.delta");
  assert.equal(writes[0].payload.text, "plan more");
  assert.equal(writes[1].kind, "text.delta");
  assert.equal(writes[1].payload.text, "hello world");
});

test("empty text.delta is ignored on durable path", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 100, maxMs: 0 });
  coalescer.accept({ type: "text.delta", agent: "a", text: "" });
  coalescer.accept({ type: "text.delta", agent: "a", text: "hi" });
  coalescer.flushAll();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.text, "hi");
});

test("disabled mode writes every event immediately", () => {
  const { writes, coalescer } = collectWrites({ enabled: false, maxChars: 400 });
  coalescer.accept({ type: "text.delta", agent: "a", text: "a" });
  coalescer.accept({ type: "text.delta", agent: "a", text: "b" });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].payload.text, "a");
  assert.equal(writes[1].payload.text, "b");
});

test("maxChars 0 disables coalescing", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 0 });
  assert.equal(coalescer.enabled, false);
  coalescer.accept({ type: "text.delta", agent: "a", text: "a" });
  assert.equal(writes.length, 1);
});

test("idle debounce resets timer on each append and flushes after pause", () => {
  let now = 0;
  const timers = [];
  const { writes, coalescer } = collectWrites({
    maxChars: 1000,
    maxMs: 50,
    now: () => now,
    schedule: (fn, ms) => {
      const id = { fn, fireAt: now + ms, cancelled: false };
      timers.push(id);
      return id;
    },
    cancel: (handle) => {
      handle.cancelled = true;
      const idx = timers.indexOf(handle);
      if (idx >= 0) timers.splice(idx, 1);
    },
  });

  coalescer.accept({ type: "text.delta", agent: "a", text: "tick" });
  assert.equal(timers.length, 1);
  const first = timers[0];

  // More text before idle fires — timer should be re-armed (debounce).
  now = 40;
  coalescer.accept({ type: "text.delta", agent: "a", text: " tock" });
  assert.equal(first.cancelled, true);
  assert.equal(timers.length, 1);
  assert.equal(writes.length, 0);

  now = 90;
  timers[0].fn();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.text, "tick tock");
});

test("resolveCoalesceOptionsFromEnv honors disable and numeric overrides", () => {
  assert.deepEqual(resolveCoalesceOptionsFromEnv({ DURABLE_DELTA_COALESCE: "0" }), {
    enabled: false,
  });
  assert.deepEqual(
    resolveCoalesceOptionsFromEnv({
      DURABLE_DELTA_COALESCE: "1",
      DURABLE_DELTA_COALESCE_CHARS: "80",
      DURABLE_DELTA_COALESCE_MS: "25",
    }),
    { enabled: true, maxChars: 80, maxMs: 25 }
  );
  assert.equal(DEFAULT_MAX_CHARS, 8_000);
  assert.equal(DEFAULT_MAX_MS, 1_500);
});
