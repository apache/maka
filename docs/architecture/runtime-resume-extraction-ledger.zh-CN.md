# Runtime Resume #1346 拆分与提取账本

- 状态：Active
- 更新日期：2026-07-27
- 集成实验来源：`origin/codex/runtime-resume-phase3a@24bb5f33`
- PR A 旧重写来源：`codex/runtime-recovery-authority@c843519e`
- 当前平铺基线：`upstream/main@466f238b`
- 当前平铺分支：`codex/runtime-recovery-authority-v2`

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

## 8. #1346 的关闭条件

PR A–C 合并后：

1. 在 #1346 最后评论列出 replacement PR；
2. 明确未迁移的原型和原因；
3. 保持 Draft 并关闭，不 squash/merge；
4. PR body 与 review thread 保留为历史证据；
5. PR D 可独立推进，不阻塞 #1346 关闭。
