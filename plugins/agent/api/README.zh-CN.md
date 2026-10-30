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

# maka-agent-api

[English](README.md)

包含 Agent、Session、Executor、WorkHub 的协议声明以及 Agent 配置 schema。原生服务与 SDK 生成共用这些定义。调用方只需要公开契约时，可以依赖这里，无需引入 Agent 执行引擎。

独立 Desktop 通过同一个 Root 绑定的[公共 Host client](../../../platform/host-runtime/src/application/host/client.rs)使用持久 Agent 服务，不直接打开 Agent 存储，也不嵌入执行引擎。字段及 schema 以 [Agent 契约](src/contract.rs)和[交互契约](src/contract/interaction.rs)为准。

`history` 分页保持同一个 `through` 边界，`watch` 从最后的 `nextAfter` 继续，并发布队列与待处理交互更新。`send` 接受工作并返回其身份，`stop` 指定该次 invocation。重连后通过 `pendingInteractions`、`interaction` 和 `respond` 重建并回答原请求。修改保留原操作回执；丢失响应不代表可以重新发送。参见[原生接入验收](../native/README.zh-CN.md)及[传输所有权与退出方式](../../../platform/transport/README.zh-CN.md)。

`resumable` 使用选定的续跑模型检查最新执行，返回精确来源回执或不可继续的原因；复用 resume 准备逻辑与 engine 重放检查，不准入新工作。调用 `resume` 时提交该来源边界并保持操作身份稳定；准入时重新检查当前安全条件与权限，创建新 turn，丢失响应后恢复同一回执。可继续的查询结果不预留来源。

历史行引用使用 `position: { sourceSequence, itemIndex }`，先按产生该行的原始事件排序，再按该事件内的行序号排序。游标、来源读取、提示词锚点及工具图片引用共用这一位置。`through` 和 `{ kind: "event", sequence }` 仍指向原始事件；模型完成时产生的所有历史行都归属于该完成事件。

`search` 在所选 Session 的历史中按字面量查询，显式传入 `caseSensitive` 和 `wholeWord`。忽略大小写使用 Unicode 简单大小写折叠，不做规范化；全字匹配要求两侧不紧邻 Unicode 单词字符（字母、组合标记、十进制数字、连接标点或连接控制符）。以 `after: null` 开始，分页时保持查询、选项和 `through` 不变，沿 `nextAfter` 继续，即使当前页没有命中；null 表示扫描结束。每条命中标明原始字段，可通过 `source` 精确读取。搜索命中以 `position` 和原始 `field` 定位。用相同 `through` 调用 `history`，位置为 `{ kind: "row", position: hit.position, field: hit.field === "thinking" ? "thinking" : "body" }`，可打开空工具行及明确指定的内部工具；后续隐藏规则不变。已有字节游标仍用于续页。

Executor 的 `execute` 通过名为 `attachments` 的单个可选二进制资源接收不可变文件。资源 metadata 是按顺序排列的 `{ name, mimeType, bytes, digest }` 数组；资源内容按同一顺序连接各文件的原始字节，偏移由前项长度累加得到。必须通过实际请求资源读取，Host 字节预算和清理责任仍归原请求所有；metadata 本身不授予访问权限。

`fork` 根据来源版本，从完整一轮或全部当前历史创建旁支会话。所包含的工作必须已结算；后续轮次仍在运行时，也可分叉更早的完整轮次。新 Session 保留这段历史和附件，共享已验证的工作区，收窄权限且不带入运行中的工作；`branch` 标明来源。丢失响应后使用原操作引用恢复；Host 结果仍未知时，`forkReceipt` 可查找已发布的分叉。返回 null 不代表操作未发生，也不授权创建替代分叉。字段见[分叉声明](src/contract/fork.rs)。

