const fs = require("node:fs");
const path = require("node:path");

function sanitizeDir(id) {
  return (id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

function getSessionMapPath(chatSessionId, sessionMapRoot) {
  return path.join(sessionMapRoot, sanitizeDir(chatSessionId), "sessions.json");
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
