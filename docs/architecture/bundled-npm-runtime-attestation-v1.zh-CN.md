---
document_status: implementation-contract
status: draft-stacked-foundation
date: 2026-08-08
milestone: M1.3
stack_base: managed-dependency-producer-boundary-v1
---

# Bundled npm Runtime Attestation v1

## 1. 本 PR 只证明一个主要不变量

> 在调用方已经取得“来自 Maka 已签名发布物”的 resources-root authority 后，固定 npm producer 只能使用其中完整清单验证通过、且绑定当前受支持 Host Node 的 npm 运行闭包；调用者不能通过伪造结构体、传入任意 executable 或在签发后替换 npm 文件来取得执行权。

本 PR 的 owner 是 Runtime Host package 内部的 bundled npm attestation 模块。它拥有 npm 运行树 manifest 的解码、完整文件清单校验、Host Node 版本与 executable identity、不可伪造 capability 的签发和每次调用前的重新验证。

这里必须区分两层证明：外层应用签名与平台发布链提供 **provenance trust**，本模块的 manifest 提供 **runtime integrity**。manifest 与 npm tree 位于同一资源目录，攻击者若能同时替换二者并重算摘要，本模块本身无法识别；它绝不是自足的密码学信任根。PR 3 的 API 合同因此有一个显式前置条件：`resourcesRoot` 必须已经由后续 packaged-process owner 认证。本 PR 单独只能证明“受权目录在 admission 与每次 invocation 时没有发生未声明变化”，不能证明任意目录来自 Maka。

本 PR 不包含 Desktop/CLI/Runtime Host composition 的生产 consumer。attestation resolver、capability issuer 和固定 npm provision 入口不通过 `@maka/runtime-host/server` 公共 barrel 暴露；PR 4 必须在一个固定 `resourcesPath` 的 composition owner 中把三者接通。因此本 PR 保持 Draft，不能单独宣称 M1.3 已可用。

## 2. 为什么只 bundled npm，不再 bundled 一份 Node

Maka 已经由 Electron 或当前受控 Runtime Host 携带 Node。再打包第二份 Node 会增加包体、补丁与许可证维护面，并制造“两套 Node authority”。v1 直接绑定当前 Host runtime：

```text
process.execPath canonical path + SHA-256
+ process.versions.node
+ process.versions.modules (ABI)
+ platform / arch
+ 完整 npm tree manifest
= ManagedNpmRuntimeCapability
```

Node 支持范围采用有限 allowlist；未知未来 major 默认拒绝，必须经过 permission-model 兼容验证后显式加入。当前允许：

- Node 22.22.2 及同 major 后续版本；
- Node 24.15.0 及同 major 后续版本；
- Node 26.x；
- 其他 major 全部拒绝。

## 3. 发布闭包与供应链

发布准备从锁定的 `npm@12.0.2` 生成一个 Maka-owned runtime tree，并替换 npm 自带闭包中的四个已知脆弱版本：

| package | npm 原版本 | 发布版本 | 证据 |
| --- | --- | --- | --- |
| `tar` | 7.5.19 | 7.5.22 | GHSA-r292-9mhp-454m |
| `brace-expansion` | 5.0.7 | 5.0.9 | GHSA-mh99-v99m-4gvg；GHSA-rgw5-rvv9-x895 |
| `ip-address` | 10.2.0 | 10.4.0 | 三条 manifest 中固定的 GHSA |
| `undici` | 6.27.0 | 6.28.0 | 三条 manifest 中固定的 GHSA |

准备过程拒绝 symlink/junction，只接受 regular file/directory，输出：

```text
apps/desktop/.generated/bundled-npm/
  npm/**                 完整 npm runtime tree
  bundled-npm.json       每个文件的 path、bytes、sha256
  audit/package-lock.json 独立 production audit 视图
```

release gate 对独立 audit lock 执行 `npm audit --omit=dev --audit-level=high`。当前实际生成闭包约 14.6 MB，audit 为 0 vulnerabilities。生成目录不进入 Git；每次打包重新生成并验证。

## 4. 权限边界

`ManagedNpmRuntimeCapability` 的 TypeScript 形状不是权限。真实权限由 Runtime Host 模块内的 `WeakMap` 记录：只有 internal issuer 产生的对象才能通过消费 gate。结构相同的普通对象必须被拒绝。

签发器同样不属于公共 package API。否则任意调用者可以为自建目录生成“合法” capability，变成自认证。PR 4 的 composition owner 只能以打包应用的固定 resources root 调用 internal resolver，不能接受用户或 operation 传入的路径。

