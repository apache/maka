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

# 普通记忆 PR2：统一写入判定实现说明

日期：2026-11-17。基线：官方 `rust-preview` 的 `9ac917f17`，其中已经合入 PR1（#6970）。开发分支：`codex/ordinary-memory-pr2`。

本文记录本分支实际实现，包括先前精确匹配提交及本次补齐的有界语义判定、批处理、权限控制、并发提交和验收。它替代先前仅记录精确匹配阶段的文档。数据库没有自然语言唯一约束，有限词法检索和模型判断仍有误差；第 9 节明确区分确定性测试与语义质量证据。

## 1. 问题与结果

PR1 每次 Create 都可能生成新 ID，删除和更正历史虽然保留，却未参与完整写入判断。先前提交只解决相同正文的重复和抑制，无法处理同义改写、批次内部重复或模型判断期间发生的删除。

现在 `changeMemory` 和新 `reconcileMemories` 都通过同一解析与提交流程。语义等价内容复用当前断言并追加证据；明确且较新的自动偏好变化可生成新版本；与用户保护条目冲突的候选保存为 unresolved；删除和纠正历史参与匹配。判断期间范围变化会重新读取、至多重判一次，最后提交仍检查范围版本。

这次不提前实现 PR3 的 Recall 读取链路、PR4 的常驻投影和旧文件导入器、PR5 的自然语言授权解析与冻结会话提取器，以及 PR6/7 的自动触发器。它们可以消费本次批量写入服务；没有增加第二套调度器。

## 2. 改动地图

| 位置 | 实际修改 | 目的 |
| --- | --- | --- |
| `plugins/agent/facts/src/memory.rs` | 批量输入、批量回执、created/revised/unresolved/retryable 等结果，以及 extraction 生成方式 | 让调用方区分实际保存、补证、抑制、未决和重试 |
| `plugins/agent/api/src/contract{,/memory}.rs` | `reconcileMemories`、`pendingMemories`、可选 resolution 上下文 | 提供真实 Host 管理接口，不依赖尚未开发的 UI |
| `plugins/agent/state/src/memory/resolution.rs` | 候选快照、批内关系矩阵、来源核验、统一提交、版本检查和回归测试 | 集中写入权限、去重、抑制及原子性 |
| `plugins/agent/state/src/memory/matching.rs` | PR2 第一阶段的安全摘要与精确匹配 | 保留与 PR1 一致的哈希语义，并让已知精确抑制不受 Top-K 影响 |
| `plugins/agent/state/src/memory.rs` | 原始 UserChange 限于 crate 内使用；未决条目分页；管理端可读取未决条目的证据和历史 | 防止 Native 接口绕开统一计划，并让待处理结果可检查 |
| `plugins/agent/state/migrations/0046_memory_resolution.sql`、`state/src/lib.rs` | FTS5 trigram 派生索引、关系表、生成方式字段、迁移注册与升级测试 | 保留旧断言并以索引检索候选，支持历史数据升级 |
| `plugins/agent/native/src/owner/memory.rs` | 可信管理入口、来源项目检查、模型上下文、有限重查及最终 Statement | 将实际 Host 调用接到统一流程 |
| `plugins/agent/native/src/owner/recap.rs` | 复用辅助模型资源、取消、清理、定价与用量记录，区分 Recap/Memory 用途 | 避免另建裸 HTTP 调用或绕过现有资源结算 |
| `plugins/agent/native/src/owner/memory/resolution-prompt.md` | 严格 JSON 关系矩阵提示词 | 分类等价、补充、替代、独立和冲突，输入正文始终作为数据 |
| `plugins/agent/native/src/service.rs` | 路由新查询和 mutation，传入 Host operation scope | 沿用原有操作身份与回执事务 |
| `products/maka/client/src/{lib,journal}.rs` | 批量写入归入设置操作的 admission、持久回执和恢复过滤 | 客户端重启后仍能找到待处理操作 |
| `packages/plugin-sdk/src/` 生成声明 | 从 Rust schema 重新生成 | TypeScript 消费者获得实际 API 和结果枚举 |
| `scripts/ci.test.mjs` | 验证提示词变化选中 Native 和产品传递消费者 | 嵌入文本必须触发产品测试，而非被当作纯文档 |

