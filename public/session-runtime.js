(function initSessionRuntime(globalScope) {
  "use strict";

  function createEmptyRuntime(sessionId) {
    return {
      sessionId: sessionId || "_pending",
      status: "idle",
      controller: null,
      doneReceived: false,
      hasStructuredEvents: false,
      liveMessages: new Map(),
      liveRuns: new Map(),
      liveInvocations: new Map(),
      lastError: "",
      updatedAt: Date.now(),
    };
  }

  function createRuntimeStore() {
    const runtimes = new Map();

    function getOrCreate(sessionId) {
      const id = sessionId || "_pending";
      if (!runtimes.has(id)) {
        runtimes.set(id, createEmptyRuntime(id));
      }
      return runtimes.get(id);
    }

    function get(sessionId) {
      const id = sessionId || "_pending";
      return runtimes.get(id) || null;
    }

    function touch(rt) {
      rt.updatedAt = Date.now();
      return rt;
    }

    function setStatus(sessionId, status) {
      const rt = getOrCreate(sessionId);
      rt.status = status;
      return touch(rt);
    }

    function beginRun(sessionId, controller) {
      const rt = getOrCreate(sessionId);
      if (rt.controller && rt.controller !== controller) {
        try { rt.controller.abort(); } catch {}
      }
      rt.controller = controller || null;
      rt.doneReceived = false;
      rt.hasStructuredEvents = false;
      rt.liveMessages.clear();
      rt.liveRuns.clear();
      rt.liveInvocations.clear();
      rt.lastError = "";
      rt.status = "running";
      return touch(rt);
    }

    function endRun(sessionId, options = {}) {
      const rt = getOrCreate(sessionId);
      const controller = options.controller;
      // Ignore stale finally blocks from an older run on the same session.
      if (controller && rt.controller && rt.controller !== controller) {
        return rt;
      }
      rt.controller = null;
      if (options.status) {
        rt.status = options.status;
      } else if (options.aborted) {
        rt.status = "idle";
      } else if (rt.doneReceived) {
        rt.status = rt.status === "error" ? "error" : "done";
      } else {
        rt.status = "error";
      }
      if (options.error) rt.lastError = String(options.error);
      return touch(rt);
    }

    function abort(sessionId) {
      const rt = get(sessionId);
      if (!rt || !rt.controller) return false;
      try { rt.controller.abort(); } catch {}
      return true;
    }

    function dispose(sessionId) {
      abort(sessionId);
      return runtimes.delete(sessionId || "_pending");
    }

    function rekey(fromId, toId) {
      if (!fromId || !toId || fromId === toId) return getOrCreate(toId);
      const existing = runtimes.get(fromId);
      if (!existing) return getOrCreate(toId);
      runtimes.delete(fromId);
      existing.sessionId = toId;
      const conflict = runtimes.get(toId);
      if (conflict && conflict.controller && conflict !== existing) {
        try { conflict.controller.abort(); } catch {}
      }
      runtimes.set(toId, existing);
      return touch(existing);
    }

    function getStatus(sessionId) {
      const rt = get(sessionId);
      return rt ? rt.status : "idle";
    }

    function statusSnapshot() {
      const out = {};
      for (const [id, rt] of runtimes) {
        out[id] = rt.status;
      }
      return out;
    }

    return {
      getOrCreate,
      get,
      setStatus,
      beginRun,
      endRun,
      abort,
      dispose,
      rekey,
      getStatus,
      statusSnapshot,
      // test helper
      _runtimes: runtimes,
    };
  }

  const api = { createRuntimeStore, createEmptyRuntime };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.SessionRuntime = api;
})(typeof window !== "undefined" ? window : globalThis);
