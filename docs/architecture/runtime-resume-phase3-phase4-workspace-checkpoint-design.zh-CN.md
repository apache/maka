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

# Runtime Resume Phase 3–4 实施路线

> 路线更新（2026-08-02）：workspace 主线已从“通用 checkpoint 抽象优先”切换为
> **Git-native managed workspace**。本文保留 Recovery/Continuation 已落地协议与旧路线的历史论证；
> 新实现不再以通用 per-file checkpoint、native manifest 或 CAS object store 为前置。
> 当前 M0 的 baseline-only 权威合同见
> [Workspace Version Authority v1](./runtime-workspace-version-authority-v1.zh-CN.md)。

- 状态：Implementation tracked
- 更新日期：2026-08-02
- 事实权威：immutable RuntimeEvents
- 主要平台：Linux、macOS；Windows 有限支持
- 拆分审计：`runtime-resume-extraction-ledger.zh-CN.md`

## 1. 四个正交平面

```text
operation plane     工具副作用是否已收敛
continuation plane  provider 将看到哪一段 immutable history
workspace plane     当前文件系统是否对应 history boundary
host plane          谁拥有 store、worker、恢复任务与关闭顺序
```

RuntimeEvent 是语义事实的唯一权威，但不能替代执行所有权的原子仲裁：

| 层级 | 权威 | 职责 |
|---|---|---|
| recovery semantics | immutable RuntimeEvents | call、dispatch、outcome、observation、decision |
| execution ownership | admission/claim CAS | 一个 source boundary 只能有一个执行者 |
| projection | SQLite tables | 可删除、可从事件重建 |
| workspace artifact | managed Git artifact owner（强模式） | 保存/验证 workspace 状态，不能单独授权 continuation |

## 2. Phase 3A：工具恢复

### PR A — Recovery persistence authority

不变量：

> 保留 recovery fact 只有一个 atomic writer；completed 必须引用匹配的成功 outcome；
> online/reopen/rebuild/Resolver 对同一 immutable ledger 得到同一解释。

关键实现：

1. tool facts 被划分为 call、dispatch、outcome、reconcile、decision 五条权威 lane；
2. 一个物理 RuntimeEvent 只能进入一条 lane；
3. generic writer 不能持久化 dispatch、operation-linked outcome 或 recovery fact；
4. T1 从真实 function call 重新计算 canonical args identity；
5. recovery bundle 在一个 SQLite transaction 中写 reconcile、可选 outcome、terminal decision；
6. completed 和 parked 都是 v1 terminal；parked 不存在第二次 attempt；
7. scanner 和 recovery interpreter 由 writer、rebuild、Resolver 共享；
8. `parked` 和 `recovery.hasCorruption` 是 resume 的硬闸门，不能依赖 diagnostic switch
   间接阻断；
9. generic、batch、T1、T2、recovery bundle writer 在事务内对全局 immutable ledger
   与 candidates 运行同一个 prospective transition validator；exact retry 也必须先过此闸门；
10. function call/response 只允许各自白名单内的 state delta；artifact、continuation marker、
    terminal status 或 branch 不能夹带进 tool authority lane；
11. strict args identity 明确处理 `__proto__` 并拒绝 sparse/accessor/custom array；
12. 唯一 canonical RuntimeEvent codec 负责 decode、normalization、strict JSON、稳定 bytes 与
    lossless round-trip；SQLite/JSONL、未来 prefix digest 均复用它；
13. JSONL immutable exact retry 物理去重，写前验证 Run header identity；
14. SQLite 强制一个 invocation 只对应一个 `(sessionId, runId, turnId)`；
15. journal ID 只由 store 派生；正式 schema 4 的无 dispatch legacy rows保守隔离。

PR A 首版的 prospective gate 是 workspace-wide semantic fail-stop：任何 session 中已存在的
canonical tool-ledger corruption 都会拒绝同一 SQLite workspace 后续所有 tool-bearing write。
这会扩大故障域并在写事务内产生全历史扫描成本，但它是明确的 correctness-first 选择。后续只能
用可从 immutable events 重建的增量 reducer 收缩到 candidate execution spine；不能用可变缓存
替代事实权威。

PR A 的证明矩阵包括：

