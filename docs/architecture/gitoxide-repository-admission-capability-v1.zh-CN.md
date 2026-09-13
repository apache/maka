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

# Gitoxide repository admission capability v1

完整的 Phase 3/4 workspace continuity 路线见 [Runtime Resume Phase 3/4 Workspace Checkpoint Design](./runtime-resume-phase3-phase4-workspace-checkpoint-design.zh-CN.md)，其交付状态由该设计文档链接的 tracker 统一维护。

状态：Gitoxide repository admission / source-import 的可合并 enabling infrastructure；source import data
plane 作为同一 PR 内的独立 authority layer 消费该 capability，产品接线仍未完成。

## 1. 主要不变量

本切片只证明：

> caller 不能用裸 repository path、object format、commit OID 或 tree OID 自证 source identity。
> 只有 owner-bound helper capability 的一次真实、严格 SHA-1 observation，才能签发指定 admission
> owner 可解析的 opaque capability；SHA-256/未知格式只返回 policy rejection，不产生 capability。

## 2. Owner 与事实流

```text
helper invocation owner
  └─ exact repository_inspected response
       ↓
repository admission authority
  ├─ canonical repository path
  ├─ protocol/object format
  ├─ exact HEAD commit OID
  └─ exact HEAD tree OID
       ↓ private WeakMap
opaque GitoxideRepositoryAdmissionCapability
       ↓ only the designated import owner may resolve
immutable admission state
       ↓ exact verified commit/tree graph
fresh SHA-1 bare baseline repository
```

认证元数据与可返回 observation state 分开存储；解析 capability 不会泄漏 owner token。相关 API 不从
`@maka/runtime-host/server` 导出。

## 3. 原子性、失败状态与回滚

| 项目 | v1 合同 |
| --- | --- |
| observation owner | short-lived invocation owner |
| capability owner | repository admission authority |
| admission 原子性边界 | 一次 canonical path observation + 一次 exact helper response + 进程内 capability 签发 |
| import 原子性边界 | 完整 preflight 后用 `create_dir()` 领取 fresh destination；baseline ref 只允许 `MustNotExist` |
| accepted | SHA-1 exact commit/tree，签发 opaque capability |
| policy rejected | SHA-256/未知 format，返回 rejection，不签发 capability |
| helper/路径失败 | 沿用 invocation owner 的稳定 fail-closed error |
| forged/wrong-owner capability | `gitoxide_repository_admission_capability_invalid` |
| durable state | admission capability 仅在进程内；import 会创建 bare repository、objects 与 baseline ref |
| rollback | observation 无副作用；import 失败留下的 claimed destination 由后续 recovery owner 处理，本层不删除或接管 |

source import 的原子边界是“先完成 source/ref/policy/object graph preflight，再以 `create_dir()` 原子领取
此前不存在的 destination”。destination 一旦存在就拒绝接管；本层不修复、不删除 partial 或 foreign
artifact。每个 commit/tree/blob 都在解析或递归前重新计算 SHA-1 并与 claimed OID 比较，validate 与
copy 共用同一个 bounded verified walker。

## 4. Freshness 与未来 T1

capability 表示一次明确线性化点上的 immutable Git commit/tree snapshot，不承诺 source branch 在随后
保持不变。未来 T1 owner 应把 exact commit/tree 写入 durable admission，并从该 immutable commit
导入 source；不得在 T1 后重新解释“当前 HEAD”，也不得 fallback 到 caller 提供的 OID。

如果产品需要“必须采用用户按下执行按钮那一刻的最新 HEAD”，该策略必须在未来 T1 owner 内重新
观察并比较；不能让本 capability 变成可变 branch lease。

## 5. 当前完成度

到本切片为止，Gitoxide 验证栈已具备：

1. Rust helper 的 isolated SHA-1 observation / SHA-256 rejection；
2. exact helper artifact → opaque invocation capability；
3. bounded short-lived process owner 与 strict response decoder；
4. exact repository observation → opaque admission capability；
5. Linux、macOS、Windows 的真实 helper contract workflow。
6. exact commit/tree/blob checksum verification、atomic destination claim 与 deterministic zero-parent
   baseline publication。

`managedTreePolicyVersion: 3` 是当前唯一的 **portable lexical materialization policy**，而不只是 Git
object import policy。未发布的 policy v1 已删除；helper、Host capability 和 import response 都拒绝把
version 1 重新解释成当前语义。v2 只证明 Git tree 的词法身份和受支持 attributes 满足同一套保守规则，
不宣称已证明某个真实 Windows volume 上的 path-length、8.3 alias、ACL 或大小写能力。

v2 只接受 canonical Git tree ordering 以及 raw mode token `40000`、`100644`、`100755`；mode 的等价
八进制别名和未排序 tree 都在 destination claim 前拒绝。路径统一拒绝 Windows reserved/control
characters、device names（含 extension 与小写 superscript 形式）、trailing dot/space 与 `.git`。
`.gitattributes` 只允许规范小写拼写；大小写、Unicode case-fold 或尾部别名继续拒绝。每个 attributes
blob 最多 64 KiB、必须是 UTF-8；每一原始行必须短于 Git 的 2048-byte 上限，并且只接受以下精确
byte grammar：

```gitattributes
* text=auto eol=lf
/<portable-literal-path> export-ignore
```

空行和以 `#` 开头且不含控制字符的注释允许。规则不接受 attribute 换序、前后空白、额外分隔空格、
CRLF 或 tab；literal path 不接受任何 whitespace/control。外部 `filter`、`working-tree-encoding`、
`ident`、未知 attribute、escaped/wildcard path 及其他未证明语义都在 destination claim 前以
`unsupported_source_attributes` fail closed。collision key 的版本化算法固定为：

```text
Unicode 17.0 NFC → Unicode 16.0 Default Full Case Folding（Non-Turkic）→ Unicode 17.0 NFC
```

原路径和 folded key 各自执行单路径与累计 byte budget。后续 candidate、tree read 必须消费 policy 3；
真实 projection 还必须由独立的 `FilesystemMaterializationProfileV1` 在 fresh destination 上证明
目标 filesystem 的 case/alias/path-length 能力并执行 create/post-observation，不能把本词法检查冒充为
真实文件系统准入。该 projection/candidate owner 还必须实现与 `text=auto eol=lf` 对称的确定性 LF
materialization/canonicalization；本 helper 只验证 immutable tree 并复制 object，不执行 checkout。

仍未完成、也没有伪装完成：

- signed packaged-release trust root 与受保护安装路径；
- Desktop/CLI 消费者；
- T1 durable admission、projection、candidate 与 ref CAS；
- state-root-bound destination capability、partial artifact receipt/quarantine/recovery owner。

因此本层可以作为 Gitoxide backend 的窄基础设施独立合并；正式 release owner、storage-root-bound
destination owner 和 Desktop/CLI 消费者仍是启用产品能力前的硬门槛。
