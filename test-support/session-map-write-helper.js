const fs = require("node:fs");
const { persistProviderSession } = require("../src/agents/session-persistence");

const [file, gate, agentKey, sessionId] = process.argv.slice(2);
fs.writeFileSync(`${gate}.${agentKey}.ready`, "ready\n", "utf8");
while (!fs.existsSync(`${gate}.go`)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
persistProviderSession({
  file,
  agentKey,
  sessionId,
  workspaceKey: `base:${agentKey}`,
  providerKey: `${agentKey}:test`,
});
