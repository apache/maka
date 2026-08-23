---
document_status: implementation-contract
status: draft-stacked-foundation
date: 2026-08-08
milestone: M1.3-storage-authority
base: upstream/main@08bcf324b
---
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

# Managed Dependency Storage Authority v1

## 1. 本 PR 只证明一个不变量

> 同一个 canonical dependency environment identity 最多对应一棵由 Maka 发布、由 artifact 权限域之外的 durable receipt 证明、可在崩溃后收敛重开的依赖树；任何身份、路径、内容或平台证据不可证明时 fail closed。

本 PR 的 owner 是 `ManagedDependencyEnvironmentAuthority`。它拥有 environment identity、artifact publication、SQLite receipt、lease、pending reservation 与 GC。注入的 producer 只获得一次性 staging 中的 `outputRoot` 与 `scratchRoot`，不获得 storage root、canonical artifact path 或 receipt database。

同一个 canonical storage root 在同一时刻只能存在一个该 authority：同进程由 module-private owner claim 拒绝重复实例，跨进程由稳定 lock artifact 上的 OS exclusive lock 拒绝第二个 owner。lock 在 receipt database 或 artifact 被读取、修复、发布、租用、GC 之前取得，只在 authority 完整关闭或初始化失败时释放；active lease 导致的 close 拒绝不会释放 owner。

本 PR 不包含：

- bundled npm 的实现与网络策略；
- `node_modules/.bin` symlink 的 producer 配额扫描；
- ManagedWorkspaceOwner/worker logical binding；
- Desktop/CLI/Runtime Host 接线；
- release packaging、audit 或 SBOM。

因此该 PR 是 stacked foundation，在出现下一个生产 owner consumer 前保持 Draft；不得单独宣称 M1.3 用户能力闭环。

## 2. 权威与原子性边界

权威事实存放在 artifact 域之外的专用 SQLite database：

```text
managed-workspaces/dependency-environment-authority-v1.sqlite
```

artifact 目录只允许包含 `node_modules/`，不能携带同目录 receipt。发布顺序固定为：

```text
canonical identity validation
  -> process owner claim + cross-process OS lock
  -> pending reservation
  -> producer-owned random staging
  -> producer provision resolves (PR 2 must prove its process tree has exited)
  -> deep-copy node_modules into new authority-owned inodes
  -> delete the producer-owned tree
  -> one authoritative tree seal:
       hash every entry + fsync every regular file
       + fsync directories bottom-up
       + ADS/reparse validation
  -> fsync artifact staging root
  -> atomic rename artifact
  -> fsync publication parent
  -> SQLite receipt transaction (synchronous=FULL)
  -> reopen and revalidate artifact + receipt
  -> lease
```

filesystem rename 与 SQLite 不是共同事务，恢复依靠可收敛状态而非假装原子：

- artifact 存在、receipt 不存在：删除 orphan artifact，重新物化；
- receipt 存在、artifact 不存在：删除 orphan receipt；
- 两者都存在且一致：重新验证后复用；
- 两者都存在但不一致：fail closed，不自动接受或覆盖。

## 3. 身份、路径和平台规则

- authority 根据 manifest/lockfile bytes、package manager、Node ABI、platform/arch、producer runtime/policy 重新计算 identity；调用者提供的 `environmentId` 不能自证。
- publication digest 必须是固定 64 位小写十六进制 SHA-256，所有 join/realpath/rename 后重新检查 containment。
- Linux/macOS 的相对 symlink 只有在目标仍位于 dependency root 内时允许，link path/target 进入 tree digest；绝对或逃逸 link 拒绝。
- Linux/macOS 上 rename 不会撤销 producer 保留的 writable file descriptor，因此 producer tree 绝不直接 rename 成 artifact。authority 必须复制到新 inode、删除 producer tree，再做完整内容证明；旧 descriptor 后续只能修改已 unlink 的 producer inode。
- Windows 拒绝 symlink/reparse point，并通过系统绝对路径 PowerShell 枚举、拒绝 NTFS named stream。
- 每次 acquisition 都重新验证完整内容树。不能用目录 mtime 作为终裁，因为内容变化不保证可靠改变父目录 mtime；性能优化不能削弱内容证明。

