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

状态：Gitoxide 验证栈的最后一个 API-only Draft；尚未接 T1、source import 或 managed workspace。

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
       ↓ only the designated admission owner may resolve
immutable admission state
```

认证元数据与可返回 observation state 分开存储；解析 capability 不会泄漏 owner token。相关 API 不从
`@maka/runtime-host/server` 导出。

## 3. 原子性、失败状态与回滚

| 项目 | v1 合同 |
| --- | --- |
| observation owner | short-lived invocation owner |
| capability owner | repository admission authority |
| 原子性边界 | 一次 canonical path observation + 一次 exact helper response + 进程内 capability 签发 |
| accepted | SHA-1 exact commit/tree，签发 opaque capability |
| policy rejected | SHA-256/未知 format，返回 rejection，不签发 capability |
| helper/路径失败 | 沿用 invocation owner 的稳定 fail-closed error |
| forged/wrong-owner capability | `gitoxide_repository_admission_capability_invalid` |
| durable state | 无；该 capability 必须在 T1 前消费 |
| rollback | 只读 observation，无副作用 |

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

仍未完成、也没有伪装完成：

- signed packaged-release trust root 与受保护安装路径；
- Desktop/CLI 消费者；
- T1 durable admission、source import、projection、candidate 与 ref CAS。

因此这些 PR 可以作为 Gitoxide backend 的验证栈审查，但在正式 release owner 和生产消费者接入前
继续保持 Draft。
