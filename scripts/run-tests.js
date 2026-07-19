const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TESTS_DIR = path.join(ROOT, "tests");

function collectTests(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectTests(target);
      return entry.isFile() && entry.name.endsWith(".test.js") ? [target] : [];
    })
    .sort();
}

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shift-tests-"));
const transcriptDir = path.join(runtimeRoot, "transcripts");

try {
  const result = spawnSync(process.execPath, ["--test", ...collectTests(TESTS_DIR)], {
    cwd: ROOT,
    env: {
      ...process.env,
      SHIFT_TRANSCRIPT_DIR: transcriptDir,
    },
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}
