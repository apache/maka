# Managed files 四项交付提取账本

冻结来源：`87a9c7765`。新基线：`cd93f13da`。
编号只是本文交付顺序，不是 GitHub issue/PR 编号。

| 交付 | 主要不变量 | 状态 |
| --- | --- | --- |
| 1 | managed T1 后只经限定 authority 结算 | 已提取，Windows 独立构建和定向测试通过 |
| 2 | accepted Git 内容、candidate 与接受证明一致 | 已提取，独立构建和定向验证通过；完整 CI 未宣称通过 |
| 3 | 创建前固定 managed intent 与 Host capability | 已提取；Windows 开发态真实 Electron smoke 通过，保持 Draft 候选 |
| 4 | 同一 causal boundary 恢复且不重跑已完成 mutation | 已提取；Runtime 213/213、Rust 77/77、Host 59 passed/6 skip、四项 Windows Electron 重启通过 |

## 文件与测试归属

以下覆盖来源增量全部 94 个路径。多编号表示必须按功能块提取，不允许整文件或跨边界
commit 搬运；原表是分配计划，PR2/3/4 的实际提取见各节。

| 来源路径 | 交付 |
| --- | --- |
| `.github/workflows/gitoxide-helper-admission.yml` | 2 / 3 / 4，各 PR 携带自己的 gate/接线 |
| `apps/desktop/src/main/__tests__/app-shell-first-send-cleanup.test.ts` | 3 |
| `apps/desktop/src/main/__tests__/expected-error-presentation.test.ts` | 3 |
| `apps/desktop/src/main/__tests__/runtime-host-client-operations.test.ts` | 3 |
| `apps/desktop/src/main/__tests__/runtime-host-session-catalog-ipc-main.test.ts` | 3 |
| `apps/desktop/src/main/__tests__/session-local.test.ts` | 3 |
| `apps/desktop/src/main/runtime-host-boot.ts` | 3 |
| `apps/desktop/src/main/runtime-host-candidate-entry.test.ts` | 3 |
| `apps/desktop/src/main/runtime-host-candidate-entry.ts` | 3 |
| `apps/desktop/src/main/runtime-host-client.ts` | 3 |
| `apps/desktop/src/main/runtime-host-session-catalog-ipc-main.ts` | 3 |
| `apps/desktop/src/main/session-local-service.ts` | 3 |
| `apps/desktop/src/renderer/app-shell-chat-actions.ts` | 3 |
| `apps/desktop/src/renderer/app-shell.tsx` | 3 |
| `apps/desktop/src/renderer/locales/shell-copy.ts` | 3 |
| `docs/architecture/managed-files-rebuild-extraction-ledger.zh-CN.md` | 档案；不整份迁移 |
| `docs/architecture/managed-resume-mainline-rebuild-plan-2026-09.zh-CN.md` | 档案；不整份迁移 |
| `native/gitoxide-helper/src/main.rs` | 2 / 3 / 4，按 import/execution、创建、恢复分块 |
| `native/gitoxide-helper/tests/repository_admission.rs` | 2 / 3 / 4，按 import/execution、创建、恢复分块 |
| `packages/core/src/session.ts` | 3 |
| `packages/runtime-host/src/__tests__/connect-or-spawn-env.test.ts` | 3 |
| `packages/runtime-host/src/__tests__/connection-session.test.ts` | 3 |
| `packages/runtime-host/src/__tests__/execution-composition-factory.test.ts` | 2 / 3 / 4，各 PR 携带自己的 gate/接线 |
| `packages/runtime-host/src/__tests__/execution-model-composition.test.ts` | 3 |
| `packages/runtime-host/src/__tests__/fixtures/gitoxide-baseline-reopen-child.ts` | 2 / 3 / 4，按 import/execution、创建、恢复分块 |
| `packages/runtime-host/src/__tests__/gitoxide-helper-artifact-authority-internal.test.ts` | 2 / 3 / 4，按 import/execution、创建、恢复分块 |
| `packages/runtime-host/src/__tests__/gitoxide-helper-invocation-internal.test.ts` | 2 / 3 / 4，按 import/execution、创建、恢复分块 |
| `packages/runtime-host/src/__tests__/gitoxide-repository-admission-authority-internal.test.ts` | 2 / 3 / 4，按 import/execution、创建、恢复分块 |
| `packages/runtime-host/src/__tests__/handshake-compatibility.test.ts` | 3 |
| `packages/runtime-host/src/__tests__/host-kernel.test.ts` | 2 / 3 / 4，各 PR 携带自己的 gate/接线 |
| `packages/runtime-host/src/__tests__/hosted-execution-tool-profile.test.ts` | 3 |
| `packages/runtime-host/src/__tests__/managed-files-dev-bootstrap.test.ts` | 3 |
| `packages/runtime-host/src/__tests__/operation-dispatcher.test.ts` | 3 |
| `packages/runtime-host/src/__tests__/protocol.test.ts` | 3 |
| `packages/runtime-host/src/__tests__/resumable-peer-stream.test.ts` | 3 |
| `packages/runtime-host/src/__tests__/session-catalog-coordinator.test.ts` | 3 |
| `packages/runtime-host/src/client/connect-or-spawn.ts` | 3 |
| `packages/runtime-host/src/client/index.ts` | 3 |
| `packages/runtime-host/src/protocol/host-status.ts` | 3 |
| `packages/runtime-host/src/protocol/index.ts` | 3 |
| `packages/runtime-host/src/protocol/operations.ts` | 3 |
| `packages/runtime-host/src/server/execution-composition-factory.ts` | 2 / 3 / 4，各 PR 携带自己的 gate/接线 |
| `packages/runtime-host/src/server/execution-composition.ts` | 2 / 3 / 4，各 PR 携带自己的 gate/接线 |
| `packages/runtime-host/src/server/execution-model-composition.ts` | 3 |
| `packages/runtime-host/src/server/gitoxide-candidate-recovery-internal.ts` | 4 |
| `packages/runtime-host/src/server/gitoxide-candidate-settlement-internal.ts` | 2 |
| `packages/runtime-host/src/server/gitoxide-helper-artifact-authority-internal.ts` | 2 / 3 / 4，按 import/execution、创建、恢复分块 |
| `packages/runtime-host/src/server/gitoxide-helper-invocation-internal.ts` | 2 / 3 / 4，按 import/execution、创建、恢复分块 |
| `packages/runtime-host/src/server/gitoxide-managed-session-internal.ts` | 2 / 3 / 4，按 import/execution、创建、恢复分块 |
| `packages/runtime-host/src/server/gitoxide-mutation-admission-internal.ts` | 2 |
| `packages/runtime-host/src/server/gitoxide-repository-admission-authority-internal.ts` | 2 / 3 / 4，按 import/execution、创建、恢复分块 |
| `packages/runtime-host/src/server/gitoxide-runtime-mutation-internal.ts` | 2 |
| `packages/runtime-host/src/server/gitoxide-workspace-baseline-owner-internal.ts` | 2 / 3 / 4，按 import/execution、创建、恢复分块 |
| `packages/runtime-host/src/server/host-kernel.ts` | 2 / 3 / 4，各 PR 携带自己的 gate/接线 |
| `packages/runtime-host/src/server/hosted-execution-tool-profile.ts` | 3 |
| `packages/runtime-host/src/server/session-catalog-coordinator.ts` | 3 |
| `packages/runtime-host/src/test-only/managed-files-candidate-main.ts` | 3 |
| `packages/runtime-host/src/test-only/managed-files-dev-bootstrap.ts` | 3 |
| `packages/runtime/package.json` | 2 |
| `packages/runtime/src/__tests__/ai-sdk-backend.test.ts` | 3 |
| `packages/runtime/src/__tests__/managed-mutation-transform.test.ts` | 1 |
| `packages/runtime/src/__tests__/runtime-continuation.test.ts` | 4 |
| `packages/runtime/src/__tests__/session-manager.test.ts` | 4 |
| `packages/runtime/src/__tests__/tool-runtime-durable-boundary.test.ts` | 1 |
| `packages/runtime/src/ai-sdk-backend.ts` | 3 |
| `packages/runtime/src/continuation-safety.ts` | 4 |
| `packages/runtime/src/edit-replace.ts` | 1 |
| `packages/runtime/src/managed-mutation-transform.ts` | 1 |
| `packages/runtime/src/runtime-kernel.ts` | 3 / 4，按 composition 与 continuation 分开 |
| `packages/runtime/src/runtime-resume.ts` | 4 |
| `packages/runtime/src/session-manager.ts` | 4 |
| `packages/runtime/src/tool-runtime.ts` | 1 |
| `packages/storage/src/__tests__/execution-provider-conformance.test.ts` | 1 |
| `packages/storage/src/__tests__/session-store.test.ts` | 3 |
| `packages/storage/src/__tests__/sqlite-session-metadata-store.test.ts` | 3 |
| `packages/storage/src/__tests__/workspace-version-authority-persistence.test.ts` | 1 |
| `packages/storage/src/execution-persistence-provider.ts` | 1 |
| `packages/storage/src/execution-stores.ts` | 1；prepared session creation facade 留给 3 |
| `packages/storage/src/execution-workspace-authority-internal.ts` | 1；readVersion 留给 4 |
| `packages/storage/src/local-execution-persistence.ts` | 1；readVersion 留给 4 |
| `packages/storage/src/session-store-contract.ts` | 3 |
| `packages/storage/src/session-store.ts` | 3 |
| `packages/storage/src/sqlite-runtime-store.ts` | 1 |
| `packages/storage/src/sqlite-session-metadata-schema.ts` | 3 |
| `packages/storage/src/sqlite-session-metadata-store.ts` | 3 |
| `packages/storage/src/test-only/memory-execution-session.ts` | 3 |
| `packages/storage/src/workspace-version-authority-internal.ts` | 1 |
| `packages/ui/src/__tests__/composer-plus-menu.test.tsx` | 3 |
| `packages/ui/src/composer.tsx` | 3 |
| `scripts/ci-workflow-policy.test.mjs` | 2 / 3 / 4，各 PR 携带自己的 gate/接线 |
| `scripts/desktop-managed-candidate-breakpoint.mjs` | 4；普通启动 smoke 可供 3 复用 |
| `scripts/desktop-managed-files-smoke.mjs` | 4；普通启动 smoke 可供 3 复用 |
| `scripts/desktop-managed-smoke-entry.cjs` | 4；普通启动 smoke 可供 3 复用 |
| `scripts/release-cli-file-policy.test.mjs` | 3 |

