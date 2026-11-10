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

# maka-event-log

[English](README.md)

Transcript 行分别暴露 `position` 和 `order`：前者定位规范原文，后者按原生 assistant 消息真正开始的位置排序，即使消息结束记录晚于工具调用。历史分页、导航与复制历史按显示顺序使用索引，原文读取和 fence 仍保留规范来源。原生消息正文按 invocation／message 专用索引重建，不逐条重扫此前所有工具输出。

Checkpoint 使用 `RootStore::history_checkpoints` 和
[`checkpoints`](src/checkpoints.rs) 中的类型。捕获在 runtime 数据库中冻结事件成员关系、
来源边界、Artifact 引用和导出元数据。Manifest 承诺从该快照重建的原生 Bundle；
校验使用临时传输文件。Manifest 与可选的 Workspace 文件对象保存在私有 Root 下。
Checkpoint Head、快照发布关系和发布回执在同一数据库事务提交；Host 操作结算单独查询该回执。

原操作固定输入与已捕获快照。启动恢复中断未完成捕获，并从同一快照继续已准备的发布。
失败或命中去重的未发布捕获释放自身的独立快照引用。快照成员关系独立于实时 Session 的修改
和回收，保留所需规范事件材料与 Artifact 内容。精确 checkout 只接受当前 Head revision，
并重建其已承诺的传输字节；历史发布回执不授予已被替代版本的 checkout 权限。
临时文件清理与发布成功分开记录。

`HistoryCheckpoints::load_exact` 校验精确的当前 Head 及其来源，在同一数据库中记录引用既有
不可变快照的加载回执，不创建 Session、不执行导入，也不创建检查数据库。有界历史与 Artifact
查询使用快照所有权，保留历史身份，不暴露实时执行能力。重放加载操作返回原回执；
Head 推进后，已加载历史仍然可读。

Checkpoint 文件发布当前要求 Unix 文件及目录持久化语义，不提供自动触发、协议入口或跨 Root
执行交接。原生传输格式不兼容旧 TS compatibility bundle；Workspace 捕获及同 Root 目录恢复见下文。

存储通过当前 SQL 迁移初始化；不支持的内部布局和记录格式会被拒绝。规范事实及其接受、所有权、恢复和预算索引共享原事务；transcript 与 Recall 读模型属于可丢弃的 observation 缓存。

管理 SQLite 事件存储和 State Root 租约，持久化应用配置与包、操作回执、会话、轮次及恢复记录。独占所有权见 `root`，已提交的组合见 `applications`，中断恢复见 `recovery`。服务激活前必须先取得 Root 的持久化所有权；业务策略属于插件，规范事实由这里记录。

生产入口是持有唯一 `RootOwner` 的 `RootStore`，使用一个 runtime 数据库。应用来源与包、caller intent journal、project/workspace binding、Session、操作日志及有作用域的插件数据都保存在该库。`SessionStore` 和 `OperationStore` 将访问绑定到已获准的身份；共享存储不授予其他 Session 或来源的访问权。

公开 API 保持异步，将拥有数据的命令送入 actor。每个 actor 的专用线程打开、独占并关闭同步 `rusqlite::Connection`。一条 writer FIFO 串行执行修改，独立 reader 通道读取已提交快照，observation 通道拥有可丢弃缓存。SQL、行解码与事务清理都在连接所属线程上执行；SQLite 行、statement 和借用的 BLOB 数据不离开当前任务。

CPU 密集的写入准备使用有界工作池和准入容量。请求在开始准备前预留 writer FIFO 位置，准备完成的先后不会改变已接受写入的顺序。可中断读取安装每任务独立的 SQLite progress hook；观察者取消只标记该读取，清理和连接复用前会移除 hook。已接受的写入保留原始 custody 直到物理事务清理完成，即使观察者已经消失。

闲置句柄和已完成的 capability 只持有弱引用。执行通过工具、Host child scope 传递捕获的权限 basis、binding pins 和 Session work lease；可能超出父调用生命周期的子 worker 从这份实际 custody 派生独立租约。Root 关闭先停止准入、排空已接受的工作，等待 reader 和准备线程退出，并确认全部 SQLite 连接实际关闭。关闭完成回执报告真实的 `Connection::close` 结果；无法关闭的存活句柄保留其所有权并报告失败。观察者消失不代表清理完成。

