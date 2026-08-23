<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# 专家团实现详情 — WorkBuddy & QoderWork 逆向（实现级）

> 本文是"专家团/数字同事"两款竞品的**完整实现拆解**，用于指导 maka-agent 的实现。
> 基于对本机安装的 WorkBuddy（腾讯 CodeBuddy 换皮）与 QoderWork（阿里 Qoder）的解包逆向。
> 上层设计与 maka 落点见 [expert-team-plan.md](expert-team-plan.md)。
> 逐层原始 spec（含 byte offset / 逐字字符串）在 scratchpad：
> `IMPL-workbuddy-runtime.md`、`IMPL-workbuddy-mainprocess.md`、`IMPL-workbuddy-renderer.md`、
> `IMPL-workbuddy-colleague.md`、`IMPL-qoderwork-runtime.md`、`IMPL-qoderwork-plugins.md`。
> 标注：**[C]** = 代码/文件中确证，**[I]** = 推断。

---

# 总览：两家的架构范式

两家惊人地同构，都是 **"Electron 壳（manager）+ 一个 Claude-Code 派生的 CLI agent 引擎 + 一个远程 marketplace"**：

| | WorkBuddy | QoderWork |
|---|---|---|
| 壳 | Electron 主进程（DI/CellJS 组件） | Electron 主进程 `main.js` |
| Agent 引擎 | `agent-cli`（`codebuddy.js` 21.6MB，品牌 "CodeBuddy Code"），**每会话一个 `agent-cli --serve` 子进程** | `qodercli`（`@qoder-ai/qoder-agent-sdk`），**host(94KB) + worker(35MB obf) 两进程** |
| 引擎↔壳 通信 | HTTP (`/api/v1/*`) + ACP endpoint | host↔worker transport + SDK API |
| "专家"单元 | plugin bundle（含 `agents/*.md` 人格）从 COS 拉取 | Plugin 文件夹（skills+commands+connectors）本地/云 |
| 多智能体 | **两种原语**：sub-agents + Agent Teams（`TeamCreate`） | sub-agents（`Agent` 工具，无 team 原语） |
| 人格来源 | 专家 plugin 的 agent md（身份覆盖 system prompt） | awareness `SOUL.md` 分层（system-reminder 注入） |
| 数字同事 | 有（cloud-agent + Claw IM + BackgroundAgent 云端） | 无（只到 plugin/awareness 层） |

**关键洞察**：两家的"专家"本质都是 **"带人格的 agent 定义（md + frontmatter）+ 一个能热加载它的 CLI 引擎"**。真正的差异在**多智能体编排**（WorkBuddy 有完整的 Agent Teams 原语，Qoder 靠 sub-agent + 工具作用域）和**产品化外壳**（WorkBuddy 有数字同事 + IM + 云端）。

---

# 第一部分：WorkBuddy

## A0. 进程/目录拓扑

- **引擎**：`agent-cli`（`wb-app/cli/dist/codebuddy.js`），`--serve` 模式暴露本地 HTTP + ACP。**每个会话一个子进程**（`SidecarServer` / `sidecar-entry.js`，macOS/Linux 用 `@lydell/node-pty` PTY，Windows 用 `spawn`）。[C]
- **状态目录**：引擎侧 `~/.codebuddy/`；壳侧 `~/.workbuddy/`（部分镜像）。
- **专家 marketplace**：腾讯 COS `https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace`。
- **引擎自带人类可读文档**（逆向金矿）：`wb-app/cli/dist/web-ui/docs/cn/cli/{sub-agents,agent-teams,plugins-reference,skills,sdk-hooks,acp,permissions}.md`。

## A1. 数据模型（marketplace）

Manifest = `expert_center.json`（331 专家 / 13 分类），外加并行拉取 `internalExpert.json`/`externalExpert.json` 合并（企业内外部隔离）。每个专家条目关键字段：
```
id, categoryId, displayName{en,zh}, profession, description,
promptFile,          # COS 相对路径，指向人格 md（如 /plugins/content-creator/agents/content-creator.md）
avatar, defaultInitPrompt{en,zh}, quickPrompts[], tags[],
expertType: "agent"(285) | "team"(46),   # team 就是"专家团"
agentName, plugin,   # 指向 bundle 内的 agent id
members[]            # 仅 team：[{id, displayName, profession, avatar, promptFile, role:"lead"|"member"}]
```
人格 md = YAML frontmatter（`name, description, color, emoji, vibe`；team lead 加 `maxTurns:200`）+ body（🚨身份覆盖指令 + Role/Capabilities/内置Skill触发 + 🔒身份提醒）。

