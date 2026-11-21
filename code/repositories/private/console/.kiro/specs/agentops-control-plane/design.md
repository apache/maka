# Design Document: AgentOps Control Plane

## Decision: Runtime

### 选择

**选择 B：本地 Node 后端 + Vite 前端**

### 原因

1. **技术成熟度**：Node.js 生态成熟，前后端分离架构被广泛验证，团队熟悉度高
2. **开发效率**：Vite + React 的开发体验优秀，热更新快速，无需学习 Tauri/Rust
3. **调试便利**：前后端可独立调试，问题定位更清晰
4. **部署灵活**：可轻松扩展为远程服务（虽然 MVP 不需要）
5. **依赖简单**：仅需 Node.js 环境，无需 Rust 工具链

### 权衡

| 维度 | Node 后端 + Vite 前端 | Tauri 桌面壳 |
|------|----------------------|--------------|
| 启动复杂度 | 需启动两个进程 | 单一可执行文件 |
| 跨进程通信 | HTTP/WebSocket | Tauri IPC |
| 原生能力 | 需要后端桥接 | 直接调用系统 API |
| 打包体积 | 较大（Node 运行时） | 较小 |
| 学习曲线 | 低 | 中（需了解 Rust/Tauri） |

### 替代方案

- **Tauri 桌面壳**：适合需要更原生体验的场景，但 MVP 阶段开发成本较高
- **Electron**：类似 Tauri 但体积更大，不推荐
- **纯前端 + 浏览器 File System Access API**：兼容性差，功能受限

---

## Decision: FS_ROOT 边界与约束

### 定义

- `FS_ROOT`：Control Plane 允许访问的文件系统根目录
- 默认值：当前工作目录（`process.cwd()`）
- 可通过环境变量 `CONTROL_PLANE_FS_ROOT` 覆盖

### 只读约束

Control Plane **严格只读**，不对以下目录进行任何写入操作：

- `.ggbdpq/actions/**`
- `.kiro/specs/**`

### 允许读取的目录

| 目录 | 用途 |
|------|------|
| `.ggbdpq/actions/**` | 读取 prd.json、progress.txt、EXECUTION.md |
| `.kiro/specs/**` | 读取 requirements.md、design.md、tasks.md |

### 禁止行为

- ❌ 读取 FS_ROOT 之外的任意路径
- ❌ 写入任何文件（除 `tests/tmp` 等测试目录）
- ❌ 执行任何修改文件系统状态的操作

---

## Decision: File Watch 实现边界

### 监听范围

仅监听以下目录：

- `.ggbdpq/actions/**`
- `.kiro/specs/**`

### 事件模型

| 事件类型 | 触发条件 |
|----------|----------|
| `add` | 新文件创建 |
| `change` | 文件内容修改 |
| `unlink` | 文件删除 |
| `addDir` | 新目录创建 |
| `unlinkDir` | 目录删除 |

### 去抖策略

- **去抖时间**：500ms（与 requirements.md 的响应时间要求对齐）
- **实现方式**：收到事件后启动 500ms 计时器，期间有新事件则重置计时器
- **批量处理**：计时器到期后，一次性处理所有累积的变更事件

### 错误降级策略

| 错误场景 | 降级行为 |
|----------|----------|
| watch 库初始化失败 | 禁用自动刷新，提供手动刷新按钮 |
| 监听目录不存在 | 显示提示信息，继续监听父目录 |
| 事件处理异常 | 记录错误日志，不中断监听 |
| 资源耗尽（fd 限制） | 降级为轮询模式（间隔 5s） |

### 技术选型

- **首选**：chokidar（Node.js 下成熟稳定）
- **备选**：fs.watch（标准库，但跨平台行为不一致）

---

## Decision: Git 信息获取实现边界

### 可用性判断

在使用 Git 功能前，必须进行可用性检查：

