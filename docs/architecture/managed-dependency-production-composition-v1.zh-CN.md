---
document_status: implementation-contract
status: implemented-stacked-pr4
date: 2026-08-09
milestone: M1.3
stack_base: bundled-npm-runtime-attestation-v1
---

# Managed Dependency Production Composition v1

## 1. 本切片只证明一个主要不变量

> Runtime Host 请求 `dependency_environment_v1` 时，只能消费由当前 storage-root owner 创建、由 attested bundled npm producer 物化、由 durable receipt 证明且仍持有 active lease 的 Maka-owned dependency artifact；任一证据缺失时必须在 worker dispatch 前 fail closed，不得退回 attached checkout 的 `node_modules`、用户 PATH 上的 npm 或未经验证的目录。

本切片把前三个独立基础切片组合成首个生产组合链路：

1. storage authority：拥有 identity、staging publication、receipt、lease、GC 与 crash convergence；
2. producer boundary：拥有固定 npm argv、Permission Model、hermetic environment、process-tree 回收与 bounded observation；
3. bundled npm attestation：拥有 release manifest、完整 runtime inventory、Node executable/runtime identity 与重验能力；
4. 本切片：由 Runtime Host candidate、execution composition、`ManagedWorkspaceOwner` 和 filesystem worker bridge 连接以上能力。

本切片不启用 Desktop UI 的默认 managed mode，不改变普通 attached checkout，不提供 Shell/Build、Write/Edit、secret projection 或 scratch capability，也不把依赖环境当作 workspace checkpoint。

## 2. Owner 与能力边界

### 2.1 生产 owner 链

```text
packaged Electron process identity
  -> fixed process.resourcesPath
  -> bundled Git + bundled npm attestation
  -> interactive root owner / OS writer lock
  -> Runtime Host execution composition
  -> ManagedWorkspaceOwner
  -> ManagedDependencyEnvironmentAuthority
  -> owner-token execution scope
  -> sandboxed filesystem worker
```

只有 packaged Electron（存在 Electron identity 且 `defaultApp !== true`）可以把 `process.resourcesPath` 解释为 release authority。Node/CLI 与开发态 Electron 不从 ambient directory 自动发现 bundled runtime。测试可以显式注入 verified Git input，但生产 npm producer只能从 attested bundled resources 创建。

`ManagedWorkspaceOwner` 是跨 Git baseline、dependency lease 与 worker scope 的组合 owner。它负责：

- 从 accepted baseline commit 读取 tracked `package.json` 与 `package-lock.json`；
- 拒绝 canonical tree 中已 tracked 的 `node_modules`；
- 要求 `packageManager` 精确等于 `npm@12.0.2`；
- 用 manifest/lockfile bytes、Node ABI、platform/arch、producer runtime/policy digest 计算 environment identity；
- 在可能耗时的 provision 完成后重新验证 root identity、Git artifact 与 immutable workspace head；
- 仅在上述重验通过后签发带 dependency root 的 owner-token scope；
- scope 结束时先 revoke，再 release dependency lease；owner drain 后关闭 dependency authority，最后才允许 root owner 关闭。

Runtime Host 只接收公开的 execution-stores facade。raw workspace baseline writer 通过 module-private WeakMap seam 绑定到该 facade，不作为公共 API 暴露，调用方不能自己拼接未认证 store。

## 3. 原子性边界与 durable root identity

artifact publication 与 receipt 的原子性仍由 storage authority 切片负责。本切片不创建第二套事实源。生产组合只消费：

```text
verified baseline commit
  + canonical environment identity
  + verified artifact/receipt pair
  + active lease
  + current workspace head
```

workspace baseline authority 首次使用前必须绑定 `.maka-storage-root.json` 的 durable `root_id`。新建 runtime database 在其他 operational authority 写入事实前完成绑定。旧的 unbound database 如果已有 session、RuntimeEvent 或非空 authority state，必须走显式 whole-root adoption；不能由启动代码静默认领。

允许在 binding 前存在的只有精确 bootstrap 状态：schema/capability rows、revision 为 0 的 automation/usage authority row，以及 generation/pending_writes 均为 0 的 session catalog row。控制行一旦变化即属于 logical state，自动绑定必须 fail closed。

## 4. Logical `node_modules` binding

managed worktree 内不创建 symlink、junction，也不复制 dependency tree。owner scope 内部持有真实 dependency root；worker bridge 把以下逻辑路径映射到该 root：

```text
node_modules/**
<managed cwd>/node_modules/**
```

