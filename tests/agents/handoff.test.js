const assert = require("node:assert/strict");
const test = require("node:test");
const handoff = require("../../src/agents/handoff");

const {
  parseHandoffBlocks,
  parseHandoffBody,
  extractPrimaryHandoff,
  evaluateHandoff,
  renderHandoffTask,
  renderDegradedHandoff,
  summarizeHandoff,
  REQUIRED_FIELDS,
} = handoff;

const FULL_BLOCK = `
@OpenCode

请接手。

\`\`\`handoff
to: opencode
goal: review auth
what: 新增 POST /api/login
why: 多实例不能用 session
tradeoff: 暂不做 refresh token
open_questions:
  - TTL 是否 7 天
next_action: 审查 JWT 与哈希
files:
  - src/server/auth.js
evidence:
  - tests passed
\`\`\`
`;

test("parseHandoffBlocks extracts a full handoff", () => {
  const blocks = parseHandoffBlocks(FULL_BLOCK);
  assert.equal(blocks.length, 1);
  const h = blocks[0];
  assert.equal(h.to, "opencode");
  assert.equal(h.goal, "review auth");
  assert.equal(h.what, "新增 POST /api/login");
  assert.equal(h.why, "多实例不能用 session");
  assert.equal(h.tradeoff, "暂不做 refresh token");
  assert.equal(h.next_action, "审查 JWT 与哈希");
  assert.deepEqual(h.open_questions, ["TTL 是否 7 天"]);
  assert.deepEqual(h.files, ["src/server/auth.js"]);
  assert.deepEqual(h.evidence, ["tests passed"]);
});

test("parseHandoffBlocks returns empty for no fence", () => {
  assert.deepEqual(parseHandoffBlocks("@OpenCode\n请 review"), []);
  assert.deepEqual(parseHandoffBlocks(""), []);
  assert.deepEqual(parseHandoffBlocks(null), []);
});

test("parseHandoffBlocks ignores empty handoff fences", () => {
  assert.deepEqual(parseHandoffBlocks("```handoff\n```\n"), []);
});

test("parseHandoffBody supports multi-line scalar fields", () => {
  const h = parseHandoffBody(
    ["what: line1", "still what", "why: because", "next_action: do it"].join("\n")
  );
  assert.match(h.what, /line1/);
  assert.match(h.what, /still what/);
  assert.equal(h.why, "because");
});

test("parseHandoffBody supports comma-separated list on one line", () => {
  const h = parseHandoffBody("files: a.js, b.js\nwhat: x\nwhy: y\nnext_action: z");
  assert.deepEqual(h.files, ["a.js", "b.js"]);
});

test("extractPrimaryHandoff prefers last block", () => {
  const text = [
    "```handoff",
    "to: grok",
    "what: first",
    "why: w1",
    "next_action: n1",
    "```",
    "",
    "```handoff",
    "to: opencode",
    "what: second",
    "why: w2",
    "next_action: n2",
    "```",
  ].join("\n");
  const h = extractPrimaryHandoff(text);
  assert.equal(h.to, "opencode");
  assert.equal(h.what, "second");
});

test("extractPrimaryHandoff prefers block matching routedTo", () => {
  const text = [
    "```handoff",
    "to: grok",
    "what: for grok",
    "why: w",
    "next_action: n",
    "```",
    "```handoff",
    "to: opencode",
    "what: for opencode",
    "why: w",
    "next_action: n",
    "```",
  ].join("\n");
  const h = extractPrimaryHandoff(text, { routedTo: "grok" });
  assert.equal(h.what, "for grok");
});

test("evaluateHandoff marks complete packs ok", () => {
  const h = extractPrimaryHandoff(FULL_BLOCK);
  const q = evaluateHandoff(h);
  assert.equal(q.hasBlock, true);
  assert.equal(q.ok, true);
  assert.equal(q.degraded, false);
  assert.deepEqual(q.missing, []);
  assert.ok(q.score >= 0.9);
});

test("evaluateHandoff reports missing why", () => {
  const h = parseHandoffBody("what: only what\nnext_action: go");
  const q = evaluateHandoff(h);
  assert.equal(q.ok, false);
  assert.equal(q.degraded, true);
  assert.ok(q.missing.includes("why"));
});

test("evaluateHandoff null is fully degraded", () => {
  const q = evaluateHandoff(null);
  assert.equal(q.hasBlock, false);
  assert.equal(q.degraded, true);
  assert.deepEqual(q.missing, REQUIRED_FIELDS.slice());
  assert.equal(q.score, 0);
});

test("renderHandoffTask uses structured fields for complete handoff", () => {
  const h = extractPrimaryHandoff(FULL_BLOCK);
  const q = evaluateHandoff(h);
  const text = renderHandoffTask({
    handoff: h,
    quality: q,
    fromagent: "grok",
    fromLabel: "Grok",
    fromContent: "long narrative should be appendix only " + "x".repeat(100),
    userPrompt: "实现登录",
  });
  assert.match(text, /Structured Handoff/);
  assert.match(text, /what: 新增 POST \/api\/login/);
  assert.match(text, /why: 多实例不能用 session/);
  assert.match(text, /next_action: 审查 JWT 与哈希/);
  assert.match(text, /用户原始请求/);
  assert.match(text, /实现登录/);
  assert.match(text, /交接包完整度: ok/);
  assert.doesNotMatch(text, /未提供标准/);
});

