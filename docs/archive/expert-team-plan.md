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

# 专家团 (Expert Team) — 调研与实现方案

> 目标：在 maka-agent 中实现"专家团 / 数字同事"功能。
> 本文基于对 **WorkBuddy**（腾讯 CodeBuddy 换皮）与 **QoderWork**（阿里 Qoder）两款已安装应用的逆向，
> 加上对 maka-agent 自身架构的映射，给出可落地的设计。
> 逆向原始 spec：`scratchpad/RE-workbuddy-experts.md`、`scratchpad/RE-qoderwork-agents.md`、`scratchpad/maka-architecture-map.md`。

---

## 1. 调研结论：两家怎么做的

### 1.1 WorkBuddy —— 完整的"专家中心 + 数字同事"（最值得抄）

WorkBuddy 有**两个不同层次**，不要混为一谈：

1. **专家 / 专家中心 (Expert Center)** —— 一个**市场目录**，331 个专家人格、13 个分类，托管在腾讯 COS。
   - Manifest：`https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace/expert_center.json`，
     并行拉取 `internalExpert.json` / `externalExpert.json` 合并（企业内/外部专家隔离），
     缓存到 `~/.workbuddy/app/cache/experts/`（sha256 + `cacheFormatVersion:2`）。
   - 每个专家 = 一个 **plugin bundle**（zip 懒加载解压），人格来自一个 **agent markdown**（`promptFile`）+ 头像 PNG。
   - `expertType` 两种：**`agent`（285 个，单人格）** 与 **`team`（46 个，即"专家团"）**。

2. **数字同事 / 云助理 (Digital Colleague)** —— 用户自建的**持久化助理**，它"雇佣(hire)"一个专家/专家团作为能力来源，
   拥有自己的昵称+头像+高级配置（专家/仓库/资料库/模型），可绑定 IM 渠道（QQ/微信/飞书/钉钉）、云端运行、被 @、被定时调度。
   —— 这是把"专家"产品化的外壳。（注：`collab-*` 模块是**人与人**的工作区协作，与专家无关。）

**专家条目 schema（关键字段）：**
```
id, categoryId, displayName{en,zh}, profession{en,zh}, description{en,zh},
promptFile,                # COS 相对路径，指向人格 md，如 /plugins/content-creator/agents/content-creator.md
avatar,                    # /avatars/ContentCreator.png
defaultInitPrompt{en,zh},  # 召唤后自动注入的第一条消息
quickPrompts[{en,zh}],     # 组合框里的建议起手 prompt
tags[{en,zh}],             # 能力标签 chip
expertType: "agent"|"team",
agentName, plugin,         # 指向 plugin 内的 subagent id
isOPC, operationalTag, visibility, author,
members[]                  # 仅 team 有
```

**专家团 (team) 的结构 —— 就是 orchestrator→worker 多智能体：**
```
members: [
  { id, displayName, profession, avatar, promptFile, role: "lead" | "member" }
]
```
- team 顶层的 `agentName`/`promptFile` 指向 **lead**；每个 member 有自己独立的人格 md。
- 运行时：**lead 作为唯一对话 agent**，通过 `Agent` 工具（`subagent_type = member.id`）派生 member 子代理。
- 协作协议写在 lead 的人格 prompt 里：`TeamCreate（建团，只能 lead 做）→ 顺序/并行调度成员 → 成员回传`，
  **星型拓扑**（所有跨成员信息经 lead 中转，成员之间不直连），lead 不模拟成员输出、只汇总。
- **没有服务端 router**——编排完全靠 lead 的人格 prompt，跑在本地 Claude-Code 式 subagent runtime 上。

**人格 md 格式**（不内联在 manifest，激活时才拉取）：YAML frontmatter + markdown body。
- frontmatter：`name, description, color(强调色), emoji, vibe`；team lead 额外 `maxTurns:200`。
- body 是**强身份覆盖**模板：`🚨 CRITICAL IDENTITY DIRECTIVE`（"你是 X 且只是 X，绝不暴露底层模型"）+
  `Role Definition / Core Capabilities / 内置 Skill 使用场景（自动触发的技能）/ Final Identity Reminder`。

**持久化**（sqlite `~/.workbuddy/workbuddy.db`）：`sessions` 表带 `expert_id / expert_locale /
expert_runtime_identity（人格快照，manifest 变了会话也钉住）/ expert_marketplace`；`automations` 也带 `expert_id`（定时任务可绑专家）。

### 1.2 QoderWork —— 没有"专家团"，但有可借鉴的分层

QoderWork **没有**命名人格选择器。它的三层值得参考：

