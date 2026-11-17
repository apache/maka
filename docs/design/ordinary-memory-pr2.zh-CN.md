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

# 普通记忆 PR2：精确匹配阶段实现记录

日期：2026-11-17。基线：官方 `rust-preview` 的 `9ac917f17`（包含 PR1，#6970）。开发分支：`codex/ordinary-memory-pr2`。

**状态：本文记录的是 PR2 的部分实现，不代表八 PR 计划中的 PR2 已全部完成。** 尚缺语义候选检索、模型批量关系判断、自动提取写入、相关范围版本复核和完整验收。本文不将哈希匹配描述为语义去重。

## 1. 本次实际解决的问题

PR1 已保存断言哈希、历史版本、删除状态及证据，但 `changeMemory` 的 `create` 操作仍每次分配新 ID。重复保存会形成多条有效记忆；删除或更正后的旧正文也能通过新 ID 回流。

本次把精确检查接入现有用户管理写事务：相同 namespace、scope、正文规范化摘要和 metadata 的有效断言复用原 ID、追加用户操作证据；匹配删除或纠正的旧断言时返回不带正文的 `suppressed`。

## 2. 文件与职责

| 文件 | 改动及目的 |
| --- | --- |
| `plugins/agent/facts/src/memory.rs` | 新增 `evidence_added` 与 `suppressed` 结果，区分重复确认和受限匹配拒绝 |
| `plugins/agent/state/src/memory/matching.rs` | 集中安全摘要、受限记录优先检查、有效事实查找及增量补证 |
| `plugins/agent/state/src/memory.rs` | 在 Create 的输入验证之后、插入之前调用精确匹配；将补证结果标记为有写入；复用相同摘要算法；增加行为测试 |
| `plugins/agent/native/src/owner/driver/tests/model_recovery/memory.rs` | 在现有 Host 集成测试中验证真实 changeMemory 入口、重复回执、删除后拦截及重启后拦截 |
| `packages/plugin-sdk/src/` 下生成声明 | 由 Rust schema 重新生成，向 TypeScript 消费者暴露新增结果分支 |

另修复最新基线的编译遗漏：`owner/session_tools.rs` 在构造 `Create` 时补充 `incognito: false`。最终配置仍通过创建公共路径的 `input.incognito || policy.incognito` 继承调用方隐身策略，不开放模型关闭该策略的字段。

不增加数据库文件、迁移、模型调用或后台任务。本次使用 PR1 已有表与索引。

## 3. 算法与事务原理

### 3.1 安全规范化

仅将 CRLF 转为 LF，去除正文首尾空白，然后计算 SHA-256。保留内部空白、大小写、标点、否定词、数量、条件和日期。与 PR1 摘要算法一致，因此已有记录无需重建摘要。

哈希仅筛选候选。查询仍限定 namespace 和 scope，并比较 metadata，其中包含 kind、statement 和 temporal。相同正文处于不同时间区间或不同项目时独立保存。当前 metadata 均由 Rust 同一结构序列化；SQL 使用 JSON 紧凑表示比较，不对外部任意 JSON 对象提供键顺序归一化。

### 3.2 先查询受限断言

使用 `agent_memory_matching(namespace,scope,digest,disposition)` 索引查询 corrected/suppressed 版本，通过 EXISTS 返回布尔结果，不加载全部历史正文，也不与普通 Top-K 竞争。命中后直接返回 `suppressed`，不分配有效新条目，不返回匹配正文或历史 ID。

显式 Restore 会让同一条目的当前断言重新 active。如果该条目当前正文和 metadata 与旧受限版本一致，旧版本不会反过来阻止该已恢复断言的重复确认。其他旧正文仍维持抑制；这不是清空整个主题的抑制历史。

### 3.3 复用有效断言与追加证据

受限检查未命中时，通过相同索引及当前断言连接查找有效事实。多个历史遗留重复项存在时按 ID 稳定选择一个；本次不宣称已经迁移合并历史重复记录。

命中后向当前 assertion 追加 `UserOperation` 证据。source_key 使用操作 UUID，相同重复确认操作再次执行不会重复追加。新证据增加条目 revision 与 scope revision，但不改变 assertion、正文、有效时间或 modified_at，因此不会借补证改变优先次序。

