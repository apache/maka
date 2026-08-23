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

> source import 只能消费 owner-bound repository admission capability 中冻结的 exact SHA-1 HEAD；helper
> 只把该 commit 的 reachable tree/blob 导入此前不存在的 Maka-owned bare repository，并以确定性零父
> baseline commit 发布 `refs/maka/*`。caller 不能重新提交 source path、HEAD 或 tree identity。

## 2. Owner 与原子性边界

- repository admission authority 拥有 source path、commit 与 tree identity；
- invocation owner 在每次调用前重新验证 helper artifact；
- short-lived helper 拥有 object copy 与 baseline ref publication；
- fresh destination 整体是 artifact 边界，不尝试跨 source/destination/SQLite 伪造事务。

线性化点是 fresh destination 内 `refs/maka/*` 从不存在到 baseline commit 的 ref publication。ref 发布前
的 objects 不具有 canonical 意义；完整 response 返回前，destination 不能被上层接受。

## 3. 失败与回滚

| 状态 | 处理 |
| --- | --- |
| source HEAD 与 admission 不一致 | 创建 destination 前失败 |
| destination 已存在、是文件或 symlink | 拒绝接管，不修改原内容 |
| path/type/quota/object copy 失败 | destination 是 untrusted partial artifact，整体删除 |
| helper 进程中断或响应丢失 | 不推断成功；整体删除 fresh destination 后用新路径重试 |
| SHA-256/未知 object format | policy reject；不 fallback 到系统 Git |

v1 不复制 source commit/history，不创建 alternates，不执行 hook/filter/submodule/LFS，也不接入 T1/T2。

## 4. 平台与资源边界

- 单文件最多 64 MiB；总计最多 2 GiB；最多 200,000 个普通文件；
- 只接受 tree、`100644` blob 与 `100755` executable blob；
- 拒绝 symlink、submodule、`.git`、`.gitattributes`、非 UTF-8 与 NFC/大小写 collision；
- Linux/macOS/Windows 运行同一 locked Cargo suite；只承诺 process-crash discard/retry，不承诺断电；
- Windows 保留 Git tree 中的 executable bit，不把它映射成 ACL 权威。

## 5. 后续依赖

下一切片是 Gitoxide candidate/ref CAS。M2.1 与 M2.3 可以并行从最新 main 重建；M2.2/M2.4 必须等
candidate/ref authority 完成后再重建。M1.3 production composition 只能消费本切片签发的 baseline
artifact，不能恢复旧 Git CLI adapter 或 PATH discovery。