| 层 | 单元 | 说明 |
|---|---|---|
| 人格/性格 | `awareness/`（`SOUL.md` 等 + soul-presets：果断/沉稳/高效/贴心） | 单 agent 身份调优 |
| 能力打包 | **Plugin（专家套件）** = Skills + Commands + Connectors(MCP) | "装一个角色的整个工具箱"，最接近"专家" |
| 运行时编排 | **Sub-agents**（`agents/*.md`，`Agent(subagent_type,...)` 派生） | 真·多智能体 |

- `plugin-creator` skill 原话："Skill 是一件工具，Plugin 是一个角色的整个工具箱。"按角色/行业分类（电商/产品/法务/财税）。
- `ai-slides` LegoKit 是教科书式 **orchestrator→worker 流水线**：6 个命名 subagent（researcher/designer/reviewer/notes-writer），
  硬性委派边界，单轮多 tool_use 块并行，**产物落盘 + JSON 指针交接（回传指针不回传大 payload）**。
- 可借鉴的具体做法：Markdown+frontmatter 的 agent 按 `description` 自动路由；单轮 fan-out + 等待 fan-in（**不要后台 detach**）；
  每个 worker 入口自校验；性格 preset；用 `AskUserQuestion` 引导"自建专家"。

---

## 2. maka-agent 现有可复用底座（三块几乎现成）

后端主轴（ARCHITECTURE.md）：`Desktop/TUI/Headless → SessionManager → AgentRun → Model + Tool Runtime → 事件日志 → 投影`。
存储是**文件/JSON**（无 sqlite）。

| 关注点 | 复用/扩展 | 位置 |
|---|---|---|
| 专家**人格注入** | `mode:` 标签 + prompt fragment（照抄 Deep Research） | `apps/desktop/src/main/system-prompt-main.ts`（已有 `childInstruction` seam）；`packages/core/src/explore-agent.ts`（`mode:deep_research` 先例） |
| 专家=**带工具作用域的专业 agent** | 扩展 `BUILTIN_AGENT_DEFINITIONS`（每条已带 `systemPrompt`） | `packages/runtime/src/agent-catalog.ts`、`subagent-tools.ts`（`agent_spawn`/`SessionManager.spawnChildAgent`） |
| 专家**目录 + 按需安装** | 克隆 managed/bundled 技能目录 | `apps/desktop/src/main/managed-skill-sources.ts`、`bundled-skill-catalog.generated.ts`、`skills.ts`（install→`skill.lock.json`→baseline→update diff，PR #842） |
| 专家**定义文件格式** | 复用 SKILL.md frontmatter 解析 | `packages/runtime/src/skills.ts`（`parseSkillFrontMatter`） |
| 专家**选择器 + 中心 UI** | 克隆"市场/内置/已安装"三 tab | `packages/ui/src/skills-panel.tsx`、`nav-selection.ts`、`session-sidebar-nav.tsx`、`module-pages.tsx` |
| 专家**聊天界面** | 普通会话 + expert 标签 | `packages/ui/src/chat-view.tsx`、`composer.tsx` |
| **非 UI 一致性**（CLI/headless） | 共享 runtime prompt builder，自动继承 | `packages/cli/src/cli-system-prompt.ts`、`packages/headless/src/tools.ts` |

**关键判断：**
1. maka 的 `agent-catalog.ts`（每个 `AgentDefinition` 带 `id/name/description/systemPrompt/tools/permissionMode`）
   与 WorkBuddy 的"专家 = 带人格的 subagent"**结构同构**。→ 单专家直接落在这里。
2. maka 的 subagent runtime（`spawnChildAgent` + `agent_spawn` 工具，父子 AgentRun）
   与 WorkBuddy team 的"lead 通过 Agent 工具派生 member"**结构同构**。→ 专家团直接落在这里。
3. maka 的技能市场（远程/内置目录 + `contentSha256` + install/lock/update）
   是"专家中心目录"**现成模板**，只差一个 `sourceType:'remote'` HTTP 拉取。
4. ⚠️ 约束：worktree 隔离的子代理目前 **fail closed**（没有 worktree executor）。专家团 member 先用**非隔离**子代理跑。

---

## 3. 推荐方案

### 3.1 数据模型：专家 = 一份 `EXPERT.md`（SKILL.md 同族）

