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

`resumable` 使用选定的续跑模型检查最新执行，返回精确来源回执或不可继续的原因；复用来源条件与 engine 重放检查，不准入新工作，也不启动 MCP 服务；实时工具可用性留到 `resume` 启动服务时检查。调用 `resume` 时提交该来源边界并保持操作身份稳定；准入时重新检查当前安全条件与权限，创建新 turn，丢失响应后恢复同一回执。可继续的查询结果不预留来源。

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

## 历史 checkpoint 管理

[Checkpoint 契约](src/contract/checkpoints.rs)通过现有 Agent endpoint 提供显式的 checkpoint 管理：

| 方法 | 模式 | 返回内容 |
| --- | --- | --- |
| `previewHistoryCheckpoint` | Query | Session 历史闭包成员及实时 revision |
| `publishCheckpoint` | Mutation | 持久发布状态及清理状态 |
| `checkpointReceipt` | Query | 原 Host 操作观测及领域发布回执 |
| `historyCheckpointHead` | Query | 当前 checkpoint Head，或 null |
| `readHistoryCheckpoint` | Subscription | 指定 retained revision 的原生历史包 |
| `loadHistoryCheckpoint` | Mutation | 隔离只读检查区状态及导入的成员 Session ID |
| `historyCheckpointLoadReceipt` | Query | 原 Host 操作观测及领域加载回执 |
| `restoreSessionCheckpoint` | Mutation | 同 Root 重新绑定后的 Session 及恢复目录路径 |
| `sessionCheckpointRestoreReceipt` | Query | 原 Host 操作观测及领域恢复回执 |

先预览，再携带 `confirmedSubtreeDigest` 和显式 `expectedRevision` 发布；只有创建第一个 Head 时预期为 null。摘要确认成员集合，不固定此前的内容 revision；Manifest 记录实际一致捕获的切点。繁忙源直接失败，不进入等待队列。日常消息不推进 checkpoint Head。发布经过普通 Host mutation 的准备与确认，确认前保存原 `RecoveryRef` **及原始输入**。结果未知时查询原操作，不换 ID 重发。CAS 冲突对原操作是终态，修改期望需要新操作。

`checkpointReceipt` 同时要求 endpoint 访问和原操作恢复权限。包括 Root 重开后的查询都只读原事实，不重新捕获当前历史。`publication.state.kind = published` 确认存档成功，即使 `operation.outcome` 仍为 `unresolved`、清理仍为 `unconfirmed`：二者来自不同事务。查询不会伪造 Host 完成，也不释放原操作的工作持有权。null 只表示未找到对应保留事实，不证明操作不可能执行。`interrupted` 表示捕获未完成，`prepared` 等待 Root 恢复，`unavailable` 需要排查，不能用原操作重新捕获。发布后的清理失败不撤销已提交 Head。

读取时先获取 Head，再指定其精确 revision；Head 已移动则失败，不自动选择最新。历史成功回执不授予旧 revision 读取能力。已经受理的读取持有校验后的文件，随后 Head 移动仍可完成。流依次返回 `checkpoint` 元数据（带可空的 Workspace 引用）、连续偏移的 Base64 `chunk`（解码后每块最多 32 KiB）及含完整对象 SHA-256、字节数的 `end`。内容是原生 `MAKA-SESSION` v2，不是 tar.gz，也不兼容旧 TypeScript checkpoint 格式。接收方须检查元数据、连续偏移、摘要、End、成功的 null 完成及清理结果；缺少 End 就是不完整传输。背压限制排队数据块，取消等待原读取工作排空，不接受调用方任意文件路径。

这些方法属于管理入口，不是模型工具。Scope 来自已获准的 Agent 装配；模型来源调用和其他 namespace 被拒绝。`workspaceConsistency: null` 时，`publishCheckpoint` 只包含原生 Bundle 的历史闭包及关联 Artifact；Workspace 和受限恢复使用下文的显式方法。两者均不包含完整 Memory/Goal 状态或跨 Host 执行授权。发布目前依赖 Root 存储的 Unix 实现，不支持的平台显式失败。不可变对象保守保留，自动触发、UI 和 retention/GC 另行推进。

### 精确只读加载

从 `historyCheckpointHead` 取得 `{ sessionId, revision }`，通过 Host 的 mutation 准备与确认调用 `loadHistoryCheckpoint`，保存原 `RecoveryRef` 和输入。写入目标之前先校验并登记当前 retained revision；Head 已移动则拒绝新的加载。登记成功后，即使 Head 推进，恢复仍使用已固定的 Manifest 和 Bundle。`ready` 返回 `inspection` 定位信息及导入的 `sessionIds`。

检查副本在独立私有数据库中保留历史 Session ID，不覆盖实时 Session，也不向普通目录注册可运行副本。加载不会启动模型、工具、待处理消息消费者或 Agent 后台任务。源配置只作为历史证据，不成为目标执行授权。若包含 Workspace，加载只验证清单及不可变文件对象并返回一致性信息，不在检查区复制文件、不切换实时目录或执行任务，也不向另一 Host 导入。

响应未知时，携带 `{ reference, input }` 查询 `historyCheckpointLoadReceipt`。它分别返回原 Host 操作观测与领域加载结果，不启动另一加载。`preparing` 等待从原材料恢复，`unavailable` 需要排查；领域 `ready` 不代表 Host 已确认结果或清理。Root 在开放检查接口前恢复未完成导入；若目标已提交而加载回执丢失，使用原生导入回执找回原结果。

以下读取接口携带返回的 `inspection` 和其中一个成员 `sessionId`：

