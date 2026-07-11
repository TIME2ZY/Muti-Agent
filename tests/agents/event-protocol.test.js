const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PROTOCOL_VERSION,
  makeEvent,
  normalizeCanonicalEvent,
  validateCanonicalEvent,
  assertCanonicalEvent,
  createRunLifecycle,
  lifecyclePhase,
} = require("../../src/agents/event-protocol");
const { createProviderRuntime } = require("../../src/agents/providers");

test("makeEvent stamps protocolVersion", () => {
  const event = makeEvent("text.delta", {
    agent: "architect",
    invocationId: "inv-1",
    text: "hi",
  });
  assert.equal(event.protocolVersion, PROTOCOL_VERSION);
  assert.equal(event.type, "text.delta");
});

test("normalize coerces loose field types before validation", () => {
  const event = normalizeCanonicalEvent({
    type: "text.delta",
    agent: "architect",
    invocationId: "inv-1",
    text: 42,
  });
  assert.equal(event.text, "42");
  assert.equal(event.protocolVersion, PROTOCOL_VERSION);
  assert.doesNotThrow(() => assertCanonicalEvent(event));
});

test("validateCanonicalEvent rejects wrong types when not coerced", () => {
  const errors = validateCanonicalEvent({
    type: "text.delta",
    agent: "architect",
    invocationId: "inv-1",
    text: 42,
  });
  assert.ok(errors.some((e) => /text must be a string/.test(e)));
});

test("validateCanonicalEvent rejects future protocol versions", () => {
  const errors = validateCanonicalEvent({
    type: "text.delta",
    agent: "a",
    invocationId: "i",
    text: "x",
    protocolVersion: PROTOCOL_VERSION + 10,
  });
  assert.ok(errors.some((e) => /unsupported protocolVersion/.test(e)));
});

test("run lifecycle accepts started → content → one terminal only", () => {
  const life = createRunLifecycle();
  assert.equal(lifecyclePhase("text.delta"), "content");
  assert.equal(life.accept("run.started"), true);
  assert.equal(life.accept("run.started"), false);
  assert.equal(life.accept("text.delta"), true);
  assert.equal(life.accept("thinking.delta"), true);
  assert.equal(life.accept("run.finished"), true);
  assert.equal(life.accept("run.failed"), false);
  assert.equal(life.accept("text.delta"), false);
  assert.equal(life.terminal, true);
});

test("runtime envelope drops content after terminal and stamps protocolVersion", () => {
  const runtime = createProviderRuntime({
    providerId: "codex",
    model: "gpt-5.5",
  });
  const ctx = { agent: "architect", invocationId: "inv-proto" };

  const first = runtime.transform(
    { type: "item.completed", item: { type: "agent_message", text: "hello" } },
    ctx
  );
  assert.deepEqual(
    first.map((e) => e.type),
    ["run.started", "text.delta"]
  );
  assert.ok(first.every((e) => e.protocolVersion === PROTOCOL_VERSION));

  const finished = runtime.finish(ctx, { terminal: true, ok: true, exitCode: 0 });
  assert.deepEqual(
    finished.map((e) => e.type),
    ["run.finished"]
  );

  const late = runtime.transform(
    { type: "item.completed", item: { type: "agent_message", text: "late" } },
    ctx
  );
  assert.deepEqual(late, []);
  assert.deepEqual(runtime.finish(ctx, { terminal: true, ok: true, exitCode: 0 }), []);
});
