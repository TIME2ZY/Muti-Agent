/**
 * Thin UI state container with pub/sub notifications.
 * Keeps a single mutable state object (compatible with existing modules that
 * receive `state` by reference) while allowing views to subscribe to changes.
 */
(function initUiStore(globalScope) {
  "use strict";

  function resolveBus(bus) {
    if (bus && typeof bus.on === "function" && typeof bus.emit === "function") {
      return bus;
    }
    const factory = globalScope.EventBus && globalScope.EventBus.createEventBus;
    if (typeof factory === "function") return factory();
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./event-bus.js").createEventBus();
      } catch {
        // fall through
      }
    }
    // Minimal fallback if EventBus is not loaded yet.
    const map = new Map();
    return {
      on(event, handler) {
        if (!map.has(event)) map.set(event, new Set());
        map.get(event).add(handler);
        return () => map.get(event)?.delete(handler);
      },
      emit(event, payload) {
        const set = map.get(event);
        if (!set) return 0;
        for (const h of [...set]) h(payload);
        return set.size;
      },
    };
  }

  /**
   * @param {object} [options]
   * @param {object} [options.initial] initial state fields
   * @param {object} [options.bus] shared event bus
   * @param {string} [options.changeEvent="ui:change"] event name for patches
   */
  function createUiStore(options = {}) {
    const bus = resolveBus(options.bus);
    const changeEvent = options.changeEvent || "ui:change";
    const state = options.initial && typeof options.initial === "object"
      ? options.initial
      : {};

    function getState() {
      return state;
    }

    function patch(partial, meta = {}) {
      if (!partial || typeof partial !== "object") return state;
      Object.assign(state, partial);
      bus.emit(changeEvent, { state, partial, ...meta });
      return state;
    }

    function set(key, value, meta = {}) {
      state[key] = value;
      bus.emit(changeEvent, { state, partial: { [key]: value }, ...meta });
      return state;
    }

    function subscribe(handler) {
      return bus.on(changeEvent, handler);
    }

    function notify(meta = {}) {
      bus.emit(changeEvent, { state, partial: {}, ...meta });
      return state;
    }

    return {
      state,
      bus,
      getState,
      patch,
      set,
      subscribe,
      notify,
      changeEvent,
    };
  }

  const api = { createUiStore };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.UiStore = api;
})(typeof window !== "undefined" ? window : globalThis);