| 检查项 | 判定方法 | 失败时行为 |
|--------|----------|------------|
| Git 命令可用 | 执行 `git --version` | 标记为 `git_unavailable` |
| 当前目录是 Git 仓库 | 检查 `.git` 目录存在 | 标记为 `not_git_repo` |
| 有读取权限 | 执行 `git status` | 标记为 `git_permission_denied` |

### 返回状态定义

```typescript
type GitAvailability = 
  | { available: true }
  | { available: false; reason: 'git_unavailable' | 'not_git_repo' | 'git_permission_denied' }
```

### 失败时行为

当 Git 不可用时，**不猜测、不编造**，而是返回 `unverifiable` 状态：

```typescript
interface GitQueryResult<T> {
  status: 'success' | 'unverifiable'
  data?: T
  reason?: string
}
```

### 合规性检查降级

| 检查项 | Git 可用时 | Git 不可用时 |
|--------|-----------|--------------|
| one-prd-per-commit | 检查并报告 passed/failed | 返回 unverifiable |
| commit-convention | 检查并报告 passed/failed | 返回 unverifiable |
| 审计链路 | 完整构建 PRD↔Progress↔Commit | 仅构建 PRD↔Progress |

### 技术选型

- **首选**：simple-git（Node.js 下 API 友好）
- **备选**：直接调用 git 命令行

---

## Overview

AgentOps Control Plane 是一个 AI Agent 执行与编排中枢的**可视化、审计与治理层**。它不是执行引擎，而是执行过程的"观察者"和"审计员"。

### 系统定位

Control Plane 在整体架构中的角色：

