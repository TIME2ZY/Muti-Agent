/**
 * Centralized zh-CN strings for the frontend.
 * Keep HTML shell copy in index.html for now; JS UI / status / badges use this map.
 * Swap or extend later for multi-locale support.
 */
(function initLocaleZhCN(globalScope) {
  "use strict";

  const locale = {
    code: "zh-CN",

    role: {
      user: "用户",
      system: "系统",
    },
    roleBadge: {
      user: "发起者",
      assistant: "Agent",
      system: "系统",
    },

    time: {
      justNow: "刚刚",
    },

    badge: {
      thinking: "思考中",
      writing: "输出中",
      error: "异常退出",
    },

    message: {
      copy: "复制消息",
      copyOk: "已复制",
      copyFail: "失败",
      thinkingProcess: "思考过程",
      thinkingProcessChars: (n) => `思考过程 · ${n} 字`,
      process: "执行过程",
      running: "运行中",
      done: "完成",
      success: "成功",
      failed: "失败",
      progressDone: (n) => `进度 · ${n} 步已完成`,
      progressPartial: (done, total) => `进度 · ${done}/${total}`,
    },

    status: {
      stopped: "已停止",
      generating: "生成中…",
      done: "完成",
      error: "异常退出",
    },

    confirm: {
      deleteSession: "删除对话？此操作不可撤销。",
      discardWorkspace: "丢弃当前 worktree 的全部改动？",
    },

    empty: {
      title: "选择默认 Agent 后直接发送，或用 @ 单次指定模型",
      hint: "Enter 发送 · Shift + Enter 换行 · 右侧卡片切换默认 Agent",
    },

    composer: {
      send: "发送",
      stop: "停止生成",
      clear: "清空",
      placeholder: "直接输入消息，或用 @Agent 单次指定模型…",
    },

    shell: {
      title: "多 Agent 协作台",
      skillsActive: "已激活能力",
      tabAgents: "Agents",
      tabWorkspace: "工作区",
      tabRecall: "回忆",
      worktreeChip: "改代码",
    },
  };

  function t(path, fallback = "") {
    const parts = String(path || "").split(".");
    let cur = locale;
    for (const part of parts) {
      if (cur == null || typeof cur !== "object") return fallback || path;
      cur = cur[part];
    }
    if (typeof cur === "function") return cur;
    if (cur == null) return fallback || path;
    return cur;
  }

  const api = { locale, t, defaultLocale: locale };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.LocaleZhCN = api;
  // Default active locale for helpers that look up globalScope.Locale
  if (!globalScope.Locale) globalScope.Locale = api;
})(typeof window !== "undefined" ? window : globalThis);
