const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getMentionTrigger } = require("../public/mention-composer.js");

test("getMentionTrigger detects @query at cursor", () => {
  const t = getMentionTrigger("hello @arc", 10);
  assert.ok(t);
  assert.equal(t.query, "arc");
  assert.equal(t.start, 6);
  assert.equal(t.end, 10);
});

test("getMentionTrigger returns null without mention", () => {
  assert.equal(getMentionTrigger("hello world", 11), null);
});

test("getMentionTrigger supports start-of-line mention", () => {
  const t = getMentionTrigger("@coder do work", 6);
  assert.ok(t);
  assert.equal(t.query, "coder");
  assert.equal(t.start, 0);
});