```
┌─────────────────────────────────────────────────────────────┐
│                    AgentOps 系统架构                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │   Specs     │    │   Actions   │    │  Control    │     │
│  │   Layer     │    │   Layer     │    │   Plane     │     │
│  │             │    │             │    │             │     │
│  │ • design    │    │ • prd.json  │    │ • 可视化    │     │
│  │ • require-  │    │ • progress  │    │ • 审计      │     │
│  │   ments     │    │ • EXECUTION │    │ • 治理      │     │
│  │ • tasks     │    │             │    │ • 度量      │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│        │                  │                  ▲              │
│        │                  │                  │              │
│        ▼                  ▼                  │              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              File System (唯一真相源)                │   │
│  │  .kiro/specs/          .ggbdpq/actions/             │   │
│  └─────────────────────────────────────────────────────┘   │
│                           ▲                                 │
│                           │ 读取                            │
│                           │                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              AI Agent (执行者)                       │   │
│  │  Cursor / Claude / Kiro / Codex / ...               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 与传统系统的区别

| 维度     | 传统后台/DevOps/CI | AgentOps Control Plane             |
| -------- | ------------------ | ---------------------------------- |
| 真相源   | 数据库 / API 状态  | 文件系统（prd.json, progress.txt） |
| 执行者   | 人类 / CI Pipeline | AI Agent                           |
| 状态管理 | 主动写入数据库     | 被动读取文件                       |
| 裁决逻辑 | 系统内置规则引擎   | 无裁决，仅展示文件状态             |
| 部署模式 | 云端服务           | 本地开发环境                       |

### 核心设计原则

1. **文件即真相**：所有状态来源于文件系统，Control Plane 不维护独立状态
2. **只读不写**：Control Plane 只读取和展示，不修改执行状态文件
3. **无裁决逻辑**：不引入额外的业务规则判断，完全依赖 EXECUTION.md 定义
4. **实时同步**：通过文件监听实现近实时的状态更新

## Architecture

### 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Control Plane 架构                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                   React Frontend                     │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │   │
│  │  │  Spec   │ │   PRD   │ │Progress │ │Dashboard│   │   │
│  │  │  View   │ │  View   │ │Timeline │ │  View   │   │   │
│  │  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘   │   │
│  │       │           │           │           │         │   │
│  │  ┌────┴───────────┴───────────┴───────────┴────┐   │   │
│  │  │              State Management               │   │   │
│  │  │         (React Context / Zustand)           │   │   │
│  │  └────────────────────┬────────────────────────┘   │   │
│  └───────────────────────┼────────────────────────────┘   │
│                          │                                 │
│  ┌───────────────────────┼────────────────────────────┐   │
│  │                 Service Layer                       │   │
│  │  ┌────────────────────┴────────────────────────┐   │   │
│  │  │              File Parser Service             │   │   │
│  │  │  • PRD JSON Parser                          │   │   │
│  │  │  • Progress TXT Parser                      │   │   │
│  │  │  • Markdown Parser                          │   │   │
│  │  └─────────────────────────────────────────────┘   │   │
│  │  ┌─────────────────────────────────────────────┐   │   │
│  │  │           File Watcher Service              │   │   │
│  │  │  • chokidar / fs.watch                      │   │   │
│  │  └─────────────────────────────────────────────┘   │   │
│  │  ┌─────────────────────────────────────────────┐   │   │
│  │  │           Git Integration Service           │   │   │
│  │  │  • simple-git / isomorphic-git              │   │   │
│  │  └─────────────────────────────────────────────┘   │   │
│  │  ┌─────────────────────────────────────────────┐   │   │
│  │  │           Compliance Checker Service        │   │   │
│  │  │  • 合规性规则验证                            │   │   │
│  │  └─────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                 │
│  ┌───────────────────────┼────────────────────────────┐   │
│  │              File System (Read Only)                │   │
│  │  .kiro/specs/          .ggbdpq/actions/             │   │
│  │  └── */                └── */                       │   │
│  │      ├── requirements.md   ├── prd.json            │   │
│  │      ├── design.md         ├── progress.txt        │   │
│  │      └── tasks.md          └── EXECUTION.md        │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 前端职责

| 模块              | 职责                        | 数据来源                                |
| ----------------- | --------------------------- | --------------------------------------- |
| Spec View         | 展示 specs 目录下的规划文档 | `.kiro/specs/*/`                        |
| PRD View          | 展示 PRD 列表和完成状态     | `prd.json`                              |
| Progress Timeline | 展示执行时间线              | `progress.txt`                          |
| Iteration View    | 展示单 PRD 执行周期         | `prd.json` + `progress.txt` + `git log` |
| Milestone View    | 展示多 PRD 聚合视图         | `prd.json`                              |
| Compliance View   | 展示合规性检查结果          | `prd.json` + `progress.txt` + `git log` |
| Audit View        | 展示审计链路                | `prd.json` + `progress.txt` + `git log` |
| Dashboard         | 展示统计与度量              | `prd.json.statistics`                   |

### 文件系统在架构中的地位

文件系统是整个系统的**唯一真相源**：

```
┌─────────────────────────────────────────────────────────────┐
│                    文件系统结构                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  project-root/                                              │
│  ├── .kiro/                                                 │
│  │   └── specs/                    # Specs Layer            │
│  │       └── {spec-name}/                                   │
│  │           ├── requirements.md   # 需求定义               │
│  │           ├── design.md         # 设计文档               │
│  │           └── tasks.md          # 任务清单               │
│  │                                                          │
│  ├── .ggbdpq/                                               │
│  │   └── actions/                  # Actions Layer          │
│  │       └── {spec-name}/                                   │
│  │           ├── EXECUTION.md      # 执行协议（只读）        │
│  │           ├── prd.json          # PRD 状态（真相源）      │
│  │           └── progress.txt      # 执行留痕（append-only） │
│  │                                                          │
│  └── .git/                         # Git 历史               │
│      └── ...                       # commit 记录            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### 核心组件

#### 1. FileWatcherService

负责监听文件系统变更：

```typescript
interface FileWatcherService {
  // 开始监听指定目录
  watch(paths: string[]): void

  // 停止监听
  unwatch(): void

  // 文件变更事件
  onFileChange(callback: (event: FileChangeEvent) => void): void
}

interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink'
  path: string
  timestamp: Date
}
```

#### 2. PRDParserService

解析 prd.json 文件：

```typescript
interface PRDParserService {
  // 解析 prd.json 文件
  parse(filePath: string): Promise<PRDDocument>

  // 验证 prd.json 结构
  validate(content: unknown): ValidationResult
}

interface PRDDocument {
  items: PRDItem[]
  statistics: PRDStatistics
}

interface PRDItem {
  id: string
  component: string
  priority: 'P0' | 'P1' | 'P2'
  steps: string[]
  passes: boolean
}

interface PRDStatistics {
  total: number
  passing: number
  failing: number
  completion: string // e.g., "75%"
  blocked_reason: string
}
```

#### 3. ProgressParserService

解析 progress.txt 文件：

```typescript
interface ProgressParserService {
  // 解析 progress.txt 文件
  parse(filePath: string): Promise<ProgressEntry[]>
}

interface ProgressEntry {
  datetime: Date
  prdId: string
  component: string
  priority: 'P0' | 'P1' | 'P2'
  what: string
  why: string
  typecheckResult: string
  commitMessage: string
  next: string
  rawContent: string
}
```

#### 4. GitService

读取 Git 历史：

```typescript
interface GitService {
  // 获取 commit 列表
  getCommits(options?: GitLogOptions): Promise<GitCommit[]>

  // 获取单个 commit 详情
  getCommit(hash: string): Promise<GitCommit>

  // 获取文件在某个 commit 的内容
  getFileAtCommit(filePath: string, commitHash: string): Promise<string>
}

interface GitCommit {
  hash: string
  message: string
  author: string
  date: Date
  files: string[]
}
```

#### 5. ComplianceCheckerService

检查执行合规性：

```typescript
interface ComplianceCheckerService {
  // 检查所有合规性规则
  checkAll(context: ComplianceContext): Promise<ComplianceReport>

  // 检查单个规则
  checkRule(rule: ComplianceRule, context: ComplianceContext): Promise<ComplianceResult>
}

interface ComplianceContext {
  prdDocument: PRDDocument
  progressEntries: ProgressEntry[]
  gitCommits: GitCommit[]
}

interface ComplianceReport {
  rules: ComplianceResult[]
  summary: {
    passed: number
    failed: number
    unverifiable: number
  }
}

interface ComplianceResult {
  rule: ComplianceRule
  status: 'passed' | 'failed' | 'unverifiable'
  details: string
  violations?: ComplianceViolation[]
}

type ComplianceRule = 'one-prd-per-commit' | 'typecheck-gate' | 'append-only-progress' | 'commit-convention'
```

#### 6. AuditService

构建审计链路：

```typescript
interface AuditService {
  // 构建 PRD -> Progress -> Commit 链路
  buildAuditTrail(context: AuditContext): Promise<AuditTrail[]>

  // 检查链路完整性
  checkIntegrity(trails: AuditTrail[]): IntegrityReport
}

interface AuditTrail {
  prdItem: PRDItem
  progressEntries: ProgressEntry[]
  gitCommits: GitCommit[]
  integrity: 'complete' | 'partial' | 'broken'
}

interface IntegrityReport {
  totalPRDs: number
  completeTrails: number
  partialTrails: number
  brokenTrails: number
  completionRate: string
}
```

### 前端组件接口

#### 视图组件

```typescript
// Spec 管理视图
interface SpecViewProps {
  specName: string
}

// PRD 列表视图
interface PRDViewProps {
  prdDocument: PRDDocument
  filter?: PRDFilter
}

interface PRDFilter {
  passes?: boolean
  priority?: 'P0' | 'P1' | 'P2'
}

// Progress 时间线视图
interface ProgressTimelineProps {
  entries: ProgressEntry[]
  dateRange?: DateRange
}

// Iteration 视图
interface IterationViewProps {
  iteration: Iteration
}

interface Iteration {
  prdItem: PRDItem
  progressEntry: ProgressEntry
  gitCommit: GitCommit
  isValid: boolean
}

// Milestone 聚合视图
interface MilestoneViewProps {
  milestone: Milestone
}

interface Milestone {
  name: string
  prdItems: PRDItem[]
  statistics: {
    total: number
    completed: number
    completion: string
  }
}

// 合规性视图
interface ComplianceViewProps {
  report: ComplianceReport
}

// 审计视图
interface AuditViewProps {
  trails: AuditTrail[]
  integrityReport: IntegrityReport
}

// 仪表盘视图
interface DashboardProps {
  statistics: PRDStatistics
  trends: TrendData[]
}
```

## Data Models

### 核心数据模型

#### PRD 文档模型

```typescript
/**
 * PRD 文档结构
 * 对应 prd.json 文件
 */
