/**
 * MarkdownLite — public API for chat message Markdown rendering.
 *
 * Internals (Batch 1): markdown-it + GFM plugins → custom token renderers →
 * DOMPurify → (optional) Prism. Call sites keep renderMd / paintMarkdown.
 */
(function initMarkdownLite(globalScope) {
  "use strict";

  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

  function escHtml(text) {
    return String(text).replace(/[&<>"']/g, (match) => ESC_MAP[match]);
  }

  /**
   * Normalize newlines before parse. Windows CLIs often emit CRLF; bare CR
   * also appears in progress rewrites.
   */
  function normalizeMdNewlines(text) {
    return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  function tryRequire(name) {
    if (typeof require !== "function") return null;
    try {
      return require(name);
    } catch {
      return null;
    }
  }

  function resolveMarkdownIt() {
    const fromPkg = tryRequire("markdown-it");
    if (fromPkg) return fromPkg;
    return typeof globalScope.markdownit === "function" ? globalScope.markdownit : null;
  }

  function resolveMultimdTable() {
    return tryRequire("markdown-it-multimd-table") || globalScope.markdownitMultimdTable || null;
  }

  function resolveTaskLists() {
    return tryRequire("markdown-it-task-lists") || globalScope.markdownitTaskLists || null;
  }

  function resolveDOMPurify() {
    if (globalScope.DOMPurify && typeof globalScope.DOMPurify.sanitize === "function") {
      return globalScope.DOMPurify;
    }
    return tryRequire("isomorphic-dompurify") || tryRequire("dompurify") || null;
  }

  function isSafeHttpUrl(href) {
    const raw = String(href || "").trim();
    if (!raw) return false;
    // Block schemes that execute or navigate unsafely.
    if (/^\/\//.test(raw)) return false;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
      return /^https?:\/\//i.test(raw);
    }
    // Relative / fragment — not used for model links we emit; reject.
    return false;
  }

  /** Below this length: sync parse + Prism highlight (snappy enough). */
  const MD_SYNC_HIGHLIGHT_CHARS = 12_000;
  /** At/above this length: show plain text first, parse MD in idle. */
  const MD_DEFER_PARSE_CHARS = 48_000;

  function shouldDeferHighlight(text, limit = MD_SYNC_HIGHLIGHT_CHARS) {
    return String(text || "").length >= limit;
  }

  function shouldDeferParse(text, limit = MD_DEFER_PARSE_CHARS) {
    return String(text || "").length >= limit;
  }

  function scheduleIdle(fn, timeoutMs = 400) {
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(() => fn(), { timeout: timeoutMs });
      return () => {
        if (typeof cancelIdleCallback === "function") cancelIdleCallback(id);
      };
    }
    const id = setTimeout(fn, 0);
    return () => clearTimeout(id);
  }

  /**
   * Run Prism on code blocks that were rendered with highlight:false.
   * Skips nodes already marked data-prism="1".
   * @param {ParentNode|null|undefined} root
   * @param {object} [prism]
   * @returns {number} number of blocks highlighted
   */
  function highlightCodeBlocks(root, prism) {
    const eng = prism || globalScope.Prism;
    if (!root || !eng || typeof eng.highlightElement !== "function") return 0;
    let count = 0;
    const codes = root.querySelectorAll
      ? root.querySelectorAll("pre code[class*='language-']")
      : [];
    for (const el of codes) {
      if (!el || el.getAttribute("data-prism") === "1") continue;
      try {
        eng.highlightElement(el);
        el.setAttribute("data-prism", "1");
        count += 1;
      } catch {
        /* ignore single-block failures */
      }
    }
    return count;
  }

  const PURIFY_CONFIG = {
    ALLOWED_TAGS: [
      "p",
      "br",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "blockquote",
      "hr",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "caption",
      "pre",
      "code",
      "strong",
      "em",
      "s",
      "del",
      "a",
      "div",
      "span",
      "button",
      "input",
    ],
    ALLOWED_ATTR: [
      "class",
      "href",
      "title",
      "target",
      "rel",
      "start",
      "value",
      "type",
      "checked",
      "disabled",
      "role",
      "tabindex",
      "aria-label",
      "aria-expanded",
      "data-prism",
      "data-copy",
      "data-toggle",
      "colspan",
      "rowspan",
      "id",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "svg", "math"],
    FORBID_ATTR: ["style"],
  };

  /** @type {import('markdown-it')|null} */
  let mdEngine = null;
  let mdEngineReady = false;

  function configureRenderers(md) {
    const defaultLinkOpen =
      md.renderer.rules.link_open ||
      function linkOpen(tokens, idx, options, env, self) {
        return self.renderToken(tokens, idx, options);
      };

    md.renderer.rules.link_open = function linkOpen(tokens, idx, options, env, self) {
      const token = tokens[idx];
      const href = token.attrGet("href") || "";
      if (!isSafeHttpUrl(href)) {
        token.attrSet("href", "#");
        token.attrSet("data-unsafe-href", "1");
      }
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
      return defaultLinkOpen(tokens, idx, options, env, self);
    };

    md.renderer.rules.heading_open = function headingOpen(tokens, idx, options, env, self) {
      const token = tokens[idx];
      const level = String(token.tag || "h1").replace(/^h/i, "") || "1";
      const cls = `md-h md-h${level}`;
      const existing = token.attrGet("class");
      token.attrSet("class", existing ? `${existing} ${cls}` : cls);
      return self.renderToken(tokens, idx, options);
    };

    md.renderer.rules.blockquote_open = function blockquoteOpen(tokens, idx, options, env, self) {
      const token = tokens[idx];
      const existing = token.attrGet("class");
      token.attrSet("class", existing ? `${existing} md-quote` : "md-quote");
      return self.renderToken(tokens, idx, options);
    };

    // Prefer <del> over <s> for existing CSS / semantics.
    md.renderer.rules.s_open = function sOpen() {
      return "<del>";
    };
    md.renderer.rules.s_close = function sClose() {
      return "</del>";
    };

    md.renderer.rules.code_inline = function codeInline(tokens, idx) {
      return `<code class="md-code-inline">${escHtml(tokens[idx].content)}</code>`;
    };

    function alignClassFromToken(token) {
      const style = token.attrGet("style") || "";
      const m = style.match(/text-align\s*:\s*(left|right|center)/i);
      if (m) return `ta-${m[1].toLowerCase()}`;
      return "";
    }

    function stripStyleAttr(token) {
      if (!token.attrs) return;
      token.attrs = token.attrs.filter((pair) => pair[0] !== "style");
    }

    function cellOpen(tokens, idx, options, env, self) {
      const token = tokens[idx];
      const alignCls = alignClassFromToken(token);
      stripStyleAttr(token);
      if (alignCls) {
        const existing = token.attrGet("class");
        token.attrSet("class", existing ? `${existing} ${alignCls}` : alignCls);
      }
      return self.renderToken(tokens, idx, options);
    }

    md.renderer.rules.th_open = cellOpen;
    md.renderer.rules.td_open = cellOpen;

    md.renderer.rules.table_open = function tableOpen() {
      return (
        '<div class="md-table-scroll" role="region" tabindex="0" aria-label="Markdown table">' +
        '<table class="md-table">'
      );
    };
    md.renderer.rules.table_close = function tableClose() {
      return "</table></div>";
    };

    // Task-list plugin sets contains-task-list; map to existing .md-task styles via CSS.
    // Keep plugin checkbox HTML (disabled) — sanitized later.

    md.renderer.rules.fence = function fence(tokens, idx, options, env) {
      const token = tokens[idx];
      const info = token.info ? String(token.info).trim() : "";
      const lang = info.split(/\s+/u)[0] || "";
      const langLabel = lang || "text";
      const code = String(token.content || "").replace(/\n$/, "");
      const doHighlight = env && env.highlight !== false;

      let highlightedCode = escHtml(code);
      let prismDone = false;
      if (
        doHighlight &&
        lang &&
        globalScope.Prism &&
        globalScope.Prism.languages &&
        globalScope.Prism.languages[lang]
      ) {
        try {
          highlightedCode = globalScope.Prism.highlight(
            code,
            globalScope.Prism.languages[lang],
            lang
          );
          prismDone = true;
        } catch {
          highlightedCode = escHtml(code);
        }
      }

      const lineCount = code.length ? code.split("\n").length : 1;
      const shouldCollapse = lineCount > 20;
      const prismAttr = prismDone ? ' data-prism="1"' : "";
      const langClass = lang ? `language-${escHtml(lang)}` : "language-text";
      const shellClass = shouldCollapse ? "md-code md-code-collapsible" : "md-code";
      const preClass = shouldCollapse ? ' class="md-code-pre-collapsed"' : "";
      const toggleBtn = shouldCollapse
        ? '<button type="button" class="md-code-toggle" data-toggle="1" aria-label="Expand code" aria-expanded="false" title="Expand">▼</button>'
        : "";

      return (
        `<div class="${shellClass}">` +
        `<div class="md-code-head">` +
        `<span class="md-code-lang">${escHtml(langLabel)}</span>` +
        `<span class="md-code-lines">${lineCount} lines</span>` +
        toggleBtn +
        `<button type="button" class="md-code-copy" data-copy="1" title="复制代码">复制代码</button>` +
        `</div>` +
        `<pre${preClass}><code class="${langClass}"${prismAttr}>${highlightedCode}</code></pre>` +
        `</div>`
      );
    };
  }

  function getMdEngine() {
    if (mdEngineReady) return mdEngine;
    mdEngineReady = true;
    const MarkdownIt = resolveMarkdownIt();
    if (!MarkdownIt) {
      mdEngine = null;
      return null;
    }

    const md = new MarkdownIt({
      html: false,
      linkify: true,
      breaks: true,
      typographer: false,
    });

    const multimd = resolveMultimdTable();
    if (typeof multimd === "function") {
      md.use(multimd, {
        multiline: false,
        rowspan: false,
        headerless: false,
        multibody: true,
        autolabel: false,
      });
    }

    const taskLists = resolveTaskLists();
    if (typeof taskLists === "function") {
      md.use(taskLists, { enabled: false, label: false });
    }

    configureRenderers(md);
    mdEngine = md;
    return mdEngine;
  }

  function hasRenderPipeline() {
    return !!(getMdEngine() && resolveDOMPurify());
  }

  /**
   * Sanitize HTML; fail closed to empty string if purifier missing.
   * @param {string} dirty
   * @returns {string}
   */
  function sanitizeHtml(dirty) {
    const purify = resolveDOMPurify();
    if (!purify || typeof purify.sanitize !== "function") return "";
    try {
      return String(purify.sanitize(dirty, PURIFY_CONFIG) || "");
    } catch {
      return "";
    }
  }

  /**
   * @param {string} text
   * @param {{ highlight?: boolean }} [options] highlight defaults to true
   * @returns {string} safe HTML, or "" when empty / pipeline unavailable
   */
  function renderMd(text, options = {}) {
    if (!text) return "";
    const md = getMdEngine();
    if (!md) return "";

    const doHighlight = options.highlight !== false;
    const src = normalizeMdNewlines(text);
    let dirty = "";
    try {
      dirty = md.render(src, { highlight: doHighlight });
    } catch {
      return "";
    }

    // Drop accidental data-unsafe-href markers from the token path if any leaked.
    dirty = dirty.replace(/\sdata-unsafe-href="1"/g, "");

    return sanitizeHtml(dirty);
  }

  /**
   * Paint markdown into a DOM node with deferred work for long replies.
   * Modes:
   *  - sync: parse + highlight immediately (< 12k)
   *  - structure: parse without Prism, highlight on idle (12k–48k)
   *  - plain: textContent first, then structure, then highlight (≥ 48k)
   *  - fallback: pipeline missing → textContent only (fail closed)
   *
   * @param {HTMLElement} targetEl
   * @param {string} text
   * @param {{ onHtml?: (html: string) => void, syncHighlightChars?: number, deferParseChars?: number }} [options]
   * @returns {{ cancel: () => void, deferred: boolean, mode: string }}
   */
  function paintMarkdown(targetEl, text, options = {}) {
    const onHtml = typeof options.onHtml === "function" ? options.onHtml : null;
    const syncLimit =
      typeof options.syncHighlightChars === "number"
        ? options.syncHighlightChars
        : MD_SYNC_HIGHLIGHT_CHARS;
    const plainLimit =
      typeof options.deferParseChars === "number"
        ? options.deferParseChars
        : MD_DEFER_PARSE_CHARS;
    const raw = String(text || "");
    let cancelled = false;
    /** @type {Array<() => void>} */
    const cancelFns = [];

    function cancel() {
      cancelled = true;
      while (cancelFns.length) {
        const fn = cancelFns.pop();
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    }

    function setHtml(html) {
      if (cancelled || !targetEl) return;
      targetEl.classList.remove("is-md-plain");
      targetEl.innerHTML = html;
      if (onHtml) onHtml(html);
    }

    function setPlain() {
      if (cancelled || !targetEl) return;
      targetEl.classList.add("is-md-plain");
      targetEl.classList.remove("is-md-pending-highlight");
      targetEl.textContent = raw;
      if (onHtml) onHtml("");
    }

    function scheduleHighlight() {
      if (cancelled || !targetEl) return;
      targetEl.classList.add("is-md-pending-highlight");
      cancelFns.push(
        scheduleIdle(() => {
          if (cancelled || !targetEl || !targetEl.isConnected) return;
          highlightCodeBlocks(targetEl);
          targetEl.classList.remove("is-md-pending-highlight");
        }, 500)
      );
    }

    if (!targetEl) {
      return { cancel, deferred: false, mode: "noop" };
    }

    // Fail closed: no parser/purifier → never assign untrusted structured HTML.
    if (!hasRenderPipeline()) {
      setPlain();
      return { cancel, deferred: false, mode: "fallback" };
    }

    // Super-long: keep the UI responsive — plain text first frame.
    if (raw.length >= plainLimit) {
      setPlain();
      cancelFns.push(
        scheduleIdle(() => {
          if (cancelled || !targetEl || !targetEl.isConnected) return;
          const html = renderMd(raw, { highlight: false });
          if (!html && raw) {
            setPlain();
            return;
          }
          setHtml(html);
          scheduleHighlight();
        }, 200)
      );
      return { cancel, deferred: true, mode: "plain" };
    }

    // Long: structure immediately, Prism later (Prism is the heavy part).
    if (raw.length >= syncLimit) {
      const html = renderMd(raw, { highlight: false });
      if (!html && raw) {
        setPlain();
        return { cancel, deferred: false, mode: "fallback" };
      }
      setHtml(html);
      scheduleHighlight();
      return { cancel, deferred: true, mode: "structure" };
    }

    const html = renderMd(raw, { highlight: true });
    if (!html && raw) {
      setPlain();
      return { cancel, deferred: false, mode: "fallback" };
    }
    setHtml(html);
    return { cancel, deferred: false, mode: "sync" };
  }

  const api = {
    escHtml,
    renderMd,
    paintMarkdown,
    highlightCodeBlocks,
    shouldDeferHighlight,
    shouldDeferParse,
    scheduleIdle,
    MD_SYNC_HIGHLIGHT_CHARS,
    MD_DEFER_PARSE_CHARS,
    normalizeMdNewlines,
    hasRenderPipeline,
    isSafeHttpUrl,
    // Retained no-op-ish helpers for older tests / callers (deprecated).
    splitTableRow(line) {
      const inner = String(line || "").replace(/^\||\|$/g, "");
      return inner.split("|").map((cell) => cell.trim());
    },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.MarkdownLite = api;
})(typeof window !== "undefined" ? window : globalThis);
