const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createEventBus } = require("../public/event-bus.js");
const { createUiStore } = require("../public/ui-store.js");

test("ui store patches state and notifies subscribers", () => {
  const bus = createEventBus();
  const store = createUiStore({
    bus,
    initial: { selectedAgent: "codex", count: 0 },
  });
  const events = [];
  store.subscribe((e) => events.push(e.partial));
  store.patch({ count: 1 });
  assert.equal(store.state.count, 1);
  assert.deepEqual(events[0], { count: 1 });
  // Same object reference for existing modules
  assert.equal(store.getState(), store.state);
});

test("ui store set updates a single key", () => {
  const store = createUiStore({ initial: { a: 1 } });
  store.set("a", 2);
  assert.equal(store.state.a, 2);
});
