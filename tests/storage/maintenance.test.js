const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const {
  integrityCheck,
  checkpoint,
  rebuildThreadRecall,
  rebuildAllRecall,
  rebuildFts,
} = require("../../src/storage/maintenance");

test("maintenance rebuild helpers reindex a thread and FTS", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-1" });
    storage.messages.append({
      id: "m1",
      threadId: "thread-1",
      role: "user",
      content: "searchable maintenance token",
    });
    const rebuilt = rebuildThreadRecall(storage, "thread-1");
    assert.equal(rebuilt.messages, 1);
    assert.equal(storage.recall.search("thread-1", "maintenance token").length, 1);

    const all = rebuildAllRecall(storage);
    assert.equal(all.threads, 1);
    const fts = rebuildFts(storage);
    assert.ok(fts.items >= 1);

    assert.equal(integrityCheck(storage.db).ok, true);
    assert.ok(Array.isArray(checkpoint(storage.db, "PASSIVE")));
  } finally {
    storage.close();
  }
});