## A2. 主进程专家生命周期（`IMPL-workbuddy-mainprocess.md`）

DI 组件（CellJS `@Component`）：`ExpertManifestProvider`（+`ExpertCacheManager`+`ExpertCenterResourceLoader`）、`ExpertService`/`ExpertCloudService`/`ExpertDesktopService`、`ExpertPluginService`、`ExpertHistoryService`。

### A2.1 Manifest pipeline — 缓存优先 + 前台增量 + 后台重校验
```
CURRENT_SOURCE_SIGNATURE = JSON.stringify({baseUrl, manifestPath})
cacheDir = <runtimeUserDataDir>/cache/experts  → manifest.json / version.txt / metadata.json
metadata = {version, cachedAt, sourceSignature, manifestHash: sha256(JSON), cacheFormatVersion:2}
doInit():
  loadFromCache()  // sourceSignature 不符则 clear
  有缓存 → syncManifestBeforeReady()（前台 fetch，version==&&hash== 则保留，否则替换）
  无缓存 → fetchAndCacheManifest()（冷启动远程拉）
  backgroundManifestUpdate()  // setImmediate 后台重校验，变了才替换
fetchManifest() = Promise.all([base expert_center.json, ...scoped]) → mergeExpertManifests（id-keyed Map，scoped 覆盖 base）
```
**无 ETag**，靠 sha256+version+sourceSignature。企业/visibility 过滤在**渲染层**做。

### A2.2 激活 `ExpertPluginService.activateExpert()`
```
bundleName = pluginName || manifest.experts[].plugin || kebab(expertId)
localPath  = 下载 COS /bundles/<bundle>.tar.gz（zip 仅限可信运营平台 URL，host allowlist + zip-slip guard）→ 解压
manifest   = 读 .codebuddy-plugin/plugin.json
agentName  = resolveExpertAgentName（5 级：manifest.agentName → team leadAgent → agents/<kebab(id)>.md 的 name → 唯一 .md → kebab）
→ 注册 marketplace（marketplace.json 增量）→ 删旧 agent-override settings.json → activeExperts.add
return {expertType, agentName, localPath, pluginRegisteredName}
```
`resolveExpertLocation` 优先级：hint → 官方 `experts` → 自建 `my-experts`，缺失则懒下载。下载有 in-flight dedup + `.downloaded_at` 时间戳判新旧。

### A2.3 会话绑定 + CLI 注入（核心机制）
`sessions` 表列：`expert_id / expert_locale / expert_runtime_identity / expert_marketplace`（`upsertSession` 用 COALESCE 合并）。
> **纠正**：`expert_runtime_identity` 是**不透明激活 key 字符串**（默认 `expert:<id>`，实际是 `name@marketplace` 的 sourcePluginId），**不是** JSON 人格快照。用作幂等重激活的 dedup key。

**人格如何进入 CLI —— 不是 spawn 参数，而是 before-prompt hook + HTTP：**
```
createWorkbuddyAppServerBeforePromptExpertActivation({sessionId, desiredConfig}):
  resolved = resolveExpertLocation(expertId, marketplace)   // 懒下载
  headers  = {"X-Expert-Id": expertId, ...(team ? {"X-Expert-Team-Task":"true"} : {})}
  switchExpertPluginForSession(sid, disable=ø, enable=manifest.name, agentName,
                               sourcePluginId=`${manifest.name}@${marketplace}`, headers)
    → POST `${httpBase}/api/v1/plugins/switch`
       body {persist:false, enable:`name@mp`, agentName, sourcePluginId, internalModelRequestHeaders}
```
`persist:false` → 只在当前 CLI 进程内生效。这一个 HTTP 调用让通用 `agent-cli` 把该 plugin 的 agent md 当作 system prompt 加载。team 专家额外带 `X-Expert-Team-Task` header，触发 agent-teams 环境。自建专家（`@my-experts`）走两次 POST 的 override-refresh 让编辑后的人格重载。失败则"降级到当前 prompt"（会话仍跑，只是没人格）。

### A2.4 IPC（`expert:*` / `expert-history:*`）
21 个 `expert:*` channel（`init/getCategories/getExperts/getExpert/getFeaturedScenes/getRanking/activatePlugin/switchPluginForSession/exportZip/importFromUrl/preCheckShare/queryShareSecurityScan/scanCustomExperts/addUserExperts/...`）。渲染层实际召唤走**一个 facade RPC `expert:summonExpert`**（不是细粒度 channel），主进程内部编排 detail→download+activate→history。

