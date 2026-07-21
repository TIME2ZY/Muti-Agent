const assert = require("node:assert/strict");
const test = require("node:test");

const markdownLite = require("../public/markdown-lite.js");

test("render pipeline is available under Node (markdown-it + purifier)", () => {
  assert.equal(markdownLite.hasRenderPipeline(), true);
});

test("escHtml escapes HTML-sensitive characters", () => {
  assert.equal(
    markdownLite.escHtml(`<div class="x">'&"</div>`),
    "&lt;div class=&quot;x&quot;&gt;&#39;&amp;&quot;&lt;/div&gt;"
  );
});

test("normalizeMdNewlines converts CRLF and bare CR", () => {
  assert.equal(markdownLite.normalizeMdNewlines("a\r\nb\rc"), "a\nb\nc");
});

test("renderMd supports headings, lists, links, and tables", () => {
  const html = markdownLite.renderMd(
    [
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
    ].join("\n")
  );

  assert.match(html, /<h1 class="md-h md-h1">Title<\/h1>/);
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
  assert.match(
    html,
    /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">Docs<\/a>/
  );
  assert.match(html, /class="md-table-scroll"/);
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /class="ta-left"[^>]*>name</);
  assert.match(html, /class="ta-right"[^>]*>1</);
});

test("renderMd supports h4-h6 and wraps plain paragraphs with soft breaks", () => {
  const html = markdownLite.renderMd(
    ["#### P0 — 标题", "", "第一段第一行", "第一段第二行", "", "第二段"].join("\n")
  );

  assert.match(html, /<h4 class="md-h md-h4">P0 — 标题<\/h4>/);
  assert.match(html, /<p>第一段第一行<br>\s*第一段第二行<\/p>/);
  assert.match(html, /<p>第二段<\/p>/);
});

test("renderMd accepts GFM tables without leading pipes", () => {
  const html = markdownLite.renderMd(
    ["目录 | 用途", "--- | ---", "src/server/ | HTTP 服务端"].join("\n")
  );

  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<th>目录<\/th>/);
  assert.match(html, /<td>src\/server\/<\/td>/);
});

test("renderMd renders nested lists", () => {
  const html = markdownLite.renderMd("- parent\n  - child\n  - child2\n- parent2");
  assert.match(html, /<ul>\s*<li>parent\s*<ul>\s*<li>child<\/li>\s*<li>child2<\/li>\s*<\/ul>\s*<\/li>\s*<li>parent2<\/li>\s*<\/ul>/);
});

test("renderMd renders lists inside blockquotes", () => {
  const html = markdownLite.renderMd("> quote\n> - item\n> - item2");
  assert.match(html, /<blockquote class="md-quote">/);
  assert.match(html, /<ul>\s*<li>item<\/li>\s*<li>item2<\/li>\s*<\/ul>/);
});

test("renderMd supports tilde fences and setext headings", () => {
  const tilde = markdownLite.renderMd("~~~\nplain code\n~~~");
  assert.match(tilde, /class="md-code"/);
  assert.match(tilde, /plain code/);
  assert.doesNotMatch(tilde, /<del>/);

  const setext = markdownLite.renderMd("Title\n=====\n\nSub\n-----");
  assert.match(setext, /<h1 class="md-h md-h1">Title<\/h1>/);
  assert.match(setext, /<h2 class="md-h md-h2">Sub<\/h2>/);
});

test("renderMd keeps parentheses inside link destinations", () => {
  const html = markdownLite.renderMd("[docs](https://example.com/a_(b))");
  assert.match(
    html,
    /href="https:\/\/example\.com\/a_\(b\)"/
  );
  assert.doesNotMatch(html, /<\/a>\)/);
});

test("renderMd handles escaped pipes in tables", () => {
  const html = markdownLite.renderMd("| a \\| b | c |\n| --- | --- |\n| 1 | 2 |");
  assert.match(html, /<th>a \| b<\/th>/);
  assert.match(html, /<th>c<\/th>/);
  assert.match(html, /<td>1<\/td>/);
});

test("renderMd renders collapsible fenced code blocks after 20 lines", () => {
  const code = Array.from({ length: 21 }, (_, i) => `line ${i + 1}`).join("\n");
  const html = markdownLite.renderMd("```js\n" + code + "\n```");

  assert.match(html, /class="md-code md-code-collapsible"/);
  assert.match(html, /class="md-code-lines">21 lines<\/span>/);
  assert.match(html, /class="md-code-toggle"/);
  assert.match(html, /data-toggle="1"/);
  assert.match(html, /class="md-code-copy"/);
  assert.match(html, /data-copy="1"/);
  assert.match(html, /class="language-js"/);
  assert.match(html, /aria-expanded="false"/);
});

