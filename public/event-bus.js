/**
 * Lightweight pub/sub event bus for UI ↔ runtime coordination.
 * Keeps modules decoupled without a full framework store.
 */
(function initEventBus(globalScope) {
  "use strict";

  function createEventBus() {
    /** @type {Map<string, Set<Function>>} */
    const listeners = new Map();

    function on(event, handler) {
      if (!event || typeof handler !== "function") {
        return () => {};
      }
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return function off() {
        const set = listeners.get(event);
        if (set) set.delete(handler);
      };
    }

    function once(event, handler) {
      const off = on(event, (payload) => {
        off();
        handler(payload);
      });
      return off;
    }

    function off(event, handler) {
      const set = listeners.get(event);
      if (!set) return false;
      return set.delete(handler);
    }

    function emit(event, payload) {
      const set = listeners.get(event);
      if (!set || set.size === 0) return 0;
      // Copy so handlers may unsubscribe during emit.
      const list = [...set];
      for (const handler of list) {
        try {
          handler(payload);
        } catch (error) {
          console.error(`[event-bus] handler error for "${event}":`, error);
        }
      }
      return list.length;
    }

    function clear(event) {
      if (event == null) {
        listeners.clear();
        return;
      }
      listeners.delete(event);
    }

    function listenerCount(event) {
      const set = listeners.get(event);
      return set ? set.size : 0;
    }

    return { on, once, off, emit, clear, listenerCount };
  }

  const api = { createEventBus };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.EventBus = api;
})(typeof window !== "undefined" ? window : globalThis);
