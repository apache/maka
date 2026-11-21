# Requirements Document

## Introduction

AgentOps Control Plane 是一个 AI Agent 的执行与编排中枢系统的**可视化、审计与治理层**。系统以文件作为唯一真相源（Single Source of Truth），Control Plane 仅负责**展示与解析**文件状态，不引入新的裁决逻辑。

本文档定义了系统的功能需求与验收标准，所有需求必须与已冻结的执行法典（EXECUTION.md）完全一致。

## Glossary

- **Control_Plane**: Agent 执行与编排的可视化、审计与治理层，不作为执行状态的真相源
- **Spec**: 规划文档集合（`.kiro/specs/`），包含 requirements.md、design.md、tasks.md，用于规划与对齐
- **Action**: Agent 可执行的原子操作单元，执行状态存储于 `.ggbdpq/actions/`
- **PRD_Item**: prd.json 中的单个需求条目，包含 id、component、priority、steps、passes（boolean）
- **Progress**: 执行留痕记录（progress.txt），append-only 模式
- **Iteration**: 完成**一个** PRD_Item 的完整执行周期（select → implement → typecheck → progress → commit）
- **Milestone**: 多个 PRD_Item 的聚合视图，用于批次管理（非 Iteration）
- **Agent**: 执行任务的 AI 助手
- **File_System**: 本地文件系统，作为系统唯一真相源
- **Blocked_State**: 任务因依赖用户输入/决策/外部条件无法继续执行的状态，由 prd.json.statistics.blocked_reason 定义
- **Typecheck_Gate**: 类型检查门禁，passes 置为 true 前必须通过 pnpm typecheck

## Requirements

### Requirement 1: Spec 管理

**User Story:** As a 开发者, I want to 查看和管理 Spec 文档集合, so that I can 了解系统规划并追踪设计演进。

#### Acceptance Criteria

1. WHEN 用户访问 Spec 管理界面 THEN THE Control_Plane SHALL 展示所有 `.kiro/specs/` 目录下的 Spec 列表
2. WHEN 用户选择某个 Spec THEN THE Control_Plane SHALL 展示该 Spec 的 requirements.md、design.md、tasks.md 内容
3. WHEN Spec 文件发生变更 THEN THE Control_Plane SHALL 自动检测并更新展示内容
4. WHEN 用户查看 Spec 详情 THEN THE Control_Plane SHALL 高亮显示任务完成状态（已完成/进行中/未开始）
5. IF Spec 目录结构不完整 THEN THE Control_Plane SHALL 显示缺失文件的提示信息

### Requirement 2: Action 执行状态可视化

**User Story:** As a 开发者, I want to 实时查看 Action 的执行状态, so that I can 监控 Agent 的工作进度并及时发现问题。

#### Acceptance Criteria

1. WHEN 用户访问 Action 视图 THEN THE Control_Plane SHALL 从 `.ggbdpq/actions/` 目录读取并展示所有 Action 的执行状态
2. WHEN 展示 Action 状态 THEN THE Control_Plane SHALL 完全基于 prd.json 和 progress.txt 的文件内容，不引入额外裁决逻辑
3. WHEN Action 执行产生新的 progress 记录 THEN THE Control_Plane SHALL 实时检测 progress.txt 变更并更新展示
4. WHEN 用户查看 Action 历史 THEN THE Control_Plane SHALL 按 progress.txt 的 append-only 顺序展示所有记录
5. WHILE Action 正在执行（存在 passes: false 的 PRD_Item）THEN THE Control_Plane SHALL 展示当前执行中的 PRD_Item 信息

### Requirement 3: PRD 列表与完成度追踪

**User Story:** As a 产品经理或开发者, I want to 查看 PRD 列表及其完成度, so that I can 了解产品需求的实现进度。

#### Acceptance Criteria