所有平台的 publication 顺序都要求：每个 authority-owned 普通文件先完成平台可用的同步，内部目录按子目录到父目录的顺序尝试同步，随后同步 staging root；rename 后再同步 publication parent，最后才允许提交 SQLite receipt。tree hash 与 durable seal 必须由同一个遍历 primitive 完成，不能维护两套可能漂移的目录语义。

Linux 只有在文件系统和硬件兑现 file/directory `fsync` 合同时，才承诺上述顺序覆盖断电恢复。macOS 的普通 `fsync` 不等价于 `F_FULLFSYNC`，而本协议也没有同时为 artifact 与 SQLite receipt 启用并证明 full-sync ordering；Windows 的 Node 文件系统接口同样不能提供与 POSIX 等价的目录项持久性证明。因此 macOS 与 Windows v1 都只承诺**进程崩溃收敛**，不承诺断电后的 artifact publication 自动收敛。断电后若 artifact/receipt 不一致，必须 fail closed，并通过删除缓存后重新物化或人工清理恢复。绿色的 child-process crash test 不能充当 power-loss 证明。

Windows 上只读 dependency file 是合法输入。authority 只在自己的 unpublished staging inode 上临时增加 owner-write 权限以完成文件同步，并在继续 publication 前恢复原始 mode；producer inode 与最终 published mode 都不得被永久改写。任何同步或权限恢复失败都必须在 receipt 前 fail closed。

## 4. Lease、配额与失败状态

- authority 生命周期为 `open -> draining -> closed`。`close()` 先拒绝新的 acquisition，再等待所有已接纳 acquisition 完成 lease 安装或失败；完成后若存在 active lease，则 close 明确拒绝并恢复 `open`，不能先关闭 receipt owner 再返回活 lease。
- acquire 开始即安装 pending reservation，直到正式 lease 建立或失败清理；GC 不得删除 pending/inflight/leased digest。
- cache cost 为内容字节数加每个 entry 的固定治理成本，避免大量空文件绕过软配额。
- GC 串行执行；一次 GC rejection 可报告给当前调用者，但不能永久毒化后续 GC task chain。
- authority startup 遇到 malformed receipt 或 unowned cache entry 时整体 fail closed。Quarantine 会引入新的 durable lifecycle，不在本 PR 静默增加。

## 5. Crash 与对抗矩阵

| 场景                                 | 唯一合法结果                           |
| ------------------------------------ | -------------------------------------- |
| producer 中断                        | staging 清理，无 artifact/receipt      |
| 完整 tree durable seal 前中断         | 无 receipt；重启清理 staging/orphan    |
| tree seal 完成、artifact rename 前中断 | 无 receipt；重启清理 staging/orphan    |
| artifact rename 后进程退出           | 重启删除无 receipt artifact，再物化    |
| receipt commit 后进程退出            | 重启重验并复用                         |
| Linux receipt 前断电                  | receipt 不得领先已同步的完整 artifact tree |
| macOS/Windows publication 期间断电    | v1 不承诺自动收敛；不一致时 fail closed |
| Windows dependency file 为只读        | staging 临时提权同步后恢复 mode，再继续发布 |
| artifact 与同目录伪 receipt 一起修改 | 外部 SQLite receipt 不变，acquire 拒绝 |
| 伪造 environmentId/path traversal    | T1/任何文件写入前拒绝                  |
| Windows ADS/reparse                  | publish/reopen 拒绝                    |
| acquisition pending 时 GC            | pending digest 保留                    |
| cache 中任意已发布内容漂移           | 新 acquisition fail closed             |
| 同进程第二个 authority               | 接触 receipt/artifact/GC 前拒绝         |
| 另一进程持有同 root authority         | OS lock 处拒绝；不得观察或删除其 lease  |
| close 与 lease 安装并发               | drain 后因 active lease 拒绝 close      |
| POSIX producer 保留 output writable fd | late write 不得改变 authority-owned artifact |

