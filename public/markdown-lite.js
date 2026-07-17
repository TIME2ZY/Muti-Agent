(function initMarkdownLite(globalScope) {
  "use strict";

  const ESC_MAP = { "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" };

  function escHtml(text) {
    return String(text).replace(/[&<>"']/g, (match) => ESC_MAP[match]);
  }

  function splitTableRow(line) {
    const inner = line.replace(/^\||\|$/g, "");
    return inner.split("|").map((cell) => cell.trim());
  }

  function isTableRowLine(line) {
    const t = String(line || "").trim();
    if (!t || t.indexOf("|") === -1) return false;
    // At least one cell separator; allow missing leading/trailing pipes (GFM).
    return /^\|?.+\|.+\|?\s*$/.test(t) && !/^[-*]\s+/.test(t) && !/^\d+\.\s+/.test(t);
  }

  function isTableSepLine(line) {
    const t = String(line || "").trim();
    if (!t || t.indexOf("|") === -1) return false;
    return /^\|?[\s:|-]+\|[\s:|-]+\|?\s*$/.test(t);
  }

  /** True table starts only when a row is followed by a separator row. */
  function isTableStartAt(lines, index) {
    if (!Array.isArray(lines) || index < 0 || index >= lines.length) return false;
    return isTableRowLine(lines[index]) && index + 1 < lines.length && isTableSepLine(lines[index + 1]);
  }

  /**
   * Normalize newlines before parse. Windows CLIs often emit CRLF; bare CR
   * also appears in progress rewrites. Leaving \r in HTML breaks continuous
   * text layout and can confuse line-oriented matchers.
   */
  function normalizeMdNewlines(text) {
    return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  /**
   * Blockquote prefix after escHtml: ">" becomes "&gt;".
   * Accept both so pre-escape call sites (if any) still work.
   */
  function isBlockquoteLine(line) {
    return /^(&gt;|>)\s?/.test(String(line || ""));
  }

  function stripBlockquotePrefix(line) {
    return String(line || "").replace(/^(&gt;|>)\s?/, "");
  }

  function isBlockStartLine(line) {
    const raw = String(line || "");
    if (!raw.trim()) return true;
    if (/^---+\s*$/.test(raw) || /^\*\*\*+\s*$/.test(raw)) return true;
    if (/^#{1,6}\s+/.test(raw)) return true;
    if (/^[-*]\s+/.test(raw)) return true;
    if (/^\d+\.\s+/.test(raw)) return true;
    if (isBlockquoteLine(raw)) return true;
    // Do NOT treat bare pipe-rows as block starts — continuous prose like
    // "A | B" lines would otherwise be split into one <p> per line. Real
    // tables are detected via isTableStartAt (row + separator look-ahead).
    return false;
  }

  /** Hard block that always ends a list (not blank, not a list item). */
  function isHardBlockStart(line, marker) {
    const raw = String(line || "");
    if (!raw.trim()) return false;
    if (/^---+\s*$/.test(raw) || /^\*\*\*+\s*$/.test(raw)) return true;
    if (/^#{1,6}\s+/.test(raw)) return true;
    if (isBlockquoteLine(raw)) return true;
    if (marker && new RegExp(`^${marker}\\d+${marker}$`).test(raw.trim())) return true;
    return false;
  }

  function matchOrderedItem(line) {
    const m = String(line || "").match(/^(\d+)\.\s+(.*)$/);
    if (!m) return null;
    return { n: parseInt(m[1], 10), text: m[2] };
  }

  function matchTaskItem(line) {
    const m = String(line || "").match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (!m) return null;
    return { checked: m[1] !== " ", text: m[2] };
  }

  function matchUnorderedItem(line) {
    if (matchTaskItem(line)) return null;
    const m = String(line || "").match(/^[-*]\s+(.*)$/);
    if (!m) return null;
    return { text: m[1] };
  }

  function isAnyListItemLine(line) {
    return !!(matchOrderedItem(line) || matchTaskItem(line) || matchUnorderedItem(line));
  }

  function peekNextNonEmpty(lines, from) {
    let j = from;
    while (j < lines.length && !String(lines[j]).trim()) j += 1;
    return j;
  }

  /**
   * Consume continuation lines for a list item.
   * - Indented lines (2+ spaces / tab) stay in the same <li>
   * - Blank line before the next list item is NOT consumed here (outer loop
   *   keeps the parent <ol>/<ul> open)
   * - Blank line then unindented paragraph ends the item (and the list)
   * @returns {{ body: string, nextIndex: number }}
   */
  function consumeListItemBody(lines, itemIndex, firstContent, marker) {
    const parts = [firstContent];
    let j = itemIndex + 1;
    while (j < lines.length) {
      const line = lines[j];

      if (!String(line).trim()) {
        const next = peekNextNonEmpty(lines, j + 1);
        if (next >= lines.length) break;
        // Sibling list item after blank → stop body; blankContinuesList keeps list open.
        if (isAnyListItemLine(lines[next])) break;
        if (isHardBlockStart(lines[next], marker)) break;
        // Indented text after blank still belongs to this item.
        if (/^(?: {2,}|\t)\S/.test(lines[next])) {
          j = next;
          parts.push(String(lines[j]).replace(/^\s+/, ""));
          j += 1;
          continue;
        }
        // Unindented paragraph after blank ends the list item.
        break;
      }

      if (isAnyListItemLine(line)) break;
      if (isHardBlockStart(line, marker)) break;

      // Indented continuation (2+ spaces / tab) stays in the item.
      if (/^(?: {2,}|\t)\S/.test(line)) {
        parts.push(String(line).replace(/^\s+/, ""));
        j += 1;
        continue;
      }

      // Unindented plain line after a list marker ends the item (new paragraph).
      break;
    }
    return { body: parts.join("<br>"), nextIndex: j };
  }

  /**
   * Blank line between same-kind list items must NOT close the list —
   * otherwise each item becomes its own <ol> and every marker shows "1".
   */
  function blankContinuesList(lines, blankIndex, inList, listType) {
    if (!inList) return false;
    const next = peekNextNonEmpty(lines, blankIndex + 1);
    if (next >= lines.length) return false;
    const line = lines[next];
    if (inList === "ol") return !!matchOrderedItem(line);
    if (inList === "ul" && listType === "task") return !!matchTaskItem(line);
    if (inList === "ul" && listType === "ul") return !!matchUnorderedItem(line);
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

  /**
   * Paint markdown into a DOM node with deferred work for long replies.
   * Modes:
   *  - sync: parse + highlight immediately (< 12k)
   *  - structure: parse without Prism, highlight on idle (12k–48k)
   *  - plain: textContent first, then structure, then highlight (≥ 48k)
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

    // Super-long: keep the UI responsive — plain text first frame.
    if (raw.length >= plainLimit) {
      targetEl.classList.add("is-md-plain");
      targetEl.classList.remove("is-md-pending-highlight");
      targetEl.textContent = raw;
      if (onHtml) onHtml("");
      cancelFns.push(
        scheduleIdle(() => {
          if (cancelled || !targetEl || !targetEl.isConnected) return;
          const html = renderMd(raw, { highlight: false });
          setHtml(html);
          scheduleHighlight();
        }, 200)
      );
      return { cancel, deferred: true, mode: "plain" };
    }

    // Long: structure immediately, Prism later (Prism is the heavy part).
    if (raw.length >= syncLimit) {
      const html = renderMd(raw, { highlight: false });
      setHtml(html);
      scheduleHighlight();
      return { cancel, deferred: true, mode: "structure" };
    }

    const html = renderMd(raw, { highlight: true });
    setHtml(html);
    return { cancel, deferred: false, mode: "sync" };
  }

  /**
   * @param {string} text
   * @param {{ highlight?: boolean }} [options] highlight defaults to true
   */
  function renderMd(text, options = {}) {
    if (!text) return "";
    const doHighlight = options.highlight !== false;

    const marker = "\uE000";
    const codeBlocks = [];
    const inlineCodes = [];
    let html = escHtml(normalizeMdNewlines(text));

    // Fenced code: allow optional trailing spaces on the closing fence.
    html = html.replace(/```([\w+-]*)\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: lang || "", code: code.replace(/\n$/, "") });
      return `${marker}${idx}${marker}`;
    });

    // Unclosed fence (stream abort / model omitted closer): treat rest of
    // document as a code block so backticks don't leak as raw paragraphs.
    html = html.replace(/```([\w+-]*)\r?\n?([\s\S]*)$/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: lang || "", code: code.replace(/\n$/, "") });
      return `${marker}${idx}${marker}`;
    });

    html = html.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(code);
      return `${marker}i${idx}${marker}`;
    });

    const lines = html.split("\n");
    const out = [];
    let i = 0;
    let inList = null;
    let listType = null;
    /** Next expected ordered value (for value= when LLM skips numbers). */
    let listNextExpected = 1;
    const closeList = () => {
      if (inList) {
        out.push(`</${inList}>`);
        inList = null;
        listType = null;
        listNextExpected = 1;
      }
    };

    while (i < lines.length) {
      const raw = lines[i];

      if (/^---+\s*$/.test(raw) || /^\*\*\*+\s*$/.test(raw)) {
        closeList();
        out.push("<hr>");
        i++;
        continue;
      }

      if (isTableRowLine(raw) && i + 1 < lines.length && isTableSepLine(lines[i + 1])) {
        closeList();
        const headerCells = splitTableRow(raw);
        const alignCells = splitTableRow(lines[i + 1]);
        const aligns = alignCells.map((cell) => {
          const left = cell.trim().startsWith(":");
          const right = cell.trim().endsWith(":");
          if (left && right) return "center";
          if (right) return "right";
          if (left) return "left";
          return "";
        });
        const bodyRows = [];
        let j = i + 2;
        while (j < lines.length && isTableRowLine(lines[j]) && !isTableSepLine(lines[j]) && lines[j].trim()) {
          bodyRows.push(splitTableRow(lines[j]));
          j++;
        }
        out.push("<table class=\"md-table\"><thead><tr>");
        headerCells.forEach((cell, k) => {
          const align = aligns[k] ? ` class="ta-${aligns[k]}"` : "";
          out.push(`<th${align}>${cell}</th>`);
        });
        out.push("</tr></thead><tbody>");
        bodyRows.forEach((row) => {
          out.push("<tr>");
          row.forEach((cell, k) => {
            const align = aligns[k] ? ` class="ta-${aligns[k]}"` : "";
            out.push(`<td${align}>${cell}</td>`);
          });
          out.push("</tr>");
        });
        out.push("</tbody></table>");
        i = j;
        continue;
      }

      // Headings h1–h6 (was h1–h3 only — #### etc. leaked as raw text).
      const heading = raw.match(/^(#{1,6})\s+(.+)/);
      if (heading) {
        closeList();
        const level = heading[1].length;
        out.push(`<h${level} class="md-h md-h${level}">${heading[2]}</h${level}>`);
        i++;
        continue;
      }

      const task = matchTaskItem(raw);
      if (task) {
        if (inList !== "ul" || listType !== "task") {
          closeList();
          out.push("<ul class=\"md-task\">");
          inList = "ul";
          listType = "task";
        }
        const { body, nextIndex } = consumeListItemBody(lines, i, task.text, marker);
        out.push(
          `<li><input type="checkbox" disabled${task.checked ? " checked" : ""}><span>${body}</span></li>`
        );
        i = nextIndex;
        continue;
      }

      const ul = matchUnorderedItem(raw);
      if (ul) {
        if (inList !== "ul" || listType !== "ul") {
          closeList();
          out.push("<ul>");
          inList = "ul";
          listType = "ul";
        }
        const { body, nextIndex } = consumeListItemBody(lines, i, ul.text, marker);
        out.push(`<li>${body}</li>`);
        i = nextIndex;
        continue;
      }

      const ol = matchOrderedItem(raw);
      if (ol) {
        if (inList !== "ol") {
          closeList();
          // Honor non-1 starts (e.g. continued steps "3. …").
          const startAttr = ol.n !== 1 ? ` start="${ol.n}"` : "";
          out.push(`<ol${startAttr}>`);
          inList = "ol";
          listType = "ol";
          listNextExpected = ol.n;
        }
        // If the source number jumps, set HTML value so markers stay correct.
        const valueAttr = ol.n !== listNextExpected ? ` value="${ol.n}"` : "";
        const { body, nextIndex } = consumeListItemBody(lines, i, ol.text, marker);
        out.push(`<li${valueAttr}>${body}</li>`);
        listNextExpected = ol.n + 1;
        i = nextIndex;
        continue;
      }

      if (isBlockquoteLine(raw)) {
        closeList();
        const quoteLines = [];
        while (i < lines.length && isBlockquoteLine(lines[i])) {
          quoteLines.push(stripBlockquotePrefix(lines[i]));
          i++;
        }
        out.push(`<blockquote class="md-quote">${quoteLines.join("<br>")}</blockquote>`);
        continue;
      }

      if (raw.trim() === "") {
        // Keep one <ol>/<ul> across blank lines when the next item continues it.
        // (Previously closeList() here → N separate <ol> → every item rendered as "1".)
        if (blankContinuesList(lines, i, inList, listType)) {
          i++;
          continue;
        }
        closeList();
        out.push("");
        i++;
        continue;
      }

      // Fenced-code placeholders must stay top-level (not wrapped in <p>).
      if (new RegExp(`^${marker}\\d+${marker}$`).test(raw.trim())) {
        closeList();
        out.push(raw.trim());
        i++;
        continue;
      }

      // Paragraphs: wrap plain lines so newlines/structure survive without
      // relying on white-space:pre-wrap (which breaks lists/tables styling).
      // Soft line breaks → <br> (chat-friendly; keeps single-\n agent prose).
      closeList();
      const paraLines = [raw];
      i++;
      while (
        i < lines.length
        && !isBlockStartLine(lines[i])
        && !isTableStartAt(lines, i)
        && !new RegExp(`^${marker}\\d+${marker}$`).test(String(lines[i]).trim())
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      out.push(`<p>${paraLines.join("<br>")}</p>`);
    }
    closeList();

    html = out.join("\n");
    // Autolink angle-bracket URLs that survived escHtml as &lt;http...&gt;
    html = html.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    html = html.replace(/&lt;(http[^&\s]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    // Also keep the pre-escape form for code-marker paths that reintroduce raw tags.
    html = html.replace(/<(http[^>\s]+)>/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, label, url) => `<a href="${escHtml(url)}" target="_blank" rel="noopener">${label}</a>`);
    html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    // Bold: allow multi-word and CJK without requiring non-* only between stars greedily per segment.
    html = html.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");

    html = html.replace(new RegExp(`${marker}i(\\d+)${marker}`, "g"), (_, k) =>
      `<code class="md-code-inline">${inlineCodes[+k]}</code>`);

    html = html.replace(new RegExp(`${marker}(\\d+)${marker}`, "g"), (_, k) => {
      const { lang, code } = codeBlocks[+k];
      const langLabel = lang || "text";
      let highlightedCode = code;
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
          highlightedCode = code;
        }
      }
      const lineCount = code.split("\n").length;
      const shouldCollapse = lineCount > 20;
      const prismAttr = prismDone ? ' data-prism="1"' : "";

      return `<div class="md-code ${shouldCollapse ? "md-code-collapsible" : ""}">
          <div class="md-code-head">
            <span class="md-code-lang">${escHtml(langLabel)}</span>
            <span class="md-code-lines">${lineCount} lines</span>
            ${shouldCollapse ? '<button type="button" class="md-code-toggle" data-toggle="1">▼</button>' : ""}
            <button type="button" class="md-code-copy" data-copy="1" title="复制代码">复制代码</button>
          </div>
          <pre class="${shouldCollapse ? "md-code-pre-collapsed" : ""}"><code class="language-${escHtml(lang)}"${prismAttr}>${highlightedCode}</code></pre>
        </div>`;
    });

    return html;
  }

  const api = {
    escHtml,
    splitTableRow,
    renderMd,
    paintMarkdown,
    highlightCodeBlocks,
    shouldDeferHighlight,
    shouldDeferParse,
    scheduleIdle,
    MD_SYNC_HIGHLIGHT_CHARS,
    MD_DEFER_PARSE_CHARS,
    // helpers (exported for unit tests)
    normalizeMdNewlines,
    isTableStartAt,
    isTableRowLine,
    isBlockquoteLine,
    stripBlockquotePrefix,
    matchOrderedItem,
    matchUnorderedItem,
    matchTaskItem,
    blankContinuesList,
    consumeListItemBody,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.MarkdownLite = api;
})(typeof window !== "undefined" ? window : globalThis);
