const fs = require("node:fs");
const path = require("node:path");
const { assertValidOpaqueId, resolveInside } = require("./id-policy");
const { updateJsonAtomic, writeJsonAtomic } = require("../shared/atomic-json-file");
const {
  LEGACY_WORKSPACE_KEY,
  getByWorkspaceMap,
  resolveResumeSessionId,
  upsertAgentProviderSession,
  clearAgentProviderSession,
} = require("../shared/session-map");

function sanitizeDir(id) {
  return assertValidOpaqueId(id, "chatSessionId");
}

function getSessionMapPath(chatSessionId, sessionMapRoot) {
  return resolveInside(sessionMapRoot, sanitizeDir(chatSessionId), "sessions.json");
}

function readSessionMap(chatSessionId, sessionMapRoot) {
  const file = getSessionMapPath(chatSessionId, sessionMapRoot);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeSessionMap(chatSessionId, sessionMapRoot, sessions) {
  const file = getSessionMapPath(chatSessionId, sessionMapRoot);
  writeJsonAtomic(file, sessions || {});
  return file;
}

/**
 * Drop the provider session for agent × workspace after a window seal so the
 * next invocation does not resume the abandoned provider chain.
 */
function abandonProviderSession(chatSessionId, sessionMapRoot, agentKey, workspaceKey = "") {
  const file = getSessionMapPath(chatSessionId, sessionMapRoot);
  return updateJsonAtomic(file, (sessions) => {
    clearAgentProviderSession(sessions, agentKey, workspaceKey);
    return sessions;
  });
}

function deleteSessionMap(chatSessionId, sessionMapRoot) {
  fs.rmSync(path.dirname(getSessionMapPath(chatSessionId, sessionMapRoot)), {
    recursive: true,
    force: true,
  });
}

module.exports = {
  LEGACY_WORKSPACE_KEY,
  sanitizeDir,
  getSessionMapPath,
  readSessionMap,
  writeSessionMap,
  abandonProviderSession,
  deleteSessionMap,
  getByWorkspaceMap,
  resolveResumeSessionId,
  upsertAgentProviderSession,
  clearAgentProviderSession,
};
