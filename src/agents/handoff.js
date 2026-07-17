/**
 * Structured A2A handoff packets.
 *
 * Agents should emit a fenced ```handoff block when routing to another agent.
 * Soft mode (default): missing fields still allow routing; the next agent is
 * told the handoff is degraded. Hard blocking is intentionally not enabled yet.
 */

const REQUIRED_FIELDS = ["what", "why", "next_action"];
const RECOMMENDED_FIELDS = ["to", "goal", "tradeoff", "open_questions"];
const LIST_FIELDS = new Set(["open_questions", "files", "evidence"]);
const SCALAR_FIELDS = new Set(["to", "goal", "what", "why", "tradeoff", "next_action"]);
const ALL_KNOWN_FIELDS = new Set([...SCALAR_FIELDS, ...LIST_FIELDS]);

/** Structured pack: keep more of the prior narrative (reviews are often long). */
const DEFAULT_APPENDIX_CHARS = 5000;
/** No handoff fence: even more of the prior text is the only payload. */
const DEGRADED_APPENDIX_CHARS = 8000;

/** Prefer keeping windows that contain these review/handoff anchors. */
const APPENDIX_ANCHORS = [
  "request-changes",
  "approve-with-nits",
  "```handoff",
  "结论:",
  "结论：",
  "P0",
  "P1",
  "## Review",
  "## 评审",
  "### P0",
  "### P1",
];

const IMPLEMENTER_AGENT_IDS = new Set(["grok"]);
const REVIEWER_AGENT_IDS = new Set(["opencode"]);

/**
 * @typedef {object} Handoff
 * @property {string} [to]
 * @property {string} [goal]
 * @property {string} [what]
 * @property {string} [why]
 * @property {string} [tradeoff]
 * @property {string} [next_action]
 * @property {string[]} [open_questions]
 * @property {string[]} [files]
 * @property {string[]} [evidence]
 * @property {string} raw
 */

/**
 * @typedef {object} HandoffQuality
 * @property {boolean} ok
 * @property {boolean} degraded
 * @property {string[]} missing
 * @property {string[]} missingRecommended
 * @property {number} score
 * @property {boolean} hasBlock
 */

/**
 * Extract all ```handoff ... ``` blocks from agent output.
 * @param {string} text
 * @returns {Handoff[]}
 */
function parseHandoffBlocks(text) {
  if (!text || typeof text !== "string") return [];

  const blocks = [];
  const re = /```handoff\s*\r?\n([\s\S]*?)```/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    const parsed = parseHandoffBody(raw);
    if (parsed) blocks.push(parsed);
  }
  return blocks;
}

/**
 * Parse the interior of a handoff fence into a structured object.
 * @param {string} body
 * @returns {Handoff | null}
 */
