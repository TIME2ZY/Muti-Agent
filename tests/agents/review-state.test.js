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
