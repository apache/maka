# magpie 多模型协作 · 分线开发计划与执行提示词

> **状态（2026-11-07 校注）**：2026-10-13 方案/快照，之后无更新；是否重启未定。文内 `E:` 盘路径属 Windows 工作区（已于 10 月撤除）。第十一节开场提示词中的 `E:/cc/guahub/fork/magpie-hub/docs/` 已不存在（文档现位于 `fork/docs/hub/magpie/design/`）。

> 日期：2026-10-13 · 版本：v0.2 · 状态：计划草案。B/C 线未启动；A 线保留已有工作。
> 本轮只新增本文：未创建分支、未切换工作区、未修改代码、未执行运行验证。后续 Agent 每次只认领一条线。

## v0.2 相对 v0.1 的变更

| # | 变更 | 依据 |
| --- | --- | --- |
| 1 | 新增"决策 D1：主控由谁回答"，作为 B0 的前置条件 | 加密子任务只有 ChatGPT 账号能打开（`codexSubagentPick`、`sealedKept`） |
| 2 | B1 从"在 magpie 里实现角色配置"改为"使用 Codex 原生自定义 Agent，magpie 代码零改动" | Codex 官方支持 `.codex/agents/*.toml`，可设 `model`、`sandbox_mode` |
| 3 | 明确：magpie 统一子模型**确定覆盖**所有子 Agent 的模型选择，B 线要求其为空 | `CodexSubagentModel` 改写所有 `collab_spawn` 请求 |
| 4 | 验收证据改为"实际模型 + `kept` 为空 + 主控拿到结果" | 留在原模型时表面无报错，只记在路由记录 |
| 5 | 隔离写死为 `XDG_CONFIG_HOME`、`CODEX_HOME`、`MAGPIE_ADDR` 和非默认端口，B 线不启动 GUI | `appdir.Config`、`appdir/codex.go`、`settings.go`、GUI 单实例 |
| 6 | Pi 从 B2 候选中移出，只作为"同会话换模型"的后续参考 | Pi 核心不含子 Agent；虚拟模型属于同会话逐请求换模型 |
| 7 | C 线入口改为"A 完成 P1 且 B1 通过"，取消 GUI 写入接口 | magpie 不编辑用户自己的 Agent 文件（先例见 `agent-wiring.md`） |
| 8 | 补充成本对比口径，以及上游提交的测试要求 | 官方说明子 Agent 更耗 token；上游 `contributors.md` 对 ggbdpq 的检查要求 |

---

## 一、角色与目标

你是一名熟悉 Go、Wails、原生 JavaScript、LLM 网关与 Agent runtime 的工程师。先核实已有能力，优先复用，交付可验证、可回退的最小增量。

**目标**：在现有 magpie 网关上，支持"一个主控 + 多个分别绑定模型的子 Agent"。鹊桥接线台 UI 改版继续并行；协作能力不以 UI 合入 main 为前提，新界面的接入由集成线负责。

本计划区分三件事，第一期只做第一种：

| 类别 | 含义 | 第一期 |
| --- | --- | --- |
| ① 独立子 Agent 用不同模型 | 主控派出子 Agent，每个子 Agent 是独立线程，用自己的模型 | **做** |
| ② 同一会话按阶段换模型 | 一个会话里，规划用强模型、实现用便宜模型（Pi 虚拟模型、jev-router 属于此类） | 不做，留作后续 |
| ③ 跨客户端编排 | 一个客户端（如 Codex）调用另一个客户端（如 Pi、Claude Code） | 不做 |

术语约定：**客户端**指 Codex CLI / Codex 桌面版等程序；**主控模型**指主控那一轮由哪个模型回答；**子模型**指子 Agent 实际落到的模型。三者不得混用。

---

## 二、事实基线（2026-10-13 只读核查，开工前重新核对）

### 2.1 仓库与分支

