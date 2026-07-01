const fs = require("node:fs");
const path = require("node:path");

function validateProjectDir(dir) {
  const value = typeof dir === "string" ? dir.trim() : "";
  if (!value) {
    throw new Error("dir is required.");
  }

  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory not found: ${resolved}`);
  }

  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }

  return resolved;
}

module.exports = {
  validateProjectDir,
};
