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

# Managed Workspace Baseline Open v1：M0 最终接受门

- 状态：已合并；M1 execution admission 在其返回值上增加 owner-bound handle，不改变 M0 durable authority
- 更新日期：2026-08-04
- 主要不变量：只有经 Git artifact owner 持久化并重新验证的 exact baseline receipt，才能由同一
  storage-root lifecycle owner 提交给 SQLite workspace authority；Git artifact 单独成功不构成
  canonical workspace version
- Git artifact owner：`GitWorkspaceService`
- composition/lifecycle owner：`ManagedWorkspaceOwner`
- canonical history owner：SQLite 内 immutable workspace RuntimeEvents

## 1. 本切片交付什么

前三个 M0 切片已经分别证明：

1. Maka 可以用 pinned Git 创建、验证、repair 和 quarantine 自有 Git repository/worktree artifacts；
2. SQLite 可以把 epoch-opened、baseline-accepted 与三个 projection 原子提交，并从 RuntimeEvents 重建；
3. 一个 authenticated interactive storage root 只发布一个 managed workspace lifecycle owner。

它们之间仍缺一个权限与因果门。如果调用者可以把任意 OID 直接交给 SQLite，那么 Git 验证只是注释；
如果 Git 创建成功就被当作 canonical，那么 SQLite 失败后会出现第二套 workspace truth。本切片只关闭这条
seam，不接 Desktop、CLI、runtime host 或工具执行。

公开入口是：

```ts
owner.openManagedWorkspaceBaseline(runtimeStore, {
  repositoryId,
  workspaceId,
  workspaceEpochId,
  workspaceInstanceId,
  sourceRoot,
});
```

调用者只提供业务身份与 source root，不能提供 policy hash、commit/tree OID、version ID、event ID、
tree delta 或“verified”布尔值。M0 policy 是实现实际执行并内部 canonicalize/hash 的固定协议，不是
调用者提供的标签。

## 2. Owner、原子边界、失败状态与回滚

| 项目 | 决策 |
|---|---|
| Git artifact owner | `GitWorkspaceService` 证明 Git artifact，并在未导出的 receipt authority capability 中实现持久化与复验 |
| lifecycle owner | `ManagedWorkspaceOwner` 是 receipt capability 的唯一持有者，独占 Git receipt → SQLite authority 的组合调用 |
| canonical truth | SQLite authority stream 的 immutable RuntimeEvents；receipt 是 admission evidence，不是 canonical head |
| Git durability boundary | `baseline-receipt.json` 以同目录临时文件、file fsync、rename、POSIX parent fsync 持久化 |
| SQLite atomic boundary | epoch fact、baseline fact、epoch/version/head projection 位于同一事务 |
| root binding | authority store 必须是 authenticated storage root 下精确的普通非 symlink `runtime.sqlite`，并保持注册时的文件 identity；该文件必须只有一个 hard link，lease 的真实 DB path 是唯一依据；数据库 singleton rootId 必须等于 authenticated owner rootId；SQLite COMMIT 后、返回前再次验证 pathname、identity 与 durable rootId |
| policy identity | policy version/hash 从固定且实际执行的 M0 policy object 内部派生；覆盖 source cleanliness、tracked/untracked/ignored、UTF-8 lossless path、NFC/case-fold collision、symlink/submodule/attributes/special mode 与 materialization；public API 不接受裸 hash |
| exact retry | version/event IDs 由 binding + artifact + policy 确定性派生；durable receipt 冻结可重新证明的 Git evidence 与 delta |
| pre-accept orphan | receipt 已落盘而 SQLite 未接受时，它是可重试 orphan；不是 canonical workspace version |
| post-accept loss | SQLite 已有 head 但 receipt 缺失、漂移或 Git artifact 不可验证时，报 corruption/unavailable，不生成替代 receipt |
| 回滚 | 停止调用本入口即可；既有 RuntimeEvents 仍可读。不能删除已接受 receipt 来“回滚” canonical history |

本切片没有尝试跨 Git filesystem 与 SQLite 建立一个不真实的分布式事务。它使用可重放协议收敛：Git
receipt 先 durable，SQLite 后原子接受；唯一允许的半完成状态是“未被接受的 Git orphan”。反方向的
“SQLite 已接受但 Git receipt 不存在”不是可修复半状态，而是 fail-closed corruption。

