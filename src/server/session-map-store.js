const fs = require("node:fs");
const path = require("node:path");
const { assertValidOpaqueId, resolveInside } = require("./id-policy");

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
  sanitizeDir,
  getSessionMapPath,
  readSessionMap,
  deleteSessionMap,
};
