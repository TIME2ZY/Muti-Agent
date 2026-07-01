const assert = require("node:assert/strict");
const test = require("node:test");
const contextHealth = require("../../src/session/health");
const { AGENTS } = require("../../src/agents/invoke-cli");

test("makeTracker with default capacity uses 200k tokens", () => {
  const tracker = contextHealth.makeTracker("architect");
  assert.equal(tracker.agentId, "architect");
  assert.equal(tracker.capacityTokens, 200_000);
  assert.equal(tracker.getUsedChars(), 0);
  assert.equal(tracker.getFillRatio(), 0);
});

test("makeTracker with explicit capacity overrides default", () => {
  const tracker = contextHealth.makeTracker("architect", { capacityTokens: 100_000 });
  assert.equal(tracker.capacityTokens, 100_000);
});

test("makeTracker for unknown agent falls back to default", () => {
  const tracker = contextHealth.makeTracker("nonexistent-agent");
  assert.equal(tracker.capacityTokens, contextHealth.DEFAULT_CAPACITY_TOKENS);
});

test("addInput / addOutput accumulate chars", () => {
  const tracker = contextHealth.makeTracker("architect");
  tracker.addInput(1000);
  tracker.addOutput(500);
  assert.equal(tracker.getUsedChars(), 1500);
});

test("addInput / addOutput ignore non-positive values", () => {
  const tracker = contextHealth.makeTracker("architect");
  tracker.addInput(0);
  tracker.addInput(-5);
  tracker.addInput("not a number");
  tracker.addOutput(NaN);
  assert.equal(tracker.getUsedChars(), 0);
});

test("fillRatio is (input+output) / (capacity * charsPerToken)", () => {
  const tracker = contextHealth.makeTracker("architect", { capacityTokens: 1000 });
  // 4000 chars total = 1000 tokens = fillRatio 1.0
  tracker.addInput(2000);
  tracker.addOutput(2000);
  assert.equal(tracker.getFillRatio(), 1.0);
});

test("fillRatio grows monotonically as input/output accumulate", () => {
  const tracker = contextHealth.makeTracker("architect", { capacityTokens: 1000 });
  const r0 = tracker.getFillRatio();
  tracker.addInput(1000);
  const r1 = tracker.getFillRatio();
  tracker.addOutput(1000);
  const r2 = tracker.getFillRatio();
  assert.ok(r0 < r1 && r1 < r2, `expected r0<r1<r2, got ${r0}, ${r1}, ${r2}`);
});

test("snapshot returns a consistent view of all counters", () => {
  // capacity 2000 tokens × 4 chars/token = 8000 char capacity
  const tracker = contextHealth.makeTracker("architect", { capacityTokens: 2000 });
  tracker.addInput(4000);
  tracker.addOutput(4000);
  const snap = tracker.snapshot();
  assert.equal(snap.agentId, "architect");
  assert.equal(snap.capacityTokens, 2000);
  assert.equal(snap.inputChars, 4000);
  assert.equal(snap.outputChars, 4000);
  assert.equal(snap.usedChars, 8000);
  assert.equal(snap.usedTokens, 2000);
  assert.equal(snap.fillRatio, 1.0);
  assert.ok(typeof snap.elapsedMs === "number" && snap.elapsedMs >= 0);
});

test("getAgentCapacity honors per-agent capacityTokens override", () => {
  // Mutate AGENTS for this test and restore after.
  const original = AGENTS.architect.capacityTokens;
  AGENTS.architect.capacityTokens = 50_000;
  try {
    const tracker = contextHealth.makeTracker("architect");
    assert.equal(tracker.capacityTokens, 50_000);
  } finally {
    if (original === undefined) delete AGENTS.architect.capacityTokens;
    else AGENTS.architect.capacityTokens = original;
  }
});