## 3. Durable receipt 合同

receipt 位于 managed instance root，和 `binding.json` 同级：

```text
managed-workspaces/
  w/<workspace>/e/<epoch>/i/<instance>/
    binding.json
    baseline-receipt.json
    worktree/
```

v1 receipt 严格包含：

```ts
{
  schemaVersion: 1,
  protocol: 'maka_managed_workspace_baseline_receipt_v1',
  binding,
  workspaceVersionId,
  policyVersion: 1,
  policyHash,
  epochOpenedEventId,
  baselineAcceptedEventId,
  treeDeltaDigest,
  changedFileCount,
  deletedFileCount: 0,
}
```

所有字段采用 exact-key strict decoder。receipt 必须重新证明：

- durable binding 与调用 identity 完全相同；
- repository record、epoch artifact、baseline ref、head ref、commit/tree 与 pinned Git capability 一致；
- worktree registration 仍被 Maka ownership lock 锁定；
- HEAD/tree 等于 baseline，worktree clean；
- policy version/hash 等于实现实际执行的 canonical M0 policy；
- workspaceVersionId、epochOpenedEventId 与 baselineAcceptedEventId 可从 binding、baseline artifact 与
  policy 确定性重新派生；合法 shape 的磁盘篡改也必须被拒绝；
- tree delta 摘要与 baseline tree 重新计算结果一致。

`GitWorkspaceService` 的 public interface 不暴露 receipt 的 issue/require/verify，package root 也不导出
`git-workspace-service` factory。artifact-only create/open 只作为 storage 内部前置实现存在；public
`ManagedWorkspaceOwner` 只暴露 `openManagedWorkspaceBaseline(...)` 与 lifecycle close。对应 receipt capability
位于未被 package root 导出的 internal module，并通过实例绑定的 `WeakMap` 只交给该 owner。普通 package
consumer 既不能预占一个 epoch 的 admission identity，也不能在 canonical acceptance 前取得 executable
worktree path。M1 execution admission 只允许消费由该入口成功返回的 owner-bound handle；handle 的 consumer
是同一 `ManagedWorkspaceOwner.withManagedWorkspaceExecution(...)` 准入门，仍未把 cwd 暴露给 Desktop、CLI
或 ToolRuntime。详细合同见
[Managed Workspace Execution Admission v1](./runtime-managed-workspace-execution-admission-v1.zh-CN.md)。

receipt 不保存 wall-clock `committedAt`：artifact owner 无法从 Git evidence 重新证明该时间，允许它进入 receipt
会让 orphan receipt 篡改污染 canonical event 时间。M0 的 baseline authority 使用协议固定逻辑时间 `0`；
canonical 顺序由 SQLite authority spine 的 `event_seq` 决定。真实 wall-clock acceptance time 若未来用于观测，
必须由 store 自己生成并作为 operational metadata 保存，不进入 Git evidence 或恢复身份。

## 4. Tree delta 摘要

M0 baseline 的逻辑 parent 是 empty tree，因此：

- `changedFileCount` 等于 baseline tree 的受支持 blob entry 数；
- `deletedFileCount` 固定为 `0`；
- `treeDeltaDigest` 是 domain-separated canonical manifest 的 SHA-256，而不是 caller 自报值。

manifest 以 Buffer 读取 Git `ls-tree -r -z`，按 Git canonical 顺序记录每个 entry 的 `mode`、
`objectType`、`oid` 和 `pathBytesBase64`。v1 为了保证 Git path 与 Node/host 路径语义一致，会严格
拒绝不能无损解码并 round-trip 的非 UTF-8 path；不会把 replacement character 写进摘要。M0 只接受
普通 blob mode `100644` / `100755`；symlink、submodule、special mode、
`.gitattributes` 与 case collision 继续由 Git Workspace Service 在 receipt 生成前拒绝。

该摘要证明的是 Git object delta，不是 checkout 文件字节扫描，也不把 ignored/untracked 内容纳入
canonical baseline。

## 5. 正常时序

