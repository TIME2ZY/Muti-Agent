const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const RUNTIME_DATA_DIR = path.join(ROOT, "data", "runtime");
const DEFAULT_SESSIONS_FILE = path.join(RUNTIME_DATA_DIR, "sessions.json");
const DEFAULT_INVOCATIONS_FILE = path.join(RUNTIME_DATA_DIR, "invocations.json");
const DEFAULT_SESSION_MAP_ROOT = path.join(RUNTIME_DATA_DIR, "session-maps");
const DEFAULT_TRANSCRIPT_DIR = path.join(RUNTIME_DATA_DIR, "transcripts");
const DEFAULT_WORKTREE_STATE_FILE = path.join(RUNTIME_DATA_DIR, "worktrees.json");
const DEFAULT_RAW_EVENTS_DIR = path.join(RUNTIME_DATA_DIR, "raw-events");
const DEFAULT_MEMORY_DB_FILE = path.join(RUNTIME_DATA_DIR, "memory.sqlite");

module.exports = {
  ROOT,
  RUNTIME_DATA_DIR,
  DEFAULT_SESSIONS_FILE,
  DEFAULT_INVOCATIONS_FILE,
  DEFAULT_SESSION_MAP_ROOT,
  DEFAULT_TRANSCRIPT_DIR,
  DEFAULT_WORKTREE_STATE_FILE,
  DEFAULT_RAW_EVENTS_DIR,
  DEFAULT_MEMORY_DB_FILE,
};
