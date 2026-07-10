const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createThemeController } = require("../public/theme.js");

function mockRoot() {
  const attrs = {};
  return {
    attributes: attrs,
    setAttribute(k, v) { attrs[k] = v; },
    removeAttribute(k) { delete attrs[k]; },
    getAttribute(k) { return attrs[k]; },
  };
}

test("theme cycles system → light → dark → system", () => {
  const storage = new Map();
  const root = mockRoot();
  const toggleEl = { textContent: "", title: "", setAttribute() {} };
  const theme = createThemeController({
    storage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v),
    },
    root,
    toggleEl,
  });
  theme.init();
  assert.equal(theme.current(), "system");
  assert.equal(root.getAttribute("data-theme"), undefined);
  theme.cycle();
  assert.equal(theme.current(), "light");
  assert.equal(root.getAttribute("data-theme"), "light");
  theme.cycle();
  assert.equal(theme.current(), "dark");
  theme.cycle();
  assert.equal(theme.current(), "system");
});
