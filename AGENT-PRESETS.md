# 预设各 Agent 工作内容指南

> 适用版本：agent-bridge 0.2.0
> 相关文件：`BRIDGE-RULES.md`（精简模板）、`README.md`（安装与配置）、`AGENTS.md`（你要在项目里新建的文件）
> 结论先说：**一次性分工在对话框里说；想让每次都一样，就写项目根目录的 `AGENTS.md`；只跟自己这台机器有关的通用纪律，才放进 `bridge.config.json` 的 `routing.rules`。**

---

## 0. 先理解一件事：规范要"说给谁听"

很多人把规范写在一个地方，却发现"有时生效、有时不生效"，根因是**这四层的作用对象完全不同**：

```text
① 总调度层（决定"怎么分工"）
   ├─ AGENTS.md          → 由 Codex 宿主读取，作用于"某个项目目录下的会话"
   └─ routing.rules      → 由桥接服务读取，作用于"本机所有项目的会话"
                ↓ 总调度据此决定：调原生工具 还是 submit_task，role/acceptance 怎么写
② 任务层（这一次到底交代了什么）
   └─ 对话框里那几句话 → submit_task 的 role / objective / acceptance / context
                ↓ 桥接冻结成不可变快照
③ 数据层（外部 Agent 实际能读到什么）
   └─ 项目上下文 summary + 材料 + 已确认记忆（confirmed）
                ↓ 随任务包下发
④ 代码层（所有外部 Agent 共用的系统提示与默认值）
   └─ src/engine.ts 的 researchInstructions、src/schema.ts 的 acceptance 默认值
```

**关键事实（容易踩坑）**：

- `AGENTS.md` 和 `routing.rules` **都只影响总调度（GPT）**，**不会**被外部模型子代理读到——桥接进程根本看不到 `AGENTS.md`。
- 外部 Agent 拿到的是：固定的一份 `researchInstructions` + 任务包（`role`/`objective`/`acceptance`/`task_context`/项目摘要/已确认记忆/材料元信息/前序结果）+ 三个工具（`read_context`、`read_material`、`propose_memory`）。
- 所以：**"总调度该怎么分工"写 AGENTS.md；"子代理必须遵守什么"要写进项目上下文或验收标准。**

---

## 1. 第一层：会话内直接指定（最灵活，零配置）

你完全可以在对话框里直接安排角色——这正是这个工具的设计意图。你给的例子已经很好，下面是可直接复制、稍加结构化的版本。

### 模板 A｜双 Agent：推导 + 独立审查（数学证明类）

```text
本次安排两名子 Agent，请严格按下述角色与验收标准执行：

【Agent 1 · GPT 原生】角色：推导
- 目标：给出完整证明，逐步注明使用的假设、定义与定理。
- 结尾必须列出：你认为最薄弱的 1 个环节，以及它成立所需的条件。

【Agent 2 · DeepSeek 外部】角色：独立审查
- 先不要看 Agent 1 的结论，自行独立推导一遍。
- 再逐行核对 Agent 1 的证明：逻辑漏洞、隐含假设、边界条件（如 n=0 / n=1、归纳基与归纳步）、可能的反例。
- 只使用 read_context / read_material 拿到的材料；材料未覆盖的引用必须标注"未核验"。

【共同要求】
- project_id：<你的稳定项目 ID>
- 两者共享同一题目与已确认的项目记忆，不要依赖本聊天里的其他上下文。
- 外部任务 idempotency_key：<项目>-<日期>-01
- 提交后必须 wait_task 到终态，再 get_artifact 读完整产物；排队成功不算完成。

【最后的汇总由你（总调度）完成】
- 明确给出：两者结论是否一致、分歧点在哪、你的裁定与理由。
- 指出哪些步骤仍需人工核验，不要把未经核验的内容写进项目记忆。
```

### 模板 B｜三 Agent：推导 + 反证 + 来源核验

```text
本次安排三名子 Agent，最多两个同时活跃，第三个排在后面：

【Agent 1 · GPT 原生】角色：推导 —— 给出完整证明与假设清单。
【Agent 2 · DeepSeek】角色：反例搜索 —— 只做一件事：尽力构造反例或说明为什么构造不出来；不要重复 Agent 1 的推导。
【Agent 3 · DeepSeek（依赖 Agent 1）】角色：来源核验 —— 用 depends_on 等 Agent 1 完成后启动，核对证明中每一步引用的定理名称与条件是否与材料一致。

要求：Agent 2 的目标是"证伪"，Agent 3 的目标是"溯源"，三者结论冲突时不要自行调和，把冲突原样报给我。
外部任务 idempotency_key 依次用 <项目>-<日期>-01 / -02 / -03。
```

