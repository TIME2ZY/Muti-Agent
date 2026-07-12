const test = require("node:test");
const assert = require("node:assert/strict");
const { createInvocationRegistry } = require("../../src/server/invocation-registry");

test("invocation registry loads valid records and deletes one session atomically", () => {
  const writes = [];
  const registry = createInvocationRegistry({
    file: "memory.json",
    readFile: () => ({
      one: { invocationId: "one", sessionId: "s1" },
      two: { invocationId: "two", sessionId: "s2" },
      invalid: { sessionId: "s1" },
    }),
    writeFile: (file, value) => writes.push({ file, value }),
  });

  assert.deepEqual([...registry.events.keys()], ["one", "two"]);
  registry.deleteForSession("s1");
  assert.deepEqual([...registry.events.keys()], ["two"]);
  assert.deepEqual(writes, [
    {
      file: "memory.json",
      value: { two: { invocationId: "two", sessionId: "s2" } },
    },
  ]);
});

test("invocation registry contains persistence errors", () => {
  const errors = [];
  const registry = createInvocationRegistry({
    file: "memory.json",
    readFile: () => ({}),
    writeFile: () => {
      throw new Error("disk full");
    },
    logger: { error: (...args) => errors.push(args) },
  });
  registry.persist();
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], "disk full");
});
