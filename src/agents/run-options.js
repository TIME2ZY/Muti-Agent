function normalizeRunOptions(options = {}, defaults = {}) {
  const providerOptions =
    options.providerOptions && typeof options.providerOptions === "object"
      ? { ...options.providerOptions }
      : {};
  return {
    proxy: typeof options.proxy === "string" ? options.proxy.trim() : "",
    timeoutMs: options.timeoutMs || defaults.timeoutMs,
    killGraceMs: options.killGraceMs || defaults.killGraceMs,
    retries: options.retries ?? defaults.retries ?? 0,
    providerOptions,
  };
}

module.exports = { normalizeRunOptions };