- 主 clone `E:/cc/guahub/fork/magpie-hub/magpie`：`main`，HEAD `e1b70c13`，工作区干净。该提交与上游 `yetone/magpie` main 一致。
- UI checkout `E:/cc/guahub/fork/magpie-hub/magpie-ui`（已不存在，10-17 删除）：`ui/switchboard`，HEAD `848d2ea9`，是 `e1b70c13` 的祖先（落后 9 个提交，涉及 43 个文件，含 `internal/settings/settings.go`），有未提交修改和未跟踪测试，必须保留。
- `magpie-pr1` ~ `magpie-pr3`：pr2、pr3 有未提交改动，pr1 有近期提交，都不可默认占用。

### 2.2 已有能力（源码事实）

| 能力 | 位置 | 行为 |
| --- | --- | --- |
| 主控逐任务点名子模型 | Codex `spawn_agent` 的 `model` 参数 | 主控为每个子 Agent 指定模型 |
| 放宽可选模型列表 | `internal/gateway/codex_spawn_models.go` `spawnAgentModels` | Codex 原本只列前 5 个，magpie 放宽到整个目录（最多 200 个） |
| 没点名时的默认子模型 | Codex `[agents] default_subagent_model`；magpie 字段 `subagent` | 只是默认值，主控点名时被覆盖 |
| magpie 统一子模型 | `settings.CodexSubagentModel`；`internal/gateway/codex_subagent.go` `codexSubagentPick` | **改写所有子 Agent 请求，不管主控点了谁**（覆盖关系是确定的） |
| 加密任务边界 | `sealedTaskIn`、`sealedKept`；`docs/subsystems/gateway-routing.md` | 主控由 ChatGPT 后端回答（多 Agent V2）时，子任务被加密，只有 ChatGPT 账号能打开；否则子 Agent 留在原模型，或被拒绝 |
| 结果回传 | `withoutSealedMessages` | 打不开的加密消息被剔除，换成注明发送方的文字说明；子 Agent 的最终结果以文字回到主控 |
| 落点记录 | `internal/gateway/trace.go` `Route.Subagent`（`asked`/`to`/`kept`）；响应头 `X-Magpie-Provider`/`X-Magpie-Model`；用量用途 `collab_spawn`/`thread_spawn`/`agent_job` | 能区分"换成功"与"留在原模型" |
| 现有测试 | `codex_subagent_test.go`、`codex_subagent_chat_test.go`、`codex_spawn_models_test.go`、`sealed_*_test.go` | 覆盖上述规则 |

### 2.3 Codex 官方能力

来源：<https://developers.openai.com/codex/subagents>

- 自定义 Agent：`~/.codex/agents/` 或项目 `.codex/agents/` 下，每个 TOML 文件定义一个 Agent，必填 `name`、`description`、`developer_instructions`；可设 `model`、`model_reasoning_effort`、`sandbox_mode`、`mcp_servers`。
- 模型解析顺序：显式 spawn 值 → `[agents]` 默认 → 继承主控；Agent 文件里的 `model` 优先。
- 并发上限：`agents.max_concurrent_threads_per_session`。
- 官方提示：子 Agent 工作流比单 Agent 消耗更多 token。

### 2.4 有效优先级（从高到低）

1. magpie 统一子模型（网关改写，非空时其余全部失效）；
2. 自定义 Agent 文件里的 `model`；
3. 主控在 `spawn_agent` 里点名的模型；
4. `[agents] default_subagent_model`；
5. 继承主控模型。

第 1 条在 magpie 网关里，第 2~5 条在 Codex 客户端里。**待验证**：自定义 Agent 发出的请求同样带 `x-openai-subagent: collab_spawn`，因此同样会被第 1 条改写。

### 2.5 尚未读取、开工时核对

- hub 的 `docs/08-Windows工作区与沙盒规范.md`；
- UI checkout 的本地改动；
- 实际安装的 Codex 版本，以及它是否支持自定义 Agent。

---

## 三、实施前必须决策

### D1：主控由谁回答（决定 B0 验证什么）

| 选项 | 主控 | 子 Agent 可用模型 | 说明 |
| --- | --- | --- | --- |
| **a（建议）** | magpie 托管的非 ChatGPT 模型 | magpie 提供的任何模型 | 任务以明文传递，满足"子 Agent 分别指定模型" |
| b | ChatGPT 账号（多 Agent V2） | 只有 ChatGPT 账号的模型 | 子 Agent 若设成第三方模型，会留在原模型或被拒绝 |
| c | 多 Agent V1 | 任何模型 | 取决于 Codex 版本是否仍支持，待验证 |

