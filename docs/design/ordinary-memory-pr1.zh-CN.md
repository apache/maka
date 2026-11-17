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

# 普通会话记忆 PR1：范围隔离、用户管理与持久化

日期：2026-11-17。开发基线：官方 `rust-preview` 的 `1bdfb822ee7f745db001a33b6f2fe72550ef5c1e`。开发分支：`codex/ordinary-memory-pr1`。

本文记录本 PR 的代码行为、实现原因和验证边界。实施依据为 `docs/ordinary-memory-pr-plan-2026-11-15.zh-CN.md` 的 PR1；语义判定、Recall 集成、常驻注入、自动提取及管理界面分别属于后续 PR。

## 1. 实际交付

新增 Agent Host 服务方法 `changeMemory`、`memory`、`memories`、`memoryHistory`、`memorySource`、`memoryEvidence`。用户可以手动创建记忆、按 ID 更正、切换常驻管理标记、删除，以及明确重新保存已删除的条目。所有写入通过原 Root 数据库及 Host 操作事务完成，不创建独立 memory.sqlite。

这里的“常驻”仅指持久化的 `user_always` 管理状态。本 PR 不将内容放入模型上下文，也不实现 PR4 的聚合预算检查。调用方不能据此宣称记忆已随某个 Run 加载。

手动正文逐字保留，不经过模型改写。新建条目为 `user_recall`；更正自动条目会转为用户管理；取消常驻回到 `user_recall`。对常驻条目的更正保留其常驻标记。自动写入的业务入口尚未开放，调用方不能指定 `auto_recall` 或伪造自动提取来源。

## 2. 文件与职责

| 文件 | 修改及目的 |
| --- | --- |
| `plugins/agent/facts/src/memory.rs` | 定义 MemoryId、MemoryRevision、管理方式、生命周期、断言元数据、用户操作及会话来源、证据和确定性修改结果。 |
| `plugins/agent/api/src/contract/memory.rs` | 定义范围选择、详情、分页、历史及修改请求；拒绝未知字段。 |
| `plugins/agent/api/src/contract.rs` | 注册真实 Agent 服务方法及 schema。 |
| `plugins/agent/state/migrations/0043_memory.sql` | 在原 Root 中建立条目、断言版本、范围版本和索引。42 已由 Root checkpoint repository 使用。 |
| `plugins/agent/state/migrations/0044_memory_metadata.sql`、`0045_memory_evidence.sql` | 增加断言元数据、独立证据关联及分页索引，并迁移已有用户操作来源。 |
| `plugins/agent/state/src/lib.rs` | 注册 migration；升级测试同时覆盖旧库缺少记忆表的情形。 |
| `plugins/agent/state/src/memory.rs` | 实现有界读取和事务修改，包含 CAS、来源、纠正关系、抑制索引与范围版本维护。 |
| `plugins/agent/native/src/owner/memory.rs` | 将真实调用身份、Host namespace、当前会话 workspace 及策略绑定到读写操作。 |
| `plugins/workspace/workspace-files/engine/src/workspace/project.rs` | 项目解析携带目录观察身份，供记忆入口核对解析结果仍属于已授权目录。 |
| `plugins/agent/native/src/service.rs` | 接通 Host 查询和 mutation completion，使用现有 journal/回执协议。 |
| `plugins/agent/native/src/owner/driver/tests/model_recovery/memory.rs` | 用真实 Host/client 验证并发、来源、删除、回执和重启。 |
| `products/maka/client/src/{lib,journal}.rs` | 将 changeMemory 接入既有设置操作恢复路由，使客户端重启后能找回未完成操作。 |
| `plugins/settings/native/src/preferences.rs`、`plugins/settings/store/src/policy.rs` | 通过已有设置 API 和配置 CAS 读写 MemoryPolicy。 |
| `packages/plugin-sdk/src/generated/` | 从 Rust schema 生成 TypeScript 消费契约，不手工维护第二份协议。 |

## 3. 数据结构与事务

### 3.1 条目与断言分离

`agent_memories` 的主键是 `(namespace, scope, id)`。条目保存当前操作版本 `revision`、当前正文版本 `assertion`、管理方式、状态及时间戳。正文置于 `agent_memory_versions`，由 `(namespace, scope, id, revision)` 定位。

区分操作版本和正文版本，是因为切换管理方式和删除都必须使旧窗口的 CAS 失效，但不能捏造新的正文证据。正文更正生成新断言；管理标记修改只递增条目版本，仍指向原断言。

