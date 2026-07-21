const assert = require("node:assert/strict");
const test = require("node:test");

const {
  appendContentSegment,
  joinSegmentText,
  buildContentSegmentsFromEvents,
  fallbackSegmentsFromItem,
} = require("../public/message-view.js");

test("appendContentSegment merges adjacent same kind only", () => {
  const segments = [];
  appendContentSegment(segments, "thinking", "plan ");
  appendContentSegment(segments, "thinking", "more");
  appendContentSegment(segments, "text", "hello ");
  appendContentSegment(segments, "thinking", "again");
  appendContentSegment(segments, "text", "world");
  assert.deepEqual(segments, [
    { kind: "thinking", text: "plan more" },
    { kind: "text", text: "hello " },
    { kind: "thinking", text: "again" },
    { kind: "text", text: "world" },
  ]);
});

test("appendContentSegment ignores empty chunks", () => {
  const segments = [];
  appendContentSegment(segments, "text", "");
  appendContentSegment(segments, "text", "hi");
  assert.deepEqual(segments, [{ kind: "text", text: "hi" }]);
});

test("joinSegmentText filters by kind in order", () => {
  const segments = [
    { kind: "thinking", text: "a" },
    { kind: "text", text: "1" },
    { kind: "thinking", text: "b" },
    { kind: "text", text: "2" },
  ];
  assert.equal(joinSegmentText(segments, "thinking"), "ab");
  assert.equal(joinSegmentText(segments, "text"), "12");
});

test("buildContentSegmentsFromEvents preserves interleaved durable order", () => {
  const segments = buildContentSegmentsFromEvents([
    { kind: "thinking.delta", payload: { text: "plan " } },
    { kind: "text.delta", payload: { text: "hello " } },
    { kind: "thinking.delta", payload: { text: "more" } },
    { kind: "text.delta", payload: { text: "world" } },
    { kind: "tool.started", payload: { toolName: "read" } },
  ]);
  assert.deepEqual(segments, [
    { kind: "thinking", text: "plan " },
    { kind: "text", text: "hello " },
    { kind: "thinking", text: "more" },
    { kind: "text", text: "world" },
  ]);
});

test("buildContentSegmentsFromEvents merges adjacent same-kind rows", () => {
  const segments = buildContentSegmentsFromEvents([
    { kind: "text.delta", payload: { text: "a" } },
    { kind: "text.delta", payload: { text: "b" } },
    { type: "thinking.delta", text: "t" },
  ]);
  assert.deepEqual(segments, [
    { kind: "text", text: "ab" },
    { kind: "thinking", text: "t" },
  ]);
});

test("fallbackSegmentsFromItem prefers explicit segments", () => {
  assert.deepEqual(
    fallbackSegmentsFromItem({
      segments: [{ kind: "text", text: "x" }],
      rawText: "ignored",
      thinkingText: "ignored",
    }),
    [{ kind: "text", text: "x" }]
  );
  assert.deepEqual(
    fallbackSegmentsFromItem({ thinkingText: "think", rawText: "answer" }),
    [
      { kind: "thinking", text: "think" },
      { kind: "text", text: "answer" },
    ]
  );
});
