(function initMemoryApi(globalScope) {
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
    const query = parts.join("&");
    return query ? `${pathname}?${query}` : pathname;
  }

  function createMemoryApi(fetchImpl) {
    const request = fetchImpl || (globalScope.fetch ? globalScope.fetch.bind(globalScope) : null);
    if (typeof request !== "function") {
      throw new Error("fetch implementation is required");
    }
    const jsonOrThrow = resolveJsonOrThrow();

    return {
      async listMemories(sessionId, options = {}) {
        return jsonOrThrow(
          await request(
            buildUrl("/api/memories", {
              sessionId,
              kind: options.kind || options.kinds,
              status: options.status || options.statuses,
              includeRetired:
                options.includeRetired === false
                  ? "0"
                  : options.includeRetired
                    ? "1"
                    : undefined,
              limit: options.limit,
            })
          )
        );
      },
      async createMemory(body) {
        return jsonOrThrow(
          await request("/api/memories", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body || {}),
          })
        );
      },
      async getMemory(id) {
        return jsonOrThrow(await request(`/api/memories/${encodeURIComponent(id)}`));
      },
      async confirmMemory(id, body = {}) {
        return jsonOrThrow(
          await request(`/api/memories/${encodeURIComponent(id)}/confirm`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        );
      },
      async invalidateMemory(id, body = {}) {
        return jsonOrThrow(
          await request(`/api/memories/${encodeURIComponent(id)}/invalidate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        );
      },
    };
  }

  const api = { createMemoryApi };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.MemoryApi = api;
})(typeof window !== "undefined" ? window : globalThis);