1. WHEN 用户访问 PRD 视图 THEN THE Control_Plane SHALL 从 prd.json.items 读取并展示所有 PRD_Item 列表
2. WHEN 展示 PRD_Item THEN THE Control_Plane SHALL 显示每个条目的 passes 状态（boolean: true/false）
3. WHEN 展示 PRD 概览 THEN THE Control_Plane SHALL 直接读取并展示 prd.json.statistics 中的 completion 百分比，不进行二次计算
4. WHEN 用户筛选 PRD_Item THEN THE Control_Plane SHALL 支持按 passes 状态（true/false）和 priority（P0/P1/P2）过滤
5. WHEN prd.json 文件变更 THEN THE Control_Plane SHALL 自动检测并更新 PRD 视图，确保与文件状态一致

### Requirement 4: Progress 时间线展示

**User Story:** As a 开发者, I want to 查看任务执行的时间线, so that I can 回顾工作历史并分析执行效率。

#### Acceptance Criteria

1. WHEN 用户访问 Progress 视图 THEN THE Control_Plane SHALL 解析 progress.txt 并以时间线形式展示所有进度记录
2. WHEN 展示时间线条目 THEN THE Control_Plane SHALL 包含日期时间、PRD id/component/priority、What、Why、typecheck 结果、git commit message、Next
3. WHEN 用户选择时间范围 THEN THE Control_Plane SHALL 过滤并展示该范围内的进度记录
4. WHEN 用户点击时间线条目 THEN THE Control_Plane SHALL 展示该条目的完整详细信息
5. WHEN progress.txt 文件追加新记录 THEN THE Control_Plane SHALL 实时检测并追加到时间线顶部

### Requirement 5: Blocked 状态与原因展示

**User Story:** As a 开发者, I want to 清晰看到被阻塞的任务及其原因, so that I can 快速定位问题并采取行动解除阻塞。

#### Acceptance Criteria

1. WHEN prd.json.statistics.blocked_reason 非空 THEN THE Control_Plane SHALL 在界面醒目位置展示阻塞提示
2. WHEN 展示 Blocked 状态 THEN THE Control_Plane SHALL 直接显示 blocked_reason 字段内容，不进行额外解释或裁决
3. WHEN 存在 Blocked 状态 THEN THE Control_Plane SHALL 同时展示当前被阻塞的 PRD_Item（passes: false 且按选择规则应执行的 item）
4. WHEN blocked_reason 被清空 THEN THE Control_Plane SHALL 自动移除阻塞提示
5. IF blocked_reason 格式不符合规范 THEN THE Control_Plane SHALL 原样展示内容并标记格式警告

### Requirement 6: Iteration 视图（单 PRD 执行周期）

**User Story:** As a 开发者, I want to 查看单个 PRD_Item 的完整执行周期, so that I can 理解每次 Iteration 的执行过程。

#### Acceptance Criteria

1. WHEN 用户访问 Iteration 视图 THEN THE Control_Plane SHALL 展示每个 Iteration 的完整周期（select → implement → typecheck → progress → commit）
2. WHEN 展示 Iteration THEN THE Control_Plane SHALL 关联展示：PRD_Item 信息、对应的 progress 记录、对应的 git commit
3. WHEN 用户选择某个 Iteration THEN THE Control_Plane SHALL 展示该 Iteration 的详细执行步骤和结果
4. WHEN Iteration 未完成（缺少任一步骤）THEN THE Control_Plane SHALL 标记该 Iteration 为无效状态
5. WHEN 展示 Iteration 列表 THEN THE Control_Plane SHALL 按 progress.txt 的时间顺序排列

### Requirement 7: Milestone 聚合视图

**User Story:** As a 项目管理者, I want to 按批次查看多个 PRD_Item 的聚合进度, so that I can 从宏观视角追踪项目进展。

#### Acceptance Criteria

1. WHEN 用户访问 Milestone 视图 THEN THE Control_Plane SHALL 支持按 priority 或自定义分组展示 PRD_Item 聚合
2. WHEN 展示 Milestone THEN THE Control_Plane SHALL 显示该批次的 PRD_Item 数量、已完成数量、完成百分比
3. WHEN 用户定义 Milestone 分组规则 THEN THE Control_Plane SHALL 按规则动态聚合 PRD_Item
4. WHEN Milestone 内 PRD_Item 状态变更 THEN THE Control_Plane SHALL 实时更新聚合统计
5. WHEN 展示 Milestone 概览 THEN THE Control_Plane SHALL 支持进度趋势图展示

