const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  fileStatusMark,
  fileStatusClass,
} = require("../public/workspace-panel.js");

test("fileStatusMark maps common git-ish statuses to single letters", () => {
  assert.equal(fileStatusMark("modified"), "M");
  assert.equal(fileStatusMark("untracked"), "A");
  assert.equal(fileStatusMark("deleted"), "D");
  assert.equal(fileStatusMark("renamed"), "R");
  assert.equal(fileStatusMark(""), "?");
});

test("fileStatusClass maps to CSS status classes", () => {
  assert.equal(fileStatusClass("modified"), "status-modified");
  assert.equal(fileStatusClass("untracked"), "status-untracked");
  assert.equal(fileStatusClass("deleted"), "status-deleted");
  assert.equal(fileStatusClass("renamed"), "status-renamed");
});