`diagnostics` 在固定的 `through` 边界内，从新到旧分页读取执行、模型步骤及自动标题失败。`watchDiagnostics` 在订阅时及变化后发送当前诊断版本；重连后重新读取最新页。这些会话范围内的运行记录保留原 invocation/event 标识和安全的类型化原因，不包含提供方响应正文或复制来源会话的失败。诊断版本独立于对话历史，因此回答结束后才发生的标题失败仍可发现。

`context` 返回所选 Session 最近一次已准备的 Main 请求，包括运行中或已中断的请求。它按消息角色和工具定义展示原始 Host 输入构成；token 数为估算，提供方报告的实际输入用量单独返回。固定 `through` 可在重连后读取同一结果。不存在的请求或缺失的测量保持 null，复制的历史不算新 Session 自己执行的请求。字段见[上下文声明](src/contract/context.rs)。

UI 插件绑定 `agent` 导入后，通过 `context.services.agent[0].query('compactionPrompt', { sessionId })` 读取：结果包含 `revision`、可为 null 的原始 `prompt`、完整生效正文 `compactionPrompt` 及继承正文 `defaultCompactionPrompt`。只有 null 继承全局设置（或对应语言的内置提示词），空字符串及纯空白均是有效覆盖值。保存时用该版本调用 `setCompactionPrompt`，并处理 `MetadataResult` 的 `revision_conflict` 等结果。设置影响新工作，已捕获的执行及队列提示词保持不变；`compact.prompt` 仍只覆盖当次压缩。以下示例恢复继承，其中 `current` 是已校验的查询结果，`ServiceMethods` 从 `@maka-agent/plugin-sdk` 导入。字段见[压缩声明](src/contract_compaction.rs)。

```ts
const input = {
  sessionId,
  expectedRevision: current.revision,
  prompt: null,
} satisfies ServiceMethods['agent']['setCompactionPrompt']['input'];
const operation = await context.services.agent[0].mutation('setCompactionPrompt', input);
```

`gitStatus` 和 `gitDiff` 通过同一个 Agent 服务读取所选 Session 的仓库，也适用于 WorkHub 协调者会话。状态区分已暂存、工作区和未跟踪的变化；同一路径可以同时出现在已暂存和工作区部分。diff 分别比较 HEAD 与索引、索引与工作文件，或空文件与未跟踪文件。尚无提交的仓库返回 null `head`；没有仓库的工作区返回 null。路径以 `bytesBase64` 保留 Git 文件名的原始字节，重命名呈现为删除加新增。

这些查询提供当前的只读观察，不是仓库快照。状态完整返回已暂存、工作区和未跟踪的条目列表。单文件 diff 读取完整输入，区分文本、二进制、未变化和不支持的情况；文本补丁完整返回。仓库元数据、control 文件、状态条目、diff 输入和补丁在内存中缓冲。取消采用协作方式；这些查询不承诺有界内存或固定执行时限。所选工作区必须是仓库根目录；外部过滤器、稀疏检出、子模块等不支持的仓库特性会明确失败，不执行配置中的命令。工作区或比较基准变化后应重新查询。协议类型见 [Git 声明](src/contract/git.rs)；`snapshotPatch` 在工作区写者全部结清后捕获已完成工作的不可变补丁。捕获会读取完整源内容，并在发布前将完整补丁缓冲在内存中；`readPatch` 分页读取该原始产物，后续执行和 Host 重启不会改变它。

`listFiles` 列出所选 Session 工作区中一个目录的直接子项，`watchFiles` 通知该目录需要重新读取；也适用于 WorkHub 协调者会话。`path` 为 null 表示工作区根目录，其他路径使用 `WorkspacePath`，以 `bytesBase64` 保留相对文件名的原始字节。符号链接作为叶子展示，不进入其目标；排除 `.git`、工作区标记及 Host 私有状态/control 目录，模型配置为无限制访问时也不例外。私有状态内仅允许读取 Session 已验证的受管 worktree。每页最多 128 项，以 512 KiB 为软字节目标，完整首项始终可以推进；路径保留完整相对字节。平台无法表示的文件名明确报错，不做有损转换。

