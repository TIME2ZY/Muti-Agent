const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_RAW_EVENTS_DIR } = require("../shared/runtime-paths");

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function createRawEventLogger({
  invocationId = "standalone",
  providerId = "",
  enabled,
  rawEventsDir = DEFAULT_RAW_EVENTS_DIR,
  env = process.env,
} = {}) {
  const active = enabled != null ? Boolean(enabled) : isTruthyEnv(env.INVOKE_RAW_EVENT_LOG);
  let logPath = "";

  if (active) {
    try {
      fs.mkdirSync(rawEventsDir, { recursive: true });
      const safeId =
        String(invocationId)
          .replace(/[^a-zA-Z0-9._-]/g, "_")
          .slice(0, 120) || "standalone";
      logPath = path.join(rawEventsDir, `${safeId}.jsonl`);
    } catch {
      logPath = "";
    }
  }

  return {
    path: logPath,
    log(raw) {
      if (!logPath) return;
      try {
        fs.appendFileSync(
          logPath,
          `${JSON.stringify({ ts: new Date().toISOString(), provider: providerId, raw })}\n`,
          "utf8"
        );
      } catch {
        // ignore logging failures
      }
    },
  };
}

module.exports = {
  isTruthyEnv,
  createRawEventLogger,
};
