const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  dayBucket,
  groupSessions,
  runStatusLabel,
} = require("../public/session-list-view.js");

test("runStatusLabel covers known statuses", () => {
  assert.equal(runStatusLabel("running"), "运行中");
  assert.equal(runStatusLabel("done"), "完成");
  assert.equal(runStatusLabel("error"), "失败");
  assert.equal(runStatusLabel("idle"), "");
});

test("dayBucket maps today / yesterday / earlier", () => {
  const now = new Date(2026, 6, 10, 15, 0, 0).getTime(); // local Jul 10 2026
  const todayIso = new Date(2026, 6, 10, 9, 0, 0).toISOString();
  const yesterdayIso = new Date(2026, 6, 9, 18, 0, 0).toISOString();
  const earlierIso = new Date(2026, 6, 1, 12, 0, 0).toISOString();
  assert.equal(dayBucket(todayIso, now), "today");
  assert.equal(dayBucket(yesterdayIso, now), "yesterday");
  assert.equal(dayBucket(earlierIso, now), "earlier");
  assert.equal(dayBucket(null, now), "earlier");
});

test("groupSessions preserves order and skips empty groups", () => {
  const now = new Date(2026, 6, 10, 15, 0, 0).getTime();
  const sessions = [
    { id: "a", createdAt: new Date(2026, 6, 10, 12, 0, 0).toISOString(), title: "A" },
    { id: "b", createdAt: new Date(2026, 6, 10, 8, 0, 0).toISOString(), title: "B" },
    { id: "c", createdAt: new Date(2026, 6, 9, 10, 0, 0).toISOString(), title: "C" },
    { id: "d", createdAt: new Date(2026, 5, 1, 10, 0, 0).toISOString(), title: "D" },
  ];
  const groups = groupSessions(sessions, now);
  assert.deepEqual(groups.map((g) => g.key), ["today", "yesterday", "earlier"]);
  assert.deepEqual(groups[0].items.map((s) => s.id), ["a", "b"]);
  assert.deepEqual(groups[1].items.map((s) => s.id), ["c"]);
  assert.deepEqual(groups[2].items.map((s) => s.id), ["d"]);
  assert.equal(groups[0].label, "今天");
  assert.equal(groups[1].label, "昨天");
  assert.equal(groups[2].label, "更早");
});

test("groupSessions with only earlier items omits today/yesterday headings", () => {
  const now = new Date(2026, 6, 10, 15, 0, 0).getTime();
  const groups = groupSessions([
    { id: "old", createdAt: new Date(2026, 1, 1).toISOString() },
  ], now);
  assert.deepEqual(groups.map((g) => g.key), ["earlier"]);
});
