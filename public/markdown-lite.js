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

  function isBlockStartLine(line) {
    const raw = String(line || "");
    if (!raw.trim()) return true;
    if (/^---+\s*$/.test(raw) || /^\*\*\*+\s*$/.test(raw)) return true;
    if (/^#{1,6}\s+/.test(raw)) return true;
    if (/^[-*]\s+/.test(raw)) return true;
    if (/^\d+\.\s+/.test(raw)) return true;
    if (/^>\s?/.test(raw)) return true;
    if (isTableRowLine(raw)) return true;
    return false;
  }

  function renderMd(text) {
    if (!text) return "";

    const marker = "\uE000";
    const codeBlocks = [];
    const inlineCodes = [];
    let html = escHtml(text);

    // Fenced code: allow optional trailing spaces on the closing fence.
    html = html.replace(/```([\w+-]*)\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
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
    const closeList = () => {
      if (inList) {
        out.push(`</${inList}>`);
        inList = null;
        listType = null;
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

      const task = raw.match(/^[-*]\s+\[([ xX])\]\s+(.+)/);
      if (task) {
        if (inList !== "ul" || listType !== "task") {
          closeList();
          out.push("<ul class=\"md-task\">");
          inList = "ul";
          listType = "task";
        }
        const checked = task[1] !== " ";
        out.push(`<li><input type="checkbox" disabled${checked ? " checked" : ""}><span>${task[2]}</span></li>`);
        i++;
        continue;
      }

      const ul = raw.match(/^[-*]\s+(.+)/);
      if (ul) {
        if (inList !== "ul" || listType !== "ul") {
          closeList();
          out.push("<ul>");
          inList = "ul";
          listType = "ul";
        }
        out.push(`<li>${ul[1]}</li>`);
        i++;
        continue;
      }

      const ol = raw.match(/^\d+\.\s+(.+)/);
      if (ol) {
        if (inList !== "ol") {
          closeList();
          out.push("<ol>");
          inList = "ol";
          listType = "ol";
        }
        out.push(`<li>${ol[1]}</li>`);
        i++;
        continue;
      }

      if (/^>\s?/.test(raw)) {
        closeList();
        const quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        out.push(`<blockquote class="md-quote">${quoteLines.join("<br>")}</blockquote>`);
        continue;
      }

      if (raw.trim() === "") {
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
      closeList();
      const paraLines = [raw];
      i++;
      while (
        i < lines.length
        && !isBlockStartLine(lines[i])
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
      if (lang && globalScope.Prism && globalScope.Prism.languages && globalScope.Prism.languages[lang]) {
        try {
          highlightedCode = globalScope.Prism.highlight(code, globalScope.Prism.languages[lang], lang);
        } catch {
          highlightedCode = code;
        }
      }
      const lineCount = code.split("\n").length;
      const shouldCollapse = lineCount > 20;

      return `<div class="md-code ${shouldCollapse ? "md-code-collapsible" : ""}">
          <div class="md-code-head">
            <span class="md-code-lang">${escHtml(langLabel)}</span>
            <span class="md-code-lines">${lineCount} lines</span>
            ${shouldCollapse ? '<button type="button" class="md-code-toggle" data-toggle="1">▼</button>' : ""}
            <button type="button" class="md-code-copy" data-copy="1" title="复制代码">复制代码</button>
          </div>
          <pre class="${shouldCollapse ? "md-code-pre-collapsed" : ""}"><code class="language-${escHtml(lang)}">${highlightedCode}</code></pre>
        </div>`;
    });

    return html;
  }

  const api = { escHtml, splitTableRow, renderMd };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.MarkdownLite = api;
})(typeof window !== "undefined" ? window : globalThis);
