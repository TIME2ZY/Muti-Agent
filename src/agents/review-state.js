const STATES = Object.freeze({
  IDLE: "idle",
  AWAITING_REVIEW: "awaiting_review",
  REVIEWING: "reviewing",
  CHANGES_REQUESTED: "changes_requested",
  FIXING: "fixing",
  APPROVED: "approved",
});

const EVENTS = Object.freeze({
  REVIEW_REQUESTED: "review_requested",
  REVIEW_STARTED: "review_started",
  CHANGES_REQUESTED: "changes_requested",
  FIX_STARTED: "fix_started",
  APPROVED: "approved",
});

const VALID_STATES = new Set(Object.values(STATES));
const VERDICT_RE = /(?:结论|verdict)\s*[:：]\s*(request-changes|approve-with-nits|approve)\b/i;

function initialReviewState(input = {}) {
  input = input && typeof input === "object" ? input : {};
  const status = VALID_STATES.has(input.status) ? input.status : STATES.IDLE;
  return {
    status,
    round: Math.max(0, Number(input.round) || 0),
    verdict: typeof input.verdict === "string" ? input.verdict : null,
    reviewer: typeof input.reviewer === "string" ? input.reviewer : null,
    implementer: typeof input.implementer === "string" ? input.implementer : null,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : null,
  };
}

