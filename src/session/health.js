const { AGENTS, DEFAULT_CONTEXT_TOKENS, getAgentModelProfile } = require("../agents/catalog");
const { ENV } = require("../shared/brand");

// Rough rule of thumb: 1 token ≈ 4 characters for English/CJK-mixed text.
// This is intentionally conservative — overestimating token count means we
// seal slightly too early, which is the safer direction.
const CHARS_PER_TOKEN = 4;

// All known agents currently use 200k token context windows. Override per
// agent via AGENTS[id].capacityTokens, or per call via makeTracker options.
const DEFAULT_CAPACITY_TOKENS = DEFAULT_CONTEXT_TOKENS;

function getAgentCapacity(agentId) {
  // Test override: lets integration tests force tiny capacities to exercise
  // warn/action thresholds without producing megabytes of stdout.
  const envOverride = Number(process.env[ENV.TEST_CAPACITY]);
  if (Number.isFinite(envOverride) && envOverride > 0) return envOverride;

  const agent = AGENTS[agentId];
  if (!agent) return DEFAULT_CAPACITY_TOKENS;
  if (agent.capacityTokens) return agent.capacityTokens;
  const modelProfile = getAgentModelProfile(agentId);
  return modelProfile ? modelProfile.contextTokens : DEFAULT_CAPACITY_TOKENS;
}

function makeTracker(agentId, opts = {}) {
  const capacityTokens = opts.capacityTokens || getAgentCapacity(agentId);
  let inputChars = nonNegativeNumber(opts.inputChars);
  let outputChars = nonNegativeNumber(opts.outputChars);
  const startedAt = Date.now();

  function addInput(n) {
    if (typeof n === "number" && n > 0) inputChars += n;
  }

  function addOutput(n) {
    if (typeof n === "number" && n > 0) outputChars += n;
  }

  function getUsedChars() {
    return inputChars + outputChars;
  }

  function getFillRatio() {
    return getUsedChars() / (capacityTokens * CHARS_PER_TOKEN);
  }

  function snapshot() {
    return {
      agentId,
      capacityTokens,
      inputChars,
      outputChars,
      usedChars: getUsedChars(),
      usedTokens: Math.floor(getUsedChars() / CHARS_PER_TOKEN),
      fillRatio: getFillRatio(),
      elapsedMs: Date.now() - startedAt,
    };
  }

  return {
    agentId,
    capacityTokens,
    addInput,
    addOutput,
    getUsedChars,
    getFillRatio,
    snapshot,
  };
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

module.exports = {
  makeTracker,
  getAgentCapacity,
  CHARS_PER_TOKEN,
  DEFAULT_CAPACITY_TOKENS,
};
