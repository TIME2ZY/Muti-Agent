const { createCodexRuntime } = require("./codex");
const { createOpencodeRuntime } = require("./opencode");

function createProviderRuntime(cli) {
  if (cli.name === "codex") return createCodexRuntime(cli);
  if (cli.name === "opencode") return createOpencodeRuntime(cli);
  throw new Error(`Unsupported provider "${cli.name}"`);
}

module.exports = {
  createProviderRuntime,
};
