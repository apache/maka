# Runtime Resume #1346 拆分与提取账本

- 状态：Active
- 更新日期：2026-07-28
- 集成实验来源：`origin/codex/runtime-resume-phase3a@24bb5f33`
- PR A 旧重写来源：`codex/runtime-recovery-authority@c843519e`
- PR A 已合并：`upstream/main@086ec99d`（#1521）
- 当前 PR B 平铺基线：`upstream/main@de242b43`
- 当前 PR B 平铺分支：`codex/runtime-continuation-correctness`

## 1. 目的

#1346 是设计与集成实验，不再作为可合并交付单元。生产实现按“一个 PR 证明一个完整不变量”
重新落地，禁止按旧 commit 边界机械 cherry-pick。

| 切片 | 唯一需要证明的不变量 |
|---|---|
| PR A | recovery fact 只有一个原子写入权威，且 online/reopen/rebuild/Resolver 必然同构 |
| PR B | continuation cursor 只来自 immutable RuntimeEvents，同一 source boundary 只有一个 claim |
| PR C | T1 选择 file reconcile 时必须有可信 evidence；自动恢复只做 after-state finalize |
| PR D | store、worker、registry、后台恢复任务各有唯一 host owner 和完整关闭顺序 |

Phase 3B/4A 的 workspace checkpoint 是后续独立切片，不进入 PR A。

## 2. 提取规则

1. 每个新 PR 从当时最新 `upstream/main` 建立平铺分支。
2. 先迁移或重写能表达黑盒不变量的测试，再补最小生产代码。
3. 不 cherry-pick merge commit。
4. 同时跨越两个不变量的旧 commit 只能按 hunk 阅读和手工重写。
5. 不为让旧测试通过而恢复已否决的 public API。
6. 每个 PR 必须执行 path diff、range-diff 和 production-shaped crash tests。
7. PR A–C 合并后关闭 #1346，但保留其讨论作为设计与审查记录。

## 3. PR A 的提取结论

### 3.1 保留并重写的能力

- 精确的 reconcile-result / recovery-decision v1 schema；
- strict-JSON admissibility 与冻结的 mainline v1 tool args hash bytes；未来的 domain separation
  必须由显式 dispatch/hash v2 引入，不能原地改变 `t1_after_preflight_v1`；
- call、dispatch、outcome、reconcile、decision semantic lane；
- generic append/import 对保留事实的 authority gate；
- 一个 SQLite recovery bundle transaction；
- completed 必须引用同 execution identity 的成功 outcome；
- parked 是 v1 的永久终态，只有 exact bundle retry 幂等；
- tool projection 可以只从 immutable RuntimeEvents 重建；
- mutable partial corruption fail-soft，immutable corruption fail-closed；
- SQL row identity 与 payload identity 交叉校验；
- online、close/reopen、rebuild、Resolver 的黄金等价性。
- resume 对 terminal parked 和任意 scanner corruption 设独立硬闸门；diagnostic 只负责解释，
  不能成为唯一安全条件；
- tool-bearing writer 在事务内用同一 prospective transition validator 证明候选 prefix；
- PR A 首版刻意采用 workspace-wide semantic fail-stop：任一 session 的 canonical tool-ledger
  corruption 都会阻止该 SQLite workspace 后续所有 tool-bearing boundary；普通非工具事件仍可写。
  这是 correctness-first 的隔离取舍，不是偶然副作用；
- SQLite 与 JSONL 共享唯一 lossless canonical RuntimeEvent codec；validator 消费 codec
  返回的 event，store 持久化同一次编码返回的稳定 JSON bytes；
- SQLite 对每个 invocation 强制唯一 `(sessionId, runId, turnId)` execution spine；
- JSONL immutable append 对 exact retry 物理去重，并在落盘前验证目标 Run header；
- projection-local journal ID 由 operation/event 派生，调用者不能选择；
- schema 4 的 nullable-dispatch legacy projection 可读但隔离，不进入 recovery 或 canonical rebuild。

### 3.2 明确不带入 PR A

- recovery contract registry、observer、reconciler；
- Write/Edit file checkpoint；
- continuation planning、claim 或 provider replay；
- Desktop/CLI 自动 resume 接线；
- Git carrier、restricted verifier、retry/reattach 原型；
- #1346 SQLite 数据迁移、downgrade 或 mixed-version reader。