一个专家一个目录，`EXPERT.md` = frontmatter + 人格 body：
```yaml
---
id: content-creator
displayName: { zh: 文博凯, en: Kai }
profession: { zh: 内容创作专家, en: Content Creator }
description: { zh: ..., en: ... }
category: 06-ContentCreative
avatar: avatar.png
color: teal            # 强调色（借 WorkBuddy）
expertType: agent      # agent | team
allowed-tools: [...]   # 声明式，不授予；PermissionEngine 仍是权威
quickPrompts: [{ zh, en }]
defaultInitPrompt: { zh, en }
# team 专用：
members:
  - { id, displayName, profession, promptFile, role: lead|member }
---
<身份指令 + Role / Capabilities / 内置技能触发场景 + 身份提醒>
```
- 复用 `parseSkillFrontMatter`（扩字段），复用技能的 install/lock/baseline/update 生命周期。
- 目录：内置 `bundled-expert-catalog.generated.ts`（复用 memory 里已逆向的 13 skills 那套种子流程）；
  managed `~/.maka/experts/<id>/EXPERT.md`；后续加 `sourceType:'remote'` 拉远程 manifest（COS 那套）。

### 3.2 运行时：单专家 vs 专家团

- **单专家（expertType=agent）**：给会话打 `mode:expert:<id>` 标签 → `system-prompt-main.ts` 按标签 gate 出人格 fragment，
  经 `childInstruction` 边界注入（继承权限/隐私/工作区约束）。**照抄 Deep Research 的 `mode:deep_research` 路径。**
  召唤时把 `defaultInitPrompt` 作为首条消息注入，`quickPrompts` 渲染成起手按钮。
- **专家团（expertType=team）**：lead 作为对话 agent（`mode:expert:<teamId>` + lead 人格），
  lead 人格 prompt 里写 orchestrator 协议（TeamCreate→派发→回传，星型），
  member 作为 `AgentDefinition` 注册进 catalog，lead 用现有 `agent_spawn` 派生（`subagent_type=member.id`）。
  **不后台 detach**：单轮 fan-out + 等待 fan-in（借 Qoder 教训）；member 回传落盘+指针。

### 3.3 UI

- 导航：`nav-selection.ts` 加 `{section:'experts'}`；`session-sidebar-nav.tsx` 加"专家团/同事"入口；`module-pages.tsx` 加 `ExpertsPage`。
- 专家中心：克隆 `skills-panel.tsx` 的 市场/内置/已安装 三 tab + 分类过滤 + 搜索 + 卡片"召唤"。
- 专家聊天：就是普通 `chat-view.tsx` 会话，带 expert 标签 + 头像 + `color` 强调色（借 `use-expert-theme` 思路，light/dark 感知）。

### 3.4 分期落地

| 阶段 | 交付 | 复用 |
|---|---|---|
| **P0 单专家 MVP** | `EXPERT.md` 格式 + 内置目录 + `mode:expert:` 注入 + 专家中心 UI + 召唤即聊 | Deep Research 注入路径、技能目录/UI、agent-catalog |
| **P1 专家团** | team schema + lead orchestrator 人格 + member 子代理派发（非隔离）+ 团队卡片 | `spawnChildAgent`/`agent_spawn`、subagent runtime |
| **P2 数字同事** | 持久化助理外壳（自建昵称/头像/雇佣专家/配置仓库·资料库·模型）+ 定时调度 | 会话标签、scheduled-task-store |
| **P3 远程专家中心 + 分享** | `sourceType:'remote'` 拉 COS 式 manifest + 缓存校验 + 自建专家导出/导入（安全扫描） | managed-skill-sources 远程化、lock/sha256 |
| **P4（可选）IM 绑定 / 云端 / @ 协作** | 绑 IM 渠道、云端运行、@ 数字同事 | 需新连接层，评估 |

### 3.5 待你拍板的分叉点

1. **专家人格的落点**：（a）纯 overlay = 标签会话 + 人格 fragment（最轻，先做）vs（b）数据驱动 `AgentDefinition` = 带独立工具作用域/权限（重，给"真·工具受限同事"）。建议 P0 走 (a)，P1 team member 走 (b)。
2. **专家团 member 隔离**：先接受非隔离（共享 cwd）还是先补 worktree executor？建议先非隔离，P1 后再评估隔离。
3. **目录来源**：先只做内置 + 本地 managed（P0），远程 COS 式 manifest 放 P3；还是一开始就上远程？

---

## 4. 一句话总结

WorkBuddy 的"专家 = 带身份覆盖人格的 subagent，专家团 = 一个 lead 星型编排多个 member subagent，专家中心 = COS 上的
plugin 市场，数字同事 = 雇佣专家的持久化助理外壳"。这套模型和 maka-agent 的
**agent-catalog（人格 subagent）+ spawnChildAgent（多智能体）+ 技能市场（目录/安装/锁）+ Deep Research（mode 注入）**
四块现有底座几乎一一对应，可分 4~5 期低风险落地。
