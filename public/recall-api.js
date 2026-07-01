(function initRecallApi(globalScope) {
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

  function buildUrl(pathname, params) {
    const parts = [];
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === "") continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    return `${pathname}?${parts.join("&")}`;
  }

  function createRecallApi(fetchImpl) {
    const request = fetchImpl || (globalScope.fetch ? globalScope.fetch.bind(globalScope) : null);
    if (typeof request !== "function") {
      throw new Error("fetch implementation is required");
    }
    const jsonOrThrow = resolveJsonOrThrow();

    return {
      async listInvocations(sessionId) {
        const data = await jsonOrThrow(await request(buildUrl("/api/callbacks/list-invocations", {
          sessionId,
        })));
        return data.invocations || [];
      },
      async readInvocation(sessionId, targetInvocationId, options = {}) {
        return jsonOrThrow(await request(buildUrl("/api/callbacks/read-invocation", {
          sessionId,
          targetInvocationId,
          from: options.from ?? 0,
          limit: options.limit ?? 200,
        })));
      },
      async searchSession(sessionId, query, options = {}) {
        const data = await jsonOrThrow(await request(buildUrl("/api/callbacks/session-search", {
          sessionId,
          query,
          limit: options.limit ?? 20,
        })));
        return data.hits || [];
      },
    };
  }

  const api = { createRecallApi };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.RecallApi = api;
})(typeof window !== "undefined" ? window : globalThis);