### 3.3 实验格式断代

#1346 从未发布、没有用户，其 SQLite 数据是一次性实验数据。PR A 不猜测兼容：

```text
#1346 experimental capability  -> unsupported, fail closed
mainline schema 4              -> supported migration to schema 5
PR A capability                -> runtime_recovery_authority@1
future newer schema            -> fail closed
```

这项决策只删除未发布实验格式的迁移负担，不删除正式 mainline 数据升级责任。

## 4. PR A 文件账本

### Core

| 文件 | 归属 | 处理 |
|---|---|---|
| `runtime-event.ts` | PR A | 增加 exact recovery fact envelope decoder |
| `canonical-runtime-event.ts` | PR A | 唯一 lossless decoder、strict JSON 与稳定 bytes owner |
| `runtime-event-store.ts` | PR A | 增加单一 bundle capability |
| `tool-args-identity.ts` | PR A | strict JSON 校验 + mainline v1 hash 字节兼容；v2 才允许 domain separation |
| `tool-ledger-scanner.ts` | PR A | 共享 exact lane、duplicate/order/identity scanner 与 prospective transition validator |
| `tool-recovery-fact.ts` | PR A | truthful observation 与 terminal decision |
| `tool-recovery-bundle.ts` | PR A | writer/rebuild/Resolver 共享 bundle 与 causal interpreter |

### Storage

| 文件 | 归属 | 处理 |
|---|---|---|
| `sqlite-runtime-schema.ts` | PR A | schema 5 + `runtime_recovery_authority@1` |
| `sqlite-runtime-store.ts` | PR A | 全局 prospective gate、invocation spine、atomic recovery bundle、projection rebuild |
| `agent-run-store.ts` | PR A | JSONL authority gate、header identity 与 immutable exact retry 去重 |

### Runtime

| 文件 | 归属 | 处理 |
|---|---|---|
| `recovery-resolver.ts` | PR A | 只消费共享 scanner/interpreter，不维护第二套 map |
| `runtime-event-read-model.ts` | PR A | recovery audit fact 不产生聊天消息 |
| `runtime-commit-sink.ts` | PR A | 使用 core canonical args identity |
| `runtime-resume.ts` | PR A | 保留真实 corruption machine code 与 terminal parked |

## 5. PR A 测试账本

| 场景 | 新测试位置 | 状态 |
|---|---|---|
| strict JSON admissibility + mainline v1 hash compatibility | core authority test | 已覆盖 |
| `required` / `enum` 特殊排序与 ordinary array 的 mainline v1 literal vectors | core authority test | 已覆盖 |
| 历史 `__proto__` hash omission 与 strict RuntimeEvent JSON data-property 保留 | core authority test | 已覆盖 |
| sparse/accessor/custom array identity rejection | core authority test | 已覆盖 |
| semantic lane smuggling | core + storage authority test | 已覆盖 |
| partial authority、branch-qualified authority | core authority test | 已覆盖 |
| generic SQLite/JSONL writer bypass | storage tests | 已覆盖 |
| duplicate call、早到 response、unbound T2 的 prospective rejection | core + storage tests | 已覆盖 |
| T1 wrong hash | storage authority test | 已覆盖 |
| duplicate call / operation / event | core + rebuild tests | 已覆盖 |
| dispatch-before-call | core + rebuild tests | 已覆盖 |
| completed missing/mismatched outcome | core bundle validator | 已覆盖 |
| completed/parked exact retry | storage authority test | 已覆盖 |
| reconcile/outcome/decision exception rollback | storage authority test | 已覆盖 |
| reconcile/outcome/decision SIGKILL rollback + post-COMMIT | storage process crash test | POSIX 覆盖；Windows 按有限支持跳过 |
| exact/conflicting bundle、rebuild/commit 多进程竞争 | storage multi-process test | 已覆盖 |
| 多进程同时打开并持有同一 WAL 数据库、初始化失败有界退出 | storage multi-process test | 已覆盖 |
| populated mainline schema 4 prepared/completed tool rows | storage authority test | 已覆盖并隔离 |
| populated mainline schema 4 T1 dispatch + special args hash | storage authority test | 已覆盖并可重建 |
| schema 4→5 optimistic stale read 后锁内重读 | storage schema test | 确定性覆盖 |
| schema 4→5 多进程并发打开升级 | storage multi-process test | 已覆盖 smoke path |
| #1346 capability rejection | storage authority test | 已覆盖 |
| immutable row/payload mismatch | storage authority test | 已覆盖 |
| corrupt mutable partial | storage authority test | 已覆盖 |
| online = reopen = rebuild = Resolver | runtime equivalence test | 已覆盖 |
| prepared、normal T2 success/error、parked、recovered completion | runtime equivalence test | 已覆盖 |
| 多 operation 交错后 journal/projection rebuild | storage authority test | 已覆盖 |
| parked 不再进入 reconcile | storage + runtime equivalence test | 已覆盖 |
| parked / orphan corruption 不得产生 safe replay | runtime planner test | 已覆盖 |
| decoder canonical persistence 与有损 JSON 拒绝 | storage authority test | 已覆盖 |
| nested undefined、provider `toJSON`、recovery evidence 改写 | storage authority test | 已覆盖 |
| JSONL ordinary/tool exact retry 与 conflicting retry | JSONL storage test | 已覆盖 |
| JSONL event 与目标 Run header identity | JSONL storage test | 已覆盖 |
| invocation 跨 session/run/turn 漂移 | core scanner + SQLite authority test | 已覆盖 |
| unrelated session corruption 阻断新 session tool boundary | storage authority test | 已覆盖 |
| corrupt ledger 上的 T1/T2/recovery exact retry | storage authority test | 已覆盖 |
| SQLite terminal raw/canonical-equivalent retry | SQLite storage test | 已覆盖 |
| JSONL terminal target Run identity 与 exact retry post-effect 收敛 | JSONL storage test | 已覆盖 |
| journal ID online/rebuild 同源派生 | storage authority test | 已覆盖 |
| audit fact 不产生 message row | runtime read-model test | 已覆盖 |

