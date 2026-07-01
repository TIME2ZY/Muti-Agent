(function initWorkspaceDiff(globalScope) {
  "use strict";

  function normalizePath(line) {
    return String(line || "").replace(/^a\//, "").replace(/^b\//, "").trim();
  }

  function parseUnifiedDiff(diffText) {
    const text = String(diffText || "");
    if (!text.trim()) return [];

    const blocks = text
      .split(/^diff --git /m)
      .filter(Boolean)
      .map((block) => `diff --git ${block}`);

    return blocks
      .map((block) => {
        const lines = block.split("\n");
        const header = lines[0] || "";
        const match = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
        const pathFromHeader = match ? match[2] : "";
        const newFile = lines.some((line) => line.startsWith("new file mode "));
        const deletedFile = lines.some((line) => line.startsWith("deleted file mode "));
        const pathLine = lines.find((line) => line.startsWith("+++ "));
        const resolvedPath = pathLine && !pathLine.includes("/dev/null")
          ? normalizePath(pathLine.slice(4))
          : normalizePath(pathFromHeader);

        return {
          path: resolvedPath,
          status: newFile ? "untracked" : deletedFile ? "deleted" : "modified",
          patch: block.trim(),
        };
      })
      .filter((entry) => entry.path);
  }

  function summarizeUnifiedDiff(files) {
    const list = Array.isArray(files) ? files : [];
    return {
      totalFiles: list.length,
      untrackedFiles: list.filter((file) => file.status === "untracked").length,
      hasDiff: list.length > 0,
    };
  }

  const api = { parseUnifiedDiff, summarizeUnifiedDiff };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.WorkspaceDiff = api;
})(typeof window !== "undefined" ? window : globalThis);
