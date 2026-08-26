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

## 1. 主要不变量

本切片只证明：

> owner-bound accepted-repository capability 只能读取被冻结的 exact accepted SHA-1 commit/tree，或
> 从该 exact base 生成 operation-bound immutable candidate proof。candidate 不能推进 accepted ref，
> 也不能签发新的 accepted capability。

SQLite accepted head 仍由后续 mutation authority 拥有。本切片不提供 filesystem projection；projection
必须由 storage-root owner 在后续 PR 中以独立 destination capability 和 crash protocol 实现。

## 2. Owner、原子边界与能力

- import authority 在任何 destination side effect 前验证 helper 的 operation feature attestation；导入成功
  后捕获 helper capability、managed repository path、accepted ref、commit、tree 与 policy v3，并签发
  opaque accepted-repository capability；
- candidate helper 同时绑定 exact base commit/tree、accepted ref、operation-specific candidate ref、path
  与 result bytes；它在任何 object write 前验证 base tree 与 accepted ref，随后只 CAS 新 candidate ref；
- candidate publication 返回 opaque candidate capability/proof，不返回 accepted capability；相同
  operation/content 是 exact retry，no-change 返回 typed proof 且不创建 commit/ref；
- direct read 沿 accepted tree 的 exact path 加载并重验 tree/blob object identity，只返回最多 8 MiB 的
  UTF-8 内容；它不读取 projection filesystem；
- 每个公开入口都复用 admission 时捕获的 helper capability，并在短生命周期 helper 启动前重新验证
  artifact identity。

## 3. 失败与回滚

| 状态 | 处理 |
| --- | --- |
| accepted ref 不再等于 capability base | 写 object 前返回 `base_commit_mismatch`，candidate ref 不存在 |
| base commit/tree identity 不一致 | 写 object 前 fail closed |
| candidate 违反 policy v3 | candidate ref CAS 前 fail closed |
| candidate ref 已存在且不等于 deterministic candidate | fail closed，不覆盖已有 candidate |
| result 与 base tree 相同 | 返回 `candidate_no_change`，不写 commit/ref |
| direct read 路径、类型、大小、UTF-8 或 object identity 不合法 | fail closed，不读取 filesystem |
| helper 超时、中断或输出不匹配 | 不签发新 capability；由调用者重试 exact operation 或 park |

candidate publication 的线性化点是 operation-specific candidate ref 的 `MustNotExist` CAS。accepted ref
在本切片中只读。direct read 是 observation，不发布持久事实。

## 4. 平台与资源边界

- Linux/macOS/Windows 使用同一 Gitoxide protocol；本切片不写工作区 filesystem；
- policy v3 的 path、Unicode fold、tree/blob、`.gitattributes` 和 object identity 规则与 source import
  完全相同，并额外拒绝 Git HFS 语义下的 `.git`/`.gitattributes` aliases；
- candidate 和 direct read 的绝对 deadline 为 10 分钟；
- candidate content 通过 bounded Base64 field 传输，64 MiB 业务上限与 JSON escaping 无关；
- direct read 单文件最多 8 MiB，helper stdout 以 JSON worst-case escaping 设置固定上限。

## 5. 后续依赖

后续 mutation lifecycle 把 accepted capability 与 SQLite T1 reservation 绑定；SQLite 原子接受 candidate
后，单独的 promotion/reconcile owner 才能更新 accepted-ref projection 并签发新 accepted capability。
Desktop/CLI 消费者不得绕过 capability 直接传 repository path、helper path 或 accepted commit。
