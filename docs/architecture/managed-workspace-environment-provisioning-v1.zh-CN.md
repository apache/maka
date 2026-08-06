---
document_status: implementation-contract
status: implemented-pending-review
date: 2026-08-06
milestone: M1.3
---

# Managed Workspace Environment Provisioning v1

## 1. 目标与非目标

M1.3 只解决一个主要不变量：

> managed execution 只能消费由 Maka 拥有、身份可验证、与当前 canonical tree 明确匹配的环境；能力缺失时必须在 execution scope 签发前 fail closed，不能复制或复用 attached checkout 中的 ignored 内容。

首版环境分为三类，但按独立切片交付：

1. dependency environment：由 lockfile 和受信 package-manager runtime 物化，可跨相同 identity 的 managed worktree 共享；
2. secret projection：只在单次 execution scope 内注入，不进入 Git、缓存、receipt 或 RuntimeEvent；
3. scratch：Maka-owned、按 execution 生命周期租用，不能混入 canonical tree。

本合同当前只授权第 1 类进入施工。secret 与 scratch 要等出现真实的 Shell/Build 消费者后再分别设计，不能预埋无消费者抽象。

M1.3 不做：

- 从 source checkout 复制或链接 `node_modules`、`.env`、build output；
- 把项目依赖打进 Maka 安装包或 Session Bundle；
- 静默调用用户 PATH 上的 npm/pnpm/yarn；
- 在依赖环境内执行 Agent 任意命令；
- 启用 Write/Edit/Shell 或改变 M2 的 workspace mutation authority；
- 把 dependency cache 当作 workspace checkpoint 或 RuntimeEvent truth。

## 2. Owner、事实与原子性边界

### 2.1 Owner

`ManagedWorkspaceOwner` 是 dependency environment admission 的唯一 owner。它负责：

- 从已接受的 baseline tree 读取 tracked manifest/lockfile；
- 计算 environment identity；
- 调用显式配置且已验证的 package-manager producer；
- 创建、验证、租用和回收 Maka-owned environment artifact；
- 在 scope 签发前最终重验 worktree binding/head，并持有已验证 environment lease；
- 给 filesystem worker 增加只读 dependency root 权限。

package manager 负责包内容下载、完整性校验与其内部 store；Maka 不再发明一套 npm/pnpm CAS。Maka 只拥有 environment 的身份、发布、租约、绑定和 GC。

### 2.2 权威事实

dependency environment 的权威事实是 owner 私有目录中的 durable receipt，而不是 worktree 内的 symlink/junction，也不是 package manager 的控制台输出。

artifact receipt 至少包含：

```text
protocolVersion
environmentId
lockfilePath
lockfileSha256
manifestSha256
packageManagerName
packageManagerVersion
nodeVersion
nodeAbi
platform
arch
producerRuntimeIdentitySha256
producerPolicyIdentitySha256
policyVersion
artifactRoot
```

v1 不新增 durable worktree-environment binding 行。Owner 在一次 admission 内组合已验证的
`baselineTreeOid + environmentId lease`，然后把 cwd 与 dependency root 只放进 owner-token 保护的 active scope。
`baselineTreeOid` 不进入共享 artifact receipt，否则两个依赖完全相同、只改了业务源码的 baseline 会被错误地禁止复用同一 environment。

`environmentId` 对上述决定内容与执行兼容性的字段做 domain-separated canonical hash。producer runtime identity 同时绑定已验证 bundled npm manifest 的完整 runtime tree digest、Node executable digest、Node version/ABI 和 platform/arch；producer policy identity 来自精确的 hermetic capability profile。时间、绝对 source path、sessionId 和 worktreeId 不进入 identity，因此同一平台上相同依赖状态可以共享；平台、架构、Node ABI、producer runtime 或 policy 不同则不能共享。

### 2.3 原子性边界

创建采用 staging + durable receipt + atomic publish：

```text
compute identity
  -> acquire environmentId lease
  -> provision into Maka-owned staging project
     (write staging package.json/package-lock.json; never receive or write worktree path)
  -> verify producer result and write receipt
  -> fsync files/receipt where supported
  -> atomic rename staging -> environments/<environmentId>
  -> reopen and verify receipt
  -> issue lease/binding
```

它不是 Git、SQLite、package registry 与 filesystem 的共同事务。崩溃前未发布的 staging 是 orphan，可 GC；已发布 artifact 必须能仅凭 receipt 和目录重新验证。

## 3. Identity 与缓存策略

### 3.1 v1 identity

```text
dependency_environment_v1(
  baseline tracked package manifest bytes,
  baseline tracked lockfile bytes,
  package manager name + exact version,
  Node version + ABI,
  platform + arch,
  verified producer runtime tree digest,
  hermetic producer policy digest,
  environment policy version
)
```

不能只使用 lockfile hash：同一 lockfile 在不同 Node ABI、操作系统、CPU 架构或 package-manager 算法下可能产生不同 native package 与 install layout。

### 3.2 磁盘与包体