还保留第一阶段修复：`SessionCreate` 构造 Create 时补上 `incognito: false`。公共创建路径仍用 `input.incognito || policy.incognito` 继承调用方隐身状态；这不是允许模型关闭隐身。

## 3. API 与授权

### 3.1 管理与自动候选分开

两个写入 API 都要求 Native/Remote 管理身份。Agent 身份不能通过它们伪装用户，输入也没有 `actor=user` 这种可升级字段。

`MemoryWrite` 包含 `edit` 和可选 `evidence`：

- 无 evidence：可信管理端直接输入，使用真实 Host operation 作为用户来源。
- 有 evidence：只允许 Create，按自动提取权限处理。引用需要匹配原会话、事实 ID、消息指纹和 UTF-8 字节范围；来源不能隐身，项目来源不能跨写入项目。
- 自动候选不能直接调用 Correct/Restore/SetAlways/Delete。自动替代只允许修改 auto_recall，用户条目和受限历史的冲突进入 unresolved。
- 已有自动事实被用户明确保存时可升级 user_recall；自动补证不会降权，也不会修改用户正文、时间或排序时间。

这些接口是可信 Host 管理/提取服务入口，不把模型提供的原文引用直接当作“用户已经授权长期修改”的证明。自然语言授权解析仍属于 PR5。

### 3.2 批量保存示例

```json
{
  "scope": { "kind": "personal" },
  "writes": [
    { "edit": { "kind": "create", "body": "项目数据库使用 PostgreSQL" } },
    { "edit": { "kind": "create", "body": "项目数据库采用 Postgres" } }
  ],
  "resolution": {
    "sessionId": "用于辅助模型调用的普通会话 ID",
    "model": { "connectionId": "已配置连接 ID", "modelId": "模型 ID" }
  }
}
```

调用 `reconcileMemories`。模型上下文明确选择已有连接和非隐身会话；辅助调用沿用会话可接纳条件。需要语义比较却没有 resolution 时返回 retryable，不能静默创建。

批量回执保留每项 created、evidence_added、revised、suppressed、unresolved 等结果。旧 `changeMemory` 继续以 saved 表示单项新建/修订，补证、抑制和重试有独立结果；既有 NotFound、Conflict 和 InvalidState 行为保留。`pendingMemories` 是仅管理端可用的 keyset 分页查询，正常 memories/memory 仍不提供未决正文。

## 4. 候选检索与语义判断

正文仅统一 CRLF/LF 和首尾空白后做 SHA-256，不删除否定词、条件、数量、大小写或有效时间。范围、kind、statement、temporal 仍独立核验。明确不重叠的时间区间可以确定为独立；其他 metadata 差异不被自动解释成允许绕过抑制。

迁移为已有版本及后续确认的同义表述建立匹配记录和 FTS5 trigram 派生索引，并用插入/删除触发器维护。匹配正文绑定原断言版本，等价补证保留新表述，删除或纠正后沿同一断言状态执行抑制；明确恢复相同事实时，沿断言版本的已确认等价关系继承匹配记录，并保存只对恢复事实有效的授权关系；关联旧条目仍保持抑制，不自动激活纯冲突后代。若另一有效身份已承载该事实，按 ID 的恢复仍进入未决。语义抑制也保留已确认匹配及其受限断言身份，使批内后续关系和后续重试继续受抑制；这不会将受限正文作为新事实的支持证据。查询从精确摘要索引、范围限定的全文索引以及当前 user_always 条目取得候选身份，再读取需要的断言；不会把全部历史正文加载到应用层。正文版本不可变，状态变化直接读取事实表，不要求重新写全文正文。

普通自动事实、用户保护/未决事实、删除/纠正历史分别取候选，避免普通项挤掉受限项。整个批次先读取各项的精确命中，再填充词法候选，后续项的精确匹配不会被前一项耗尽的预算挤掉。候选按断言去重时保留每项输入的精确命中关系，因此同批次重复提交多个已确认别名仍可确定性补证，不要求再次调用模型。已知精确受限命中另外通过索引限一条检查，不依赖候选 Top-K。常驻条目也参加候选判断。

候选查询由匹配记录驱动连接：精确查询使用摘要索引，词法查询按检索结果中的 rowid 读取，避免 SQLite 先扫描整个范围或某个状态的记忆再过滤。提交阶段的精确去重和抑制查询同样从摘要命中开始。回归测试直接执行生产查询，在三类候选的精确命中、词法命中和零命中情形下，将记录数从 100 增至 10,000，检查返回结果及数据库执行步数。宽泛词法命中、常驻项和相关恢复历史仍有各自的读取成本，不以最终候选数量上限宣称查询恒定成本。