- prepared、normal T2 success/error、permanent parked、recovered completion；
- 多 operation 交错；
- online、reopen、rebuild、Resolver 等价；
- recovery bundle 三个事务内部 SIGKILL 边界与 COMMIT 后 SIGKILL；
- exact bundle、completed-vs-parked、rebuild-vs-commit 多进程竞争。
- JSONL ordinary/tool exact retry、conflicting retry、path/header identity；
- nested undefined / `toJSON` 有损改写与 SQLite terminal canonical retry；
- invocation 跨 session/run/turn 漂移；
- corrupt immutable ledger 上 T1/T2/recovery exact retry 均 fail closed。

进程 crash harness 以 Linux/macOS 为发布证明平台；Windows 仍为有限支持，不能用其 skip
反向宣称跨平台 durability。

### PR B — Continuation correctness

不变量：

> continuation cursor 只来自 immutable RuntimeEvents；同一 source boundary 至多一个 durable
> claim；祖先与直接 source 使用同一 replay policy；只有 SQLite authority 新写入且标记为
> `runtime_admission` 的 continuation-start 才是 provider-call T1。`claim_repair` start 只是
> provider=0 的审计与收敛事实。

PR B 从已合并 PR A 的 `upstream/main@e4c6ddbf` 平铺实现，不迁移 #1346 的 continuation
代码块。当前实现分为 B1、B2 与 B2.1；B3 typed branch 继续 defer。

#### B1：immutable composite boundary

单个 Run 的 boundary 不是 `events.length`，而是：

```text
ImmutableRuntimePrefixV1
  identity = sessionId + invocationId + runId + turnId
  position = lastEventSeq + eventCount + lastEventId
  prefixDigest = sha256(domain || identity || eventSeq || canonicalEventBytes...)
```

约束如下：

1. store 只读取 `runtime_events` 物理行，不合并 `runtime_partial_snapshots`；
2. `event_seq` 必须从 1 连续增长，high-water 必须对应真实物理行；
3. 每行先经 PR A 的 lossless canonical RuntimeEvent codec 解码并重新编码，再参与 digest；
4. prefix 内任何 session/invocation/run/turn 漂移都会拒绝；
5. mutable partial snapshot 不能进入 prefix；
6. `runtimePrefixSegment()` 会从携带的 events 重建 position/digest，调用方不能伪造 prefix 对象。

多代 lineage 使用 oldest-to-source ordered manifest：

```text
RuntimeBoundaryCursorV1
  segments = [ancestor A, continuation B, immediate source C]
  manifestDigest = sha256(domain || canonical(segments))
```

相同 segment 的不同顺序会得到不同 manifest。lineage 最大 64 段；cycle、missing ancestor、
V2 edge prefix digest、edge manifest、child continuation-start 或对应 durable claim state 不一致
都会用稳定 reason park。每条历史 V2 edge 还必须由 claim row 交叉证明 claim id、target immutable
header、start event id、`start_kind` 与 provider replay identity；header/start 不能自我认证。

#### B1：唯一 provider replay projection

每个 segment 独立调用 `buildRuntimeEventModelReplayPlan()`；PR B 不复制 provider step 组合逻辑。
随后应用同一 suffix policy：

- 最近稳定边界只能是 user text 或 tool result；
- crash 时未完成的 assistant text/thinking/tool-call suffix 被裁掉；
- 某段完全没有 user/tool 稳定锚点时，该段所有 model-visible text/thinking/tool-call 都被
  裁掉，只保留 actions-only audit facts 与 terminal facts；
- live continuation-start 同时继承当前 T1 tool-boundary marker，因此 continuation 自己在
  dispatch T1 前崩溃的 function call 也能被证明为 definitely-not-dispatched 并作为 suffix 裁掉；
- unmatched call 后仍出现 provider-visible 内容属于 non-suffix gap，必须 park；
- tool recovery corruption/unsettled 状态先由 PR A Resolver 阻断；
- 每段先投影再拼接，祖先曾被裁掉的 suffix 不会在下一代 continuation 中重新出现。

composite replay 存在时，它是 tool-state 与 provider suffix 的唯一 gate；旧
`buildResumePlanFromRuntimeEvents()` 只服务无 composite boundary 的 legacy 路径，不能在外层
再次把已经安全裁掉的 `definitely_not_dispatched` call 判为 dangling。

`retryChildAgentWithExecution()` 同样通过 `RuntimeContinuationPlanner` 构造 immutable
composite boundary。旧 child 的 `retriedFromRunId/resumedFromRunId` 边从对应 immutable prefix
严格派生临时 V1 segment；新 child retry 持久化 V2 `continuationSource`。该路径不再使用
`readRuntimeEvents()`、`events.length` 或独立的 `buildResumePlanFromRuntimeEvents()` 组装
provider history。

最终同时冻结：