用户明确保存已有自动事实时，mode 从 auto_recall 升为 user_recall；user_recall 和 user_always 保持原样。此权限来自现有 Native/Remote 用户管理入口，模型不能通过结果字段获得该权限。

### 3.4 原子性与回执

匹配和写入都运行在现有 `UserChange` Statement 内，沿用 RootStore 的写入序列与 Host operation 回执事务。两个精确 Create 不在事务外分别判断“无候选”，避免两个同时创建不同 ID。返回 `evidence_added` 时 Statement 的 changed 为 true，使证据和 revision 更新被持久化。

本次没有事务外模型调用，所以尚未实现计划要求的“读取 scope revision → 模型判断 → 提交时复核 → 有限重试”。未来语义实现必须增加该边界，不能据此扩展为持锁调用模型。

## 4. API 行为

| 输入及状态 | 返回 | 数据变化 |
| --- | --- | --- |
| 无精确匹配的 Create | 原有 saved | 新条目与初始证据 |
| 有效断言精确匹配 | evidence_added，原 ID、新 revision | 增量用户证据；必要时确认自动事实 |
| 已删除或已纠正旧断言精确匹配 | suppressed | 无新增有效事实；不泄露正文 |
| 同正文不同 scope/time/kind/statement | 原有 saved | 独立事实 |
| 明确 Restore 后再次保存相同正文 | evidence_added | 复用明确恢复的断言 |

原有按 ID Correct、Restore、SetAlways、Delete、AddEvidence 的契约继续存在。**Correct/Restore 尚未统一接入跨条目匹配，因此不能声称所有写入口都已经防止换 ID 回流。**

## 5. 验证与限制

新增存储测试覆盖换行/首尾空白规范化、ID 复用、证据增长、常驻保持、排序时间不变、不同 scope/time、否定和大小写区别、删除和纠正抑制、显式恢复、自动事实用户确认、重复操作幂等，以及 EXPLAIN QUERY PLAN 使用匹配索引。真实 Host 测试扩展覆盖端到端结果和重启持久性。

执行结果以本文末尾的验证记录为准。没有调用真实模型，也没有语义质量、延迟分位数或大规模数据性能报告。

## 6. 距离完整 PR2 的剩余工作

1. 给普通、受保护、受限候选分别设置数量及 token 预算，建立中英文关键词/实体/别名候选检索；不能以全库模型遍历替代。
2. 用一次有界语义调用判断等价、兼容补充、明确替代、独立和未决冲突；校验目标、revision、引用与可信授权，失败不得直接创建。
3. 建立所有新增、编辑、导入及后续提取复用的提交计划；验证自动权限不能替代或恢复用户保护/删除记录。
4. 实现批次内部判重、不可变断言和关系保存、未决候选及完整结果分类。
5. 在模型调用前后检查相关 scope revision、目标版本、来源身份与当前授权，实施有限重查，覆盖删除/更正和并发插入竞争。
6. 完成计划列出的 Postgres 拼写变体、中英文改写、条件共存、旧来源晚到、保护项换 ID、受限候选预算和模型失败用例，报告语义误差。

本提交只能作为继续实现 PR2 的基础，不能作为完整 PR2 合并验收依据。

## 验证记录

- `cargo test -p maka-agent-state --lib --locked`：18 项通过。
- `npm run schema:generate -w @maka-agent/plugin-sdk`：成功，从 Rust schema 生成声明。
- `cargo test -p maka-agent-native --lib memory_management_cas_sources_deletion_and_restart --locked`：1 项通过，含并发创建与重启后的精确抑制。沙箱内夹具初始化曾被 EPERM 拦截，沙箱外重跑通过。
- `npm run typecheck -w @maka-agent/plugin-sdk`：通过。
- `npm run schema:check -w @maka-agent/plugin-sdk`：5 个声明文件一致。
- `node --test scripts/ci.test.mjs`：18 项通过；本地监听测试在沙箱外重跑通过。
- 修改 Rust 文件的 `rustfmt --check`、`git diff --check`：通过。
- 没有运行全仓库 `just check`，也没有执行完整 PR2 的语义验收。
