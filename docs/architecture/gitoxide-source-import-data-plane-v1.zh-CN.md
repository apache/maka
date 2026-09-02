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

状态：堆叠在 repository admission capability 之后、可独立合并的 API-only enabling infrastructure；
没有 Desktop/CLI 产品消费者。

## 1. 主要不变量

本切片只证明：

> source import 只能消费 owner-bound repository admission capability 中冻结的 exact SHA-1 HEAD、
> helper artifact identity 与 managed-tree policy；helper 只把该 commit 的 reachable tree/blob 导入
> 此前不存在的 fresh bare repository，并以确定性零父 baseline commit 发布 `refs/maka/*`。caller 不能
> 重新提交 source path、HEAD、tree identity、helper identity 或 tree policy。

v1 尚未接入 state-root lease，因此不能证明 destination 属于 Maka。正式消费者必须在调用 helper
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

该 claim 只约束 helper 在检查通过的 parent 下原子创建当时不存在的叶子目录。它不抵抗拥有同一 OS
用户权限的进程在随后 rename、junction/reparse replacement 或删除该路径；正式组合仍需稳定的
storage-root owner 与 destination capability，不能把 fresh `create_dir()` 描述成同用户安全边界。

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

当前唯一的 managed tree policy 是 version 2。未发布的 version 1 请求会在 destination 创建前以
`unsupported_managed_tree_policy` 拒绝。import 不复制 source commit/history，不创建 alternates，不执行
hook/filter/submodule/LFS，也不接入 T1/T2。

## 4. 平台与资源边界

- commit object 最多 1 MiB；单个 tree object 最多 8 MiB；全部 reachable tree object 总计最多 64 MiB；
- 单文件最多 64 MiB；总计最多 2 GiB；最多 200,000 个普通文件；
- 只接受 canonical Git tree ordering，以及 raw mode token `40000`、`100644`、`100755`；
- 拒绝 symlink、submodule、`.git`、非 UTF-8，以及
  `Unicode 17.0 NFC → Unicode 16.0 Default Full Case Folding（Non-Turkic）→ Unicode 17.0 NFC`
  collision；原路径与 folded key
  分别有单路径和累计 byte budget；
- `.gitattributes` 必须使用规范小写路径、每个 blob 不超过 64 KiB、每一原始行短于 2048 bytes，并且
  只包含空行/无控制字符注释、精确的 `* text=auto eol=lf` 或
  `/<portable-literal-path> export-ignore`；attribute 换序、前后空白、额外分隔空格、CRLF、tab、filter、
  encoding、ident、未知规则和 escaped/wildcard path 全部在 destination claim 前 fail closed；
- repository inspection deadline 为 5 秒；source import deadline 为 10 分钟。deadline 从 public 入口
  开始覆盖 artifact/path preflight 与 helper 执行；2 GiB/200,000 files 是输入上限，不是十分钟内一定
  成功的 SLA；若 helper 已启动，超时后由共享 child lifecycle 有界终止并 fail closed；若仍在不可取消
  的 Node 文件系统 preflight，调用方按 deadline fail closed，迟到结果不得继续启动 helper 或签发
  capability；
- commit/tree/blob 在完整 decode 前先读取 object header 并执行对应预算；isolated Gitoxide open 另固定
  `gitoxide.objects.allocLimit=64 MiB` 与 1,024 个 object-store slots；source alternates 一律在 open 前
  拒绝，primary `objects/pack` 的类型、名称 byte budget 与最多 1,024 entries 进入同一个 metadata
  preflight，避免 policy counter 生效前递归发现 ODB 或按磁盘状态分配 slots；
- Linux/macOS/Windows 运行同一 locked Cargo suite；当前只证明 fresh-only fail-closed，不承诺 import
  process-crash 自动恢复或断电恢复；
- Windows 保留 Git tree 中的 executable bit，不把它映射成 ACL 权威。

上述规则是 portable lexical materialization policy v3。它不证明 Windows path-length、8.3 alias 或
目标 volume 的大小写行为；这些能力必须由未来 projection owner 的
`FilesystemMaterializationProfileV1` 在 fresh destination 上独立验证。v2 import 只验证 attributes
语义并复制 immutable objects；真正 materialize 和 candidate 写回必须消费同一 policy，并对受支持文本
执行确定性的 LF 规则。

## 5. 后续依赖

下一切片是 Gitoxide candidate/ref CAS。M2.1 与 M2.3 可以并行从最新 main 重建；M2.2/M2.4 必须等
candidate/ref authority 完成后再重建。M1.3 production composition 只能消费本切片签发的 baseline
artifact，不能恢复旧 Git CLI adapter 或 PATH discovery。
