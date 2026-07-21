const test = require("node:test");
const assert = require("node:assert/strict");
const review = require("../../src/agents/review-state");

test("review workflow closes a request-changes and rereview cycle", () => {
  let current = review.initialReviewState();
  const apply = (event) => {
    const result = review.transitionReviewState(current, event, "2026-07-21T00:00:00.000Z");
    assert.equal(result.ignored, false);
    current = result.state;
  };

  apply({
    type: review.EVENTS.REVIEW_REQUESTED,
    actor: "grok",
    actorRole: "implementer",
    counterpart: "opencode",
  });
  assert.equal(current.status, review.STATES.AWAITING_REVIEW);

  apply({
    type: review.EVENTS.REVIEW_STARTED,
    actor: "opencode",
    actorRole: "reviewer",
    counterpart: "grok",
  });
  apply({
    type: review.EVENTS.CHANGES_REQUESTED,
    actor: "opencode",
    actorRole: "reviewer",
    counterpart: "grok",
  });
  assert.equal(current.status, review.STATES.CHANGES_REQUESTED);
  assert.equal(current.round, 1);

  apply({
    type: review.EVENTS.FIX_STARTED,
    actor: "grok",
    actorRole: "implementer",
    counterpart: "opencode",
  });
  apply({
    type: review.EVENTS.REVIEW_REQUESTED,
    actor: "grok",
    actorRole: "implementer",
    counterpart: "opencode",
  });
  apply({
    type: review.EVENTS.REVIEW_STARTED,
    actor: "opencode",
    actorRole: "reviewer",
    counterpart: "grok",
  });
  apply({
    type: review.EVENTS.APPROVED,
    actor: "opencode",
    actorRole: "reviewer",
    counterpart: "grok",
    verdict: "approve-with-nits",
  });
  assert.equal(current.status, review.STATES.APPROVED);
  assert.equal(current.verdict, "approve-with-nits");
  assert.equal(current.round, 1);
});

test("review workflow rejects self-approval and out-of-order fix events", () => {
  const idle = review.initialReviewState();
  const selfApproval = review.transitionReviewState(idle, {
    type: review.EVENTS.APPROVED,
    actor: "grok",
    actorRole: "implementer",
  });
  assert.equal(selfApproval.changed, false);
  assert.equal(selfApproval.ignored, true);

  const earlyFix = review.transitionReviewState(idle, {
    type: review.EVENTS.FIX_STARTED,
    actor: "grok",
    actorRole: "implementer",
  });
  assert.equal(earlyFix.changed, false);
  assert.equal(earlyFix.state.status, review.STATES.IDLE);
});

test("review verdict extraction requires an explicit conclusion", () => {
  assert.equal(review.extractReviewVerdict("结论: request-changes\nP1: race"), "request-changes");
  assert.equal(review.extractReviewVerdict("verdict: APPROVE"), "approve");
  assert.equal(review.extractReviewVerdict("looks good but needs thought"), null);
});

test("review state block tells the active role what happens next", () => {
  const text = review.renderReviewStateBlock({ status: "changes_requested", round: 2 });
  assert.match(text, /status: changes_requested/);
  assert.match(text, /Implementer/);
  assert.match(text, /重新 @Reviewer/);
});

test("rebuildReviewWorkflowFromMessages uses the newest non-idle snapshot", () => {
  const rebuilt = review.rebuildReviewWorkflowFromMessages([
    {
      kind: "review-state",
      reviewStatus: "awaiting_review",
      reviewRound: 0,
      implementer: "grok",
      reviewer: "opencode",
    },
    { role: "user", content: "noise" },
    {
      kind: "review-state",
      reviewStatus: "changes_requested",
      reviewRound: 2,
      verdict: "request-changes",
      implementer: "grok",
      reviewer: "opencode",
      updatedAt: "2026-07-21T01:00:00.000Z",
    },
  ]);
  assert.equal(rebuilt.status, "changes_requested");
  assert.equal(rebuilt.round, 2);
  assert.equal(rebuilt.verdict, "request-changes");
  assert.equal(rebuilt.implementer, "grok");
  assert.equal(rebuilt.reviewer, "opencode");
  assert.equal(rebuilt.updatedAt, "2026-07-21T01:00:00.000Z");
});

test("rebuildReviewWorkflowFromMessages returns idle when history has no review-state", () => {
  const rebuilt = review.rebuildReviewWorkflowFromMessages([
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ]);
  assert.equal(rebuilt.status, review.STATES.IDLE);
  assert.equal(rebuilt.round, 0);
});

test("resolveReviewWorkflow prefers session field over older messages", () => {
  const resolved = review.resolveReviewWorkflow({
    reviewWorkflow: {
      status: "fixing",
      round: 1,
      implementer: "grok",
      reviewer: "opencode",
    },
    messages: [
      {
        kind: "review-state",
        reviewStatus: "changes_requested",
        reviewRound: 1,
      },
    ],
  });
  assert.equal(resolved.source, "session");
  assert.equal(resolved.state.status, "fixing");
});

test("resolveReviewWorkflow rebuilds from messages when session field is idle", () => {
  const resolved = review.resolveReviewWorkflow({
    reviewWorkflow: null,
    messages: [
      {
        kind: "review-state",
        reviewStatus: "approved",
        reviewRound: 1,
        verdict: "approve",
        reviewer: "opencode",
        implementer: "grok",
      },
    ],
  });
  assert.equal(resolved.source, "messages");
  assert.equal(resolved.state.status, "approved");
  assert.equal(resolved.state.verdict, "approve");
  assert.equal(resolved.state.reviewer, "opencode");
});

test("reviewStateFromMessage accepts transcript-style payloads", () => {
  const fromPayload = review.reviewStateFromMessage({
    event: "approved",
    status: "approved",
    round: 1,
    verdict: "approve-with-nits",
    reviewer: "opencode",
  });
  assert.equal(fromPayload.status, "approved");
  assert.equal(fromPayload.verdict, "approve-with-nits");
  assert.equal(review.reviewStateFromMessage({ kind: "a2a-route" }), null);
});
