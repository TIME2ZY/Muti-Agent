(function initAgentPanelView(globalScope) {
  "use strict";

  function budgetRailSegments(fillRatio) {
    const usedPercent = Math.min(80, Math.max(0, Number(fillRatio || 0) * 80));
    return { usedPercent, remainingPercent: Math.max(0, 80 - usedPercent) };
  }

  function createAgentPanelView(deps) {
    const {
      agentTabsEl,
      contextStatusEl,
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

    function compactTokens(value) {
      const count = Number(value || 0);
      if (!Number.isFinite(count)) return "—";
      if (count >= 1_000_000)
        return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 1 : 2).replace(/\.0+$/, "")}M`;
      if (count >= 1_000)
        return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
      return String(Math.round(count));
    }

    function usageEntry(agent) {
      const entries =
        state.usageSummary && Array.isArray(state.usageSummary.agents)
          ? state.usageSummary.agents
          : [];
      const stored = entries.find((entry) => entry.agentId === agent.id) || null;
      const contextWindowTokens = Number(
        stored?.context?.contextWindowTokens || agent.contextTokens || 0
      );
      const reserveRatio = Number(stored?.context?.reserveRatio ?? agent.reserveRatio ?? 0.2);
      const reserveTokens = Number(
        stored?.context?.reserveTokens || Math.floor(contextWindowTokens * reserveRatio)
      );
      const usableContextTokens = Number(
        stored?.context?.usableContextTokens || Math.max(0, contextWindowTokens - reserveTokens)
      );
      const contextUsedTokens = Number(stored?.context?.contextUsedTokens || 0);
      return {
        ...stored,
        context: {
          ...(stored?.context || {}),
          contextWindowTokens,
          reserveRatio,
          reserveTokens,
          usableContextTokens,
          contextUsedTokens,
          remainingTokens: Math.max(0, usableContextTokens - contextUsedTokens),
          budgetFillRatio: usableContextTokens > 0 ? contextUsedTokens / usableContextTokens : 0,
          contextUsageSource: stored?.context?.contextUsageSource || "char_estimated",
        },
      };
    }

    function renderBudget(item, agent) {
      const entry = usageEntry(agent);
      const context = entry.context;
      const billing = entry.billing || {};
      const sessionUsage = item.querySelector(".agent-session-usage");
      const sessionTotal = Number(billing.totalTokens || 0);
      sessionUsage.querySelector("strong").textContent =
        sessionTotal > 0 ? `${compactTokens(sessionTotal)} tokens` : "—";
      sessionUsage.title = [
        `本会话输入 ${compactTokens(billing.inputTokens)}`,
        `输出 ${compactTokens(billing.outputTokens)}`,
        `缓存 ${compactTokens(billing.cachedInputTokens)}`,
        `推理 ${compactTokens(billing.reasoningTokens)}`,
      ].join(" · ");
      const { usedPercent, remainingPercent } = budgetRailSegments(context.budgetFillRatio);
      const budget = item.querySelector(".agent-tab-budget");
      const rail = item.querySelector(".context-rail");
      budget.hidden = false;
      rail.style.setProperty("--context-used", `${usedPercent}%`);
      rail.style.setProperty("--context-remaining", `${remainingPercent}%`);
      rail.setAttribute("aria-valuenow", String(Math.round(context.contextUsedTokens)));
      rail.setAttribute("aria-valuemax", String(Math.round(context.usableContextTokens)));
      const source = context.contextUsageSource === "provider_exact" ? "精确" : "估算";
      item.querySelector(".agent-budget-used").textContent =
        `${compactTokens(context.contextUsedTokens)} 已用`;
      item.querySelector(".agent-budget-remaining").textContent =
        `${compactTokens(context.remainingTokens)} 剩余`;
      item.querySelector(".agent-budget-source").textContent = source;
      item.classList.toggle(
        "context-warning",
        context.budgetFillRatio >= 0.9 && context.budgetFillRatio < 1
      );
      item.classList.toggle("context-full", context.budgetFillRatio >= 1);
      budget.title = `物理窗口 ${compactTokens(context.contextWindowTokens)} · 可用 ${compactTokens(context.usableContextTokens)} · 预留 ${compactTokens(context.reserveTokens)} · ${source}`;
    }

    function colorFor(id) {
      if (typeof agentColorIndex === "function") return String(agentColorIndex(id));
      return "1";
    }

    function renderCurrentAgent() {
      const agent = state.agents.find((a) => a.id === state.selectedAgent) ||
        state.agents[0] || {
          id: state.selectedAgent || "codex",
          label: state.selectedAgent || "codex",
        };
      const label = agentLabel(agent.id);
      if (contextStatusEl) {
        const context = usageEntry(agent).context;
        const ratio = Math.max(0, context.budgetFillRatio || 0);
        contextStatusEl.hidden = false;
        contextStatusEl.classList.toggle("context-warning", ratio >= 0.9 && ratio < 1);
        contextStatusEl.classList.toggle("context-full", ratio >= 1);
        const value = contextStatusEl.querySelector("#context-status-value");
        if (value)
          value.textContent = `${Math.round(ratio * 100)}% · 余 ${compactTokens(context.remainingTokens)}`;
        contextStatusEl.title = `${label}：已用 ${compactTokens(context.contextUsedTokens)} / 可用 ${compactTokens(context.usableContextTokens)}；物理窗口 ${compactTokens(context.contextWindowTokens)}`;
      }
    }

    function renderAgentTabs() {
      if (!agentTabsEl) return;
      agentTabsEl.replaceChildren(
        ...state.agents.map((a) => {
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
          <span class="agent-tab-avatar-slot"></span>
          <span class="agent-tab-name"></span>
          <span class="agent-tab-model"></span>
          <span class="agent-session-usage"><span>本会话</span><strong></strong></span>
          <span class="agent-tab-role"></span>
          <div class="agent-tab-budget" hidden>
            <div class="context-rail" role="progressbar" aria-label="上下文可用预算" aria-valuemin="0">
              <span class="context-rail-used"></span>
              <span class="context-rail-remaining"></span>
              <span class="context-rail-reserve"></span>
            </div>
            <div class="agent-budget-meta">
              <span class="agent-budget-used"></span>
              <span class="agent-budget-remaining"></span>
              <span class="agent-budget-source"></span>
            </div>
          </div>`;
          item.querySelector(".agent-tab-name").textContent = agentLabel(a.id);
          if (globalScope.AgentAvatar) {
            const avatar = globalScope.AgentAvatar.createAgentAvatar(a.id, {
              label: agentLabel(a.id),
              className: "agent-avatar-panel",
            });
            const slot = item.querySelector(".agent-tab-avatar-slot");
            if (slot && avatar) slot.appendChild(avatar);
          }
          item.querySelector(".agent-tab-model").textContent = agentMeta(a);
          item.querySelector(".agent-tab-role").textContent = agentRoleSummary(a);
          renderBudget(item, a);
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
        })
      );
      renderCurrentAgent();
    }

    return { renderAgentTabs, renderCurrentAgent };
  }

  const api = { createAgentPanelView, budgetRailSegments };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.AgentPanelView = api;
})(typeof window !== "undefined" ? window : globalThis);