### D2：第一批两个子角色

建议都是只读角色，例如 `explorer`（调查代码）、`reviewer`（评审）。每个角色的模型，由你从 magpie 已提供的模型里选定。

### D3：B 线工作目录与基线

建议新建独立目录（例如 `E:/cc/guahub/fork/magpie-hub/magpie-b`）克隆，基线冻结在 `e1b70c13`。不占用 `magpie-pr1~3`。

---

## 四、开发线、分支与文件归属

### A 线：UI 改版（不变）

- 目录 `E:/cc/guahub/fork/magpie-hub/magpie-ui`（已不存在，10-17 删除）；分支 `ui/switchboard`，不改名。
- 输入：已有 UI 设计文档和布局提示词，继续 P0~P4。
- 负责：该目录内的 GUI 资源、布局测试，以及必要的 GUI 相关 Go 测试。
- 边界：不改 API、网关、provider、settings 和 Agent 配置行为；不实现协作功能。
- 输出：可独立验收的提交、真实截图、验证证据；在 P1 交付检查器挂载点。

### B 线：多模型协作

- 分支 `codex/multi-model-core`（未创建）；目录按 D3。
- **默认不改 magpie 代码**。只有 B0 实测证明有缺口时，才在网关/provider 做最小修改，并且必须先报告、获得确认。
- 负责：自定义 Agent 文件样例、验证脚本、证据，以及发现缺口时的 Go 修改和测试。
- 边界：不改 GUI 资源、GUI 测试、GUI API；不做通用编排框架；不让网关根据提示词猜角色；不编辑用户自己的 Agent 文件。
- 输出：一套可复现的协作闭环（命令、配置文件、证据），以及失败行为说明。

### C 线：集成与验收

- 分支 `codex/multi-model-integration`（未创建）。
- **入口条件：A 完成 P1 且 B1 通过**，不需要等 A 的 P4。
- 负责：在新检查器里**只读展示**每个子 Agent 的实际落点、是否留在原模型及原因（数据来自现有路由记录与用量日志），处理冲突，跑组合回归。
- 不新增 GUI 写入接口；如果之后确实需要从 magpie 编辑角色，另行立项。
- 从冻结基线引入 A/B 已验收的提交，不复制未提交的工作区，不要求 UI 先合入 main。合并 main 或发布，在集成验收后另行讨论。

---

## 五、隔离约束

**只靠分支不同不足以隔离，必须同时有独立目录、文件归属和独立运行环境。**

1. 各线只在自己目录里执行 Git 和构建；不自动 stash、reset、clean，也不新增 worktree。
2. B 线运行时，每个 PowerShell 窗口固定设置以下三项，并且只用 `magpie serve`，不启动桌面版（桌面版是单实例，会接管正在运行的实例）：

   ```powershell
   $env:XDG_CONFIG_HOME = "E:\cc\guahub\sandbox\b\cfg"     # magpie 配置、用量、路由记录
   $env:CODEX_HOME      = "E:\cc\guahub\sandbox\b\codex"   # Codex 配置与自定义 Agent
   $env:MAGPIE_ADDR     = "127.0.0.1:18787"                # 避开日常的 8787
   ```

   开工前打印这三个变量并确认生效。不得读写真实的 `~/.codex`、`~/.config/magpie`。
3. A 线的 GUI 测试使用项目自带的 `testenv` 隔离，不连接真实网关。
4. 同一文件需要两条线都改时，先交接，不承诺"分支不同就没有冲突"。已知高风险共享文件：`internal/settings/settings.go`、`internal/gui/assets/i18n.js`。
5. hub 文档由主 Agent 统一维护，其他线只提交反馈；证据归档到 `E:/cc/guahub/fork/magpie-hub/magpie-hunt-issues/<线名>/`（已不存在：10-16 改名迁入 issues/，旧档案 legacy/ 已于 10-23 删除；现行产物目录为 `fork/docs/hub/magpie/issues/`）。

---

## 六、B 线分阶段交付

推进顺序：**D1~D3 确认 → B0 → B1；B0 发现阻断缺口 → B2 → 回到 B0。** B2 是条件分支，不是必做阶段。