### Requirement 8: 文件系统监听与同步

**User Story:** As a 开发者, I want to 系统自动监听文件变更并同步状态, so that I can 无需手动刷新即可看到最新数据。

#### Acceptance Criteria

1. WHILE Control_Plane 运行 THEN THE File_System SHALL 被持续监听以检测 `.ggbdpq/actions/` 和 `.kiro/specs/` 目录的变更
2. WHEN 监听到文件变更 THEN THE Control_Plane SHALL 在 500ms 内更新相关视图
3. WHEN 文件被创建或删除 THEN THE Control_Plane SHALL 相应更新文件列表
4. IF 文件监听出现错误 THEN THE Control_Plane SHALL 显示错误提示并提供重试选项
5. WHEN 用户手动触发刷新 THEN THE Control_Plane SHALL 重新扫描文件系统并更新所有视图

### Requirement 9: 执行合规性检查

**User Story:** As a 平台管理者, I want to 验证 Agent 执行是否遵守执行法典, so that I can 确保执行过程的规范性和可审计性。

#### Acceptance Criteria

1. WHEN 用户访问合规性视图 THEN THE Control_Plane SHALL 检查并展示以下合规项状态：
   - 一次一个 PRD 规则（每个 commit 只对应一个 passes 变更）
   - Typecheck 门禁（passes: true 前必须通过 typecheck）
   - Append-only progress（progress.txt 无历史修改）
   - Commit 规范（Angular 风格 commit message）
2. WHEN 检测到合规性违规 THEN THE Control_Plane SHALL 在对应 Iteration 上标记违规类型和详情
3. WHEN 展示合规性报告 THEN THE Control_Plane SHALL 统计各类违规的数量和占比
4. WHEN 用户查看违规详情 THEN THE Control_Plane SHALL 展示违规的具体内容和建议修复方式
5. IF 无法确定是否违规（如缺少 git 历史）THEN THE Control_Plane SHALL 标记为"无法验证"状态

### Requirement 10: 审计与可追溯链路

**User Story:** As a 审计人员, I want to 追溯 PRD 到 progress 到 git commit 的完整链路, so that I can 验证执行过程的完整性和一致性。

#### Acceptance Criteria

1. WHEN 用户选择某个 PRD_Item THEN THE Control_Plane SHALL 展示该 PRD 关联的所有 progress 记录和 git commit
2. WHEN 用户选择某条 progress 记录 THEN THE Control_Plane SHALL 展示该记录关联的 PRD_Item 和 git commit
3. WHEN 用户选择某个 git commit THEN THE Control_Plane SHALL 展示该 commit 关联的 PRD_Item 和 progress 记录
4. WHEN 链路存在断裂（如 PRD 无对应 progress 或 commit）THEN THE Control_Plane SHALL 标记链路完整性问题
5. WHEN 展示审计报告 THEN THE Control_Plane SHALL 统计链路完整性指标（完整链路数 / 总 PRD 数）
6. WHEN 用户导出审计数据 THEN THE Control_Plane SHALL 支持导出 PRD ↔ progress ↔ commit 的完整映射表

### Requirement 11: 统计与度量仪表盘

**User Story:** As a 项目管理者, I want to 查看执行统计与度量数据, so that I can 评估执行效率和项目健康度。

#### Acceptance Criteria

1. WHEN 用户访问仪表盘 THEN THE Control_Plane SHALL 展示以下核心指标：
   - 总体完成度（直接读取 prd.json.statistics.completion）
   - PRD 分布（按 priority 统计 P0/P1/P2 数量）
   - 执行速率（每日/每周完成的 PRD 数量趋势）
2. WHEN 展示统计数据 THEN THE Control_Plane SHALL 确保所有数据来源于文件系统，不进行额外裁决
3. WHEN 用户选择时间范围 THEN THE Control_Plane SHALL 按范围过滤并重新计算趋势数据
4. WHEN 存在 Blocked 状态 THEN THE Control_Plane SHALL 在仪表盘醒目位置展示阻塞警告
5. WHEN 用户导出统计数据 THEN THE Control_Plane SHALL 支持导出 CSV/JSON 格式的统计报表
