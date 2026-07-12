(function initApiClient(globalScope) {
  "use strict";

  const UI_TOKEN_HEADER = "X-Shift-UI-Token";

  function readUiToken(documentRef) {
    const meta = documentRef && documentRef.querySelector
      ? documentRef.querySelector('meta[name="shift-ui-token"]')
      : null;
    return meta ? meta.getAttribute("content") || "" : "";
  }

  function createApiFetch(fetchImpl, uiToken) {
    if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
    return function apiFetch(input, init = {}) {
      const headers = new Headers(init.headers || {});
      headers.set(UI_TOKEN_HEADER, uiToken || "");
      return fetchImpl(input, { ...init, headers });
    };
  }

  const nativeFetch = globalScope.fetch ? globalScope.fetch.bind(globalScope) : null;
  const token = readUiToken(globalScope.document);
  const api = {
    UI_TOKEN_HEADER,
    readUiToken,
    createApiFetch,
    apiFetch: nativeFetch ? createApiFetch(nativeFetch, token) : null,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.ApiClient = api;
})(typeof window !== "undefined" ? window : globalThis);
