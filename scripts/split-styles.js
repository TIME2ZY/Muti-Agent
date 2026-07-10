const fs = require("fs");
const path = require("path");

const cssPath = path.join(__dirname, "../public/styles.css");
let text = fs.readFileSync(cssPath, "utf8").replace(/^\uFEFF/, "");
const lines = text.split(/\n/).map((l) => (l.startsWith("    ") ? l.slice(4) : l));
text = lines.join("\n");

const headers = [];
const re = /\/\* ═+\s*\n\s*([^\n*]+?)\s*\n\s*═+ \*\//g;
let m;
while ((m = re.exec(text))) {
  headers.push({ name: m[1].trim(), index: m.index });
}

function sliceBetween(startName, endName) {
  const start = headers.find((h) => h.name.includes(startName));
  const end = endName ? headers.find((h) => h.name.includes(endName)) : null;
  if (!start) throw new Error("missing " + startName);
  return text.slice(start.index, end ? end.index : text.length).trim() + "\n";
}

const outDir = path.join(__dirname, "../public/styles");
fs.mkdirSync(outDir, { recursive: true });

let tokens = text.slice(0, headers.find((h) => h.name.includes("RESET")).index).trim() + "\n";
if (!tokens.includes("--density")) {
  tokens = tokens.replace(
    /(--radius: 14px;)/,
    "$1\n\n  /* Density (1 = comfortable; compact via data-density) */\n  --density: 1;\n  --row-pad-y: calc(8px * var(--density));"
  );
  tokens += `
:root[data-density="compact"] {
  --density: 0.85;
}
`;
}

const a11y = `/* ═══════════════════════════════════════════════════════════
   A11Y + SHARED OVERLAYS
   ═══════════════════════════════════════════════════════════ */

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.ui-confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: color-mix(in srgb, #000 45%, transparent);
}

.ui-confirm-backdrop[hidden] { display: none; }

.ui-confirm-dialog {
  width: min(420px, 100%);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-primary);
  box-shadow: 0 16px 40px color-mix(in srgb, #000 25%, transparent);
  padding: var(--space-5);
}

.ui-confirm-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: var(--space-2);
}

.ui-confirm-body {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.55;
  margin-bottom: var(--space-5);
}

.ui-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
}

/* Mobile side-panel expand for workspace/recall */
.side-panel.is-expanded {
  max-height: min(50vh, 360px) !important;
}

.mention-option.active,
.mention-option.is-active {
  background: color-mix(in srgb, var(--accent) 12%, var(--surface-raised));
  color: var(--text-primary);
}
`;

const parts = {
  "tokens.css": tokens,
  "base.css": sliceBetween("RESET", "APP SHELL"),
  "shell.css":
    sliceBetween("APP SHELL", "MESSAGES") + "\n" + sliceBetween("RESPONSIVE — Tablet", "RECALL"),
  "messages.css": sliceBetween("MESSAGES", "AGENT PANEL"),
  "workspace.css": sliceBetween("AGENT PANEL", "COMPOSER"),
  "composer.css": sliceBetween("COMPOSER", "RESPONSIVE — Tablet"),
  "recall.css": sliceBetween("RECALL", null),
  "a11y.css": a11y,
};

for (const [name, content] of Object.entries(parts)) {
  fs.writeFileSync(path.join(outDir, name), content, "utf8");
  console.log("wrote", name, content.split(/\n/).length);
}

const aggregator = `/* Frontend styles aggregator — domain sheets under public/styles/ */
@import url("./styles/tokens.css");
@import url("./styles/base.css");
@import url("./styles/shell.css");
@import url("./styles/messages.css");
@import url("./styles/workspace.css");
@import url("./styles/composer.css");
@import url("./styles/recall.css");
@import url("./styles/a11y.css");
`;
fs.writeFileSync(cssPath, aggregator, "utf8");
console.log("aggregator ok");
