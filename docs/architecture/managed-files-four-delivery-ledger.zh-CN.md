# Managed files 四项交付提取账本

冻结来源：`87a9c7765`。新基线：`cd93f13da`。
编号只是本文交付顺序，不是 GitHub issue/PR 编号。

| 交付 | 主要不变量 | 状态 |
| --- | --- | --- |
| 1 | managed T1 后只经限定 authority 结算 | 已提取，Windows 独立构建和定向测试通过 |
| 2 | accepted Git 内容、candidate 与接受证明一致 | 待提取 |
| 3 | 创建前固定 managed intent 与 Host capability | 待提取 |
| 4 | 同一 causal boundary 恢复且不重跑已完成 mutation | 待提取 |

## 文件与测试归属

以下覆盖来源增量全部 94 个路径。多编号表示必须按功能块提取，不允许整文件或跨边界
commit 搬运；后三项是待核对的分配计划，不表示已经完成提取。

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
