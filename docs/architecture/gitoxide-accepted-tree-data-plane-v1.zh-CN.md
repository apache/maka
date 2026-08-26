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

# Gitoxide accepted tree data plane v1

状态：建立在 Gitoxide repository admission/source import 之上的 enabling infrastructure。

## 1. 主要不变量

本切片只证明：

> successor ref、fresh filesystem projection 和 bounded direct read 都只能消费同一个
> owner-bound managed-repository capability，并从其中冻结的 exact accepted SHA-1 commit/tree 与
> managed-tree policy v2 派生。调用者不能重新提交 helper、repository path、accepted commit/tree 或
> policy。

SQLite accepted head 仍由后续 mutation authority 拥有；本切片发布的是 immutable Git candidate/ref
和可丢弃投影，不把 Git ref 或 filesystem projection 提升为第二事实源。

## 2. Owner、原子边界与能力

- import authority 在导入成功时捕获 helper capability、managed repository path、accepted ref、commit、
  tree 与 policy v2，并签发 opaque managed-repository capability；
- successor helper 从 capability 中的 exact base 创建 deterministic commit，并以 Git ref
  `MustExistAndMatch(base)` 完成 CAS；响应丢失后的相同请求只接受同一 deterministic successor；
- projection helper 只向 fresh destination 物化 accepted tree；已存在目录仅在逐文件、类型、mode、
  内容和额外路径检查全部一致时视为 exact retry；
- direct read 沿 accepted tree 的 exact path 加载并重验 tree/blob object identity，只返回最多 8 MiB 的
  UTF-8 内容；它不读取 projection filesystem；
- 每个公开入口都复用 admission 时捕获的 helper capability，并在短生命周期 helper 启动前重新验证
  artifact identity。

## 3. 失败与回滚

| 状态 | 处理 |
| --- | --- |
| target ref 不再等于 capability base | 返回 `base_commit_mismatch`，不移动 ref |
| successor 违反 policy v2 | ref CAS 前 fail closed |
| projection destination 已存在但不完全一致 | `projection_destination_not_fresh`，不覆盖、不删除 |
| projection 后续出现内容、类型、mode 或额外路径漂移 | 返回 `projection_drifted`，accepted Git tree 不变 |
| direct read 路径、类型、大小、UTF-8 或 object identity 不合法 | fail closed，不读取 filesystem projection |
| helper 超时、中断或输出不匹配 | 不签发新 capability；由调用者重试 exact operation 或 park |

successor 的线性化点是 accepted ref CAS。projection 没有 canonical 线性化点，只是 accepted tree 的
可重建派生物。direct read 是 observation，不发布持久事实。

## 4. 平台与资源边界

- Linux/macOS/Windows 使用同一 Gitoxide protocol；projection observation 使用 no-follow open，并在
  Windows 拒绝 reparse-point root/children；
- policy v2 的 path、Unicode fold、tree/blob、`.gitattributes` 和 object identity 规则与 source import
  完全相同；
- successor、projection 的绝对 deadline 为 10 分钟；direct read 同样受该上界约束；
- projection 会同步普通文件与目录（Windows v1 不声明目录 fsync/power-loss durability）；当前只承诺
  进程内成功返回后的 exact observation，不承诺 partial materialization 自动清理；
- direct read 单文件最多 8 MiB，helper stdout 以 JSON worst-case escaping 设置固定上限。

## 5. 后续依赖

后续 mutation lifecycle 可以把 managed-repository capability 与 SQLite T1 reservation 绑定，并在
successor 验证后原子接受 workspace head。Desktop/CLI 消费者不得绕过该 capability 直接传 repository
path、helper path 或 accepted commit。