`fileCandidates` 是同一 Session 工作区内的有限订阅。输入 `{sessionId, query, directory?}` 中省略 `directory` 或传 null 时选择工作区根目录。空查询或纯空白查询浅浏览所选目录内全部符合条件的直接文件和目录；非空查询只在该目录的后代中搜索相对文件路径。发送的数据项为 `{entries: [{path, kind}, ...]}` 批次，`WorkspacePath` 保留工作区相对路径的原始字节；持续追加批次，直到 EOF。与 `readFile` 一样，成功的最终完成值为 null，因此方法输出 schema 同时允许批次对象和该完成值；生产者不会把 null 作为数据项发送。批次沿用现有 `readFile` 的字节量子，不截断单项或结果集。关闭订阅会取消遍历并等待工作线程退出，发送背压会暂停生产者。遍历遵守工作区内 `.rgignore`、`.ignore`、`.gitignore` 及目录型 `.git/info/exclude` 规则，不跟随目录或忽略文件的符号链接，也不读取候选文件内容。搜索结果不会增加读取权限。

`readFile` 是普通 UI 可用的订阅，按相同 Session 权限读取一个精确 `WorkspacePath` 指向的当前普通文件。完整捕获 UTF-8 文本或受支持的原始图片字节，使用不跟随符号链接的目录/文件句柄，并在发布前校验工作区、权限边界及文件身份。它依次发送 `begin`、每块最多 32 KiB 原始字节的 Base64 `chunk`，最后发送明确的 `end` item；订阅最终值为 null。文本块止于 UTF-8 边界。消费者必须核验连续字节偏移、End 中匹配的版本/大小/摘要和完整 SHA-256 摘要，才能接受内容；缺少 End 表示传输未完成。文件缺失、已变化、二进制和不支持的文件类型均有明确结果；权限、非法路径和 IO 错误仍然返回失败。空文件是合法文本。

版本绑定原始内容、文件/父目录物理身份和路径；可选 `expectedVersion` 是重新读取的前提条件，不授予权限。一次读取的所有块均来自同一份完整原生 buffer，交付中替换路径不会混合版本。它不承诺持久 artifact，也不承诺并发写入下的原子文件系统快照。再次读取会重新授权 Session 并捕获当前内容；历史 `toolImage` 继续使用独立的不可变来源。接受预览前需继续读取至订阅成功结束、清理完成；关闭订阅以取消，然后等待原始清理完成。

先订阅并等待 `ready`，再读取第一页，并核对它与 `ready` 的 `directoryIdentity` 一致；通过 `next` 继续分页。收到 `changed` 后丢弃游标，从第一页重新读取。分页反映实时目录，并发编辑可能改变分页结果。通知可合并，不提供历史事件重放；重连后重新订阅和读取。检测到所选子目录删除或替换后，以 `unavailable` 结束订阅；Session/工作区授权失效或文件系统观察失败则以错误结束。离开目录时关闭订阅。

macOS 上，活动订阅还会比较直接子项的元数据。每次扫描后至少等待一秒；扫描耗时较长时，等待时间延长到该次扫描耗时的九倍，目标是每个订阅约用 10% 的时间扫描，并不承诺固定通知期限或限制总 CPU 用量。即使原生通知延迟，也能发现持续存在的变化；未变化时不发送通知。扫描不读取文件内容、不跟随符号链接，也不进入子目录。`ready` 会等待首次扫描；大目录或较慢的存储可能延迟就绪和后续通知。关闭订阅会等待其正在执行的文件系统工作结束。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)

`metadata.pinned` 用于置顶或取消置顶会话，省略时保留原状态。Session 结果包含 `pinned`。会话目录先返回置顶会话，再沿用原有 ID 顺序，前后翻页游标仍受目录 revision 约束。新会话和新分支默认不置顶。
