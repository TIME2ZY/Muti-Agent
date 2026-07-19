const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeUsage, createUsageAccumulator } = require("../../src/agents/usage");

test("normalizeUsage understands snake_case and nested OpenCode tokens", () => {
  assert.deepEqual(
    normalizeUsage({
      input_tokens: 100,
      cache_read_input_tokens: 40,
      output_tokens: 20,
      reasoning_output_tokens: 5,
    }),
    {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningTokens: 5,
      totalTokens: 120,
    }
  );
  const nested = normalizeUsage({ tokens: { input: 10, output: 2, cache: { read: 3 } } });
  assert.equal(nested.totalTokens, 12);
  assert.equal(nested.cachedInputTokens, 3);
});

test("usage normalization never adds cached or reasoning subsets twice", () => {
  const usage = normalizeUsage({
    input: 100,
    cacheRead: 40,
    output: 30,
    reasoning: 10,
  });
  assert.equal(usage.totalTokens, 130);
});

test("usage accumulator removes repeated snapshots", () => {
  const accumulator = createUsageAccumulator();
  const event = {
    type: "usage.update",
    scope: "run",
    mode: "cumulative",
    totalTokens: 10,
  };
  assert.equal(accumulator.accept(event), event);
  assert.equal(accumulator.accept({ ...event }), null);
});

test("usage accumulator preserves identical delta events from separate steps", () => {
  const accumulator = createUsageAccumulator();
  const event = { type: "usage.update", scope: "step", mode: "delta", totalTokens: 10 };
  assert.equal(accumulator.accept(event), event);
  assert.deepEqual(accumulator.accept({ ...event }), event);
});
