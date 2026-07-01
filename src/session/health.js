const { AGENTS } = require("../agents/invoke-cli");

// Rough rule of thumb: 1 token ≈ 4 characters for English/CJK-mixed text.
// This is intentionally conservative — overestimating token count means we
// seal slightly too early, which is the safer direction.
const CHARS_PER_TOKEN = 4;

// All known agents currently use 200k token context windows. Override per
// agent via AGENTS[id].capacityTokens, or per call via makeTracker options.
const DEFAULT_CAPACITY_TOKENS = 200_000;

function getAgentCapacity(agentId) {
  // Test override: lets integration tests force tiny capacities to exercise
  // warn/action thresholds without producing megabytes of stdout.
  const envOverride = Number(process.env.CAT_CAFE_TEST_CAPACITY);
  if (Number.isFinite(envOverride) && envOverride > 0) return envOverride;

  const agent = AGENTS[agentId];
  if (!agent) return DEFAULT_CAPACITY_TOKENS;
  return agent.capacityTokens || DEFAULT_CAPACITY_TOKENS;
}

function makeTracker(agentId, opts = {}) {
  const capacityTokens = opts.capacityTokens || getAgentCapacity(agentId);
  let inputChars = 0;
  let outputChars = 0;
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

module.exports = {
  makeTracker,
  getAgentCapacity,
  CHARS_PER_TOKEN,
  DEFAULT_CAPACITY_TOKENS,
};
