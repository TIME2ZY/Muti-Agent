/**
 * Sync fixed markdown rendering deps into public/vendor/markdown for offline UI.
 *
 * Sources come from package.json dependencies (npm install), not CDNs.
 * Run: node scripts/vendor-md.js
 *      npm run vendor:md
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DEST = path.join(ROOT, "public", "vendor", "markdown");

/** @type {{ src: string, dest: string }[]} */
const FILES = [
  {
    src: "node_modules/markdown-it/dist/markdown-it.min.js",
    dest: "markdown-it.min.js",
  },
  {
    src: "node_modules/dompurify/dist/purify.min.js",
    dest: "purify.min.js",
  },
  {
    src: "node_modules/markdown-it-multimd-table/dist/markdown-it-multimd-table.min.js",
    dest: "markdown-it-multimd-table.min.js",
  },
  {
    src: "node_modules/markdown-it-task-lists/dist/markdown-it-task-lists.min.js",
    dest: "markdown-it-task-lists.min.js",
  },
];

/** @type {{ src: string, dest: string }[]} */
const LICENSES = [
  { src: "node_modules/markdown-it/LICENSE", dest: "LICENSE.markdown-it" },
  { src: "node_modules/dompurify/LICENSE", dest: "LICENSE.dompurify" },
  {
    src: "node_modules/markdown-it-multimd-table/LICENSE",
    dest: "LICENSE.markdown-it-multimd-table",
  },
  {
    src: "node_modules/markdown-it-task-lists/LICENSE",
    dest: "LICENSE.markdown-it-task-lists",
  },
];

function copyFile(srcRel, destName) {
  const from = path.join(ROOT, srcRel);
  const to = path.join(DEST, destName);
  if (!fs.existsSync(from)) {
    throw new Error(`Missing vendor source: ${srcRel} (run npm install)`);
  }
  fs.copyFileSync(from, to);
  const size = fs.statSync(to).size;
  console.log(`  ${destName} (${size} bytes)`);
}

function main() {
  fs.mkdirSync(DEST, { recursive: true });
  console.log(`Vendor markdown deps → ${path.relative(ROOT, DEST)}`);
  for (const { src, dest } of FILES) copyFile(src, dest);
  for (const { src, dest } of LICENSES) {
    try {
      copyFile(src, dest);
    } catch {
      console.warn(`  skip license ${dest} (not found)`);
    }
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const versions = {
    "markdown-it": pkg.dependencies["markdown-it"],
    dompurify: pkg.dependencies.dompurify,
    "markdown-it-multimd-table": pkg.dependencies["markdown-it-multimd-table"],
    "markdown-it-task-lists": pkg.dependencies["markdown-it-task-lists"],
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(DEST, "VERSIONS.json"),
    `${JSON.stringify(versions, null, 2)}\n`,
    "utf8"
  );
  console.log("  VERSIONS.json");
  console.log("Done.");
}

main();