interface PRDDocument {
  /** PRD 条目列表 */
  items: PRDItem[]

  /** 统计信息 */
  statistics: PRDStatistics
}

/**
 * 单个 PRD 条目
 */
interface PRDItem {
  /** 唯一标识符 */
  id: string

  /** 所属组件/模块 */
  component: string

  /** 优先级 */
  priority: 'P0' | 'P1' | 'P2'

  /** 实现步骤 */
  steps: string[]

  /** 是否通过（boolean，非数字） */
  passes: boolean
}

/**
 * PRD 统计信息
 * 直接读取，不进行二次计算
 */
interface PRDStatistics {
  /** 总数 */
  total: number

  /** 通过数 */
  passing: number

  /** 未通过数 */
  failing: number

  /** 完成百分比（字符串格式，如 "75%"） */
  completion: string

  /** 阻塞原因（空字符串表示未阻塞） */
  blocked_reason: string
}
```

#### Progress 记录模型

```typescript
/**
 * Progress 记录条目
 * 对应 progress.txt 中的单条记录
 */
interface ProgressEntry {
  /** 记录时间 */
  datetime: Date

  /** 关联的 PRD ID */
  prdId: string

  /** 关联的组件 */
  component: string

  /** 优先级 */
  priority: 'P0' | 'P1' | 'P2'