### A2.5 分享 & 安全
- 导出 `exportExpertZip`：adm-zip，顶层单目录=expertId，manifest 里盖章分享者。
- 导入 `installExpertZipFromPath`：强制单顶层目录 + `plugin.json` + 路径逃逸 guard → 落 `my-experts`。
- 安全扫描：腾讯 **XTI** API（`SkillSecurityClient`，`SkillAnalysisUpload`/`SkillAnalysisInfo`，md5 键，threatLevel→low/medium/high）。`runSkillPreCheck` **fail-open on scanner error, fail-closed on risk verdict**（扫描器出错放行，返回风险则 `security_check_blocked`）。

## A3. Agent 运行时（`IMPL-workbuddy-runtime.md`）—— 最有价值的部分

### A3.1 两种协作原语（不要混）
引擎自带文档明确区分：

| | **Sub-agents** | **Agent Teams** |
|---|---|---|
| 派生 | `Agent` 工具（**无** `name`） | `TeamCreate` 后 `Agent`（**带** `name`） |
| 上下文 | 独立 window；**结果 summary 回传给 parent** | 独立 window；**完全独立** |
| 通信 | 只能把 final result 上报 parent | 成员间 `SendMessage` mailbox 互发 |
| 协调 | parent 全权编排 | 共享 task list，成员自领任务 |
| 拓扑 | 星型（仅 parent） | mesh（成员↔成员 + `@all` 广播） |

marketplace 的 `team` 专家跑在 **Agent Teams** 上；lead 人格 md 里写的编排指令**驱动**真实的 `TeamCreate`→`Agent`→`SendMessage` 工具（**没有服务端 router**）。

### A3.2 `Agent` 工具（逐字 schema，offset ~11,263,540）
```js
name = "Agent"
parameters = z.object({
  description: z.string(),          // 3-5 词任务描述
  prompt: z.string(),               // 交给 agent 的任务
  subagent_type: z.string().optional(),
  model: z.enum(["default","lite","reasoning"]).optional(),
  resume: z.string().optional(),    // 传上次 agentId 续跑（带完整历史 transcript）
  run_in_background: z.boolean().optional(),  // 返回 task id，用 TaskOutput 取
  name: z.string().optional(),      // 有 name → teammate（可被 SendMessage 寻址）；"team-lead" 保留
  team_name: z.string().optional(),
  mode: z.enum(["acceptEdits","bypassPermissions","default","plan"]).optional(),
  max_turns: z.number().int().positive().optional()
})
```
`execute()` 路由顺序：**fork 特化**（`<fork-boilerplate>` prompt 禁止嵌套 fork）→ **teammate**（有 `name` + team 启用 → `spawnTeammate`）→ **background**（`run_in_background` → 返回 task id）→ **同步 sub-agent**（默认；`isolation:"worktree"` 则建 git worktree）。

### A3.3 执行模型
- sub-agent/teammate 是**进程内 `AgentTask`**（`detached:true, captureOutput:true`），不是独立 OS 进程；可选 `--swarm`/`CODEBUDDY_INPROCESS_TEAMMATES`。
- **独立 context window，全新状态**：成员不继承 lead 历史，spawn 时重载 `CODEBUDDY.md`/MCP/skills。
- **返回=summary 非 transcript**：完成时先跑 `SubagentStop` hooks，再用 `result.finalOutput ?? "Task completed"` resolve parent 的 await callback。大输出外置到 `tool-results/{callId}.txt` 用指针引用。
- **禁止嵌套**：sub-agent 不能再 spawn sub-agent；team 不能建 sub-team（只有 lead 管 team）。
- **并行 = 一个 assistant turn 里多个 `Agent` tool_use block**。
- **resume**：每次跑有 `agentId`，transcript 存 `~/.codebuddy/projects/{proj}/{parentSid}/subagents/agent-{agentId}.jsonl`。
- **内置 agent 类型**：`general-purpose`（全工具）/`explore`（只读，gemini-3.0-flash）/`plan`/`fork`/`compact` + 保留的 `team-lead`。

### A3.4 人格→system prompt（身份覆盖机制）
agent md body → agent `systemPrompt`。`buildSystemPromptAgentOverride(name, instructions, appendInstructions)`：**`instructions` 完全替换** base persona，`appendInstructions` 追加。marketplace 人格用 `instructions`（完全替换）装入"🚨你是X且只是X，绝不暴露底层模型"的身份覆盖模板。`defaultInitPrompt` **不在** system prompt 里 —— 它作为**首条 user message** 注入。