function extractReviewVerdict(text) {
  const match = String(text || "").match(VERDICT_RE);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Apply a validated workflow event. Role checks prevent an implementer from
 * accidentally approving its own work or a reviewer from entering fix state.
 */
function transitionReviewState(current, event = {}, now = new Date().toISOString()) {
  const state = initialReviewState(current);
  const type = event.type;
  const actorRole = String(event.actorRole || "").toLowerCase();
  const actor = event.actor ? String(event.actor) : null;
  const counterpart = event.counterpart ? String(event.counterpart) : null;
  let nextStatus = state.status;
  let verdict = state.verdict;
  let round = state.round;
  let reviewer = state.reviewer;
  let implementer = state.implementer;

  if (type === EVENTS.REVIEW_REQUESTED && actorRole === "implementer") {
    if (
      state.status === STATES.AWAITING_REVIEW &&
      (!actor || actor === state.implementer) &&
      (!counterpart || counterpart === state.reviewer)
    ) {
      return { state, changed: false, ignored: true };
    }
    nextStatus = STATES.AWAITING_REVIEW;
    implementer = actor || implementer;
    reviewer = counterpart || reviewer;
    verdict = null;
  } else if (
    type === EVENTS.REVIEW_STARTED &&
    actorRole === "reviewer" &&
    state.status === STATES.AWAITING_REVIEW
  ) {
    nextStatus = STATES.REVIEWING;
    reviewer = actor || reviewer;
    implementer = counterpart || implementer;
  } else if (
    type === EVENTS.CHANGES_REQUESTED &&
    actorRole === "reviewer" &&
    (state.status === STATES.REVIEWING || state.status === STATES.AWAITING_REVIEW)
  ) {
    nextStatus = STATES.CHANGES_REQUESTED;
    reviewer = actor || reviewer;
    implementer = counterpart || implementer;
    verdict = "request-changes";
    round += 1;
  } else if (
    type === EVENTS.FIX_STARTED &&
    actorRole === "implementer" &&
    state.status === STATES.CHANGES_REQUESTED
  ) {
    nextStatus = STATES.FIXING;
    implementer = actor || implementer;
  } else if (
    type === EVENTS.APPROVED &&
    actorRole === "reviewer" &&
    (state.status === STATES.REVIEWING || state.status === STATES.AWAITING_REVIEW)
  ) {
    nextStatus = STATES.APPROVED;
    reviewer = actor || reviewer;
    implementer = counterpart || implementer;
    verdict = event.verdict === "approve-with-nits" ? "approve-with-nits" : "approve";
  } else {
    return { state, changed: false, ignored: true };
  }

  const next = {
    status: nextStatus,
    round,
    verdict,
    reviewer,
    implementer,
    updatedAt: now,
  };
  return {
    state: next,
    changed: JSON.stringify(next) !== JSON.stringify(state),
    ignored: false,
  };
}

function renderReviewStateBlock(input) {
  const state = initialReviewState(input);
  if (state.status === STATES.IDLE) return "";
  const expected = {
    [STATES.AWAITING_REVIEW]: "Reviewer 应开始审查并给出明确结论。",
    [STATES.REVIEWING]: "Reviewer 必须输出结论: request-changes|approve-with-nits|approve。",
    [STATES.CHANGES_REQUESTED]: "Implementer 应处理阻塞项，完成后重新 @Reviewer。",
    [STATES.FIXING]: "Implementer 正在修复；完成后必须请求复审。",
    [STATES.APPROVED]: "本轮审查已放行；除非出现新改动，不要继续循环 @。",
  }[state.status];
  return [
    "<!-- Review Workflow State -->",
    `status: ${state.status}`,
    `round: ${state.round}`,
    state.verdict ? `verdict: ${state.verdict}` : "",
    `next: ${expected}`,
    "<!-- /Review Workflow State -->",
  ]
    .filter(Boolean)
    .join("\n");
}

function describeReviewState(state) {
  const normalized = initialReviewState(state);
  const labels = {
    [STATES.IDLE]: "未进入审查",
    [STATES.AWAITING_REVIEW]: "等待审查",
    [STATES.REVIEWING]: "审查中",
    [STATES.CHANGES_REQUESTED]: "需要修改",
    [STATES.FIXING]: "修复中",
    [STATES.APPROVED]: "已放行",
  };
  return `审查状态：${labels[normalized.status]}（第 ${normalized.round} 轮）`;
}

/**
 * True when the workflow has left the default idle state (including approved).
 * Used to decide whether session.reviewWorkflow is authoritative.
 */
function isActiveReviewState(input) {
  return initialReviewState(input).status !== STATES.IDLE;
}

/**
 * Map a persisted session / transcript message (or raw event payload) back to
 * a review workflow snapshot. Returns null when the record is not a review-state.
 */
function reviewStateFromMessage(message = {}) {
  if (!message || typeof message !== "object") return null;

  const kind = String(message.kind || message.event || "")
    .trim()
    .toLowerCase();
  // Session messages use kind:"review-state"; SSE/transcript payloads use event type
  // or may omit kind when fields are inlined from the state snapshot.
  const looksLikeReviewState =
    kind === "review-state" ||
    kind === EVENTS.REVIEW_REQUESTED ||
    kind === EVENTS.REVIEW_STARTED ||
    kind === EVENTS.CHANGES_REQUESTED ||
    kind === EVENTS.FIX_STARTED ||
    kind === EVENTS.APPROVED ||
    VALID_STATES.has(message.reviewStatus) ||
    VALID_STATES.has(message.status);

  if (!looksLikeReviewState) return null;

  const statusCandidate = message.reviewStatus || message.status;
  if (!VALID_STATES.has(statusCandidate) || statusCandidate === STATES.IDLE) {
    return null;
  }

  return initialReviewState({
    status: statusCandidate,
    round: message.reviewRound ?? message.round,
    verdict: message.verdict || message.reviewVerdict || null,
    reviewer: message.reviewer || null,
    implementer: message.implementer || null,
    updatedAt: message.updatedAt || message.createdAt || null,
  });
}

/**
 * Walk messages newest-first and rebuild the latest non-idle review snapshot.
 * Empty / missing history yields idle.
 */
function rebuildReviewWorkflowFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return initialReviewState();
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const rebuilt = reviewStateFromMessage(messages[index]);
    if (rebuilt && isActiveReviewState(rebuilt)) return rebuilt;
  }
  return initialReviewState();
}

/**
 * Prefer the session field when it is already active; otherwise fall back to
 * the newest review-state message. Does not invent transitions — only restores
 * the last known snapshot.
 *
 * @returns {{ state: object, source: "session"|"messages"|"idle" }}
 */
function resolveReviewWorkflow(session = {}) {
  const fromField = initialReviewState(session?.reviewWorkflow);
  if (isActiveReviewState(fromField)) {
    return { state: fromField, source: "session" };
  }

  const fromMessages = rebuildReviewWorkflowFromMessages(session?.messages);
  if (isActiveReviewState(fromMessages)) {
    return { state: fromMessages, source: "messages" };
  }

  return { state: fromField, source: "idle" };
}

module.exports = {
  STATES,
  EVENTS,
  initialReviewState,
  isActiveReviewState,
  extractReviewVerdict,
  transitionReviewState,
  renderReviewStateBlock,
  describeReviewState,
  reviewStateFromMessage,
  rebuildReviewWorkflowFromMessages,
  resolveReviewWorkflow,
};
