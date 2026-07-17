const assert = require("node:assert/strict");
const test = require("node:test");

const {
  decidePolicy,
  canEnqueue,
  resolveHandoffPolicyMode,
  buildRepairPayload,
  DECISIONS,
} = require("../../src/agents/handoff-policy");

test("resolveHandoffPolicyMode defaults to balanced", () => {
  assert.equal(resolveHandoffPolicyMode({}), "balanced");
  assert.equal(resolveHandoffPolicyMode({ SHIFT_HANDOFF_POLICY: "soft" }), "soft");
  assert.equal(resolveHandoffPolicyMode({ SHIFT_HANDOFF_POLICY: "STRICT" }), "strict");
  assert.equal(resolveHandoffPolicyMode({ SHIFT_HANDOFF_POLICY: "nope" }), "balanced");
});

test("soft mode never requests repair for missing handoff", () => {
  assert.equal(
    decidePolicy({
      mode: "soft",
      useWorktree: true,
      quality: { hasBlock: false, emptyPacket: true, ok: false },
    }),
    DECISIONS.ALLOW_DEGRADED
  );
  assert.equal(
    decidePolicy({
      mode: "soft",
      quality: { hasBlock: true, ok: true },
    }),
    DECISIONS.ALLOW
  );
});

test("balanced mode repairs worktree empty packet but allows discussion", () => {
  assert.equal(
    decidePolicy({
      mode: "balanced",
      useWorktree: true,
      quality: { hasBlock: false, emptyPacket: true, ok: false },
    }),
    DECISIONS.REQUEST_REPAIR
  );
  assert.equal(
    decidePolicy({
      mode: "balanced",
      useWorktree: false,
      quality: { hasBlock: false, emptyPacket: true, ok: false },
    }),
    DECISIONS.ALLOW_DEGRADED
  );
  assert.equal(
    decidePolicy({
      mode: "balanced",
      useWorktree: true,
      quality: { hasBlock: true, ok: false },
    }),
    DECISIONS.ALLOW_DEGRADED
  );
  assert.equal(
    decidePolicy({
      mode: "balanced",
      quality: { hasBlock: true, ok: true },
    }),
    DECISIONS.ALLOW
  );
});

test("strict mode repairs any non-ok handoff", () => {
  assert.equal(
    decidePolicy({
      mode: "strict",
      useWorktree: false,
      quality: { hasBlock: true, ok: false },
    }),
    DECISIONS.REQUEST_REPAIR
  );
  assert.equal(
    decidePolicy({
      mode: "strict",
      quality: { hasBlock: true, ok: true },
    }),
    DECISIONS.ALLOW
  );
});

test("canEnqueue only allows allow and allow_degraded", () => {
  assert.equal(canEnqueue(DECISIONS.ALLOW), true);
  assert.equal(canEnqueue(DECISIONS.ALLOW_DEGRADED), true);
  assert.equal(canEnqueue(DECISIONS.REQUEST_REPAIR), false);
  assert.equal(canEnqueue(DECISIONS.REJECT), false);
});

test("buildRepairPayload includes example fence", () => {
  const payload = buildRepairPayload({
    fromAgent: "codex",
    toAgent: "opencode",
    mode: "balanced",
    quality: { emptyPacket: true, hasBlock: false, missing: ["what", "why", "next_action"] },
  });
  assert.equal(payload.policy, DECISIONS.REQUEST_REPAIR);
  assert.match(payload.message, /未入队/);
  assert.match(payload.example, /```handoff/);
  assert.match(payload.example, /to: opencode/);
});