### A3.5 `TeamCreate` / `SendMessage` / `TaskStop`（逐字 schema）
```js
// TeamCreate（lead-only，一会话一 team；offset ~11,586,300）
"TeamCreate" params: {team_name, description?, agent_type?}
execute: 若已在 team → 拒绝；createTeam → ctx.meta.isTeamLead=true → 启动 inbox 轮询 →
         返回 "Spawn teammates with the Agent tool using `name` and `team_name`"

// SendMessage（mailbox；offset ~11,450,000）
"SendMessage" params: {
  type: z.enum(["message","broadcast","shutdown_request","shutdown_response","plan_approval_response"]),
  recipient?, content?, summary?, request_id?, approve? }

// TaskStop：取消 running/pending 的 AgentTask 或 background shell
```
**Delegate Mode**（Shift+Tab）：把 lead 限制为协调工具 `Agent, TaskStop, SendMessage, AskUserQuestion, StructuredOutput`（无 Read/Edit/Bash）。**Plan-before-implement**：`Agent{mode:"plan"}` → 成员交计划 → lead `SendMessage{plan_approval_response, approve}`。

**Team 磁盘状态**：`~/.codebuddy/teams/{team}/config.json`、`inboxes/{member}.json`、`~/.codebuddy/tasks/{team}/`（任务 pending/in_progress/completed，支持依赖，完成自动解锁下游，成员自领）。清理 team 必须 lead 做。

### A3.6 Skills / Plugins / Hooks / ACP
- **`skill` 工具**：params `{skill | command, args}`，`/` 开头走 slash command，否则执行 Skill。人格 frontmatter `skills:` 在 agent start 自动加载。
- **Plugins** 打包 `agents/ skills/ commands/ connectors/`（`.codebuddy-plugin/plugin.json`），marketplace 注册进 `PluginManager`；专家=从 COS 懒拉的 plugin。
- **Hooks**：`PreToolUse/PostToolUse/SessionStart/Stop/SubagentStart/SubagentStop`。`SubagentStop` 在 parent callback resolve 前触发。
- **权限优先级**：`Agent{mode}` → `--subagent-permission-mode` → env → settings → 继承（Delegate Mode 强制 `default`）。
- **ACP team bridge**：`session_info_update._meta["codebuddy.ai/teamUpdate"]` 推 member 状态；成员流用 `_meta["codebuddy.ai/memberEvent"]` 打标路由到各自 timeline；`AcpTeamBridge` 刷新时重放历史。

### A3.7 一个 team 专家端到端
1. 召唤 team 专家 → 下载/解压 bundle → 写 session 行 → CLI 以 **lead** md 为身份覆盖 system prompt 启动 → 首条 msg=`defaultInitPrompt`。
2. lead 人格指示它调 `TeamCreate{team_name, agent_type}` → 写 `~/.codebuddy/teams/…` → 启动 inbox 轮询。
3. lead 发 1+ 个 `Agent{name:"role", subagent_type:"memberId", team_name, prompt, mode?}` → 各成为进程内 detached `AgentTask`。
4. 成员并行、从共享 task list 自领任务、用 `SendMessage` 协调。
5. 每成员完成触发 `SubagentStop`，`finalOutput`（仅 summary）回 lead；lead 综合 → `SendMessage{shutdown_request}` → 清理 team。

`agent` 型专家（86%）折叠 2-4 步：单个人格注入的对话 agent，可选用 `Agent` 工具做星型 sub-agent。

## A4. 渲染层（`IMPL-workbuddy-renderer.md`）

- **召唤流程**：卡片"立即召唤" → `handleSummon`（team 警告 + 金融风险 gate）→ `useExpertSummon().summonExpert` → **一个 facade RPC `expert:summonExpert`**（detail→download+activate→history）→ `session.prepare({selectedExpert})` 设 pending expert → `goHome()`（新会话）或 `navigate('/task/:id')`。
- **`defaultInitPrompt` 在专家中心路径下只 pre-fill composer**（`applyExpertDefaultPrompt` = `setInputValue`），**不自动发送**；只有 colleague chat page 的 `autoSendPrompt` 会真发。`quickPrompts` = 带 `promptOverride` 重召唤的按钮。
- **状态**：无 redux，真值源是 `WorkbuddyAgentAdapterNext.selectedExpertBySession`（Map，含 `PENDING_EXPERT_SESSION_KEY`）+ RxJS Subject 总线（`pendingExpertModeActivation$` 等）。会话内切专家 → `expert:switchPluginForSession`（原子 disable-old+enable-new，一次 `rebuildAgents`）。深链导入 buffer 在 `globalThis.__GENIE_PENDING_EXPERT_INSTALL_INTENT__`。
- **主题**：`useExpertTheme()` 读 `document.body.classList`（`vscode-dark`/`vscode-high-contrast`→dark）+ `MutationObserver` 监听 body class；`useThemeClassName()`→`expert-center-dark|light` 盖在 `.expert-center-page`，切换 `--ec-*` CSS 变量族。per-expert accent 来自人格 frontmatter `color`/`emoji`，与明暗正交；头像 fallback 用 8 色 `--ec-avatar-fallback-bg-N`（`name.charCodeAt(0)%8+1`）。

