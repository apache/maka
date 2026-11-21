---
name: agent-choreography-template
owner: ggbdpq
type: methodology-template
purpose: '将需求 → 执行 → 验收 → 留痕 → 提交 机械化完成'
pattern: 'planning → specs → actions'
language:
  primary: zh-CN
  allow: ['en', 'code', 'abbr']
compatibility:
  planning: ['planning-with-files', 'kiro']
  execution: ['cursor', 'claude-code', 'codex', 'gemini-cli', 'antigravity', 'windsurf', 'conductor']
---

# Agent Choreography Template

这是一个 **以文件为中心（file-driven）的代理编排方法论模板仓库**。

它的目标不是"让 AI 写代码"，而是：

> **定义一套可被 AI / Agent 机械执行的工程协议，  
> 把「需求 → 执行 → 验收 → 留痕 → 提交」稳定、可审计地跑通。**

---

## 核心思想（一句话版）

- **规划交给人（或规划型 Agent）**
- **执行交给执行型 Agent**
- **状态只认文件，不认对话**

---

## 为什么需要这套结构？

在实际使用 AI 工具（Cursor / Claude Code / Codex / Gemini CLI 等）时，常见问题是：

- 上下文容易丢失
- 执行标准不一致
- 一次做太多事，无法回滚
- 很难知道"做到哪一步了"
- 很难复盘或让别人接手

本仓库通过**明确分层 + 强文件约束**解决这些问题。

---

## 总体结构说明

```txt
<repo>/
├─ .ggbdpq/
│  ├─ specs/        # 规划层（人读为主）
│  └─ actions/      # 执行层（Agent 读为主）
│
├─ README.md        # ← 你正在看的这个文件（方法论入口）
└─ AGENTS.md        # 全局宪法（通用偏好与协作原则）
```

---

## specs：规划层（Design → Requirements → Tasks）

specs 用于想清楚要做什么，不直接参与执行状态判断。

```txt
.ggbdpq/specs/<spec-name>/
├─ design.md         # 方案 / 架构 / 取舍（How）
├─ requirements.md   # 需求 / 验收标准（What / Why）
└─ tasks.md          # 人类可读任务拆解（Do）
```

**职责边界：**

- `design.md`：解决"怎么做、为什么这么设计"
- `requirements.md`：解决"要做什么、如何验收"
- `tasks.md`：解决"要做哪些任务"（摘要视图）

**说明：**

- specs 可以由人手写
- 也可以由 planning-with-files、kiro 等规划型工具辅助生成
- specs 不裁决执行完成与否

---

## actions：执行层（机械执行 + 留痕）

actions 用于机械地把事情做完，是整个体系的执行核心。

```txt
.ggbdpq/actions/<spec-name>/
├─ EXECUTION.md      # ⭐ 代理编排执行协议（唯一执行入口）
├─ prd.json          # ⭐ 机器执行任务清单（执行真相源）
└─ progress.txt      # ⭐ 执行留痕（append-only）
```

**职责边界：**

- `EXECUTION.md`
  - 定义 iteration
  - 定义执行顺序与约束
  - 定义自动循环规则
  - 定义 blocked / success 条件
  - 定义多工具通用执行契约
- `prd.json`
  - 机器可执行的任务清单
  - 每个任务有明确 steps / priority / passes
  - 是"执行状态"的唯一来源
- `progress.txt`
  - 执行日志（只追加，不回写）
  - 用于审计、复盘、回滚依据

> ⚠️ 所有"是否完成"的判断，只认 actions 下的文件。

---

## AGENTS.md 的角色（全局宪法）

根目录的 AGENTS.md 是全局宪法文件：

- 定义通用协作原则
- 定义风格偏好
- 定义不可触碰的底线

它**不包含具体执行算法**，也**不绑定某个 spec**。
项目级的执行细节，全部放在 `actions/<spec>/EXECUTION.md`。

---

## 标准工作流（planning → specs → actions）

### 阶段 1：Planning（可选，但推荐）

使用 planning-with-files / Kiro 等工具，把思考外置到文件中：

- task_plan / notes / findings / progress
- 目标是：想清楚，不急着写代码

### 阶段 2：固化为 specs

将规划结果整理为：

- design.md
- requirements.md
- tasks.md

这一阶段适合人类 review、对齐共识。

### 阶段 3：落地到 actions

把 tasks 转换为机器可执行的：

- prd.json
- progress.txt
- EXECUTION.md

### 阶段 4：Agent 执行（自动循环）

对任意支持文件操作的 AI 工具输入：

```txt
严格按 .ggbdpq/actions/<spec-name>/EXECUTION.md 执行
```

Agent 将：

- 一次只完成一个 PRD
- typecheck → progress → commit
- 自动循环，直到 SUCCESS 或 BLOCKED

---

## 适用场景

- 复杂项目的分阶段交付
- 需要可审计 / 可回滚的 AI 辅助开发
- 多工具并存（Cursor / Claude / Codex / Gemini 等）
- 个人方法论沉淀为可复用模板
- 团队尝试 Agent 工程化协作

---

## 你应该从哪里开始？

1. 阅读本 README，理解整体分层
2. 查看 AGENTS.md，了解全局宪法
3. 进入某个 `.ggbdpq/actions/<spec>/EXECUTION.md`
4. 把它作为**唯一执行入口**

---

## 最后一句话

这不是一个"项目模板"，
而是一套"如何让 Agent 把项目稳定做完"的方法论。

如果你能理解并坚持这套分层，
AI 不再是"灵感来源"，而是可靠的执行者。
