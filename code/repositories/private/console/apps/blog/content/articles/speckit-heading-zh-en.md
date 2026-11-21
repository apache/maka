---
slug: speckit-heading-zh-en
title: "2026-08-17 Spec Kit 协议骨架标题中英对照"
series: "Spec 工作法"
source: spec-kit-me
date: 2026-08-17
excerpt: "问题：纯英文章节标题（尤其加粗标签）开会时不好读；纯中文标题又和 Spec Kit / 后端 / 终端对不上。"
---

# 2026-08-17 Spec Kit 协议骨架标题中英对照

**问题**：纯英文章节标题（尤其加粗标签）开会时不好读；纯中文标题又和 Spec Kit / 后端 / 终端对不上。  
**约定**：给人看的标题、加粗标签、验收三词写成 `中文（English）`；正文用简体中文。编号、文件名、接口字段不译。

本仓库规则：`.cursor/rules/speckit-zh-cn.mdc`。官方英文模板不要改：`.specify/templates/`（生成后再按本约定写成中文在前）。章程：`.specify/memory/constitution.md` 语言原则 I（v0.2.0）。

## 1. 一句话

中文管「人怎么读、怎么验」；括号里的英文管「这是哪一类文档、哪一节」。编号（`FR-001`）继续对齐三端。

```markdown
# 特性规格（Feature Specification）: 示例特性：智能回顾
### 用户故事 1（User Story 1）- 服务者讲解智能回顾，顾客感到被记住（Priority: P1）
## A. 智能回顾（Smart Recap）（P1）
## 1. 服务下发（Service Launch）
## 出口（Export）
## 属性（Props）
```

| 层级 | 语言 | 例子 |
| --- | --- | --- |
| 协议节 | `中文（English）` | `出口（Export）`、`属性（Props）`、`禁止（Forbidden）`、`前置（Prerequisites）`、`决策（Decision）` |
| 领域节 | `中文（English）` | `智能回顾（Smart Recap）`、`服务下发（Service Launch）` |
| 正文 | 中文 | 假如/当/则 后面的说明、表格单元格 |

不要再写成 `Comfort Memory - 智能回顾` 或只留英文标题。

## 2. 每个产物文件的 H1

冒号后面写中文业务名。括号里的英文协议词必须保留。

| 文件 | 写成 | 不要写成 |
| --- | --- | --- |
| `spec.md` | `特性规格（Feature Specification）:` | `Feature Specification:` 或 `特性规格：` |
| `plan.md` | `实现计划（Implementation Plan）:` | `Implementation Plan:` 或 `实现计划：` |
| `tasks.md` | `任务清单（Tasks）:` | `Tasks:` 或 `任务：` |
| `research.md` | `调研（Research）:` | `Research:` 或 `调研：` |
| 现网对照笔记 | `调研（Research）:` | `现网……对照研究`（无协议词） |
| `data-model.md` | `数据模型（Data Model）:` | `Data Model:` 或 `数据模型：` |
| `quickstart.md` | `快速验收（Quickstart）:` | `Quickstart:` 或 `快速开始：` |
| `contracts/*.md` | `契约（Contract）:` | `Contract:` 或 `契约：` |
| `checklists/requirements.md` | `规格质量清单（Specification Quality Checklist）:` | 纯英文 H1 或纯中文 H1 |

`contracts/` 文件名继续英文（如 `comfort-memory.md`），与代码模块同名。

## 3. spec.md

### 文头

| 写成 | 原英文 |
| --- | --- |
| 特性分支（Feature Branch） | Feature Branch |
| 创建日期（Created） | Created |
| 状态（Status） | Status |
| 草稿（Draft） | Draft |
| 输入（Input） | Input |
| 用户描述（User description） | User description |
| 来源（Sources） | Sources |

### 章节

