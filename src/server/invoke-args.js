function createInvokeArgsBuilder({ agents }) {
  function buildInvokeArgs(body, augmentedPrompt) {
    const agent = typeof body.agent === "string" ? body.agent : "codex";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (!agents[agent]) throw new Error(`Unsupported agent "${agent}".`);
    if (!prompt) throw new Error("Prompt is required.");

    const args = ["src/agents/invoke-cli.js", "--agent", agent];
    args.push(augmentedPrompt || prompt);
    return args;
  }

  function buildChatArgs(agent, prompt, augmentedPrompt) {
    return buildInvokeArgs({ agent, prompt }, augmentedPrompt);
  }

  return { buildInvokeArgs, buildChatArgs };
}

module.exports = { createInvokeArgsBuilder };
