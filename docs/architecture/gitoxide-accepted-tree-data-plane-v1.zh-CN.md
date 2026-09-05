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

# Gitoxide candidate and accepted-tree read data plane v1

状态：建立在 Gitoxide repository admission/source import 之上的 enabling infrastructure。

最小因果主线是：

```text
accepted A
  -> 基于 A 生成 immutable staged candidate B
  -> 用 operation-specific ref + MustNotExist CAS 发布 B
  -> 后续 SQLite acceptance owner 决定是否 promote A -> B
```

本切片只拥有 stage，不拥有 promote；任何 candidate 路径都不得推进 `refs/maka/accepted` 或签发新的
accepted capability。

## 1. 主要不变量

本切片只证明：

> owner-bound accepted-repository capability 只能读取被冻结的 exact accepted SHA-1 commit/tree，或
> 从该 exact base 生成 operation-bound immutable candidate proof。candidate 不能推进 accepted ref，
> 也不能签发新的 accepted capability。

SQLite accepted head 仍由后续 mutation authority 拥有。本切片不提供 filesystem projection；projection
必须由 storage-root owner 在后续 PR 中以独立 destination capability 和 crash protocol 实现。

## 2. Owner、原子边界与能力

- import authority 在任何 destination side effect 前验证 helper 的 operation feature attestation；导入成功
  后只在固定 `refs/maka/accepted` namespace 捕获 helper capability、managed repository path、accepted
  commit、tree 与 policy v3，并签发
  opaque accepted-repository capability；
- candidate helper 同时绑定 exact base commit/tree、accepted ref、operation-specific candidate ref、path
  与 result bytes；完整 verified walk 后，tree editor 仍只通过 checksum-verifying finder 加载 owned tree，
  禁止重新信任未验证 ODB bytes；
- published 与 no-change 都创建包含 request digest 的 deterministic candidate receipt commit，并以同一个
  operation-specific ref 作为线性化点；两种成功都返回 owner-bound candidate-outcome capability；
- accepted ref 与 candidate ref 都必须是直接指向 exact commit object 的 direct ref；symbolic ref 与
  annotated tag 不得通过 peel 后的语义相等冒充 receipt identity；
- candidate outcome 私下绑定 exact accepted capability identity、repository/ref、helper artifact、policy、
  request digest、result SHA-256 与 Git identities；验证时必须同时出示原 accepted capability；
- direct read 沿 accepted tree 的 exact path 加载并重验 tree/blob object identity，只返回最多 8 MiB 的
  UTF-8 内容；它不读取 projection filesystem；
- 每个公开入口都复用 admission 时捕获的 helper capability，并在短生命周期 helper 启动前重新验证
  artifact identity，同时要求 release claim 明确 attest 本次实际调用的 operation；
- candidate fresh self-check 与 exact retry 都必须实际加载 result blob，在 64 MiB 上限内验证 kind 与
  checksum，不能只相信 candidate tree 中记录的 OID edge；
- exact retry 从 verified base tree、继承的目标 mode、canonical path 与 result blob 纯计算唯一 expected
  candidate tree OID，不写入新 object；receipt tree 必须与它完全相等。由此目标之外的额外变化、目标 mode
  flip 和伪造 no-change receipt 都无法获得 outcome capability。

## 3. 失败与回滚

| 状态 | 处理 |
| --- | --- |
| accepted ref 在初次检查时不等于 capability base | 写 object 前返回 `base_commit_mismatch`，candidate ref 不存在 |
| accepted/candidate ref 是 symbolic ref 或指向 tag/非 commit object | 稳定返回 direct-ref/target-invalid 错误 |
| base commit/tree identity 不一致 | 写 object 前 fail closed |
| candidate 违反 policy v3 | candidate ref CAS 前 fail closed |
| candidate ref 已存在且 request digest 不同 | 写 object 前返回 `candidate_request_conflict`，不覆盖已有 candidate |
| existing receipt 的 tree 不是 exact base 单路径转换结果 | 返回 `candidate_ref_target_invalid`，不签发 capability |
| result 与 base tree 相同 | 写入 same-tree receipt commit 并 CAS operation ref，返回 `candidate_no_change` outcome capability |
| 同一 operation 后续给出不同 path/content/disposition | deterministic commit 不同，稳定 conflict |
| direct read 路径、类型、大小、UTF-8 或 object identity 不合法 | fail closed，不读取 filesystem |
| helper 超时、中断或输出不匹配 | 不签发新 capability；由调用者重试 exact operation 或 park |

candidate outcome 的线性化点是 operation-specific direct candidate ref 的 `MustNotExist` CAS。任何 object
write 前先检查既有 direct receipt：request digest 相同则从 verified base 纯计算 expected successor tree，
要求 receipt tree 与之精确一致，再重验 result blob 后 exact retry；request 不同则稳定 conflict。CAS 竞争失败
后再次重读 direct ref：相同 deterministic commit 视为 exact retry，不同 commit 视为 conflict；无法证明
publication 状态时返回 `candidate_publication_indeterminate`。

accepted ref 在本切片中只读，并与 `refs/maka/candidates/<operation-hash>` namespace 不重叠。第二次 accepted
ref 检查与 candidate CAS 不是一个跨 ref transaction：二者之间的 accepted drift 可能留下绑定旧 base 的
stale candidate evidence，但不能推进 accepted truth。后续 SQLite acceptance 必须重新验证 canonical head 并
拒绝 stale candidate。direct read 是 observation，不发布持久事实。

## 4. 平台与资源边界

- Linux/macOS/Windows 使用同一 Gitoxide protocol；本切片不写工作区 filesystem；
- policy v3 的 path、Unicode fold、tree/blob、`.gitattributes` 和 object identity 规则只由 Rust helper
  判定；TypeScript 只负责 transport byte bound，避免复制一份会漂移的 path policy；
- candidate 和 direct read 的绝对 deadline 为 10 分钟；
- candidate content 通过 bounded Base64 field 传输，64 MiB 业务上限与 JSON escaping 无关；
- direct read 单文件最多 8 MiB，helper stdout 以 JSON worst-case escaping 设置固定上限。

## 5. 后续依赖

后续 mutation lifecycle 把 accepted capability 与 SQLite T1 reservation 绑定；SQLite 原子接受 candidate
后，单独的 promotion/reconcile owner 才能更新 accepted-ref projection 并签发新 accepted capability。
Desktop/CLI 消费者不得绕过 capability 直接传 repository path、helper path 或 accepted commit。

当前 accepted/candidate capability 是进程内 opaque authority。Git candidate ref/receipt commit 跨进程耐久，
但 Host crash 后重新签发 capability 需要后续 durable workspace receipt owner：它必须重开 exact repository、
持有 storage-root lease，重验 direct accepted/candidate ref、receipt commit checksum、request digest、base
parent、candidate tree 与 path/result blob，再允许 SQLite 接受。本切片的 exact retry 承诺覆盖同一进程及
helper process response loss；不把尚未接线的 cross-Host reopen 或 candidate GC 宣称为已完成能力。
