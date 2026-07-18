const assert = require("node:assert/strict");
const test = require("node:test");

const markdownLite = require("../public/markdown-lite.js");

test("escHtml escapes HTML-sensitive characters", () => {
  assert.equal(
    markdownLite.escHtml(`<div class="x">'&"</div>`),
    "&lt;div class=&quot;x&quot;&gt;&#39;&amp;&quot;&lt;/div&gt;"
  );
});

test("renderMd supports headings, lists, links, and tables", () => {
  const html = markdownLite.renderMd([
    "# Title",
    "",
    "- one",
    "- two",
    "",
    "[Docs](https://example.com)",
    "",
    "| name | value |",
    "| :--- | ---: |",
    "| a | 1 |",
  ].join("\n"));

  assert.match(html, /<h1 class="md-h md-h1">Title<\/h1>/);
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener">Docs<\/a>/);
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<th class="ta-left">name<\/th>/);
  assert.match(html, /<td class="ta-right">1<\/td>/);
});

test("renderMd supports h4-h6 and wraps plain paragraphs", () => {
  const html = markdownLite.renderMd([
    "#### P0 — 标题",
    "",
    "第一段第一行",
    "第一段第二行",
    "",
    "第二段",
  ].join("\n"));

  assert.match(html, /<h4 class="md-h md-h4">P0 — 标题<\/h4>/);
  assert.match(html, /<p>第一段第一行<br>第一段第二行<\/p>/);
  assert.match(html, /<p>第二段<\/p>/);
});

test("renderMd accepts GFM tables without leading pipes", () => {
  const html = markdownLite.renderMd([
    "目录 | 用途",
    "--- | ---",
    "src/server/ | HTTP 服务端",
  ].join("\n"));

  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<th>目录<\/th>/);
  assert.match(html, /<td>src\/server\/<\/td>/);
});

test("renderMd renders collapsible fenced code blocks after 20 lines", () => {
  const code = Array.from({ length: 21 }, (_, i) => `line ${i + 1}`).join("\n");
  const html = markdownLite.renderMd(`\`\`\`js\n${code}\n\`\`\``);

  assert.match(html, /class="md-code md-code-collapsible"/);
  assert.match(html, /class="md-code-lines">21 lines<\/span>/);
  assert.match(html, /class="md-code-toggle"/);
  assert.match(html, /class="md-code-copy"/);
  assert.match(html, /class="language-js"/);
});

test("renderMd renders blockquotes after escHtml (leading > becomes &gt;)", () => {
  const simple = markdownLite.renderMd("> hello");
  assert.match(simple, /<blockquote class="md-quote">hello<\/blockquote>/);
  assert.doesNotMatch(simple, /&gt; hello/);

  const multi = markdownLite.renderMd("> a\n> b\n> c");
  assert.match(
    multi,
    /<blockquote class="md-quote">a<br>b<br>c<\/blockquote>/
  );

  // Blank quote line keeps the block open (GFM-ish soft continue).
  const withBlank = markdownLite.renderMd("> a\n>\n> b");
  assert.match(
    withBlank,
    /<blockquote class="md-quote">a<br><br>b<\/blockquote>/
  );

  // Quote content stays escaped.
  const safe = markdownLite.renderMd("> <script>x</script>");
  assert.match(safe, /<blockquote class="md-quote">/);
  assert.match(safe, /&lt;script&gt;/);
  assert.doesNotMatch(safe, /<script>/);
});

test("isBlockquoteLine accepts raw > and escaped &gt;", () => {
  assert.equal(markdownLite.isBlockquoteLine("> hi"), true);
  assert.equal(markdownLite.isBlockquoteLine("&gt; hi"), true);
  assert.equal(markdownLite.isBlockquoteLine("&gt;hi"), true);
  assert.equal(markdownLite.isBlockquoteLine("not a quote"), false);
  assert.equal(markdownLite.stripBlockquotePrefix("&gt; hi"), "hi");
  assert.equal(markdownLite.stripBlockquotePrefix("> hi"), "hi");
});