worker permission profile只增加 exact dependency root 的 read-only subtree，不扩大到 storage root。返回的 Glob/Grep 路径重新映射成 `node_modules/**`，真实 artifact path 不进入模型可见结果。

路径 admission 在 worker dispatch 前拒绝：

- `..`、`.`、空 segment；
- NUL；
- `:`（Windows ADS 与 drive-like 非 canonical 形状）；
- absolute escape 或 dependency root 外路径；
- provisioning 与 dependency root 不成对的 forged scope。

如果 scope 请求 `dependency_environment_v1` 但没有 exact lease root，必须拒绝整个 operation，不能把相同逻辑路径交给 attached cwd。

## 5. Producer 与运行时协议

生产 producer只接受 PR3 发出的不可伪造 `ManagedNpmRuntimeCapability`。每次 provision 都重新验证 Node executable 与 bundled npm完整 inventory，然后运行：

```text
node --permission
  --allow-fs-read=<attested npm runtime>
  --allow-fs-read=<owned staging project>
  --allow-fs-write=<owned staging project>
  npm-cli.js ci
  --ignore-scripts --no-audit --no-fund --package-lock=true
```

环境不继承 host secrets、HOME、npm config 或 PATH package manager。HOME、cache 与 TEMP 都位于本次 staging。Node compile cache 显式禁用：producer 生命周期很短，没有可衡量收益；Node 26/Windows 在 Permission Model 与 `NODE_COMPILE_CACHE` 同时启用时可能卡在启动阶段，因此该组合不属于 v1 profile。

producer failure、timeout、abort、process-tree drain failure、runtime revalidation failure 或 observed limit failure都回滚 staging，不发布 receipt，也不 fallback。

## 6. 稳定失败与回滚

主要稳定失败包括：

```text
managed_workspace_profile_unavailable
managed_workspace_execution_options_invalid
managed_dependency_producer_unavailable
managed_dependency_manifest_unsupported
managed_dependency_provision_failed
managed_workspace_operation_denied
```

回滚/收敛规则：

- bundled runtime 不可验证：candidate 不获得 managed owner；attached execution 独立存在；
- baseline manifest/lockfile 不支持：scope 不签发，worktree 与 source 不修改；
- provision 中断：producer tree被回收，staging由 authority 清理；
- artifact 已发布但 receipt 未提交：按 storage authority 协议删除 orphan 并重建；
- receipt 已提交但 scope 未签发：下次 acquire 重验并复用，无 durable half-scope；
- provision 后 workspace head/drift 变化：释放 lease并拒绝 scope；
- operation 完成/失败：先 revoke scope，再释放 lease；
- host drain：等待 active operation，关闭 workspace composition/managed owner/dependency authority，最后释放 root owner。

## 7. 平台能力矩阵

| 平台 | dependency authority | producer profile | logical worker binding | v1 承诺 |
|---|---|---|---|---|
| Linux | 支持 | Node Permission Model + process group | exact read-only root | process-crash convergence；不承诺断电级 storage durability |
| macOS | 支持 | 同 Linux；canonical path alias | exact read-only root | process-crash convergence；普通 `fsync` 不提升为 `F_FULLFSYNC` 承诺 |
| Windows | 支持 | Node Permission Model + process-tree owner；compile cache关闭 | 依赖 M1.2 Windows sandbox能力，缺失则 fail closed | process-crash convergence；不承诺 power-loss convergence |

observed bytes/entries 是 soft postcondition，不是 OS quota；不能宣称它能阻止瞬时磁盘超写。项目 dependency artifact 存在 storage cache，不打进 Maka release，因此用户项目依赖不会继续膨胀安装包。

## 8. Production-shaped verification

本切片必须至少证明：

1. 真实 Git source baseline，且 source 中存在 ignored attached `node_modules`；
2. 真实 execution stores/root owner 与 durable root binding；
3. attested fixture npm runtime经真实 producer child process运行；
4. storage authority发布并租用 artifact；
5. Runtime Host workspace composition打开 managed profile；
6. filesystem worker读取逻辑 `node_modules/**` 时得到 Maka-owned 内容，而不是 attached 内容；
7. drain/close 能在 lease释放后完成；
8. producer missing、manifest mismatch、path traversal、forged scope、unbound logical state均 fail closed。

M1.3 完成后的能力边界是“Runtime Host 具备可组合的 managed dependency read profile”。后续 session/task routing 仍需显式选择该 profile；在选择器进入 Desktop/CLI 前，不应宣称所有用户任务默认运行在 managed worktree。
