# EXECUTION.md（代理编排执行协议）

> 本文件定义：如何让任意 AI 工具"机械地"把一个 spec 的 PRD 全部执行完成。
> 默认行为：无人值守自动循环执行 PRD，直到全部完成或被阻塞。

## 一 目的与适用范围

### （一）目标

将「需求 → 执行 → 验收 → 留痕 → 提交」机械化，保证：

- 可审计（每次迭代都有日志与提交）
- 可回滚（可定位到每个 commit）
- 可度量（统计与完成率可计算）
- 可复用（不绑定项目名与工具）

### （二）边界

- 本文件只规范"执行层"（actions）
- specs（design/requirements/tasks）用于规划与对齐，不裁决执行状态

### （三）SSOT 口径

**唯一真相源**：

- 只包含 `prd.json` 与 `progress.txt`
- 固定存放在 `.ggbdpq/actions/<spec-name>/`

**执行协议**：

- 属于 required 基座资源，不是 SSOT
- 固定存放在 `.ggbdpq/required/execution/`

**路径裁决**：

- 任何路径裁决以 prd.json 中的 `optional_refs` 索引为准
- 避免多口径，不在其他文档中重复定义路径

## 二 默认执行模式

### （一）默认无人值守执行到完成

Agent 在满足以下条件时，**默认获得连续执行授权**，无需逐条请求用户确认：

- PRD priority ∈ {P0, P1, P2}
- 当前 iteration 未写入 statistics.blocked_reason
- 用户已触发执行（使用本文件作为执行法典即为授权信号）

授权生效后：

- Agent 不得在 PRD 之间主动暂停或询问
- 必须严格按执行循环连续执行
- 仅在命中暂停条件时允许中断

### （二）允许的自动行为集合

在遵守本仓库 PRD 与执行协议的前提下，明确授权代理执行以下行为：

1. **文件系统**
   - 在本仓库内创建、修改、删除任意文件
   - 允许修改：prd.json、progress.txt、配置文件、源码文件
   - 禁止访问或修改仓库目录之外的任何路径

2. **命令执行**
   - 允许执行 Node.js / pnpm / prisma 相关命令
   - 允许执行 git 命令（commit / status / diff）
   - 禁止自动安装未在 PRD 中声明的依赖或工具

3. **连续执行**
   - 允许连续执行多个 iteration
   - 执行过程中禁止因权限原因中断或反复请求确认

### （三）必须暂停的触发条件集合

遇到以下任一情况，**必须立即暂停**并等待人工介入：

| 触发条件 | 说明 |
|---------|------|
| blocked_reason 非空 | 需要用户输入/决策/外部依赖 |
| typecheck / tests 失败且无法自修复 | 连续 3 次修复尝试均失败 |
| 变更范围超出当前 PRD item | 检测到级联改动超过 50 个文件 |
| 涉及删除核心文件 | 删除 prd.json / progress.txt / AGENTS.md 等 |
| 需要引入 PRD 未声明的技术栈 | 必须在 Plan 中显式声明并获授权 |
| 需要网络请求外部 API | 必须获得显式授权 |
| 执行环境异常 | 命令无法运行、文件系统错误等 |
| 用户明确要求暂停 | 立即停止 |
| 本文件被修改 | 视为新执行会话 |

## 三 执行循环

### （一）目录契约

本 spec 的执行目录结构必须为：

- `.ggbdpq/actions/<spec-name>/`
  - `prd.json`（机器执行任务清单：唯一执行状态源）
  - `progress.txt`（执行留痕：append-only）

> `<spec-name>` 可为任意名称，不得在本协议中写死。

### （二）Iteration 定义

一次 iteration = 完成**一个** PRD item 的完整周期，必须包含：

1. 选择 1 个 PRD item
2. 实现其 steps
3. 运行并通过 typecheck
4. 追加 progress 记录（append-only）
5. 产生 1 次 git commit

缺一不可。否则该 iteration 无效。

### （三）选择 PRD item 的规则

从 `prd.json.items` 中选择"下一条要做的 item"：

1. 只从 `passes === false` 的 items 中选
2. 优先级：P0 > P1 > P2
3. 同优先级下，选择最小 id

如果不存在任何 `passes === false` 的 item：停止（SUCCESS）。

### （四）Iteration 步骤

**Step 1：选择 PRD item**

按选择规则选择目标 item，记录为 CURRENT_ITEM。

**Step 2：仅实现该 PRD**

只实现 CURRENT_ITEM.steps 中的要求：

- 不得改动与本 item 无关的代码与文档
- 不得顺手重构、顺手优化、顺手加功能

**Step 3：运行 typecheck**

```bash
pnpm typecheck
```

- 若失败：修复并重复 Step 3，直到通过
- 未通过之前，不得进入 Step 4

**Step 4：更新 PRD 状态**

若 CURRENT_ITEM 已完成且满足 steps 与 typecheck：

- 将该 item 的 passes 设为 true

若被阻塞：

- 保持 passes: false
- 写入 statistics.blocked_reason
- 停止（BLOCKED）

**Step 5：重算 statistics**

更新 prd.json.statistics，必须与 items 一致：

