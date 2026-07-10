(function initProjectHeader(globalScope) {
  "use strict";

  function createProjectHeader(deps) {
    const {
      projectDirEl,
      projectDirPath,
      worktreeStatusEl,
      state,
      sessionApi,
      worktreeApi,
    } = deps;

    async function loadProjectDir(sessionId = state.currentSessionId) {
      if (!sessionId) {
        projectDirPath.textContent = state.projectDir || "(当前目录)";
        return;
      }
      try {
        state.projectDir = await sessionApi.readProjectDir(sessionId);
        projectDirPath.textContent = state.projectDir || "(当前目录)";
      } catch {
        state.projectDir = "";
        projectDirPath.textContent = "(当前目录)";
      }
    }

    function renderWorktreeStatus() {
      const wt = state.worktreeStatus;
      if (!wt) {
        worktreeStatusEl.textContent = "";
        worktreeStatusEl.className = "worktree-status";
        worktreeStatusEl.title = "当前对话尚未创建修改 worktree";
        return;
      }
      const marker = wt.clean ? "clean" : "dirty";
      worktreeStatusEl.textContent = "";
      const label = document.createElement("span");
      label.textContent = `${wt.branch || "(worktree)"} · ${marker}`;
      worktreeStatusEl.append(label);
      if (wt.previewUrl) {
        const link = document.createElement("a");
        link.href = wt.previewUrl;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "预览";
        link.className = "worktree-preview-link";
        link.title = `预览修改后的应用 (${wt.previewUrl})`;
        worktreeStatusEl.append(link);
      }
      worktreeStatusEl.className = "worktree-status" + (wt.clean ? "" : " dirty");
      worktreeStatusEl.title = wt.worktreeDir || wt.branch || "";
    }

    async function loadWorktreeStatus() {
      if (!state.currentSessionId) {
        state.worktreeStatus = null;
        renderWorktreeStatus();
        return;
      }
      try {
        state.worktreeStatus = await worktreeApi.readStatus(state.currentSessionId, { allowMissing: true });
        renderWorktreeStatus();
      } catch {
        state.worktreeStatus = null;
        renderWorktreeStatus();
      }
    }

    function bindProjectDirEdit() {
      if (!projectDirEl) return;
      projectDirEl.addEventListener("click", () => {
        if (projectDirEl.classList.contains("editing")) return;
        const input = document.createElement("input");
        input.className = "project-dir-input";
        input.value = state.projectDir;
        input.placeholder = "/path/to/project";
        projectDirEl.classList.add("editing");
        projectDirEl.appendChild(input);
        input.focus();
        input.select();

        const done = async (save) => {
          const val = input.value.trim();
          input.remove();
          projectDirEl.classList.remove("editing");

          if (save && val && val !== state.projectDir) {
            if (!state.currentSessionId) {
              state.projectDir = val;
              projectDirPath.textContent = val;
              return;
            }
            try {
              state.projectDir = await sessionApi.updateProjectDir(state.currentSessionId, val);
              projectDirPath.textContent = state.projectDir;
            } catch (e) {
              alert("设置失败: " + e.message);
            }
          }
        };

        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); done(true); }
          if (e.key === "Escape") { done(false); }
        });
        input.addEventListener("blur", () => done(true));
      });
    }

    return {
      loadProjectDir,
      loadWorktreeStatus,
      renderWorktreeStatus,
      bindProjectDirEdit,
    };
  }

  const api = { createProjectHeader };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.ProjectHeader = api;
})(typeof window !== "undefined" ? window : globalThis);