## 6. 旧 commit 去向

旧 PR A 的八个非 merge commit只作为阅读来源，不整体 cherry-pick：

| 旧 commit | 处理 |
|---|---|
| `34805553` core fact authority | 测试与最小 schema 手工重写 |
| `68ee74de` SQLite bundle | transaction 思路手工重写 |
| `f464cfb1` runtime causality | 被共享 scanner/interpreter 替代 |
| `5f2b0ae5` restart tests | 有效场景重写到新 fixture |
| `4de05393` writer bypass | 收敛为 core generic authority gate |
| `b36486b7` evidence identity | 收敛为 strict hash + bundle validator |
| `b0683358` rebuild races | duplicate/order 场景重写 |
| `c843519e` JSONL validation | 仅提取 generic writer gate |

#1346 中其余 commit 按职责进入 PR B、PR C、PR D 或直接 defer/drop；Git carrier、restricted
verification、auto redo、retry/reattach 不从实验分支迁移。

## 7. Diff 审计与合并门槛

提交前执行：

```text
git diff --name-status upstream/main...HEAD
git log --no-merges --name-only upstream/main..HEAD
git range-diff upstream/main..codex/runtime-recovery-authority upstream/main..HEAD
git diff --stat codex/runtime-recovery-authority HEAD -- <PR-A-owned-paths>
```

range-diff 的目标不是伪造 commit 等价，而是确认旧实现中的有效场景都有明确去向。路径审计必须证明
PR A 没带入 file checkpoint、continuation 或 host lifecycle。

2026-07-27 本轮结果：

- 旧 PR A 的 8 个 commit 全部显示为 removed；
- 新平铺 PR A 最初的 4 个实现 commit 与后续 10 个审查收敛 commit 全部显示为 added；
- 没有 commit 被错误标记为等价 cherry-pick；
- `upstream/main...HEAD` 只涉及 core recovery contract、SQLite/JSONL authority、
  Runtime Resolver/read-model/resume diagnostics、对应测试与本路线文档；
- 未出现 file checkpoint carrier、filesystem worker、SessionManager/Desktop/CLI host wiring
  或 Git carrier 路径。
- 分支已再次重放到 `upstream/main@466f238b`；本轮唯一内容冲突位于 Desktop settings E2E，
  保留上游当前更精确的三按钮 permission fixture，因此该文件最终不出现在 PR A 的重放提交中；
  recovery authority 的 18 个其余提交以及两个 schema 4 blocker 修复均由 range-diff 证明语义等价。