## 交付 1 的历史来源

- `d2507eaee`：纯转换及其测试，不带旧路线文档。
- `7175f0a06`：普通历史显式 root adoption 及真实进程退出测试。
- `52b0bd738`：group-bound authority；保留窄接口。
- `c66dcedd2`：Edit deterministic rejection 类型和转换行为（不搬 Host settlement）。
- `9cca39e27`：Runtime managed T1/T2 选择、完整 response adoption 和对应测试。
- 后续提交只取上述文件的最终修正；`readVersion` 历史权限有意排除，归交付 4。

没有 cherry-pick merge commit；没有复制来源分支的 package.json 依赖版本。
没有迁移 Runtime Host/端点/启动、schema 变更、helper、UI 或 continuation。

## 校验

- 路径级比较：交付 1 白名单文件应与冻结来源一致；预期差异为两个 Storage 文件去掉
  continuation 专用 `readVersion`，execution-stores 去掉交付 3 的 prepared session creation facade。
- range-diff 用于比较来源历史与重新组织的提交，不要求旧提交一一对应。
  未匹配的 Host/Desktop/recovery 提交是有意排除，而不是已证明被迁移。
- 新分支必须独立 build/test，不能使用来源 worktree 的 dist 作为交付证据。
- 来源测试先跑得到 167/168；失败为后来扩大的 `readVersion` 与窄接口测试不一致。
  新分支按职责排除该权限，不修改测试断言；加上原有 Edit 回归后新分支 187/187、0 skip。