- Maka release 不携带项目 `node_modules`；安装包不会随用户项目依赖增长。
- environment 是运行时磁盘缓存，不是内存副本。
- 不同 identity 可以同时存在；相同 identity 只物化一份并由多个 managed worktree 共享。
- package manager 自己的 download/content store 可以继续去重；Maka 不复制其 CAS。
- v1 默认软配额为 2 GiB；receipt 记录内容字节数，每次 acquire 更新 artifact 的最后租用时间，release 后按 LRU
  删除未租用 artifact，active lease 与本次刚释放的 artifact 不得删除。配额是缓存治理，不进入 environment identity；
  `.staging` 由新 owner 启动时独立清理。
- artifact cache 可以被不同 baseline 复用；workspace-specific binding 则只存在于一次 owner-bound execution scope 中，组合
  `baselineTreeOid + environmentId lease`，两者不是同一个概念，也不新增 durable binding 表。
- v1 的 lease/GC 依附于持有 OS 级独占 storage-root write lock 的 `ManagedWorkspaceOwner`。同一 storage root 不允许第二个
  Desktop/CLI writer owner 同时进入，因此不会出现另一个合法 owner 跨进程删除 active artifact；未来若允许多 writer，必须先把
  lease/GC 升级成跨进程协议，不能复用当前进程内计数。

## 4. Owner-bound logical binding

M1.3 v1 不在 managed worktree 中创建 `node_modules` symlink/junction。只读 worker bridge 在 owner-bound scope
内部把 `node_modules/**` 逻辑路由到该 scope 持有 lease 的 dependency root。这样 dependency environment 不会成为
Git ignored/untracked drift，也不会让下一次 canonical-tree admission 误判。

logical binding 必须满足：

1. binding 路径由 policy 固定（Node v1 为 `node_modules`）；
2. baseline tree 在该路径没有 tracked entry；
3. scope 只能指向当前 owner 已验证并持有 lease 的 artifact；
4. raw dependency root 只存在于 owner-token 保护的 internal scope state，不进入公共 profile、模型消息或 RuntimeEvent；
5. worker boundary 只增加 exact artifact root 的只读权限，不能借 binding 获得 storage root 的广泛访问；
6. `../`、空 segment 与 escape 形状在 worker dispatch 前拒绝；相对路径与位于 managed cwd
   `node_modules/**` 下的等价绝对路径必须归一到同一个 dependency root，其他绝对路径不获得 dependency 权限；
7. Glob/Grep 等可能返回 absolute path 的结果必须在返回 host 前重新映射为 `node_modules/**`。

不能简单把 `node_modules` 从 `git status` 校验中全局忽略，也不能在 worktree 中放一个持久链接后让 Git verifier
对白名单路径视而不见。v1 的 logical binding 不改变 worktree，因此 Git drift authority 保持原样。

平台实现：

| 平台 | v1 binding | 保证 |
|---|---|---|
| Linux | owner-scope logical route | sandbox 对 exact dependency root 只读授权 |
| macOS | owner-scope logical route | 同 Linux；canonicalize `/var`/`/private/var` alias |
| Windows | owner-scope logical route | storage authority 可用；managed worker sandbox 仍按 M1.2 的 Windows 有限支持矩阵 fail closed |

M1.3 不宣称能物理阻止用户修改 app-data 中的 artifact。owner 在每次新 acquisition 时验证完整 inventory/content digest；
发现 artifact identity 漂移时停止签发 scope，并保留目录作为诊断证据。未来 Shell/Build 若要求操作系统级 mount/overlay，必须
作为新的平台 I/O 不变量设计，不能把 v1 logical read binding 悄悄升级成可写链接。

## 5. Producer policy

生产 producer 必须绑定可验证的 package-manager runtime。M1.3 随 Desktop release 打包固定的 npm 12.0.2
JavaScript runtime，并用全量文件 inventory、逐文件 SHA-256、Node version/ABI 与 platform/arch 共同确定 authority：

producer 不是一个可任意扩展的通用函数。authority 只接受精确的 `hermetic_dependency_builder_v1` capability：

```text
network: registry_https_only
filesystem: maka_owned_staging_only
secrets: none
childProcess: verified_runtime_only
lifecycleScripts: disabled
```

该 capability 的 policy digest 与 bundled runtime tree digest 同时进入 environment identity 和 durable receipt。新增 producer
必须定义新的显式 capability/policy identity 并单独证明其网络、文件系统、secret 与 child-process 边界；不能在现有 capability
下加入 `curl`、`git clone`、任意 shell 或系统 package manager fallback。这里的 capability 是 admission contract；实际生产路径仍只
组装经过完整 manifest 验证的 bundled npm producer，不把类型声明冒充操作系统 sandbox。

- M1.3 authority/binding 不得调用系统 package manager；
- 测试 producer 只能用于 production-shaped fixture，不能成为默认生产 fallback；
- 没有 configured producer 时，请求 dependency provisioning 必须返回稳定的 `managed_dependency_producer_unavailable`；
- npm producer 只接受 manifest 显式声明的 `npm@12.0.2` 与非 workspace 的 package-lock v3；
- producer 从实际 Node/Electron executable 探测 version、ABI、platform 与 arch；Node 不满足 npm 12 的
  `^22.22.2 || ^24.15.0 || >=26.0.0` 时在 environment identity/acquire 前 fail closed；
