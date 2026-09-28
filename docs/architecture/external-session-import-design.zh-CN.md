---
doc_id: architecture.external-session-import-design
title: "外部会话导入设计"
language: zh-CN
source_language: zh-CN
counterpart: ./external-session-import-design.md
implementation_status: current
document_status: current
translation_status: synced
last_verified: 2026-09-16
owners:
  - maka-backend
---
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

[English](./external-session-import-design.md)

# 外部会话导入设计

## 范围和用户契约

TUI 和 Desktop 通过同一 Runtime Host catalog/import 路径选择并导入 Claude Code、Codex 或 OpenCode 的一个外部 Session。每次显式导入都创建一份新的原生 Maka Session 快照；成功时返回并打开准确的 Session，导入本身不调用模型。外部来源保持只读，Maka 后续对话不会写回来源，来源的后续变化也不会同步到已有副本。旧的 TUI scanner 和 digest handoff 不再是生产路径。

catalog 列出外部来源会话，Maka 任务列表列出已发布的原生 Session。一个刚导入的旧会话未必排在任务列表顶部，因为任务按对话活动时间排序。重复导入既不覆盖旧副本，也不合并历史；不同 Host/Profile 的来源和 Maka Session 空间互不共享，远程 Host 只读自己的来源文件。

## 非目标与取舍

不追踪来源更新或给已导入 Session 增量同步，不增加 freshness 状态机；不迁移旧 digest handoff 产生的普通 Session；不发布被截断的部分历史，也不把来源工具记录当作 Maka 当前运行时的执行事实。结果未知时不增加跨客户端的尝试 ID 或自动对账：用户可以查看已发布副本，也可以明确创建另一份独立副本。

## Authority 与接缝

| 义务 | 唯一 authority | 对外接缝 |
| --- | --- | --- |
| 来源格式、发现、筛选、分页、解码与转换 | 对应 Storage adapter | `listSessionPage(query)`、`readSession(id)` |
| 通用 query、sanitize、limit 契约 | Core external-session | 被 adapter 与 Host 共同使用的 contract |
| workspace 解析、导入并发、结果分类、暂存、发布与恢复 | Runtime Host external-session coordinator | `external-session.catalog.query`、`external-session.import` |
| 当前已发布副本数量与最近 Session ID | Storage Session authority | `lookupExternalSessionImports(adapterId, sourceSessionIds, limit)`，由 Host 投影为 `importState` |
| 已存历史的 provider 准入 | Runtime replay planner | `buildRuntimeEventModelReplayPlan`；continuation 单独准入 |
| Desktop 身份/导航与 TUI 导航 | Desktop preload/shell；TUI `MakaSessionDriver` | Host-scoped Session ID；`switchSession(sessionId)` |
| 请求警告、按钮和菜单 | Desktop 页面与 TUI runner | 只展示 Host 结果，不推断来源记录属于哪次请求 |

本 PR 把 TUI 与 Desktop 的外部会话导入统一到 Runtime Host：客户端只选择来源与会话；Host 负责查询、转换、落库和发布。导入完成后得到一份新的原生 Maka Session，导入过程本身不会调用模型。

本文描述当前实现，不记录中间方案。协议字段和数值上限以当前代码与测试为准。

## 运行链路

```text
TUI / Desktop 选择来源与外部 Session
  → Runtime Host 解析 workspace 与查询参数
  → Claude / Codex / OpenCode adapter 返回有界 catalog 页
  → 用户选择一项后，adapter 读取并转换完整 transcript
  → importer 校验存在可阅读对话
  → Session 以未发布状态暂存
  → Ledger 物化历史
  → Session 发布，客户端打开新 Session
```

- **catalog**：只读取用于选择的摘要，不读取完整会话。
- **import**：读取用户选中的一份完整会话并转成 Maka 消息。
- **published Session**：Ledger 已物化完成，可以出现在任务列表并打开的 Maka Session。

## 1 · 模块边界