### B0：回归与真实闭环验证

- [ ] 记录 Codex 版本、多 Agent 模式（V1/V2）、主控模型（按 D1），以及 magpie 的基线提交。
- [ ] 跑现有回归（免费）：

  ```powershell
  go test -tags nogui ./internal/gateway -run "CodexSubagent|SpawnAgent|Sealed" -count=1
  go test -tags nogui ./internal/agent -run "Codex" -count=1
  ```

  预期全部通过。这只证明现有规则，不代表真实模型能跑通。
- [ ] 确认 magpie 统一子模型为空（读隔离配置目录里的 settings）。
- [ ] 用一次真实闭环验证"主控点名两个不同模型"（需付费授权，见第九节第 3 步）。
- [ ] 本地假供应商的测试结果不得当作真实模型的成功。

**验收**：命令、输入、输出、退出码，以及第八节规定的三项证据。没跑的项目单独列出。如果现有机制已经满足目标，就不新增执行层。

### B1：用 Codex 原生自定义 Agent 绑定角色

- [ ] 在 `$env:CODEX_HOME\agents\` 下放两个文件（按 D2），各设一个 magpie 模型 ID 和 `sandbox_mode = "read-only"`，并写清 `description` 与 `developer_instructions`。
- [ ] 主控显式派遣这两个角色，不做自动分类；主控负责汇总。
- [ ] 文档写清第 2.4 节的优先级。统一子模型非空时，B 线流程**报告冲突并停止**，不静默修改用户设置。
- [ ] 覆盖以下失败情况，沿用现有失败语义：模型未提供（`CodexSubagentUnserved`）、模型被禁用、网关密钥无权使用、加密任务打不开。
- [ ] 配置恢复：断开接入后，`config.toml` 恢复原样，Agent 文件原样不动。

**验收**：两个角色各自落到指定模型；失败原因可以从路由记录读到；恢复前后的文件哈希一致。具体用哪个模型由你决定，不预设厂商能力排名。

### B2：运行时缺口决策（仅在 B0 证明必要时进入）

只比较两条路线：**在现有 Codex 路径上做增量修改**，或者**独立委派桥**。报告会话、进程、权限、部署和维护成本，你选定后才实现。

Pi 不在候选中。原因：Pi 核心不含子 Agent（README："skips features like sub-agents"）；它的虚拟模型属于"同会话逐请求换模型"（第一节类别 ②）；`jev-router.ts` 是示例扩展，需要 TypeSafe 凭据和 Codex 登录。等将来做阶段换模型时再参考：

- <https://github.com/earendil-works/pi>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/jev-router.ts>

---

## 七、C 线界面接入与验收

- [ ] 在新版 Agent 检查器里，只读展示：客户端、主控模型、每个子 Agent 要求的模型（`asked`）、实际模型（`to` 或响应头），以及留在原模型的原因（`kept`）。不新增一级页面。
- [ ] 数据只来自路由记录和用量日志；请求记录不冒充任务生命周期；没有真实切换就不做切换动画。
- [ ] 验证经典布局、窗口、托盘、`magpie web`，以及键盘操作、窄屏和工程要求的所有语言文案。
- [ ] **单模型对比**：同一任务、同一基线，协作方案和单模型方案各跑 3 次以上；成本从用量日志按用途分开取（主控 / 子 Agent / 汇总），计入缓存读写、重试和故障转移；质量用事先写好的检查表判定；耗时按端到端计算。不预设协作一定更便宜。

---

## 八、验收证据标准（所有线通用）

一次"协作成功"必须同时满足：

1. 每个子 Agent 请求的**实际模型**与预期一致（看 `X-Magpie-Model` 响应头，或用量日志的 provider/model）；
2. 路由记录 `subagent` 字段不存在，或者 `kept` 为空；
3. 主控的最终回答包含每个子 Agent 的结果。

只有"配置写入成功"或"命令退出码为 0"，**不算**协作成功。

---

## 九、最小端到端验证方案（B0/B1）

第 1~2 步免费；第 3 步起需要真实账号，必须先获得授权。

1. 回归测试（见 B0），预期全部通过。
2. 准备隔离环境（第五节第 2 条），另开一个窗口运行 `magpie serve`；记录 `Get-FileHash $env:CODEX_HOME\config.toml`。
3. 添加供应商并接入 Codex：`magpie provider add <provider> <key>`、`magpie codex <provider>/<主控模型>`。
4. 放入两个自定义 Agent 文件（B1）。
5. **正向**：`codex exec "分别派 explorer 和 reviewer 各读 README 并报告第一行，然后汇总"`。预期满足第八节三项。
6. **反证：覆盖关系**。设统一子模型为模型 X 后重跑，预期两个子 Agent 都落在 X 上。验证完立即清空。
7. **反证：加密边界**（仅当 D1 选 b，或要确认边界时）。主控改走 ChatGPT 账号，预期 `kept` 为 `sealedKept` 那句原因。
8. **权限**：让 explorer 新建一个文件，预期被只读沙盒拒绝，文件不存在。
9. **取消**：子 Agent 运行中按 Ctrl+C，预期路由记录显示该请求中止，`magpie serve` 里没有残留的进行中请求。
10. **恢复**：断开接入，预期 `config.toml` 哈希与第 2 步一致，Agent 文件原样不动。

---

## 十、工程门禁、回滚与交付

- 改动过的 Go 文件：`gofmt -l`、`go vet ./...`、`go test -tags nogui ./...`，以及规范要求的本机和跨平台 vet、构建；有并发改动时加 `-race`。
- GUI：沿用 Makefile 和测试 README；Chromium 与 WebKit 都跑；中英文及 zh-TW、ja、de 文案齐全。
- **新增测试必须在未修改的代码上先变红**，并搜索同类位置（其他判定逻辑、其他路由、其他供应商）是否也需要改。打算提交上游时这是硬要求（上游 `docs/contributors.md` 对作者 ggbdpq 有专门检查）。
- 每阶段只报告实际运行的命令、输入、结果、退出码、没跑的项目和继续条件。没运行的不写成"通过"。
- 回滚：代码用对应提交的反向变更；配置恢复用现有断开/暂存语义，并测试；不整仓重置，不覆盖他人工作。
- 交付前：对每个新增的抽象做一次移除验证，删掉后仍满足验收就删掉。保留权限、数据保护、兼容、错误处理和可观测性。

---

## 十一、可复制的分线开场提示词

```text
请按 E:/cc/guahub/fork/magpie-hub/docs/magpie-multi-model-plan-v0.2.md 工作。
本次只认领：<A/B/C 线>；实际 checkout：<分配目录>；D1 选择：<a/b/c>。
先核对适用规则（AGENTS.md、CLAUDE.md、LESSONS.md、code-standards、contributors）、
Git 状态、分支、基线，以及该目录是否被其他任务占用。保留已有改动。
B 线：先打印 XDG_CONFIG_HOME、CODEX_HOME、MAGPIE_ADDR 并确认指向沙盒，
只用 magpie serve；默认不改 magpie 代码，发现缺口先报告。
先提交不超过 40 行的理解确认：负责文件、禁止触达范围、本阶段验收、待决策项；
获得确认后再实施。
"协作成功"以第八节三项证据为准，配置写入成功不算。
发现跨线依赖就交接，不替另一条线改共享文件。
不自动提交、推送、合并 main，不改真实账号和真实配置；
付费模型联调须先得到我的授权。
阶段结束附验证证据、回滚方式和交接提交；没运行的不写成通过。
```

---

## 十二、仍待验证

1. 自定义 Agent 派出的请求是否同样被识别为 `collab_spawn`（决定统一子模型是否覆盖它）。
2. 本机 Codex 版本是否支持自定义 Agent，以及多 Agent V1 是否仍可用（影响 D1 选项 c）。
3. 子 Agent 落在 Chat 协议供应商上时，工具调用的协议转换是否完整（由第九节第 5 步证明）。
4. Windows 下设置 `XDG_CONFIG_HOME` 后，GUI 单实例与配置目录是否完全隔离（B 线不启动 GUI，可以绕开）。
5. Claude Code 原生子 Agent 是否适合作为备选主控（本期不做，仅记录）。
