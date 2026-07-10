(function initDisplayHelpers(globalScope) {
  "use strict";

  function fmtTime(iso, nowMs) {
    if (!iso) return "";
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    const diff = now - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  }

  function agentLabelFromList(agents, id) {
    const list = Array.isArray(agents) ? agents : [];
    return list.find((a) => a && a.id === id)?.label || id;
  }

  function agentMention(agent) {
    if (!agent) return "";
    return agent.label || agent.id;
  }

  function agentMeta(agent) {
    if (!agent) return "";
    const cliLabel = agent.cli === "opencode" ? "opencode go" : agent.cli;
    if (agent.cli === "opencode") return `${cliLabel} · ${agent.model}`;
    return agent.reasoningEffort
      ? `${cliLabel} · ${agent.model} · ${agent.reasoningEffort}`
      : `${cliLabel} · ${agent.model}`;
  }

  function roleBadgeLabel(role) {
    if (role === "user") return "发起者";
    if (role === "assistant") return "Agent";
    return "系统";
  }

  function roleDisplayName(role, agentId, agents) {
    if (role === "system") return "系统";
    return role === "user" ? "用户" : agentLabelFromList(agents, agentId);
  }

  function agentRoleLabel(agent) {
    return (agent && agent.description) || "";
  }

  function agentRoleSummary(agent) {
    const desc = (agent && agent.description) || "";
    const max = 32;
    return desc.length > max ? desc.slice(0, max) + "…" : desc;
  }

  function createDisplayHelpers({ getAgents, now } = {}) {
    const agentsOf = typeof getAgents === "function" ? getAgents : () => [];
    const nowOf = typeof now === "function" ? now : () => Date.now();

    function agentLabel(id) {
      return agentLabelFromList(agentsOf(), id);
    }

    return {
      fmtTime(iso) {
        return fmtTime(iso, nowOf());
      },
      agentLabel,
      agentMention,
      agentMeta,
      roleBadgeLabel,
      roleDisplayName(role, agentId) {
        return roleDisplayName(role, agentId, agentsOf());
      },
      agentRoleLabel,
      agentRoleSummary,
    };
  }

  const api = {
    createDisplayHelpers,
    fmtTime,
    agentLabelFromList,
    agentMention,
    agentMeta,
    roleBadgeLabel,
    roleDisplayName,
    agentRoleLabel,
    agentRoleSummary,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.DisplayHelpers = api;
})(typeof window !== "undefined" ? window : globalThis);
