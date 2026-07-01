(function initWorktreeApi(globalScope) {
  "use strict";

  function resolveJsonOrThrow() {
    if (globalScope.SessionApi && typeof globalScope.SessionApi.jsonOrThrow === "function") {
      return globalScope.SessionApi.jsonOrThrow;
    }
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      return require("./session-api.js").jsonOrThrow;
    }
    throw new Error("SessionApi.jsonOrThrow is required");
  }

  function createWorktreeApi(fetchImpl) {
    const request = fetchImpl || (globalScope.fetch ? globalScope.fetch.bind(globalScope) : null);
    if (typeof request !== "function") {
      throw new Error("fetch implementation is required");
    }
    const jsonOrThrow = resolveJsonOrThrow();

    return {
      async readStatus(sessionId, options = {}) {
        const res = await request(`/api/sessions/${encodeURIComponent(sessionId)}/worktree/status`);
        if (options.allowMissing && (res.status === 400 || res.status === 404)) {
          return null;
        }
        return jsonOrThrow(res);
      },
      async readDiff(sessionId, options = {}) {
        const res = await request(`/api/sessions/${encodeURIComponent(sessionId)}/worktree/diff`);
        if (options.allowMissing && (res.status === 400 || res.status === 404)) {
          return "";
        }
        const data = await jsonOrThrow(res);
        return data.diff || "";
      },
      async discard(sessionId) {
        return jsonOrThrow(await request(`/api/sessions/${encodeURIComponent(sessionId)}/worktree/discard`, {
          method: "POST",
        }));
      },
    };
  }

  const api = { createWorktreeApi };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.WorktreeApi = api;
})(typeof window !== "undefined" ? window : globalThis);