| 写成 | 原英文 |
| --- | --- |
| 0. 阅读顺序（Reading Order） | 0. Reading Order |
| 1. 范围与边界（Scope and Boundaries） | 1. Scope and Boundaries |
| 1.1 本期包含（In Scope） | 1.1 In Scope |
| 1.2 本期不包含（Out of Scope） | 1.2 Out of Scope |
| 1.3 与其他模块的契约（Contracts with Other Modules） | 1.3 Contracts with Other Modules |
| 1.4 平台约束（Platform Constraints） | 1.4 Platform Constraints |
| 1.5 现网锚点（Production Anchors） | 1.5 Production Anchors |
| 1.6 继承、改变、新增（Inherit, Change, Add） | 1.6 Inherit, Change, Add |
| 1.7 不变量（Invariants） | 1.7 Invariants |
| 澄清记录（Clarifications） | Clarifications |
| 场次（Session） | Session |
| 用户场景与测试（User Scenarios & Testing） *(mandatory)* | User Scenarios & Testing *(mandatory)* |
| 用户故事 N（User Story N） | User Story |
| 优先级（Priority） | Priority |
| 为何优先（Why this priority） | Why this priority |
| 独立验收（Independent Test） | Independent Test |
| 验收场景（Acceptance Scenarios） | Acceptance Scenarios |
| 边界情况（Edge Cases） | Edge Cases |
| 需求（Requirements） *(mandatory)* | Requirements *(mandatory)* |
| 功能需求（Functional Requirements） | Functional Requirements |
| 关键实体（Key Entities） | Key Entities |
| 成功标准（Success Criteria） *(mandatory)* | Success Criteria *(mandatory)* |
| 可度量结果（Measurable Outcomes） | Measurable Outcomes |
| 假设（Assumptions） | Assumptions |
| 依赖与风险（Dependencies and Risks） | Dependencies and Risks |
| 验收对照（Acceptance Mapping） | Acceptance Mapping |

`*(mandatory)*` 保留，表示必填章节。正文、表格单元格、验收句子用中文。

### 验收句式

| 写成 | 怎么记 |
| --- | --- |
| 假如（Given） | 已经怎样 |
| 当（When） | 用户做了什么 |
| 则（Then） | 必须看到什么 |

三词连用，括号里的英文不要删，方便和 003 对齐：

```markdown
1. **假如（Given）** 报告已生成且本次有可用历史数据，**当（When）** 服务者进入「智能回顾」，**则（Then）** 页面展示固定标题……
```

## 4. plan.md

| 写成 | 原英文 |
| --- | --- |
| 分支（Branch） | Branch |
| 日期（Date） | Date |
| 规格（Spec） | Spec |
| 说明（Note） | Note |
| 摘要（Summary） | Summary |
| 技术上下文（Technical Context） | Technical Context |
| 语言/版本（Language/Version） | Language/Version |
| 主要依赖（Primary Dependencies） | Primary Dependencies |
| 存储（Storage） | Storage |
| 测试（Testing） | Testing |
| 目标平台（Target Platform） | Target Platform |
| 项目类型（Project Type） | Project Type |
| 性能目标（Performance Goals） | Performance Goals |
| 约束（Constraints） | Constraints |
| 规模/范围（Scale/Scope） | Scale/Scope |
| 章程门禁（Constitution Check） | Constitution Check |
| 门禁（GATE） | GATE |
| 通过（PASS） | PASS（表格单元格里的 PASS / N/A 可保持原样，作为门禁取值） |
| 不适用（N/A） | N/A |
| 项目结构（Project Structure） | Project Structure |
| 文档（本特性）（Documentation (this feature)） | Documentation (this feature) |
| 源码（Source Code） | Source Code |
| 结构决策（Structure Decision） | Structure Decision |
| 复杂度跟踪（Complexity Tracking） | Complexity Tracking |

阶段 0 = 调研（写出 `research.md`）。阶段 1 = 设计（写出 `data-model.md`、`contracts/`、`quickstart.md`）。

## 5. tasks.md

| 写成 | 原英文 |
| --- | --- |
| 输入（Input） | Input |
| 前置（Prerequisites） | Prerequisites |
| 测试（Tests） | Tests |
| 组织方式（Organization） | Organization |
| 格式（Format） | Format |
| 路径约定（Path Conventions） | Path Conventions |
| 阶段 1：搭建（Phase 1: Setup） | Phase 1: Setup |
| 共用骨架（Shared Infrastructure） | Shared Infrastructure |
| 阶段 2：基础能力（Phase 2: Foundational） | Phase 2: Foundational |
| 阻塞前置（Blocking Prerequisites） | Blocking Prerequisites |
| 关键（CRITICAL） | CRITICAL |
| 目的（Purpose） | Purpose |
| 目标（Goal） | Goal |
| 检查点（Checkpoint） | Checkpoint |
| 用户故事 N 的实现（Implementation for User Story N） | Implementation for User Story N |
| 依赖（Depends on） | Depends on |
| 最小可交付（MVP） | MVP |
| 收口与横切（Polish & Cross-Cutting Concerns） | Polish & Cross-Cutting Concerns |
| 依赖与执行顺序（Dependencies & Execution Order） | Dependencies & Execution Order |
| 并行示例（Parallel Example） | Parallel Example |
| 实施策略（Implementation Strategy） | Implementation Strategy |
| 先做最小可交付（MVP First） | MVP First |
| 增量交付（Incremental Delivery） | Incremental Delivery |
| 多人并行（Parallel Team Strategy） | Parallel Team Strategy |
| 备注（Notes） | Notes |

