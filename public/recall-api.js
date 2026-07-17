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
        const data = await jsonOrThrow(
          await request(
            buildUrl("/api/callbacks/session-search", {
              sessionId,
              query,
              limit: options.limit ?? 20,
              layers: options.layers,
              includeRetired: options.includeRetired ? "1" : undefined,
              includeThinking: options.includeThinking ? "1" : undefined,
            })
          )
        );
        // Wave R2: full search contract (hits + layer stats). Callers that only
        // need rows can read `.hits`.
        return {
          hits: Array.isArray(data.hits) ? data.hits : [],
          layers: normalizeLayerCounts(data.layers),
          query: data.query ?? query ?? "",
          limit: Number(data.limit) || options.limit || 20,
          truncated: Boolean(data.truncated),
          weakQuery: Boolean(data.weakQuery),
        };
      },
    };
  }

  function normalizeLayerCounts(layers) {
    const src = layers && typeof layers === "object" ? layers : {};
    return {
      memory: Number(src.memory) || 0,
      message: Number(src.message) || 0,
      evidence: Number(src.evidence) || 0,
    };
  }

  const api = { createRecallApi };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.RecallApi = api;
})(typeof window !== "undefined" ? window : globalThis);
