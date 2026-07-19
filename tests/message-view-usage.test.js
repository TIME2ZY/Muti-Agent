const assert = require("node:assert/strict");
const test = require("node:test");

const { aggregateInvocationUsage, normalizedUsage } = require("../public/message-view.js");

test("aggregateInvocationUsage reconciles step deltas with a run cumulative total", () => {
  const usage = aggregateInvocationUsage([
    {
      kind: "usage.update",
      payload: {
        type: "usage.update",
        scope: "step",
        mode: "delta",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      },
    },
    {
      kind: "usage.update",
      payload: {
        type: "usage.update",
        scope: "step",
        mode: "delta",
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
      },
    },
    {
      kind: "usage.update",
      payload: {
        type: "usage.update",
        scope: "run",
        mode: "cumulative",
        inputTokens: 180,
        cachedInputTokens: 80,
        outputTokens: 40,
        reasoningTokens: 5,
        totalTokens: 220,
      },
    },
  ]);

  assert.deepEqual(usage, {
    inputTokens: 180,
    cachedInputTokens: 80,
    outputTokens: 40,
    reasoningTokens: 5,
    totalTokens: 220,
    costUsd: 0,
  });
});

test("normalizedUsage derives total from input and output without adding subsets", () => {
  assert.deepEqual(
    normalizedUsage({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 50, reasoningTokens: 7 }),
    {
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 20,
      reasoningTokens: 7,
      totalTokens: 120,
      costUsd: 0,
    }
  );
});