## A5. 数字同事 / 云助理（`IMPL-workbuddy-colleague.md`）

UI 词"助理/云助理/数字同事"映射**三个内部子系统**：**cloud-agent**（定义+实例+会话，后端 CRUD）、**cloud-assistant**（entitlement 门）、**Claw**（IM 渠道 + 后台 agent）+ **BackgroundAgent**（云后端，webhook + Redis ChannelRegistry）。

### A5.1 双存储面
- **云面（权威）**：colleague 是**云对象**，非本地行。`POST /v2/user/cloudagent/agents` 创建，带**版本化 `manifest`**。REST：`orchestrator/agents/validate-field/quota/clone/versions/enterprise-published` + `/v2/as/conversations/*`。IPC `cloudAgent:*` / `cloudAssistant:*` 镜像。
- **本地面（调度/会话）**：`automations` 表（RRULE、`schedule_type`、`next_run_at`、**`expert_id`/`expert_marketplace`**=雇佣的专家、`connector_ids_json`、`skills_json`、**`push_to_wechat`**）→ `automation_runs`/`automation_runtime_state`。IM 绑定存 `settings.json → claw.channels` + `ioa-im-override.json` + `AgentImBindingStore`。

### A5.2 创建对话字段
基本信息（avatar ≤5MB / 昵称 validateField 查重 / 职能预设）+ 能力配置（**hireExpert** 从 `{expert|team|企业智能体}` 选 1 / **codeRepo** github·cnb·工蜂 OAuth / **knowledgeBase** / **model** listAvailableModels）。雇佣的专家存为 `expert_id`+`expert_marketplace`，会话启动时按普通召唤解析人格；额外由 **MemoryCollector** 注入 `ClawMemory_1/2/3` + `<cwd>/.workbuddy/memory/MEMORY.md`（cap 8000 字）。

### A5.3 IM 绑定（最新颖）—— 无第三方 IM SDK 打包，两种模式
- **`webhook`（云中继，默认）**：`ClawService.registerChannelWithBackend` → `POST /v2/backgroundagent/localProxy/register` 写后端 ChannelRegistry（Redis）返回 `webhookUrl`。IM 平台 → webhook → 后端 → cloud-agent 会话 → 回复。**桌面可离线**。
- **`websocket`/`scan`（本地）**：沙箱化的 IM **CLI plugin 子进程**（`lark-channel`/`wecom` 等）持 WebSocket 到平台，通过 unix-socket JSON-RPC 流给 daemon。
- 各平台认证走 CLI（`lark-cli config init --new`+`auth login`、`wecom-cli init --noninteractive`，抓 stdout 的 auth-URL/QR/device-code）+ 微信机器人 QR + QQ QR。
- 绑定键 `users[uid].targets[targetType][targetId].backends[backendMode][channelType]`，`targetType∈{assistant,colleague}`，`backendMode∈{local,cloud}`。@提及 → `triggerSource="user_mention"`。**IOA gate**（`ioa-im-override.json`）在腾讯内网机器上拦非腾讯 IM。

### A5.4 云/daemon/调度/配额
- `daemon-app-server` 是 Electron main 的独立 stdio-only Node 子进程，跑同一 `module.app-server` 容器 + 常驻后台服务（Claw 渠道 plugin + automation 调度器）——即"本地云"。云模式用后端沙箱 + 微信小程序做"手机远程"。
- 调度：`automations`（RRULE）→ `automation_runs`。
- 配额：服务端 `GET /v2/user/cloudagent/quota`，渲染层映射 个人体验版/专业版/SaaS企业版；`cloudAssistant:getEntitlement` 门控。

---

# 第二部分：QoderWork