  /** 做了什么 */
  what: string

  /** 为什么这样做 */
  why: string

  /** typecheck 结果 */
  typecheckResult: string

  /** git commit message */
  commitMessage: string

  /** 下一条计划执行的 PRD */
  next: string

  /** 原始文本内容 */
  rawContent: string
}
```

#### Iteration 模型

```typescript
/**
 * Iteration 模型
 * 一个 Iteration = 完成一个 PRD_Item 的完整周期
 */
interface Iteration {
  /** 关联的 PRD 条目 */
  prdItem: PRDItem

  /** 关联的 Progress 记录 */
  progressEntry: ProgressEntry | null

  /** 关联的 Git Commit */
  gitCommit: GitCommit | null

  /** Iteration 是否有效（包含完整的 5 个步骤） */
  isValid: boolean

  /** 无效原因（如果 isValid 为 false） */
  invalidReason?: string
}
```

#### Milestone 模型

```typescript
/**
 * Milestone 模型
 * 多个 PRD_Item 的聚合视图
 */
interface Milestone {
  /** Milestone 名称 */
  name: string

  /** 分组规则 */
  groupBy: 'priority' | 'component' | 'custom'

  /** 包含的 PRD 条目 */
  prdItems: PRDItem[]

  /** 聚合统计 */
  statistics: {
    total: number
    completed: number
    completion: string
  }
}
```

#### 合规性模型

```typescript
/**
 * 合规性规则类型
 */
type ComplianceRule =
  | 'one-prd-per-commit' // 一次一个 PRD
  | 'typecheck-gate' // typecheck 门禁
  | 'append-only-progress' // append-only progress
  | 'commit-convention' // commit 规范

/**
 * 合规性检查结果
 */
interface ComplianceResult {
  /** 规则类型 */
  rule: ComplianceRule

  /** 检查状态 */
  status: 'passed' | 'failed' | 'unverifiable'

  /** 详细说明 */
  details: string

  /** 违规列表（如果 status 为 failed） */
  violations?: ComplianceViolation[]
}

/**
 * 单个违规记录
 */
interface ComplianceViolation {
  /** 违规类型 */
  type: ComplianceRule

  /** 关联的 Iteration */
  iteration?: Iteration

  /** 违规描述 */
  description: string

