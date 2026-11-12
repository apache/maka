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

# maka-fs-tools

[English](README.md)

实现文件读取、搜索、编辑、写入、补丁和 worktree 操作。调用方提供已授权的文件系统作用域。`ReadExecutor` 处理分页读取，`MutationExecutor` 与 `WriteCoordinator` 准备并串行化写入。补丁解析委托相邻的 `patch` crate。

写入、编辑与补丁通过原始授权文件句柄准备完整 UTF-8 内容，保留已有 inode 和模式，在写入前重新验证目标身份，并在取消与结算期间等待原始 worker 完成。Edit 要求唯一匹配；补丁操作保留源顺序和换行符规则。准备阶段在内存中保留完整字符串，写入不是原子替换。

文本读取每页通过原始已授权文件描述符扫描一次，仅保留有界的页面候选内容。序列化响应预算不限制文本总大小。每页都会验证完整源文件的 UTF-8（拒绝 NUL）、统计所有行，并将续页地址绑定到内容摘要；后续页仍须重新扫描完整文件。读取在块之间检查取消，调用方等待工作线程结束。这不保证并发修改文件的原子快照。图像读取保留完整的 PNG/JPEG/GIF/WebP 原始字节，验证图像头和非零尺寸，并在块之间检查取消。读取不会缩放或重新编码图像。

`workspace` 通过原始已捕获目录准备内在身份。存在可用 Git 仓库时，仅在缺少规则时向共用的 `info/exclude` 追加 `.maka-workspace.json`，保留已有字节。该固定初始化操作覆盖选中的子目录和 linked worktree，并要求真实私有 Root/control 边界及受检验的托管 worktree binding。最近的 `.git` 入口不可用时不会转而修改祖先仓库；向有效排除文件写入失败仍会报错。已跟踪文件和用户忽略规则保留 Git 原有的优先级。

`git` 提供原生的只读仓库状态和单文件比较。调用方传入原目录身份、私有 State Root 及经过验证的受管 worktree 绑定，并持有阻塞 worker 直到工作结束。库遍历前先检查 Git 元数据及 ignore/attributes 控制文件，不执行外部命令或使用替代对象库。状态条目和文本补丁完整返回。仓库元数据、控制文件和比较结果在内存中缓冲。取消采用协作方式；查询不承诺有界内存、固定执行时限或原子仓库快照。

`worktree` 管理隔离的 Git 检出，并相对分配时的不可变基准捕获最终工作文件。调用方必须先结清所有工作区写者。捕获读取完整内容和路径集合，在内存中缓冲完整补丁，并在返回前验证 HEAD/index 未变及完整归属记录。取消采用协作方式；捕获不承诺有界内存，也不是外部并发编辑的原子快照。重新打开保留子任务的修改；移除必须持有原始归属证明。

`files` 通过持有的目录能力列出直接子项，并提供原生变更失效提示。调用方传入原工作区身份、私有 Root/control 路径及经过验证的受管 worktree 绑定；调用方路径不能自行创建这个例外。与 Git 共用的 `WorkspacePath` 保留准确的相对路径字节。列表采用有界实时分页，不保存快照缓存。监听在就绪前注册工作区到目标目录的祖先链，忽略读取/access 通知、合并变更，并在交付前重新校验目录名称。即使客户端取消，原 worker 也必须等待 `Watch::close` 完成正常的原生监听及回调清理。原生文件系统通知不是持久事件历史。

Grep 和 Glob 返回授权搜索范围内的完整匹配集合，保留完整源数据和结果，并通过迭代遍历及活动循环检测检查调用方取消；不再设置独立的源大小、结果数量、遍历层数或整次搜索期限。隐藏、忽略、二进制及符号链接仍遵循各工具声明的范围。正则编译保留所固定依赖的嵌套与编译内存保护，不承诺接受所有数学上有效的正则表达式。当前文件捕获和可读取的写入前内容保留完整原文。文件列表使用可继续的分页及软字节目标，完整首项始终可以推进。Git 仍受依赖表示范围及降低信任时的分配策略约束；路径长度不会授予仓库权限。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
