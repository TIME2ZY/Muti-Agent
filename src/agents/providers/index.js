const { createCodexRuntime } = require("./codex");
const { createOpencodeRuntime } = require("./opencode");

/**
 * Provider adapters keyed by CLI runtime name (not model id).
 * Add Claude etc. here: claude: createClaudeRuntime.
 */
const PROVIDER_RUNTIMES = {
  codex: createCodexRuntime,
  opencode: createOpencodeRuntime,
};

function createProviderRuntime(cli) {
  const name = cli && cli.name;
  const factory = PROVIDER_RUNTIMES[name];
  if (!factory) {
    const supported = Object.keys(PROVIDER_RUNTIMES).join(", ");
    throw new Error(`Unsupported provider "${name}". Supported: ${supported}`);
  }
  return factory(cli);
}

function listSupportedProviders() {
  return Object.keys(PROVIDER_RUNTIMES);
}

module.exports = {
  PROVIDER_RUNTIMES,
  createProviderRuntime,
  listSupportedProviders,
};
