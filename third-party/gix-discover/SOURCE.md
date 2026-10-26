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

# Preserve repository discovery I/O failures

Sources and licenses are copied from the published `gix-discover` 0.57.1 crate. `upstream.json` records the registry checksum, source revision and original file hashes. Registry installation metadata and the upstream lockfile are omitted.

Repository layout checks in `src/is.rs` preserve metadata and linked-worktree path read errors instead of treating them as missing layout entries. Missing HEAD, objects or refs still mean an invalid repository. Maka uses Gix’s classified errors and their original I/O causes; it no longer probes sentinels by matching removed error variants. The existing workspace identity permission fixtures cover HEAD, objects, refs and linked metadata.

The existing path-file size check in `src/path.rs` reports `InvalidData` instead of `Other`, so malformed metadata remains distinguishable from real filesystem failures without parsing error messages.

仓库布局检查保留 metadata 与 linked-worktree 路径文件的真实 I/O 错误，不再把权限错误当作布局缺失。HEAD、objects、refs 正常缺失仍表示无效仓库。Maka 使用 Gix 的错误分类与原始 I/O 原因，移除依赖已删除错误枚举的额外探测；沿用工作区身份与权限回归测试。

`src/path.rs` 原有路径文件大小检查改为返回 `InvalidData`，无需解析错误文本即可区分损坏的元数据与真实文件系统故障。
