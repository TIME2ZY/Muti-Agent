# Multi-Agent Invoke UI（多 Agent 协作台）

基于本地 Node HTTP 服务的多 Agent 协作控制台：在浏览器里选择 Agent、发送任务、观察 SSE 流式输出，并通过 skills / worktree / A2A 回调组织跨 Agent 协作。

运行时通过子进程调用本机已安装的 **Codex** / **OpenCode** CLI（本仓库不打包这些 CLI）。

## 项目目标

- 提供统一 Web UI，编排多个角色化 Agent（规划、编码、前端、评审等）
- 用应用层 skills（`skills/*.md`）注入协作规则，与 CLI 原生 skill 隔离
- 支持会话持久化、transcript、worktree 隔离改代码、Agent 间 @ 提及接力
- 运行时保持轻量：静态前端 + 本地 SQLite 持久化基础层（`better-sqlite3`）
- 开发态使用 ESLint / Prettier / EditorConfig 与 GitHub Actions 保证质量

## 环境要求

| 项目    | 要求                                                                        |
| ------- | --------------------------------------------------------------------------- |
| Node.js | **>= 20**（见 `package.json` `engines` 与 `.nvmrc`）                        |
| 包管理  | 使用 `npm ci` 安装 SQLite 运行时依赖与开发工具                              |
| CLI     | 本机可执行 `codex`、`opencode`、`grok`（Grok Build CLI，按所用 Agent 安装） |
| 系统    | Windows / macOS / Linux；Windows 建议 PowerShell 7（`pwsh`）                |

```bash
# 若使用 nvm / nvm-windows / fnm
nvm use   # 读取 .nvmrc → 20
node -v   # 应 >= v20

# 开发工具（lint / format）
npm ci
```

可选环境变量模板见 **`.env.example`**（复制为 `.env` 后由 shell/进程管理器注入；应用本身不内置 dotenv）。

## 快速启动

```bash
# 克隆后进入仓库根目录
npm ci
npm start
# 等价于: node src/server/index.js
```

默认监听：

```text
http://127.0.0.1:8787
```

浏览器打开上述地址即可使用。服务绑定 `127.0.0.1`，供本机使用。

### 常用脚本

| 命令                   | 说明                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `npm start`            | 启动 Web UI 服务                                               |
| `npm test`             | 运行 Node 内置测试（`node --test`）                            |
| `npm run check`        | 对 `src` / `public` / `tests` 等 JS 做语法检查（自动发现文件） |
| `npm run lint`         | ESLint                                                         |
| `npm run format`       | Prettier 写回                                                  |
| `npm run format:check` | Prettier 仅检查                                                |

## 系统架构

```text
┌─────────────────────────────────────────────────────────────────┐
│  Browser (index.html + public/*.js)                             │
│  · 会话列表 / 消息流 / Agents 面板 / 工作区 / 回忆               │
│  · SSE 消费流式事件 · @Agent 提及 · UI Token 鉴权                │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTP + SSE
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Node Server (src/server/)                                      │
│  · 静态资源 + HTML token 注入                                   │
│  · session / chat / callback 路由                               │
│  · skills 加载与 prompt 增强 · 只读模式规则                     │
└───┬─────────────────┬───────────────────┬───────────────────────┘
    │                 │                   │
    ▼                 ▼                   ▼
┌─────────┐   ┌──────────────┐   ┌──────────────────────────────┐
│ Session │   │ Worktree     │   │ Agent invoke (src/agents/)    │
│ store / │   │ manager      │   │ · routing (@A2A)              │
│ map /   │   │ (git worktree│   │ · providers: codex / opencode │
│ transcript  │ 隔离改代码)  │   │ · callbacks (post-message…) │
└─────────┘   └──────────────┘   └──────────────┬───────────────┘
                                                 │ spawn CLI
                                                 ▼
                                    ┌────────────────────────┐
                                    │ codex / opencode (全局) │
                                    └────────────────────────┘
```

### 目录速览

| 路径            | 职责                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| `src/server/`   | HTTP 服务、路由、UI 安全、会话与调用存储、`skills.js` 技能系统              |
| `src/agents/`   | CLI 调用、Agent 定义、身份包（`identities/`）、A2A 路由、回调协议、provider |
| `src/session/`  | transcript、上下文健康、会话密封与 bootstrap                                |
| `src/storage/`  | SQLite schema、migration、事务与分代记忆 Repository 基础层                  |
| `src/worktree/` | 按会话创建/丢弃 git worktree                                                |
| `public/`       | 前端（IIFE + `window.*` 模块，无 bundler）                                  |
| `skills/`       | 应用层协作技能（Markdown + frontmatter）                                    |
| `tests/`        | Node 内置 test runner 用例                                                  |
| `data/runtime/` | 运行时状态（默认 gitignore）                                                |