- Core、Storage、Runtime 独立 build 通过；13 个代码/测试文件 Biome format 通过。
- 路径比较实际仅三个预期差异；其余十个代码/测试文件与冻结来源完全一致。
- 当前 main 的 package-lock.json 和依赖版本未改变。

## 交付 3 的实际提取

- 分支 `codex/desktop-managed-files-delivery`，基于交付 2 `2e8033292`。
- 取 `672d82731..7f534eeff` 中 Desktop 创建、prepared header、Host readiness、
  managed session backend 和 accepted Read 的功能块；不搬整个历史提交。
- `e2bafcc1d` 至 `9bdbebee1`：session/backend、source-bound import、
  pinned helper、Host capability、prepared session publication。
- `3dd807118`、`2362f0626`、`355e46d14`：开发态 candidate、
  显式创建 intent 与加号菜单；`7f534eeff` 只取正常启动的 Electron smoke。
- 保留新 main 的 first-send 清理顺序：拒绝/异常时保留 managed intent，
  成功且当前 Session 仍持有 UI 时才清除；补对应断言。
- PR3 不修改 Rust、tool-runtime、runtime-kernel、session-manager、continuation、
  candidate recovery、依赖版本或 lockfile。prepared facade 单独从交付 2 增量提取。
- 三平台 helper workflow 增加创建相关选择与定向测试；真实 Electron smoke 本轮为
  Windows 手工执行证据，不声称已经被三平台 CI 执行。
