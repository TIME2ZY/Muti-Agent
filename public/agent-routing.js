(function initAgentRouting(globalScope) {
  "use strict";

  function agentMentionLabel(agent) {
    if (!agent) return "";
    if (typeof agent.mention === "string" && agent.mention) return agent.mention;
    if (typeof agent.label === "string" && agent.label) return agent.label;
    return agent.id || "";
  }

  function findExplicitLeadingAgent(prompt, agents) {
    const text = String(prompt || "").trimStart();
    if (!text.startsWith("@")) return null;

    const list = Array.isArray(agents) ? [...agents] : [];
    list.sort((a, b) => agentMentionLabel(b).length - agentMentionLabel(a).length);

    for (const agent of list) {
      const labels = [agentMentionLabel(agent), agent.id].filter(Boolean);
      for (const label of labels) {
        const token = `@${label}`;
        if (text === token || text.startsWith(`${token} `) || text.startsWith(`${token}\n`)) {
          return agent;
        }
      }
    }
    return null;
  }

  function findAgentById(agents, id) {
    if (!id || !Array.isArray(agents)) return null;
    return agents.find((agent) => agent && agent.id === id) || null;
  }

  /**
   * Resolve which agent should handle a prompt.
   * Priority: leading @mention → session lastAgent → selectedAgent → defaultAgent → first agent.
   */
  function resolvePromptAgent(options = {}) {
    const {
      prompt = "",
      agents = [],
      selectedAgent = "",
      lastAgent = "",
      defaultAgent = "architect",
    } = options;

    const explicit = findExplicitLeadingAgent(prompt, agents);
    if (explicit) {
      return { agent: explicit, source: "mention" };
    }

    const fromSession = findAgentById(agents, lastAgent);
    if (fromSession) {
      return { agent: fromSession, source: "session" };
    }

    const fromSelected = findAgentById(agents, selectedAgent);
    if (fromSelected) {
      return { agent: fromSelected, source: "selected" };
    }

    const fromDefault = findAgentById(agents, defaultAgent);
    if (fromDefault) {
      return { agent: fromDefault, source: "default" };
    }

    if (Array.isArray(agents) && agents[0]) {
      return { agent: agents[0], source: "fallback" };
    }

    return { agent: null, source: "none" };
  }

  const api = {
    agentMentionLabel,
    findExplicitLeadingAgent,
    findAgentById,
    resolvePromptAgent,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.AgentRouting = api;
})(typeof window !== "undefined" ? window : globalThis);