test("renderMd treats unclosed fences as code through EOF", () => {
  const html = markdownLite.renderMd("before\n```js\nconst x = 1\nstill code");
  assert.match(html, /<p>before<\/p>/);
  assert.match(html, /class="md-code /);
  assert.match(html, /class="language-js"/);
  assert.match(html, /const x = 1/);
  assert.match(html, /still code/);
  // Must not leak fence markers as a paragraph of backticks.
  assert.doesNotMatch(html, /<p>```/);
  assert.doesNotMatch(html, /<p>`js/);
});

test("renderMd unclosed fence without language still becomes a code block", () => {
  const html = markdownLite.renderMd("```\nplain code");
  assert.match(html, /class="md-code /);
  assert.match(html, /plain code/);
  assert.doesNotMatch(html, /<p>```/);
});

test("renderMd does not treat inline triple backticks as an unclosed fence", () => {
  const html = markdownLite.renderMd("Use ``` to describe a fence in prose.");
  assert.doesNotMatch(html, /class="md-code /);
  assert.match(html, /<p>Use ``` to describe a fence in prose\.<\/p>/);
});

test("renderMd closed fences still win over unclosed trailing text", () => {
  const html = markdownLite.renderMd("```js\nclosed\n```\n\nafter");
  assert.match(html, /class="language-js"/);
  assert.match(html, /closed/);
  assert.match(html, /<p>after<\/p>/);
  // One code shell only — trailing "after" is not swallowed.
  assert.equal((html.match(/class="md-code /g) || []).length, 1);
});

test("normalizeMdNewlines converts CRLF and bare CR", () => {
  assert.equal(markdownLite.normalizeMdNewlines("a\r\nb\rc"), "a\nb\nc");
});

test("renderMd continuous text keeps soft line breaks without stray CR", () => {
  const html = markdownLite.renderMd("第一句。\r\n第二句。\r\n第三句。");
  assert.match(html, /<p>第一句。<br>第二句。<br>第三句。<\/p>/);
  assert.doesNotMatch(html, /\r/);
  // One paragraph only — continuous prose, not three spaced blocks.
  assert.equal((html.match(/<p>/g) || []).length, 1);
});

test("renderMd blank lines still split continuous text into paragraphs", () => {
  const html = markdownLite.renderMd("第一段。\n\n第二段。\n\n第三段。");
  assert.equal((html.match(/<p>/g) || []).length, 3);
  assert.match(html, /<p>第一段。<\/p>/);
  assert.match(html, /<p>第二段。<\/p>/);
  assert.match(html, /<p>第三段。<\/p>/);
});

test("renderMd pipe lines without a separator stay continuous text", () => {
  // Previously isTableRowLine was treated as a block start, so each pipe
  // line became its own <p> with extra spacing — broke continuous prose.
  const html = markdownLite.renderMd("A | B | C\nD | E | F\nmore text");
  assert.equal((html.match(/<p>/g) || []).length, 1);
  assert.match(html, /A \| B \| C<br>D \| E \| F<br>more text/);
  assert.doesNotMatch(html, /<table/);
});

test("renderMd still parses real GFM tables after continuous text", () => {
  const html = markdownLite.renderMd(
    ["intro line", "", "| name | value |", "| --- | --- |", "| a | 1 |", "", "outro"].join("\n")
  );
  assert.match(html, /<p>intro line<\/p>/);
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<td>a<\/td>/);
  assert.match(html, /<p>outro<\/p>/);
});

test("renderMd keeps tight ordered lists in a single <ol>", () => {
  const html = markdownLite.renderMd("1. a\n2. b\n3. c");
  assert.match(html, /<ol>\s*<li>a<\/li>\s*<li>b<\/li>\s*<li>c<\/li>\s*<\/ol>/);
  assert.equal((html.match(/<ol\b/g) || []).length, 1);
});

test("renderMd keeps loose ordered lists (blank lines) in one <ol> so markers are 1,2,3", () => {
  // LLM replies often insert blank lines between steps; each separate <ol>
  // would restart at 1 in the browser.
  const html = markdownLite.renderMd("1. a\n\n2. b\n\n3. c");
  assert.equal((html.match(/<ol\b/g) || []).length, 1);
  assert.match(html, /<ol>\s*<li>a<\/li>\s*<li>b<\/li>\s*<li>c<\/li>\s*<\/ol>/);
});

test("renderMd keeps loose unordered lists in one <ul>", () => {
  const html = markdownLite.renderMd("- a\n\n- b\n\n- c");
  assert.equal((html.match(/<ul\b/g) || []).length, 1);
  assert.match(html, /<ul>\s*<li>a<\/li>\s*<li>b<\/li>\s*<li>c<\/li>\s*<\/ul>/);
});

test("renderMd honors ordered list start and value jumps", () => {
  const startHtml = markdownLite.renderMd("3. third\n4. fourth");
  assert.match(startHtml, /<ol start="3">\s*<li>third<\/li>\s*<li>fourth<\/li>\s*<\/ol>/);

  const jumpHtml = markdownLite.renderMd("1. a\n2. b\n5. e");
  assert.match(jumpHtml, /<ol>\s*<li>a<\/li>\s*<li>b<\/li>\s*<li value="5">e<\/li>\s*<\/ol>/);
});

test("renderMd keeps indented ordered-list continuations in the same item", () => {
  const html = markdownLite.renderMd("1. a\n   cont\n2. b");
  assert.equal((html.match(/<ol\b/g) || []).length, 1);
  assert.match(html, /<li>a<br>cont<\/li>/);
  assert.match(html, /<li>b<\/li>/);
});

test("renderMd ends a list when a real paragraph follows a blank line", () => {
  const html = markdownLite.renderMd("1. a\n2. b\n\npara\n\n1. c");
  assert.equal((html.match(/<ol\b/g) || []).length, 2);
  assert.match(html, /<p>para<\/p>/);
});

test("renderMd highlight:false skips Prism and omits data-prism", () => {
  const prev = global.Prism;
  let calls = 0;
  global.Prism = {
    languages: { js: {} },
    highlight(code) {
      calls += 1;
      return `HIGHLIGHTED:${code}`;
    },
  };
  try {
    const off = markdownLite.renderMd("```js\nconst x = 1\n```", { highlight: false });
    assert.equal(calls, 0);
    assert.doesNotMatch(off, /data-prism="1"/);
    assert.match(off, /const x = 1/);

    const on = markdownLite.renderMd("```js\nconst x = 1\n```", { highlight: true });
    assert.equal(calls, 1);
    assert.match(on, /data-prism="1"/);
    assert.match(on, /HIGHLIGHTED:/);
  } finally {
    global.Prism = prev;
  }
});

test("shouldDeferHighlight / shouldDeferParse use length thresholds", () => {
  assert.equal(markdownLite.shouldDeferHighlight("short"), false);
  assert.equal(
    markdownLite.shouldDeferHighlight("x".repeat(markdownLite.MD_SYNC_HIGHLIGHT_CHARS)),
    true
  );
  assert.equal(markdownLite.shouldDeferParse("x".repeat(1000)), false);
  assert.equal(
    markdownLite.shouldDeferParse("x".repeat(markdownLite.MD_DEFER_PARSE_CHARS)),
    true
  );
});

test("paintMarkdown sync mode paints immediately for short text", () => {
  const el = {
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
    },
    innerHTML: "",
    textContent: "",
    isConnected: true,
  };
  const htmls = [];
  const job = markdownLite.paintMarkdown(el, "**hi**", {
    onHtml(html) { htmls.push(html); },
  });
  assert.equal(job.mode, "sync");
  assert.equal(job.deferred, false);
  assert.match(el.innerHTML, /<strong>hi<\/strong>/);
  assert.equal(htmls.length, 1);
});

test("paintMarkdown structure mode defers Prism for medium-long text", async () => {
  const el = {
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
    },
    innerHTML: "",
    textContent: "",
    isConnected: true,
    querySelectorAll() {
      return [];
    },
  };
  const body = `# Title\n\n${"paragraph text ".repeat(900)}`;
  assert.ok(body.length >= markdownLite.MD_SYNC_HIGHLIGHT_CHARS);
  assert.ok(body.length < markdownLite.MD_DEFER_PARSE_CHARS);

  const job = markdownLite.paintMarkdown(el, body);
  assert.equal(job.mode, "structure");
  assert.equal(job.deferred, true);
  assert.match(el.innerHTML, /<h1/);
  assert.ok(el.classList._set.has("is-md-pending-highlight"));
  job.cancel();
});

test("paintMarkdown plain mode shows textContent first for very long text", () => {
  const el = {
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
    },
    innerHTML: "stale",
    textContent: "",
    isConnected: true,
    querySelectorAll() {
      return [];
    },
  };
  const body = "x".repeat(markdownLite.MD_DEFER_PARSE_CHARS);
  const job = markdownLite.paintMarkdown(el, body);
  assert.equal(job.mode, "plain");
  assert.equal(job.deferred, true);
  assert.ok(el.classList._set.has("is-md-plain"));
  assert.equal(el.textContent, body);
  job.cancel();
});

test("highlightCodeBlocks marks and skips already-highlighted nodes", () => {
  const highlighted = [];
  const prism = {
    highlightElement(el) {
      highlighted.push(el);
      el.setAttribute("data-prism", "1");
    },
  };
  const a = { getAttribute: () => null, setAttribute() {}, className: "language-js" };
  const b = {
    getAttribute: (k) => (k === "data-prism" ? "1" : null),
    setAttribute() {},
    className: "language-js",
  };
  const root = {
    querySelectorAll() {
      return [a, b];
    },
  };
  const n = markdownLite.highlightCodeBlocks(root, prism);
  assert.equal(n, 1);
  assert.deepEqual(highlighted, [a]);
});