模型返回完整关系矩阵：第 i 个输入与全部存储候选及前 i 个输入逐对分类。矩阵长度、枚举、额外字段及替代引用均校验；模型无法指定快照之外的目标。提交使用快照中实际 ID、记录 revision 和 assertion，不采信模型自报权限或版本。

## 5. 写入规则和证据

- 等价：复用当前 ID/assertion，增量追加证据。证据 key 绑定用户 operation 或不可变会话引用，重复证据不反复增加版本。受保护模式和 modified_at 保持不变。
- 独立/兼容补充：保留新断言及条件，不因主题相近删除旧事实。
- 明确替代：只允许自动条目、晚于当前断言全部已验证证据的来源观察时间和兼容的事实时间，并要求模型返回可在已验证证据中定位的明确替代片段。没有片段、越权或歧义目标不会覆盖。
- 按 ID 编辑若与另一个 ID 等价，保存未决候选并关联两个目标，保留原条目的 ID、正文和常驻状态，不擅自退休或合并另一个受保护身份。
- 用户按 ID 修改：使用用户输入作为新版本来源，旧正文和旧证据仍属于旧 assertion。不会把旧聊天证据挂到用户的新正文下。
- 冲突：保存 unresolved 新候选和目标关系，正常读取不可见；其来源和历史可以通过管理端检查。重复的未决断言可复用并补证。
- 抑制：等价于受限历史时不产生新有效事实，返回无正文的 suppressed。用户恢复必须明确使用 Restore；普通再次提及不会解除删除。

未决候选同时保留已确认的等价和冲突目标。关系两端绑定断言版本，删除沿已确认关系递归抑制相关版本；仅当条目当前断言属于该集合时才停用该条目，保留用户后来更正的独立事实，同时继续处理旧版本关联的未决后代。关系索引避免扫描全库关系。显式恢复的成本随相关等价分量的历史和别名增长，不承诺固定常数。它不承诺找到从未召回和确认的全部同义项，也不物理擦除原聊天。

## 6. 事务、并发与恢复

Inspect 在同一查询中读取候选与 scope revision。模型调用在数据库事务外，不持有范围锁跨网络等待。模型返回后再次读取范围；变化时重新检索，整个操作最多两次判断。

最终 Commit 再次检查 scope revision、目标 revision、来源引用和项目绑定。提交前统一检查调用方 CAS；后续按 ID 编辑承接同一事务内前序写入产生的新 revision，仍保留请求的 assertion 与状态检查；批次写入在 savepoint 内执行，任何无效关系或写入失败都会回滚。批内后续项按原断言身份重新读取状态、保护方式和最新证据时间，不能沿用前序项已改变的权限；重复未决项复用身份并补充证据和关系。矩阵中的替代目标按 ID/断言去重；精确命中当前版本后，不让同 ID 已被替代版本的旧关系重新生成重复未决项。最新证据时间通过范围、条目和断言限定的排序索引读取，不扫描完整来源历史。新断言、证据、关系、状态、索引、scope revision 与 Host 操作回执沿用 RootStore 的提交边界。

两个会话同时认为“没有候选”时，只有一个旧快照可以提交；另一个得到 retryable，使用新操作身份重新判定。最终检查和提交之间不存在模型调用。

操作重放由 Host 的既有 operation 回执处理，已提交结果只含 ID/版本和状态，不保存可绕过删除过滤的正文。辅助模型工作继续使用原有资源票据和清理确认，不通过 timeout 直接遗弃后台请求。范围变化后的重判使用同一 Host operation 下独立的辅助尝试身份，两次调用分别计量；首次尝试省略新增编号，保留既有账本来源身份。

当前自动断言的合法替代不会被同 ID 的历史冲突阻挡，因此连续多次明确偏好变化可保持原条目身份；等价于受限旧内容的候选仍优先抑制，其他 ID 的冲突和用户保护仍然有效。已删除别名的批次确定性判断保留各输入的精确命中，即使同时召回其他词法候选也不要求模型调用。

## 7. 固定成本边界

