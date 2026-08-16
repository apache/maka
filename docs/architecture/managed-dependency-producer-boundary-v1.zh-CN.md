---
document_status: implementation-contract
status: draft-stacked-foundation
date: 2026-08-08
milestone: M1.3
stack_base: managed-dependency-storage-authority-v1
---

# Managed Dependency Producer Boundary v1

## 1. 本 PR 只证明一个主要不变量

> 在 storage authority 复制 producer 输出以前，固定 npm producer 必须只在一次性 Maka-owned staging 中运行；它不能继承 host secrets、不能创建 child process、不能执行 lifecycle script，并且只有在根进程退出、输出 drain、最终 inventory 与 observed-limit 验证全部完成后才允许 `provision()` resolve。

本 PR 的候选 owner 是 Runtime Host 模块内部的 `runManagedNpmDependencyProvision()`。它拥有固定 npm argv、hermetic environment、Node permission profile、staging project layout、manifest/lockfile admission、timeout/abort、process lifecycle、bounded diagnostics，以及运行中和终态 filesystem inventory。

`runManagedNpmDependencyProvision()` 与低层 `runManagedDependencyProducerProcessInternal()` 均不通过 Runtime Host server barrel 暴露。PR 2 没有 runtime attestation owner，因此任何 raw executable path 都不能成为 production 输入。PR 3 必须先把经过 manifest/digest 验证的、有限 Node major allowlist 内的 bundled runtime capability 与该模块共同落地，之后才能公开固定 npm 入口。后续 PR 不能绕过该入口自行 spawn package manager。

本 PR 不包含：

- bundled npm/Node 文件树、manifest、digest、license 或 release packaging；
- Desktop、CLI、ManagedWorkspaceOwner 或 Runtime Host composition 接线；
- dependency lease 到 Read/Glob/Grep worker 的 logical binding；
- Shell/Build、Write/Edit 或 workspace mutation；
- 用户 PATH 上的 npm fallback；
- production network broker。

因此本 PR 必须保持 Draft。它与 PR 1、PR 3 一样没有独立用户能力；PR 3 完成 runtime attestation 前，当前固定 npm 入口也不能成为生产 API。只有 PR 4 的 production consumer 和端到端测试成立后，整个 stack 才能按顺序转 Ready。

## 2. 固定 producer 协议

v1 只接受：

```text
package manager: npm 12.0.2
manifest: packageManager == npm@12.0.2
lockfile: non-workspace package-lock v3
resolved URL: https://registry.npmjs.org/**
integrity: sha1/sha256/sha384/sha512 SRI
link dependency: rejected
hasInstallScript: rejected
package entries: <= 25,000
manifest bytes: <= 1 MiB
lockfile bytes: <= 64 MiB
```

固定 invocation：

```text
verified-node
  --permission
  --allow-fs-read=<verified npm runtime root>
  --allow-fs-read=<owned staging project>
  --allow-fs-write=<owned staging project>
  <verified npm-cli.js>
  ci
  --ignore-scripts
  --no-audit
  --no-fund
  --package-lock=true
  --cache=<owned scratch/cache>
  --userconfig=<owned scratch/home/npmrc>
  --globalconfig=<owned scratch/home/global-npmrc>
```

没有 `--allow-child-process`，因此 production npm root process 不能创建 descendant。`PATH`、`NODE_OPTIONS`、proxy、credential、registry token 和任意 host environment 都不继承；HOME、npm config、temp 与 Node compile cache 全部指向同一次 staging 的 scratch。

PR 3 必须提供经过完整 manifest/digest 验证的 Node executable、npm runtime root 与 npm CLI，并使用有限 Node major allowlist。它必须在同一 Runtime Host package 内完成不可伪造 capability 的发行与消费，再由 server barrel 公开组合后的入口；不能仅把 raw path 验证留给调用者。它也不能覆盖 argv、env、timeout 或 observed limit。

## 3. Owner、时序和失败状态

```text
validate identity + manifest + lockfile
  -> canonicalize exact output/scratch/runtime paths
  -> create owned scratch children with exclusive creation
  -> write exact npm configs + manifest + lockfile
  -> spawn one detached root process with no child-process capability
  -> monitor whole staging project every 100 ms
  -> abort / timeout / invalid tree / observed limit: terminate process tree and await exit + I/O drain
  -> normal root exit
  -> await stdout/stderr drain
  -> final complete inventory
  -> exit code == 0
  -> provision resolves
  -> PR 1 storage authority may deep-copy producer output
```

稳定失败原因：

```text
aborted
timeout
filesystem_limit_exceeded
filesystem_invalid
output_drain_incomplete
process_failed
```

失败不会发布 artifact 或 receipt。transaction root 仍由 PR 1 storage authority 拥有并在 producer rejection 后删除；PR 2 不新增第二个 durable owner、数据库或 cleanup journal。

## 4. Filesystem inventory 与 `.bin`

默认 soft observed limit 固定为 2 GiB 和 250,000 entries，不能由 PR 3/4 调高。它通过 100 ms polling 与最终 inventory 保证“超限结果绝不进入 artifact publication”，但不是 OS/filesystem 强制的峰值磁盘 quota；producer 可在相邻 observation 之间短暂超写。若产品要求防止磁盘被瞬时写满，必须另建 OS quota、受控写入 broker 或等价平台 owner，不能把 polling 描述为 disk-safety boundary。