- `packages/core/external-session` 定义跨来源 contract、query、来源 Session ID/标题/cwd 匹配、sanitize 和 limit 语义，不理解任何来源的文件格式。
- storage adapter 各自拥有 Claude、Codex、OpenCode 的发现、筛选、分页、解码和消息转换规则。
- Runtime Host 拥有 workspace 解析、wire 边界、导入并发、错误分类、暂存和发布。
- TUI 与 Desktop 只展示 catalog、提交选择、按稳定结果码更新交互，不解析来源数据或错误字符串。

这条边界保证来源格式只在一个 adapter 内变化，分页位置也由真正理解排序键的 adapter 决定。

## 2 · Claude catalog 的读取边界

Claude catalog 对每个候选最多读取：

```text
head = 256 KiB
tail = 256 KiB
```

catalog 与完整导入使用不同预算。head/tail 只提取列表所需的 id、cwd、标题和时间；窗口边缘的不完整 JSONL 记录不会被当作完整记录解析。

项目目录名不是 cwd 的可逆编码，例如 `-workspace-my-project` 无法可靠区分 `/workspace/my-project` 与 `/workspace/my/project`。因此实现不再从目录名猜 cwd，而是从有界 head 中提取完整的顶层 `cwd` JSON 字符串：

- 能读到完整 cwd：用真实 cwd 做 workspace 匹配。
- cwd 缺失、损坏或刚好被截断：在带 workspace 条件的查询中不返回该项。
- 不会用目录名猜测后继续匹配。

因此 scoped catalog 可能少显示一个无法确认归属的会话，但不会把别的项目会话错误归入当前 workspace。

## 3 · OpenCode 的导入边界

```text
OPENCODE_TRANSCRIPT_MAX_RAW_BYTES        = 64 MiB
OPENCODE_TRANSCRIPT_MAX_ROWS             = 250,000
OPENCODE_TRANSCRIPT_MAX_CONVERTED_BYTES  = 256 MiB
```

- raw bytes 限制数据库中本次要读取的编码字段总量，也拒绝单条异常大的数据。
- rows 限制解码后的源 message/part 数量。
- converted bytes 限制最终保留的 canonical Maka 消息总量。

任一上限超出都会在提交前拒绝整次导入；不会截掉旧内容，也不会只保留最新一段。三个数约束的是各阶段明确持有的数据，不是进程 RSS 的保证。

OpenCode catalog 只选择能确认 `parent_id` 为空的 root Session。明确是 child、类型不合法或无法确认的记录都 fail closed。catalog 与 `readSession` 共用严格 row decoder。

## 4 · 什么算“存在可导入的对话”

导入器和 Ledger 共用 `isConversationTextMessage`：

- user 消息算对话；
- assistant 只有非空文本才算对话；
- tool、note、token、turn-state 和 steering 投影不单独构成对话。

如果转换结果只有工具或运行元数据，导入会在创建暂存 Session 之前失败，不会发布一份看起来为空的任务。

Ledger 修复会把同一 turn 的记录一直归组到最后一条，即使不同 turn 交错、同一 turn 有多条状态记录也一样。它先分页找出各 turn 的最后序号，再以固定的 high-water 序号分页转换同一份 transcript；最终状态由最后一条状态记录决定。

## 5 · assistant-first 历史的保存与模型准入

来源 transcript 若确实以 assistant 开头，Maka Ledger 仍忠实保存这段历史。普通用户随后继续该 Session 时，provider-history 使用 durable `storedMessageId` provenance 识别 transcript repair 产生的 assistant 前缀，只在发给模型的副本中从第一个有效 user 边界开始投影。

因此：

- 用户在 Maka 中仍能看到完整原始历史；
- Anthropic 等要求 user-led history 的 provider 不会收到 `assistant, user` 开头的非法序列；
- native legacy 与 imported Session 使用同一条规则；
- 普通 tool/diagnostic 前缀不会被无条件删除。

## 6 · workspace scope

Runtime Host TUI 的 external-session surface 是 workspace scope 的唯一决策者：

- 当前 Session 有 workspace target：surface 提供 “当前 workspace / 全部” 两个选项，默认当前 workspace。
- 没有 workspace target：surface 只提供“全部”，界面不显示无效的 workspace 切换。
- 如果发起当前 workspace 查询时 target 已失效，surface 明确拒绝，不会省略 workspace 参数后静默查询全部。