function parseHandoffBody(body) {
  if (!body || typeof body !== "string") return null;

  /** @type {Handoff} */
  const handoff = { raw: body };
  let currentKey = null;
  let currentIsList = false;
  const scalarBuf = Object.create(null);

  const flushScalar = () => {
    if (!currentKey || currentIsList) return;
    const value = (scalarBuf[currentKey] || []).join("\n").trim();
    if (value) handoff[currentKey] = value;
    scalarBuf[currentKey] = [];
  };

  for (const line of body.split(/\r?\n/)) {
    const keyMatch = line.match(/^([a-z_]+)\s*:\s*(.*)$/i);
    if (keyMatch) {
      const key = keyMatch[1].toLowerCase();
      const rest = keyMatch[2];
      if (ALL_KNOWN_FIELDS.has(key)) {
        flushScalar();
        currentKey = key;
        currentIsList = LIST_FIELDS.has(key);

        if (currentIsList) {
          if (!Array.isArray(handoff[key])) handoff[key] = [];
          const item = rest.trim();
          if (item) {
            // Support "files: a.js, b.js" on the same line
            if (item.includes(",") && !item.startsWith("-")) {
              for (const part of item.split(",")) {
                const t = part.trim().replace(/^[-*]\s+/, "");
                if (t) handoff[key].push(t);
              }
            } else {
              handoff[key].push(item.replace(/^[-*]\s+/, ""));
            }
          }
        } else {
          scalarBuf[key] = rest.trim() ? [rest.trim()] : [];
        }
        continue;
      }

      // Unknown key (e.g. review-only verdict/nits): do NOT append to the
      // previous scalar — that polluted `to` and broke routing checks.
      flushScalar();
      currentKey = null;
      currentIsList = false;
      continue;
    }

    // Continuation / list item under current key
    if (!currentKey) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (currentIsList) {
      if (!Array.isArray(handoff[currentKey])) handoff[currentKey] = [];
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        handoff[currentKey].push(trimmed.slice(2).trim());
      } else {
        handoff[currentKey].push(trimmed);
      }
    } else {
      if (!scalarBuf[currentKey]) scalarBuf[currentKey] = [];
      scalarBuf[currentKey].push(trimmed);
    }
  }
  flushScalar();

  // `to` is a single agent token — keep first line only if a model wrapped junk.
  if (typeof handoff.to === "string") {
    handoff.to = handoff.to.split(/\r?\n/)[0].trim();
    if (!handoff.to) delete handoff.to;
  }

  // Normalize empty arrays away
  for (const key of LIST_FIELDS) {
    if (Array.isArray(handoff[key]) && handoff[key].length === 0) {
      delete handoff[key];
    }
  }

  // A block with no known fields is not a real handoff
  const hasAny = [...ALL_KNOWN_FIELDS].some((k) => {
    const v = handoff[k];
    return Array.isArray(v) ? v.length > 0 : Boolean(v);
  });
  if (!hasAny) return null;

  return handoff;
}

/**
 * Pick the primary handoff for the next agent.
 * Prefers the last block; if routedTo is set, prefers matching `to`.
 *
 * @param {string} text
 * @param {{ currentAgentId?: string, routedTo?: string }} [opts]
 * @returns {Handoff | null}
 */
function extractPrimaryHandoff(text, opts = {}) {
  return extractPrimaryHandoffMatch(text, opts).handoff;
}

/**
 * Pick the primary handoff and retain its parsed block index for stable capture keys.
 * @param {string} text
 * @param {{ currentAgentId?: string, routedTo?: string }} [opts]
 * @returns {{ handoff: Handoff | null, blockIndex: number | null }}
 */
function extractPrimaryHandoffMatch(text, opts = {}) {
  const blocks = parseHandoffBlocks(text);
  if (blocks.length === 0) return { handoff: null, blockIndex: null };

  const routedTo = opts.routedTo ? String(opts.routedTo).toLowerCase() : "";
  if (routedTo) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const to = normalizeTo(blocks[i].to);
      if (to && (to === routedTo || to.includes(routedTo))) {
        return { handoff: blocks[i], blockIndex: i };
      }
    }
  }

  return { handoff: blocks[blocks.length - 1], blockIndex: blocks.length - 1 };
}

function normalizeTo(value) {
  if (!value) return "";
  // First line only — models sometimes leak multi-line junk into `to`.
  const firstLine = String(value).split(/\r?\n/)[0].trim();
  return firstLine.replace(/^@/, "").toLowerCase();
}

/**
 * Evaluate completeness of a handoff (soft scoring).
 * @param {Handoff | null} handoff
 * @returns {HandoffQuality}
 */
function evaluateHandoff(handoff) {
  if (!handoff) {
    return {
      ok: false,
      degraded: true,
      missing: REQUIRED_FIELDS.slice(),
      missingRecommended: RECOMMENDED_FIELDS.slice(),
      score: 0,
      hasBlock: false,
    };
  }

  const missing = REQUIRED_FIELDS.filter((k) => !hasValue(handoff[k]));
  const missingRecommended = RECOMMENDED_FIELDS.filter((k) => !hasValue(handoff[k]));
  const requiredScore = (REQUIRED_FIELDS.length - missing.length) / REQUIRED_FIELDS.length;
  const recommendedScore =
    (RECOMMENDED_FIELDS.length - missingRecommended.length) / RECOMMENDED_FIELDS.length;
  const score = Math.round((requiredScore * 0.75 + recommendedScore * 0.25) * 100) / 100;
  const ok = missing.length === 0;

  return {
    ok,
    degraded: !ok,
    missing,
    missingRecommended,
    score,
    hasBlock: true,
  };
}

