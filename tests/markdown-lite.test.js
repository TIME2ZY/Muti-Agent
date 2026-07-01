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

test("renderMd renders collapsible fenced code blocks after 20 lines", () => {
  const code = Array.from({ length: 21 }, (_, i) => `line ${i + 1}`).join("\n");
  const html = markdownLite.renderMd(`\`\`\`js\n${code}\n\`\`\``);

  assert.match(html, /class="md-code md-code-collapsible"/);
  assert.match(html, /class="md-code-lines">21 lines<\/span>/);
  assert.match(html, /class="md-code-toggle"/);
  assert.match(html, /class="md-code-copy"/);
  assert.match(html, /class="language-js"/);
});