| 方法 | 其他输入 | 结果 |
| --- | --- | --- |
| `loadedHistoryCheckpointHistory` | `position`，可选 `includeThinking` | 既有有界 `HistoryPage`，包含工具结果文本 |
| `loadedHistoryCheckpointArtifacts` | `offset` | 最多 32 条 Artifact 元数据及 `nextOffset` |
| `loadedHistoryCheckpointArtifact` | `artifactId`、字节 `offset` | 订阅：连续返回元数据及最多 32 KiB 的 Base64 块；不存在返回 null |

使用返回的历史游标和 Artifact 偏移分页，无需把整个 checkpoint 放入内存。每个 Artifact 订阅在完整传输期间只使用一条只读数据库连接，具备背压与取消排空；调用方须确认订阅完成及清理结果。检查区读取不申请写租约、不执行迁移、不同步目录，可并发读取。检查副本独立于后续 Head 变化保留。目前检查数据库和不可变对象没有删除/GC API；不断发起**新**加载会增加磁盘占用，原操作重试复用原目标。这些方法与发布使用相同的管理授权和 namespace；定位信息本身不授予访问权。

### Workspace 发布与本地继续执行

`publishCheckpoint` 输入 `{ sessionId, expectedRevision, confirmedSubtreeDigest, workspaceConsistency }`，`checkpointReceipt` 使用原始 `{ reference, input }`。统一接口及 Manifest 表达纯历史（`workspaceConsistency: null`）和带 Workspace 两种模式。带 Workspace 时只支持空闲的普通 native Session 和单个 Workspace；准入排除目标 Session、共享或嵌套 Workspace 的执行以及该 Session 尚未完成的 Goal producer。复制期间不持有全 Agent 的 runs/goals 锁，无关 Session 可以继续。路径来自 Host 验证过的绑定。Manifest 包含原生历史 Bundle、事件历史切面以及可空的 Workspace 清单/内容寻址文件对象。历史订阅使用同一种 `checkpoint` 首帧并传输 Bundle。发布及回执结果的 `workspace` 为 null 或 `{ consistency, warning }`。

捕获 Workspace 时必须显式选择 `caller_confirmed_quiescent`（调用方确认复制全程已停写）或 `unverified`（不能保证）。**两者都不隔离外部写入者，也不要求 Apple entitlement。** 客户端应显示 `external_writers_not_fenced` 提示：捕获期间需暂停编辑器、终端、其他 Agent 和后台程序的写入。用户确认只是前提声明，不是系统快照证明；无法保证时不得把产物宣称为一致、可信的 checkpoint。两种模式检测到变化都中止发布；摘要校验仅证明保存的字节完整，不能证明各文件来自同一时刻。此标记随 Manifest、加载和恢复保留。

捕获遵循项目 `.gitignore`、嵌套忽略文件和 `.git/info/exclude`，不读取全局或项目上层的忽略配置。额外排除 `.git`、`node_modules`、`.DS_Store`、`__pycache__`、`.cache`、`.maka-workspace.json` 及已知凭据文件名/目录（包括真实 `.env`）。这些路径被省略，不再导致整个捕获报错；普通 `.pem`、`.key` 测试夹具允许保留，但文件名规则并非通用秘密扫描器。被选中的符号链接、特殊文件和不可移植路径仍显式拒绝。保留普通文件、可执行位和空目录；不设固定文件数量、容量或时间门槛。磁盘成本随纳入数据量增长，内存随清单规模增长；大型捕获仍有 I/O 成本，完成前保留目标 Session 准入。

API 和私有 JSON 仍是开发中契约：不保留旧发布端点、Manifest 双轨或缺失 Workspace 字段的隐式兼容。旧形状的开发 checkpoint 数据需要显式离线迁移或重新生成。

`restoreSessionCheckpoint` 输入为 `{ checkpoint: { sessionId, revision }, parent: "/absolute/allowed/directory", permissions, backend, acceptExternalWritersRisk: true }`。输入为获准根内的绝对路径或 `~` 前缀路径，目录物理身份由 Host 获取并重新验证。Host 在父目录中新建 `maka-restored-…` 子目录，不覆盖原项目。首版仅支持**同 Root、事件历史仍与存档点相同**的普通 native Session；已读、改名、置顶、之前的恢复不会使未变化的历史失效，当前元数据 revision 仅用于提交 CAS。历史已推进、Head 已移动、WorkHub、子 Session、Goal 状态和 executor backend 都拒绝。显式选择目标模型与权限，撤销旧授权；unverified 不会因恢复变成可信。

恢复在同一事务提交目录绑定与原操作回执，保留 Session ID 和 checkpoint Head，下一次发布仍以原 Head revision 做 CAS。不会回滚新历史，也不重建已丢失的 Root；加载/重新绑定不会自动调用模型或工具，显式发送下一条普通消息后才从新目录执行。跨 Root/Host 权威交接、任意历史回滚、完整辅助状态迁移和轮次中间恢复不在本次范围。

回执未知时，使用原始 `{ reference, input }` 调用 `sessionCheckpointRestoreReceipt`；已提交回执不依赖目标目录仍在原位置。登记恢复请求不代表拥有目标目录；只有复制完成且落盘成功后，才记录实际创建目录的物理身份。重试与提交都要求仍是该目录，即便替换目录内容完全相同也拒绝。提交前若目标已被占用、不完整或被改变，则保持原 Session 不变，保留目录供检查；处理失败准备后使用新的操作/目标目录。恢复还会排除未完成的 Goal 写入，并持续到目录绑定提交。不自动删除用户可见的恢复目录；检查数据库、恢复目录和文件对象均占用持久磁盘，尚无自动 GC。
