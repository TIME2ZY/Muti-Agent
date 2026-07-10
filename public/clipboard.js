(function initClipboardUtils(globalScope) {
  "use strict";

  async function writeClipboard(env, payload) {
    const clipboard = env && env.clipboard;
    if (!clipboard) {
      throw new Error("clipboard implementation is required");
    }

    const text = payload && payload.text ? String(payload.text) : "";
    const html = payload && payload.html ? String(payload.html) : "";

    if (html) {
      const ClipboardItemCtor = env && env.ClipboardItem;
      if (typeof ClipboardItemCtor === "function" && typeof clipboard.write === "function") {
        const item = new ClipboardItemCtor({
          "text/plain": text,
          "text/html": html,
        });
        return clipboard.write([item]);
      }
    }

    if (typeof clipboard.writeText !== "function") {
      throw new Error("clipboard.writeText is required");
    }
    return clipboard.writeText(text);
  }

  const api = { writeClipboard };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.ClipboardUtils = api;
})(typeof window !== "undefined" ? window : globalThis);
