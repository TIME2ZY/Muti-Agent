const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isSubagentTool,
  subagentDisplayName,
  summarizeTask,
  toolNameFromItem,
  toolArgsFromItem,
} = require("../src/agents/tool-classification");

test("isSubagentTool detects spawn/task/wait style tools", () => {
  assert.equal(isSubagentTool("spawn_agent", { prompt: "x" }), true);
  assert.equal(isSubagentTool("wait_agent", { id: "1" }), true);
  assert.equal(isSubagentTool("task", { subagent_type: "explore", prompt: "look around" }), true);
  assert.equal(isSubagentTool("web_search", { query: "x" }), false);
  assert.equal(isSubagentTool("read_file", { path: "a.js" }), false);
});

test("tool helpers parse common item shapes", () => {
  assert.equal(toolNameFromItem({ type: "mcp_tool_call", tool: "task" }), "task");
  assert.deepEqual(
    toolArgsFromItem({ arguments: "{\"prompt\":\"hi\",\"subagent_type\":\"explore\"}" }),
    { prompt: "hi", subagent_type: "explore" }
  );
  assert.equal(subagentDisplayName("task", { subagent_type: "explore" }), "explore");
  assert.match(summarizeTask({ prompt: "Find the session runtime module" }), /session runtime/);
});

test("summarizeTask prefers description over long prompt", () => {
  const { summarizeTask: sumTask } = require("../src/agents/tool-classification");
  assert.equal(
    sumTask({
      description: "查看git状态和最近提交",
      prompt: "请执行以下任务：\n1. git status\n2. git log ... very long",
    }),
    "查看git状态和最近提交"
  );
});

test("summarizeResult strips OpenCode task XML wrappers", () => {
  const { summarizeResult: sumRes, cleanToolOutput } = require("../src/agents/tool-classification");
  const raw = `<task id="ses_x" state="completed"><task_result>
## Git status
On branch codex/structured-cli-events
</task_result></task>`;
  assert.match(cleanToolOutput(raw), /On branch codex/);
  assert.doesNotMatch(cleanToolOutput(raw), /<task/);
  assert.doesNotMatch(sumRes(raw), /<task_result>/);
  assert.match(sumRes(raw), /Git status|codex\/structured-cli-events/);
});
