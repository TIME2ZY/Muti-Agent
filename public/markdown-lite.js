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

  function renderMd(text) {
    if (!text) return "";

    const marker = "\uE000";
    const codeBlocks = [];
    const inlineCodes = [];
    let html = escHtml(text);

    html = html.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
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

      if (/^\|.*\|\s*$/.test(raw) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
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
        while (j < lines.length && /^\|.*\|\s*$/.test(lines[j]) && lines[j].trim()) {
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

      const heading = raw.match(/^(#{1,3})\s+(.+)/);
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

      closeList();
      out.push(raw);
      i++;
    }
    closeList();

    html = out.join("\n");
    html = html.replace(/<(http[^>\s]+)>/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, label, url) => `<a href="${escHtml(url)}" target="_blank" rel="noopener">${escHtml(label)}</a>`);
    html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

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
            <button type="button" class="md-code-copy" data-copy="1">Copy</button>
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
