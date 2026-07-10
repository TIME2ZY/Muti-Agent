(function initAgentPanelView(globalScope) {
  "use strict";

  function createAgentPanelView(deps) {
    const {
      agentTabsEl,
      currentAgentEl,
      currentAgentNameEl,
      state,
      agentLabel,
      agentMention,
      agentMeta,
      agentRoleSummary,
      agentColorIndex,
      setDefaultAgent,
      insertAgentMention,
      promptEl,
    } = deps;

    function colorFor(id) {
      if (typeof agentColorIndex === "function") return String(agentColorIndex(id));
      return "1";
    }

    function renderCurrentAgent() {
      const agent = state.agents.find((a) => a.id === state.selectedAgent)
        || state.agents[0]
        || { id: state.selectedAgent || "architect", label: state.selectedAgent || "architect" };
      const label = agentLabel(agent.id);
      if (currentAgentNameEl) currentAgentNameEl.textContent = label;
      if (currentAgentEl) {
        currentAgentEl.title = `当前默认 Agent：${label}（${agent.id}）。点击打开 Agents；消息行首 @ 可单次覆盖。`;
        currentAgentEl.dataset.agentColor = colorFor(agent.id);
        currentAgentEl.dataset.agentId = agent.id;
        if (typeof currentAgentEl.setAttribute === "function") {
          currentAgentEl.setAttribute("aria-label", `当前默认 Agent：${label}`);
        }
      }
    }

    function renderAgentTabs() {
      if (!agentTabsEl) return;
      agentTabsEl.replaceChildren(...state.agents.map((a) => {
        const item = document.createElement("article");
        const isSelected = a.id === state.selectedAgent;
        item.className = "agent-tab" + (isSelected ? " is-selected" : "");
        item.dataset.agentColor = colorFor(a.id);
        item.dataset.agentId = a.id;
        item.setAttribute("role", "button");
        item.tabIndex = 0;
        item.setAttribute("aria-pressed", isSelected ? "true" : "false");
        item.title = a.description
          ? `${a.label} (${a.id}) — ${a.description}\n点击设为默认 Agent · Shift+点击插入 @${agentMention(a)}`
          : `点击设为默认 Agent · Shift+点击插入 @${agentMention(a)}`;
        // Order: name → model → capability tag
        item.innerHTML = `
          <span class="agent-tab-name"></span>
          <span class="agent-tab-model"></span>
          <span class="agent-tab-role"></span>`;
        item.querySelector(".agent-tab-name").textContent = agentLabel(a.id);
        item.querySelector(".agent-tab-model").textContent = agentMeta(a);
        item.querySelector(".agent-tab-role").textContent = agentRoleSummary(a);
        item.addEventListener("click", (e) => {
          if (e.shiftKey) {
            insertAgentMention(a);
            return;
          }
          setDefaultAgent(a.id);
          if (promptEl) promptEl.focus();
        });
        item.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (e.shiftKey) insertAgentMention(a);
            else {
              setDefaultAgent(a.id);
              if (promptEl) promptEl.focus();
            }
          }
        });
        return item;
      }));
      renderCurrentAgent();
    }

    return { renderAgentTabs, renderCurrentAgent };
  }

  const api = { createAgentPanelView };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.AgentPanelView = api;
})(typeof window !== "undefined" ? window : globalThis);