断言保存原正文、用户操作来源、`corrects` 关系、精确匹配摘要及匹配用途。正文和来源不被后续编辑覆盖；用途可由 current 变为 corrected 或 suppressed。旧证据始终属于旧正文。直接手动输入来源为 `user_operation`，包含 Host 提供的 operation UUID 和观察时间，不声称存在聊天逐字引用。

每个新断言先关联一个真实用户操作来源。migration 44 增加不可变断言元数据及生成方式；migration 45 建立独立的证据关联表，并迁入已有用户操作来源。`memoryEvidence` 按正文版本和游标分页，不在详情中携带无界来源数组。

断言的 `metadata` 保存 kind、statement 和 temporal。没有用户输入时明确记为 unspecified；temporal 可表示未知、无时间限制或前闭后开的 Unix 毫秒区间，结束时间必须晚于开始时间。`generation=user_input` 表示正文来自用户输入，`corrects` 标明更正关系。这些数据随正文版本保留，不能用操作观察时间代替事实有效时间。

客户端先从公开 history 接口取得消息位置和原文，再调用 `memorySource`，由 Host 校验选中片段并解析 fact UUID 和全文指纹；不要求客户端读取数据库或猜测内部身份。该来源解析入口仅对管理身份开放。

`changeMemory.add_evidence` 指定预期操作版本及正文 assertion。会话引用包含 session ID、sequence、item index、原始 fact UUID、全文 SHA-256、UTF-8 字节区间和原文。Host 检查所属会话和项目范围；事务内重新核对来源绑定、真实消息身份、指纹及片段，并拒绝隐身来源。来源时间取真实消息时间，关联操作身份取 Host 回执。范围比较及事务提交复用同一份已捕获的目标和来源绑定，不在比较之后再次解析出不同的提交范围。

追加证据递增操作版本和范围版本，不改变正文版本、管理方式或排序时间。同一正文的相同引用幂等，不同事实可以引用同一来源。用户更正只给新正文关联新的用户操作来源，旧聊天证据仍绑定旧正文。普通证据分页过滤 suppressed 条目和版本，显式恢复也不暴露此前被抑制的证据。

引用校验证明原文真实，不等于自动证明语义蕴含。这里由用户明确关联证据；自动判定、冻结会话提取和关键词候选仍由后续 PR 实现。

新增表 `agent_memory_evidence` 的字段含义如下：

| 字段 | 作用 |
| --- | --- |
| `sequence` | 数据库分配的关联行 ID，用作稳定分页游标，不表示消息时间或事实优先级。 |
| `namespace / scope / id` | 定位所属 Host、Agent、范围及记忆条目。 |
| `assertion` | 引用不可变正文版本，与版本表构成外键，不能使用仅因切换常驻而递增的操作版本。 |
| `source` | 已验证来源的 JSON：用户操作，或含消息地址、指纹、原文定位、观察时间及关联操作身份的会话引用。 |
| `source_key` | 同一断言内的引用去重键。会话引用使用固定长度 SHA-256，避免把长原文重复放入唯一索引；不把本次关联 operation ID 当成来源身份，因此重复关联不会生成重复证据。 |

唯一约束限定在同一条目和正文版本内，不宣称语义唯一；分页索引以前四个定位字段及 sequence 排序。migration 44/45 通过原迁移账本执行，已有 43 版本数据库保留正文，以 unspecified 补入未知语义字段，并迁入原用户操作来源，不根据旧文本猜测事实时间。

### 3.2 提交顺序

1. Host 验证调用与 mutation 协议，提供不可由正文参数覆盖的操作身份。
2. native 确认是用户管理入口，解析范围。
3. `DataWriter.prepare_result` 提交待执行 statement。
4. Root 事务内再次验证项目绑定，检查条目 `expectedRevision` 和合法状态。
5. 同事务更新条目、断言、纠正/抑制匹配记录及范围 revision。
6. Host 在同一提交路径记录实际结果回执。

任何 SQL 失败都向上传播，不转换成成功或空库。返回 `conflict` 不执行写入；数据库错误通过原事务回滚。模型调用不在事务中，本 PR 本身不调用模型。

### 3.3 并发与幂等

除 create 外，每个动作必须携带预期版本。两个窗口同时使用版本 1 更正，只有一个提交版本 2，另一个收到实际版本的 conflict。范围计数每次成功修改递增，为 PR2 的候选读取/提交验证提供基础。

operationId 使用 Host RecoveryRef 中的 UUID，不新增调用方可任意指定的身份参数。重放和结果丢失恢复遵循原 Host journal，不重新生成记忆 ID 或重复运行已经提交的修改。

