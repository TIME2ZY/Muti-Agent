const fs = require("node:fs");
const path = require("node:path");

function findPwsh(env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return "";
  const existsSync = options.existsSync || fs.existsSync;
  const explicit = String(env.SHIFT_PWSH_PATH || env.PWSH_PATH || "").trim();
  if (explicit) return explicit;

  const delimiter = options.delimiter || ";";
  const pathValue = String(env.PATH || env.Path || "");
  for (const entry of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = path.join(entry, "pwsh.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function windowsUtf8Environment(env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return {};
  const pwsh = findPwsh(env, options);
  return {
    LANG: env.LANG || "C.UTF-8",
    LC_ALL: env.LC_ALL || "C.UTF-8",
    PYTHONUTF8: env.PYTHONUTF8 || "1",
    PYTHONIOENCODING: env.PYTHONIOENCODING || "utf-8",
    ...(pwsh ? { SHELL: pwsh, SHIFT_PWSH_PATH: pwsh } : {}),
  };
}

module.exports = {
  findPwsh,
  windowsUtf8Environment,
};
