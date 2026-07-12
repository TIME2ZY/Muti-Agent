const path = require("node:path");
const { DEFAULT_MEMORY_DB_FILE, DEFAULT_SESSIONS_FILE } = require("../shared/runtime-paths");
const { createDualWriteRecorder } = require("./dual-write-recorder");
const { createStorage } = require("./index");

function createServerStorage(options = {}, sessionsFile, logger = console) {
  const mode = options.storageMode || process.env.CAT_CAFE_STORAGE_MODE || "dual";
  if (!new Set(["files", "dual"]).has(mode)) {
    throw new Error(`Unsupported storage mode "${mode}". Use files or dual.`);
  }
  if (mode === "files") {
    return {
      mode,
      storage: null,
      recorder: createDualWriteRecorder(),
      close() {},
    };
  }

  let storage = options.storage || null;
  const ownsStorage = !storage;
  if (!storage) {
    const file =
      options.memoryDbFile ||
      process.env.CAT_CAFE_MEMORY_DB ||
      (sessionsFile && path.resolve(sessionsFile) !== path.resolve(DEFAULT_SESSIONS_FILE)
        ? path.join(path.dirname(sessionsFile), "memory.sqlite")
        : DEFAULT_MEMORY_DB_FILE);
    try {
      storage = createStorage({ file });
    } catch (error) {
      logger.error(`[sqlite-dual-write] initialization failed: ${error.message}`);
    }
  }

  const recorder = createDualWriteRecorder({ storage, logger });
  return {
    mode,
    storage,
    recorder,
    close() {
      recorder.close();
      if (ownsStorage && storage) storage.close();
    },
  };
}

module.exports = { createServerStorage };
