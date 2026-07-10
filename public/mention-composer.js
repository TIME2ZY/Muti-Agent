(function initMentionComposer(globalScope) {
  "use strict";

  function getMentionTrigger(value, cursorPos) {
    const pos = typeof cursorPos === "number" ? cursorPos : String(value || "").length;
    const before = String(value || "").slice(0, pos);
    const match = before.match(/(^|\s)@([^\s@]*)$/);
    if (!match) return null;
    return {
      start: before.length - match[2].length - 1,
      end: pos,
      query: match[2].toLowerCase(),
    };
  }

  function createMentionComposer(deps) {
    const {
      promptEl,
      menuEl,
      state,
      getAgents,
      setDefaultAgent,
      agentMention,
      agentMeta,
      updateActiveSkills,
    } = deps;

    function hide() {
      state.mentionOpen = false;
      state.mentionMatches = [];
      state.mentionRange = null;
      if (menuEl) {
        menuEl.hidden = true;
        menuEl.replaceChildren();
      }
      if (promptEl) {
        promptEl.setAttribute("aria-expanded", "false");
        promptEl.removeAttribute("aria-activedescendant");
      }
    }

    function render() {
      if (!menuEl) return;
      menuEl.replaceChildren(...state.mentionMatches.map((agent, index) => {
        const option = document.createElement("button");
        option.type = "button";
        option.id = `mention-option-${index}`;
        option.setAttribute("role", "option");
        const selected = index === state.mentionIndex;
        option.setAttribute("aria-selected", selected ? "true" : "false");
        // Keep both active + is-active during transition (M3 state naming).
        option.className = "mention-option" + (selected ? " active is-active" : "");
        option.innerHTML = `<span class="mention-option-name"></span><span class="mention-option-meta"></span>`;
        option.querySelector(".mention-option-name").textContent = `@${agentMention(agent)}`;
        option.querySelector(".mention-option-meta").textContent = agentMeta(agent);
        option.addEventListener("mousedown", (e) => {
          e.preventDefault();
          select(index);
        });
        return option;
      }));
      const open = state.mentionMatches.length > 0;
      menuEl.hidden = !open;
      state.mentionOpen = open;
      if (promptEl) {
        promptEl.setAttribute("aria-expanded", open ? "true" : "false");
        if (open && state.mentionMatches.length) {
          const idx = Math.max(0, Math.min(state.mentionIndex || 0, state.mentionMatches.length - 1));
          promptEl.setAttribute("aria-activedescendant", `mention-option-${idx}`);
        } else {
          promptEl.removeAttribute("aria-activedescendant");
        }
      }
    }

    function update() {
      if (!promptEl) {
        hide();
        return;
      }
      const trigger = getMentionTrigger(promptEl.value, promptEl.selectionStart || 0);
      if (!trigger) {
        hide();
        return;
      }

      const agents = typeof getAgents === "function" ? getAgents() : [];
      const matches = agents.filter((agent) => {
        const label = agentMention(agent).toLowerCase();
        const id = String(agent.id || "").toLowerCase();
        return label.includes(trigger.query) || id.includes(trigger.query);
      });
      if (matches.length === 0) {
        hide();
        return;
      }

      state.mentionRange = trigger;
      state.mentionMatches = matches;
      state.mentionIndex = Math.min(state.mentionIndex || 0, matches.length - 1);
      if (state.mentionIndex < 0) state.mentionIndex = 0;
      render();
    }

    function select(index = state.mentionIndex) {
      const agent = state.mentionMatches[index];
      if (!agent || !state.mentionRange || !promptEl) return;

      const before = promptEl.value.slice(0, state.mentionRange.start);
      const after = promptEl.value.slice(state.mentionRange.end);
      const insert = `@${agentMention(agent)} `;
      promptEl.value = before + insert + after;
      const cursor = (before + insert).length;
      promptEl.setSelectionRange(cursor, cursor);
      if (typeof setDefaultAgent === "function") setDefaultAgent(agent.id);
      hide();
      if (typeof updateActiveSkills === "function") updateActiveSkills(promptEl.value);
      promptEl.focus();
    }

    /**
     * Handle mention navigation keys.
     * @returns {boolean} true if the event was consumed
     */
    function handleKeydown(e) {
      if (!state.mentionOpen) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        state.mentionIndex = (state.mentionIndex + 1) % state.mentionMatches.length;
        render();
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        state.mentionIndex = (state.mentionIndex - 1 + state.mentionMatches.length) % state.mentionMatches.length;
        render();
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        select();
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hide();
        return true;
      }
      return false;
    }

    function isOpen() {
      return !!state.mentionOpen;
    }

    return {
      getMentionTrigger,
      update,
      hide,
      render,
      select,
      handleKeydown,
      isOpen,
    };
  }

  const api = { createMentionComposer, getMentionTrigger };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.MentionComposer = api;
})(typeof window !== "undefined" ? window : globalThis);
