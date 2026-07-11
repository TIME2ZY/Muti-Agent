const { codexProvider } = require("./codex");
const { opencodeProvider } = require("./opencode");
const { grokProvider } = require("./grok");
const { requireModelProfile } = require("../catalog");
const { assertCanonicalEvent, makeEvent, normalizeCanonicalEvent } = require("../event-protocol");
const { resolveProxy, proxyEnvVars } = require("../proxy");

const REQUIRED_ADAPTER_METHODS = ["createRuntime", "buildInvocation"];

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function assertProviderAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("Provider adapter must be an object.");
  }
  if (!adapter.id || typeof adapter.id !== "string") {
    throw new Error("Provider adapter id is required.");
  }
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`Provider adapter "${adapter.id}" must implement ${method}().`);
    }
  }
  if (!adapter.capabilities || typeof adapter.capabilities !== "object") {
    throw new Error(`Provider adapter "${adapter.id}" must declare capabilities.`);
  }
  if (!Array.isArray(adapter.allowedProviderOptions)) {
    throw new Error(
      `Provider adapter "${adapter.id}" must declare allowedProviderOptions as an array.`
    );
  }
  return adapter;
}

const PROVIDERS = Object.fromEntries(
  [codexProvider, opencodeProvider, grokProvider].map((adapter) => {
    assertProviderAdapter(adapter);
    return [adapter.id, adapter];
  })
);
const PROVIDER_RUNTIMES = Object.fromEntries(
  Object.entries(PROVIDERS).map(([id, adapter]) => [id, adapter.createRuntime])
);

function providerIdFrom(config) {
  return config && (config.providerId || config.name);
}

function getProviderAdapter(providerId) {
  const adapter = PROVIDERS[providerId];
  if (!adapter) {
    throw new Error(
      `Unsupported provider "${providerId}". Supported: ${Object.keys(PROVIDERS).join(", ")}`
    );
  }
  return adapter;
}

function validateProviderOptions(adapter, providerOptions) {
  const options =
    providerOptions && typeof providerOptions === "object" && !Array.isArray(providerOptions)
      ? providerOptions
      : {};
  if (Array.isArray(providerOptions)) {
    throw new Error(`providerOptions for "${adapter.id}" must be an object.`);
  }
  const allowed = new Set(adapter.allowedProviderOptions || []);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new Error(
      `Unknown providerOptions for "${adapter.id}": ${unknown.join(", ")}. Allowed: ${[
        ...allowed,
      ].join(", ") || "(none)"}.`
    );
  }
  return options;
}

function validateProviderConfig(config) {
  const providerId = providerIdFrom(config);
  const adapter = getProviderAdapter(providerId);
  const modelProfile = config.model ? requireModelProfile(providerId, config.model) : null;

  validateProviderOptions(adapter, config.providerOptions);

  if (config.reasoningEffort && modelProfile && modelProfile.reasoning.supported) {
    const levels = modelProfile.reasoning.levels || [];
    if (levels.length && !levels.includes(config.reasoningEffort)) {
      throw new Error(
        `Unsupported reasoning effort "${config.reasoningEffort}" for ${providerId}/${config.model}. Supported: ${levels.join(", ")}.`
      );
    }
  }
  if (typeof adapter.validate === "function") adapter.validate(config, modelProfile);
  return { adapter, modelProfile };
}

