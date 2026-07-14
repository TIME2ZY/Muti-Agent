(function initDisplayHelpers(globalScope) {
  "use strict";

  function resolveLocale() {
    if (globalScope.Locale && globalScope.Locale.locale) return globalScope.Locale.locale;
    if (globalScope.LocaleZhCN && globalScope.LocaleZhCN.locale) return globalScope.LocaleZhCN.locale;
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./locale-zh-CN.js").locale;
      } catch {
        // fall through
      }
    }
    return {
      role: { user: "用户", system: "系统" },
      roleBadge: { user: "发起者", assistant: "Agent", system: "系统" },
      time: { justNow: "刚刚" },
    };
  }

  function fmtTime(iso, nowMs) {
    if (!iso) return "";
    const L = resolveLocale();
    const now = typeof nowMs === "number" ? nowMs : Date.now();
    const diff = now - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return (L.time && L.time.justNow) || "刚刚";
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

  function resolveCapabilityTags(agent) {
    if (globalScope.MessageProcessHelpers && globalScope.MessageProcessHelpers.capabilityTagList) {
      return globalScope.MessageProcessHelpers.capabilityTagList(agent);
    }
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./message-process-helpers.js").capabilityTagList(agent);
      } catch {
        /* ignore */
      }
    }
    return [];
  }

  function agentMeta(agent) {
    if (!agent) return "";
    const cliLabel = agent.cli === "opencode" ? "opencode go" : agent.cli || agent.providerId || "";
    let base;
    if (agent.cli === "opencode" || agent.providerId === "opencode") {
      base = `${cliLabel || "opencode go"} · ${agent.model}`;
    } else if (agent.cli === "grok" || agent.providerId === "grok") {
      base = agent.reasoningEffort
        ? `xAI · ${agent.model} · ${agent.reasoningEffort}`
        : `xAI · ${agent.model}`;
    } else if (agent.cli === "antigravity" || agent.providerId === "antigravity") {
      base = agent.reasoningEffort
        ? `Antigravity · ${agent.model} · ${agent.reasoningEffort}`
        : `Antigravity · ${agent.model}`;
    } else {
      base = agent.reasoningEffort
        ? `${cliLabel} · ${agent.model} · ${agent.reasoningEffort}`
        : `${cliLabel} · ${agent.model}`;
    }
    // Capability tags only when the API provided an explicit capabilities object.
    if (agent.capabilities && typeof agent.capabilities === "object") {
      const tags = resolveCapabilityTags(agent);
      if (tags.length) base = `${base} · ${tags.join("+")}`;
    }
    return base;
  }

  function roleBadgeLabel(role) {
    const L = resolveLocale().roleBadge || {};
    if (role === "user") return L.user || "发起者";
    if (role === "assistant") return L.assistant || "Agent";
    return L.system || "系统";
  }

  function roleDisplayName(role, agentId, agents) {
    const L = resolveLocale().role || {};
    if (role === "system") return L.system || "系统";
    return role === "user" ? (L.user || "用户") : agentLabelFromList(agents, agentId);
  }

  function agentRoleLabel(agent) {
    return (agent && agent.description) || "";
  }

  function agentRoleSummary(agent) {
    const desc = (agent && agent.description) || "";
    const max = 32;
    return desc.length > max ? desc.slice(0, max) + "…" : desc;
  }

  /** Stable palette slots (1..AGENT_COLOR_COUNT) for multi-agent scanning. */
  const AGENT_COLOR_COUNT = 6;
  const AGENT_COLOR_BY_ID = {
    architect: 1,
    orchestrator: 2,
    planner: 3,
    gemini: 3, // brainstorm / ideation cohort with 小谋
    coder: 4,
    grok: 4, // coding cohort shares palette slot with 小码
    frontend: 5,
    critic: 6,
  };

  function agentColorIndex(id) {
    if (!id) return 1;
    const key = String(id);
    if (Object.prototype.hasOwnProperty.call(AGENT_COLOR_BY_ID, key)) {
      return AGENT_COLOR_BY_ID[key];
    }
    let h = 0;
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    }
    return (Math.abs(h) % AGENT_COLOR_COUNT) + 1;
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
      agentColorIndex,
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
    agentColorIndex,
    AGENT_COLOR_COUNT,
    roleBadgeLabel,
    roleDisplayName,
    agentRoleLabel,
    agentRoleSummary,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.DisplayHelpers = api;
})(typeof window !== "undefined" ? window : globalThis);