test("renderMd renders blockquotes and escapes raw HTML", () => {
  const simple = markdownLite.renderMd("> hello");
  assert.match(simple, /<blockquote class="md-quote">/);
  assert.match(simple, /hello/);
  assert.doesNotMatch(simple, /&gt; hello/);

  const multi = markdownLite.renderMd("> a\n> b\n> c");
  assert.match(multi, /<blockquote class="md-quote">/);
  assert.match(multi, /a<br>\s*b<br>\s*c/);

  const safe = markdownLite.renderMd("> <script>x</script>");
  assert.match(safe, /<blockquote class="md-quote">/);
  assert.match(safe, /&lt;script&gt;/);
  assert.doesNotMatch(safe, /<script>/);
});

test("renderMd treats unclosed fences as code through EOF", () => {
  const html = markdownLite.renderMd("before\n```js\nconst x = 1\nstill code");
  assert.match(html, /<p>before<\/p>/);
  assert.match(html, /class="md-code"/);
  assert.match(html, /class="language-js"/);
  assert.match(html, /const x = 1/);
  assert.match(html, /still code/);
});

test("renderMd closed fences still win over trailing text", () => {
  const html = markdownLite.renderMd("```js\nclosed\n```\n\nafter");
  assert.match(html, /class="language-js"/);
  assert.match(html, /closed/);
  assert.match(html, /<p>after<\/p>/);
  assert.equal((html.match(/class="md-code(?:\s|")/g) || []).length, 1);
});

test("renderMd continuous text keeps soft line breaks without stray CR", () => {
  const html = markdownLite.renderMd("第一句。\r\n第二句。\r\n第三句。");
  assert.match(html, /<p>第一句。<br>\s*第二句。<br>\s*第三句。<\/p>/);
  assert.doesNotMatch(html, /\r/);
  assert.equal((html.match(/<p>/g) || []).length, 1);
});

test("renderMd blank lines still split continuous text into paragraphs", () => {
  const html = markdownLite.renderMd("第一段。\n\n第二段。\n\n第三段。");
  assert.equal((html.match(/<p>/g) || []).length, 3);
});

