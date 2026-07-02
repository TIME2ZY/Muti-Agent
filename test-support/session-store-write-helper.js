const fs = require("node:fs");
const path = require("node:path");

const store = require("../src/server/session-store");

const sessionsFile = path.resolve(process.argv[2] || "");
const gatePrefix = path.resolve(process.argv[3] || "");
const role = process.argv[4] || "writer";

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (!sessionsFile) {
  throw new Error("sessionsFile is required");
}

if (role === "slow") {
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function patchedWriteFileSync(target, ...args) {
    const result = originalWriteFileSync.call(fs, target, ...args);
    const resolvedTarget = path.resolve(target);
    if (resolvedTarget.startsWith(`${sessionsFile}.`) && resolvedTarget.endsWith(".tmp")) {
      originalWriteFileSync.call(fs, `${gatePrefix}.ready`, "ready\n", "utf8");
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(`${gatePrefix}.go`)) {
        if (Date.now() > deadline) {
          throw new Error("Timed out waiting for release gate");
        }
        sleep(25);
      }
    }
    return result;
  };
}

store.writeSessions(sessionsFile, {
  sessions: {
    [role]: {
      id: role,
      title: role,
      createdAt: new Date().toISOString(),
      messages: [],
      worktree: null,
      projectDir: "",
    },
  },
  lastSessionId: role,
});
