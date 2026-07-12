const DEFAULT_CONTEXT_TOKENS = 200_000;

function model(providerId, modelId, vendorId, options = {}) {
  return {
    id: modelId,
    providerId,
    vendorId,
    contextTokens: options.contextTokens || DEFAULT_CONTEXT_TOKENS,
    reasoning: options.reasoning || { supported: false, levels: [] },
  };
}

const MODEL_PROFILES = [
  model("codex", "gpt-5.5", "openai", {
    reasoning: { supported: true, levels: ["low", "medium", "high"] },
  }),
  model("codex", "gpt-5.4", "openai", {
    reasoning: { supported: true, levels: ["low", "medium", "high"] },
  }),
  model("opencode", "deepseek-v4-flash", "deepseek"),
  model("opencode", "deepseek-v4-pro", "deepseek"),
  model("opencode", "glm-5.1", "zhipu"),
  model("opencode", "glm-5.2", "zhipu"),
  model("opencode", "kimi-k2.6", "moonshot"),
  model("opencode", "kimi-k2.7-code", "moonshot"),
  model("opencode", "mimo-v2.5", "xiaomi"),
  model("opencode", "mimo-v2.5-pro", "xiaomi"),
  model("opencode", "minimax-m2.7", "minimax"),
  model("opencode", "minimax-m3", "minimax", {
    reasoning: { supported: true, levels: ["high"] },
  }),
  model("opencode", "qwen3.6-plus", "alibaba"),
  model("opencode", "qwen3.7-max", "alibaba"),
  model("opencode", "qwen3.7-plus", "alibaba"),
  model("grok", "grok-4.5", "xai", {
    contextTokens: 500_000,
    reasoning: { supported: true, levels: ["low", "medium", "high"] },
  }),
];

const MODELS = Object.fromEntries(
  MODEL_PROFILES.map((profile) => [`${profile.providerId}:${profile.id}`, profile])
);

function agent(id, label, providerId, modelId, description, options = {}) {
  return {
    id,
    label,
    providerId,
    // Compatibility alias for older callers. New code should use providerId.
    name: providerId,
    model: modelId,
    // Compatibility override; context capacity is otherwise owned by the model profile.
    ...(options.capacityTokens ? { capacityTokens: options.capacityTokens } : {}),
    reasoningEffort: options.reasoningEffort || "",
    description,
  };
}

const AGENTS = {
  architect: agent("architect", "Codex", "codex", "gpt-5.5", "默认主控 Agent，负责规划与编排。", {
    reasoningEffort: "high",
  }),
  orchestrator: agent(
    "orchestrator",
    "万事通",
    "opencode",
    "deepseek-v4-pro",
    "通才型助手，兜底各种杂活与跨领域问题。"
  ),
  planner: agent(
    "planner",
    "小谋",
    "opencode",
    "mimo-v2.5-pro",
    "推理与规划专家，擅长任务拆解、方案设计与决策建议。"
  ),
  coder: agent(
    "coder",
    "小码",
    "opencode",
    "minimax-m3",
    "Coding 主力，负责服务端与通用代码实现与重构。",
    { reasoningEffort: "high" }
  ),
  grok: agent(
    "grok",
    "Grok",
    "grok",
    "grok-4.5",
    "Grok 4.5 high — 本地 Grok Build CLI 编码与硬推理主力。",
    { reasoningEffort: "high", capacityTokens: 500_000 }
  ),
  frontend: agent(
    "frontend",
    "小视",
    "opencode",
    "glm-5.2",
    "前端 Coding 专家，专注 UI、样式、交互与可访问性。"
  ),
  critic: agent(
    "critic",
    "小评",
    "opencode",
    "qwen3.7-plus",
    "Review 专家，负责代码评审、问题诊断与质量把关。"
  ),
};

function getModelProfile(providerId, modelId) {
  return MODELS[`${providerId}:${modelId}`] || null;
}

function requireModelProfile(providerId, modelId) {
  const profile = getModelProfile(providerId, modelId);
  if (profile) return profile;
  const supported = MODEL_PROFILES.filter((candidate) => candidate.providerId === providerId).map(
    (candidate) => candidate.id
  );
  throw new Error(
    `Unsupported ${providerId} model "${modelId}". Supported models: ${supported.join(", ")}.`
  );
}

function getAgentModelProfile(agentId) {
  const profile = AGENTS[agentId];
  return profile ? getModelProfile(profile.providerId, profile.model) : null;
}

module.exports = {
  DEFAULT_CONTEXT_TOKENS,
  MODEL_PROFILES,
  MODELS,
  AGENTS,
  getModelProfile,
  requireModelProfile,
  getAgentModelProfile,
};