## B0. 架构（`IMPL-qoderwork-runtime.md` §0）
Electron 是 **manager**；真实 agent loop 在打包的 **`qodercli`（`@qoder-ai/qoder-agent-sdk`）**：
```
app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/
  package.json           # name "@ali/qoder-agent-sdk-next" v1.0.13, qoderCliVersion 1.0.41
  dist/index.js          # 94KB host（query/listSubagents/hooks/session）
  dist/_worker/qoder-worker-runtime.obf.mjs  # 35MB 真 agent loop（obfuscated，base64+XOR key "hABjM4Eb0CeC"）
```
worker 由 `install` 从 `download.qoder.com/qodercli/releases/1.0.41/...tgz` 下发。`defaultTransport:"worker"`。**Qoder 没有 team 原语**，多智能体只靠 sub-agent + 工具作用域。

## B1. Plugin（专家套件）打包/安装/热加载（`IMPL-qoderwork-plugins.md`）

### 目录 & schema
```
~/.qoderwork/plugins（市场装） / plugins-custom（自建/fork） ; Resources/plugins-example（15 个内置"本地市场"）
配置目录候选 [".qoder-plugin", ".claude-plugin"]（兼容 Claude-Code 导入）
plugin.json: {name, displayName, version, description{En,Zh}, category, customizedFrom?, tags,
              skills:["./skills/xxx"], commands:["commands/x.md"], qoderMarket?:{pluginId}}
guards: isValidPluginFolderName（无 ../\/前导.）; BLOCKED{员工管理,招聘管理,薪酬绩效}; MAX_ZIP 50MB
```
### 安装 → 迁移 → 热加载
- tRPC `plugin.*`（`installMarket/forkPlugin/updateMarket/uninstall/listInstalled/...`）；本地源从 `plugins-example` 拷贝，远程源按 `pluginId` 下载。
- **`plugin-cli-migration-service`**：把 plugin 所有权从 Electron 迁给 qodercli（feature-gate `qoderworkPluginCliMigrationV1Succeeded`，幂等一次性）。`PluginCliManagementService.syncInstalled` → SDK `installPlugin(path)` 注册目录 → `enablePlugin/disablePlugin` 开关。
- **热加载**：`reloadMainSessionPlugins(reason)` → `runtime.reloadPlugins()` → `query.reloadPlugins()` 返回 `{plugins[], commands[], agents[], mcpServers[]}`，**live session 内热注入无需重启**。一个 plugin 一次贡献 skills+commands+sub-agents+MCP。

## B2. Skills / Commands
- **Skills**：`SKILL.md`（YAML frontmatter `name/version/description/description_zh/disabled` + body）。发现优先级 builtin→user→plugin→market；首次运行把 default-enabled 内置 skill **拷进** user 目录供编辑。**注入=懒加载 + description 触发**：模型只见 catalog（name+description，故意堆同义触发词），body 在 `@`/`/`/`Skill` 工具激活时加载，`references/` 按需（progressive loading，SKILL.md <500 行）。`user-invocable:false` = 隐藏知识库 skill，只被别的 skill 引用。启停=改 `disabled:` frontmatter。
- **Commands**：`commands/*.md`（frontmatter + body=prompt macro），`/name` 调用。
- **`external-commands`**：`registry.json` 声明的**下载的原生 CLI 可执行文件**（per-platform 签名 zip，sha256 校验，`entry`/`defaultArgs`/`env`）——如 `/wiki` 跑 `wiki-cli`。区别于 prompt-macro 的 `commands/`。

## B3. Connectors（MCP）三层
1. **native/market**：在 `qoderwork.settings.connector.market`，产品级，**不写** `.mcp.json`，`CONNECTORS.md` 文档化。
2. **custom**：用户本地加的，不可移植。
3. **guided-setup**：需 per-user 凭证的第三方（钉钉/飞书），写 `.mcp.json`（`type:"guided-setup"`，`_setup.url` 只是公开配置页），装后详情页渲染指引让用户贴自己的 config。

`CONNECTORS.md` 用 `~~类别` 占位符 —— plugin **工具无关**，每个 skill 必须能独立工作，connector 只在 SKILL.md 末尾加"If Connectors Available"增强段。`reloadMcp()` → mcp-adaptor 进程（`~/.qoderwork/mcp-adaptor.config`），CLI 收到 MCP 工具名 `setMainSessionMcpToolSnapshot`。

## B4. Sub-agent 运行时（`IMPL-qoderwork-runtime.md`）