| 资源 | 上限 |
| --- | --- |
| 每批写入 | 4 项 |
| 每项正文 | 8,192 UTF-8 字节 |
| 每项会话证据 quote | 16,384 UTF-8 字节 |
| 查询 trigram | 每项最多 48 个 |
| 每类候选 | 8 个，三类独立 |
| 每类候选正文 | 8,192 字节；超限拒绝，不截断受限正文 |
| 序列化语义输入 | 40,000 字节 |
| 语义输出 | 最多 8,192 token，且受所选模型输出上限约束；文本最多 65,536 字节 |
| 单次模型等待 | 45 秒，随后取消并确认清理 |
| 范围变化重判 | 最多一次，即总共至多两次模型调用 |

字节边界是可确定执行的保守输入约束，不是精确 tokenizer 计量。模型实际用量和费用由现有辅助调用账本记录。索引和抑制历史随数据增长；本次不引入 TTL 丢弃或宣称恒定磁盘占用。

## 8. 升级与可维护性

0046 在已有版本上建立索引并增加 method 字段；已有记录默认 user_input，新提取断言写 extraction。旧 generation 列的约束保留在历史迁移中，新读取使用 method，避免修改已发布迁移或重建证据外键图。

迁移测试覆盖全新数据库、从旧迁移集合升级及重新打开。PR1 的逐版本证据测试继续运行。新 API 的客户端回执路由和生成 SDK 同步更新；嵌入提示词通过 Cargo 包所有权到 Native、再到产品依赖，CI 路由测试验证这一传递关系。

## 9. 验证、测量与语义边界

存储测试覆盖规范化、scope/time 区分、证据去重、保护模式、删除和纠正抑制、批内同义项、并发插入/删除后的旧快照拒绝、非法矩阵、跨时间错误合并、引用伪造、无引用替代、旧来源晚到、未决查询和来源，以及受限候选独立预算。

真实 Host 验收使用本地 provider 协议夹具走完整辅助调用、operation、写入和重启路径；验证 Postgres/PostgreSQL 复用、非法模型响应不写入、删除后改写抑制、Agent 身份不能通过单项或批量 API 冒充用户。并发测试在首次模型响应前完成删除，验证第二次请求读取受限快照、最终抑制，以及同一操作下两次独立的成功用量记录。夹具给出可控关系结果，用来验证产品接线和权限，**不是生产模型语义质量评测**。

固定词法检索样例为 6 组，命中 5 组、漏召回 1 组：Postgres 拼写变体、中文词片段、英文邮件条件、否定变化和 Python 关键词可被召回；`I live in Beijing` → `我的常住城市是北京` 没有共享片段，未召回。一次并行开发环境运行报告 lookup p50 23,350µs、p95 128,278µs，仅是六次查询的冒烟测量，不是规模性能承诺。

生产模型的误合并率和错误抑制率本次未测，不能报告为零。短于三个字符且没有其他共享片段的改写、跨语言无共享词、未提供别名及候选预算之外的断言仍可能漏召回。没有候选只表示本次有界检索没有命中，不能证明全库语义唯一。

最终执行记录见下面的验证清单。未执行全仓库 just check、跨平台 runner 或生产模型抽样，不据本地测试替代这些后续 CI/评测结果。

## 10. 最终验证清单

- `cargo test -p maka-agent-state --lib --locked`：44 项通过；Facts 库另有 36 项通过。
- `cargo test -p maka-agent-native --lib memory:: --locked`：4 项通过，含真实 Host 语义调用、权限拒绝、重启和跨 Host 隔离；需要沙箱外的本地监听权限。
- `cargo test -p maka-app-client --lib pending_preset_settings_survive_reopen_and_fence_repeated_writes --locked`：1 项通过。
- `node --test scripts/ci.test.mjs`：19 项通过。
- SDK schema 生成、5 个声明文件一致性检查、TypeScript 类型检查：通过。
- `cargo clippy -p maka-agent-state --lib --locked --no-deps -- -D warnings`：通过。
- 修改文件的 rustfmt 检查及 `git diff --check`：通过。
- 额外的严格 Native Clippy 未通过，报错位置在本次未修改的 driver、driver_cleanup、notifications、历史 projection 和 scheduler 等代码；没有通过放宽仓库 lint 配置来掩盖结果。包含依赖的 Clippy 还报告 provider-protocol 原有 struct update 告警。因此本次不宣称全仓严格 Clippy 通过。