- path diff 保留最新 main 的 Desktop/Host 修改；range-diff 中未匹配的恢复提交归 PR4。
- 验证与未关闭限制见 `desktop-managed-files-delivery.zh-CN.md`。

## 交付 2 的实际提取

- 新分支 `codex/gitoxide-file-execution-delivery` 堆叠在 PR1 `0de112e99`，
  不包含其他 integration 历史。
- `ab9534444`、`eac82a400`：authentic import → baseline acceptance → reopen。
- `c6f2709c2`、`3a6824a92`：真实 child exit 与 candidate/T2 exact binding。
- `a7bdc4344`、`52f152632`、`c66dcedd2`：exact absence、no-op、deterministic failure。
- `c418f419d`：accepted-ref predecessor 校验；因此 readVersion 在 PR2 加入，而非等到 PR4。
- `e73319f9a`、`9cca39e27`：mutation admission 与 Runtime 适配器，测试携带真实 ToolRuntime。
- `7f534eeff` 只取 helper 长 ref/Windows 修正，不取 Desktop 接线。
- candidate-settlement、mutation-admission、runtime-mutation 三个文件取最终来源；
  baseline owner 取 9cca 的完整执行边界，排除最终来源 recoverCandidate/inspectContinuation。
- 原 gitoxide-baseline-reopen-child 取 9cca 的 636 行文件执行部分，改名
  gitoxide-file-execution-child；未携带 backend、catalog、continuation、startup mode。
- 三平台 helper workflow 消费这些测试，并触发于新 owner、fixture、Runtime 和 Storage。
- Core session、schema、Host protocol、Desktop、lockfile 均不改动。
- 验证：Rust 76 passed；Host 45 passed/6 Windows skip；Runtime/Storage 121 passed；
  新 workflow filter 两项 passed。完整 workflow policy 的 Windows shared-comparison
  fixture 仍非绿，详见交付合同。

## 交付 4 的实际提取

- 分支 `codex/managed-files-recovery-delivery`，堆叠在交付 3 `9691730f4`。
- 迁移 `7f534eeff..87a9c7765` 的恢复功能块，不携带历史 merge。
- 将交付 2 缩小版 child fixture 扩展为完整的 baseline/recovery fixture；
  同时补回先前未迁移的 catalog/backend 真实进程证明，不保留未使用的双份 fixture。
- 迁移 existing candidate verify、candidate recovery、source-bound continuation、
  启动 reconciliation 和 Electron kill/restart 场景。
- 94 个来源路径做逐文件 hash 对比；两个旧文档由四片合同替代，
  main 的 UI/Host/依赖变更、新 conformance 测试和 CI 组织差异有意保留。
- 路径审计另补回一条 helper capability 缺少 verify_source_import 权限时拒绝的测试；
  4/4 artifact authority 测试通过，未修改生产权限。
- Runtime/Host/Rust 恢复生产代码与冻结来源完全相同。
- 本片不更改 Storage schema、不增加 release helper、不引入 Bash/npm 或自动恢复产品。
- 本机证据、平台限制和执行命令见 `managed-files-recovery-delivery.zh-CN.md`。