function createProviderRuntime(config) {
  const { adapter } = validateProviderConfig(config);
  const runtime = adapter.createRuntime(config);
  if (!runtime || typeof runtime.transform !== "function") {
    throw new Error(`Provider runtime "${adapter.id}" must implement transform().`);
  }
  let started = false;
  let terminal = false;

  const validateEvents = (events, context, sessionId = "") => {
    if (!Array.isArray(events)) {
      throw new Error(`Provider runtime "${adapter.id}" must return an event array.`);
    }
    const normalized = events.map(normalizeCanonicalEvent);
    const hasStarted = normalized.some((event) => event.type === "run.started");
    if (hasStarted) started = true;
    const hasTerminal = normalized.some(
      (event) => event.type === "run.finished" || event.type === "run.failed"
    );
    if (hasTerminal) terminal = true;
    if (normalized.length && !started) {
      normalized.unshift(
        makeEvent("run.started", {
          agent: context.agent,
          invocationId: context.invocationId,
          sessionId,
          provider: adapter.id,
          model: config.model || "",
        })
      );
      started = true;
    }
    return normalized.map(assertCanonicalEvent);
  };
  return {
    extractSessionId:
      typeof runtime.extractSessionId === "function"
        ? runtime.extractSessionId.bind(runtime)
        : () => "",
    transform(event, context) {
      const sessionId =
        typeof runtime.extractSessionId === "function" ? runtime.extractSessionId(event) : "";
      return validateEvents(runtime.transform(event, context), context, sessionId);
    },
    finish(context, outcome = {}) {
      const rawEvents = typeof runtime.finish === "function" ? runtime.finish(context) : [];
      const events = validateEvents(rawEvents, context);
      if (outcome.terminal === true && !terminal) {
        if (!started) {
          events.push(
            assertCanonicalEvent(
              makeEvent("run.started", {
                agent: context.agent,
                invocationId: context.invocationId,
                sessionId: "",
                provider: adapter.id,
                model: config.model || "",
              })
            )
          );
          started = true;
        }
        const terminalEvent = outcome.ok
          ? makeEvent("run.finished", {
              agent: context.agent,
              invocationId: context.invocationId,
              exitCode: outcome.exitCode ?? 0,
              signal: outcome.signal || null,
            })
          : makeEvent("run.failed", {
              agent: context.agent,
              invocationId: context.invocationId,
              error: outcome.error || "Provider process failed.",
              exitCode: outcome.exitCode ?? null,
              signal: outcome.signal || null,
            });
        events.push(assertCanonicalEvent(terminalEvent));
        terminal = true;
      }
      return events;
    },
  };
}

function buildProviderInvocation(config, prompt) {
  const { adapter } = validateProviderConfig(config);
  return adapter.buildInvocation(config, prompt);
}

function resolveProviderRunOptions(config, options = {}, env = process.env) {
  const { adapter } = validateProviderConfig(config);
  const proxy =
    typeof adapter.resolveProxy === "function"
      ? adapter.resolveProxy(options, env)
      : resolveProxy(options, env);
  return { ...options, proxy };
}

/**
 * Build the env patch for a provider CLI child process.
 * Always injects shared proxy vars; adapters may add provider-owned keys.
 */
function buildProviderEnvironment(config, options = {}, env = process.env) {
  const { adapter } = validateProviderConfig(config);
  const runOptions = resolveProviderRunOptions(config, options, env);
  const patch = {
    ...proxyEnvVars(runOptions.proxy),
  };
  if (typeof adapter.buildEnvironment === "function") {
    Object.assign(patch, adapter.buildEnvironment(runOptions, env) || {});
  }
  return { env: { ...env, ...patch }, proxy: runOptions.proxy, runOptions };
}

/**
 * Collect diagnostic messages for stderr before spawn.
 * Shared proxy log + adapter-owned warnings (e.g. missing Grok proxy).
 */
function getProviderDiagnostics(config, options = {}, env = process.env) {
  const { adapter } = validateProviderConfig(config);
  const runOptions = resolveProviderRunOptions(config, options, env);
  const messages = [];

  if (runOptions.proxy && isTruthyEnv(env.INVOKE_CLI_PROXY_LOG)) {
    messages.push(`[invoke-cli] proxy for ${adapter.id}: ${runOptions.proxy}`);
  }

  if (typeof adapter.diagnostics === "function") {
    const extra = adapter.diagnostics(runOptions, env);
    if (Array.isArray(extra)) {
      for (const line of extra) {
        if (typeof line === "string" && line.trim()) messages.push(line);
      }
    }
  }

  return messages;
}

function listSupportedProviders() {
  return Object.keys(PROVIDERS);
}

module.exports = {
  PROVIDERS,
  // Compatibility alias for existing integrations.
  PROVIDER_RUNTIMES,
  assertProviderAdapter,
  getProviderAdapter,
  validateProviderConfig,
  validateProviderOptions,
  createProviderRuntime,
  buildProviderInvocation,
  resolveProviderRunOptions,
  buildProviderEnvironment,
  getProviderDiagnostics,
  listSupportedProviders,
};