- `prepare:bundled-npm` 必须把 npm 12.0.2 自带、受 GHSA-r292-9mhp-454m 影响的 tar 7.5.19
  确定性替换为 tar 7.5.22；source/replacement 版本不精确匹配即停止发行，最终 manifest 对替换后的树取证；
- 安装固定使用官方 npm registry、隔离 HOME/user/global config、`npm ci --ignore-scripts --no-audit --no-fund`；
- lockfile 中的 link、install script 与非官方 registry resolved URL 在 provisioning 前 fail closed；
- npm runtime 采用 Artistic-2.0，完整 dependency closure 进入发行版 third-party notices，不改变 Maka 的 Apache-2.0 源码许可；
- 每种 lockfile 必须有显式 adapter；未知或多重冲突 lockfile fail closed。

首个生产 producer 建议只支持项目声明的 exact npm 版本和 `package-lock.json`，再分别增加 pnpm/yarn；不能用一个“自动猜 package manager”的宽松入口。

### 5.1 M1.3 发行体积证据

Windows x64 开发树中，固定 npm 12.0.2 runtime（含 tar 7.5.22 security replacement）物化后为
2,165 个普通文件、14,218,997 bytes；完整 runtime manifest 为 396,673 bytes。合并 npm closure 后的
third-party notices 为 675,354 bytes，相对基线增加约 25 KiB。也就是说，未压缩 release resource 的
确定性增量约 14.64 MB；最终安装包增量取决于
electron-builder 的目标格式与压缩率，必须由 Windows/macOS release CI 分别记录，不能用未压缩数字冒充安装包结果。

## 6. 生命周期与失败状态

稳定失败码至少包括：

```text
managed_dependency_manifest_unsupported
managed_dependency_lockfile_missing
managed_dependency_identity_conflict
managed_dependency_producer_unavailable
managed_dependency_provision_failed
managed_dependency_artifact_corrupt
managed_dependency_binding_conflict
managed_dependency_binding_drifted
managed_dependency_environment_busy
```

回滚方式：

- pre-publish crash：删除过期 staging；canonical tree 未改变；
- post-publish/pre-bind crash：保留可复用 artifact，重启后按 receipt reopen；
- post-bind/pre-scope crash：logical binding 未持久化；重启后重新验证 artifact；无 durable half-scope；
- binding drift：scope 立即失效，不修改 source checkout；
- artifact corruption：所有引用它的新 admission fail closed；v1 不在可能仍有 active lease 时移动目录，待 lease-aware
  quarantine 有明确生产需求后再增加；
- producer failure：保留诊断，删除 staging，不 fallback 到 source `node_modules` 或系统 package manager。

## 7. Crash 与对抗矩阵

首个可合并切片必须覆盖：

| 中断/攻击点 | 重启后的唯一合法结果 |
|---|---|
| identity 计算后、lease 前 | 可安全重试 |
| staging 创建后、producer 前 | orphan staging 可 GC |
| producer 中途退出 | 不发布 artifact |
| receipt durable 前后 | 未发布目录清理，或已发布 receipt 可验证 |
| publish rename 前后 | 最多一个 canonical artifact |
| logical binding/scope 签发前后 | 无 durable half-binding；新进程必须重新 acquire artifact |
| scope 签发前进程退出 | 无 durable half-scope |
| 第二个 Desktop/CLI writer 同时打开同一 storage root | 在 root-owner OS lock 处失败，不进入 provision/GC |
| source checkout 有 `node_modules` | 永不读取、复制或链接它 |
| 伪造/过期/cross-owner scope | worker dispatch 前 fail closed |
| 用户修改 shared artifact | 所有新 admission fail closed，保留现场供诊断 |
| lockfile/Node ABI/platform 改变 | 产生新 identity，不复用旧 artifact |

## 8. 单一 M1.3 PR 的施工顺序

M1.3 作为一个分支和一个 PR 交付，只证明本文开头的一条主要不变量。为了让审查仍可逐层验证，PR 内部按以下
独立 commit 顺序施工，不把多个事实权威混在同一 commit：

1. environment identity、artifact authority、原子 publish/reopen 与 fail-closed code；
2. managed owner/scope/worker 的 owner-bound 只读 binding；
3. 发行包内固定版本 package-manager producer；
4. production-shaped crash、并发、tamper 与 Linux/macOS/Windows 平台验证；
5. release size、license、GC 与性能证据。

最终 PR 必须同时闭环：同一 owner 可以把由 bundled producer 生成的 artifact 原子发布、验证、共享并只读绑定到
managed scope；没有 producer 时 fail closed；默认生产路径不调用系统 package manager。不能只合入没有 producer
或没有 managed worker 消费者的半成品。

### M1.3 之后

secret projection 与 scratch 只有在 M2/Shell 出现生产消费者后才各自开独立 PR。它们不能被塞进 dependency PR，也不能改变 canonical Git tree。
