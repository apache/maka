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

# Gitoxide source import data plane v1

状态：堆叠在 repository admission capability 之后的 API-only Draft；没有 Desktop/CLI 消费者。

## 1. 主要不变量

本切片只证明：

> source import 只能消费 owner-bound repository admission capability 中冻结的 exact SHA-1 HEAD、
> helper artifact identity 与 managed-tree policy；helper 只把该 commit 的 reachable tree/blob 导入
> 此前不存在的 fresh bare repository，并以确定性零父 baseline commit 发布 `refs/maka/*`。caller 不能
> 重新提交 source path、HEAD、tree identity、helper identity 或 tree policy。

本 Draft 尚未接入 state-root lease，因此不能证明 destination 属于 Maka。正式消费者必须在调用 helper
以前由 Storage owner 签发 destination capability；在此之前，API 只接受 fresh path，并拒绝接管或修复
任何已有 repository。

## 2. Owner 与原子性边界

- repository admission authority 拥有 source path、commit 与 tree identity；
- invocation owner 在每次调用前重新验证 helper artifact；
- short-lived helper 先用原子 `create_dir` 独占领取 fresh destination，再拥有 object copy 与 baseline ref
  publication；任何已存在的叶子路径（包括空目录）都稳定拒绝；
- fresh destination 整体是 artifact 边界，不尝试跨 source/destination/SQLite 伪造事务；
- helper 不拥有 destination recovery/cleanup 权限。失败后的 partial artifact 只能由未来持有 storage-root
  identity 与 durable receipt 的 owner 处理。

fresh ownership 的线性化点是原子叶子目录创建；import 成功的线性化点是该独占 destination 内
`refs/maka/*` 以 `MustNotExist` 从不存在发布到 baseline commit。ref 发布前的 objects 不具有 canonical
意义；完整 response 返回前，destination 不能被上层接受。已存在 ref 没有“内容相同即成功”的旁路。

## 3. 失败与回滚

| 状态 | 处理 |
| --- | --- |
| source HEAD 与 admission 不一致 | 创建 destination 前失败 |
| baseline ref 不满足 Gitoxide authoritative ref grammar | `invalid_baseline_ref`，创建 destination 前失败 |
| destination 已存在（包括 source 自身、foreign bare repo、partial import） | `import_destination_not_fresh`，不读取、修复或删除原内容 |
| destination parent 含 symlink/junction/reparse alias | `import_destination_parent_untrusted`，创建前拒绝 |
| path/type/quota/object copy 失败 | destination 可能是 untrusted partial artifact；helper 不自动清理或重试 |
| helper 进程中断或响应丢失 | 不推断成功；未来 storage owner 必须先验证/隔离 partial artifact，再签发新的 fresh destination |
| SHA-256/未知 object format | policy reject；不 fallback 到系统 Git |

v1 不复制 source commit/history，不创建 alternates，不执行 hook/filter/submodule/LFS，也不接入 T1/T2。

## 4. 平台与资源边界

- commit object 最多 1 MiB；单个 tree object 最多 8 MiB；全部 reachable tree object 总计最多 64 MiB；
- 单文件最多 64 MiB；总计最多 2 GiB；最多 200,000 个普通文件；
- 只接受 tree、`100644` blob 与 `100755` executable blob；
- 拒绝 symlink、submodule、`.git`、`.gitattributes`、非 UTF-8 与 NFC/大小写 collision；
- repository inspection deadline 为 5 秒；source import deadline 为 10 分钟。2 GiB/200,000 files 是输入
  上限，不是十分钟内一定成功的 SLA；超时后 fail closed；
- commit/tree/blob 在完整 decode 前先读取 object header 并执行对应预算；isolated Gitoxide open 另固定
  `gitoxide.objects.allocLimit=64 MiB`，避免 policy counter 生效前发生无界单次 object allocation；
- Linux/macOS/Windows 运行同一 locked Cargo suite；当前只证明 fresh-only fail-closed，不承诺 import
  process-crash 自动恢复或断电恢复；
- Windows 保留 Git tree 中的 executable bit，不把它映射成 ACL 权威。

## 5. 后续依赖

下一切片是 Gitoxide candidate/ref CAS。M2.1 与 M2.3 可以并行从最新 main 重建；M2.2/M2.4 必须等
candidate/ref authority 完成后再重建。M1.3 production composition 只能消费本切片签发的 baseline
artifact，不能恢复旧 Git CLI adapter 或 PATH discovery。
