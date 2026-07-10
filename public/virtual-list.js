(function initVirtualList(globalScope) {
  "use strict";

  /**
   * Compute the inclusive-exclusive window of rows that should be mounted.
   * @returns {{ start: number, end: number }}
   */
  function visibleRange({ scrollTop, viewport, rowHeight, count, overscan }) {
    const rh = Math.max(1, Number(rowHeight) || 1);
    const total = Math.max(0, Number(count) || 0);
    const top = Math.max(0, Number(scrollTop) || 0);
    const view = Math.max(0, Number(viewport) || 0);
    const pad = Math.max(0, Number(overscan) || 0);
    if (total === 0) return { start: 0, end: 0 };
    const start = Math.max(0, Math.floor(top / rh) - pad);
    const end = Math.min(total, Math.ceil((top + view) / rh) + pad);
    return { start, end: Math.max(start, end) };
  }

  /**
   * Fixed-row-height virtual list.
   * @param {object} deps
   * @param {HTMLElement} deps.containerEl scroll container
   * @param {number} deps.rowHeight
   * @param {number} [deps.overscan=8]
   * @param {() => number} deps.getCount
   * @param {(index: number, rowEl: HTMLElement) => void} deps.renderRow
   */
  function createVirtualList(deps) {
    const {
      containerEl,
      rowHeight = 18,
      overscan = 8,
      getCount,
      renderRow,
    } = deps;

    if (!containerEl) {
      throw new Error("createVirtualList requires containerEl");
    }

    const spacer = document.createElement("div");
    spacer.className = "virtual-list-spacer";
    spacer.style.position = "relative";
    spacer.style.width = "100%";
    containerEl.replaceChildren(spacer);

    let destroyed = false;
    let rafId = null;

    function paint() {
      if (destroyed) return;
      const count = typeof getCount === "function" ? getCount() : 0;
      const totalHeight = count * rowHeight;
      spacer.style.height = `${totalHeight}px`;

      const { start, end } = visibleRange({
        scrollTop: containerEl.scrollTop,
        viewport: containerEl.clientHeight || 0,
        rowHeight,
        count,
        overscan,
      });

      // Recycle by full replace within the window — simple and predictable.
      const fragment = document.createDocumentFragment();
      for (let i = start; i < end; i += 1) {
        const row = document.createElement("div");
        row.className = "virtual-list-row";
        row.dataset.index = String(i);
        row.style.position = "absolute";
        row.style.top = `${i * rowHeight}px`;
        row.style.left = "0";
        row.style.right = "0";
        row.style.height = `${rowHeight}px`;
        row.style.boxSizing = "border-box";
        if (typeof renderRow === "function") renderRow(i, row);
        fragment.appendChild(row);
      }
      spacer.replaceChildren(fragment);
    }

    function schedulePaint() {
      if (destroyed || rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        paint();
      });
    }

    function onScroll() {
      schedulePaint();
    }

    containerEl.addEventListener("scroll", onScroll, { passive: true });

    function refresh() {
      paint();
    }

    function scrollTo(index) {
      const i = Math.max(0, Number(index) || 0);
      containerEl.scrollTop = i * rowHeight;
      paint();
    }

    function destroy() {
      destroyed = true;
      if (rafId != null) cancelAnimationFrame(rafId);
      containerEl.removeEventListener("scroll", onScroll);
      containerEl.replaceChildren();
    }

    paint();

    return { refresh, scrollTo, destroy, visibleRange };
  }

  const api = { visibleRange, createVirtualList };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.VirtualList = api;
})(typeof window !== "undefined" ? window : globalThis);