- `providerProjectionVersion = 1`；
- composite `providerReplayDigest`；
- segment boundary manifest。

未知 projection version 不能按“正整数即兼容”采信。

#### B2：SQLite durable claim authority

schema 6 增加 `runtime_continuation_claims` 与 capability
`runtime_continuation_authority@1`。claim v1 同时保存：

- canonical boundary JSON 与 manifest digest；
- immediate source execution identity、physical high-water、prefix digest；
- provider projection version 与 provider replay digest；
- fresh target session/invocation/run/turn；
- target Run 的完整、严格解码 `AgentRunHeader`（含 V2 continuation source）；
- claim id、claimed-at、protocol version；
- 可空、唯一的 continuation-start event id；
- 与 start 同生存期的 store-owned `start_kind`：`runtime_admission | claim_repair`。

数据库约束保证：

- 一个 boundary digest 只能有一个 claim；
- source boundary tuple 只能 claim 一次；
- target invocation/run/session+turn 不能复用；
- start event 只能绑定一个 claim。

`BEGIN IMMEDIATE` transaction 是唯一裁判。结果只有：

```text
acquired  -> 本执行拥有创建 target/provider T1 的资格
existing  -> exact boundary 已有 owner；只读分类，绝不再调用 provider
conflict  -> claim/target/source identity 被复用；fail closed
```

INSERT claim 前，事务内必须重读真实 RuntimeEvent ledger：

- ancestor segment 按其 pinned high-water 验证；
- immediate source 必须与数据库当前 latest immutable head 完全一致；
- immediate source 必须恰好包含一个 terminal RuntimeEvent，且 terminal 必须位于 immutable
  ledger 尾部；active/non-terminal source、重复 terminal 或 terminal 后缀均拒绝 claim；
- source 不存在、出现 H+1、identity/position/digest 漂移或 event-seq gap 均拒绝 claim；
- claim 成功后，该 immediate source ledger 被 seal，不能再追加新的 immutable event。

这条 terminal-tail gate 的 owner 是 `SqliteRuntimeStore`，不能只依赖上层 planner。它与 latest
boundary 重读、target ledger 为空检查和 claim INSERT 位于同一个 `BEGIN IMMEDIATE` 事务：
任一检查失败时整个事务回滚，不产生 claim、不 seal source，active Run 仍可提交自己的 terminal
事实。这样即使内部调用者绕过 planner，数据库也不能把尚在运行的 source 永久封死。

planner 只读 existing claim 并分类：

- claim + missing target Run/start：`continuation_claim_repair_required`；
- matching start + nonterminal target：`continuation_started_indeterminate`；
- terminal target：`continuation_already_exists`；
- terminal RuntimeEvent 与 header 未收敛：repair required。

existing claim 不能只凭 run id 或首条 event 的 claim id 分类。必须交叉验证完整 target Run
immutable header、V2 source、claim/boundary/provider replay identity、`start_event_id`、完整
continuation-start payload，以及 terminal fact 必须是 target invocation 的最后一条 immutable
event。普通 Run 复用 target id、start payload 被篡改、terminal 后仍有输出，均进入 repair，而
不是报告“已存在”。

JSONL 没有跨进程 unique claim authority，因此只保留读取兼容，不能执行 durable continuation；
generic SQLite/JSONL append 均拒绝 continuation-start。

payload 的 `provenance` 只是审计镜像，不能由事件自己声明执行资格。SQLite 只暴露两个窄命令：
`commitContinuationStart` 写 `runtime_admission`，`commitContinuationRepairStart` 写
`claim_repair`；两者都在同一事务内写 event、`start_event_id` 和 `start_kind`。读取 claim state
时必须交叉验证三者，任何缺失或矛盾都 fail closed。

最终发布路径支持已发布 mainline schema 5 → schema 6，并保留 populated RuntimeEvents。本分支
中途产生的未发布实验 schema 6 与 #1346 数据不属于兼容合同。

#### B2：执行前重验证与 provider-call T1

```mermaid
sequenceDiagram
    participant H as Host / SessionManager
    participant P as Read-only Planner
    participant K as RuntimeKernel
    participant S as SQLite Authority
    participant R as AgentRun
    participant B as Backend / Provider

    H->>P: plan(sourceRun)
    P->>S: read immutable lineage prefixes
    P->>P: build one composite replay + safety plan
    P-->>H: continuation(boundary, replayDigest, fresh target)
    H->>K: execute planned continuation
    K->>S: re-read ancestors pinned + immediate source latest
    K->>K: rebuild manifest + provider replay + safety
    K->>S: claimContinuation(boundary, replay, exact target header)
    alt acquired
        K->>R: create target Run(status=created)
        R->>S: commit live continuation_start_v2 (event_seq=1)
        S-->>R: created=true + startEventId
        R->>R: issue opaque one-shot start proof
        R->>B: consume runner-bound receipt; reserve/start backend
        B-->>R: provider events
    else existing or conflict
        K-->>H: fail closed; provider is never called
    end
```

