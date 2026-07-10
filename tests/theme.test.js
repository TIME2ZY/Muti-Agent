const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createThemeController,
  normalizeTheme,
  resolveFromSystem,
  themeIconSvg,
  THEME_CYCLE,
  THEME_ICON,
} = require("../public/theme.js");

function mockRoot() {
  const attrs = {};
  return {
    attributes: attrs,
    setAttribute(k, v) { attrs[k] = v; },
    removeAttribute(k) { delete attrs[k]; },
    getAttribute(k) { return attrs[k]; },
  };
}

function mockMatchMedia(dark) {
  return () => ({ matches: !!dark, media: "(prefers-color-scheme: dark)" });
}

function mockStorage(map = new Map()) {
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
  };
}

test("THEME_CYCLE is light and dark only", () => {
  assert.deepEqual(THEME_CYCLE, ["light", "dark"]);
});

test("themeIconSvg returns SVG markup for light and dark", () => {
  assert.match(themeIconSvg("light"), /<svg/);
  assert.match(themeIconSvg("dark"), /<svg/);
  assert.match(themeIconSvg("light"), /circle/);
  assert.equal(THEME_ICON.light, "sun");
  assert.equal(THEME_ICON.dark, "moon");
});

test("resolveFromSystem uses prefers-color-scheme", () => {
  assert.equal(resolveFromSystem(mockMatchMedia(true)), "dark");
  assert.equal(resolveFromSystem(mockMatchMedia(false)), "light");
});

test("normalizeTheme migrates system and unknown to resolved preference", () => {
  assert.equal(normalizeTheme("light", mockMatchMedia(true)), "light");
  assert.equal(normalizeTheme("dark", mockMatchMedia(false)), "dark");
  assert.equal(normalizeTheme("system", mockMatchMedia(true)), "dark");
  assert.equal(normalizeTheme(null, mockMatchMedia(false)), "light");
  assert.equal(normalizeTheme("weird", mockMatchMedia(true)), "dark");
});

test("theme cycles light ↔ dark and injects SVG icons", () => {
  const storage = mockStorage(new Map([["agent-chat-theme", "light"]]));
  const root = mockRoot();
  const toggleEl = { innerHTML: "", textContent: "", title: "", dataset: {}, setAttribute() {} };
  const theme = createThemeController({
    storage,
    root,
    toggleEl,
    matchMedia: mockMatchMedia(false),
  });
  theme.init();
  assert.equal(theme.current(), "light");
  assert.equal(root.getAttribute("data-theme"), "light");
  assert.match(toggleEl.innerHTML, /<svg/);
  assert.equal(toggleEl.dataset.theme, "light");

  theme.cycle();
  assert.equal(theme.current(), "dark");
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.match(toggleEl.innerHTML, /<svg/);
  assert.equal(toggleEl.dataset.theme, "dark");
  assert.equal(storage.map.get("agent-chat-theme"), "dark");

  theme.cycle();
  assert.equal(theme.current(), "light");
  assert.equal(root.getAttribute("data-theme"), "light");
});

test("init resolves and persists first visit from system preference", () => {
  const storage = mockStorage();
  const root = mockRoot();
  const theme = createThemeController({
    storage,
    root,
    matchMedia: mockMatchMedia(true),
  });
  const applied = theme.init();
  assert.equal(applied, "dark");
  assert.equal(theme.current(), "dark");
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.equal(storage.map.get("agent-chat-theme"), "dark");
});

test("init migrates legacy system value to explicit light/dark", () => {
  const storage = mockStorage(new Map([["agent-chat-theme", "system"]]));
  const root = mockRoot();
  const theme = createThemeController({
    storage,
    root,
    matchMedia: mockMatchMedia(false),
  });
  theme.init();
  assert.equal(theme.current(), "light");
  assert.equal(root.getAttribute("data-theme"), "light");
  assert.equal(storage.map.get("agent-chat-theme"), "light");
});

test("apply always sets data-theme (never removes attribute)", () => {
  const storage = mockStorage(new Map([["agent-chat-theme", "dark"]]));
  const root = mockRoot();
  const theme = createThemeController({
    storage,
    root,
    matchMedia: mockMatchMedia(true),
  });
  theme.init();
  assert.equal(root.getAttribute("data-theme"), "dark");
  theme.apply("light");
  assert.equal(root.getAttribute("data-theme"), "light");
  assert.equal(root.getAttribute("data-theme") === undefined, false);
});