空文件、目录、普通文件和合法 symlink 都计入 observed entry limit；普通文件 size 与 symlink target bytes 计入 observed byte limit。进程退出后必须再做一次完整终检，避免短命 producer 在 monitor tick 前超限后退出。

Linux/macOS 允许 npm 的典型相对 `.bin` symlink，例如：

```text
node_modules/.bin/tool -> ../package/bin/tool.js
```

target 必须按 link 所在目录解析后仍位于 staging project 内。absolute/escaping symlink fail closed。Windows 的 npm shim 应为普通 `.cmd/.ps1` 文件；symlink、junction/reparse point 在 inventory 或后续 PR 1 artifact seal 中拒绝。

## 5. 平台能力矩阵

| 平台 | child process | timeout/abort | `.bin` | 保证 |
|---|---|---|---|---|
| Linux | PR 3 attested Node permission 禁止；异常终止用 process group + descendant scan | root 存活时先收割树，再 reject | contained relative symlink | production-shaped POSIX 测试必须执行 |
| macOS | PR 3 attested Node permission 禁止；异常终止用 process group + descendant scan | root 存活时先收割树，再 reject | contained relative symlink | `/var` alias 由 canonical path 处理 |
| Windows | PR 3 attested Node permission 禁止；异常终止用 `taskkill /T /F` | root 存活时先收割树，再 reject | 普通 npm shim；reparse 拒绝 | 无 Job Object；禁止任意可生 descendant 的 producer |

Node permission model 与 PR 3 runtime attestation 必须共同存在，才构成 production root-only 证明；二者都不是可选 hardening。内部任意 argv primitive 不承诺在 root 已退出后回收 detached descendant，且不得成为 production consumer。若未来 package manager 必须启动 child process，必须定义新的 capability/policy identity，并为 POSIX 引入 cgroup/subreaper 或为 Windows 引入 Job Object 等真实平台 owner；不能在 `hermetic_dependency_builder_v1` 下静默加入 `--allow-child-process`。

## 6. Network 边界与尚未闭环的证明

本 PR 固定官方 registry config，并在 spawn 前拒绝非官方 `resolved` URL；无 lifecycle script、无 child process、无 host proxy/credential 环境。它没有单独提供一个 OS 级 host allowlist。

因此 `registry_https_only` 的完整证明依赖 PR 3 对 bundled npm runtime tree 的不可变验证，以及 PR 4 的 production composition/egress 决策。本 PR 不能单独被描述为已经提供强网络 sandbox。若 PR 4 要求网络层也成为强制 host allowlist，应增加 host-owned registry fetch broker 或等价执行边界，并产生新的 production-shaped 网络对抗测试；不能仅靠文案把 npm config 当作 OS enforcement。

## 7. Crash 与对抗矩阵

| 场景 | 唯一合法结果 |
|---|---|
| manifest/lockfile 不满足固定 policy | spawn 前拒绝 |
| scratch child 被 symlink/junction 预占 | spawn 前拒绝；outside 不写入 |
| npm 尝试创建 child process | Node permission 拒绝；不产生 descendant side effect |
| caller abort | tree 完全退出且 I/O drain 后返回 `aborted` |
| timeout | tree 完全退出且 I/O drain 后返回 `timeout` |
| observed byte/entry limit 超限 | tree 完全退出后返回 `filesystem_limit_exceeded`；超限内容不发布，但不承诺峰值磁盘占用 |
| escaping/unsupported entry | tree 完全退出后返回 `filesystem_invalid` |
| root exit 非零 | bounded stderr/stdout tail 随 `process_failed` 返回 |
| output 在 deadline 前未 drain | 返回 `output_drain_incomplete`；该状态禁止发布。PR 3 通过 attested no-child runtime 使 descendant 形状不可达 |
| producer 成功后 storage deep-copy 前 host 崩溃 | PR 1 启动清理 staging，无 artifact/receipt |

child-process crash test 只能证明进程生命周期，不是断电测试。PR 2 不写 durable fact，所以没有 schema migration 或数据库 recovery 语义。

## 8. Extraction ledger

| 旧集成提交 | PR 2 处理 |
|---|---|
| `89c9e0a3c feat(runtime-host): ship verified bundled npm environments` | 只提取固定 npm argv/env、input validation 与 process-owner 轮廓；runtime manifest/release 归 PR 3 |
| `8150e90a7 fix(runtime-host): constrain bundled npm provisioning` | 重写 timeout/abort、quota、scratch 与 `.bin` policy；不迁移仅 `child.kill()` 的旧生命周期 |
| `27f8f6b8e fix(release): verify shipped bundled npm closure` | 不属于 PR 2；全部留给 PR 3 |
| `9a42a761c fix(runtime-host): transport packaged dependency authority` | 不属于 PR 2；production composition 留给 PR 4 |

本 PR 从 PR 1 head 平铺增加 producer owner，没有 cherry-pick 上述跨边界提交。
