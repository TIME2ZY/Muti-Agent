const { ENV } = require("../shared/brand");

const POLICY_MODES = Object.freeze(["soft", "balanced", "strict"]);
const DECISIONS = Object.freeze({
  ALLOW: "allow",
  ALLOW_DEGRADED: "allow_degraded",
  REQUEST_REPAIR: "request_repair",
  REJECT: "reject",
});

/**
 * Resolve SHIFT_HANDOFF_POLICY. Default balanced (Wave H2).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"soft"|"balanced"|"strict"}
 */
function resolveHandoffPolicyMode(env = process.env) {
  const raw = String(env[ENV.HANDOFF_POLICY] || "")
    .trim()
    .toLowerCase();
  if (POLICY_MODES.includes(raw)) return raw;
  return "balanced";
}

/**
 * Decide whether an A2A route may enqueue.
 *
 * @param {object} input
 * @param {{ hasBlock?: boolean, ok?: boolean, emptyPacket?: boolean }} input.quality
 * @param {boolean} [input.useWorktree]
 * @param {"soft"|"balanced"|"strict"} [input.mode]
 * @returns {"allow"|"allow_degraded"|"request_repair"|"reject"}
 */
function decidePolicy(input = {}) {
  const quality = input.quality || {};
  const useWorktree = Boolean(input.useWorktree);
  const mode = POLICY_MODES.includes(input.mode) ? input.mode : resolveHandoffPolicyMode();
  const hasBlock = Boolean(quality.hasBlock) && !quality.emptyPacket;
  const ok = Boolean(quality.ok) && hasBlock;

  if (mode === "soft") {
    return ok ? DECISIONS.ALLOW : DECISIONS.ALLOW_DEGRADED;
  }

  if (mode === "strict") {
    return ok ? DECISIONS.ALLOW : DECISIONS.REQUEST_REPAIR;
  }

  // balanced (default)
  if (ok) return DECISIONS.ALLOW;
  if (!hasBlock) {
    // Worktree / write mode: missing fence must not silently continue.
    return useWorktree ? DECISIONS.REQUEST_REPAIR : DECISIONS.ALLOW_DEGRADED;
  }
  // hasBlock but incomplete required fields
  return DECISIONS.ALLOW_DEGRADED;
}

function canEnqueue(decision) {
  return decision === DECISIONS.ALLOW || decision === DECISIONS.ALLOW_DEGRADED;
}

/**
 * Human-readable system/SSE payload for request_repair.
 */
function buildRepairPayload({ fromAgent, toAgent, quality, mode } = {}) {
  const missing =
    quality && Array.isArray(quality.missing) && quality.missing.length > 0
      ? quality.missing.join(", ")
      : "what, why, next_action";
  const empty = !quality || quality.emptyPacket || !quality.hasBlock;
  const example = [
    "```handoff",
    `to: ${toAgent || "<agent>"}`,
    "goal: <可空>",
    "what: <尽量填>",
    "why: <尽量填>",
    "next_action: <尽量填>",
    "files:",
    "  - <可空>",
    "```",
  ].join("\n");

  const reason = empty
    ? "缺少标准 ```handoff 块"
    : `handoff 不完整（缺失: ${missing}）`;

  const message = [
    `⛔ 交接需补全后再 @（policy=${mode || resolveHandoffPolicyMode()}）`,
    `${fromAgent || "?"} → ${toAgent || "?"}: ${reason}`,
    "本轮未入队。请补全 handoff 后重新行首 @ 目标。",
    "",
    "示例：",
    example,
  ].join("\n");

  return {
    from: fromAgent || null,
    to: toAgent || null,
    reason: empty ? "missing_handoff" : "incomplete_handoff",
    missing: quality && Array.isArray(quality.missing) ? quality.missing.slice() : [],
    emptyPacket: Boolean(empty),
    policy: DECISIONS.REQUEST_REPAIR,
    mode: mode || resolveHandoffPolicyMode(),
    message,
    example,
  };
}

module.exports = {
  POLICY_MODES,
  DECISIONS,
  resolveHandoffPolicyMode,
  decidePolicy,
  canEnqueue,
  buildRepairPayload,
};
