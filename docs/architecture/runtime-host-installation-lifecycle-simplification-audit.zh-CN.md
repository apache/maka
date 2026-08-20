---
doc_id: architecture.runtime-host-installation-lifecycle-simplification-audit
title: "Runtime Host 安装与更新生命周期简化审计"
language: zh-CN
source_language: zh-CN
implementation_status: mixed
document_status: draft
translation_status: source-only
last_verified: 2026-08-19
owners:
  - maka-backend
---

# Runtime Host 安装与更新生命周期简化审计

> 核心问题：当前候选实现为 CLI/TUI 增加 Host generation reconciliation 后，哪些概念可以在进入 PR review 前直接消失，哪些更大的统一仍缺少产品或 authority 决策？

本文只审计 `design/3231-runtime-host-update-lifecycle` 相对 `origin/main` 的候选实现及其直接相邻边界，不实施生产代码改动，也不把未来设计写成 implementation plan。审计读者是准备 review #3231、#3243、#3244、#3245 的维护者。

## 结论

没有 P0。一个 P1 已由 #3231/#3243 的明确 ownership 决策闭合：Desktop、installed CLI 与 TUI 的 local artifact selection、staging、replacement retry 和 verification 应收敛为一条 installation-owner flow，而不是让每个 Surface 各自拥有 lifecycle policy。这个 P1 承诺的是 authority 与 contract，不要求预先创建一个特定 class 或常驻 manager process。

当前 P1a 切片没有引入第二个 Runtime authority：Host Kernel 仍独占 State Root writer lease、activity、drain 和 retirement；TUI 只投影事实并收集用户决定；remote 仍由 operator 管理。

审计还发现两个可以在 PR 前单独处理的小型删除项，现已在 audit 结束后的本地 follow-up 中完成：

- P2：让 `installationScope` 成为 installation context 中 replacement authority 的唯一 representation，删除可推导的 `canReplaceLocalHost` 和未被消费者使用的公开 `provenance` 字段。
- P3：删除已经只被测试引用的 `shouldRetryRuntimeHostConflict()`，把 wait 解析保留在唯一的 restart/wait/cancel decision parser 中。

仍未决定的是 installation-owner flow 的具体 module shape，以及 `npx` 是否进入该 owner。把逻辑 authority 固化成名为 `Local Installation Manager` 的单一 class/process 不属于 P1 的必要条件。

## Coverage

| Architecture slice | Status | Demand chain 与证据 | 结论 |
|---|---|---|---|
| CLI package identity | Reviewed | `cli-core.ts` 消费 package root/version；`runtime-host-cli-context.ts` 消费 artifact generation 和 replacement eligibility；context tests 覆盖 release/development/`npx` | 存在两个多余公开字段，形成 P2 |
| Local connect/election | Reviewed | `connect-or-spawn.ts`、connection handshake、Host Kernel 与 candidate-generation tests | `generation` 与 `candidateGeneration` 语义不同，均有生产需求 |
| TUI conflict adapter | Reviewed | `runtime-host-tui-command.ts`、`runtime-host-tui-context.ts`、真实 PTY restart/wait/cancel probe | 旧 wait helper 已无生产消费者，形成 P3 |
| Desktop update/restart | Reviewed | `runtime-host-boot.ts`、`runtime-host-desktop-manager.ts`、`app-update-service.ts`、upgrade dialog tests | presentation 和 Electron updater 保留；artifact selection/retry 加入 P1 owner flow |
| npm/`npx` provenance | Reviewed | shared `_npx` detector、service installation guard、installation-context tests | detector 共享合理；durability contract 仍是 Decision gate |
| Managed remote service | Reviewed as adjacent boundary | `runtime-host-managed-deployment.ts`、service manager、`connectRemoteRuntimeHostProfile()` | staging 可作为未来复用证据，但 remote operator authority 不在本次删除范围 |
| 文档与测试 representation | Reviewed | 双语 design draft、CLI/Host tests、runtime probes | 删除字段和 helper 时对应断言与 Current 文案也可消失 |
| Storage migration/downgrade | Partial, out of candidate scope | 只核实 Host startup 与 #3227 的边界，未验证全部 released artifact | 不据此提出 rollback/downgrade simplification |

