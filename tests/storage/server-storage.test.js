const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createServerStorage } = require("../../src/storage/server-storage");

test("files storage mode does not open SQLite", () => {
  const context = createServerStorage({ storageMode: "files" }, "sessions.json");
  assert.equal(context.mode, "files");
  assert.equal(context.storage, null);
  assert.equal(context.recorder.enabled, false);
  context.close();
});

test("dual storage uses an isolated database beside a custom sessions file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-storage-"));
  const context = createServerStorage({}, path.join(tmpDir, "sessions.json"));
  try {
    assert.equal(context.mode, "dual");
    assert.equal(context.recorder.enabled, true);
    assert.equal(fs.existsSync(path.join(tmpDir, "memory.sqlite")), true);
  } finally {
    context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sqlite storage mode opens the durable database", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-storage-sqlite-"));
  const context = createServerStorage(
    { storageMode: "sqlite" },
    path.join(tmpDir, "sessions.json")
  );
  try {
    assert.equal(context.mode, "sqlite");
    assert.equal(context.recorder.enabled, true);
    assert.ok(context.storage);
  } finally {
    context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("dual storage fails open when SQLite initialization fails", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-storage-failure-"));
  const errors = [];
  const context = createServerStorage(
    { memoryDbFile: tmpDir },
    path.join(tmpDir, "sessions.json"),
    { error: (message) => errors.push(message) }
  );
  try {
    assert.equal(context.storage, null);
    assert.equal(context.recorder.enabled, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /initialization failed/);
  } finally {
    context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
