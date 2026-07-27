# Runtime Resume Phase 3–4 实施路线

- 状态：Implementation tracked
- 更新日期：2026-07-27
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
| workspace artifact | checkpoint provider | 保存/验证 workspace 状态，不能单独授权 continuation |

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
7. scanner 和 recovery interpreter 由 writer、rebuild、Resolver 共享。

### PR B — Continuation correctness

不变量：

> continuation cursor 只来自 immutable RuntimeEvents；同一 source boundary 至多一个 durable
> claim；祖先与直接 source 使用同一 replay policy。

实施顺序：

1. store 提供 immutable prefix cursor，而不是用 `events.length`；
2. claim key 绑定 source run + immutable high-water/digest；
3. claim 创建使用 SQLite unique constraint/transaction，而非“先查后建”；
4. plan 与 execution revalidation 使用同一 envelope；
5. immediate source 与 ancestor segment 共用 provider suffix trimming；
6. mutable partial 只用于 UI，不能进入 cursor；
7. clone 有 recovery refs 时必须完整重写 ID，或明确拒绝。

Crash matrix：

- claim durable 前/后崩溃；
- startup resume 与手动 resume 并发；
- 二代、三代 continuation；
- interrupted text/thinking suffix；
- partial snapshot 与 immutable cursor 并存。

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
- before identity 与 expected-after identity；
- transform/algorithm version；
- worker 生成的 production-shaped result；
- size、regular-file、symlink、UTF-8 等观察边界。

正常执行与 prepare 必须共用 Write/Edit transform；filesystem worker 保持 permission profile、
sandbox、one-call grant 和 abort boundary 的执行所有权。

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
- Desktop 与 CLI 同 workspace 的 owner 冲突策略。

## 3. Native 与 Git 的能力边界

### 无 Git CLI / 非 Git workspace

Native 支持止于单次 operation：

- Write/Edit 的 before/expected-after evidence；
- 崩溃后 after-state finalize；
- 不能证明时 park；
- 不建设 native workspace manifest 或 CAS object store；
- 不提供 workspace-wide drift、isolated restore 或 durable rebaseline。

### 有 Git CLI 且 workspace 是 eligible repository

Git 是 workspace continuity carrier，而不是单文件因果证明的前置条件：

- workspace snapshot；
- RuntimeEvent boundary 与 Git tree/commit 绑定；
- workspace-wide drift detection；
- isolated worktree restore；
- durable rebaseline；
- object retention 与 GC。

## 4. Phase 3B：Checkpoint 语义

### PR E — Checkpoint contracts

先定义纯语义和 fake provider，不接 Git：

```ts
interface WorkspaceBoundary {
  workspaceIdentity: string;
  workspaceEpoch: number;
  immutableRuntimeHighWater: number;
  immutableRuntimeDigest: string;
  checkpointRef: string;
  checkpointPolicyHash: string;
}
```

需要证明：

- checkpoint 绑定的是 immutable boundary，不是 mutable UI snapshot；
- cwd 切换产生明确 workspace transition；
- checkpoint provider 只能 capture/verify/materialize，不能自行批准 resume；
- required/optional/legacy host policy 有稳定结果；
- plan 与 execution revalidation 使用同一 boundary。

### PR F — Canonical checkpoint bundle

把 checkpoint accepted fact 与 RuntimeEvent boundary 原子绑定：

- fact 只有一个 canonical writer；
- projection 可重建；
- checkpoint ref、workspace identity、epoch、high-water、digest 全部交叉校验；
- artifact 已生成但 fact 未提交时允许 GC；
- fact 已提交但 artifact 缺失时 fail closed。

## 5. Phase 4A：Git observe/capture

### PR G — Observe-only Git carrier

先只读验证：

- repository/worktree identity；
- HEAD/tree/index/dirty state；
- ignored/untracked policy；
- submodule、LFS、sparse checkout、case sensitivity 能力探测；
- 不写 ref、不改用户 index、不改 working tree。

不合格仓库降级到 native operation recovery，不伪装具备 workspace continuity。

### PR H — Production capture + retention

- 使用 Maka 自有 ref namespace 或独立 object ownership；
- capture 不修改用户 branch/index；
- checkpoint fact 接受后才成为 durable root；
- quota、retention、orphan GC；
- p50/p95 capture 延迟和磁盘增量 telemetry；
- host lifecycle 完成后才默认启用。

## 6. Phase 4B/4C：恢复与 rebaseline

### Isolated restore

workspace drift 时默认恢复到隔离 worktree/目录，不覆盖用户当前工作：

1. verify checkpoint；
2. materialize isolated workspace；
3. 写 workspace transition fact；
4. continuation 在新 identity/epoch 下开始；
5. 用户当前目录保持不变。

### Durable rebaseline

“以当前文件为准继续”不是忽略错误：

1. capture 当前 workspace；
2. 持久化新 baseline fact；
3. increment workspace epoch；
4. 告知模型必须重新读取受影响文件；
5. continuation 只引用新 boundary。

## 7. 依赖顺序

```text
PR A persistence authority
 ├─> PR B continuation correctness
 └─> PR C file finalize-only recovery

PR B + PR C
 └─> PR E checkpoint contracts
      └─> PR F canonical checkpoint bundle
           └─> PR G observe-only Git
                └─> PR H capture + retention
                     ├─> isolated restore
                     └─> durable rebaseline

PR D host lifecycle 必须在 production capture/auto-resume 默认开启前完成。
```

## 8. 工程门槛

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
- checkpoint capture p50/p95；
- `workspace_drift`、`mode_mismatch`、`artifact_missing` park 比例；
- 自动恢复成功率必须把长命令、大仓库、dirty workspace 纳入分母。

## 9. 不做的承诺

- PR A 不提供真实工具自动恢复；
- PR B 不恢复 workspace；
- PR C 不自动 redo stale before-state；
- 无 Git 环境不提供 workspace snapshot；
- Git carrier 不覆盖用户当前工作区；
- 无法证明的 Bash/远程 API 副作用不自动重试；
- process-crash transaction atomicity 不等于断电级 durability。