- total = items.length
- passing = count(passes === true)
- failing = count(passes === false)
- completion = round(passing / total * 100) + "%"

提交前必须校验：passing + failing === total

**Step 6：追加 progress 留痕**

在 progress.txt 末尾追加一段，必须包含：

- 日期时间
- 本次完成的 PRD：id / component / priority
- 做了什么（What）
- 为什么这样做（Why：关键决策）
- typecheck 结果摘要
- git commit message
- Next：下一条计划执行的 PRD

**Step 7：提交前门禁检查**

在执行 git commit 之前，必须全部通过以下检查：

1. 执行 `git status`：确认不存在 node_modules / dist / .vite 等构建产物
2. 执行 `git diff --stat`：确认变更量与当前 PRD item 强相关
3. 执行 `pnpm test` 或 `pnpm typecheck`

任一检查不通过：禁止提交，必须先修复。

### （五）Continue

若本 iteration 成功完成（未 blocked）：立即回到 Step 1。

## 四 约束与门禁

### （一）范围门禁

- 每个 iteration 只允许一个 `passes: false → true`
- 对应一个 commit
- 其他 items 的 passes 不得改动

### （二）安全门禁

- 禁止访问仓库外文件系统、网络敏感资源或用户私有数据
- 禁止自动安装未知来源工具或依赖
- 禁止修改本 EXECUTION.md 中的执行算法规则

### （三）变更门禁

- 不得引入 PRD 未声明的技术栈
- 扩大范围行为必须在 Plan 中显式声明并给出理由
- 任何模糊点必须转化为暂停条件或输入清单

### （四）失败门禁

- typecheck 失败：不得将 passes 改为 true
- tests 失败：立即 STOP
- 违反 append-only progress 规则：iteration 失败
- commit message 不符合中文规范：必须重写 commit

### （五）Git 提交规范

commit message 采用 Angular 风格：

```
<type>(<scope>): <subject>
```

- type 建议：feat / fix / docs / refactor / test / chore / build / ci
- scope 建议：core / engine / web / config / docs / actions / specs

**强制规则**：

- subject 必须使用中文
- 禁止使用纯英文提交说明
- 如包含英文术语，需配合中文说明

## 五 产物与记录

### （一）必须产出的工件

- 更新后的 prd.json（状态变更）
- 更新后的 progress.txt（append-only 留痕）
- 代码改动（若有）
- 每个 PRD 至少对应一个 git commit

### （二）最小可回滚策略

- 每个 PRD 对应一个 commit，可通过 git revert 回滚
- progress.txt 为 append-only，不存在回写
- 不允许 squash / rewrite 执行期间的 commit（除非人工介入）
- 所有 commit 可通过 PRD → Progress → Commit 链路追溯

## 六 测试纪律

1. 所有变更都需要测试支撑，包含修 bug、重构、新功能
2. 先写会失败的测试，覆盖预期行为与边界条件
3. 开始实现前，先确认失败原因正确
4. 新功能优先从 CLI 或接口层测试入手，再补核心逻辑单测
5. 保持小步提交，让测试持续保持绿色

## 七 降级策略

### （一）缺上下文时：只读评审

当 PRD 信息不完整、依赖不明确或存在歧义时：

- 切换为只读模式
- 仅进行代码分析与方案输出
- 不执行实际变更
- 在 progress.txt 记录降级原因

### （二）高风险时：停止并请求授权

当检测到以下情况时，必须停止并请求明确授权：

- 删除文件数量 > 5
- 改动文件数量 > 50
- 涉及核心配置（package.json 依赖变更、tsconfig 等）
- 需要执行破坏性命令（rm -rf、git reset --hard 等）

### （三）连续失败时：暂停并报告

当连续 3 个 iteration 均失败时：

- 立即暂停执行
- 在 progress.txt 记录失败链路
- 等待人工介入

## 八 常见任务模板

### （一）无人值守执行任务

```
严格按 .ggbdpq/required/execution/EXECUTION.md 机械执行：
自动循环 PRD，直到 SUCCESS 或 BLOCKED。
```

### （二）Cursor 启动口令

```
按 .ggbdpq/required/execution/EXECUTION.md 执行
```

### （三）多工具通用口令

```
严格按 .ggbdpq/required/execution/EXECUTION.md 机械执行：
自动循环 PRD，直到 SUCCESS 或 BLOCKED。
```

## 九 停止条件

### （一）STOP (SUCCESS)

不存在任何 `passes === false` 的 item。

完成态应满足：

- prd.json.items 全部 passes === true
- prd.json.statistics.completion === "100%"
- progress.txt 对每个 PRD 至少有一条对应记录
- git 历史中每个 PRD 至少对应一个 commit

### （二）STOP (BLOCKED)

本 iteration 需要用户输入/决策/外部依赖，无法继续。

blocked_reason 格式：

```
Blocked on <原因>. Need: <需要用户提供的输入/决策>.
```

当 iteration 成功完成：statistics.blocked_reason 必须清空为 ""。

## 附录：关键路径清单

```
.ggbdpq/actions/<spec-name>/prd.json
.ggbdpq/actions/<spec-name>/progress.txt
.ggbdpq/required/execution/EXECUTION.md
```
