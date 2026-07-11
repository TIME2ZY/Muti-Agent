/**
 * Shared + per-provider proxy resolution for CLI children.
 *
 * Global (all providers), first non-empty wins:
 *   1. explicit option / --proxy
 *   2. INVOKE_CLI_PROXY
 *   3. HTTPS_PROXY / HTTP_PROXY (and lowercase)
 *   4. ALL_PROXY / all_proxy
 *
 * Grok-only (applied only when spawning the grok CLI):
 *   GROK_PROXY | INVOKE_GROK_PROXY | GROK_HTTP_PROXY | GROK_HTTPS_PROXY
 *   then falls back to the global list above.
 *
 * Why Grok-only exists: Grok Build CLI often needs an explicit HTTP(S) proxy
 * to reach api.x.ai, while OpenCode (e.g. DeepSeek) and Codex (ChatGPT +
 * Windows system proxy) may work without forcing the same env onto them.
 */

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Global proxy (shared by codex / opencode / explicit --proxy).
 * @param {{ proxy?: string }} [options]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveProxy(options = {}, env = process.env) {
  return firstNonEmpty(
    options.proxy,
    env.INVOKE_CLI_PROXY,
    env.HTTPS_PROXY,
    env.HTTP_PROXY,
    env.https_proxy,
    env.http_proxy,
    env.ALL_PROXY,
    env.all_proxy
  );
}

/**
 * Grok-specific proxy vars (do not affect codex/opencode unless they also
 * inherit a process-wide HTTP_PROXY the user set themselves).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveGrokOnlyProxy(env = process.env) {
  return firstNonEmpty(
    env.GROK_PROXY,
    env.INVOKE_GROK_PROXY,
    env.GROK_HTTP_PROXY,
    env.GROK_HTTPS_PROXY
  );
}

/**
 * Resolve proxy for a given provider/CLI name.
 * @param {string} [provider] e.g. "grok" | "codex" | "opencode"
 * @param {{ proxy?: string }} [options]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveProviderProxy(provider, options = {}, env = process.env) {
  const name = String(provider || "").toLowerCase();
  if (name === "grok") {
    // Prefer Grok-only vars, then explicit --proxy, then global shared proxy.
    return firstNonEmpty(
      options.proxy,
      resolveGrokOnlyProxy(env),
      resolveProxy({}, env)
    );
  }
  // codex / opencode / others: never pick GROK_PROXY automatically
  return resolveProxy(options, env);
}

/**
 * Env vars to inject into a CLI child so common HTTP clients honor the proxy.
 * @param {string} proxy
 * @returns {Record<string, string>}
 */
function proxyEnvVars(proxy) {
  if (!proxy) return {};
  return {
    INVOKE_CLI_PROXY: proxy,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
  };
}

module.exports = {
  resolveProxy,
  resolveGrokOnlyProxy,
  resolveProviderProxy,
  proxyEnvVars,
};
