const fs = require("node:fs");
const path = require("node:path");
const { upsertAgentProviderSession, providerKeyFromConfig } = require("../shared/session-map");

/**
 * Write the session ID for this agent to the per-chat-session file so the
 * server can read it back for the next invocation in the same chat session.
 * Provider sessions are stored per workspaceKey so base/worktree do not overwrite.
 */
function persistProviderSession({
  file,
  agentKey,
  sessionId,
  workspaceKey = "",
  providerKey = "",
}) {
  if (!file || !sessionId || !agentKey) return;

  let sessions = {};
  try {
    if (fs.existsSync(file)) {
      sessions = JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    // corrupted file → start fresh
  }
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
    sessions = {};
  }

  upsertAgentProviderSession(sessions, agentKey, sessionId, workspaceKey, providerKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
}

function persistSessionId(cli, sessionId, env = process.env) {
  const file = env.INVOKE_SESSION_FILE;
  if (!file || !sessionId) return;
  persistProviderSession({
    file,
    agentKey: cli.id || cli.name,
    sessionId,
    workspaceKey: env.INVOKE_WORKSPACE_KEY || "",
    providerKey: providerKeyFromConfig(cli),
  });
}

module.exports = {
  persistProviderSession,
  persistSessionId,
};
