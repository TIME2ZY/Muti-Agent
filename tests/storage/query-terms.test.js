const assert = require("node:assert/strict");
const test = require("node:test");

const { extractSearchTerms, isWeakQuery } = require("../../src/storage/query-terms");

test("extractSearchTerms keeps identifiers and Chinese signal terms", () => {
  const terms = extractSearchTerms("请继续完成 JWT 过期处理并检查错误码 AUTH_EXPIRED");
  assert.ok(terms.includes("jwt") || terms.some((term) => term.includes("jwt")));
  assert.ok(terms.some((term) => term.includes("auth_expired") || term === "auth_expired"));
  assert.ok(terms.some((term) => term.includes("过期")));
});

test("extractSearchTerms prefers short Chinese compounds and emits trigrams", () => {
  const terms = extractSearchTerms("鉴权策略与过期时间配置");
  assert.ok(terms.some((term) => term.includes("鉴权") || term === "鉴权策略"));
  assert.ok(terms.some((term) => term.length >= 3 && /[\u4e00-\u9fff]/.test(term)));
});

test("isWeakQuery treats empty and continue-only prompts as weak", () => {
  assert.equal(isWeakQuery([], ""), true);
  assert.equal(isWeakQuery([], "继续"), true);
  assert.equal(isWeakQuery(extractSearchTerms("继续"), "继续"), true);
  assert.equal(isWeakQuery(extractSearchTerms("Hi"), "Hi"), false);
  assert.equal(
    isWeakQuery(extractSearchTerms("JWT 过期 AUTH_EXPIRED"), "JWT 过期 AUTH_EXPIRED"),
    false
  );
});