Workspace 重定位只修改共享 binding 及其 revision offset，不重写所有 Session。Metadata CAS 使用 effective revision；受影响 binding 上有实际工作时不能重定位，Session 退休还要等待 operation auxiliary 工作。Auxiliary 准入、原操作 pending 检查与 once-only 记录仍在来源日志的同一事务中完成。启动时先恢复遗留 effect/auxiliary 工作，再公开 Root ready。

Root catalog 和 usage 在 runtime 数据库中使用有索引的 keyset 分页，并在 SQL 中排除尚未发布或隐藏的 Session。用量活动与分类明细使用 keyset 游标；会话历史复制不会重复计算物理事实。Goal token meter 在结算事务中维护 Session 累计值，常规预算检查读取索引累计值，不扫描全部历史。Session 通知只登记活跃观察者，在提交后发布对应 Session 的变更。

模型请求通过 Session 执行 custody 捕获不可变的规范来源。Engine 冻结渲染决定并负责请求准备；事件日志提供有界来源读取，不使用私有 prepared 数据库。Session scratch 和已加载工具状态使用磁盘上的 `maka-session-state` 后端。模型上下文压缩限制选中的工作窗口，同时保留完整规范历史。采纳检查点后，模型上下文由历史检查点摘要和 `covered_through` 之后的事件组成，不再重放已经覆盖的开头消息。开头消息的身份仍用于校验 MidTurn 检查点。摘要保留的附件引用通过复制会话已有的所有权映射解析。