### `Agent` 工具（解码后逐字 schema `uji`）
```js
{ description*, prompt*, subagent_type(default "general-purpose"), cwd,
  run_in_background, name, team_name, isolation:enum["default","worktree"] }
// subagent_type 非必填；isolation:"worktree" 跑隔离 git worktree（无改动则自动清理）
```
类 `TG`：`isReadOnly=true`（工具本身只读，子的工具才带权限）；`checkPermissions` 按 tool+agentType 规则 allow/ask/deny；`getDefinition` miss 抛 `Unknown agent type: '<x>'. Available types: …`；definition 有 `kind`（`"local"` md-file vs `"workflow"`）。

### Roster 注入（路由靠 description）
`gjn(registry, disabled)` 动态建工具描述：base "Launch a new agent…" + 每 agent 一 bullet `- <name>: <description> (Tools: <All tools|list|All tools except X>)` + `subagent_type` enum = **sorted agent names 闭集**。另有 `**Available custom agents configured:**` 列表 + `**Connected MCP servers:**`。模型**纯靠 description 匹配路由，无独立 team manifest**。静态指引逐字含："send a single message with multiple tool uses so they run concurrently"、"result … is not visible to the user … send a text summary"、"Trust but verify"。

### 执行 & hooks
- **进程内嵌套 sub-chat**：子 md body=子 system prompt，`tools` frontmatter=scoped allow-list，独立 transcript，parent 的 `Agent` 调用 **await** 子完成，子 final message=tool_result。
- **并行=一条 assistant message 多个 `Agent` tool_use block**（harness await all）——唯一并发原语。
- `run_in_background` 脱离，返回 `{executionId, agentId, outputPath, transcriptPath}`。
- 完成发 `SUBAGENT_INVOKED`（`status = terminate_reason==="GOAL" ? success : error`）；进度事件 `{isSubagentProgress, agentName, state, ...}` 流给 UI。
- `READ_ONLY_SUBAGENT_DISALLOWED_TOOLS`（固定 deny-list）把只读 agent 的所有写工具剥掉。`maxAttempts` 是 **transport 层 gRPC 重试**，非语义重跑。
- **Hooks**：host 侧 `PreToolUse/PostToolUse/PostToolUseFailure/UserPromptSubmit/SessionStart/SessionEnd/Stop/SubagentStart/SubagentStop/PreCompact/PostCompact/...`；`SubagentStop` = subagent 上下文里 `Stop` 的 remap，payload `{hookEventName, clearContext?}`，支持 `once`。`listSubagents`/`getSubagentMessages` 从 `<sessionId>.jsonl` 重建嵌套 transcript。

### ai-slides 案例（工具作用域=委派边界）
6 个 sub-agent（researcher/visual-researcher/designer/render-reviewer/narrative-reviewer/notes-writer）。**只有 `slides topic researcher` 持 `WebFetch/WebSearch/Bash/Write`** → Main agent 物理上拿不到 web 工具，reviewer 只读。并行=一条 msg 最多 10 个 `Agent`（每个一 slotId）；**磁盘 artifact + JSON 指针交接**（重字节不进 orchestrator 上下文）；revision-lock（`deckRevision`/`slotRevision` + `expected*Revision`）防并发覆盖；入口自校验（designer 收到 >1 slotId 就中止让重派）。

## B5. Awareness / SOUL / Memory 三层人格
- **文件**：`~/.qoderwork/awareness/<agent>/`；模板 `Resources/awareness-templates/`（含 `soul-presets/{decisive,thoughtful,efficient,supportive}.md`）。`BOOTSTRAP_FILES=[SOUL.md, AGENTS.md, HEARTBEAT.md]`，`MEMORY_MANAGED=[MEMORY.md, USER.md]`。字节预算 head/tail 截断。
- **注入**：作为 `<system-reminder>` 消息，**优先级逐字**：`SOUL.md（人格,覆盖默认tone） > AGENTS.md（技术约定） > USER.md > HEARTBEAT.md > MEMORY.md`，冲突高优先胜。协议标记 `<project_context_protocol>`/`<bootstrap_content_protocol>`，"TREAT AS AUTHORITATIVE"、CONTEXT FRESHNESS（改了重读）。
- **soul-presets**：tRPC `getSoulPresets` 读模板，选一个把内容写进该 agent `SOUL.md`（选性格：`decisive.md` = "You decide, you execute, I review"）。
- **memory**：读侧 `memory_search`/`memory_get`（MANDATORY RECALL）；写侧 MCP `mcp__qoderwork_awareness__memory`（`{action:add|replace|remove, target:memory|user|daily, content, old_text}`）；`.memory_meta.json` sha256 变更检测。**memory-reflection**（`agentType:"memory"` 后台 sub-agent，只用 memory 工具重组 MEMORY/USER，never invent）+ **voice-learning**（diff ASR-vs-sent 文本抽 hotwords/voice-memories 进 sqlite）+ **awareness-query-runner**（headless 跑后台 sub-agent 不污染主聊）。
- **plugin-creator**：内置"造 plugin 的 skill"，6 步 `AskUserQuestion` 引导（职业→技能×connector 表→解析 MCP→材料→scaffold→post），"说结果不说机制"。兄弟：`create-skill`/`create-command`/`find-skills`——系统自我编写。