## 6. Extraction ledger

来源仅作为实现证据，不继承集成分支历史：

| 文件                                                                                    | PR 1 归属          | 来源/处理                                              |
| --------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------ |
| `packages/storage/src/managed-dependency-environment.ts`                                | authority owner    | 从 #2307 storage commits 手工提取，删除无消费者 helper |
| `packages/storage/src/__tests__/managed-dependency-environment.test.ts`                 | identity/tamper/GC | 测试先迁移并在 main 上 RED                             |
| `packages/storage/src/__tests__/managed-dependency-environment-crash.test.ts`           | crash convergence  | production-shaped child-process crash                  |
| `packages/storage/src/__tests__/fixtures/managed-dependency-environment-crash-child.ts` | crash fixture      | 仅服务上述 crash contract                              |
| `packages/storage/src/__tests__/fixtures/managed-dependency-environment-owner-child.ts` | owner fixture      | 持有真实跨进程 owner lock，验证第二 owner 被拒绝        |
| producer/runtime-host/Desktop/release files                                             | 不属于 PR 1        | 留给后续平铺 PR，不迁移                                |

旧集成分支 `codex/managed-workspace-environment-provisioning-m1-3` 只作为实现来源。提交按不变量拆解如下，任何混合提交都不得整体 cherry-pick：

| 来源提交    | 原提交主题                                              | 平铺归属 | 处理方式                                                                 |
| ----------- | ------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `afb798092` | `feat(storage): add managed dependency artifact authority` | PR 1     | 迁移 authority、identity、receipt、crash fixture 与最小测试              |
| `57aba6bb7` | `fix(runtime): bind managed dependencies to producer authority` | PR 1/4   | 仅提取 storage authority 的 producer capability/identity 硬化；runtime consumer 留给 PR 4 |
| `cff6fc476` | `fix(storage): harden managed dependency authority`     | PR 1     | 提取外置 SQLite receipt、路径/平台校验、pending/GC 与对抗测试             |
| `89c9e0a3c` | `feat(runtime-host): ship verified bundled npm environments` | PR 2/3/4 | producer 隔离归 PR 2，bundled runtime 供应链归 PR 3，host 组装归 PR 4     |
| `8150e90a7` | `fix(runtime-host): constrain bundled npm provisioning` | PR 2/3   | provision policy/quota 归 PR 2，shipped runtime verification 归 PR 3     |
| `27f8f6b8e` | `fix(release): verify shipped bundled npm closure`      | PR 3     | release audit、manifest、notice 与 packaged smoke                        |
| `16e10b3c5` | `feat(storage): bind dependency environments to managed scopes` | PR 4     | owner-bound lease、logical binding 与 read-only worker consumer          |
| `9a42a761c` | `fix(runtime-host): transport packaged dependency authority` | PR 4     | Desktop/CLI/Runtime Host 生命周期与关闭顺序                              |
| `980143a3b` | `docs(architecture): split M1.3 authority boundaries`  | 文档证据 | 不迁移旧总文档；由每个平铺 PR 维护自己的 owner/rollback 合同             |

后续平铺顺序固定为：

1. PR 1：本文件定义的 storage authority；
2. PR 2：producer boundary，必须证明 producer 进程树退出后 `provision()` 才 resolve，并包含真实 npm `.bin` symlink 的配额与取消/超时测试；
3. PR 3：bundled npm runtime 供应链、发布审计与许可证材料；
4. PR 4：唯一生产 consumer，把真实 baseline、environment lease 和 Read/Glob/Grep worker 串成闭环。

PR 1–3 只是堆叠地基；PR 4 合并前不能把 M1.3 描述为用户可用。PR 2 不得通过拒绝所有 POSIX symlink 规避 `.bin`：producer inventory 应计量合法 link，最终 storage authority 与 worker 仍负责 target containment；Windows 继续拒绝 reparse point。

验证时必须执行 storage build、focused authority tests、真实 Windows ADS test，以及三个 child-process crash failpoint。后续 PR 不得通过放宽本 authority 的 fail-closed 规则来提高采用率。
