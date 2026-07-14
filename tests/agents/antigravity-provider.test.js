const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAntigravityRuntime,
  resolveAgyModelLabel,
  resolveAgyCommand,
  antigravityProvider,
} = require("../../src/agents/providers/antigravity");
const { AGENTS } = require("../../src/agents/catalog");
const { buildInvocation } = require("../../src/agents/invoke-cli");
const { createProviderRuntime, listSupportedProviders } = require("../../src/agents/providers");

test("provider registry includes antigravity", () => {
  assert.ok(listSupportedProviders().includes("antigravity"));
  const runtime = createProviderRuntime({
    providerId: "antigravity",
    model: "gemini-3.5-flash",
    reasoningEffort: "high",
  });
  assert.equal(typeof runtime.transform, "function");
  assert.equal(typeof runtime.parseStdoutLine, "function");
});

test("AGENTS.gemini is catalogued as Gemini 3.5 Flash high brainstormer", () => {
  assert.ok(AGENTS.gemini);
  assert.equal(AGENTS.gemini.label, "Gemini");
  assert.equal(AGENTS.gemini.providerId, "antigravity");
  assert.equal(AGENTS.gemini.name, "antigravity");
  assert.equal(AGENTS.gemini.model, "gemini-3.5-flash");
  assert.equal(AGENTS.gemini.reasoningEffort, "high");
  assert.match(AGENTS.gemini.description, /头脑风暴|灵光/);
});

test("resolveAgyModelLabel embeds effort in CLI model name", () => {
  assert.equal(resolveAgyModelLabel("gemini-3.5-flash", "high"), "Gemini 3.5 Flash (High)");
  assert.equal(resolveAgyModelLabel("gemini-3.5-flash", "medium"), "Gemini 3.5 Flash (Medium)");
  assert.equal(resolveAgyModelLabel("gemini-3.1-pro", "low"), "Gemini 3.1 Pro (Low)");
  assert.equal(
    resolveAgyModelLabel("Gemini 3.5 Flash (High)", "medium"),
    "Gemini 3.5 Flash (High)"
  );
});

test("buildInvocation for gemini spawns agy print mode", () => {
  const inv = buildInvocation(AGENTS.gemini, "brainstorm names");
  assert.match(String(inv.command), /agy(\.exe)?$/i);
  assert.ok(inv.args.includes("-p"));
  assert.ok(inv.args.includes("brainstorm names"));
  assert.ok(inv.args.includes("--model"));
  assert.ok(inv.args.includes("Gemini 3.5 Flash (High)"));
  assert.ok(inv.args.includes("--dangerously-skip-permissions"));
  assert.ok(inv.args.includes("--mode"));
  assert.ok(inv.args.includes("plan"));
});

test("buildInvocation resumes with --conversation", () => {
  const inv = buildInvocation(
    { ...AGENTS.gemini, resumeSessionId: "ac743010-d674-432f-a4a9-bf20647ceb54" },
    "continue ideas"
  );
  const idx = inv.args.indexOf("--conversation");
  assert.ok(idx >= 0);
  assert.equal(inv.args[idx + 1], "ac743010-d674-432f-a4a9-bf20647ceb54");
});

test("buildInvocation rejects unsupported effort", () => {
  assert.throws(
    () =>
      buildInvocation(
        { providerId: "antigravity", model: "gemini-3.5-flash", reasoningEffort: "ultra" },
        "x"
      ),
    /Unsupported reasoning effort "ultra"/
  );
});

test("resolveAgyCommand returns a string", () => {
  const cmd = resolveAgyCommand();
  assert.equal(typeof cmd, "string");
  assert.ok(cmd.length > 0);
});

test("createAntigravityRuntime maps plain stdout lines to text.delta", () => {
  const runtime = createAntigravityRuntime(AGENTS.gemini);
  const ctx = { agent: "gemini", invocationId: "inv-g1" };

  const synthetic = runtime.parseStdoutLine("fresh idea one");
  assert.equal(synthetic.type, "agy.stdout");

  const events = runtime.transform(synthetic, ctx);
  assert.equal(events[0].type, "run.started");
  assert.equal(events[0].provider, "antigravity");
  assert.equal(events[0].model, "Gemini 3.5 Flash (High)");
  assert.equal(events[1].type, "text.delta");
  assert.equal(events[1].text, "fresh idea one\n");

  const more = runtime.transform(runtime.parseStdoutLine("fresh idea two"), ctx);
  assert.deepEqual(
    more.map((e) => e.type),
    ["text.delta"]
  );
  assert.equal(more[0].text, "fresh idea two\n");
});

test("antigravity adapter declares expected capabilities", () => {
  assert.equal(antigravityProvider.id, "antigravity");
  assert.equal(antigravityProvider.capabilities.resume, true);
  assert.equal(antigravityProvider.capabilities.thinking, false);
  assert.ok(antigravityProvider.allowedProviderOptions.includes("mode"));
});
