const { test } = require("node:test");
const assert = require("node:assert/strict");
const { locale, t } = require("../public/locale-zh-CN.js");

test("locale exposes core role strings", () => {
  assert.equal(locale.role.user, "用户");
  assert.equal(locale.roleBadge.user, "发起者");
  assert.equal(locale.message.copy, "复制消息");
});

test("t resolves dotted paths", () => {
  assert.equal(t("role.user"), "用户");
  assert.equal(t("missing.key", "fallback"), "fallback");
});
