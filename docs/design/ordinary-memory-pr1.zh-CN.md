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

新增 Agent Host 服务方法 `changeMemory`、`memory`、`memories`、`memoryHistory`。用户可以手动创建记忆、按 ID 更正、切换常驻管理标记、删除，以及明确重新保存已删除的条目。所有写入通过原 Root 数据库及 Host 操作事务完成，不创建独立 memory.sqlite。

这里的“常驻”仅指持久化的 `user_always` 管理状态。本 PR 不将内容放入模型上下文，也不实现 PR4 的聚合预算检查。调用方不能据此宣称记忆已随某个 Run 加载。

手动正文逐字保留，不经过模型改写。新建条目为 `user_recall`；更正自动条目会转为用户管理；取消常驻回到 `user_recall`。对常驻条目的更正保留其常驻标记。自动写入的业务入口尚未开放，调用方不能指定 `auto_recall` 或伪造自动提取来源。

## 2. 文件与职责

| 文件 | 修改及目的 |
| --- | --- |
| `plugins/agent/facts/src/memory.rs` | 定义 MemoryId、MemoryRevision、管理方式、生命周期、记录、断言版本、用户操作来源及确定性修改结果。 |
| `plugins/agent/api/src/contract/memory.rs` | 定义范围选择、详情、分页、历史及修改请求；拒绝未知字段。 |
| `plugins/agent/api/src/contract.rs` | 注册真实 Agent 服务方法及 schema。 |
| `plugins/agent/state/migrations/0043_memory.sql` | 在原 Root 中建立条目、断言版本、范围版本和索引。42 已由 Root checkpoint repository 使用。 |
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

本 PR 每个新断言只有一个真实用户操作来源。没有实现自动补证、聊天引用验证、关键词候选、时间关系裁决或语义合并；后续扩展不能将此单来源字段当成无限证据数组。

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

当前基线没有可接入的隐身会话字段。本 PR 不新增一个无法贯穿 Run 生命周期的影子开关，也不宣称已实现隐身运行语义。新增隐身入口时必须同时约束读取、写入和在途请求。

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
| `cargo check --offline -p maka-agent-native --tests`、`cargo fmt --all -- --check` | 通过。 |
| `cargo test --offline -p maka-agent-state --lib` | 11 项通过，包括迁移新建/升级/重开、事务回滚、范围隔离和索引分页。 |
| native `memory_management_cas_sources_deletion_and_restart` | 真实 Host 验收通过：同项目跨会话、子目录隔离、配置 CAS、禁用模型读取后继续管理、双窗口更正、来源版本、常驻切换、删除、旧回执及重启恢复。 |
| native `project_scope_rejects_directory_replacement_after_authorization`、`project_scope_rejects_redirection_after_authorization` | 通过：授权后的目录替换及符号链接重定向均拒绝解析为记忆范围。 |
| `cargo test --offline -p maka-app-client --lib pending_preset_settings_survive_reopen_and_fence_repeated_writes` | 通过，既有恢复测试扩展覆盖 changeMemory。 |
| `node packages/plugin-sdk/scripts/generate.mjs check` | 5 个 runtime declaration 文件一致性检查通过。 |
| SDK acceptance 与 product bundle TypeScript 检查 | 均通过。 |
| 本次新增文件许可证头及 `git diff --check` | 通过。 |

native 测试首次因执行沙箱禁止本地 IPC/socket 而无法初始化 Rig；对同一已构建测试二进制放开该环境限制后，测试完整通过。全仓许可证扫描包含已有未跟踪的 apps、packages 和 perf-results 产物，出现与本次修改无关的分类/头部问题；本 PR 仅提交自身文件，未改写这些产物。

没有运行全仓 `just check`，没有宣称覆盖完整隐身生命周期或大规模性能验收。

后续 PR 仍需完成：多来源证据关联、自动写入权限、语义去重和冲突、跨条目关系抑制、Recall 过滤、常驻预算与冻结投影、发送前撤销、旧数据显式导入、增量提取和管理界面。PR1 的枚举不代表上述自动行为已实现。
