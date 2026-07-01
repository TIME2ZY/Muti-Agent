const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const projectDir = require("../../src/server/project-dir");

test("validateProjectDir resolves an existing directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-dir-test-"));
  assert.equal(projectDir.validateProjectDir(dir), path.resolve(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("validateProjectDir rejects empty, missing, and file paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-dir-test-"));
  const file = path.join(dir, "file.txt");
  fs.writeFileSync(file, "x", "utf8");

  assert.throws(() => projectDir.validateProjectDir(""), /dir is required/);
  assert.throws(() => projectDir.validateProjectDir(path.join(dir, "missing")), /Directory not found/);
  assert.throws(() => projectDir.validateProjectDir(file), /Not a directory/);

  fs.rmSync(dir, { recursive: true, force: true });
});
