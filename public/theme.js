(function initTheme(globalScope) {
  "use strict";

  const THEME_CYCLE = ["system", "light", "dark"];
  const THEME_ICON = { system: "◐", light: "☀", dark: "☾" };
  const THEME_LABEL = { system: "跟随系统", light: "浅色", dark: "深色" };
  const DEFAULT_KEY = "agent-chat-theme";

  function createThemeController(deps = {}) {
    const storage = deps.storage || (typeof localStorage !== "undefined" ? localStorage : null);
    const root = deps.root || (typeof document !== "undefined" ? document.documentElement : null);
    const toggleEl = deps.toggleEl || null;
    const key = deps.key || DEFAULT_KEY;

    function current() {
      const saved = storage && storage.getItem ? storage.getItem(key) : null;
      return THEME_CYCLE.includes(saved) ? saved : "system";
    }

    function apply(theme) {
      const next = THEME_CYCLE.includes(theme) ? theme : "system";
      if (root) {
        if (next === "system") root.removeAttribute("data-theme");
        else root.setAttribute("data-theme", next);
      }
      if (toggleEl) {
        toggleEl.textContent = THEME_ICON[next];
        toggleEl.title = `主题：${THEME_LABEL[next]}（点击切换）`;
        if (typeof toggleEl.setAttribute === "function") {
          toggleEl.setAttribute("aria-label", `切换主题，当前：${THEME_LABEL[next]}`);
        }
      }
      return next;
    }

    function init() {
      return apply(current());
    }

    function cycle() {
      const idx = THEME_CYCLE.indexOf(current());
      const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
      if (storage && storage.setItem) storage.setItem(key, next);
      return apply(next);
    }

    function bindClick() {
      if (!toggleEl || typeof toggleEl.addEventListener !== "function") return;
      toggleEl.addEventListener("click", () => {
        cycle();
      });
    }

    return {
      current,
      apply,
      init,
      cycle,
      bindClick,
      THEME_CYCLE,
      THEME_ICON,
      THEME_LABEL,
    };
  }

  const api = { createThemeController, THEME_CYCLE, THEME_ICON, THEME_LABEL, DEFAULT_KEY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.Theme = api;
})(typeof window !== "undefined" ? window : globalThis);
