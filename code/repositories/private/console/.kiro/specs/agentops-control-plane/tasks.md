# Tasks Document

> 本文档是 AgentOps Control Plane 的 **Implementation Plan**（实现计划），用于把 requirements.md / design.md 落成可机械执行的任务列表。  
> 原则：**任务必须可被 Agent 完全机械执行**（可验证、可回滚、可审计）。

---

## 任务执行总原则（必须遵守）

- [ ] 所有状态裁决以文件为准：`.ggbdpq/actions/**/prd.json` + `progress.txt`（Control Plane 只读展示，不引入新裁决逻辑）
- [ ] 任何需要"人工判断/主观选择"的地方，必须先落到 **Blocking Decision**，否则后续任务视为 **BLOCKED**
- [ ] 每个阶段必须有可机械验收的 Checkpoint（pnpm typecheck / pnpm test / fixtures 覆盖）
- [ ] 所有路径与 spec-name 不允许写死（必须通过 `<spec-name>`、配置或自动发现实现）

---

## Task 0：Blocking Decision（运行形态与实现边界）

> 未完成 Task 0，禁止进入 Task 1+。否则视为越权执行。

- [ ] 0.1 确定运行形态（二选一，并写入 `design.md` 的 "Decision: Runtime" 小节）
  - [ ] 选择 A：Tauri 桌面壳（前端可直接调用 fs/watch/shell 能力）
  - [ ] 选择 B：本地 Node 后端 + Vite 前端（后端提供 REST/WebSocket；前端仅通过 HTTP/WS 访问）
  - [ ] 在 `design.md` 写清楚：runtime 选择、原因、权衡、替代方案
- [ ] 0.2 定义只读 FS Root（文件系统访问边界）
  - [ ] 定义 `FS_ROOT`（默认：当前工作目录；允许配置覆盖）
  - [ ] 约束：所有读取必须在 `FS_ROOT` 内（禁止读取用户任意路径）
  - [ ] 约束：Control Plane **只读**（禁止写入 `.ggbdpq/actions/**` 与 `.kiro/specs/**`）
- [ ] 0.3 定义 File Watch 边界与策略
  - [ ] 监听范围仅限：`.ggbdpq/actions/**` 与 `.kiro/specs/**`
  - [ ] 事件合并策略：500ms debounce（与 requirements 的 500ms 对齐）
  - [ ] 定义降级：watch 不可用时允许手动刷新（仍需保持只读）
- [ ] 0.4 定义 Git 信息获取边界
  - [ ] 定义"可用/不可用"的判定（如非 git repo / 无 git 命令 / 权限不足）
  - [ ] 定义降级：Git 不可用则相关功能标记"无法验证"
- [ ] 0.5 创建平台抽象层接口（与运行形态解耦）
  - [ ] 建立 `src/platform/` 目录
  - [ ] 定义 `IPlatformFS`（readFile/readDir/exists/stat）
  - [ ] 定义 `IPlatformWatch`（watch/onEvent/dispose）
  - [ ] 定义 `IPlatformGit`（getCommits/getCommit/isGitRepo）
  - [ ] 提供 runtime 对应实现：Tauri 或 Node（由 0.1 决策决定）
- [ ] 0.6 建立测试 Fixtures（用于机械验收）
  - [ ] 建立 `tests/fixtures/`（模拟 `.ggbdpq/actions/<spec-name>/` 与 `.kiro/specs/<spec-name>/`）
  - [ ] 提供最小可用 fixture：包含 prd.json、progress.txt、requirements/design/tasks 示例

**Checkpoint 0（必须通过）**

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过（至少覆盖 Task 0 的 FS_ROOT、watch 边界、git 降级）
- [ ] Fixtures 可被测试正常读取与解析

---

## Task 1：项目骨架与开发规范（MVP 起步）

- [ ] 1.1 初始化项目结构（React + TS + Vite）
- [ ] 1.2 引入 UI 基础（Tailwind + shadcn/ui）
- [ ] 1.3 引入路由与页面框架（React Router）
- [ ] 1.4 引入状态管理与数据层（TanStack Query + Zustand）
- [ ] 1.5 引入测试框架（Vitest）
- [ ] 1.6 定义基础类型（与 design 的 Data Models 对齐，放入 `src/models/`）

**Checkpoint 1**

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过（至少 1 个 sanity test）
- [ ] 能启动开发环境（Vite dev）并渲染基础页面壳

---

## Task 2：Spec 读取与展示（.kiro/specs）

> 只读展示，不裁决完成状态。

- [ ] 2.1 实现 Spec 发现：扫描 `.kiro/specs/` 得到 spec 列表
- [ ] 2.2 实现 Spec 读取：读取 requirements.md/design.md/tasks.md（缺失文件要提示）
- [ ] 2.3 UI：Spec List + Spec Detail（Markdown 展示）
- [ ] 2.4 监听 `.kiro/specs/**` 变更并自动刷新（若 watch 不可用则提供手动刷新）

**Checkpoint 2**

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过（fixtures：完整 spec / 缺失文件 spec / 空目录）
- [ ] UI 能正确显示 spec 列表与详情，缺失文件有明确提示

---

## Task 3：Actions 扫描与 PRD 读取（.ggbdpq/actions）

> 执行状态以 prd.json + progress.txt 为准。

- [ ] 3.1 实现 actions spec 发现：扫描 `.ggbdpq/actions/` 下所有 `<spec-name>` 目录
- [ ] 3.2 读取并解析 `prd.json.items`
- [ ] 3.3 读取并解析 `prd.json.statistics`（**直接读取，不二次裁决**）
- [ ] 3.4 UI：Actions 列表 + Spec 选择器（切换不同 `<spec-name>`）
- [ ] 3.5 监听 `.ggbdpq/actions/**` 文件变更并刷新视图

