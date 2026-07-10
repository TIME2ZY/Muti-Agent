(function initTheme(globalScope) {
  "use strict";

  const THEME_CYCLE = ["light", "dark"];
  const THEME_LABEL = { light: "浅色", dark: "深色" };
  const DEFAULT_KEY = "agent-chat-theme";

  // Inline SVG avoids emoji font inconsistency across OS / browsers.
  const THEME_ICON_SVG = {
    light:
      '<svg class="icon-svg theme-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
      + '<circle cx="8" cy="8" r="3" fill="currentColor"/>'
      + '<path fill="currentColor" d="M8 1.25a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 8 1.25zm0 11a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1a.75.75 0 0 1 .75-.75zM1.25 8A.75.75 0 0 1 2 7.25h1a.75.75 0 0 1 0 1.5H2A.75.75 0 0 1 1.25 8zm11 0a.75.75 0 0 1 .75-.75h1a.75.75 0 0 1 0 1.5h-1A.75.75 0 0 1 12.25 8zM3.22 3.22a.75.75 0 0 1 1.06 0l.7.7a.75.75 0 1 1-1.06 1.06l-.7-.7a.75.75 0 0 1 0-1.06zm7.8 7.8a.75.75 0 0 1 1.06 0l.7.7a.75.75 0 1 1-1.06 1.06l-.7-.7a.75.75 0 0 1 0-1.06zM3.22 12.78a.75.75 0 0 1 0-1.06l.7-.7a.75.75 0 1 1 1.06 1.06l-.7.7a.75.75 0 0 1-1.06 0zm7.8-7.8a.75.75 0 0 1 0-1.06l.7-.7a.75.75 0 1 1 1.06 1.06l-.7.7a.75.75 0 0 1-1.06 0z"/>'
      + "</svg>",
    dark:
      '<svg class="icon-svg theme-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
      + '<path fill="currentColor" d="M12.8 10.05A5.6 5.6 0 0 1 6 3.2a.5.5 0 0 0-.55-.55A6.5 6.5 0 1 0 13.35 10.6a.5.5 0 0 0-.55-.55z"/>'
      + "</svg>",
  };

  // Kept for tests / consumers that still expect a short label mark.
  const THEME_ICON = { light: "sun", dark: "moon" };

  function themeIconSvg(theme) {
    return THEME_ICON_SVG[theme] || THEME_ICON_SVG.light;
  }

  function defaultMatchMedia() {
    if (typeof globalScope !== "undefined" && globalScope.matchMedia) {
      return globalScope.matchMedia.bind(globalScope);
    }
    if (typeof matchMedia === "function") return matchMedia;
    return null;
  }

  function resolveFromSystem(matchMediaFn) {
    try {
      const mm = matchMediaFn || defaultMatchMedia();
      if (mm) {
        const q = mm("(prefers-color-scheme: dark)");
        if (q && q.matches) return "dark";
      }
    } catch {
      /* ignore */
    }
    return "light";
  }

  function normalizeTheme(value, matchMediaFn) {
    if (value === "light" || value === "dark") return value;
    // Legacy "system" / missing / unknown → resolve once from OS preference.
    return resolveFromSystem(matchMediaFn);
  }

  function createThemeController(deps = {}) {
    const storage = deps.storage || (typeof localStorage !== "undefined" ? localStorage : null);
    const root = deps.root || (typeof document !== "undefined" ? document.documentElement : null);
    const toggleEl = deps.toggleEl || null;
    const key = deps.key || DEFAULT_KEY;
    const matchMediaFn = deps.matchMedia || defaultMatchMedia();

    function readStored() {
      if (!storage || !storage.getItem) return null;
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    }

    function writeStored(theme) {
      if (!storage || !storage.setItem) return;
      try {
        storage.setItem(key, theme);
      } catch {
        /* ignore quota / private mode */
      }
    }

    function current() {
      return normalizeTheme(readStored(), matchMediaFn);
    }

    function apply(theme) {
      const next = normalizeTheme(theme, matchMediaFn);
      if (root) {
        root.setAttribute("data-theme", next);
      }
      if (toggleEl) {
        if (typeof toggleEl.innerHTML !== "undefined") {
          toggleEl.innerHTML = themeIconSvg(next);
        } else {
          toggleEl.textContent = THEME_ICON[next];
        }
        toggleEl.dataset.theme = next;
        toggleEl.title = `主题：${THEME_LABEL[next]}（点击切换）`;
        if (typeof toggleEl.setAttribute === "function") {
          toggleEl.setAttribute("aria-label", `切换主题，当前：${THEME_LABEL[next]}`);
        }
      }
      return next;
    }

    function init() {
      const next = current();
      // Persist resolved preference (first visit or legacy "system") so UI is always explicit.
      writeStored(next);
      return apply(next);
    }

    function cycle() {
      const cur = current();
      const next = cur === "dark" ? "light" : "dark";
      writeStored(next);
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
      themeIconSvg,
    };
  }

  const api = {
    createThemeController,
    resolveFromSystem,
    normalizeTheme,
    themeIconSvg,
    THEME_CYCLE,
    THEME_ICON,
    THEME_ICON_SVG,
    THEME_LABEL,
    DEFAULT_KEY,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.Theme = api;
})(typeof window !== "undefined" ? window : globalThis);
