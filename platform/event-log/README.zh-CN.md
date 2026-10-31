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

仅历史 checkpoint 使用 `RootStore::history_checkpoints` 和
[`checkpoints`](src/checkpoints.rs) 中的类型。原生 Bundle 与版本化 Manifest
先验证并持久保存在私有 Root 内，再创建或条件更新独立的 checkpoint Head。
Head 与发布回执在 Session 所在分区的同一事务提交；Host 操作日志可能位于
另一分区，响应结果未知时必须先查询原发布回执。实时 Session revision 和
日常持久化行为保持原语义。

原操作固定输入与已准备材料。启动恢复会中断未完成捕获，并用原材料继续已
准备的发布，不重新捕获更新后的历史。准备事务失败后无需重启即可中断捕获；
提交结果未知时保留已经准备的材料。损坏的准备对象留下明确的 unavailable
回执；临时文件清理与业务成功分开记录。观察者取消后，物理 worker 仍持有
Root 直到工作结束。精确读取只支持当前 retained checkpoint revision，不会
替换成最新版本；历史成功回执也不授予已被替代版本的读取能力。

该内部能力当前要求 Unix 文件及目录持久化语义，其他平台在请求 claim 前
拒绝发布。它不提供自动触发、协议入口、Workspace 文件快照、执行授权或恢复
启动；原生历史格式不兼容旧 TS compatibility bundle。不可变对象暂时保守
保留，只清理明确归属的临时文件，因此磁盘使用并非自动有界；retention/GC
属于后续工作。

存储通过当前 SQL 迁移初始化；不支持的内部布局和记录格式会被拒绝。规范事实及其接受、所有权、恢复和预算索引共享原事务；transcript 与 Recall 读模型属于可丢弃的 observation 缓存。

管理 SQLite 事件存储和 State Root 租约，持久化应用配置与包、操作回执、会话、轮次及恢复记录。独占所有权见 `root`，已提交的组合见 `applications`，中断恢复见 `recovery`。服务激活前必须先取得 Root 的持久化所有权；业务策略属于插件，规范事实由这里记录。

生产入口是持有唯一 `RootOwner` 的 `RootStore`。当前布局使用一个 control 数据库和八个固定执行分区。Control 保存不可变应用来源、caller intent journal、project/workspace binding 和持久化 Session 路由；Session 及其 revision/import family 共置一个分区。操作日志按 deployment、provider namespace 与 operation 身份定位，来源 revision 不改变分区。Session 范围的插件数据跟随 Session，其他插件命名空间使用稳定的数据分区。数据写入器只读挂载 control；任何执行分区含 caller intent 记录的 Root，以及已有数据的旧单库 Root，都会被拒绝并保留原日志，不会静默忽略或移动 caller 记录。

`SessionStore` 和 `OperationStore` 只公开绑定身份的操作，不暴露原始日志。闲置句柄和已完成的 capability 只持有弱引用；已接受的 SQL 则保留实际 owner 和锁，直到物理事务清理结束。执行通过工具、Host child scope 传递捕获的权限 basis、binding pins 和 Session work lease；可能超出父调用生命周期的子 worker 从这份实际 custody 派生独立租约。Root 关闭先拒绝新工作，再等待已接受的实际工作，最后关闭全部 SQL owner。无法确认清理时保留原始所有权并报告失败；观察者消失不代表清理完成。

Workspace 重定位只修改共享 binding 及其 revision offset，不重写所有 Session。Metadata CAS 使用 effective revision；受影响 binding 上有实际工作时不能重定位。Session 退休还要等待其他分区中的 operation auxiliary 工作。Auxiliary 准入、原操作 pending 检查与 once-only 记录仍在来源日志的同一事务中完成。启动时先恢复全部分区中的遗留 effect/auxiliary 工作，再公开 Root ready。

Root catalog 和 usage 游标使用固定大小的分区向量。Catalog 合并有界的局部 keyset 页，并在 SQL 分页前排除尚未发布或隐藏的路由。用量活动与分类明细使用 keyset 游标；会话历史复制不会重复计算物理事实。Goal token meter 在结算事务中维护 Session 累计值，常规预算检查只需八次索引查询，不扫描全部历史。Session 通知只登记活跃观察者，合并固定分区中的对应 Session 通知，不为每个事件写 control，也不创建转发任务。

模型请求通过 Session 执行 custody 捕获不可变的规范来源。Engine 冻结渲染决定并负责请求准备；事件日志提供有界来源读取，不使用私有 prepared 数据库。Session scratch 和已加载工具状态使用磁盘上的 `maka-session-state` 后端。模型上下文压缩限制选中的工作窗口，同时保留完整规范历史。采纳检查点后，模型上下文由历史检查点摘要和 `covered_through` 之后的事件组成，不再重放已经覆盖的开头消息。开头消息的身份仍用于校验 MidTurn 检查点。摘要保留的附件引用通过复制会话已有的所有权映射解析。