严格顺序是：

1. 进程内 execution claim；
2. pinned 重读 ancestors、latest 重读 immediate source，重建 boundary/replay，重做 safety
   revalidation；
3. SQLite 事务内再次核验 source latest head，再提交 durable boundary claim；
4. 创建 fresh target Run，状态为 `created`；
5. 通过 dedicated writer 提交 `continuation_start_v2`，必须是 target `event_seq=1`；
6. 才允许 append running turn state、reserve backend、标记 running、调用 provider。

linked child 与 legacy child 的 provider retry 也按这套顺序执行：重新验证 boundary/replay、
workspace/background/tool catalog，竞争同一个 SQLite boundary claim，再写 continuation-start。
`retriedFromRunId` 继续承担产品查询与展示语义，但不承担并发执行所有权。

live continuation-start 同时绑定 claim id、boundary digest、immediate source identity/high-water/prefix
digest、replay manifest、provider projection version 和 provider replay digest。V2 AgentRun header 的
`continuationSource` 必须与首条 continuation-start 完全一致。若当前执行使用
`t1_after_preflight_v1`，该 marker 也写在同一 event-seq 1；repair start 不得携带它。

`RuntimeRunner` 的 public `run({ continuation })` 与 `resume()` 都 fail closed；只有
`RuntimeKernel` 能走 package-private admission 路径。AgentRun 只有在 live start 返回
`{created:true,startEventId}` 后才签发 opaque one-shot proof；Runner 再精确校验并绑定
startEventId、claim、boundary、target identity、provider projection/replay digest，签发
runner-bound one-shot receipt。receipt 在首次 `await` 前消费；runtime context、host context 与
orchestration 在签发时 clone/freeze，调用者事后修改不能改变执行语义。repair start、existing
start、伪造 proof、重复消费或换 Runner 消费均不能获得 provider authority。
proof 中的 tool-boundary protocol 还必须与目标 Runner 完全一致，避免账本声明 T1 而实际执行器
没有相同边界。
`./runtime-runner` 不再是公开 subpath，避免其他包绕开 B2 authority。

如果 start 写失败，Run 不会被伪装成普通 failed terminal：它保持 `created`，claim 保持 durable，
provider 调用次数为 0，后续进入 repair。existing claim 永远不会重新获得 provider authority。

#### B2.1：claim-only crash repair saga

startup 先枚举 continuation claim，而不是只从 AgentRun 列表开始。B2.1 只自动收敛两种可证明
尚未越过 provider T1 的状态：

```text
claim only
claim + exact target Run(created) + no start
```

repair 使用 claim 内持久化的完整 target header，通过专用 store command 写入
`start_kind=claim_repair` 的 deterministic repair start 作为合法 event-seq 1，再写 deterministic
failed terminal，failureClass 为
`continuation_abandoned_before_provider_dispatch`。全过程 provider 调用数必须为 0；exact retry
幂等；修复后的 failed Run 可作为新的 continuation source。

正常 admission 写入的 `runtime_admission` start 是 provider T1。`start durable + no terminal` 在没有
跨进程 exclusive owner/epoch 证明时只能 park 为 `continuation_started_indeterminate`，不能由
另一个进程擅自补 terminal，因为原 provider 可能仍存活。SQLite writer 同时拒绝 terminal 后追加
任何 immutable event，作为最终写侧防线。

linked-child 的 generic admission repair 在发现 target identity 已由 continuation claim 占有时
必须 defer，不能抢先创建一个缺少 V2 source 的同 id Run。只有同时证明 claim target、B2.1
deterministic repair start、deterministic terminal 与 target header 全部一致，才允许把
`continuation_abandoned_before_provider_dispatch` Run 作为 child provider retry source。仅凭
字符串 failureClass 或 V2 header 不构成证明。

canonical continuation authority 读取失败时，best-effort startup 必须隔离整个 session，不允许
退回 generic/legacy repair。否则一个暂时读不到 claim 的 host 可能把 claim-owned target 当成普通
中断 Run 修复，重新引入双重事实源。

