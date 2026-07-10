const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createEventBus } = require("../public/event-bus.js");

test("event bus delivers to subscribers and supports off", () => {
  const bus = createEventBus();
  const seen = [];
  const off = bus.on("ping", (p) => seen.push(p));
  bus.emit("ping", 1);
  off();
  bus.emit("ping", 2);
  assert.deepEqual(seen, [1]);
});

test("event bus once fires a single time", () => {
  const bus = createEventBus();
  let n = 0;
  bus.once("x", () => { n += 1; });
  bus.emit("x");
  bus.emit("x");
  assert.equal(n, 1);
});
