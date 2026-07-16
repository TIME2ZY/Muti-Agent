# SHIFT AGENTS · 交班台

**本地多 Agent 协作控制台。**  
你发令排班，Agent 上工交班——在浏览器里点选角色、派任务、看实时流式输出，让 Codex / Gemini / Grok / OpenCode 在同一会话里接力完成讨论、实现与评审。

```bash
npm ci && npm start
# → http://127.0.0.1:8787
```

---

## 这是什么

SHIFT 不是又一个聊天壳，而是把本机已安装的 CLI Agent **编排进同一工作流**：

| 你想做的事 | SHIFT 怎么帮你 |
| ---------- | -------------- |
| 理清方案 | 让 Codex 推理、Gemini 发散，交叉验证 |
| 真正改代码 | 打开 **改代码**，在隔离 worktree 里让 Grok 落地 |
| 把关质量 | 把 diff 交给 OpenCode 做 Review |
| 多人接力 | 输入 `@Grok` 或让 Agent 输出行首 `@OpenCode` 自动交接 |
| 回头找上下文 | 会话持久化 + 回忆检索，跨轮不丢线 |

运行时通过子进程调用本机的 **Codex** / **Antigravity (`agy`)** / **Grok Build** / **OpenCode** CLI——本仓库不打包这些工具，只做编排与 UI。

---

## 功能亮点

- **统一控制台** — 会话列表、消息流、Agents 面板、工作区、回忆，一屏搞定  
- **SSE 实时输出** — 思考过程与回复流式呈现，像盯着同事在打字  
- **@ 提及与 A2A 接力** — 你指定谁上场，或让 Agent 主动把棒交给下一位  
- **Worktree 隔离改代码** — 勾选「改代码」在独立 git worktree 里写；未勾选则强制只读  
- **应用层 Skills** — `skills/*.md` 注入协作规则（交接、评审门禁等），与 CLI 原生 skill 隔离  
- **本地优先** — 静态前端 + 本机 Node 服务 + SQLite 记忆；绑定 `127.0.0.1`，数据留在你的机器上  

---

## 班组成员

| Agent | 擅长 | 底层 CLI |
| ----- | ---- | -------- |
| **Codex** | 推理与讨论，澄清问题、权衡方案 | `codex` |
| **Gemini** | 想法与头脑风暴，发散后再收敛 | `agy`（Antigravity） |
| **Grok** | 写代码、实现功能、跑测试 | `grok`（Grok Build） |
| **OpenCode** | 代码 Review，挑风险与改进点 | `opencode` |

**怎么用：** 右侧 Agents 面板切换默认角色；输入框 `@Codex` / `@Gemini` / `@Grok` / `@OpenCode` 可单次覆盖；Agent 也可在输出行首 `@其他Agent` 触发自动接力。

---

## 典型用法

1. **梳理项目** — 默认 Codex：「帮我梳理当前项目结构，并给出优先改进点。」  
2. **并行分工** — 让 Codex 拆任务，再 `@Grok` 实现、`@OpenCode` 评审。  
3. **安全改代码** — 勾选「改代码」→ Grok 在 worktree 中修改 → 工作区面板查看 diff → 满意再合并。  
4. **只读讨论** — 不勾选改代码时，服务端注入只读规则，适合方案探讨与审查。  

---

## 快速开始

### 环境

| 项目 | 要求 |
| ---- | ---- |
| Node.js | **≥ 20**（可用 `nvm use` 读取 `.nvmrc`） |
| 包管理 | `npm ci` |
| 系统 | Windows / macOS / Linux（Windows 建议 PowerShell 7） |
| CLI | 按需安装并登录：`codex` · `agy` · `grok` · `opencode` |

### 启动

```bash
git clone <repo-url> && cd Muti-Agent   # 或你的本地路径
npm ci
npm start
```

浏览器打开 **http://127.0.0.1:8787**。

可选：复制 `.env.example` 为 `.env`，用 shell / 进程管理器注入环境变量（应用本身不内置 dotenv）。常用项如 `PORT`、`GROK_PROXY`、`XAI_API_KEY` 等说明见该文件。

### 脚本

| 命令 | 说明 |
| ---- | ---- |
| `npm start` | 启动控制台 |
| `npm test` | 运行测试 |
| `npm run check` / `lint` / `format` | 语法检查 · ESLint · Prettier |

---

## 工作原理（一句话）

```text
浏览器 UI  ──HTTP/SSE──►  Node 服务  ──spawn──►  本机 CLI Agents
                │                    │
                │                    ├─ skills / 身份 / 只读规则
                │                    ├─ 会话 · transcript · 记忆
                │                    └─ git worktree（可选）
                └─ @提及 / A2A 交接 在应用层完成编排
```

---

## License

Private（`package.json` 中 `"private": true`）。
