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

# Gitoxide helper artifact authority v1

状态：可独立合并的 enabling infrastructure；尚未形成 product-ready 的 release trust root，也未接入
Desktop/CLI managed-workspace 产品路径。

## 1. 主要不变量

本切片只证明：

> 普通 caller 不能用自报的 executable path 或 SHA-256 获得 Gitoxide helper 调用资格；只有内部
> release owner 签发、与 owner token 绑定的 artifact claim，在 exact platform、architecture、
> protocol、size 与 SHA-256 校验通过后，才能转换为另一个指定 owner 可消费的 opaque invocation
> capability。artifact 在 admission 后变化时，调用前重验必须 fail closed。

它不证明平台签名、安装目录保护、helper spawn、repository observation、T1 admission、managed
workspace 或 crash recovery。

## 2. Owner 与 API 权限

```text
未来的 packaged-release owner
  └─ issueGitoxideHelperReleaseArtifactClaimInternal(ownerToken, exact artifact identity)
       ↓ opaque release claim
artifact authority
  └─ exact file/platform/protocol verification
       ↓ opaque invocation capability
未来的 invocation owner
  └─ verifyGitoxideHelperArtifactForInvocationInternal(ownerToken, capability)
```

- claim 与 capability 的状态存放在模块私有 `WeakMap` 中；对象表面不包含 path、digest 或 size。
- claim 必须由相同的 release owner token 消费；capability 必须由签发时指定的 invocation owner token
  消费。
- 相关 internal API 不从 `@maka/runtime-host/server` 导出。
- 旧的 caller-provided `{ executablePath, expectedSha256 }` 不能成为这条链的 authority。

当前没有 production release owner。`issueGitoxideHelperReleaseArtifactClaimInternal()` 只是未来受信
packaging owner 的接缝，不是签名信任根；这限制产品启用条件，但不阻止该窄 authority 作为后续切片的
可审查基础设施合并。

## 3. 校验边界

一次 artifact 校验包含：

1. 输入 claim 的 protocol/platform/architecture/size/digest 形状检查；
2. 拒绝 claimed path 任意组件中的 symlink 或 Windows junction；
3. 打开 canonical regular file，并限制 helper artifact 最大为 256 MiB；
4. 在同一 handle 上进行 64 KiB 有界缓冲的 SHA-256 流式读取；
5. 比较读取前后 handle identity/size/timestamps；
6. 比较读取后 path identity 与已打开 handle；
7. 比较 exact byte count 与 digest。

admission 与每次 invocation resolve 都执行这套校验。它可以识别校验之前或校验期间的替换，不会把
相邻 manifest 当作自证信任根；但校验完成后必须关闭 handle，而 Node 只能按 path spawn，所以这里不把
“刚验证的 bytes”表述成“实际执行的 bytes”。

## 4. 原子性、失败状态与回滚

| 项目 | v1 合同 |
| --- | --- |
| owner | Runtime Host 内部 artifact authority |
| 原子性边界 | 单个打开 file handle 的一次 identity + streaming digest observation |
| durable state | 无；claim/capability 仅存在于进程内 |
| 非法/伪造 claim | `gitoxide_helper_release_claim_invalid` |
| 平台或架构不匹配 | `gitoxide_helper_release_claim_unsupported` |
| path/symlink/读取失败 | `gitoxide_helper_artifact_invalid` |
| size/digest/identity 漂移 | `gitoxide_helper_artifact_identity_mismatch` |
| 错误 owner/伪造 capability | `gitoxide_helper_invocation_capability_invalid` |
| rollback | 只读校验，无副作用，无需回滚 |

## 5. 明确不承诺的威胁模型

本切片没有声称抵抗拥有同一 OS 用户文件写权限的主动攻击者。特别是：

- 它尚未验证 macOS code signature、Windows Authenticode 或 Linux 发布清单的受信签名；
- 它尚未把 helper 放进由正式安装器保护的只读目录；
- invocation 已接入 path-based spawn，但不能消除“最后一次 handle 校验完成后、exec 开始前”的替换
  窗口；重复 rehash 只能缩小窗口，不能形成 executable CAS，因此 v1 明确保留该限制。

正式生产接入前，必须由 packaged-release owner 提供信任根，并明确三平台安装目录与签名能力。不能
通过给本 API 再传一个裸 expected digest 来绕过这一门槛。

## 6. 平台能力矩阵

| 平台 | 当前持续验证 | 尚未承诺 |
| --- | --- | --- |
| Linux | regular-file identity、digest、symlink path rejection | package signature、protected install root、spawn identity |
| macOS | 同 Linux | code-sign verification、notarized artifact binding、spawn identity |
| Windows | regular-file identity、digest、junction path rejection | Authenticode binding、ACL-protected install root、spawn identity |

## 7. 后续切片

后续只能按下面顺序推进：

1. 发布/安装 owner 把受信 helper identity 绑定到 signed product artifact；
2. 短生命周期 invocation owner 消费 opaque capability 并运行 strict helper protocol；合同见
   `gitoxide-helper-invocation-owner-v1.zh-CN.md`；
3. repository observation 再转换为 T1 前的 opaque admission capability。

在第 1 项完成以前，不接 Desktop/CLI，也不恢复旧 Git CLI adapter。