## 6. research / data-model / quickstart / contract

`/speckit-plan` 还会写出这几类文件。H1 中文在前，正文中文。

| 写成 | 出现位置 |
| --- | --- |
| 决策（Decision） | `research.md` 每条 |
| 理由（Rationale） | `research.md` 每条 |
| 考虑过的替代方案（Alternatives considered） | `research.md` 每条 |
| 已有现网对照，不重开调研（Existing research (do not re-open)） | `research.md` 文头 |
| 实体关系（Entity Relationships） | `data-model.md` |
| 前置（Prerequisites） | `quickstart.md` |
| 实现仓库（Implementation repo） | `quickstart.md` |
| 消费方（Consumer） | `contracts/*.md` |
| 来源（Source） | `contracts/*.md`、现网对照笔记 |
| 索引（Index） | 现网对照笔记 |
| 日期 / 规格 / 用途（Date / Spec / Purpose） | 文头元数据 |

`research.md` 里编号小节写成 `中文（English）`。`data-model.md` 里各实体名称中文在前。`contracts/` 里业务小节同样中文在前。

## 7. checklists/requirements.md

分类标题中文在前，方便开会勾选；括号英文方便和官方 `/speckit-specify` 清单结构对上。勾选句子用中文。

| 写成 | 原英文 |
| --- | --- |
| 规格质量清单（Specification Quality Checklist） | Specification Quality Checklist |
| 用途（Purpose） | Purpose |
| 创建日期（Created） | Created |
| 特性（Feature） | Feature |
| 内容质量（Content Quality） | Content Quality |
| 需求完整性（Requirement Completeness） | Requirement Completeness |
| 特性就绪（Feature Readiness） | Feature Readiness |
| 备注（Notes） | Notes |
| NEEDS CLARIFICATION | 需要澄清（规格里应清掉这个标记；标记本身不译） |

条目中文固定为：无实现细节、聚焦用户价值、面向非技术干系人、需求可测试、成功标准可度量、已定义全部验收场景等。勾选含义与英文原文相同。

## 8. 编号与标记（一律不译）

| 写法 | 含义 |
| --- | --- |
| FR-001 | Functional Requirement，功能需求编号 |
| SC-001 | Success Criterion，成功标准编号 |
| T001 | Task，任务编号 |
| US1 | User Story 1 |
| P1 / P2 / P3 | Priority，优先级（1 最高） |
| [P] | Parallel，可并行 |
| [US1] | 这条任务属于 User Story 1 |
| `- [ ]` / `- [x]` | 未完成 / 已完成 |
| *(mandatory)* | 必填章节 |

代码事实同样不译：`launchId`、`ComfortMemory`、文件路径、接口名、命令名 `/speckit-plan`。

## 9. 章程里常见词

出现在 `.specify/memory/constitution.md` 和 `plan.md` 的章程门禁（Constitution Check）。章程文件自身的 `Core Principles` / `Governance` 跟官方模板对齐，保持英文层级标题。

| 写成 | 原英文 |
| --- | --- |
| 章程（Constitution） | Constitution |
| 核心原则（Core Principles） | Core Principles（章程 H2 仍用英文模板名） |
| 治理（Governance） | Governance（章程 H2 仍用英文模板名） |
| 版本 / 批准日 / 最近修订日（Version / Ratified / Last Amended） | Version / Ratified / Last Amended |

本仓库章程仍是占位稿。语言原则是：给人看的标题与加粗标签用简体中文，括号保留英文协议词。

## 10. 和 003 合并时怎么用

对同一条能力，三端对齐靠编号和括号里的英文协议词，不靠纯英文标题，也不靠纯中文标题：

- 003 的 `用户故事（User Story）` / `FR-*` / `SC-*` 与 001 重叠处，以 001 已写清的规则为准
- 不要删掉 `假如（Given）` / `当（When）` / `则（Then）` 括号里的英文再去对 003
- 质量清单分类标题同样中文在前；勾选条目继续用中文
