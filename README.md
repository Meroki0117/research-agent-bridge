# agent-bridge · Codex 研究 Agent 桥接

**让 Codex 里的 GPT 总调度同时指挥两类子代理：GPT 原生子代理走 Codex 原生协作能力，DeepSeek 等外部模型走本项目的本地 MCP 服务。**

角色与模型解耦——同一个模型可以开出多个互不相干的 Agent 实例；项目上下文、长期记忆、任务产物跨模型共享；任务支持等待、取消、超时、预算控制和审核。它**不改变 Codex 登录**，**不需要额外的 OpenAI API Key**，也不会把第三方任务伪装成原生 GPT 子代理。

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524-339933?logo=node.js&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-STDIO-6E56CF)
![SDK](https://img.shields.io/badge/%40modelcontextprotocol%2Fserver-2.3.1-blue)
![Tests](https://img.shields.io/badge/tests-30%20passing-brightgreen)
![Version](https://img.shields.io/badge/version-0.2.0-informational)

---

## 目录

- [为什么需要它](#为什么需要它)
- [功能特性](#功能特性)
- [工作原理](#工作原理)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [快速开始](#快速开始)
- [MCP 工具清单](#mcp-工具清单)
- [运行限制与安全边界](#运行限制与安全边界)
- [目录结构](#目录结构)
- [开发与测试](#开发与测试)
- [常见问题](#常见问题)
- [许可证](#许可证)

---

## 为什么需要它

Codex 的原生子代理能力很强，但只能使用当前登录对应的模型；而官方子代理配置说明指出 `model_provider` 不能覆盖父会话，原生协作消息又可能包含不透明的加密内容。想让 GPT 和第三方模型（DeepSeek 等）在**同一个会话里协作**，就必须引入一个显式的、可读的桥接层。

本项目不做"解密原生通信"这种事，而是换一条干净的路：

```text
用户 → Codex 中的 GPT 总调度
          ├─ Codex 原生协作工具 ──→ GPT 子代理（沿用当前登录，本项目不介入）
          └─ research_bridge MCP ─→ 本地任务队列（SQLite）──→ DeepSeek 等外部模型 API
                                        └── 项目上下文 / 任务记录 / 产物 / 记忆
```

总调度负责拆分任务、选择后端、检查结果、合并产物；桥接服务只负责**把第三方任务可靠地跑完并把状态和产物显式地交回去**。

---

## 功能特性

### 多 Agent 协同

- **多实例并发**：同一个模型档案可以并发运行多个独立 Agent，每个都有独立的 ID、角色、阶段、耗时与产物；Agent 数量由提交次数决定，不需要为每个 Agent 配置一个供应商。
- **动态角色分工**：角色在 `submit_task.role` 中按任务指定，模型与角色完全解耦（推导 / 独立审查 / 论文起草 / 来源核验）。
- **混合调度说明**：服务通过 MCP `instructions` 内置一份总调度规则，并可叠加 `bridge.config.json` 里的自定义 `routing.rules`。

### 共享上下文与记忆

- **项目上下文**：按 `project_id` 分区，带版本号做乐观并发控制；材料（Markdown/LaTeX 文本）显式传入后由所有子代理共享读取。
- **不可变快照**：任务提交时冻结上下文与已确认记忆，之后修改项目上下文**不会**悄悄改变已提交的任务。
- **记忆需审核**：子代理只能 `propose_memory`（提议），只有总调度调用 `review_memory` 确认后的记忆才会进入新任务快照；模型生成的结论不会自动变成事实。

### 可靠的任务生命周期

- **异步任务**：`submit_task` 立即返回任务 ID；`get_task` / `wait_task`（最长 25 秒）/ `list_tasks` 查询进度。
- **幂等提交**：`idempotency_key` + 请求指纹，工具响应丢失时用相同参数重试不会重复创建或重复付费。
- **取消 / 超时 / 预算**：可取消排队或执行中的任务；默认单任务 180 秒、最多 6 次 API 请求（含重试）、累计输出上限 12000 tokens、单次最多 4096 tokens。
- **有限重试**：只对 HTTP 429/503 做最多两次重试；网络中断不自动重放（可能已计费）。
- **崩溃恢复**：任务带租约与心跳，超过 60 秒无心跳标记为 `interrupted`；已发出的请求不重放，排队任务继续。
- **产物分页读取**：`get_artifact` 分块读取完整或显式标记的部分产物，`get_task_events` 提供游标分页的完整时间线。
- **失败如实上报**：`failed` / `timed_out` / `budget_exceeded` / `interrupted` / `blocked` / `cancelled` 都不是完成，截断正文保留为部分产物并明确标记。

### 会话内进度展示（0.2.0）

默认**关闭**。开启后任务工具会返回 `display_markdown`，由总调度在会话里播报每个 Agent 的角色、模型、短 ID、阶段、工具与耗时。开关持久化在桥接数据库中，同一数据目录的所有会话共用。

```markdown
**外部 Agent · 独立审查 · 24bd5860**

模型：deepseek / deepseek-flash ｜ 阶段：已完成 · 待总调度审查

耗时：0.6 秒（排队 0.3 秒，执行 0.4 秒）｜ 请求：2/3

工具：读取材料

最近进度：0.5 秒 工具完成：读取材料 → 0.6 秒 已收到模型响应 → 0.6 秒 已完成 · 待总调度审查
```

> 上例取自 `evidence/visibility-smoke.json`（两个真实 MCP 进程 + 模拟模型的离线联调，未产生 API 费用）。

### 安全边界

- 外部 Agent 只有三个工具：`read_context`、`read_material`、`propose_memory`——**没有 shell、没有任意文件读取、没有浏览器**。
- 供应商端点强制 HTTPS、不跟随重定向；`provider: "deepseek"` 只允许 DeepSeek 官方地址。
- API Key 只从环境变量读取，不写入配置与数据库；输入侧出现密钥直接拒绝，输出侧做密钥脱敏；不回显上游原始错误正文。
- 本地 SQLite 不加密，依赖系统账户与磁盘保护；`project_id` 是单用户下的逻辑分区，**不是**多用户权限边界。

---

## 工作原理

```text
┌──────────────────────────── Codex 会话 ────────────────────────────┐
│  GPT 总调度                                                        │
│    ├── 原生协作工具 ──────────→ GPT 子代理（沿用当前登录）          │
│    └── MCP: research_bridge ──┐                                    │
└───────────────────────────────┼────────────────────────────────────┘
                                │ STDIO (JSON-RPC)
                    ┌───────────▼───────────┐
                    │  agent-bridge 服务    │
                    │  · 任务状态机/工具循环 │
                    │  · SQLite 队列与并发   │
                    │  · 上下文/记忆/产物    │
                    └───────────┬───────────┘
                                │ HTTPS (Responses / SSE)
                    ┌───────────▼───────────┐
                    │  DeepSeek 官方 API 等 │
                    └───────────────────────┘
```

外部 Agent 的执行是一个**带工具循环的对话**：任务包 → 模型请求 → 工具调用（读取上下文/材料、提议记忆）→ 回填结果 → 再次请求，直到产出最终正文或触达预算上限。

| 模块 | 职责 |
|---|---|
| `src/config.ts` | 配置校验、模型档案、端点白名单、调度规则 |
| `src/schema.ts` | 任务/上下文/记忆/工具输入类型与错误码 |
| `src/store.ts` | SQLite 持久化、原子领取、全局并发、租约心跳、幂等、事件表 |
| `src/provider.ts` | Responses HTTP/SSE 适配器与接口契约 |
| `src/engine.ts` | 任务状态机、工具循环、预算与取消、密钥脱敏 |
| `src/presentation.ts` | 进度阶段、耗时与确定性的可读进度卡 |
| `src/server.ts` | 16 个 MCP 工具与总调度说明 |
| `src/install.ts` | TOML 校验、保留原文的配置追加与备份 |
| `src/cli.ts` | `init` / `doctor` / `codex-config` / `install-codex` / `serve` |

---

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| **Node.js** | **24.0.0 或更高** | 依赖内建 `node:sqlite`；`package.json` 的 `engines` 与安装脚本都会强制校验 |
| **npm** | 随 Node 提供 | 用于安装依赖与构建 |
| **Codex** | 支持 MCP（`mcp_servers` 配置段）的桌面版或 CLI | 桥接服务以 STDIO MCP 方式接入 |
| **DeepSeek API Key** | 放在环境变量 `DEEPSEEK_API_KEY` | **不要**粘贴到聊天、配置文件或提交到 Git |
| 操作系统 | Windows 有一键安装脚本；macOS / Linux 按"手动安装"走 | 服务本身是跨平台的 Node 程序 |

检查环境：

```bash
node --version      # 需要 v24.x 或更高
npm --version
```

设置密钥（Windows，持久化后需重开终端）：

```powershell
setx DEEPSEEK_API_KEY "<你的 DeepSeek API Key>"
```

macOS / Linux：

```bash
export DEEPSEEK_API_KEY="<你的 DeepSeek API Key>"   # 建议写入 ~/.zshrc 或 ~/.bashrc
```

> 运行期只用环境变量读密钥；MCP 进程由 Codex 通过配置里的 `env_vars` 把变量转发进来。

---

## 安装

### 1. 获取源码

```bash
git clone https://github.com/<your-account>/agent-bridge.git
cd agent-bridge
```

也可以下载 Releases 里的源码压缩包后解压。

### 2. 安装依赖并构建

```bash
npm ci --ignore-scripts
npm run build
```

依赖版本已在 `package-lock.json` 中锁定；构建产物输出到 `dist/`。

### 3. 生成并检查配置

```bash
node dist/cli.js init                 # 生成 bridge.config.json（已存在则报错，不会覆盖）
node dist/cli.js doctor               # 检查配置、密钥、SQLite；不发起任何付费请求
```

`doctor` 会在任一模型档案缺少对应环境变量时返回退出码 1。

### 4. 接入 Codex

#### 方式一：一键安装（Windows，推荐）

```powershell
.\Install-Codex.ps1
```

脚本会依次：校验 Node ≥ 24 → 补装缺失依赖 → 必要时构建 → 必要时生成配置 → 运行 `doctor` → 把服务条目追加到 Codex 配置并备份原文件。可选参数 `-CodexConfigPath`、`-BridgeConfigPath`。

若执行策略拦截本地脚本，可只对本次放行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-Codex.ps1
```

#### 方式二：手动安装（跨平台）

```bash
node dist/cli.js codex-config         # 打印 Codex TOML 片段，不含任何密钥
```

Windows：

```powershell
node dist/cli.js codex-config >> "$env:CODEX_HOME\config.toml"   # 未设置 CODEX_HOME 时用 $env:USERPROFILE\.codex\config.toml
```

macOS / Linux：

```bash
node dist/cli.js codex-config >> ~/.codex/config.toml
```

生成的片段形如：

```toml
# BEGIN agent-bridge (generated; API keys stay in environment variables)
[mcp_servers.research_bridge]
command = "C:/Program Files/nodejs/node.exe"
args = ["<项目绝对路径>/dist/cli.js", "serve", "--config", "<项目绝对路径>/bridge.config.json"]
env_vars = ["DEEPSEEK_API_KEY"]
startup_timeout_sec = 20
tool_timeout_sec = 40
# END agent-bridge
```

- `command`：Node 可执行文件绝对路径。
- `args`：CLI 与**配置文件的绝对路径**，因此不依赖 Codex 的当前工作目录。
- `env_vars`：只列出需要转发的**变量名**，明文密钥永远不写进 TOML。

### 5. 重启并验证

**完全退出并重新打开 Codex，然后新建聊天。** 已经启动的桌面进程不会继承新设置的环境变量，也不会加载新的 MCP 工具。

在会话中发送：

> 请读取 research_bridge 的 get_bridge_info，确认版本为 0.2.0，并告诉我可用的模型档案和并发上限。

### 卸载

删除 Codex 配置中 `# BEGIN agent-bridge` 到 `# END agent-bridge` 的整个块后重启 Codex；也可以在该块内设置 `enabled = false` 暂时停用。`.data` 目录可保留任务历史。

---

## 配置

### `bridge.config.json`

`bridge.config.json` 是本机运行配置（已被 `.gitignore` 忽略），`bridge.config.example.json` 是示例。相对 `dataDir` 以配置文件所在目录为基准。配置是**严格校验**的：出现未知字段会直接启动失败，以免"改了却没生效"。

```json
{
  "version": 1,
  "dataDir": ".data",
  "concurrency": 2,
  "maxQueued": 100,
  "maxInputChars": 120000,
  "routing": {
    "maxActiveChildren": 2,
    "rules": [
      "数学任务先分配独立推导与审查角色，按任务选择 GPT 原生或 DeepSeek。",
      "写论文时区分起草与来源核验；没有来源的引用不得当作已验证文献。"
    ]
  },
  "profiles": {
    "deepseek": {
      "adapter": "responses",
      "provider": "deepseek",
      "endpoint": "https://api.deepseek.com/responses",
      "model": "deepseek-flash",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "reasoningEffort": "none",
      "maxOutputTokens": 4096
    }
  },
  "defaults": {
    "profile": "deepseek",
    "timeoutSeconds": 180,
    "maxRequests": 6,
    "outputTokenBudget": 12000
  }
}
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `dataDir` | `.data` | SQLite 与全部任务/记忆数据所在目录，相对配置文件解析 |
| `concurrency` | 2 | 同时运行的外部任务数（1–16）。**同一 dataDir 的所有进程必须一致** |
| `maxQueued` | 100 | 全局排队上限，超出报 `QUEUE_FULL` |
| `maxInputChars` | 120000 | 单次任务包/上下文的字符上限（不是精确 token 预算） |
| `routing.maxActiveChildren` | 2 | 写给总调度的建议值（原生 + 外部合计）；服务只能强制约束自己管理的任务 |
| `routing.rules` | `[]` | 最多 30 条、每条 ≤2000 字符，会注入 MCP instructions |
| `profiles.*.adapter` | — | 目前为 `responses` |
| `profiles.*.endpoint` | — | 必须 HTTPS，且不带账号密码、查询串或片段 |
| `profiles.*.apiKeyEnv` | — | 环境变量**名**，须匹配 `^[A-Z][A-Z0-9_]*$` |
| `defaults.timeoutSeconds` | 180 | 单任务墙钟超时（5–1800） |
| `defaults.maxRequests` | 6 | 单任务 API 请求上限（1–20），**包含重试** |
| `defaults.outputTokenBudget` | 12000 | 单任务累计输出 token 上限 |

### 新增第三方模型

后端目前实现通用的 **Responses 适配器**，并已实测 DeepSeek 官方 `https://api.deepseek.com/responses`。若某厂商提供 OpenAI 兼容的 `/responses` 接口，**只改配置即可**：

```json
"profiles": {
  "deepseek": { "adapter": "responses", "provider": "deepseek", "endpoint": "https://api.deepseek.com/responses", "model": "deepseek-flash", "apiKeyEnv": "DEEPSEEK_API_KEY", "reasoningEffort": "none", "maxOutputTokens": 4096 },
  "vendor_x": { "adapter": "responses", "provider": "vendor_x", "endpoint": "https://api.vendor-x.com/v1/responses", "model": "vendor-x-large", "apiKeyEnv": "VENDOR_X_API_KEY", "reasoningEffort": "low", "maxOutputTokens": 8192 }
}
```

注意：`provider` 不能写 `deepseek`（会被强制校验为官方端点）；`provider` 只是展示名，**真正的协议由 `adapter` 决定**。新增档案后需要重新生成 Codex 片段（`env_vars` 会自动收集所有档案的 `apiKeyEnv`）并**手动替换**配置里的整个 agent-bridge 块——安装器遇到"同名但设置不同"的服务会拒绝覆盖。

只有 Chat Completions 接口的厂商需要新增 `Provider` 实现：放宽 `adapter` 枚举、实现一个把 chat 消息与工具调用翻译成 Responses 条目形状的适配器，并保证返回 `usage`、对 HTTP 错误抛 `UpstreamError`（这样 429/503 的有限重试才会生效）。

> 未经实测的厂商不能视为已兼容。先用 `npm run smoke`（模拟端点，零费用）验证，再对真实端点做小任务测试。

### 预设各 Agent 的工作内容

| 想预设什么 | 改哪里 |
|---|---|
| 全局分工策略 | `bridge.config.json` → `routing.rules` |
| 某项目的常驻分工与项目 ID | 该项目的 `AGENTS.md`（把 `BRIDGE-RULES.md` 合并进去） |
| 项目背景 / 术语 / 标准 / 材料 | `set_project_context`（材料放 `context.materials[]`） |
| 长期结论与经验 | `propose_memory_update` → 总调度 `review_memory` 确认 |
| 单个 Agent 的任务内容 | `submit_task` 的 `role` / `objective` / `acceptance` / `context` |

把 `BRIDGE-RULES.md` 的内容合并到研究项目的 `AGENTS.md`，并把其中的示例项目 ID 换成稳定唯一的名称，常用项目就能按规则自动分工（**不要覆盖原有的项目规则**）。

### 进度展示开关

在会话里直接说「开启外部 Agent 进度展示。」/「关闭外部 Agent 进度展示。」/「查看外部 Agent 进度展示开关。」，对应 `set_progress_visibility({enabled})` 与 `get_progress_visibility({})`。开关持久化在数据库中，同一数据目录的所有会话共用；开启会增加 GPT 侧 token 消耗（本地事件记录与格式化本身不调用模型）。

---

## 快速开始

在重启后的 Codex 新聊天中，做一次完整的混合验收（一名原生 GPT 子代理 + 一名 DeepSeek 子代理）：

> 请读取 research_bridge 的 get_bridge_info。以 bridge-demo 为 project_id，把"证明前 n 个奇数之和为 n²，并检查 n=1 的边界"作为项目任务。一名 GPT 原生子代理负责独立推导，一名 DeepSeek 工具子代理负责审查证明和假设。总计最多两个活跃子任务。等待两者完成，读取 DeepSeek 产物，指出结论是否一致，并由你审查汇总；不要在提交任务后就宣布完成。

测试同模型多实例（不新建任何侧边栏聊天）：

> 使用 research_bridge 创建两个不同 ID 的 DeepSeek 子代理。一个用归纳法证明前 n 个奇数之和为 n²，另一个用求和公式独立证明。等待两个任务完成，汇总两种证明。不要新建 Codex 侧边栏聊天。

DeepSeek 任务通过 MCP 的状态和产物返回，**不会**出现在 Codex 原生 GPT 子代理列表里；原生 GPT 子代理是否可用取决于当前会话是否提供原生协作工具，本服务不能替宿主开启该能力。

---

## MCP 工具清单

| 工具 | 用途 |
|---|---|
| `get_bridge_info` | 模型档案、密钥是否存在、调度规则、并发上限、展示开关 |
| `set_project_context` / `get_project_context` | 按版本更新和读取项目上下文 |
| `get_material` | 分页读取显式提供的材料，供 GPT 子代理共享 |
| `submit_task` | 创建独立外部 Agent，立即返回任务 ID |
| `get_task` / `wait_task` / `list_tasks` | 查看状态、最多等待 25 秒、列出历史 |
| `set_progress_visibility` / `get_progress_visibility` | 持久化开启/关闭、查看进度展示 |
| `get_task_events` | 明确查看执行事件，支持游标分页 |
| `cancel_task` | 取消排队或执行中的任务 |
| `get_artifact` | 分页读取完整或明确标记的部分产物 |
| `read_project_memory` | 按项目读取记忆 |
| `propose_memory_update` / `review_memory` | 提议记忆并由总调度确认或拒绝 |

外部 Agent 侧只暴露 `read_context`、`read_material`、`propose_memory` 三个工具。

---

## 运行限制与安全边界

- **不提供任意代码执行**：外部 Agent 不能调用 shell、读取任意文件、浏览互联网，也不能解密原生 Agent 的加密通信。全文材料需由 GPT/用户显式传入；首版不直接解析 PDF/DOCX，不集成检索或符号计算。
- **并发约束**：默认最多两个第三方任务同时运行；`routing.maxActiveChildren` 只是给总调度的建议，服务无法强制限制 Codex 原生子代理。
- **容量固定**：同一数据目录中的进程必须使用相同 `concurrency`，该值记录在数据库中；要改容量需停止旧服务并使用新的 `dataDir`。
- **成本不可完全确定**：请求上限包含重试，输入按字符而非精确 token 计量；取消与超时能中止本地请求，但**不能保证上游立即停止或不计费**；`usage.complete: false` 表示费用统计可能不完整。
- **失败语义**：`failed`、`timed_out`、`budget_exceeded`、`interrupted`、`blocked`、`cancelled` 都不是完成；截断正文保留为部分产物并显式标记。
- **生命周期**：MCP 进程由 Codex 按连接启动，不是独立常驻服务；关闭全部 Codex 连接后不保证任务继续运行。
- **第三方结果是不可信证据**：模型生成内容不会自动成为事实；引用需核验，记忆需审核。

---

## 目录结构

```text
src/                     TypeScript 源码（9 个模块）
test/                    离线自动化测试（30 项，不需要真实密钥）
scripts/smoke.mjs        真实 MCP 客户端联调（模拟端点或真实 API）
evidence/                验证证据：真实 API 联调、桌面引擎调用、测试汇总
Install-Codex.ps1        Windows 一键安装脚本
bridge.config.example.json  运行配置示例
BRIDGE-RULES.md          可合并进项目 AGENTS.md 的调度规则模板
VALIDATION.md            验证范围与剩余边界
```

---

## 开发与测试

```bash
npm run build      # TypeScript 编译到 dist/
npm test           # 构建 + 30 项离线测试（不发任何付费请求）
npm run doctor     # 配置与本地数据库检查，不调用 API
npm run smoke      # 两个真实 MCP 进程 + 模拟模型，零费用联调
npm run smoke:live # 两个真实 MCP 进程 + DeepSeek 官方 API，会产生少量用量
```

真实烟雾测试只发送合成材料（每个任务最多 3 次请求、输出预算 768 tokens），不会发送你的论文或项目文件，结果保存在 `test-results/live-*/report.json`。

当前验证状态：`npm test` **30 项通过 / 0 失败**；两个独立 MCP 进程共享 SQLite 队列、工具发现、提交/等待/取消/超时、产物读取与记忆审核均已验证；Codex 桌面引擎在隔离 `CODEX_HOME` 中成功发现并调用全部 16 个工具。范围与尚未验证的部分见 [`VALIDATION.md`](VALIDATION.md)。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| `MISSING_API_KEY` | 确认 `doctor` 能读到密钥，然后**彻底重启 Codex**（终端有变量而旧桌面进程没有是两回事） |
| 看不到工具 | 确认安装到了实际 `CODEX_HOME` 对应的配置；检查 MCP 状态、Node 与脚本绝对路径；新建聊天 |
| `INPUT_TOO_LARGE` | 缩短任务与上下文，分批传入材料；历史任务与已确认记忆也占上下文 |
| `REVISION_CONFLICT` | 上下文或记忆已变更，读取新版本后重新判断，不要覆盖其他 Agent 的更新 |
| `UPSTREAM_HTTP_401` / `429` | 密钥无效或权限不足 / 限流或配额限制；服务不回显供应商原始错误正文 |
| `SERVER_EXISTS` | 目标已有同名服务且设置不同，安装器不会覆盖；请手动审查配置 |
| 改配置没生效 | `bridge.config.json` 改完需重启 Codex；改 `src/*.ts` 还需先 `npm run build` |

---

## 许可证

尚未指定。发布前请在仓库根目录补充 `LICENSE` 文件，并把本节的名称与年份替换为实际许可证（例如 MIT、Apache-2.0）。