```mermaid
sequenceDiagram
  participant C as "Storage composition caller"
  participant O as "ManagedWorkspaceOwner"
  participant G as "GitWorkspaceService"
  participant R as "baseline-receipt.json"
  participant S as "SqliteRuntimeStore"
  participant E as "Workspace RuntimeEvents"

  C->>O: openManagedWorkspaceBaseline(store, identity)
  O->>O: authenticate root lease; assert exact runtime.sqlite identity
  O->>S: bind/verify singleton durable storage-root ID
  O->>G: create/adopt and verify managed workspace
  G->>G: verify binding/repository/epoch/ref/worktree
  G->>G: derive canonical policy + IDs + empty-tree → baseline delta
  alt receipt already exists
    G->>R: strict read + exact revalidation
  else no canonical head and receipt absent
    G->>R: atomic durable write of frozen receipt
  end
  G-->>O: verified durable receipt
  O->>S: internal commitWorkspaceBaseline(receipt-derived input)
  S->>S: BEGIN IMMEDIATE
  S->>E: epoch-opened + baseline-accepted
  S->>S: epoch/version/head projections
  S->>S: COMMIT
  S-->>O: created or exact-existing head
  O->>O: post-commit revalidate exact runtime.sqlite identity
  O->>S: revalidate exact durable storage-root ID
  O->>G: post-commit reverify exact receipt and Git artifacts
  G-->>O: verified
  O->>O: re-authenticate root owner and durable root marker
  O-->>C: usable canonical baseline
```

只有最后一步成功返回以后，调用者才得到可用的 managed baseline。SQLite commit 后的 reverify 失败
不会撤销 canonical history；它阻止当前 instance 被交给后续工具，并要求 repair/quarantine 流程处理。
最终 root-owner 复验与 Git receipt 复验是两个独立闸门：receipt 证明 managed artifact，root-owner
复验证明返回瞬间的 marker、lease、database binding 仍属于同一个 authenticated storage root。

## 6. Crash 与并发矩阵

| 崩溃/并发点 | durable Git 状态 | canonical SQLite 状态 | 重启结果 |
|---|---|---|---|
| receipt durable 前退出 | 无 receipt 或原子旧值 | absent | 重新验证 Git 后重新生成 receipt |
| receipt durable 后、SQLite 前退出 | exact orphan receipt | absent | exact reuse receipt，再提交 authority |
| epoch/version/projection 事务中退出 | exact receipt | 全回滚 | exact retry；不生成新 IDs |
| SQLite COMMIT 后、post-verify 前退出 | exact receipt | accepted | 重读 head + require existing receipt；exact existing |
| accepted 后 receipt 缺失 | missing | accepted | fail closed；禁止创建 replacement receipt |
| accepted 后 receipt 篡改 | invalid/drifted | accepted | fail closed；canonical history 不变 |
| accepted 后 Git ref/object/worktree 漂移 | unverifiable | accepted | fail closed，后续 quarantine/repair；不返回 cwd |
| 同一 root owner 内两个并发 open | artifact lock/SQLite writer 串行 | 一个 transaction 创建 | 一个 created，一个 exact existing |
| 两个进程竞争同一 root owner | loser 不能越过 root-owner admission | winner 独占 composition | winner 关闭后 loser 重试并得到 exact existing |
| owner 传入另一 storage root 的 DB | 不写 receipt | 不写错误 DB | admission 前拒绝 |
| 两个 storage root 以 hard link 共享 `runtime.sqlite` inode | 不写 receipt | 不接受共享 DB；拒绝 `nlink != 1` | fail closed，避免 WAL/SHM 跨目录分裂 |
| 单独复制或移动已绑定的 `runtime.sqlite` 到另一 root | 不写/不读取错误 root 的 receipt | DB rootId 与 owner rootId 冲突 | fail closed；必须使用 whole-root import/adopt 协议 |
| 正式复制整个 storage root 后 adopt | storage-root marker 与 DB 随 root 保留 | DB rootId 与 marker rootId 保持一致 | `adoptStorageRootOnImport` 只恢复 storage-root identity；不证明旧路径下已 materialize 的 linked worktree 可迁移 |
| imported root 含既有 managed workspace instance | binding 与 Git admin metadata 可能仍引用旧绝对路径 | canonical history 保留 | fail closed；首版必须显式 relocation/adoption 或重新 materialize 新 instance，不能直接返回旧 cwd |
| unbound DB 已含 Session、RuntimeEvent、claim 或 workspace fact 等逻辑数据 | 不生成新 receipt | 禁止静默认领 | 要求独立、显式、可备份和可审计的 legacy root-binding adoption；M0 baseline open 不承担迁移 |
| 初次 DB identity 检查后 canonical pathname 被替换 | receipt 可能成为 orphan | 已打开连接的提交视为 detached，不返回 usable baseline | post-commit DB identity 复验拒绝；新 canonical DB 不获得错误 head |
| post-commit artifact 复验后 root marker 被替换 | exact receipt 与 accepted head 保留 | canonical history 不回滚 | 最终 root-owner identity 复验拒绝；不返回 usable baseline |
| owned quarantine/instance parent 被替换为 symlink | physical layout revalidation 拒绝 | canonical history 不变 | fail closed，不读取外部 control record、不移动到外部目录 |