### 模板 C｜同模型多实例交叉审查（不新建侧边栏聊天）

```text
使用 research_bridge 创建两个不同 ID 的 DeepSeek 子代理，profile 都用 deepseek：
- Agent 1：用归纳法证明前 n 个奇数之和为 n²。
- Agent 2：用求和公式独立证明同一命题。
两者不得互相参考；完成后你把两种证明并列汇总，并指出哪一种更适合作为教学材料、为什么。
不要新建 Codex 侧边栏聊天。
```

### 模板 D｜论文：起草 + 来源核验

```text
以 <project_id> 为项目，安排两名子 Agent：
【Agent 1 · DeepSeek】角色：论文起草 —— 按材料中的提纲写 <章节>，引用只能来自材料里的 source 字段。
【Agent 2 · GPT 原生】角色：来源核验 —— 逐条核对 Agent 1 的引用，把无法在材料中定位的引用标为"未核验"并列出清单。

验收标准：每个引用都必须能对应到具体材料 ID；没有对应来源的语句不得写成已确认结论。
最后你汇总：可发表部分 / 待补证据部分 / 建议删除部分。
```

### 你的话 → 工具调用：对照表

理解这张表，你就能预判"说了这句话之后会发生什么"：

| 你在对话框里说 | 实际发生的事 |
|---|---|
| "本次安排两名子 Agent" | 总调度不调用工具，它只是把任务拆成两次委派 |
| "GPT 负责推导" | 总调度调用 **Codex 原生协作工具**创建 GPT 子代理，**不经过桥接** |
| "DeepSeek 负责独立审查" | 总调度调用 `submit_task({profile:"deepseek", role:"独立审查", objective:"…", acceptance:"…", idempotency_key:"…"})` |
| "两者共享题目与已确认的项目记忆" | 同一个 `project_id`；材料经 `set_project_context` 进入项目上下文；**只有 `confirmed` 记忆**会自动进入任务快照 |
| "第三个等第一个完成" | `submit_task({depends_on:["<task_id>"]})`；前置失败时后续任务变 `blocked` |
| "总调度最后汇总结论和分歧" | 总调度 `wait_task` 到终态 → `get_artifact` 读全文 → 自行比较与汇总（这一步是模型行为，不是工具功能） |

> ⚠️ `role` 是**自由文本标签**，不是开关：它不会切换提示词，只用于展示和任务包标识。**真正决定子代理行为的是 `objective` 和 `acceptance` 的写法**——这也是为什么下面的 AGENTS.md 要把重点放在"总调度该怎么写这两项"。

### 一次会话的推荐顺序

1. `get_bridge_info` → 读版本、调度规则、可用 profile、并发上限
2. `get_project_context` + `read_project_memory(status:"confirmed")` → 拿到上下文版本与既有结论
3. `set_project_context`（如需要）→ 用 `expected_revision` 更新题目与材料（新增材料前先读版本）
4. `submit_task` × N → 记下 task_id 与幂等键
5. `wait_task` → 到终态（开启进度展示时传 `after_event_id`）
6. `get_artifact` → **读全文**再判断，不要只看摘要
7. `propose_memory_update` → 只把经核验的结论提议为记忆

---

## 2. 第二层：AGENTS.md（项目级常驻规范 —— 推荐做法）

**如果你的诉求是"每次都遵循同样规范"，这就是正确答案。** 把它放在**项目根目录**（通常是 Git 仓库根），随项目一起提交、随项目一起分发给协作者。

### 2.1 Codex 如何发现 AGENTS.md（官方规则）

Codex 在开始任何工作前构建一条"指令链"（每次运行重建，TUI 中通常是每个会话一次）：

