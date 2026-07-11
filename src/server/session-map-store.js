const fs = require("node:fs");
const path = require("node:path");
const { assertValidOpaqueId, resolveInside } = require("./id-policy");
const {
  LEGACY_WORKSPACE_KEY,
  getByWorkspaceMap,
  resolveResumeSessionId,
  upsertAgentProviderSession,
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
  deleteSessionMap,
  getByWorkspaceMap,
  resolveResumeSessionId,
  upsertAgentProviderSession,
};