真实进程 crash harness 分别覆盖 receipt durable 后、SQLite authority 前，以及 SQLite COMMIT 后、
post-verify 前的 `SIGKILL`；两者重启后都使用同一 receipt/identity 收敛。SQLite 事务内部的
process-kill/rollback 证明继续由 Workspace Version Authority 测试拥有；M0 只增加跨 Git、root owner、
SQLite 与 post-verify 的 composition crash proof。

## 7. 平台能力矩阵

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| pinned Git artifact revalidation | 支持 | 支持 | 支持 |
| receipt file fsync + atomic rename | 支持 | 支持 | 进程崩溃支持；不承诺断电级 parent fsync |
| SQLite atomic baseline acceptance | 支持 | 支持 | 支持 |
| raw Git path | 非 UTF-8 fail closed | 非 UTF-8 fail closed | Node/Git UTF-8 path policy |
| real-process crash test | 发布门槛 | 发布门槛 | 有限支持；依赖 Node/Git 的 SIGKILL 等价行为 |
| power-loss durability | 不承诺 | 不承诺 | 不承诺 |

Windows 上不虚构 POSIX directory fsync 承诺。M0 保证进程崩溃后的可重试状态收敛；机器断电、磁盘缓存
或文件系统损坏不在 v1 发布证明内。

## 8. 明确延期

- Desktop、CLI、runtime-host 与设置入口；
- 工具 cwd 切换、ignored dependency/scratch provisioning；
- mutation candidate ref、T1/T2 + workspace version 原子接受、conditional redo；
- continuation 绑定 workspace version 与自动 resume；
- orphan receipt/ref/object GC；
- whole-root import 后既有 managed worktree 的 relocation/adoption 或重新 materialize；
- 非空 legacy DB 的显式备份、授权、root-binding adoption 与完整重扫维护入口；
- replication、跨端同步、publish、undo 与 multi-agent merge。

这些能力必须分别由后续 PR 证明自己的 owner、原子边界、失败状态与回滚方式。M0 完成只代表系统拥有
一个可验证、可重试、canonical 的 managed baseline，不代表 agent 已经在该 worktree 中执行工具。

## 9. 验收门槛

- 首次 open 与 exact retry 返回同一 receipt/head；
- receipt-after-write crash 与 SQLite rollback 都能 exact retry；
- SQLite COMMIT 后、post-verify 前真实进程 crash 返回 exact existing；
- accepted 后 receipt missing/tampered fail closed；
- post-commit Git 复验后 root marker 变化时，保留 canonical head 但拒绝返回 usable workspace；
- lease 伪 path、同 root 第二 DB、memory DB、DB symlink 与文件 identity 变化均在 admission 前拒绝；
- public Git service 无 receipt issuer，canonical policy/hash 与 deterministic IDs 有 literal/篡改测试；
- raw path digest 使用字节编码，非 UTF-8 source path fail closed；
- 同 owner 并发 open 收敛为一个 created、一个 existing；跨进程首先由 root-owner lock 仲裁；
- Git service、owner、workspace authority 的 focused real-Git/crash suites 全绿；
- `@maka/core` / `@maka/storage` build 与 `git diff --check` 通过；
- 不包含 Desktop/CLI/runtime-host 生产接线。
