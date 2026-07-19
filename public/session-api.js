(function initSessionApi(globalScope) {
  "use strict";

  async function jsonOrThrow(res) {
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      const err = new Error(data.error || `${res.status} ${res.statusText}`);
      err.body = text;
      throw err;
    }
    return data;
  }

  function createSessionApi(fetchImpl) {
    const request = fetchImpl || (globalScope.fetch ? globalScope.fetch.bind(globalScope) : null);
    if (typeof request !== "function") {
      throw new Error("fetch implementation is required");
    }

    return {
      async listSessions() {
        const data = await jsonOrThrow(await request("/api/sessions"));
        return data.sessions || [];
      },
      async readMessages(sessionId) {
        const data = await jsonOrThrow(
          await request(`/api/messages?sessionId=${encodeURIComponent(sessionId)}`)
        );
        return data.messages || [];
      },
      async readProjectDir(sessionId) {
        const data = await jsonOrThrow(
          await request(`/api/project?sessionId=${encodeURIComponent(sessionId)}`)
        );
        return data.dir || "";
      },
      async readUsage(sessionId) {
        return jsonOrThrow(await request(`/api/sessions/${encodeURIComponent(sessionId)}/usage`));
      },
      async updateProjectDir(sessionId, dir) {
        const data = await jsonOrThrow(
          await request("/api/project", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, dir }),
          })
        );
        return data.dir || "";
      },
      async createSession() {
        const data = await jsonOrThrow(
          await request("/api/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        );
        return data.session;
      },
      async deleteSession(sessionId) {
        return jsonOrThrow(await request(`/api/sessions/${sessionId}`, { method: "DELETE" }));
      },
    };
  }

  const api = { createSessionApi, jsonOrThrow };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.SessionApi = api;
})(typeof window !== "undefined" ? window : globalThis);