  /** 建议修复方式 */
  suggestion: string
}
```

#### 审计链路模型

```typescript
/**
 * 审计链路
 * PRD -> Progress -> Git Commit 的完整追溯
 */
interface AuditTrail {
  /** 关联的 PRD 条目 */
  prdItem: PRDItem

  /** 关联的 Progress 记录列表 */
  progressEntries: ProgressEntry[]

  /** 关联的 Git Commit 列表 */
  gitCommits: GitCommit[]

  /** 链路完整性 */
  integrity: 'complete' | 'partial' | 'broken'

  /** 完整性问题描述（如果 integrity 不是 complete） */
  integrityIssues?: string[]
}

/**
 * 链路完整性报告
 */
interface IntegrityReport {
  /** 总 PRD 数 */
  totalPRDs: number

  /** 完整链路数 */
  completeTrails: number

  /** 部分链路数 */
  partialTrails: number

  /** 断裂链路数 */
  brokenTrails: number

  /** 完整率 */
  completionRate: string
}
```

#### Spec 文档模型

```typescript
/**
 * Spec 文档集合
 */
interface SpecDocument {
  /** Spec 名称 */
  name: string

  /** 目录路径 */
  path: string

  /** requirements.md 内容 */
  requirements: string | null

  /** design.md 内容 */
  design: string | null

  /** tasks.md 内容 */
  tasks: string | null