repair 是跨 SQLite canonical RuntimeEvent 与文件型 AgentRun operational projection 的 saga：
start、terminal fact 与 AgentRun terminal event 使用确定性 id；若 terminal fact 已提交而 header
或 operational projection 未完成，下一次启动会复用同一 terminal 并补齐。SQLite canonical fact
可以幂等，但文件 append 目前没有跨进程 CAS；两个 host 同时 repair 的 exactly-once 要由后续
lease/fencing 或 append-if-absent 解决。

#### B2/B2.1 crash matrix

| crash / race point | durable state | reopen decision |
|---|---|---|
| claim insert transaction 内失败 | 无 claim | 可重新规划 |
| claim committed、target Run 尚未创建 | claim only | deterministic pre-provider repair |
| target Run created、start 尚未提交 | claim + exact created Run | deterministic pre-provider repair |
| live start committed、backend/owner 状态未知 | claim + `runtime_admission` start | park：started indeterminate |
| terminal event committed、header 未提交 | terminal fact | header repair |
| terminal header committed | terminal continuation | already exists |
| startup 与手动 resume 同时 claim | 1 acquired + 1 existing | 只调用一次 provider |
| linked-child admission closure 与 claim repair 竞争 | claim owns target | generic closure defer |

测试同时覆盖：

- 二代/三代 lineage；
- interrupted text/thinking suffix；
- ancestor suffix 不重现；
- 无 user/tool anchor 的真实 continuation segment 全量裁掉 model-visible suffix；
- mutable partial 与 immutable prefix 并存；
- cycle、64 段上限、missing ancestor；
- 每条 V2 edge 的 historical provider replay digest；
- 每条 V2 edge 的 claim row、target immutable header、start id/kind 交叉验证；
- continuation-start → function_call → pre-T1 crash 的 suffix 裁剪；
- source H+1 的 execution/claim 双重竞态与 claim 后 source seal；
- claim row/payload mismatch、exact target header/start/terminal cross-check；
- terminal-tail seal 与 terminal 后追加拒绝；
- 两进程 claim/append race；
- claim-only 与 normal-start SIGKILL boundary；
- branch/revision 在创建目标 Session 前拒绝 V1/V2 continuation 与 authority facts。

#### B3：明确延后

本 PR 不实现通用 provider retry、ShellRun reattach、Bash 重放、conversation clone identity
rewrite 或其他 typed continuation branch。authority-capable SessionManager 内已有的
linked-child RateLimit retry 与 B2.1 repair retry 是窄协议，不代表 runtime-host 已获得生产启用
资格。其他能力必须在各自拥有 durable handle/幂等协议后独立设计，不能复用 B2 的普通
continuation claim 来暗示副作用可重跑。

兼容约束：早期的 `legacy_provider_retry` lane（只允许 continuation authority 与 safety
inspector 同时缺席的组合，半配置状态 fail closed；执行前重验 immutable immediate-source
replay，但不产生 claim/start，也不能承接
`continuation_abandoned_before_provider_dispatch`）已在 host authority lifecycle
integration 接入 typed SQLite authority owner 后移除。child provider RateLimit retry 现在
只走 durable continuation 准入：authority 或 safety inspector 任一缺席时在 claim/Run/T1
之前 fail closed，没有降级模式。

B3 之前，branch/revision preflight 必须在创建目标 Session 之前拒绝任何 V1/V2
`continuationSource` 与 continuation-start，稳定返回
`branch_runtime_fact_rewrite_unsupported`。continuation claim 与 boundary evidence 不属于普通
Run/Event 复制边界，不能在没有 typed authority copy 协议时浅拷贝。

tool dispatch/recovery 与 operation reference 则已由 conversation runtime ledger copy 建立旧 id
到新 id 的 typed 映射：新 invocation 决定新 operation id，dispatch、recovery、RuntimeEvent
refs 和 recovery evidence RuntimeEvent ids 必须原子重写后才能导入目标 Session。该路径
应保持可用，不得因 continuation authority 的 fail-closed 闸门被误拦截。

#### 后续执行语义绑定：ContinuationExecutionProfileV1

当前 sorted/deduplicated exact tool-name equality 只是过渡 gate。生产默认启用前，应新增
`ContinuationExecutionProfileV1`，贯穿 plan → claim → continuation-start → execution
revalidation，至少包含：

```text
backend kind + resolved model id
system prompt digest
tool name + input schema + recovery contract digest
tool-boundary protocol
provider materializer/projection version
permission/sandbox execution-policy digest（会影响可执行语义时）
```

