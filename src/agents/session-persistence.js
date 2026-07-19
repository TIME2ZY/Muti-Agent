const { upsertAgentProviderSession, providerKeyFromConfig } = require("../shared/session-map");
const { updateJsonAtomic } = require("../shared/atomic-json-file");

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

  updateJsonAtomic(file, (sessions) => {
    upsertAgentProviderSession(sessions, agentKey, sessionId, workspaceKey, providerKey);
    return sessions;
  });
}

function persistSessionId(cli, sessionId, env = process.env) {
  const file = env.INVOKE_SESSION_FILE;
  if (!file || !sessionId) return;
  persistProviderSession({
    file,
    agentKey: cli.id,
    sessionId,
    workspaceKey: env.INVOKE_WORKSPACE_KEY || "",
    providerKey: providerKeyFromConfig(cli),
  });
}

module.exports = {
  persistProviderSession,
  persistSessionId,
};