每次 npm invocation 前必须重新验证：

1. Host executable canonical path 未变；
2. Host executable digest 未变；
3. npm runtime 仍只含 regular files/directories；
4. 实际文件集合、大小与 SHA-256 完全匹配 manifest；
5. npm `package.json` 仍是 `npm@12.0.2`、`Artistic-2.0`。

任一项失败都在 spawn 前 fail closed。

## 5. 原子性、失败状态与回滚

本 PR 不写用户 workspace，也不产生 durable T1/T2。它的原子边界是“通过全部验证后签发 capability”；验证中途失败不产生 capability。

稳定失败分类：

- `bundled_npm_unavailable`：资源或 Host executable 不可读；
- `bundled_npm_manifest_invalid`：manifest 形状、路径或范围非法；
- `bundled_npm_platform_mismatch`：platform/arch 不匹配；
- `bundled_npm_integrity_mismatch`：文件集合、内容、版本或许可证不匹配；
- `bundled_npm_node_unsupported`：Host Node 不在验证 allowlist。

回滚本 PR 只需移除 npm release resources、manifest preparation 与 internal attestation 模块；PR 1 storage authority 和 PR 2 producer lifecycle 不需要回滚。没有兼容旧 manifest 的承诺：本能力尚无生产 consumer，格式变化应明确断代而不是建设迁移层。

## 6. 平台能力矩阵

| 能力 | Linux | macOS | Windows |
| --- | --- | --- | --- |
| regular-file tree inventory | 支持 | 支持 | 支持 |
| symlink/reparse input | 拒绝 | 拒绝 | 拒绝 junction/reparse |
| Host executable digest binding | 支持 | 支持；签名仍由外层 app 发布链保证 | 支持；Authenticode 仍由外层 app 发布链保证 |
| 每 invocation tree revalidation | 支持 | 支持 | 支持 |
| npm producer permission profile | Node permission model | Node permission model | Node permission model |

manifest 与 npm tree 一起受最终应用签名/发布物保护。macOS 的 trust root 是通过 Gatekeeper/代码签名发布的 app bundle；Windows 的 trust root 是 Authenticode 签名的安装包与已安装应用。Linux v1 没有统一的平台签名验证 API，因此只承诺由官方发布/更新链安装后的完整性检查，不把任意本机目录提升为可信发布物。manifest hash 本身不是独立信任根；如果恶意本机进程已经能替换已安装应用资源、伪造父进程或直接运行修改后的 Maka 代码，本层不声称独立抵抗该攻击。

同理，后续父子进程 bootstrap 只负责把已经取得的 application authority 传给 detached Host，防止普通 CLI 参数或 ambient path 被误当成发布资源；它不是 macOS code-signing/Windows Authenticode 的替代物，也不抵御能够任意创建 Electron 父进程和 fd channel 的同用户恶意进程。若产品威胁模型将该攻击者纳入边界，必须另行引入平台签名验证 owner，不能继续给 bootstrap 增加可伪造字段。

## 7. Crash / tamper matrix

| 时点 | 结果 |
| --- | --- |
| 准备 runtime tree 中途退出 | 生成目录不进入发布物；下一次 preparation 全量重建 |
| manifest 写入前退出 | release verifier 因 manifest 缺失失败 |
| manifest 与 tree 不一致 | runtime admission 拒绝 |
| capability 签发后 npm 文件被修改 | 下一次 invocation 在 spawn 前拒绝 |
| capability 被结构化伪造 | WeakMap gate 拒绝 |
| Host Node 被替换 | canonical path/digest revalidation 拒绝 |
| platform/arch 不一致 | admission 拒绝 |

## 8. PR 4 的硬前置

PR 4 才能增加首个生产 consumer，并必须同时证明：

1. Desktop/Runtime Host 只从固定 packaged `resourcesPath` 解析 npm；
2. storage authority、producer owner、runtime capability 由同一 composition 生命周期持有；
3. production-shaped 测试使用实际生成的 npm tree，从 hermetic loopback registry 安装一个真实 tarball package，验证解包与 `.bin` 生成后再完成依赖环境 acquire；
4. runtime identity 写入 dependency environment identity，不能由调用者自报；
5. shutdown 顺序先停止新 acquire，再 drain producer，最后关闭 storage authority。

在这五项完成以前，PR 1–3 都只是可独立审查的 stacked foundation，不是用户能力。