test("renderMd pipe lines without a separator stay continuous text", () => {
  const html = markdownLite.renderMd("A | B | C\nD | E | F\nmore text");
  assert.equal((html.match(/<p>/g) || []).length, 1);
  assert.match(html, /A \| B \| C<br>\s*D \| E \| F<br>\s*more text/);
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

test("renderMd keeps tight and loose lists in a single list element", () => {
  const tight = markdownLite.renderMd("1. a\n2. b\n3. c");
  assert.equal((tight.match(/<ol\b/g) || []).length, 1);

  const looseOl = markdownLite.renderMd("1. a\n\n2. b\n\n3. c");
  assert.equal((looseOl.match(/<ol\b/g) || []).length, 1);

  const looseUl = markdownLite.renderMd("- a\n\n- b\n\n- c");
  assert.equal((looseUl.match(/<ul\b/g) || []).length, 1);
});

test("renderMd honors ordered list start attribute", () => {
  const startHtml = markdownLite.renderMd("3. third\n4. fourth");
  assert.match(startHtml, /<ol start="3">/);
  assert.match(startHtml, /third/);
  assert.match(startHtml, /fourth/);
});

test("renderMd keeps indented list continuations in the same item", () => {
  const html = markdownLite.renderMd("1. a\n   cont\n2. b");
  assert.equal((html.match(/<ol\b/g) || []).length, 1);
  assert.match(html, /a<br>\s*cont/);
  assert.match(html, /<li>b<\/li>/);
});

test("renderMd ends a list when a real paragraph follows a blank line", () => {
  const html = markdownLite.renderMd("1. a\n2. b\n\npara\n\n1. c");
  assert.equal((html.match(/<ol\b/g) || []).length, 2);
  assert.match(html, /<p>para<\/p>/);
});

test("renderMd renders task lists with disabled checkboxes", () => {
  const html = markdownLite.renderMd("- [x] done\n- [ ] todo");
  assert.match(html, /contains-task-list|md-task/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /checked/);
  assert.match(html, /disabled/);
  assert.match(html, /done/);
  assert.match(html, /todo/);
});

test("renderMd does not crash on private-use placeholder-like text", () => {
  const weird = "hello \uE0000\uE000 world **ok**";
  assert.doesNotThrow(() => markdownLite.renderMd(weird));
  const html = markdownLite.renderMd(weird);
  assert.match(html, /<strong>ok<\/strong>/);
});

test("renderMd strips raw HTML and dangerous URL schemes", () => {
  const raw = markdownLite.renderMd('<img src=x onerror=alert(1)><script>x</script>');
  // Escaped as text is fine; must not remain live tags/attributes.
  assert.doesNotMatch(raw, /<script\b/i);
  assert.doesNotMatch(raw, /<img\b/i);
  assert.doesNotMatch(raw, /<[^>]*\bonerror\b/i);

  const js = markdownLite.renderMd("[click](javascript:alert(1))");
  assert.doesNotMatch(js, /href\s*=\s*["']?\s*javascript:/i);
  // Either plain text or a neutralized link — never an active JS URL.
  if (/<a\b/i.test(js)) {
    assert.doesNotMatch(js, /href="javascript:/i);
  }

  const svg = markdownLite.renderMd("<svg onload=alert(1)></svg>");
  assert.doesNotMatch(svg, /<svg\b/i);
});

test("PURIFY_CONFIG is explicit, frozen, and forbids executable surfaces", () => {
  const config = markdownLite.PURIFY_CONFIG;
  assert.ok(config && typeof config === "object");
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.ALLOWED_TAGS), true);
  assert.equal(Object.isFrozen(config.ALLOWED_ATTR), true);
  assert.equal(Object.isFrozen(config.FORBID_TAGS), true);
  assert.equal(Object.isFrozen(config.FORBID_ATTR), true);

  // Markdown surface we actually render.
  for (const tag of ["p", "a", "pre", "code", "table", "input", "blockquote"]) {
    assert.ok(config.ALLOWED_TAGS.includes(tag), `expected ALLOWED_TAGS to include ${tag}`);
  }
  // Dangerous tags must never be allow-listed.
  for (const tag of ["script", "style", "iframe", "object", "embed", "form", "svg", "math"]) {
    assert.equal(config.ALLOWED_TAGS.includes(tag), false, `${tag} must not be allowed`);
    assert.ok(config.FORBID_TAGS.includes(tag), `${tag} must be forbidden`);
  }
  assert.equal(config.ALLOW_DATA_ATTR, false);
  assert.ok(config.FORBID_ATTR.includes("style"));
  // Mutation must not loosen the live policy object.
  assert.throws(() => {
    config.ALLOWED_TAGS.push("script");
  }, TypeError);
});

test("sanitizeHtml applies PURIFY_CONFIG and fails closed on empty input", () => {
  assert.equal(typeof markdownLite.sanitizeHtml, "function");
  assert.equal(markdownLite.sanitizeHtml(""), "");
  const dirty =
    '<p onclick="alert(1)">ok</p><script>alert(1)</script><iframe src="https://evil"></iframe>';
  const clean = markdownLite.sanitizeHtml(dirty);
  assert.match(clean, /<p>/);
  assert.match(clean, /ok/);
  assert.doesNotMatch(clean, /<script\b/i);
  assert.doesNotMatch(clean, /<iframe\b/i);
  assert.doesNotMatch(clean, /\bonclick\b/i);
});

test("renderMd neutralizes data: and protocol-relative links", () => {
  const dataLink = markdownLite.renderMd("[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)");
  assert.doesNotMatch(dataLink, /href\s*=\s*["']?\s*data:/i);
  if (/<a\b/i.test(dataLink)) {
    assert.match(dataLink, /href="#"/);
  }

  const protocolRelative = markdownLite.renderMd("[x](//evil.example/path)");
  assert.doesNotMatch(protocolRelative, /href\s*=\s*["']?\s*\/\//i);
  if (/<a\b/i.test(protocolRelative)) {
    assert.match(protocolRelative, /href="#"/);
  }
});

test("renderMd keeps tables and task lists while stripping XSS payloads", () => {
  const html = markdownLite.renderMd(
    [
      "| name | value |",
      "| --- | --- |",
      "| a | <script>x</script> |",
      "",
      "- [x] done <img src=x onerror=alert(1)>",
      "- [ ] todo [bad](javascript:alert(1))",
    ].join("\n")
  );

  assert.match(html, /<table class="md-table">/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /disabled/);
  // Escaped text is fine; live tags / executable hrefs are not.
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /<[^>]*\bonerror\b/i);
  assert.doesNotMatch(html, /href\s*=\s*["']?\s*javascript:/i);
  // Inline HTML inside table cells must be text, not executable markup.
  assert.match(html, /&lt;script&gt;/);
});

test("isSafeHttpUrl only allows http(s)", () => {
  assert.equal(markdownLite.isSafeHttpUrl("https://example.com/a"), true);
  assert.equal(markdownLite.isSafeHttpUrl("http://example.com"), true);
  assert.equal(markdownLite.isSafeHttpUrl("javascript:alert(1)"), false);
  assert.equal(markdownLite.isSafeHttpUrl("data:text/html,hi"), false);
  assert.equal(markdownLite.isSafeHttpUrl("//evil.com"), false);
  assert.equal(markdownLite.isSafeHttpUrl("vbscript:msgbox(1)"), false);
  assert.equal(markdownLite.isSafeHttpUrl("file:///etc/passwd"), false);
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
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
    },
    innerHTML: "",
    textContent: "",
    isConnected: true,
  };
  const htmls = [];
  const job = markdownLite.paintMarkdown(el, "**hi**", {
    onHtml(html) {
      htmls.push(html);
    },
  });
  assert.equal(job.mode, "sync");
  assert.equal(job.deferred, false);
  assert.match(el.innerHTML, /<strong>hi<\/strong>/);
  assert.equal(htmls.length, 1);
});

test("paintMarkdown structure mode defers Prism for medium-long text", () => {
  const el = {
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
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
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
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