boundary 证明“继续哪一段事实”，execution profile 证明“按照哪套执行语义继续”。两者必须分开
摘要并同时匹配；不能在执行时用当前 Session 配置重新生成 target header，从而把 plan 后的模型、
prompt 或同名工具 schema 漂移悄悄合法化。

这不是优化项，而是 production auto-resume 的硬门槛。PR B 只能证明执行历史和 provider replay
形状一致，不能仅凭同名工具证明 input schema、recovery contract、permission policy 或 system
prompt 未漂移。

#### 后续边界验证与 host composition 收敛

planner、Kernel、SQLite store、Runner 和 SessionManager 当前分别承担不同阶段的重验证。下一步
应提取纯函数 `ContinuationBoundaryVerifier`，统一验证 canonical boundary、lineage edge、target
header、start、terminal 与 provider replay；store 只负责事务内 physical ledger/CAS，避免规则在
五处逐渐漂移。

PR D 的 host composition 不再用“若存在某个可选方法就启用”的 duck typing，而应使用类型化联合：

```text
ContinuationAuthorityComposition =
  | { mode: "disabled" }
  | {
      mode: "enabled"
      authority: SqliteRuntimeStore
      immutableInspector: same-ledger inspector
      repair: same-authority repair capability
      ownerLease: workspace-scoped epoch/fencing lease
    }
```

production composition test 必须证明 plan → claim → live start → provider 与 startup repair 使用同一
authority、同一 ledger transaction domain。lease 要携带 epoch/fencing token；只有持久化证据证明
旧 owner 已失效，未来才可以对 live-start indeterminate 做进一步收敛。进程内 one-shot receipt 不能
替代跨进程 owner proof。

### PR C — File evidence + finalize-only recovery

不变量：

> T1 选择 `reconcile` 时必须已持久化可信文件 evidence；恢复只能在 current 明确匹配
> expected-after 时补 outcome，不能根据陈旧 before 自动写文件。

首版策略：

| observation | 动作 |
|---|---|
| `matches_expected_state` | cleanup/finalize，合成 outcome，提交 PR A bundle |
| `matches_prior_state` | park，reason=`redo_disabled_pending_cas` |
| `diverged` | park，不覆盖外部写入 |
| `unreadable` | park，不猜测 |

原因：atomic rename 只保证不产生半文件，不提供 conditional replace。最终 hash 检查与 rename 之间
仍有 TOCTOU，尤其 crash 后旧 checkpoint 的窗口可能长达数小时或数天。因此首版不自动 redo。

文件 evidence 至少绑定：

- trusted workspace identity 与 canonical target；
- operation/call/dispatch identity；
- recovery contract id、version、evidence kind 与 evidence digest；
- before identity 与 expected-after identity；
- transform/algorithm version；
- worker 生成的 production-shaped result；
- size、regular-file、symlink、UTF-8 等观察边界。

正常执行与 prepare 必须共用 Write/Edit transform；filesystem worker 保持 permission profile、
sandbox、one-call grant 和 abort boundary 的执行所有权。

PR C 沿用 PR A 的 durable vocabulary：`matches_expected_state` 可 finalize；
`matches_prior_state`、`diverged`、`unreadable` 均提交 terminal parked decision。UI 可以把
`matches_prior_state` 映射为 `redo_disabled_pending_cas`，但不新增第二套 durable fact 名称。

### PR D — Host owner lifecycle

不变量：

> SQLite、filesystem worker、contract registry、background resume task 各有唯一 owner；
> 初始化失败、取消、退出均反向、恰好一次释放。

PR D 不改变 recovery semantics。它覆盖：

- CLI interactive owner；
- Desktop startup/shutdown；
- background promise rejection；
- store 已开但 worker 初始化失败；
- in-flight recovery 时退出；
- double close；
- Desktop 与 CLI 同 workspace 的 owner 冲突策略；
- runtime-host 的 execution-store writer facade 在同一个 storage-root lease 下拥有并暴露 SQLite
  continuation authority，而不是继续把 `FileRuntimeEventStore` 误当成 B2 authority；
- production composition test 证明 plan → claim → start → provider 与 startup repair 都经过同一个
  authority 实例。
- owner lease 的 epoch/fencing 以及 AgentRun operational projection 的 append-if-absent/CAS；
  在此之前 deterministic id 只保证可识别，不保证两个 host 同时 append 时 exactly-once。