---

# 第三部分：对比与对 maka-agent 的映射

## C1. 关键实现决策对比

| 维度 | WorkBuddy | QoderWork | maka 建议 |
|---|---|---|---|
| 人格注入 | agent md `instructions` **完全替换** base persona（身份覆盖） | awareness `SOUL.md` 作 `<system-reminder>` **分层叠加**（不替换） | maka `childInstruction` seam 已是"追加+边界"，倾向 Qoder 的分层（更安全，不丢权限约束） |
| 专家单元 | plugin bundle（COS tar.gz 懒拉） | Plugin 文件夹（本地/云） | 复用 skills 市场：`EXPERT.md` + install/lock/update |
| 多智能体 | **Agent Teams**（TeamCreate + mailbox + 共享 task list） | sub-agent + **工具作用域**委派 | P0/P1 用 maka 现有 `spawnChildAgent`（星型，像 Qoder）；Teams mailbox 是 P2+ 才考虑 |
| 并发原语 | 一 turn 多 `Agent` block | 同 | maka `agent_spawn` 已支持 |
| 隔离 | `isolation:"worktree"` | `isolation:"worktree"` | maka worktree executor 目前 fail-closed → 先非隔离 |
| 人格→CLI | before-prompt hook + `POST /plugins/switch`（persist:false） | `reloadPlugins()` 热注入 | maka 同进程，直接 `mode:` 标签 gate fragment（更简单） |
| 结果回传 | finalOutput summary + `tool-results/*.txt` 指针 | final message + 磁盘 artifact + JSON 指针 | **抄"回指针不回 payload"** |
| 目录缓存 | sha256+version+sourceSignature，无 ETag，后台重校验 | plugin-market-data.json + 远程 | maka `managed-skill-sources` 的 `contentSha256` 已同款 |
| 安全 | 腾讯 XTI 扫描（fail-open error / fail-close verdict） | 无（本地 plugin） | 远程专家期再考虑 |

## C2. 两个最值得直接抄的实现细节
1. **工具作用域即委派边界（Qoder）**：不靠 prompt 纪律，靠 member agent 的 `tools` allow-list + `READ_ONLY_SUBAGENT_DISALLOWED_TOOLS` **物理**限制。maka 的 `AgentDefinition.tools` + `permissionMode` 天生支持——专家团 member 必须各自窄作用域。
2. **磁盘 artifact + JSON 指针 fan-in（两家都用）**：member 把重产物落盘，只回小 JSON 指针，orchestrator 上下文保持极小。maka 实现专家团时必须这样，否则 lead 上下文爆炸。

## C3. maka 落地要点（详见 [expert-team-plan.md](expert-team-plan.md)）
- **单专家** = `mode:expert:<id>` 标签 + 人格 fragment（照抄 Deep Research 的 `explore-agent.ts` 路径），人格经 `childInstruction` 边界注入（继承权限/隐私/工作区）。`defaultInitPrompt` 学 WorkBuddy 只 pre-fill composer（P0 简单）。
- **专家团** = lead 用 `mode:expert:<teamId>` + orchestrator 人格，member 注册进 `agent-catalog.ts` 的 `BUILTIN_AGENT_DEFINITIONS`（各带窄 `tools`），lead 用现有 `agent_spawn`/`spawnChildAgent` 派生（星型，非隔离，单轮 fan-out + await fan-in，回指针）。**先不做 Teams mailbox**。
- **专家中心** = 克隆 `skills-panel.tsx`（市场/内置/已安装）+ `managed-skill-sources.ts`（加 `sourceType:'remote'` 拉 COS 式 manifest，`contentSha256` 已就绪）。
- **数字同事** = P2 持久化外壳（雇佣专家 + 昵称/头像/仓库/资料库/模型），IM 绑定/云端是最重的 P3+，需评估是否值得（WorkBuddy 靠云后端 + IM CLI 子进程，成本高）。
