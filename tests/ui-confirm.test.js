const { test } = require("node:test");
const assert = require("node:assert/strict");
const { confirmDialog, createConfirm } = require("../public/ui-confirm.js");

test("createConfirm falls back to native confirm without document", async () => {
  let seen = "";
  const prev = global.confirm;
  global.confirm = (msg) => {
    seen = String(msg);
    return true;
  };
  try {
    const confirmImpl = createConfirm({ documentRef: null });
    const ok = await confirmImpl("删除？", { title: "危险" });
    assert.equal(ok, true);
    assert.match(seen, /删除/);
  } finally {
    global.confirm = prev;
  }
});

test("confirmDialog resolves false when document body is missing and confirm declines", async () => {
  const prev = global.confirm;
  global.confirm = () => false;
  try {
    const ok = await confirmDialog({ body: "x", documentRef: null });
    assert.equal(ok, false);
  } finally {
    global.confirm = prev;
  }
});