**Checkpoint 3（你要求的机械验收点）**

- [ ] `pnpm typecheck` + `pnpm test` 通过
- [ ] Fixtures 覆盖：actions spec 目录、prd.json、progress.txt 的读取与解析

---

## Task 4：PRD 视图（列表、过滤、排序、完成度展示）

- [ ] 4.1 PRD 列表：展示 id/component/priority/passes
- [ ] 4.2 过滤：passes（true/false）、priority（P0/P1/P2）
- [ ] 4.3 排序：priority（P0>P1>P2）+ id 升序
- [ ] 4.4 概览：展示 `prd.json.statistics.completion`（仅展示，不计算）
- [ ] 4.5 空状态与异常提示：文件损坏/字段缺失/JSON parse error

**Checkpoint 4**

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过（空列表、单条、多条、过滤场景）

---

## Task 5：Progress 时间线视图（progress.txt）

- [ ] 5.1 定义 progress.txt 的解析规则（按你 EXECUTION.md 的字段：时间、PRD、What/Why、typecheck、commit、Next）
- [ ] 5.2 时间线 UI：按时间倒序展示（新记录在顶部）
- [ ] 5.3 支持时间范围过滤
- [ ] 5.4 点击条目展示详情（原文 + 结构化字段）

**Checkpoint 5**

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过（fixtures：多条 progress、格式不完整、未知字段）

---

## Task 6：Blocked 展示（blocked_reason）

- [ ] 6.1 当 `prd.json.statistics.blocked_reason` 非空：在 UI 醒目展示 BLOCKED
- [ ] 6.2 原样展示 blocked_reason（不解释、不裁决），格式不符时标记"格式警告"
- [ ] 6.3 同时展示"应执行的下一条 PRD"（按 priority+id 的选择规则计算 **仅用于展示**）

**Checkpoint 6**

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过（blocked_reason 空/非空/格式错误）

---

## Task 7：Iteration 视图（单 PRD 的执行周期链路）

- [ ] 7.1 从 progress.txt 中抽取 iteration（每条记录对应一次 iteration）
- [ ] 7.2 关联：PRD_Item ↔ progress 记录 ↔ git commit（若 git 不可用则降级为"无法验证"）
- [ ] 7.3 标记无效 iteration：缺少 select/implement/typecheck/progress/commit 任一步
- [ ] 7.4 UI：Iteration 列表 + 详情面板

**Checkpoint 7**

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过（有效/无效 iteration、缺 git 情况）

---

## Task 8：Milestone 聚合视图（批次视角）

- [ ] 8.1 支持按 priority 分组聚合（P0/P1/P2）
- [ ] 8.2 支持自定义分组（基于 component 前缀或规则配置）
- [ ] 8.3 展示聚合统计：总数/完成数/百分比（允许计算聚合百分比）
- [ ] 8.4 支持趋势图（可选：先做简单趋势，复杂图表后置）

**Checkpoint 8（你要求的机械验收点）**

- [ ] `pnpm typecheck` + `pnpm test` 通过
- [ ] Fixtures 覆盖：合规/违规场景、断裂链路、聚合统计

---

## Task 9：执行合规性检查（Compliance）

- [ ] 9.1 一次一个 PRD：每个 commit 只对应一个 passes 变更（需要 git 可用；否则"无法验证"）
- [ ] 9.2 Typecheck 门禁：passes true 前必须有 typecheck 通过记录（从 progress.txt 解析）
- [ ] 9.3 Append-only progress：检测 progress.txt 是否存在历史回写（最小实现：hash/line-count 变化策略；详细策略写入 design）
- [ ] 9.4 Commit message 规范检查（Angular 风格；若 git 不可用则"无法验证"）
- [ ] 9.5 UI：合规性报告列表 + 违规详情

**Checkpoint 9**

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过（合规/违规/无法验证三类都覆盖）

---

## Task 10：审计与可追溯链路（PRD ↔ Progress ↔ Commit）

- [ ] 10.1 PRD 详情页：展示关联 progress 与 commit
- [ ] 10.2 progress 详情页：展示关联 PRD 与 commit
- [ ] 10.3 commit 详情页：展示关联 PRD 与 progress
- [ ] 10.4 断裂链路检测：标记缺失关系（不裁决，只报告）
- [ ] 10.5 导出映射表：CSV/JSON（导出内容以文件解析结果为准）

**Checkpoint 10**

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过（断裂链路 + 导出）

---

## Task 11：统计与度量仪表盘（Dashboard）

- [ ] 11.1 展示核心指标（completion 直接读取 prd.json.statistics.completion）
- [ ] 11.2 PRD 分布（P0/P1/P2 数量）
- [ ] 11.3 执行速率趋势（按 progress.txt 的日期聚合）
- [ ] 11.4 Blocked 警告（blocked_reason 非空即提示）
- [ ] 11.5 导出统计数据（CSV/JSON）

**Checkpoint 11**

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过（时间范围过滤、趋势聚合）

---

## 可选任务（\*）：用于更快 MVP（默认保留，不强制完成）

> 这些任务标记为可选（\*），优先实现核心链路：Spec/PRD/Progress/Blocked/Compliance。

- [ ] \*X.1 图表增强（Recharts）—— 仪表盘趋势图更完整
- [ ] \*X.2 更强的 progress.txt 解析容错（支持更多格式变体）
- [ ] \*X.3 性能优化（大文件/多 spec 的增量刷新策略）

---

## Final Checkpoint 24（最终机械验收）

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过（覆盖率 > 80%）
- [ ] `pnpm build` 通过
- [ ] 覆盖所有边界：空列表/单条/多条/缺失文件/损坏 JSON/blocked/git 不可用/无法验证/断裂链路
