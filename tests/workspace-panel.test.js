const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldRebuildFileList,
  filesSignature,
  emptyWorkspaceState,
} = require("../public/workspace-panel.js");

test("shouldRebuildFileList is false when path+status unchanged", () => {
  const a = [
    { path: "a.js", status: "modified" },
    { path: "b.js", status: "untracked" },
  ];
  const b = [
    { path: "a.js", status: "modified" },
    { path: "b.js", status: "untracked" },
  ];
  assert.equal(shouldRebuildFileList(a, b), false);
});

test("shouldRebuildFileList is true when files change", () => {
  const a = [{ path: "a.js", status: "modified" }];
  const b = [{ path: "a.js", status: "deleted" }];
  assert.equal(shouldRebuildFileList(a, b), true);
  assert.notEqual(filesSignature(a), filesSignature(b));
});

test("emptyWorkspaceState has expected defaults", () => {
  const s = emptyWorkspaceState();
  assert.equal(s.selectedPath, "");
  assert.equal(s.loading, false);
  assert.deepEqual(s.files, []);
});
