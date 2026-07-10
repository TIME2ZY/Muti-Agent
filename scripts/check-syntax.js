#!/usr/bin/env node
/**
 * Recursively run `node --check` on project JS files.
 * Avoids hardcoding paths in package.json when files are added/removed.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const INCLUDE_DIRS = ["src", "public", "tests", "test-support", "scripts"];

const IGNORE_DIR_NAMES = new Set([
  "node_modules",
  "vendor",
  "data",
  "transcripts",
  "raw-events",
  "session-maps",
]);

function shouldSkipDir(name) {
  return IGNORE_DIR_NAMES.has(name) || name.startsWith(".");
}

function collectJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      collectJsFiles(path.join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function main() {
  const files = [];
  for (const rel of INCLUDE_DIRS) {
    collectJsFiles(path.join(ROOT, rel), files);
  }
  files.sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    console.error("check-syntax: no JavaScript files found.");
    process.exit(1);
  }

  let failed = 0;
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      failed += 1;
      const err = (result.stderr || result.stdout || "").trim();
      console.error(`FAIL ${rel}`);
      if (err) console.error(err);
    }
  }

  if (failed > 0) {
    console.error(`\ncheck-syntax: ${failed}/${files.length} file(s) failed.`);
    process.exit(1);
  }

  console.log(`check-syntax: ok (${files.length} files)`);
}

main();
