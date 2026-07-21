/**
 * Minimal project .env loader (no dotenv dependency).
 *
 * Loads `.env` then `.env.local` from a directory. Later files override earlier
 * file values. Existing process.env keys are never overwritten (shell / CI wins).
 *
 * Supported lines: KEY=VALUE, optional export prefix, # comments, blank lines,
 * single/double quoted values. No variable expansion.
 */
const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {string} content
 * @returns {Record<string, string>}
 */
function parseEnvContent(content) {
  const result = {};
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = cleaned.indexOf("=");
    if (eq <= 0) continue;

    const key = cleaned.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = cleaned.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }
  return result;
}

/**
 * Apply parsed key/values onto an env object.
 * @param {Record<string, string>} parsed
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ override?: boolean }} [options]
 * @returns {string[]} keys that were written
 */
function applyEnv(parsed, env = process.env, options = {}) {
  const override = Boolean(options.override);
  const applied = [];
  for (const [key, value] of Object.entries(parsed || {})) {
    if (!override && env[key] !== undefined) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/**
 * Read and parse a single env file if it exists.
 * @param {string} filePath
 * @returns {Record<string, string> | null}
 */
function readEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    return parseEnvContent(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Load project env files from root (`.env`, then `.env.local`).
 * @param {string} rootDir
 * @param {{ env?: NodeJS.ProcessEnv, override?: boolean, files?: string[] }} [options]
 * @returns {{ loaded: string[], applied: string[], values: Record<string, string> }}
 */
function loadProjectEnv(rootDir, options = {}) {
  const env = options.env || process.env;
  const files = options.files || [".env", ".env.local"];
  const merged = {};
  const loaded = [];

  for (const name of files) {
    const filePath = path.join(rootDir, name);
    const parsed = readEnvFile(filePath);
    if (!parsed) continue;
    Object.assign(merged, parsed);
    loaded.push(filePath);
  }

  const applied = applyEnv(merged, env, { override: options.override });
  return { loaded, applied, values: merged };
}

module.exports = {
  parseEnvContent,
  applyEnv,
  readEnvFile,
  loadProjectEnv,
};
