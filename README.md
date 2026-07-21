<div align="center">

# SHIFT AGENTS · 交班台

### 把散落在终端里的 AI Agent，组织成一支会接力的本地团队。

在一个浏览器窗口里调度 **Codex、Gemini、Grok 与 OpenCode**：<br>
从讨论方案到实现代码，再到审查结果，让不同 Agent 在同一条协作线程中完成交接。

![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-3c873a?style=flat-square)
![Agents](https://img.shields.io/badge/Agents-4-5b55e7?style=flat-square)
![Local first](https://img.shields.io/badge/Local-first-111827?style=flat-square)
![Status](https://img.shields.io/badge/Status-Private-c46a16?style=flat-square)

[快速体验](#快速体验) · [认识这支团队](#认识这支团队) · [了解工作方式](#一条任务如何完成)

</div>

![SHIFT 多智能体交班台界面](docs/assets/shift-console.png)

---

## 一个人发令，一支 Agent 团队推进

SHIFT 不是把四个聊天窗口拼在一起。它把本机已有的 CLI Agent 接入统一工作流，让任务能够被讨论、实现、复核，并带着上下文交给下一位协作者。

| 从这里开始               | SHIFT 帮你推进到这里                               |
| ------------------------ | -------------------------------------------------- |
| **一个还不清晰的想法**   | Codex 梳理问题，Gemini 发散方案，再交叉收敛        |
| **一个需要落地的需求**   | Grok 在隔离 worktree 中实现，改动与主工作区分开    |
| **一份等待把关的代码**   | OpenCode 检查 diff、风险与质量，给出审查意见       |
| **一项跨多轮的复杂任务** | 会话、交接记录与结构化记忆持续保留，不必反复补背景 |

## 你会看到什么

### 一屏掌握整个协作现场

会话、实时消息、Agent 状态、上下文用量、工作区 diff 与回忆都集中在同一个控制台。你看到的不只是最终答案，也能看见任务正在由谁处理、还剩多少上下文，以及接下来交给谁。

### 用 `@` 完成自然交接

在消息开头输入 `@Codex`、`@Gemini`、`@Grok` 或 `@OpenCode`，即可指定本轮协作者。Agent 也可以在输出中点名下一位成员，把结论与任务一起传递下去。

### 改代码时，先把边界划清楚

默认模式适合阅读、分析和方案讨论。开启「改代码」后，SHIFT 会为会话创建或复用独立 git worktree；你可以先查看 diff，再决定如何处理成果。

### 上下文会满，协作记忆不会突然消失

SHIFT 跟踪每位 Agent 的上下文用量，在窗口需要轮换时保留结构化记忆与可检索的会话记录，让后续 Agent 能继续工作，而不是从头猜测。

## 认识这支团队

|      | Agent        | 最适合的工作                 | 运行方式          |
| :--: | ------------ | ---------------------------- | ----------------- |
|  🟢   | **Codex**    | 澄清问题、推理分析、权衡方案 | `Codex CLI`       |
|  🔵   | **Gemini**   | 头脑风暴、扩展思路、交叉验证 | `Antigravity CLI` |
|  🟠   | **Grok**     | 编写代码、实现功能、运行测试 | `Grok Build`      |
|  🟣   | **OpenCode** | 代码审查、风险检查、质量把关 | `OpenCode CLI`    |

> SHIFT 负责协作与界面，不打包模型或 CLI。你可以按需要安装并登录对应工具。

## 一条任务如何完成

```text
你提出目标
    ↓
Codex / Gemini 讨论与收敛
    ↓  携带交接信息
Grok 在隔离 worktree 中实现
    ↓  提交 diff
OpenCode 审查与把关
    ↓
你查看过程与结果
```

这条路径不是固定流水线。你可以只找一位 Agent 快速处理，也可以随时用 `@` 改变路线，让合适的成员在合适的阶段接手。

## 快速体验

准备好 **Node.js 20+**，并至少安装一个你要使用的 Agent CLI：

```bash
git clone <repo-url>
cd Muti-Agent
npm ci
npm start
```

打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)，选择项目目录，然后直接描述你想推进的任务。

可以从这些指令开始：

```text
帮我梳理这个项目，找出最值得优先改进的三件事。
@Gemini 为这个功能提出三种不同方向，再让 @Codex 收敛。
@Grok 实现这个需求，完成后交给 @OpenCode 审查。
```

## 本地优先

- 浏览器界面与 Node 服务都运行在本机，默认绑定 `127.0.0.1`
- Agent 通过本机子进程启动，继续使用各自 CLI 的认证与配置
- 会话、transcript 与 SQLite 记忆保存在本地
- 写入权限由会话级 worktree 开关控制，讨论模式保持只读

## 需要更多配置时

项目开箱即可启动；端口、代理、Codex 缓存目录、存储模式等高级选项见 [`.env.example`](.env.example)。

复制为 `.env`（或 `.env.local`）后，`npm start` 会自动加载，不必每次在 shell 里 export：

```bash
cp .env.example .env
# 编辑 .env，例如：
# INVOKE_CLI_PROXY=http://127.0.0.1:7892          # 所有 CLI 共用代理
# INVOKE_CODEX_HOME=C:\Users\you\.codex-cli       # 与 Codex 桌面版隔离
npm start
```

- 全员代理请用 `INVOKE_CLI_PROXY`（会注入到 Codex / OpenCode / Grok 等子进程）。`GROK_PROXY` 仅在「只有 Grok 需要代理」时使用。
- 已在 shell / CI 中设置的环境变量优先于文件中的同名项。

<details>
<summary><strong>常用开发命令</strong></summary>

| 命令                   | 用途                 |
| ---------------------- | -------------------- |
| `npm start`            | 启动本地控制台       |
| `npm test`             | 运行测试             |
| `npm run check`        | 检查 JavaScript 语法 |
| `npm run lint`         | 运行 ESLint          |
| `npm run format:check` | 检查代码格式         |

</details>

<details>
<summary><strong>技术轮廓</strong></summary>

```text
Browser UI ── HTTP / SSE ──► Node.js service ── spawn ──► Local Agent CLIs
                                  │
                                  ├── sessions / transcript / SQLite memory
                                  ├── skills / identities / handoff rules
                                  └── git worktree (optional)
```

前端为原生 HTML、CSS 与 JavaScript；服务端运行在 Node.js，使用 SSE 传递实时事件，并以 `better-sqlite3` 支撑本地记忆。

</details>

---

<div align="center">

**SHIFT** — 让 Agent 不只回答问题，也学会把工作交给下一位。

Private project · Version 0.1.0

</div>