Host owner 使用显式 `opening -> ready -> closing -> closed` 状态机；`close()` 共享一个
幂等 Promise。关闭顺序固定为：停止 admission、取消后台 recovery、等待任务收敛、关闭 registry
与 filesystem worker、关闭 stores，最后释放 workspace owner lock。后台 Promise 在创建时就必须
登记 rejection owner。

恢复所有权顺序固定为：

```text
continuation claim repair
→ linked-child admission repair
→ generic AgentRun ledger repair
→ ordinary continuation planning / auto-resume
```

generic repair 必须识别 claim-owned target 并 defer，不能用普通 `app_restarted` Run 抢占 target
identity。当前 PR B 交付 authority-capable SessionManager 与 SQLite 协议；在 PR D 把该 authority
接入 runtime-host 生产组合并完成 owner/ordering 测试前，不得宣称 hosted auto-resume 已启用。

## 3. Native、attached 与 managed 的能力边界

### Native / attached checkout

Attached 模式继续服务现有用户目录与兼容场景，但不冒充强 workspace continuity：

- RuntimeEvent history、continuation authority 与已落地的工具恢复事实继续有效；
- 不能证明 workspace 内容对应某个 Runtime boundary 时 park；
- 不建设第二套 native workspace manifest 或 CAS object store；
- 不在用户 checkout 上自动 reset、redo 或覆盖 drift；
- 旧的 generic checkpoint provider、per-file carrier 与 observe-only user-repository Git 路线只保留为
  attached/legacy research，不再是 `managed_worktree` 的实现前置。

### Git-native managed workspace

强模式以 Maka-owned repository/worktree 为 artifact carrier。Git 证明文件世界，SQLite immutable
RuntimeEvents 决定 Maka 是否接受某个文件版本；Git commit、ref、receipt 与 projection 都不是第二套真相。
内置并校验的 Git CLI 是该模式的运行能力，不要求用户自行安装 Git，也不修改用户 repository 的 index/ref。

## 4. Git-native managed workspace 演进

### M0 — Baseline admission（已合并）

M0 只证明一条接受链：

```text
authenticated storage-root owner
→ create/reopen Maka-owned managed Git workspace
→ durable exact receipt
→ SQLite atomic epoch + baseline acceptance
→ post-commit DB/Git/root-owner revalidation
→ publish usable baseline
```

M0 不接 Desktop、CLI、runtime host 或工具执行。Whole-root import 当前只恢复 storage-root identity 与
SQLite ownership；既有 linked worktree 的路径迁移需要独立 relocation/rematerialization 协议。非空且未绑定的
legacy DB 继续 fail closed，未来由显式、备份后、可审计的 root-binding maintenance flow 处理，不能藏在首次
baseline open 中。

### M1 — Execution admission 与环境可用性

只允许 host 从 M0 成功返回的 accepted handle 取得工具 cwd，并证明：

- managed owner 与 runtime host 的启动、drain、关闭顺序；
- 每次执行前 exact instance/HEAD/tree/ownership revalidation；
- ignored dependencies、`.env` 与 build scratch 使用明确 provisioning/overlay policy，不污染 canonical tree；
- 外部修改 Maka-owned worktree 时检测 drift、fail closed 并 quarantine；
- attached 与 managed execution profile 在类型和配置上不可静默互相 fallback。

M1 拆成独立不变量，避免一次 PR 同时跨越 host lifecycle、runtime protocol 与 platform I/O：

1. **M1.1 execution scope admission（当前切片）**：M0 只返回 owner-bound opaque handle；同一 owner 每次
   execution 都在 drain residency 内重新证明 canonical head、Git receipt、HEAD/tree/ownership 与 root
   identity，最后只签发 callback 生命周期内有效的 opaque scope，不公开 raw cwd。provisioning 固定为
   `canonical_tree_only_v1`，`workspaceEffect` 固定为 `none`。同一 handle 可以并发多个只读 admission，
   `close()` 必须等待全部 active scope drain；普通生产 admission 只做一次最终 Git verification，preliminary
   verification 仅存在于配置 crash failpoint 的 production-shaped 测试路径；过期或伪造 scope 通过 typed
   `ManagedWorkspaceExecutionAuthorityError` 的稳定 code fail closed；
2. **M1.2 owner-bound worker 与 runtime-host composition**：storage-internal bridge 只能用同 owner 的 active
   scope 解析 cwd，M2 前只允许 Read/Glob/Grep；建立不可混淆的 managed/attached typed profile 与
   startup/drain/shutdown 顺序，关闭顺序固定为 tool operations → managed owner → root owner；
