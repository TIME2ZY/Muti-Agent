(function initAgentPanelView(globalScope) {
  "use strict";

  function budgetRailSegments(fillRatio) {
    const usedPercent = Math.min(80, Math.max(0, Number(fillRatio || 0) * 80));
    return { usedPercent, remainingPercent: Math.max(0, 80 - usedPercent) };
  }

  function createAgentPanelView(deps) {
    const {
      agentTabsEl,
      currentAgentEl,
      currentAgentNameEl,
      contextStatusEl,
      usageSummaryEl,
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

    function renderSessionUsage() {
      if (!usageSummaryEl) return;
      const billing = state.usageSummary?.session || {};
      const total = Number(billing.totalTokens || 0);
      usageSummaryEl.innerHTML = `
        <div class="usage-summary-head">
          <span class="usage-summary-label">本次对话累计</span>
          <strong class="usage-summary-total"></strong>
        </div>
        <dl class="usage-summary-grid">
          <div><dt>输入</dt><dd data-usage="input"></dd></div>
          <div><dt>输出</dt><dd data-usage="output"></dd></div>
          <div><dt>缓存</dt><dd data-usage="cached"></dd></div>
          <div><dt>推理</dt><dd data-usage="reasoning"></dd></div>
        </dl>`;
      usageSummaryEl.querySelector(".usage-summary-total").textContent =
        `${compactTokens(total)} tokens`;
      usageSummaryEl.querySelector('[data-usage="input"]').textContent = compactTokens(
        billing.inputTokens
      );
      usageSummaryEl.querySelector('[data-usage="output"]').textContent = compactTokens(
        billing.outputTokens
      );
      usageSummaryEl.querySelector('[data-usage="cached"]').textContent = compactTokens(
        billing.cachedInputTokens
      );
      usageSummaryEl.querySelector('[data-usage="reasoning"]').textContent = compactTokens(
        billing.reasoningTokens
      );
      const cost = Number(billing.costUsd || 0);
      usageSummaryEl.title =
        cost > 0 ? `供应商已报告费用：$${cost.toFixed(4)}` : "费用仅在供应商报告时统计";
    }

    function renderBudget(item, agent) {
      const entry = usageEntry(agent);
      const context = entry.context;
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
      if (currentAgentNameEl) currentAgentNameEl.textContent = label;
      if (currentAgentEl) {
        currentAgentEl.title = `当前默认 Agent：${label}（${agent.id}）。点击打开 Agents；消息行首 @ 可单次覆盖。`;
        currentAgentEl.dataset.agentColor = colorFor(agent.id);
        currentAgentEl.dataset.agentId = agent.id;
        if (typeof currentAgentEl.setAttribute === "function") {
          currentAgentEl.setAttribute("aria-label", `当前默认 Agent：${label}`);
        }
      }
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
          <span class="agent-tab-name"></span>
          <span class="agent-tab-model"></span>
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
      renderSessionUsage();
      renderCurrentAgent();
    }

    return { renderAgentTabs, renderCurrentAgent };
  }

  const api = { createAgentPanelView, budgetRailSegments };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.AgentPanelView = api;
})(typeof window !== "undefined" ? window : globalThis);
