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
      setDefaultAgent,
      insertAgentMention,
      promptEl,
    } = deps;

    function renderCurrentAgent() {
      const agent = state.agents.find((a) => a.id === state.selectedAgent)
        || state.agents[0]
        || { id: state.selectedAgent || "architect", label: state.selectedAgent || "architect" };
      const label = agentLabel(agent.id);
      if (currentAgentNameEl) currentAgentNameEl.textContent = label;
      if (currentAgentEl) {
        currentAgentEl.title = `当前默认 Agent：${label}（${agent.id}）。右侧卡片点击切换默认；消息行首 @ 可单次覆盖。`;
      }
    }

    function renderAgentTabs() {
      if (!agentTabsEl) return;
      agentTabsEl.replaceChildren(...state.agents.map((a) => {
        const item = document.createElement("article");
        const isSelected = a.id === state.selectedAgent;
        item.className = "agent-tab" + (isSelected ? " is-selected" : "");
        item.setAttribute("role", "button");
        item.tabIndex = 0;
        item.setAttribute("aria-pressed", isSelected ? "true" : "false");
        item.title = a.description
          ? `${a.label} (${a.id}) — ${a.description}\n点击设为默认 Agent · Shift+点击插入 @${agentMention(a)}`
          : `点击设为默认 Agent · Shift+点击插入 @${agentMention(a)}`;
        item.innerHTML = `
          <span class="agent-tab-role"></span>
          <span class="agent-tab-name"></span>
          <span class="agent-tab-model"></span>`;
        item.querySelector(".agent-tab-role").textContent = agentRoleSummary(a);
        item.querySelector(".agent-tab-name").textContent = agentLabel(a.id);
        item.querySelector(".agent-tab-model").textContent = agentMeta(a);
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
