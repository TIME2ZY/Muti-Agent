const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { findPwsh, windowsUtf8Environment } = require("../../src/agents/windows-runtime");

test("findPwsh prefers an explicit configured path", () => {
  assert.equal(
    findPwsh(
      { SHIFT_PWSH_PATH: "C:\\Tools\\pwsh.exe" },
      { platform: "win32", existsSync: () => false }
    ),
    "C:\\Tools\\pwsh.exe"
  );
});

test("findPwsh locates pwsh.exe on the Windows PATH", () => {
  const expected = path.join("C:\\Tools", "pwsh.exe");
  assert.equal(
    findPwsh(
      { PATH: "C:\\Other;C:\\Tools" },
      { platform: "win32", existsSync: (candidate) => candidate === expected }
    ),
    expected
  );
});

test("Windows provider environment prefers pwsh and UTF-8 defaults", () => {
  const patch = windowsUtf8Environment(
    { PWSH_PATH: "C:\\Tools\\pwsh.exe", LANG: "zh_CN.UTF-8" },
    { platform: "win32" }
  );
  assert.deepEqual(patch, {
    LANG: "zh_CN.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    SHELL: "C:\\Tools\\pwsh.exe",
    SHIFT_PWSH_PATH: "C:\\Tools\\pwsh.exe",
  });
});

test("non-Windows provider environment remains unchanged", () => {
  assert.deepEqual(windowsUtf8Environment({}, { platform: "linux" }), {});
});