3. **M1.3 environment provisioning**：单独设计 ignored dependency、secret 与 scratch overlay。M1.1 不复制
   `.env`、`node_modules` 或 build output，也不以 attached checkout silent fallback 掩盖能力缺失。

M1.1 合同见
[Managed Workspace Execution Admission v1](./runtime-managed-workspace-execution-admission-v1.zh-CN.md)。

### M2 — Mutation version acceptance

每个 mutating tool 使用 candidate ref/version 协议：

1. T1 前冻结 execution profile、base workspace version 与 mutation identity；
2. 工具只在 owned worktree 中执行；
3. Git artifact owner 捕获并验证 candidate commit/tree；
4. SQLite 在一个 authority transaction 中接受 tool outcome 与 successor workspace version；
5. artifact orphan 可回收；canonical fact 已接受而 artifact 缺失时 fail closed；
6. crash matrix 覆盖执行前后、candidate durable 前后、SQLite commit 前后与返回前复验。

这一步取代旧的“先做通用 checkpoint contract，再接 observe-only Git carrier”。不得同时维护两套
managed workspace version writer。

### M3 — Workspace-bound continuation / resume

Continuation boundary 同时绑定 immutable RuntimeEvent cursor 与 accepted workspace version/epoch：

- planner 与 execution revalidation 读取同一 canonical boundary；
- startup reopen 必须重新证明 exact Git artifact、storage root 与 owner；
- operation effect 无法证明、artifact 漂移或 execution profile 不匹配时 park；
- 自动 resume 仍由独立用户设置控制，默认关闭；手动恢复与自动恢复不能共享一个含糊开关。

### M4 — Product workflows

在 M0–M3 的事实与 owner 边界稳定后，再分别交付：

- isolated restore，不覆盖用户当前目录；
- explicit rebaseline，创建新 epoch 并要求模型重新读取；
- publish/merge/undo、retention 与 orphan GC；
- whole-root managed-workspace relocation；
- replication/cross-device 与 multi-agent merge。

每项都必须是独立 PR；不能借“恢复产品化”一次跨越 schema、runtime protocol、host lifecycle 与 platform I/O。

## 5. 依赖顺序

```text
PR A recovery persistence authority (merged)
└─> PR B continuation correctness (merged)

Git-native workspace:
M0.1 Git artifact owner (merged)
  + M0.2 workspace version authority (merged)
  + M0.3 managed owner lifecycle (merged)
  └─> M0.4 baseline open bundle (merged)
       └─> M1.1 execution scope admission (current)
            └─> M1.2 runtime-host composition
                 └─> M1.3 explicit environment provisioning
                      └─> M2 mutation version acceptance
                           └─> M3 workspace-bound continuation
                                └─> M4 restore / rebaseline / publish / replication

Independent maintenance gates before broad production enablement:
  - legacy non-empty DB root-binding adoption
  - whole-root managed-workspace relocation/rematerialization
```

旧 PR C–H 的论证可作为历史材料，但不再代表 `managed_worktree` 的施工依赖图；其中不具备生产消费者的
generic checkpoint、observe-only carrier 与预设抽象不得迁入新主线。

## 6. 工程门槛

每个 PR 必须：

- 只改变一个事实权威或所有权边界；
- 先有 production-shaped RED tests；
- 包含 crash/reopen matrix；
- fail-closed code 是稳定 machine code；
- 不把平台假设伪装为跨平台保证；
- 文档、类型、writer、reader、rebuild、Resolver 同步更新；
- range-diff/path diff 证明没有带入相邻阶段代码。

性能与可靠性指标在启用前定义：

- SQLite bundle commit p50/p95；
- rebuild 对总 immutable history 的成本；
- continuation claim verification 的 p50/p95 与每次 append 扫描 claim 的数量；长期应增加
  source/target/run 索引、局部验证或可失效的已验证缓存，避免退化为
  `O(claims × immutable writes)`；
- managed mutation candidate capture/accept p50/p95；
- `workspace_drift`、`mode_mismatch`、`artifact_missing` park 比例；
- 自动恢复成功率必须把长命令、大仓库、dirty workspace 纳入分母。

## 7. 不做的承诺

- PR A 不提供真实工具自动恢复；
- PR B 不恢复 workspace；
- M0 不把 managed worktree 交给生产工具；
- attached checkout 不提供 managed 级 workspace continuity；
- Maka-owned Git artifact 不覆盖用户当前 checkout；
- 无法证明的 Bash/远程 API 副作用不自动重试；
- process-crash transaction atomicity 不等于断电级 durability。