## 六个 Agent 角色

定义见 `src/agents/invoke-cli.js` 中的 `AGENTS`：

| ID             | 界面标签 | Provider              | 默认模型        | 角色说明                                                 |
| -------------- | -------- | --------------------- | --------------- | -------------------------------------------------------- |
| `architect`    | Codex    | codex                 | gpt-5.5         | 默认主控，规划与编排                                     |
| `orchestrator` | 万事通   | opencode              | deepseek-v4-pro | 通才兜底、跨领域杂活                                     |
| `planner`      | 小谋     | opencode              | mimo-v2.5-pro   | 任务拆解、方案与决策                                     |
| `coder`        | 小码     | opencode              | minimax-m3      | 服务端与通用实现/重构                                    |
| `grok`         | Grok     | grok (Grok Build CLI) | grok-4.5        | 高难度编码与硬推理（本地 CLI + `reasoning-effort high`） |
| `frontend`     | 小视     | opencode              | glm-5.2         | UI、样式、交互与 a11y                                    |
| `critic`       | 小评     | opencode              | qwen3.7-plus    | 代码评审与质量把关                                       |

> **Grok 接入（与 Codex/OpenCode 同模式）**：安装 [Grok Build CLI](https://x.ai/cli)，`grok login` 或设置 `XAI_API_KEY`。服务端 spawn：`grok -p ... --output-format streaming-json -m grok-4.5 --reasoning-effort high --always-approve`。  
> **代理（仅 Grok）**：若直连 `api.x.ai` 超时，启动前设 `GROK_PROXY=http://127.0.0.1:7892`（只注入 Grok 子进程，不影响 OpenCode/Codex）。

使用方式：

- 右侧 **Agents** 面板切换默认 Agent
- 输入框 `@标签` 或 `@id` 可单次覆盖
- Agent 输出行首 `@其他Agent` 可触发 A2A 接力（深度由 `MAX_A2A_DEPTH` 限制）

## 工作区与只读模式

- 勾选 **改代码**（worktree）：在隔离 worktree 中允许写文件
- 未勾选：服务端向 prompt 注入只读规则，禁止写/改文件与有副作用的 bash

## 环境变量

未设置时使用合理默认值。密钥类勿提交仓库（`.env` 已在 `.gitignore`）。

### 服务与 UI

| 变量                      | 默认                         | 说明                                                                |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| `PORT`                    | `8787`                       | HTTP 监听端口                                                       |
| `CAT_CAFE_UI_TOKEN`       | 进程启动时随机               | UI 请求头 `X-Cat-Cafe-UI-Token`；不设则每次启动新 token 并注入 HTML |
| `CAT_CAFE_API_URL`        | 由请求 host 推导             | 写入 Agent 环境，供回调 curl 示例使用                               |
| `CAT_CAFE_TOKEN_TTL_MS`   | 内置默认                     | 回调 token 有效期（毫秒）                                           |
| `CAT_CAFE_TRANSCRIPT_DIR` | `data/runtime/transcripts`   | transcript 根目录                                                   |
| `CAT_CAFE_TEST_CAPACITY`  | （测试用）                   | 覆盖上下文容量相关测试参数                                          |
| `CAT_CAFE_PREVIEW`        | 未设                         | 预览子进程标记；设为时影响 preview 启动逻辑                         |
| `CAT_CAFE_STORAGE_MODE`   | `dual`                       | `dual` 同步镜像到 SQLite；`files` 仅使用原文件存储                  |
| `CAT_CAFE_MEMORY_DB`      | `data/runtime/memory.sqlite` | SQLite 记忆数据库路径                                               |
| `MAX_A2A_DEPTH`           | `15`                         | Agent 间 @ 接力最大深度                                             |

### 调用 CLI 时由服务注入（一般无需手设）

| 变量                      | 说明                   |
| ------------------------- | ---------------------- |
| `CAT_CAFE_THREAD_ID`      | 当前会话 ID            |
| `CAT_CAFE_INVOCATION_ID`  | 本次调用 ID            |
| `CAT_CAFE_CALLBACK_TOKEN` | 回调鉴权 token         |
| `CAT_CAFE_WORKTREE`       | `1` 表示在 worktree 中 |
| `CAT_CAFE_BASE_DIR`       | 项目基目录             |
| `CAT_CAFE_WORKTREE_DIR`   | worktree 路径          |
| `CAT_CAFE_BRANCH`         | worktree 分支名        |
| `INVOKE_SESSION_ID`       | CLI 侧 resume session  |
| `INVOKE_SESSION_FILE`     | session map 文件路径   |
| `INVOKE_WORKSPACE_KEY`    | workspace 键           |

### CLI 可选

| 变量                   | 默认                                    | 说明                                                                         |
| ---------------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| `INVOKE_CLI_PROXY`     | 空（可回退 `HTTPS_PROXY`/`HTTP_PROXY`） | 共享代理，注入所有 CLI 子进程                                                |
| `GROK_PROXY`           | 空                                      | **仅 Grok** 子进程代理（推荐）；别名 `INVOKE_GROK_PROXY` / `GROK_HTTP_PROXY` |
| `INVOKE_RAW_EVENT_LOG` | 关闭                                    | `1`/`true`/`yes`/`on` 时写原始事件日志                                       |

## 开发提示

- 前端：`index.html` 只引入 `public/boot.js`；应用模块顺序集中在 `public/boot.js` 的 `MODULES`（dual-export IIFE：`window.*` + `module.exports`，兼容 `require` 单测）
- 状态：`EventBus` + `UiStore`（`ui:change`）与 `SessionRuntime`（`runtime:status`）做轻量 pub/sub；DOM 仍为派生视图
- 文案：前端 JS 字符串集中在 `public/locale-zh-CN.js`；`index.html` 壳层文案暂保留中文硬编码
- 消息流：过程卡纯函数在 `public/message-process-helpers.js`，`message-view.js` 负责 DOM 组合
- 服务端入口：`src/server/index.js` 仅负责实例状态与依赖装配；HTTP 编解码、静态资源、CLI 参数、子进程流和 invocation registry 分别由同目录的独立模块负责
- 服务端状态：`activeInvocations` 与 invocation registry 必须是 server 实例级状态；不要在模块顶层新增请求相关的可变 Map/Set
- 存储过渡：默认 `dual` 模式仍从 JSON/JSONL 读取，同时把新 thread、message、window、invocation/event 镜像到 SQLite；镜像失败不得中断聊天
- Skill 系统：`src/server/skills.js`（frontmatter / 匹配 / prompt 增强 / 只读规则）
- Agent 身份：`src/agents/identities/*.md` + `src/agents/identity.js`；**每一轮** invoke（含 A2A）注入对应身份块
- A2A 交接：`src/agents/handoff.js` 解析 ` ```handoff ` 块；软约束（缺字段 degraded 仍路由），结构化注入下一位 Agent
- Grok provider：本地 `grok` CLI + `src/agents/providers/grok.js`（`streaming-json` → thinking/text）
- 模型目录：`src/agents/catalog.js` 分离 Agent 角色、执行 provider 与模型厂商；上下文容量等模型元数据以该目录为准
- Provider 契约：`src/agents/providers/index.js` 统一校验完整 adapter；每个 adapter 必须声明 `capabilities`、`allowedProviderOptions`，并实现 `buildInvocation` / `createRuntime`；可选 `resolveProxy` / `buildEnvironment` / `diagnostics`
- CLI 入口：`invoke-cli.js` 只做参数解析与装配；进程监督、session 持久化、raw event log 分别在 `process-supervisor.js` / `session-persistence.js` / `raw-event-logger.js`
- 重试：invocation lifecycle 由 supervisor 跨 attempt 持有；decoder/runtime 状态每次 attempt 重建，保证单次调用只有一个 `run.started` / 终态
- 共享基础层：`src/shared/runtime-paths.js`、`session-map.js`、`frontmatter.js`（agents 与 server 共用；避免 agents → server 反向依赖）
- 运行参数：超时、重试、代理等公共参数由 `src/agents/run-options.js` 归一化；CLI 特有开关放进 `providerOptions` 并由对应 adapter 解释/校验
- 事件协议：`event-protocol.js` 带 `protocolVersion`、字段类型校验；runtime 信封保证 started→content→唯一终态，终态后丢弃迟到事件
- 能力降级：`/api/agents` 下发 `capabilities`；前端按 thinking/tools/subagents 隐藏不支持的过程 UI（不写死 provider 名）
- Provider 会话：resume 记录包含 `providerId:modelId` 指纹，切换厂商或模型时不得复用不兼容 session
- 完整 ES modules / Vite 尚未接入；新增前端文件时请追加到 `MODULES` 并保证依赖顺序
- 新增 `src` / `public` / `tests` 下的 `.js` 后，直接 `npm run check` / `npm run lint` 即可
- 应用层 skills 放在 `skills/*.md`，由服务端按 trigger 匹配并注入 prompt
- CI：`.github/workflows/test.yml` 在 Node 20/22 上跑 `check` + `lint` + `test`

## License

Private（`package.json` `"private": true`）。