  /** 文档完整性 */
  completeness: {
    hasRequirements: boolean
    hasDesign: boolean
    hasTasks: boolean
  }
}
```

## Non-Goals (Explicit Non-Goals)

以下功能明确不在本系统范围内：

### 1. 执行引擎

- ❌ 不实现 PRD 执行算法
- ❌ 不实现 Iteration 循环逻辑
- ❌ 不实现 typecheck 执行
- ❌ 不实现 git commit 操作

**原因**：执行逻辑由 EXECUTION.md 定义，由 AI Agent 执行。Control Plane 只负责可视化。

### 2. 状态写入

- ❌ 不修改 prd.json
- ❌ 不修改 progress.txt
- ❌ 不创建 git commit

**原因**：Control Plane 是只读层，不作为执行状态的真相源。

### 3. 用户体系

- ❌ 不实现用户注册/登录
- ❌ 不实现权限管理
- ❌ 不实现多租户

**原因**：本系统面向本地开发环境，单用户使用。

### 4. 云端部署

- ❌ 不假设云端服务器
- ❌ 不实现远程 API
- ❌ 不实现数据同步

**原因**：所有设计必须可在本地开发环境中成立。

### 5. 数据库

- ❌ 不引入关系型数据库
- ❌ 不引入 NoSQL 数据库
- ❌ 不引入缓存层

**原因**：文件系统是唯一真相源。

### 6. 计费系统

- ❌ 不实现计费逻辑
- ❌ 不实现订阅管理
- ❌ 不实现使用量统计（用于计费）

**原因**：本系统是开发工具，不是商业产品。

### 7. 裁决逻辑

- ❌ 不引入额外的业务规则判断
- ❌ 不覆盖 EXECUTION.md 的定义
- ❌ 不对"是否完成/是否阻塞"进行二次裁决

**原因**：所有状态判断完全来自 actions 层文件。

## Correctness Properties

_A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees._

基于需求分析，以下是本系统需要满足的核心正确性属性：

### Property 1: Spec 目录扫描一致性

_For any_ `.kiro/specs/` 目录结构，Control Plane 返回的 Spec 列表应与文件系统中实际存在的 spec 目录完全一致（包括数量和名称）。

**Validates: Requirements 1.1, 1.2**

### Property 2: PRD JSON 解析一致性

_For any_ 有效的 prd.json 文件，解析后的 PRDDocument 对象应与原始 JSON 内容完全一致，包括：

- items 数组的长度和每个 item 的所有字段
- statistics 对象的所有字段值

**Validates: Requirements 3.1, 3.2**

### Property 3: Progress TXT 解析一致性

_For any_ 有效的 progress.txt 文件，解析后的 ProgressEntry 数组应：

- 保持与原始文件相同的记录顺序
- 每条记录包含所有必需字段（datetime, prdId, component, priority, what, why, typecheckResult, commitMessage, next）

**Validates: Requirements 4.1, 4.2**

### Property 4: 无裁决逻辑（数据直接展示）

_For any_ prd.json 文件，Control Plane 展示的以下数据应与文件内容完全一致，不进行任何二次计算或裁决：

- statistics.completion 百分比
- statistics.blocked_reason 内容
- 每个 item 的 passes 状态

即使 statistics 与 items 的实际状态不一致，也应展示 statistics 中的值。

**Validates: Requirements 2.2, 3.3, 5.2, 11.2**

### Property 5: 文件变更响应

_For any_ 被监听目录中的文件变更事件（创建、修改、删除），Control Plane 应在 500ms 内更新相关视图，且更新后的视图状态应与变更后的文件内容一致。

**Validates: Requirements 1.3, 2.3, 3.5, 4.5, 5.4, 7.4, 8.1, 8.2, 8.3**

### Property 6: PRD 过滤正确性

_For any_ PRD 列表和过滤条件（passes 状态、priority），过滤结果应：

- 仅包含满足所有过滤条件的 PRD_Item
- 不遗漏任何满足条件的 PRD_Item
- 保持原始顺序

**Validates: Requirements 3.4**

### Property 7: Iteration 构建与验证

_For any_ PRD_Item、Progress 记录和 Git Commit 的组合：

- 如果三者通过 PRD ID 和 commit message 正确关联，则 Iteration.isValid 应为 true
- 如果缺少任一关联（无对应 progress 或无对应 commit），则 Iteration.isValid 应为 false

**Validates: Requirements 6.1, 6.2, 6.4, 6.5**

### Property 8: Milestone 聚合计算

_For any_ Milestone 分组规则和 PRD 列表：

- Milestone.statistics.total 应等于该分组内 PRD_Item 的数量
- Milestone.statistics.completed 应等于该分组内 passes: true 的 PRD_Item 数量
- Milestone.statistics.completion 应等于 completed / total 的百分比

**Validates: Requirements 7.1, 7.2, 7.3**

### Property 9: 合规性检查正确性

_For any_ Iteration 数据：

- 如果一个 commit 对应多个 passes 变更，则 'one-prd-per-commit' 规则应标记为 failed
- 如果 progress 记录中 typecheckResult 包含失败信息但 passes 为 true，则 'typecheck-gate' 规则应标记为 failed
- 如果 commit message 不符合 Angular 风格，则 'commit-convention' 规则应标记为 failed

**Validates: Requirements 9.1, 9.2, 9.3**

### Property 10: 审计链路完整性

_For any_ PRD_Item：

- 如果存在对应的 progress 记录和 git commit，则 AuditTrail.integrity 应为 'complete'
- 如果仅存在部分关联，则 AuditTrail.integrity 应为 'partial'
- 如果完全无关联，则 AuditTrail.integrity 应为 'broken'

IntegrityReport.completionRate 应等于 completeTrails / totalPRDs 的百分比。

**Validates: Requirements 10.4, 10.5**

### Property 11: 双向链路查询

_For any_ 审计链路中的关联关系：

- 从 PRD_Item 查询应返回所有关联的 progress 记录和 git commit
- 从 progress 记录查询应返回关联的 PRD_Item 和 git commit
- 从 git commit 查询应返回关联的 PRD_Item 和 progress 记录
- 三个方向的查询结果应保持一致性（A 关联 B 则 B 也关联 A）

**Validates: Requirements 10.1, 10.2, 10.3**

## Error Handling

### 文件系统错误

| 错误类型                      | 处理策略                             |
| ----------------------------- | ------------------------------------ |
| 文件不存在                    | 显示"文件未找到"提示，标记为缺失状态 |
| 文件读取权限不足              | 显示权限错误提示，建议检查文件权限   |
| 文件格式错误（JSON 解析失败） | 显示解析错误详情，展示原始内容       |
| 文件监听失败                  | 显示监听错误提示，提供手动刷新选项   |

### 数据一致性错误

| 错误类型                            | 处理策略                               |
| ----------------------------------- | -------------------------------------- |
| prd.json statistics 与 items 不一致 | 原样展示 statistics，不进行修正        |
| progress.txt 格式不规范             | 尽可能解析，无法解析的字段标记为"未知" |
| blocked_reason 格式不符合规范       | 原样展示内容，标记格式警告             |

### Git 集成错误

| 错误类型         | 处理策略                               |
| ---------------- | -------------------------------------- |
| 非 Git 仓库      | 禁用 Git 相关功能，显示提示信息        |
| Git 命令执行失败 | 显示错误信息，相关功能降级为"无法验证" |
| Commit 历史过大  | 分页加载，限制单次查询数量             |

### 合规性检查错误

| 错误类型          | 处理策略                     |
| ----------------- | ---------------------------- |
| 无法获取 Git 历史 | 相关规则标记为"无法验证"     |
| 数据关联失败      | 标记为"链路断裂"，不进行推断 |

## Testing Strategy

### 测试框架选择

- **单元测试**: Vitest
- **属性测试**: fast-check
- **组件测试**: React Testing Library
- **E2E 测试**: Playwright（可选）

### 测试层次

```
┌─────────────────────────────────────────────────────────────┐
│                    测试金字塔                                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    /  E2E 测试  \        ← 关键用户流程      │
│                   / 组件集成测试 \       ← 视图组件          │
│                  /   属性测试     \      ← 核心逻辑          │
│                 /    单元测试      \     ← 解析器/服务       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 属性测试配置