修改回执只含结果类型、ID 和版本，不含正文。读取内容需要重新调用当前可见性查询。这样，删除后恢复旧创建回执不会重新暴露正文，也不会复活条目。既往已返回的正文和 Host 原始请求记录不会被物理擦除。

## 4. 范围与权限

namespace 使用 Host deployment 与 Agent instance 的组合。个人范围使用固定 personal 标识；项目范围由该 Agent 拥有的真实 session 解析当前 workspace，再调用已有 `resolve_selected` 得到 `folder:<path>` 或 `git:<common directory>`。

调用方提交 session ID，而不是自行提供数据库 scope 字符串。Git worktrees 的根目录沿用 common directory 身份；显式选择子目录保留 folder 身份，不扩展为整个仓库。目录搬迁不会自动迁移旧记录。

项目读写捕获当前 PermissionBasis，数据库操作再次检查对应会话的有效 workspace binding 和权限 epoch。会话归档、撤销或重新绑定导致校验失败，不继续使用旧 scope。项目解析同时保留目录观察身份，并与授权时的路径和目录身份比较；两次操作之间替换目录或将路径改为其他项目的符号链接会被拒绝，不把另一项目解析为本次 scope。

手动 mutation 和历史查询接受 Host Native 管理调用以及已通过 Host peer/method 授权的 Remote 客户端调用。模型、后台任务和浏览器 lease 不能把正文伪装成用户手动输入。此管理方法不注册为模型工具，Remote 客户端必须由部署者授予该管理方法能力。Host 原有方法能力授权仍然必须满足，身份检查不是替代授权系统。

模型读取首先检查真实 Run access、当前 `MemoryPolicy.enabled` 和 `agent_read_enabled`。只允许本地普通会话；有 parent 或受限 tools 的会话不因拥有服务访问能力而获得个人记忆读取权。项目查询只能选择调用者自己的 session。管理端不受模型读取开关影响，用户仍可纠错和删除。

`create.incognito` 在会话创建时确定并持久保存，不能通过 metadata 修改。派生会话继承隐身限制。记忆读取检查真实执行会话的配置；隐身执行不能读取记忆，也不能借用户管理入口写入记忆，隐身会话不能作为新增证据来源。Session DTO 暴露该状态。该字段约束记忆使用，不承诺物理删除聊天记录；后续自动提取、常驻投影和在途请求路径仍须接入同一边界。

设置服务的既有 `assistantPreferences`/`updateAssistantPreferences` 入口新增 memory 字段与 memory mutation，使用原配置 revision CAS 更新 `enabled` 和 `agentReadEnabled`；没有增加第二份记忆策略库。默认仍是 enabled=true、agentReadEnabled=false，不自动开启模型读取。

## 5. 删除、更正与显式恢复

删除将状态变为 suppressed，并移除 user_always 标记；该条目的已有断言全部转为受限匹配用途。普通列表、详情和历史方法均不返回被删除正文。

更正保留旧断言并通过 `corrects` 指向被更正版本。摘要只规范化 CRLF 和首尾空白，不删除否定、条件、数字或日期。摘要不是语义唯一键，不用于本 PR 的自动去重。

普通 correct 和 set_always 无法作用于 suppressed 条目。必须使用独立 restore 动作、正确版本及新的用户输入正文。恢复新增断言和来源，历史中原先 suppressed 的正文仍不被普通 history 返回。

PR1 不阻止用户通过新的 create 再次输入相同或同义正文，也不宣称防止模型换 ID 复活。受保护/删除记录参与关键词候选和语义判定属于 PR2；当前保留的数据为其提供确定性基础。

## 6. 接口示例

```json
{"scope":{"kind":"personal"},"edit":{"kind":"create","body":"技术讨论默认使用中文。"}}
```

`changeMemory` 返回：

```json
{"kind":"saved","id":"<memory UUID>","revision":1}
```

更正请求：

```json
{"scope":{"kind":"personal"},"edit":{"kind":"correct","id":"<memory UUID>","expectedRevision":1,"body":"工作邮件使用英文，技术讨论使用中文。"}}
```

删除使用 `kind: "delete"`；显式恢复使用 `kind: "restore"` 并提供 body；切换管理方式使用 `kind: "set_always"` 和布尔 always。三者均要求 ID 和 expectedRevision。

`memories` 使用 scope、可选 after 和 limit；`memory` 使用 scope 和 id；`memoryHistory` 额外接受正文版本 after 和 limit。项目 scope 为 `{"kind":"project","sessionId":"<owned session>"}`。

## 7. 成本、索引与维护