合并门槛：

- core、storage、runtime build 通过；
- PR A 定向测试全部通过；
- 三个包完整测试通过，或明确记录与本改动无关的平台既有失败；
- SQLite transaction crash matrix 通过；
- 所有成功接受的 tool-bearing transition 均满足 `scan.hasCorruption === false`；
- JSONL exact retry 不增加物理行，冲突 retry 不改变原 ledger；
- 一个 SQLite invocation 只能对应一个 `(sessionId, runId, turnId)`；
- canonical codec 拒绝任何 nested loss、accessor/custom prototype 或 `toJSON` 改写；
- `recovery.hasCorruption` 与 terminal parked 均独立阻断 provider continuation；
- 文档中的能力边界与代码一致；
- 工作树不包含用户的 workspace/测试文件。

PR A 后续清偿项不阻塞当前 correctness merge gate：

- 从 public commit input 删除冗余 `journalEventId`，完全由 store 派生；
- 为全局 prospective scan 增加 event count / duration 指标，再演进为可重建的增量 reducer；
- 增量 reducer 落地后，把 transition scan 缩到 candidate execution spine；event、invocation、
  operation 的全局唯一性由 SQL identity constraints/projection 承担，full scan 移到 store open
  或显式 integrity check；
- JSONL 是 legacy/readable fallback，不承担跨进程的全局 invocation uniqueness；恢复 authority
  需要 SQLite。

## 8. PR B 的提取与施工账本

PR B 没有整体 cherry-pick #1346 的任何 commit。它从已包含 PR A 的
`upstream/main@de242b43` 建立平铺分支，先重写 immutable boundary、lineage replay、
claim race 与 provider-call T1 测试，再补满足不变量的最小生产路径。

### 8.1 PR B 的唯一不变量

> continuation 只有在一个版本化的 composite immutable boundary 被执行前重验证并原子 claim
> 后才能调用 provider；每个 lineage segment 使用同一 replay projection；durable
> continuation-start 是 provider-call T1。

这条不变量拆为两个已实现层次：

- **B1 — immutable boundary 与 replay**：物理 `event_seq`、canonical RuntimeEvent bytes、
  segment digest、ordered manifest、provider replay digest；
- **B2 — durable authority 与 provider T1**：SQLite unique claim、执行前完整重验证、
  target Run `created`、continuation-start T1、然后才允许 backend/provider 启动。

B3（typed retry/reattach branch）仍然 defer，不进入本 PR。

### 8.2 文件归属

#### Core

| 文件 | PR B 职责 |
|---|---|
| `runtime-boundary.ts` | immutable prefix、segment、composite cursor、claim v1 与 strict decoder |
| `runtime-event.ts` | exact `continuation_start_v2` provider-call T1 |
| `runtime-event-store.ts` | `RuntimeContinuationAuthorityStore` capability |
| `agent-run.ts` | `continuation_source_v2` header lineage |
| `runtime-boundary.test.ts` | canonical bytes、物理位置、partial 排除、伪造 prefix、manifest 顺序 |
| `runtime-event.test.ts` | continuation-start exact shape 与 projection version 冻结 |

#### Storage

| 文件 | PR B 职责 |
|---|---|
| `sqlite-runtime-schema.ts` | schema 6 + `runtime_continuation_authority@1` |
| `sqlite-runtime-store.ts` | prefix 一致性读、claim transaction、dedicated start writer |
| `agent-run-store.ts` | JSONL 拒绝 continuation-start authority fact |
| `sqlite-runtime-store.test.ts` | prefix/claim/start/rollback/row-payload mismatch |
| `sqlite-recovery-concurrency.test.ts` | 两进程争抢同一 boundary |
| `sqlite-recovery-concurrency-child.ts` | production-shaped 多进程 claim fixture |
| `sqlite-runtime-schema.test.ts` | schema 6 migration 与 capability |

#### Runtime