| 顺序 | 位置 | 规则 |
|---|---|---|
| 1 | **全局作用域**：你的 Codex home（默认 `~/.codex`，可用 `CODEX_HOME` 改变） | 存在 `AGENTS.override.md` 就用它，否则用 `AGENTS.md`；这一层**只取第一个非空文件** |
| 2 | **项目作用域**：从项目根（通常是 Git root）**向下走到当前工作目录** | 每个目录依次查 `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames` 里的备用名；**每个目录最多取一个文件** |
| 3 | **合并顺序** | 从根向下拼接、空行分隔；**越靠近当前目录的内容越靠后，因此覆盖前面的** |
| 4 | 限制 | 跳过空文件；合并后达到 `project_doc_max_bytes`（默认 **32 KiB**）就停止加载 |

实用推论：

- 你可以在 `~/.codex/AGENTS.md` 放**跨项目通用条款**，在项目根 `AGENTS.md` 放**项目专用条款**，二者会自动叠加。
- 可以在子目录放 `AGENTS.override.md` 做更细的覆盖（例如 `papers/AGENTS.override.md` 只约束论文目录）。
- **改完要在目标目录重启 Codex**（每个会话重新构建指令链，没有缓存可清）。
- 如果写了一堆却像没生效：大概率放错了目录、文件是空的、或超出了 32 KiB 被截断。