正文上限为 16 KiB UTF-8；分页为 1–100 条，内部多取一条判断是否有下一页。列表使用 `(namespace,scope,state,id)` 索引和稳定 ID 游标，JOIN 当前断言一次取回一页，不使用 OFFSET 或逐条读取正文。

历史按单个条目和版本游标读取。正文匹配摘要索引同时保留有效、纠正和删除记录。删除成本与该条目的历史版本数相关，不扫描其他条目；抑制记录没有 TTL，不静默丢弃。

本 PR 没有规模压测结果，也没有语义召回率、误合并率或成本优化结论。使用索引的确定性测试不能替代后续真实数据量验收。

## 8. 验证与范围限制

测试复用既有 agent native/state、client 和 contracts 套件与 CI 路由；没有新增测试执行器或后台调度器。

| 验证 | 结果 |
| --- | --- |
| facts / API / state / client 的完整库测试 | 53 项通过（32 / 2 / 14 / 5），包含已有数据升级、回滚、证据语义及客户端 pending operation 恢复。 |
| `cargo nextest run --offline -p maka-agent-native --lib --no-fail-fast -j 2` | 105 项运行，104 项通过，1 项 preset 用例因通道中断失败；该用例随后单独连续复跑两次通过。 |
| 最终 memory / project_scope 专项回归 | 5 项通过，包含隐身 fork 及最终捕获绑定；其中 1 项为过滤器同时命中的既有 inventory 用例。 |
| `cargo check --offline -p maka-app-client -p maka-cli -p maka-workbench --tests -j 1` | 通过。 |
| `node packages/plugin-sdk/scripts/generate.mjs check` 与 SDK / product bundle TypeScript | 5 个生成文件一致，两个 TypeScript 检查通过。 |
| `cargo fmt --all -- --check`、差异空白检查 | 通过。 |
| 暂存新增文件 ASF 许可证头 | 通过。 |

测试使用项目既有 nextest 入口，并允许真实 Host fixture 所需的本地 IPC/socket。早期直接从仓库根目录运行 native 二进制导致产品 fixture 相对路径错误；正式回归改用 nextest 提供正确 crate 工作目录。原测试 fixture 随机捕获第二个 Agent 的问题已改为按主实例身份捕获，再重新验证。

完整 native 首轮失败的用例为 `preset_execution_uses_durable_role_and_explicit_model_selection`，错误为 `Application channel ended before a complete frame`；两个独立 nextest 复跑均通过，未修改该用例或放宽超时。首次中断原因尚未定位，不能把整轮结果写成 105/105 通过。

没有运行全仓 `just check` 或所有 CI 分片，也没有完成大规模性能、后续自动提取或上下文撤销路径的验收。这里的通过结论仅针对明确列出的检查。

后续 PR 仍需完成：自动写入权限、语义去重和冲突、跨条目关系抑制、Recall 过滤、常驻预算与冻结投影、发送前撤销、旧数据显式导入、增量提取和管理界面。PR1 的枚举不代表上述自动行为已实现。

## 9. 审计后补齐工作

2026-11-17 补齐逐版本证据、断言元数据和会话隐身边界；以下逐项对应审计确认的缺口。

| 审计缺口 | 本轮实现和验收路径 |
| --- | --- |
| 来源与证据 | 新增 migration 45、`memorySource` 和逐 assertion 的 `memoryEvidence`；真实 Host 从 history 原文开始关联，拒绝伪造片段及隐身来源。状态测试覆盖幂等、跨事实复用、更正隔离和删除过滤。 |
| 断言元数据 | migration 44 保存 kind、statement、temporal 和 generation；创建/更正/恢复及 SDK 接通，验证版本保留和非法有效区间拒绝。 |
| Incognito | 创建时持久化、派生继承，实际 Agent Run 读取和来源入口执行限制；额外验证 fork 保留隐身状态。 |
| 原操作恢复 | 重开 Host/client 后通过真实 `receipts.read` 多次读取同一操作；ID/版本一致，删除正文不会因旧回执重新暴露。 |
| 读取权限 | 用真实 Run 的 Agent 身份分别检查两个开关、正常读取、越会话拒绝和用户写通道拒绝。管理端仍可在禁用时操作。 |
| 真实范围隔离 | 双 Host、双 Agent、共同 Git worktree、显式子目录，以及授权绑定变更后旧提交失败。 |
| 其余行为 | active 内容跨重启、恢复不暴露旧 suppressed 历史、常驻更正保持模式、列表/历史/证据游标翻页，以及已有 43 版本数据库升级。 |


最终执行结果见第 8 节。