| 文件 | PR B 职责 |
|---|---|
| `continuation-replay.ts` | 每个 lineage segment 的唯一 provider replay materializer |
| `model-history.ts` | 冻结 `PROVIDER_REPLAY_PROJECTION_VERSION = 1` |
| `runtime-resume.ts` | immutable lineage planner、cycle/depth/edge/T1 校验、claim 只读分类 |
| `runtime-kernel.ts` | 执行前重建 boundary/replay、原子 claim、provider T1 顺序 |
| `agent-run.ts` | Run create 与 backend reservation 之间提交 continuation-start |
| `runtime-runner.ts` | 不再伪造 legacy continuation-start |
| `session-manager.ts` | 主 resume 与 linked/legacy child provider retry 共用 immutable planner；只向具备 continuation authority 的 store 开放执行 |
| `runtime-event-read-model.ts` | continuation-start 是消息不可见的 canonical audit fact |
| `runtime-continuation*.test.ts` | lineage、claim、T1、SIGKILL crash matrix |
| `session-manager.test.ts` | production-shaped plan/execute/race/failure/stop，以及 linked/legacy child retry 的 V2 claim/start |

#### UI 与文档

| 文件 | PR B 职责 |
|---|---|
| `runtime-resume-copy.ts` | claim repair、started-indeterminate、authority unavailable 文案 |
| 本 extraction ledger | 记录平铺来源、文件归属、测试和未迁移能力 |
| Phase 3–4 设计文档 | 记录实际协议、时序、schema 与 crash matrix |

### 8.3 已覆盖测试

| 场景 | 结果 |
|---|---|
| canonical-equivalent JSON 产生同 prefix digest | covered |
| `event_seq` gap、identity drift、mutable partial、伪造 digest/position | fail closed |
| ancestor segment 顺序改变 | manifest digest 改变 |
| interrupted text/thinking suffix | 截到最近 user/tool stable boundary |
| unmatched call 后仍有 provider-visible 内容 | `provider_replay_non_suffix_gap` |
| A→B→C continuation | A 被裁掉的 suffix 不会在 C 重现 |
| cycle / lineage depth / missing ancestor | stable park |
| V2 source prefix、manifest、header/start T1 不一致 | stable park |
| exact claim retry | existing，不产生第二个 target |
| target identity、source boundary、claim id 冲突 | conflict |
| 两进程同时 claim 同一 boundary | 1 acquired + 1 existing |
| claim insert 后事务失败 | 无 durable claim |
| start event insert 后事务失败 | claim 保留、target prefix 为空 |
| claim SQL columns 与 canonical payload 不一致 | fail closed |
| continuation-start generic SQLite/JSONL append | rejected |
| start writer exact retry | 同一个物理 `event_seq=1` |
| start writer 失败 | provider 0 次、target Run 保持 repairable |
| stop after durable start | provider dispatch 被 fence |
| linked child 与 legacy child provider retry | 不读 mutable replay；写入 V2 lineage + continuation-start 后才调用 provider |
| SIGKILL after Run create/start/terminal event/terminal header | reopen 后稳定分类并修复 |

### 8.4 明确不进入 PR B

- Write/Edit file checkpoint、observer、reconciler；
- workspace checkpoint、Git tree/worktree、rebaseline；
- Bash retry、ShellRun reattach 或 typed branch；
- clone conversation 时的 recovery ref 改写；
- JSONL durable continuation claim；
- Desktop 设置或默认开启自动续跑；
- #1346 未发布实验数据库兼容。

### 8.5 验证记录

- `@maka/core` 全量：1233/1233；
- PR B runtime 相关集合：338/338；
- process SIGKILL crash harness：4 个 durable boundary 全部通过；
- SQLite prefix/claim/start、schema、并发定向集合全部通过；
- `@maka/storage` 全量在 Windows 上仍有与本切片无关的既有平台/fixture 失败：
  symlink 需要 Developer Mode、部分测试依赖 POSIX cwd、其他 execution-store fixture 未及时关闭
  `sessions.sqlite`。PR B 所属的 `runtime.sqlite` 定向与多进程测试没有失败；
- `@maka/runtime` 全量命令在本机超过 5 分钟测试预算；受影响路径已用上述 338 项集合完整覆盖。

## 9. #1346 的关闭条件

PR A–C 合并后：

1. 在 #1346 最后评论列出 replacement PR；
2. 明确未迁移的原型和原因；
3. 保持 Draft 并关闭，不 squash/merge；
4. PR body 与 review thread 保留为历史证据；
5. PR D 可独立推进，不阻塞 #1346 关闭。