较大的 semantic payload 存在 [SQLite rowid 表](https://www.sqlite.org/withoutrowid.html#when_to_use_without_rowid)中，以显式业务主键定位，让记录拥有更多内联空间。

Control 中的调用意图、项目登记、workspace attachment、Session 路由预留和发布，共用一条有类型约束的写入队列。调用意图保留既有 metadata 提交通知，还会唤醒 application-head 和 Session 观察者。各执行分区批量处理操作派发与结算、待处理消息以及符合条件的规范事件追加。每个写入器最多让 32 个已经排队且相邻的请求共享一次 FULL 提交，不等待凑批，也不跨过普通写入或控制命令。每个请求保留独立校验，多请求批次为每个请求设置保存点。执行凭据与提交通知只在提交成功后返回。生产者的后续阶段仍需等待前一阶段的持久化回执。涉及能力、checkpoint、摘要和 lineage 的追加保留原有事务路径。

新运行时事件使用 UUIDv7 身份，让事件及派生消息的索引写入集中在相邻位置。导入和重放保留原身份，事件顺序仍由数据库序号决定。语义行的 event_id 索引只覆盖需要按身份归档的工具结果；增量修订读取使用变更目录，历史来源复制按来源位置主键直接定位。

规范运行时事件入口逐条插入事件并取得序号，再在同一 SQLite worker、同一写事务内，用独立语句维护安全、执行、来源和语义投影。用于索引的记账和所有者字段由统一插入语句从同一 JSON 计算，正文回收后保留其发布值。安全与执行维护由类型化事实选择相应语句。当前事件投影完成后才开始下一条。投影存储错误使整个批次回滚，导入事件同样如此；通知仍只在提交成功后发布。复制前缀投影由当前复制路径维护。

规范数据库使用 UTF-8。成功工具结果的语义片段引用原始事件 JSON 中经过校验的字节区间。解析在调用者的读取快照内，由原 SQLite worker 读取并解码选中的工具投影；来源收集器为仍有历史所有者的正文保留存活期。归档占位内容和其他片段正文继续使用分块存储。

语义行、payload 和子项目录是有限的派生描述符，采用 Postcard 编码。writer 在发布事务内编码一次；分页把已存字节和固定小端序定位字段直接复制到调用者计费的缓冲区，消费端恢复原有类型，无需读取整个正文。原始字节位置与叶子摘要保持不变，目录编码不参与规范事实或来源身份。SQL 迁移在同一事务内转换原 JSON 描述符；转换函数仅在迁移期间存在。

`event_storage_bench` 测量真实 Root 写入、冻结目录、子项分页、首尾窗口、顺序正文、事件前缀和 bundle 导出。在两个版本上用 release 构建同一 example 并各自保存二进制后，运行 `python3 scripts/bench-event-storage.py --output /tmp/storage-comparison original=/path/to/original candidate=/path/to/candidate`。脚本交错执行至少五轮，校验事件、目录、正文与导出摘要。首次读取用于校验和预热；重开测量保留操作系统缓存。记录保留原始分布、进程 CPU/RSS/I/O 可用性、SQLite 缓存计数，以及分列的主库、WAL、SHM 大小。存活 prepared statement 的快照不能代表全部 SQL 工作；评估单独路径是否退化时，需要按投影类型复核混合计时。

语句失败会回滚整组，只有已由自身保存点隔离的领域拒绝例外。原先使用普通写入路径的请求，在确认回滚并重新校验所有权后，可以继续通过同一 owner 恢复；纯 observation 批次保留更严格的退出策略。提交失败始终返回结果未知，不产生执行凭据；此后复用原普通写入组，还要求确认清理完成且事务深度为零。保存点、所有权或无法确认的清理失败都会让写入器退出。单键与分页插件数据读取使用独立 reader，读取已提交的快照；依赖写入的读取仍需先等待相应回执。

已保存应用的检查使用 `RootOwner::open_existing` 和 `EventLog::for_application_inspection`，要求已有的私有协调状态，并持有原有的独占 Root／数据库租约。检查读取已提交的应用事实，包括保留在 WAL 中的内容，关闭后不改变存储成员或字节；不执行迁移或派生初始化，缺失状态直接报错，不做修复。该打开方式仅供原连接上的应用查询使用。CLI 的 application read 与默认更新预览共用此入口；实际应用更新时重新打开普通写入所有者，并重新计算变更。


原始操作契约按摘要只存储一次。操作请求和回执引用只携带该身份，日志读取、调用方历史与 UI 传递不再逐次复制服务 schema。读取仍核对原始请求指纹，执行准入仍校验完整契约和资源要求。

操作日志完整保存已受理的请求和返回值，不另设请求、结果或回执引用的大小额度。精确重试和重开后的读取恢复原始结果与清理状态。

消息交付保留准备后的内容、可编辑原文和最初提交的摘要。内部记录保存这些不同事实，编码后可能大于公开请求；写入与精确消息读取不再对整条编码记录重复套用请求大小限制。待处理队列不设固定条数或总字节额度。停止和整队撤回在同一事务的回执中保留完整获准条目，不另设回执大小额度。精确重试和重开后的读取返回同一份原始回执。通过 `editable_message` 按 Session、Turn 和消息身份读取一条已拥有的来源。

来源消息、执行器工具调用与生成的工具结果共享 Session 的可见消息身份空间。无论哪一方先声明，准入都依据规范事实检查冲突，包括执行器完成或调用终止时为待完成工具补出的结果。只有实际结果身份被占用；仅后缀相同不会预留身份。

规范事件写入在同一事务中维护 Session、Invocation 和分区序号前缀的固定大小 SHA-256 承诺。复制的前缀引用保留获准来源身份；Source identity 将 scope/cut 与这些前缀根绑定，lineage 使用持久化链式 ancestry root，普通读取无需在 Rust 中保留完整祖先向量。新边界在写入或导入时验证；普通请求信任已获准事实和 checkpoint，不重新扫描整段来源或递归认证历史 checkpoint。

`run_source` 读取持久化 Invocation 前缀和 opening/final 端点；身份绑定 Run 内事件数、Invocation 身份和已提交的有序来源根。普通 lineage 读取使用 opening 时安装的不可变 descriptor。Continuation 准入仍校验所有权、workspace 身份、精确封口端点和未完成 effect；来源根本身不授予执行权限。

普通请求和正常重开信任受控写入或导入边界已接受的事实与 checkpoint，读取固定语义视图，不扫描规范尾部、不与 writer 握手确认、不保存进程内信任证明，也不重新认证历史 checkpoint。新 checkpoint 校验新增来源／前驱边及必要终态。直接改写 SQLite 不属于支持的编辑 API，普通读取不负责检测这种修改；显式有界历史导出继续保留事件数和字节预检。

Observation worker 在私有临时 SQLite 数据库中建立 transcript 元数据与不含正文的 Recall postings。读取捕获规范成员关系和来源边界，仅补齐新增来源；不产出展示行的来源也推进水位。行、来源失败和进度共享缓存事务，该连接的规范数据库仍物理只读。历史读取明确报告投影失败，搜索通过 gaps 报告受影响会话；存储错误回滚缓存工作，不再拒绝执行事实。

Recall 在 [FTS5](https://sqlite.org/fts5.html#the_detail_option) 中记录每个文档出现过的 gram，每个 gram 由 1/2/3 个 Unicode scalar 组成，重复出现只记录一次。NFC 规范化并转小写后，字面 OR 命中按“非重叠命中的 scalar 总数 ÷ 正文 scalar 数”排序；不同词之间的重叠分别计分，工具结果的权重为一半。结果保留每个 Turn 中最相关的一条消息、稳定的时间与身份排序，以及请求指定的数量限制。 FTS 身份直接复用目录 rowid；候选正文和附件从原规范来源渲染后执行字面匹配核验。

逐项接受的 main part 保留原 observation 序号、消息身份和 ordinal，旧边界不会被后来事实改写。目录与 FTS 元数据不参与正文 LRU，独立于已有 32 MiB 正文保留目标。复制身份变化或 Session purge 清理对应缓存，关闭 observation 连接会丢弃全部缓存；后续读取按所需规范边界重建，不再要求 writer 安装目录或维护启动。访问权限与材料回收始终由规范所有权和引用决定。

完整产物读取使用 `with_artifact`，选择 Session 或执行轮次范围。元数据与局部只读 BLOB reader 共享原 owner 的同一快照；同步回调拥有目标资源，读取句柄关闭后才释放快照，避免每块重新打开并读取整个 payload。独立 reader 持有快照；即使等待方消失，已受理工作仍保留原 owner。跨分区复制从冻结来源快照按固定大小的 BLOB 块流入一个目标事务，并校验摘要和幂等重试。调用方继续负责资源预算、摘要核验和取消策略。`read_artifact_chunk` 用于独立窗口，多次窗口调用不会保留顺序读取游标。

生成的工具图片与用户上传在模型重建、不可变复制及导出包传输中保留完整原始产物字节。payload 长度、摘要、规范冻结位置及历史复制映射继续作为权威依据。导出包按块传输产物，保留物理帧长度表示和停滞 I/O 清理，不另设整个导出包的内容配额。

历史、事件投递和资源分页保留后续项的字节打包目标；首个完整项即使元数据超出目标，也携带原始元数据与游标继续推进。历史正文仍按 UTF-8 字节窗口传输。`history_source` 只接收正文字节目标，并保留该单块的完整原始元数据，不再设置独立 JSON 信封配额。Session 范围与冻结来源边界仍为必要条件。

集成场景通过 `cargo test -p maka-event-log --test integration` 统一运行，可用 `archive::`、`sessions::` 等模块名筛选。跨进程租约测试单独放在 `--test root_lease`，避免创建子进程时短暂继承其他测试线程持有的文件租约。私有投影测试通过 `--lib` 运行。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)

启动恢复读取全部未决执行状态，不另设条数或字节配额，已完成历史仍不参与扫描。工具结果 payload 与冻结请求配置不设应用层存储大小上限，数据库迁移保留已有内容和配置引用。