function hasValue(v) {
  if (Array.isArray(v)) return v.length > 0;
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Compact handoff reminder for A2A turns (avoids re-injecting the full
 * always-on a2a-handoff skill body — collaboration rules already cover basics).
 * @returns {string}
 */
function renderA2AHandoffCard() {
  return `<!-- A2A Handoff Card -->
## 共用 handoff 提醒（精简）

出站交接：行首 \`@队友\` + 同一套 fence；**可选字段可空**；禁止 \`verdict\`/\`nits\`/\`blocking\` 等私有顶层 key。

\`\`\`handoff
to: <agent>
goal: <可空>
what: <尽量填：交什么 / 审什么 / 结论: approve|approve-with-nits|request-changes + 分级列表>
why: <尽量填>
tradeoff: <可空>
next_action: <尽量填：希望对方立刻做什么>
open_questions:  # 可空
files:           # 可空
evidence:        # 可空
\`\`\`

入站：优先执行 Structured Handoff；缺项先补上下文，勿表演性附和。
<!-- /A2A Handoff Card -->`;
}

/**
 * Pick an appendix window: prefer the tail, but if review/handoff anchors would
 * be cut off, start near the earliest anchor so P0/结论 stay visible.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function selectAppendix(text, maxChars) {
  const s = String(text || "");
  const limit = Math.max(0, Number(maxChars) || 0);
  if (!s || limit === 0) return "";
  if (s.length <= limit) return s.trim();

  let earliestAnchor = -1;
  for (const marker of APPENDIX_ANCHORS) {
    const idx = s.indexOf(marker);
    if (idx >= 0 && (earliestAnchor < 0 || idx < earliestAnchor)) {
      earliestAnchor = idx;
    }
  }

  const tailStart = s.length - limit;
  if (earliestAnchor >= 0 && earliestAnchor < tailStart) {
    const start = Math.max(0, earliestAnchor - 80);
    return s.slice(start, start + limit).trim();
  }
  return s.slice(tailStart).trim();
}

/**
 * Whether the A2A target should receive the receiving-review skill.
 * Implementers fixing after a reviewer (or review-shaped handoff) need it.
 *
 * @param {{ targetAgentId?: string, fromAgentId?: string, handoff?: Handoff | null, text?: string }} opts
 * @returns {boolean}
 */
function shouldInjectReceivingReview(opts = {}) {
  const target = String(opts.targetAgentId || "")
    .trim()
    .toLowerCase();
  if (!IMPLEMENTER_AGENT_IDS.has(target)) return false;

  const from = String(opts.fromAgentId || "")
    .trim()
    .toLowerCase();
  if (REVIEWER_AGENT_IDS.has(from)) return true;

  const handoff = opts.handoff || null;
  const blob = [
    handoff && handoff.what,
    handoff && handoff.why,
    handoff && handoff.next_action,
    handoff && handoff.goal,
    opts.text,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return /request-changes|approve-with-nits|\bp0\b|\bp1\b|review\s*意见|修改意见|请修|fix these|blocking/.test(
    blob
  );
}

/**
 * Render the task body for the next agent from a structured handoff.
 *
 * @param {object} opts
 * @param {Handoff | null} opts.handoff
 * @param {HandoffQuality} [opts.quality]
 * @param {string} opts.fromAgent
 * @param {string} [opts.fromLabel]
 * @param {string} opts.fromContent
 * @param {string} opts.userPrompt
 * @param {number} [opts.appendixChars]
 * @returns {string}
 */
function renderHandoffTask(opts) {
  const {
    handoff,
    quality = evaluateHandoff(handoff),
    fromAgent,
    fromLabel,
    fromContent = "",
    userPrompt = "",
    appendixChars = DEFAULT_APPENDIX_CHARS,
  } = opts;

  const label = fromLabel || fromAgent || "previous agent";

  if (!handoff || !quality.hasBlock) {
    return renderDegradedHandoff({
      fromAgent,
      fromLabel: label,
      fromContent,
      userPrompt,
      missing: quality.missing,
      appendixChars:
        appendixChars === DEFAULT_APPENDIX_CHARS
          ? DEGRADED_APPENDIX_CHARS
          : Math.max(appendixChars, DEGRADED_APPENDIX_CHARS),
    });
  }

  const lines = [`[任务交接：由 ${label} 转交给你]`, "", "<!-- Structured Handoff -->"];

  if (quality.degraded) {
    lines.push(
      `⚠ 交接包不完整（缺失必填: ${quality.missing.join(", ") || "—"}）。请先补全上下文，谨慎执行破坏性操作。`,
      ""
    );
  } else {
    lines.push("交接包完整度: ok", "");
  }

  pushField(lines, "to", handoff.to);
  pushField(lines, "goal", handoff.goal);
  pushField(lines, "what", handoff.what);
  pushField(lines, "why", handoff.why);
  pushField(lines, "tradeoff", handoff.tradeoff);
  pushField(lines, "next_action", handoff.next_action);
  pushList(lines, "open_questions", handoff.open_questions);
  pushList(lines, "files", handoff.files);
  pushList(lines, "evidence", handoff.evidence);
  lines.push("<!-- /Structured Handoff -->", "");

  lines.push("=== 用户原始请求 ===", userPrompt || "(无)", "");

  const appendix = selectAppendix(fromContent, appendixChars);
  if (appendix) {
    lines.push(
      `=== ${label} 原文附录（截断） ===`,
      appendix,
      "",
      "请优先依据 Structured Handoff 执行；附录仅供补充。"
    );
  } else {
    lines.push("请根据 Structured Handoff 继续执行任务。");
  }

  return lines.join("\n");
}

/**
 * Fallback when no handoff block is present.
 */
function renderDegradedHandoff(opts) {
  const {
    fromAgent,
    fromLabel,
    fromContent = "",
    userPrompt = "",
    missing = REQUIRED_FIELDS.slice(),
    appendixChars = DEGRADED_APPENDIX_CHARS,
  } = opts;
  const label = fromLabel || fromAgent || "previous agent";
  const prevBlock = selectAppendix(fromContent, Math.max(appendixChars, DEGRADED_APPENDIX_CHARS));

  return [
    `[任务交接：由 ${label} 转交给你]`,
    "",
    "⚠ 上一位 Agent 未提供标准 ```handoff 块。以下信息可能不完整。",
    `缺失: ${missing.join(", ") || "what, why, next_action"}`,
    "请先用 session-search / 读上下文补全，不要凭猜测执行破坏性操作。",
    "",
    `=== ${label} 的完整分析 ===`,
    prevBlock,
    "",
    "=== 用户原始请求 ===",
    userPrompt || "(无)",
    "",
    "请根据上述上下文继续执行任务。",
  ].join("\n");
}

function pushField(lines, key, value) {
  if (!hasValue(value)) return;
  lines.push(`${key}: ${value}`);
}

function pushList(lines, key, values) {
  if (!Array.isArray(values) || values.length === 0) return;
  lines.push(`${key}:`);
  for (const item of values) {
    lines.push(`  - ${item}`);
  }
}

/**
 * Summarize quality for SSE / transcript (no large payloads).
 * @param {Handoff | null} handoff
 * @param {HandoffQuality} quality
 */
function summarizeHandoff(handoff, quality) {
  return {
    hasBlock: quality.hasBlock,
    ok: quality.ok,
    degraded: quality.degraded,
    score: quality.score,
    missing: quality.missing.slice(),
    to: handoff && handoff.to ? String(handoff.to) : null,
    next_action: handoff && handoff.next_action ? String(handoff.next_action).slice(0, 200) : null,
  };
}

module.exports = {
  REQUIRED_FIELDS,
  RECOMMENDED_FIELDS,
  DEFAULT_APPENDIX_CHARS,
  DEGRADED_APPENDIX_CHARS,
  IMPLEMENTER_AGENT_IDS,
  REVIEWER_AGENT_IDS,
  parseHandoffBlocks,
  parseHandoffBody,
  extractPrimaryHandoff,
  extractPrimaryHandoffMatch,
  evaluateHandoff,
  renderHandoffTask,
  renderDegradedHandoff,
  renderA2AHandoffCard,
  selectAppendix,
  shouldInjectReceivingReview,
  summarizeHandoff,
  normalizeTo,
};