## P0

无。

## P1：把 local artifact lifecycle 收敛成一条 installation-owner flow

### 删除证明

| 问题 | 证据 |
|---|---|
| 当前 authority 与 consumers | Desktop 用 app version 请求 generation 并维护 restart/wait/cancel loop；CLI 从当前 package 启动 candidate；TUI 投影 conflict；managed deployment 已有 validate/stage/atomic-publish transaction |
| 当前需求链 | #3231 把 package switching 放在 installation-management plane；#3243 明确要求 one installation-owner flow，并要求并发更新收敛到一个 installation transition |
| 最强保留理由 | Desktop bundle、global CLI、TUI 和 `npx` 的 UI、签名、权限与进程生命周期不同，分别实现可以减少初期共享 contract |
| 为什么仍可删除 | Surface 差异只保留 presentation/package adapter；artifact identity、selection、fencing、staging、replacement verification 和并发 transition 是同一 authority。分别保留会在同一 State Root 上形成互相竞争的 owner policy |
| 消失内容 | Desktop-only Host-selection policy、CLI implicit current-package ownership、未来 TUI 自有 replacement loop、各入口重复的 package path/identity inference，以及各自的 transition state |
| 新增或移动内容 | 一条 machine/profile-local installation-owner contract；内部可以由受同一 lock/record 约束的深模块组成，不要求单一 class/process |
| 为什么是净减少 | 一个 selection fact、一把 transition lock 和一套 typed outcomes 取代多个需要彼此同步的 owner state；Runtime state、UI state 和 remote operator state 都不移入其中 |
| 放弃的能力 | Surface 不能仅凭自己的 product version 直接抢占 Host，也不能从临时/未验证 artifact 启动 durable replacement |
| 影响半径与不确定性 | Local Desktop/CLI/TUI startup 与 update；artifact integrity、跨平台 atomic switch 和 `npx` ownership 仍需独立证据，但不改变唯一 owner 的已确认边界 |

P1a 只建立 immutable CLI installation context、candidate generation 与 cross-epoch startup reconciliation。它是 owner flow 的一个 vertical slice，不代表 staging、selection record、same-epoch action 或 replacement verification 已完成。

## P2：删除 installation context 的重复 representation

### 删除证明

| 问题 | 证据 |
|---|---|
| 当前 authority | npm/package manifest 决定 package identity；`isTemporaryNpxInstallation()` 判断 package root 是否位于临时 `_npx` cache；Runtime Host handshake 决定能否 takeover |
| 当前 production consumers | `packageRoot` 和 `version` 供 setup/CLI 使用；`artifactGeneration` 供 candidate launch 和 exact takeover 使用；replacement eligibility 供 TUI 决定是否展示 restart |
| 当前重复 | context 同时返回 `installationScope` 与由它直接计算的 `canReplaceLocalHost`；`provenance` 只用于 resolver 内生成 artifact identity，返回后没有 production consumer |
| 最强保留理由 | 未来 Local Installation Manager 可能需要展示 provenance，调用方读取布尔值也较方便 |
| 为什么仍可删除 | 未来需求不能证明当前公开 contract；调用方可以从唯一的 `installationScope` 推导 eligibility，resolver 内仍可用局部 provenance 计算 generation |
| 消失内容 | 两个 context interface 字段、重复 fixture/assertion，以及文档中暗示它们都是当前公共事实的表述 |
| 新增或移动内容 | 不增加新 authority；只在现有 CLI connection seam 从 `installationScope` 推导一次 eligibility |
| 放弃的能力 | 当前无；未来需要 provenance 时必须用有实际消费者的 typed contract 重新引入 |
| 影响半径与不确定性 | 仅候选分支的 CLI context、fixtures 和文档；未发现 package-level public export |

这是净删除，并减少同一事实漂移的可能，适合在建立外部依赖前完成。

## P3：删除只由测试维持的 wait helper

### 删除证明