TUI runner 只展示 surface 给出的选项并转发用户选择，不再读取 Session driver 自行推导 scope。这个 scope 仍与 Maka Session 列表的 Current/All 标签无关；后者只控制原生 Session 列表的展示范围。TUI runner 会在查询 Host 前短暂合并连续的搜索输入；每次输入都会立即推进同一个 request revision，并清除当前显示的 rows 与 cursor，因此新查询等待 debounce 时，旧的在途响应既不能回写 catalog，也不能继续旧分页。

## 7 · 分页由 adapter 拥有

所有来源在 Host 边界都实现同一个必需接口 `listSessionPage(query)`，Host 不再分支判断“adapter 有没有原生分页”。cursor 对 Host 和客户端始终是不透明字符串，其解码、查询绑定和继续位置由 adapter 负责：

- Codex 使用来源排序键的 keyset cursor。
- Claude 与 OpenCode 通过共享的 storage offset pager 把数字位置封装成绑定 `cwd/includeArchived/text` 查询的 opaque cursor。
- 格式错误、属于另一查询或已无法继续的 cursor 由 adapter 抛出 `ExternalSessionCatalogCursorError`，Host 统一返回 `invalid_request`；来源扫描超过有界候选数时，adapter 抛出 `ExternalSessionLimitError`，Host catalog 返回 `source_limit_exceeded`。

Host 请求最多 `page size + 1` 个来源项。adapter 为每个实际返回项携带其 `nextCursor`；Host 做 wire 校验或页字节预算截断后，以**最后实际交付项的来源 cursor**继续。被过滤的无效行和未交付项不会使下一页跳行。

## 8 · Codex 使用无服务端状态的 keyset cursor

Codex 不保存跨请求的 SQLite 事务、catalog snapshot、TTL 或 LRU 状态。cursor 是绑定当前 `cwd/includeArchived/text` 查询的 opaque keyset；换查询继续使用旧 cursor 会被拒绝。

两条来源路径分别使用自己的稳定排序键：

1. **state DB**：`(sort_key DESC, id DESC)`。`sort_key` 由查询算一次、随行一起选出，cursor 直接读回该行上的这个值 —— 这样 cursor 指向的位置必然就是查询排序的位置。adapter 中的唯一 normalizer 接受有限数值或数字字符串形式的 epoch 秒/毫秒，以及 ISO 8601 等可解析 date-time 字符串；SQLite 排序、cursor 位置和展示的摘要时间都调用同一条规则。首页只读最新的 `state_N.sqlite`；若该 generation 读不了，本页改由 filesystem fallback 回答，而**不是**退到更旧的 generation：更旧那本是上一次跃迁时冻结的快照，跃迁之后新建的会话都不在里面。cursor 记录起始 generation，续页仍只读打开同一个文件，通过 `WHERE` keyset 条件继续，并保持严格 —— 原 generation 已删除或不可读时 cursor 明确失效，读失败仍是 persistence failure。连接用完立即关闭。
2. **filesystem fallback**：`(mtime DESC, fixed-size path identity ASC)`。opaque cursor 使用版本化的 `f2` filesystem tag；identity 由相对 rollout path 一次派生，因此深层路径不会使 cursor 超过 Host wire 上限。一次遍历 active 和可选 archived roots，以 `maxCatalogCandidates` 限制遍历的文件数；超过上限返回 typed limit error。候选先用 stat 已知排序键与当前页尾比较，只有可能进入当前页的候选才读取有界 head 并完成 query/path 校验；内存最多保留 `limit + 1` 个匹配摘要，不物化整个 catalog，也不为深分页重复扫描多轮。

keyset 的语义是“继续读取严格排在最后交付项之后的记录”。如果一个尚未读取的 live Session 在两页之间更新并移动到 cursor 之前，本次遍历可能看不到它，但不会因此重复已经交付的行；重新打开或刷新 catalog 会看到当前最新顺序。这是实时可变来源下不持有 snapshot 的明确边界。

## 9 · Host wire 页边界

每个 catalog 字段在进入 wire 前都有上限，包含 source id、名称、cwd 和最近导入 Session id；不合法的 identity 会被丢弃，不会截断成另一个 id。

