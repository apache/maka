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

首个生产消费者是模型可见的 `ManagedWorkspaceInspect` 专用只读任务工具。它不是 session execution mode，也不会替换普通 Read/Glob/Grep：只有模型显式调用该工具时，当前 session cwd 才会作为 source 进入 managed admission。工具参数只能表达一个有界的 Read、Glob 或 Grep 操作，不能提供 source root、workspace identity、raw cwd 或 execution profile。

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

路由判断不直接消费原始首段。完整输入必须先按平台路径语义验证；任何包含 `.`、`..`、空 segment 或其他非 canonical 形状的路径都直接拒绝。Windows 的 `node_modules` 身份比较大小写不敏感，因此 `NODE_MODULES/**` 也必须进入 leased dependency root，不能落回 managed worktree。

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

调用者取消从 Runtime Host composition 贯穿 baseline admission、Git invocation、`ManagedWorkspaceOwner`、dependency authority 到 producer。可取消的 artifact writer admission 使用有界轮询获取 OS lock，取消后不会留下仍在等待锁的后台 owner。等价 environment 的并发 acquisition 共用一次 publication，但共享 producer 不受任意单个 waiter 支配：只有最后一个 waiter 放弃且 publication 尚未结束时，authority 才终止 producer。若新 caller 在被撤销 publication 的清理窗口进入，它必须等待旧 owner 收敛后重新观察 canonical slot，不能继承旧 caller 的 abort。Host drain 等待 admission、acquisition 和 producer 清理结束后才能关闭 receipt authority。

`ManagedWorkspaceInspect` 从 ToolRuntime context 取得 canonical session cwd 与 AbortSignal。Host 以 canonical source root 和 session identity 域分离地产生稳定的 repository/workspace/epoch/instance identity；模型无法自认证这些 ID。同一 session/source 的多次只读任务复用同一 accepted baseline，source 后续漂移时 fail closed，不在工具内部创建隐式 rebaseline。工具使用 `replay_safe`：它只消费同一 managed baseline 的只读结果，崩溃后重复 admission 不产生 workspace mutation；provider-facing 结果另有 64 KiB 上限，超限要求缩小读取或搜索范围。

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
- caller abort：baseline Git admission、尚未签发 scope 的 acquisition 与 filesystem worker 均消费同一 signal；若已没有其他 waiter，则回收 producer tree 与 staging；不得继续签发 scope。

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
6. 生产模型工具注册 `ManagedWorkspaceInspect`，并由该工具打开 owner-bound profile；
7. filesystem worker读取逻辑 `node_modules/**` 时得到 Maka-owned 内容，而不是 attached 内容；
8. drain/close 能在 lease释放后完成；
9. producer missing、manifest mismatch、path traversal、forged scope、unbound logical state均 fail closed。
10. 真实 Host 子进程在 dependency receipt durable 后退出；同一 source/session/task 重开后只存在一份 canonical baseline、dependency artifact 与 receipt，staging 为空，并返回相同只读结果。

当前切片通过 `ManagedWorkspaceInspect` 形成 M1.3 的生产闭环：普通 session 保持 attached；显式工具调用才进入 managed baseline、dependency lease 与 read-only worker，工具完成后 scope 与 lease 均释放。production-shaped 测试使用真实 Git source、execution stores、root owner、attested npm child process 和 managed owner，并通过该生产工具读取 Maka-owned `node_modules`，不再直接把内部 composition API 当作消费者。

这不等于 session-level managed mode 已完成。将来若让整个 session 的普通 Read/Write/Bash 都进入 managed workspace，仍必须显式定义 durable execution profile、M2 mutation acceptance 与 M3 workspace-bound continuation；不能把本工具的 session/source identity 偷换成全 session 模式。
