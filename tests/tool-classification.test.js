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