较大的 semantic payload 存在 [SQLite rowid 表](https://www.sqlite.org/withoutrowid.html#when_to_use_without_rowid)中，以显式业务主键定位，让记录拥有更多内联空间。

调用意图、项目登记、workspace attachment、Session 预留和发布、操作派发与结算、待处理消息以及符合条件的规范事件追加，共用有类型约束的 writer 队列。最多 32 个已经排队且相邻的请求共享一次 FULL 提交，不等待凑批，也不跨过普通 writer 命令。每个请求保留独立校验，多请求批次为每个请求设置保存点。持久化回执、执行凭据与提交通知只在提交成功后返回。生产者的后续阶段等待前一阶段的持久化回执。涉及能力、checkpoint、摘要和 lineage 的追加保留原有事务路径。

新运行时事件使用 UUIDv7 身份，让事件及派生消息的索引写入集中在相邻位置。导入和重放保留原身份，事件顺序仍由数据库序号决定。语义行的 event_id 索引只覆盖需要按身份归档的工具结果；增量修订读取使用变更目录，历史来源复制按来源位置主键直接定位。

规范运行时事件入口逐条插入事件并取得序号，再在同一 writer actor、同一写事务内，用独立语句维护安全、执行、来源和语义投影。用于索引的记账和所有者字段由统一插入语句从同一 JSON 计算，正文回收后保留其发布值。安全与执行维护由类型化事实选择相应语句。当前事件投影完成后才开始下一条。投影存储错误使整个批次回滚，导入事件同样如此；通知仍只在提交成功后发布。复制前缀投影由当前复制路径维护。

规范数据库使用 UTF-8。成功工具结果的原始 `model_projection` token 单独保存：`event_header` 用字面量 `null` 占位，保留周围全部原始字节；事件行记录原字节偏移和不可变正文引用。两者重建出精确的规范事件，包括导入内容的空白、数字拼写和 Unicode 转义。`canonical_bytes` 用于逻辑字节预算，压缩大小不替代已接受的规范大小。其他事件类型仍内联保存。

正文保存为可直接 seek 的原始字节，按原始 token 的 SHA-256 共享，重复身份还需逐字节核对。读取校验逻辑长度与选中区间。对照实验中，分帧压缩稳定拖慢了受支持的窗口和顺序读取，因此未作为持久化格式保留。空间收益来自紧凑目录与相同投影 token 的共享，不能把压缩实验中独有正文的压缩率套到最终实现。

完整事件的 JSON 查询在原快照内的同一 SQL 行 JOIN 引用的正文，并重建原始字节。类型化前缀 reader 只排列 header 和正文引用，避免大正文进入 SQLite 排序记录；随后在同一连接、同一事务内复用一条 prepared 主键查询读取引用的正文，内联事件无需查询正文。Reader 在连接所属 actor 上直接解码借用的 header 和原始投影字节，避免把正文复制到临时字符串中，并在推进任一行之前完成解码。原有事件／字节预检和事务覆盖完整结果；SQLite 借用和未完成的解码都不会离开该 actor。Header 复用事实字段的类型和默认值、忽略未知元数据，并验证投影占位符恰好位于已存偏移。Root 证据把原始三段字节作为一个带长度前缀的 JSON 字段计算摘要；元数据谓词继续读取 header 并使用原索引。语义区间保留原规范坐标，工具区间把原规范坐标换算为不可变正文内部的偏移，内联 model part 则保留 SQLite BLOB 的物理边界。读取仍由连接所属 actor 执行。热区间读取复用其已有 statement cache。正文引用的存活由既有历史所有者回收证明决定，最后一个引用清除或删除时，在同一事务删除正文。事件行原子发布 header、逻辑长度、偏移和引用，存活引用不可重定向；正文摘要和派生目录都不授予访问权，也不延长存活期。归档占位内容和其他片段正文继续使用分块存储。

语义行、payload 和子项目录是有限的派生描述符，采用 Postcard 编码。writer 在发布事务内编码一次；分页把已存字节和固定小端序定位字段直接复制到调用者计费的缓冲区，消费端恢复原有类型，无需读取整个正文。原始字节位置与叶子摘要保持不变，目录编码不参与规范事实或来源身份。

原 Agent 语义存储基准及其比较脚本已从 Root 配对退休。Agent 历史、冻结语义来源与 bundle 属于 Agent 领域；Root 不再提供这些基准测量。

语句失败会回滚 writer 整组，只有由请求保存点隔离的领域拒绝例外。复用连接要求确认回滚完成、处于 autocommit 状态且所有权仍有效。提交失败返回结果未知，不产生执行凭据；无法确认清理时让连接退出。单键与分页插件数据读取使用独立 reader 连接，读取已提交快照；依赖写入的读取等待前一写入的持久化回执。

已保存应用的检查使用 `RootOwner::open_existing` 和 `EventLog::for_application_inspection`，要求已有的私有协调状态，并持有原有的独占 Root／数据库租约。检查读取已提交的应用事实，包括保留在 WAL 中的内容，关闭后不改变存储成员或字节；不执行迁移或派生初始化，缺失状态直接报错，不做修复。该打开方式仅供原连接上的应用查询使用。CLI 的 application read 与默认更新预览共用此入口；实际应用更新时重新打开普通写入所有者，并重新计算变更。

原始操作契约按摘要只存储一次。操作请求和回执引用只携带该身份，日志读取、调用方历史与 UI 传递不再逐次复制服务 schema。读取仍核对原始请求指纹，执行准入仍校验完整契约和资源要求。

操作日志完整保存已受理的请求和返回值，不另设请求、结果或回执引用的大小额度。精确重试和重开后的读取恢复原始结果与清理状态。

消息交付保留准备后的内容、可编辑原文和最初提交的摘要。内部记录保存这些不同事实，编码后可能大于公开请求；写入与精确消息读取不再对整条编码记录重复套用请求大小限制。待处理队列不设固定条数或总字节额度。停止和整队撤回在同一事务的回执中保留完整获准条目，不另设回执大小额度。精确重试和重开后的读取返回同一份原始回执。通过 `editable_message` 按 Session、Turn 和消息身份读取一条已拥有的来源。

来源消息、执行器工具调用与生成的工具结果共享 Session 的可见消息身份空间。无论哪一方先声明，准入都依据规范事实检查冲突，包括执行器完成或调用终止时为待完成工具补出的结果。只有实际结果身份被占用；仅后缀相同不会预留身份。

规范事件写入在同一事务中维护 Session、Invocation 和数据库序号前缀的固定大小 SHA-256 承诺。复制的前缀引用保留获准来源身份；Source identity 将 scope/cut 与这些前缀根绑定，lineage 使用持久化链式 ancestry root，普通读取无需在 Rust 中保留完整祖先向量。新边界在写入或导入时验证；普通请求信任已获准事实和 checkpoint，不重新扫描整段来源或递归认证历史 checkpoint。

续跑检查点若完整覆盖切分位置之前的 Session 历史，后续整个 Session 的请求也可沿用。覆盖判断比较 Session 区间与各祖先 Invocation 在已有前缀索引中的累计事件数，不读取事件正文，也不另存会话头。未覆盖其它分支的检查点仍只用于自身续跑链，避免丢弃中间出现的分支历史。

`run_source` 读取持久化 Invocation 前缀和 opening/final 端点；身份绑定 Run 内事件数、Invocation 身份和已提交的有序来源根。普通 lineage 读取使用 opening 时安装的不可变 descriptor。Continuation 准入仍校验所有权、workspace 身份、精确封口端点和未完成 effect；来源根本身不授予执行权限。

普通请求和正常重开信任受控写入或导入边界已接受的事实与 checkpoint，读取固定语义视图，不扫描规范尾部、不与 writer 握手确认、不保存进程内信任证明，也不重新认证历史 checkpoint。新 checkpoint 校验新增来源／前驱边及必要终态。直接改写 SQLite 不属于支持的编辑 API，普通读取不负责检测这种修改；显式有界历史导出继续保留事件数和字节预检。

Observation actor 在私有临时 SQLite 数据库中建立 transcript 元数据与不含正文的 Recall postings。读取捕获规范成员关系和来源边界，仅补齐新增来源；不产出展示行的来源也推进水位。行、来源失败和进度共享缓存事务，该连接的规范数据库仍物理只读。历史读取明确报告投影失败，搜索通过 gaps 报告受影响会话；存储错误回滚缓存工作，不再拒绝执行事实。

Recall 在 [FTS5](https://sqlite.org/fts5.html#the_detail_option) 中记录每个文档出现过的 gram，每个 gram 由 1/2/3 个 Unicode scalar 组成，重复出现只记录一次。NFC 规范化并转小写后，字面 OR 命中按“非重叠命中的 scalar 总数 ÷ 正文 scalar 数”排序；不同词之间的重叠分别计分，工具结果的权重为一半。结果保留每个 Turn 中最相关的一条消息、稳定的时间与身份排序，以及请求指定的数量限制。 FTS 身份直接复用目录 rowid；候选正文和附件从原规范来源渲染后执行字面匹配核验。

逐项接受的 main part 保留原 observation 序号、消息身份和 ordinal，旧边界不会被后来事实改写。目录与 FTS 元数据不参与正文 LRU，独立于已有 32 MiB 正文保留目标。复制身份变化或 Session purge 清理对应缓存，关闭 observation 连接会丢弃全部缓存；后续读取按所需规范边界重建，不再要求 writer 安装目录或维护启动。访问权限与材料回收始终由规范所有权和引用决定。

完整产物读取使用 `with_artifact`，选择 Session 或执行轮次范围。元数据与局部只读 BLOB reader 共享原 owner 的同一快照；同步回调拥有目标资源，读取句柄关闭后才释放快照，避免每块重新打开并读取整个 payload。独立 reader 持有快照；即使等待方消失，已受理工作仍保留原 owner。产物复制从冻结来源快照按固定大小的 BLOB 块流入一个目标事务，并校验摘要和幂等重试。调用方继续负责资源预算、摘要核验和取消策略。`read_artifact_chunk` 用于独立窗口，多次窗口调用不会保留顺序读取游标。

生成的工具图片与用户上传在模型重建、不可变复制及导出包传输中保留完整原始产物字节。payload 长度、摘要、规范冻结位置及历史复制映射继续作为权威依据。导出包按块传输产物，保留物理帧长度表示和停滞 I/O 清理，不另设整个导出包的内容配额。

历史、事件投递和资源分页保留后续项的字节打包目标；首个完整项即使元数据超出目标，也携带原始元数据与游标继续推进。历史正文仍按 UTF-8 字节窗口传输。`history_source` 只接收正文字节目标，并保留该单块的完整原始元数据，不再设置独立 JSON 信封配额。Session 范围与冻结来源边界仍为必要条件。

集成场景通过 `cargo test -p maka-event-log --test integration` 统一运行，可用 `archive::`、`sessions::` 等模块名筛选。跨进程租约测试单独放在 `--test root_lease`，避免创建子进程时短暂继承其他测试线程持有的文件租约。私有投影测试通过 `--lib` 运行。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)

启动恢复读取全部未决执行状态，不另设条数或字节配额，已完成历史仍不参与扫描。工具结果 payload 与冻结请求配置不设应用层存储大小上限。


Workspace 存档采用路径清单和不可变文件对象；`caller_confirmed_quiescent` / `unverified` 声明与字节完整性分开，不能宣称已经隔离外部写入。同 Root 目录恢复要求实时历史未推进，在新目录物化，并原子提交绑定与原回执；不推进 checkpoint Head、不自动执行。文件策略、明确风险提示、故障恢复和范围见 [Agent API](../../plugins/agent/api/README.zh-CN.md)。