Host 同时限制每页项目数和编码后的 JSON 字节数。若下一项使页面超过字节预算，Host 返回当前页，并把 next cursor 留在最后实际交付项之后；下一页会从尚未交付的项继续。当前单行字段上限保证一行远小于页面预算，因此不会产生无法前进的空页。

`importedCount` 是仍存在且已发布的全部副本数；`importedSessionIds` 只带最近、wire-safe 的有限几个 id，用于快捷入口，不改变总数。

## 10 · 暂存、发布与恢复

导入在宣布持久化提交开始前，先完成 canonical 输入校验和确定性 catalog 投影。然后创建 `transcriptLedgerVersion: 0` 的暂存 Session。Ledger 物化完成后才升级为已发布状态，并出现在任务列表和 catalog 的副本统计中。

- 物化前失败：删除暂存 Session。
- Host 重启：`recover()` 继续处理版本 0 的 Session。每个 staged Session 独立恢复；若准备和删除都失败，该 Session 保持未发布，等待后续 Host 启动时再次恢复，不会阻断其他 staged Session 或 Host 启动。
- 只有已发布副本计入 `importedCount`。
- 同一来源的两个并发导入请求由 Host 合并到同一个 in-flight Promise；前一次结束后的再次显式导入会创建独立副本。

## 11 · unknown outcome 不猜归属；显式重试是新操作

`commit_outcome_unknown` 或已派发请求的传输中断表示本次结果无法确认。catalog 没有 operation-specific identity，所以客户端不能根据“副本数刚好多一个”推断哪个 Session 属于本次请求。Desktop Main 和 TUI 按同一结果语义处理；既不把 unknown 宣布为成功或失败，也不自动打开某个副本或自动重试。当前界面保留本次请求的警告，提示查看 Maka 任务列表；页面重新加载以 Host catalog 为准，不保留 unknown 锁。

用户可以明确再次点击导入，创建一项新的独立操作，即使上一项事实上已经成功，也可能产生第二份副本。Host 的 `isImporting` 是进行中请求的唯一重入约束：导入还在进行时，Desktop 单条/批量入口和 TUI 都不能再提交该来源；已经发布的副本仍可打开。Desktop 在行上分别提供“打开最近导入的任务”和“导入/再次导入”；TUI 对已有副本的来源显示“打开最近导入的任务 / 再次导入 / 取消”菜单。打开动作只使用 Host catalog 返回的最近 ID，不归因于 unknown 请求。外部 catalog 列出来源，Maka 任务列表列出已发布任务，两者不是同一列表。

## 12 · 稳定错误语义

adapter 负责产生结构化来源错误，Host 负责映射成公开结果，客户端只负责本地化：

- `source_limit_exceeded`：import 超过 transcript/record/converted-output 限制时携带结构化 limit kind 与 max；catalog 超过候选扫描上限时返回同一稳定错误码。
- `model_unavailable`：当前没有可用于新 Session 的模型配置。
- `source_unreadable`：来源数据库、记录或转换内容损坏/不可读。
- `commit_outcome_unknown`：进入持久化阶段后无法确认最终结果。

客户端不解析异常字符串猜测类别。unknown 不触发自动重试；用户明确再次导入时，会发起一项新的操作。catalog 超过来源候选扫描上限也返回 `source_limit_exceeded`，与非法 cursor 的 `invalid_request` 区分。

## 验证义务与边界

- Adapter 测试覆盖来源筛选、完整或拒绝、资源上限、cursor 继续位置和 Codex 两条 catalog 路径，包括「最新 generation 读不了时由 filesystem fallback 回答」与「排序值是 TEXT 时不会让后续页全部失联」；Host 与 Storage 测试覆盖 wire 截断、typed error、导入数量、并发合并、暂存发布及恢复。
- Runtime 测试覆盖 assistant-first 保存与所有 provider 投影的 user-led 准入；TUI 与 Desktop 测试覆盖搜索、scope、打开已有副本、显式重复导入、unknown、取消、批量统计和导航失败。
- 不承诺跨页读取实时可变来源时获得 snapshot，也不把 catalog 中的最近副本归因于结果未知的某次请求。未对打包后的 Desktop 或真实并发写入中的外部客户端做端到端验证。
