(function initLatestRequest(globalScope) {
  "use strict";

  function createLatestRequestRunner() {
    let activeToken = 0;

    return {
      async run(task, callbacks = {}) {
        const token = ++activeToken;
        const onResolve = typeof callbacks.onResolve === "function" ? callbacks.onResolve : null;
        const onReject = typeof callbacks.onReject === "function" ? callbacks.onReject : null;

        try {
          const value = await task();
          if (token !== activeToken) {
            return { applied: false, value };
          }
          if (onResolve) onResolve(value);
          return { applied: true, value };
        } catch (error) {
          if (token !== activeToken) {
            return { applied: false, error };
          }
          if (onReject) onReject(error);
          throw error;
        }
      },
    };
  }

  const api = { createLatestRequestRunner };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.LatestRequest = api;
})(typeof window !== "undefined" ? window : globalThis);