每个属性测试必须：

- 运行至少 100 次迭代
- 使用 fast-check 生成随机输入
- 标注对应的设计文档属性编号

```typescript
// 示例：Property 2 测试
describe('PRD JSON 解析一致性', () => {
  it('Property 2: 解析后的数据应与原始 JSON 完全一致', () => {
    // Feature: ops-panel, Property 2: PRD JSON 解析一致性
    fc.assert(
      fc.property(arbitraryPRDDocument(), prdDoc => {
        const json = JSON.stringify(prdDoc)
        const parsed = PRDParserService.parse(json)
        return deepEqual(parsed, prdDoc)
      }),
      { numRuns: 100 }
    )
  })
})
```

### 单元测试覆盖

| 模块                     | 测试重点                      |
| ------------------------ | ----------------------------- |
| PRDParserService         | JSON 解析、字段验证、边界情况 |
| ProgressParserService    | 文本解析、字段提取、格式容错  |
| ComplianceCheckerService | 各规则检查逻辑、边界情况      |
| AuditService             | 链路构建、完整性检查          |
| FileWatcherService       | 事件触发、防抖处理            |

### 组件测试覆盖

| 组件             | 测试重点                     |
| ---------------- | ---------------------------- |
| PRDView          | 列表渲染、过滤功能、状态展示 |
| ProgressTimeline | 时间线渲染、时间过滤         |
| ComplianceView   | 违规标记、报告展示           |
| AuditView        | 链路展示、完整性标记         |
| Dashboard        | 指标展示、阻塞警告           |

### 测试数据生成

使用 fast-check 生成器创建测试数据：

```typescript
// PRD 文档生成器
const arbitraryPRDItem = (): fc.Arbitrary<PRDItem> =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 10 }),
    component: fc.string({ minLength: 1, maxLength: 20 }),
    priority: fc.constantFrom('P0', 'P1', 'P2'),
    steps: fc.array(fc.string(), { minLength: 1, maxLength: 5 }),
    passes: fc.boolean(),
  })

const arbitraryPRDDocument = (): fc.Arbitrary<PRDDocument> =>
  fc.record({
    items: fc.array(arbitraryPRDItem(), { minLength: 1, maxLength: 20 }),
    statistics: arbitraryPRDStatistics(),
  })
```