test("renderHandoffTask marks incomplete packs degraded but still structured", () => {
  const h = parseHandoffBody("what: only\nnext_action: go");
  const text = renderHandoffTask({
    handoff: h,
    fromagent: "grok",
    fromLabel: "Grok",
    fromContent: "body",
    userPrompt: "task",
  });
  assert.match(text, /不完整/);
  assert.match(text, /缺失必填: why/);
  assert.match(text, /what: only/);
});

test("renderHandoffTask falls back when no block", () => {
  const text = renderHandoffTask({
    handoff: null,
    fromAgent: "codex",
    fromLabel: "Codex",
    fromContent: "@Gemini\nplease plan",
    userPrompt: "start",
  });
  assert.match(text, /未提供标准/);
  assert.match(text, /please plan/);
  assert.match(text, /start/);
});

test("renderDegradedHandoff includes missing list", () => {
  const text = renderDegradedHandoff({
    fromAgent: "a",
    fromLabel: "A",
    fromContent: "content",
    userPrompt: "u",
    missing: ["why"],
  });
  assert.match(text, /缺失: why/);
});

test("summarizeHandoff is compact for SSE", () => {
  const h = extractPrimaryHandoff(FULL_BLOCK);
  const q = evaluateHandoff(h);
  const s = summarizeHandoff(h, q);
  assert.equal(s.hasBlock, true);
  assert.equal(s.ok, true);
  assert.equal(s.to, "opencode");
  assert.ok(s.next_action);
  assert.ok(!("raw" in s));
});

test("parseHandoffBody ignores unknown keys without polluting previous fields", () => {
  const h = parseHandoffBody(
    [
      "to: Grok",
      "verdict: approve-with-nits",
      "blocking: []",
      "nits:",
      "  - id: N1",
      "    priority: P2",
      "    issue: buckets",
      "next_action: fix nits later",
      "what: 结论: approve-with-nits",
      "why: 无 P0",
    ].join("\n")
  );
  assert.equal(h.to, "Grok");
  assert.equal(h.next_action, "fix nits later");
  assert.equal(h.what, "结论: approve-with-nits");
  assert.equal(h.why, "无 P0");
  assert.equal(h.verdict, undefined);
  assert.equal(h.nits, undefined);
  const q = evaluateHandoff(h);
  assert.equal(q.ok, true);
  assert.equal(q.degraded, false);
});

test("normalizeTo uses first line only", () => {
  assert.equal(handoff.normalizeTo("Grok\nverdict: x"), "grok");
  assert.equal(handoff.normalizeTo("@OpenCode"), "opencode");
});

test("renderA2AHandoffCard is compact shared template", () => {
  const card = handoff.renderA2AHandoffCard();
  assert.match(card, /A2A Handoff Card/);
  assert.match(card, /what:/);
  assert.match(card, /next_action:/);
  assert.match(card, /verdict/);
  assert.ok(card.length < 1200, "card should stay short for A2A token budget");
});

test("selectAppendix prefers review anchors over pure tail when they would be cut", () => {
  const prefix = "noise ".repeat(800); // ~4000 chars
  const important = "\n## 评审\nP0: CAS race in foo.js\nrequest-changes\n";
  const suffix = "trailing commentary ".repeat(200);
  const full = prefix + important + suffix;
  const picked = handoff.selectAppendix(full, 2000);
  assert.match(picked, /P0: CAS race/);
  assert.match(picked, /request-changes/);
  assert.ok(picked.length <= 2000 + 20);
});

test("selectAppendix uses tail when content fits or no anchors", () => {
  assert.equal(handoff.selectAppendix("short body", 100), "short body");
  const long = "a".repeat(3000) + "TAIL_MARKER";
  const picked = handoff.selectAppendix(long, 500);
  assert.match(picked, /TAIL_MARKER$/);
  assert.ok(picked.length <= 500);
});

test("shouldInjectReceivingReview for implementer after reviewer", () => {
  assert.equal(
    handoff.shouldInjectReceivingReview({
      targetAgentId: "grok",
      fromAgentId: "opencode",
    }),
    true
  );
  assert.equal(
    handoff.shouldInjectReceivingReview({
      targetAgentId: "opencode",
      fromAgentId: "grok",
    }),
    false
  );
  assert.equal(
    handoff.shouldInjectReceivingReview({
      targetAgentId: "grok",
      fromAgentId: "codex",
      handoff: { what: "结论: request-changes\nP0: x", why: "bug", next_action: "fix" },
    }),
    true
  );
  assert.equal(
    handoff.shouldInjectReceivingReview({
      targetAgentId: "grok",
      fromAgentId: "codex",
      handoff: { what: "实现登录 API", why: "需求", next_action: "写代码" },
    }),
    false
  );
});

test("renderHandoffTask appendix uses enlarged default budget", () => {
  const h = parseHandoffBody("what: w\nwhy: y\nnext_action: n");
  const body = "x".repeat(6000) + "KEEP_END";
  const text = renderHandoffTask({
    handoff: h,
    fromAgent: "opencode",
    fromLabel: "OpenCode",
    fromContent: body,
    userPrompt: "u",
  });
  assert.match(text, /KEEP_END/);
  assert.ok(handoff.DEFAULT_APPENDIX_CHARS >= 5000);
  assert.ok(handoff.DEGRADED_APPENDIX_CHARS >= 8000);
});