| 问题 | 证据 |
|---|---|
| 当前 authority | TUI prompt 决定允许的 restart/wait/cancel 输入；`resolveRuntimeHostCliConflictDecision()` 是唯一 production parser |
| 当前 consumers | `shouldRetryRuntimeHostConflict()` 只被 decision parser 和自己的 unit test 使用，没有独立 production caller |
| 最强保留理由 | helper 曾表达旧版 wait/cancel prompt 的语义，单独测试很直观 |
| 为什么仍可删除 | 新 parser 已完整表达三态 decision；保留旧二态函数只增加第二个输入 vocabulary 和测试面 |
| 消失内容 | 一个 export、一组仅针对旧 helper 的测试和一次嵌套 normalization |
| 新增或移动内容 | 无；wait token comparison 内联到现有 decision parser |
| 放弃的能力 | 无；`w`/`wait` 行为仍由三态 parser 测试 |
| 影响半径与不确定性 | 仅 CLI 内部模块；仓库搜索未发现外部或 production consumer |

## Decision gates

### Gate A：installation-owner flow 采用什么 module/record 边界？

- **待决定的内容：** 使用一个 class、一个本地 service，还是由共享 lock/record 约束的一组深模块；selection 是 machine-wide、profile-wide 还是 installation-scoped。
- **可能消失的 surface：** 过早选错边界会迫使每个 adapter 再维护自己的 package path、transition lock 或 fallback record；正确边界可删除这些局部 state。
- **最强保留理由：** Desktop bundle 与 global CLI 可能本来就是两个独立 installation owner，不应仅因都连接 default State Root 就共享 executable selector。
- **决定性缺失证据：** Desktop/CLI 的 product ownership 承诺、artifact integrity contract、跨平台 atomic switch 与 Client data layout。

在这些证据出现前，只固定 owner contract，不固定 `Local Installation Manager` 的具体实现形态。

### Gate B：`npx` 是否承诺 durable background work？

- **待决定的内容：** invocation-owned、managed artifact 或 connect-only。
- **可能消失的 surface：** invocation-owned 会删除 `npx` residency；managed artifact 会删除“npm cache executable 必须长期存在”的假设；connect-only 会删除 `npx` candidate spawn。
- **最强保留理由：** 零安装启动是 `npx` 的主要价值，而 Scheduled Tasks/Goals 可能需要在 Surface 退出后继续。
- **决定性缺失证据：** 对外 durability 承诺、cache eviction 风险接受度和真实 usage/telemetry。

## 已核实但不删除

- `compatibilityEpoch` 与 Host Generation：前者决定 contract compatibility，后者表达 exact-artifact replacement intent。
- `generation` 与 `candidateGeneration`：前者约束现有 Host admission，后者只标记本次 election 新建的 candidate；合并会让 compatible build skew 被错误拒绝。
- Host Epoch fencing：防止 stale updater 让错误的 replacement process 退出。
- `host.upgrade.prepare` 与 handshake takeover：入口和 admission 条件不同，虽然最终都复用 Kernel drain。
- Desktop、TUI、non-interactive CLI presentation：按钮、terminal prompt 和 exit behavior 是不同 Surface obligation。
- Remote operator boundary：`connectRemoteRuntimeHostProfile()` 在 local formatter 之前处理 incompatibility；remote Client 不获得 local replacement authority。
- Shared `_npx` detector：它已删除 service guard 与 CLI context 的重复 path inference，且有两个真实 consumer。

## Evidence anchors

- `packages/cli/src/runtime-host-installation-context.ts`
- `packages/cli/src/runtime-host-installation-provenance.ts`
- `packages/cli/src/runtime-host-cli-context.ts`
- `packages/cli/src/runtime-host-tui-command.ts`
- `packages/cli/src/runtime-host-service-manager.ts`
- `packages/runtime-host/src/client/connect-or-spawn.ts`
- `packages/runtime-host/src/client/host-profile.ts`
- `packages/runtime-host/src/server/host-kernel.ts`
- `apps/desktop/src/main/runtime-host-boot.ts`
- `apps/desktop/src/main/runtime-host-desktop-manager.ts`
- `apps/desktop/src/main/app-update-service.ts`
- `packages/cli/src/__tests__/runtime-host-installation-context.test.ts`
- `packages/cli/src/__tests__/runtime-host-cli-context.test.ts`
- `packages/runtime-host/src/__tests__/host-kernel.test.ts`