> 官方文档：[developers.openai.com/codex/guides/agents-md](https://developers.openai.com/codex/guides/agents-md)。不同版本行为可能有差异，以你所用版本为准。

### 2.2 项目根 `AGENTS.md` 模板（可直接改用）

`BRIDGE-RULES.md` 是精简版；如果你想把分工规范写得更完整，用下面这份（把 `<...>` 换成你的内容）：

```markdown
# AGENTS.md

## 本项目基本信息
- project_id：`<稳定唯一，例如 odd-sum-proof>`
- 项目性质：<数学证明 / 论文写作 / 代码方案>
- 材料来源：<论文全文、题面、数据，统一由 set_project_context 的 materials 提供>

## 混合子代理分工规范（本项目的默认流程）
- 开始实质工作前先读取 research_bridge 的 get_bridge_info，遵守其中 routing 规则。
- GPT 子代理使用 Codex 原生协作工具，沿用当前登录；外部模型使用 research_bridge.submit_task。
- 不要新建侧边栏聊天代替子代理。
- 复杂任务默认安排"独立推导 + 独立审查"两个角色；简单任务直接完成，不要为凑流程而拆任务。
- 原生 GPT 与外部模型合计最多 2 个活跃子任务；桥接服务只能限制自己管理的任务，总数由你计算。

## 本项目固定角色（role 只写职责，不要写模型名）
| 角色名 | 建议后端 | 职责 | 验收标准要点 |
|---|---|---|---|
| 推导 | GPT 原生 | 完整证明与推导 | 每步注明假设；结尾列出最薄弱环节 |
| 独立审查 | DeepSeek | 先独立推导再核对 | 逻辑漏洞、隐含假设、边界条件、反例；未核验引用必须标注 |
| 反例搜索 | DeepSeek | 只尝试证伪 | 给出反例，或说明为什么构造不出来 |
| 来源核验 | DeepSeek | 逐条溯源 | 每个引用对应到具体材料 ID，否则标"未核验" |
| 论文起草 | DeepSeek | 按提纲成文 | 引用只能来自材料 source 字段 |

## 提交流程（每次都要走完）
1. 读项目上下文与已确认记忆，再按版本更新必要材料；不要混用其他 project_id。
2. 外部任务写清目标、材料、约束与验收标准；role 只用上表里的名称。
3. idempotency_key 规则：`<项目>-<YYYYMMDD>-<序号>-<角色>`；响应丢失时复用原键，故意重做要换新键。
4. 提交后必须 wait_task 到终态并 get_artifact 读全文；**排队成功不等于完成**。
5. 记忆先 propose，核对来源后再 review；不确定的结论保留为待验证。

## 交付格式
结论 / 推导或论据 / 假设 / 未验证步骤 / 引用来源 / 建议复核项。
没有检索来源时，不得把生成的引用写成已核实的文献。

## 汇报规范
- 进度展示默认关闭；只有我明确说"开启外部 Agent 进度展示"时才调用 set_progress_visibility。
- 汇报时区分后端：外部 Agent 的进度只出现在会话里，不在原生子智能体面板中。
- 失败、超时、预算耗尽的真实原因要如实报告；部分产物必须标记。
```

### 2.3 与 `BRIDGE-RULES.md` 的关系

`BRIDGE-RULES.md` 是本项目提供的**最小可用规则集**，设计意图就是"合并进 `AGENTS.md`"：

- 不要直接覆盖你项目原有的 `AGENTS.md`，把它的条目**并入**即可；
- 合并时必须把里面的 `my-research-project` 改成你项目的稳定 `project_id`；
- 项目已经有自己的规则（代码风格、提交规范）时，二者放在同一文件的不同小节即可，互不冲突。

### 2.4 验证是否生效

在**项目根目录**启动 Codex 的一个新会话，然后问：

> 请复述你当前加载的项目指令中与子代理分工有关的条款，以及本项目的 project_id。

命令行验证（官方推荐做法，能直接看到加载了哪些指令文件）：

```bash
codex --ask-for-approval never "Summarize the current instructions."
codex --cd <子目录> --ask-for-approval never "Show which instruction files are active."
```

还可以直接观察行为：你说"这次只安排一个子代理直接完成"时，如果总调度仍坚持拆成两个角色，说明 AGENTS.md 已生效。若要看它到底加载了哪些文件，可用 `codex -c log_dir=./.codex-log` 启动并检查 `./.codex-log/codex-tui.log`。

---

## 3. 第三层：`routing.rules`（本机全局策略）

改 `<项目目录>/bridge.config.json`：

```json
{
  "routing": {
    "maxActiveChildren": 2,
    "rules": [
      "任何实质任务开始前先读 get_bridge_info，并遵守其中的 routing 规则。",
      "默认分配独立推导与独立审查两个角色；只有明确简单时才单代理完成。",
      "外部子代理的 role 只使用固定角色名：推导 / 独立审查 / 反例搜索 / 来源核验 / 论文起草。",
      "外部任务一律使用 idempotency_key=<项目>-<YYYYMMDD>-<序号>-<角色>，成功的键不得复用。",
      "提交后必须 wait_task 到终态并 get_artifact 读全文；排队成功不算完成。",
      "任何模型结论进入长期记忆前必须经 review_memory 审核；无来源的引用不得写成已确认文献。",
      "进度展示默认关闭，仅在我明确要求时开启。"
    ]
  }
}
```

机制与约束（来自源码，写错会直接启动失败）：

| 项 | 说明 |
|---|---|
| 存放位置 | `bridge.config.json`，默认与项目同目录；该文件已被 `.gitignore` 忽略 |
| 上限 | `rules` 最多 **30 条**，每条最多 **2000 字符**；`maxActiveChildren` 取值 1–16 |
| 同时生效的 | `maxActiveChildren` 与 `rules` 一起通过 `get_bridge_info.routing` 返回 |
| 如何送达总调度 | 桥接服务启动时把 `routingGuide + 你的 rules` 作为 MCP `instructions` 下发，同时 `get_bridge_info` 也会返回 |
| 配置校验 | 配置是严格模式，**多写一个未定义字段就会启动失败**（工具直接消失） |
| 生效时机 | 改完必须**完全退出并重开 Codex**（MCP 进程随连接重建） |
| 强制力 | 和 AGENTS.md 一样只是**文本建议**；桥接服务只硬性执行 `concurrency`（并发槽位）与 `maxQueued`（队列上限） |

> 注意区分：`routing.maxActiveChildren` 是"建议总调度把原生 + 外部一起算进来"，**不具强制力**；真正会拦住你的是 `concurrency`（默认 2）。两者不一致时，超出的外部任务会在队列里等待。

---

## 4. `AGENTS.md` 与 `routing.rules` 的区别（重点）

### 4.1 十项对比

| 维度 | `AGENTS.md` | `routing.rules` |
|---|---|---|
| **本质** | Codex 宿主的**项目指令文件** | 桥接服务的**运行配置项** |
| **谁读取** | Codex 自己（构建指令链时） | agent-bridge（MCP 进程启动时） |
| **怎么送达模型** | 直接进入宿主 prompt 的指令链 | 作为 MCP `instructions` 下发 + `get_bridge_info` 返回 |
| **作用范围** | **该项目目录树**（从项目根到当前目录逐级合并） | **本机所有项目**（凡使用同一 `dataDir` 的会话都生效） |
| **存放位置** | 项目根目录（随仓库） | `bridge.config.json`（已被 `.gitignore` 忽略） |
| **是否版本化／可共享** | ✅ 随 Git 提交，协作者自动继承 | ❌ 本机私有，队友拿不到 |
| **生效时机** | 目标目录下**新开会话** | **完全重启 Codex**（重建 MCP 连接） |
| **粒度能力** | 支持全局 + 项目根 + 子目录 `AGENTS.override.md` 逐级覆盖 | 只有一层平铺的字符串列表 |
| **容量限制** | 合并后受 `project_doc_max_bytes`（默认 32 KiB）限制 | 30 条 × 2000 字符，另有 `maxActiveChildren` |
| **强制力** | 无（模型自觉遵守） | 无（模型自觉遵守）；只有 `concurrency`/`maxQueued` 是硬约束 |

### 4.2 什么时候用哪个

**优先写 `AGENTS.md`**，如果这条规范：

- 只对**这一个项目**有意义（项目 ID、术语表、验收标准、引用规范、章节结构）
- 需要**跟着项目一起版本化**、让协作者或未来的自己都能继承
- 内容较长、需要分小节、需要按目录细分（例如论文目录与实验目录规则不同）
- 与项目的其他工程规范（构建、测试、提交信息）放在一起更自然

**才写 `routing.rules`**，如果这条规范：

- 与**具体项目无关**，是你在这台机器上做任何研究都想遵守的纪律（"先推导后审查""排队成功不算完成""记忆必须审核"）
- 涉及**本机资源与配额**的使用约定（并发上限、进度展示开关的默认值、模型偏好）
- 你希望**所有项目一次性生效**，不想每个仓库都抄一遍
- 属于"桥接服务本身的用法约定"（幂等键命名规则、必须读 `get_bridge_info`）

### 4.3 冲突与叠加

- 两者**会同时送入总调度**，不存在自动覆盖关系。若冲突，通常**项目级的 `AGENTS.md` 更贴近当前任务**、也更容易被模型采纳，但这不是硬保证。
- 实践写法：**`routing.rules` 定通用纪律，`AGENTS.md` 定项目细节**，并且不要让两者对同一件事给出不同要求。例如：

  | 事项 | 放哪 | 示例 |
  |---|---|---|
  | 幂等键命名规则 | `routing.rules`（全局纪律） | `idempotency_key=<项目>-<YYYYMMDD>-<序号>-<角色>` |
  | 本项目的具体角色清单与验收标准 | `AGENTS.md`（项目细节） | "本项目固定角色：推导 / 独立审查 / 反例搜索" |
  | 并发不超过 2 | `routing.rules` + `maxActiveChildren` | 本机配额，跨项目一致 |
  | 引用必须来自材料的 source 字段 | `AGENTS.md`（项目规范） | 该项目特有的来源要求 |

- **两边都写了重复内容**不会报错，但会**重复消耗 token**：`routing.rules` 每次连接都会随 `instructions` 下发，`AGENTS.md` 每次会话都会进指令链。保持精简。

### 4.4 一句话判断法

> 把规则写进 `AGENTS.md`，**换台电脑、换个仓库**它还在 → 说明它是项目规范；
> 把规则写进 `routing.rules`，**换个仓库它还生效、但队友看不到** → 说明它是你的本机纪律。

---

## 5. 第四层：让外部 Agent 真正读到规范（项目上下文与记忆）

前面两层只影响总调度。如果你要**外部子代理**每次都遵守某些内容（例如输出格式、术语、禁止编造引用），必须把它变成子代理能读到的数据：

- **项目摘要 `context.summary`**：项目目标、术语定义、已知结论、格式要求。子代理用 `read_context` 读取。
- **材料 `context.materials[]`**：题面、论文全文、数据。子代理用 `read_material` 按 ID 读取（任务包里只给元信息，正文要它主动读）。
- **已确认记忆**：`propose_memory_update` → `review_memory(decision:"confirmed")` 后，会自动进入每个新任务的快照。

示例（把"输出格式"写进项目摘要）：

```json
{
  "project_id": "odd-sum-proof",
  "expected_revision": 0,
  "context": {
    "summary": "项目：证明前 n 个奇数之和为 n²。\n术语：n 为正整数。\n输出要求：任何结论必须分为【结论】【推导】【假设】【未验证步骤】【引用来源】五节；没有来源的引用一律标注为未核验。\n已知结论：n=1 的边界已在 revision 3 核验通过。",
    "materials": [
      {
        "id": "problem",
        "title": "题面",
        "source": "用户输入 2026-10-16",
        "content": "证明前 n 个奇数之和为 n²，并检查 n=1 的边界。"
      }
    ]
  }
}
```

> ⚠️ 首次设置用 `expected_revision: 0`；之后先 `get_project_context` 读版本再更新，冲突时报 `REVISION_CONFLICT`。**新任务保存不可变快照**，所以改上下文不会影响已提交的任务——想要生效必须**提交新任务**。

---

## 6. 角色与模型解耦：命名规范

- **`role` 写职责，`profile` 写模型。** 不要把"DeepSeek"写进角色名——那样以后换模型就要改所有规则。
- 角色名保持**短、稳定、可数**，因为它会出现在进度卡上（如 `外部 Agent · 独立审查 · 24bd5860`）。
- 推荐角色名集合（可按项目裁剪）：

| 角色名 | 典型后端 | 一句话职责 |
|---|---|---|
| 推导 | GPT 原生 / deepseek | 给出完整推导与假设清单 |
| 独立审查 | deepseek | 先独立推导，再核对漏洞、边界与反例 |
| 反例搜索 | deepseek | 只做证伪尝试 |
| 来源核验 | deepseek | 逐条引用溯源，标注未核验 |
| 论文起草 | deepseek / 其他 profile | 按提纲成文，引用仅限材料 |
| 方案设计 / 方案反驳 | 交叉使用 | 一个提方案，一个专门挑毛病 |

同一个 profile 可以并发开多个 Agent；**要不要换模型，是"验收标准需要独立性"决定的，不是角色决定的**。

---

## 7. 进阶：把预设做成结构化"Agent 花名册"

当前版本的 `presets` 并不存在——`bridge.config.json` 是严格校验的，直接加一个 `presets` 字段会导致 MCP 启动失败（`Invalid config: ... Unrecognized key`）。

如果你希望预设**可版本化、可复用、不必每次在对话框里重写**，需要一处小改造（约 20 行）：

1. `src/config.ts` 增加 `presets` 字段（`role` / `objective` / `acceptance` / `context` / `profile` / 预算项）；
2. `src/schema.ts` 让 `submit_task` 接受 `preset`，提交时用它补默认值（显式字段优先）；
3. `get_bridge_info` 返回预设清单，并在 `routing.rules` 里写明"优先使用已注册预设"。

之后配置文件本身就是花名册：

```json
"presets": {
  "prover":   { "role": "推导",     "objective": "用归纳法证明前 n 个奇数之和为 n²，检查 n=1 边界", "profile": "deepseek",      "acceptance": "完整步骤 + 假设清单 + 最薄弱环节" },
  "reviewer": { "role": "独立审查", "objective": "先独立推导，再逐行核对证明的逻辑与边界",           "profile": "deepseek_pro" },
  "sourcer":  { "role": "来源核验", "objective": "逐条核对引用是否可在材料中定位",                    "profile": "deepseek" }
}
```

调用方只需 `submit_task({project_id, preset:"reviewer", idempotency_key:"…"})`。

具体改动（约 20 行，需要改代码并重新构建）：

1. **`src/config.ts`**：在 `configSchema` 里增加与 `profiles` 平级的 `presets` 字段，值为 `role` / `objective` / `acceptance` / `context` / `profile` / 三个预算项组成的 `.strict()` 对象。
2. **`src/schema.ts` + `src/engine.ts`**：`submitInput` 增加 `preset`，并把 `role`、`objective` 改成可选（否则调用方仍必须传）；`engine.ts` 的 `submit()` 在 `parse` 之后用预设补默认值，**显式字段优先**，未注册的 preset 报 `UNKNOWN_PRESET`。
3. **`src/server.ts`**：`get_bridge_info` 返回值加上 `presets: [{name, role, profile}]`，并在 `routing.rules` 里写明"优先使用已注册预设"，让总调度知道有哪些可用。

改完照例 `npm run build` + **完全重启 Codex**。一个细节：幂等指纹基于**调用参数**计算，预设内容日后修改不会让同一把旧幂等键重新执行——这与"同一次提交意图只执行一次"的语义一致，属于预期行为。

---

## 8. 常见错误与排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 写了 `AGENTS.md` 但没生效 | 放错位置（必须在项目根／或用 `AGENTS.override.md` 覆盖了它）；文件为空；超过 32 KiB 被截断 | 在**项目根目录**新开一个会话；确认无 `AGENTS.override.md` 抢优先级；必要时提高 `project_doc_max_bytes` |
| 改了 `routing.rules` 没反应 | 未重启 Codex（MCP 进程仍是旧的） | 完全退出并重开 Codex，然后 `get_bridge_info` 确认 |
| 改完配置后工具全消失 | 配置是严格模式，多写了未定义字段 | 用 `node dist/cli.js doctor` 看报错，删掉多余字段 |
| 规则不生效 | `rules` 超过 30 条或单条超过 2000 字符 | 精简合并 |
| 总调度不按规则分工 | 这些规则**本身没有强制力** | 规则写得更具体（把"应该"换成明确的角色名、验收标准）；必要时在对话框里当场再强调一次 |
| 子代理不知道我的规范 | `AGENTS.md`/`routing.rules` 只影响总调度 | 把规范写进 `set_project_context` 的 `summary` 或材料，让子代理 `read_context` 读到 |
| 子代理说"没看到题目" | 材料正文不在任务包里，需要它主动 `read_material` | 确保材料已通过 `set_project_context` 存入，并在 `objective` 里写明材料 ID |
| 第三个 Agent 一直不跑 | `concurrency`（默认 2）才是硬上限，`maxActiveChildren` 只是建议 | 等前两个结束，或调大 `concurrency`（需换新 `dataDir`） |
| 记忆没进新任务 | 只有 `confirmed` 记忆进入快照 | 走 `review_memory(decision:"confirmed")` |
| 改了项目上下文但任务里还是旧内容 | 任务保存的是**不可变快照** | 改完后**重新提交**任务 |
| 队列里任务重复执行／重复计费 | 同一次提交用了不同的 `idempotency_key`，或改参数后复用旧键 | 响应丢失时复用**原键原参数**；故意重做才换新键 |
| 进度卡没有出现 | 展示开关默认关闭 | 说"开启外部 Agent 进度展示"，或调用 `set_progress_visibility({enabled:true})` |

---

## 9. 一页速查

| 我想…… | 去哪里改 | 生效方式 |
|---|---|---|
| 这一次这么分工 | 对话框里直接说（模板 A–D） | 立即 |
| 这个项目每次都这么分工 | 项目根 `AGENTS.md` | 该项目新开会话 |
| 只约束某个子目录（如论文目录） | `<子目录>/AGENTS.override.md` | 从该目录启动的新会话 |
| 我这台机器上所有项目都遵守的纪律 | `bridge.config.json` → `routing.rules` | 完全重启 Codex |
| 只想改原生 + 外部的建议并发数 | `routing.maxActiveChildren` | 完全重启 Codex |
| 真正限制同时运行的外部任务数 | `concurrency`（注意：改它要换新 `dataDir`） | 停旧服务后重启 |
| 让外部 Agent 遵守输出格式/术语 | `set_project_context` 的 `summary` / 材料 | 提交新任务后（快照） |
| 让结论跨会话沉淀 | `propose_memory_update` → `review_memory` | 确认后进入新任务快照 |
| 改变**所有**外部 Agent 的系统提示 | `src/engine.ts` 的 `researchInstructions` | 改后 `npm run build` + 重启 Codex |
| 改变默认验收标准 | `src/schema.ts` 的 `submitInput.acceptance` 默认值 | 同上 |
| 把预设做成可复用的花名册 | 增加 `config.presets`（见第 7 节） | 改代码 + 构建 + 重启 |

**三条底线**：

1. 规范写给谁，就放在谁读得到的地方（总调度 → AGENTS.md／routing.rules；子代理 → 项目上下文／验收标准）。
2. 任何一层都**不是硬约束**，真正的硬约束只有并发与队列；流程稳定性来自"规则写得具体 + 每步都验证"。
3. 改动 `AGENTS.md` 只需新开会话；改动 `bridge.config.json` 或任何 `src/*.ts` 都必须**重启 Codex**（后者还要先 `npm run build`）。
