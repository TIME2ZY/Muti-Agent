(function initUiConfirm(globalScope) {
  "use strict";

  /**
   * Promise-based modal confirm.
   * @param {object} options
   * @param {string} [options.title]
   * @param {string} [options.body]
   * @param {string} [options.confirmLabel]
   * @param {string} [options.cancelLabel]
   * @param {boolean} [options.danger]
   * @param {Document} [options.documentRef]
   * @returns {Promise<boolean>}
   */
  function confirmDialog(options = {}) {
    const doc = options.documentRef
      || (typeof document !== "undefined" ? document : null);
    if (!doc || !doc.body) {
      // Non-DOM environments fall back to native confirm when available.
      if (typeof confirm === "function") {
        return Promise.resolve(!!confirm(options.body || options.title || "确认？"));
      }
      return Promise.resolve(false);
    }

    const title = options.title || "确认";
    const body = options.body || "";
    const confirmLabel = options.confirmLabel || "确认";
    const cancelLabel = options.cancelLabel || "取消";
    const danger = options.danger === true;

    return new Promise((resolve) => {
      const prevFocus = doc.activeElement;
      const backdrop = doc.createElement("div");
      backdrop.className = "ui-confirm-backdrop";
      backdrop.setAttribute("role", "presentation");

      const dialog = doc.createElement("div");
      dialog.className = "ui-confirm-dialog";
      dialog.setAttribute("role", "alertdialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "ui-confirm-title");
      dialog.setAttribute("aria-describedby", "ui-confirm-body");

      const titleEl = doc.createElement("div");
      titleEl.id = "ui-confirm-title";
      titleEl.className = "ui-confirm-title";
      titleEl.textContent = title;

      const bodyEl = doc.createElement("div");
      bodyEl.id = "ui-confirm-body";
      bodyEl.className = "ui-confirm-body";
      bodyEl.textContent = body;

      const actions = doc.createElement("div");
      actions.className = "ui-confirm-actions";

      const cancelBtn = doc.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn-cmd";
      cancelBtn.textContent = cancelLabel;

      const okBtn = doc.createElement("button");
      okBtn.type = "button";
      okBtn.className = "btn-cmd primary" + (danger ? " danger" : "");
      okBtn.textContent = confirmLabel;

      actions.append(cancelBtn, okBtn);
      dialog.append(titleEl, bodyEl, actions);
      backdrop.append(dialog);
      doc.body.append(backdrop);

      let settled = false;
      function finish(result) {
        if (settled) return;
        settled = true;
        doc.removeEventListener("keydown", onKey);
        backdrop.remove();
        if (prevFocus && typeof prevFocus.focus === "function") {
          try { prevFocus.focus(); } catch { /* ignore */ }
        }
        resolve(!!result);
      }

      function onKey(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
          return;
        }
        if (e.key === "Tab") {
          const focusables = [cancelBtn, okBtn];
          const idx = focusables.indexOf(doc.activeElement);
          if (e.shiftKey) {
            e.preventDefault();
            focusables[(idx <= 0 ? focusables.length : idx) - 1].focus();
          } else {
            e.preventDefault();
            focusables[(idx + 1) % focusables.length].focus();
          }
        }
      }

      cancelBtn.addEventListener("click", () => finish(false));
      okBtn.addEventListener("click", () => finish(true));
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) finish(false);
      });
      doc.addEventListener("keydown", onKey);

      okBtn.focus();
    });
  }

  function createConfirm(deps = {}) {
    return function confirmImpl(message, opts = {}) {
      if (typeof message === "object" && message) {
        return confirmDialog({ ...deps, ...message });
      }
      return confirmDialog({
        ...deps,
        title: opts.title || "确认",
        body: String(message || ""),
        danger: opts.danger === true,
        confirmLabel: opts.confirmLabel,
        cancelLabel: opts.cancelLabel,
      });
    };
  }

  const api = { confirmDialog, createConfirm };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.UiConfirm = api;
})(typeof window !== "undefined" ? window : globalThis);
