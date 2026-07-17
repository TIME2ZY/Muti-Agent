const DEFAULT_MAX_TERMS = 8;
const DEFAULT_PROMPT_SCAN_CHARS = 500;
const DEFAULT_SEARCH_QUERY_CHARS = 200;

/** Low-information Chinese / English tokens that should not drive FTS alone. */
const STOP_TERMS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "please",
  "继续",
  "完成",
  "实现",
  "处理",
  "检查",
  "一下",
  "我们",
  "你们",
  "他们",
  "这个",
  "那个",
  "一个",
  "什么",
  "怎么",
  "如何",
  "需要",
  "可以",
  "进行",
  "相关",
  "问题",
  "错误",
  "代码",
  "文件",
  "请",
  "帮",
  "我",
  "你",
  "的",
  "了",
  "在",
  "是",
  "和",
  "与",
  "或",
  "并",
  "把",
  "被",
  "让",
  "对",
  "到",
  "就",
  "都",
  "也",
  "还",
  "再",
  "后",
  "前",
  "中",
  "上",
  "下",
]);

/**
 * Extract high-signal terms for recall / retrieve.
 * Keeps identifiers and mixed CJK/latin tokens; builds CJK bigrams for long runs.
 */
function extractSearchTerms(input, options = {}) {
  const maxTerms = clampInt(options.maxTerms, DEFAULT_MAX_TERMS, 1, 16);
  const maxChars = clampInt(options.maxChars, DEFAULT_PROMPT_SCAN_CHARS, 32, 2000);
  const text = String(input || "")
    .trim()
    .slice(0, maxChars);
  if (!text) return [];

  const scored = new Map();
  const bump = (term, weight) => {
    const normalized = String(term || "")
      .trim()
      .toLowerCase();
    if (!normalized || normalized.length < 2) return;
    if (STOP_TERMS.has(normalized)) return;
    // Reject pure punctuation/digits. Do NOT use \W — with the unicode flag it
    // also matches CJK letters in JavaScript, which would drop all Chinese terms.
    if (!/[\p{L}\p{N}]/u.test(normalized)) return;
    scored.set(normalized, Math.max(scored.get(normalized) || 0, weight));
  };

  for (const match of text.match(/[A-Za-z][A-Za-z0-9_./:-]{1,}/g) || []) {
    bump(match, match.length >= 4 ? 8 : 5);
  }
  for (const match of text.match(/[0-9]+[A-Za-z][A-Za-z0-9_-]*/g) || []) {
    bump(match, 7);
  }
  for (const run of text.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    if (run.length <= 6) {
      bump(run, 6 + Math.min(run.length, 4));
    } else {
      bump(run.slice(0, 6), 5);
    }
    if (run.length >= 4) {
      for (let i = 0; i < run.length - 1 && i < 8; i++) {
        bump(run.slice(i, i + 2), 3);
      }
    }
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, maxTerms)
    .map(([term]) => term);
}

function isWeakQuery(terms, raw = "") {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return true;
  // No extractable terms → treat as weak (recency-only), unless raw itself is a
  // short non-stop token that can still be used as a contains query.
  if (!Array.isArray(terms) || terms.length === 0) {
    const token = trimmed.toLowerCase();
    if (token.length >= 2 && !STOP_TERMS.has(token) && /[\p{L}\p{N}]/u.test(token)) {
      return false;
    }
    return true;
  }
  // Single ultra-generic stop term only.
  if (terms.length === 1 && STOP_TERMS.has(terms[0])) return true;
  return false;
}

function clampSearchQuery(query, maxChars = DEFAULT_SEARCH_QUERY_CHARS) {
  return String(query || "")
    .trim()
    .slice(0, Math.max(8, maxChars));
}

function clampInt(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(minimum, Math.min(Math.floor(number), maximum));
}

module.exports = {
  DEFAULT_MAX_TERMS,
  DEFAULT_PROMPT_SCAN_CHARS,
  DEFAULT_SEARCH_QUERY_CHARS,
  extractSearchTerms,
  isWeakQuery,
  clampSearchQuery,
};
