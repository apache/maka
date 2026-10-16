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

# ACP PR8：Goal/Plan 执行设计与任务拆解

- 日期：2026-09-26。状态：设计完成，待实现；本文不代表功能或测试已完成。
- 需求：[Issue #3132](https://github.com/apache/maka/issues/3132) 及其 [ACP v1 tracker 的 PR8](https://github.com/apache/maka/issues/3132#issuecomment-5386735709)。
- 本地分析基线：`main@87217d370`，已经包含 PR6（#5621）。核对时官方 main 为 `87fc9f69cd11648f31048c1b633bb813aca5f515`。
- 实施者：新的 Codex 任务，模型 `gpt-6-sol`，reasoning effort `high`，使用独立 worktree。
- 本轮只做静态分析、设计和拆解，没有修改实现代码、运行功能测试或发布 GitHub 评论。

## 1. 交付边界

PR8 交付六个具体 `_maka/` 请求，连接 Host 已有 Goal/Plan 能力，并让客户端在没有新的普通 prompt 时也能接收后台执行的文本、工具、交互和状态。Host 继续独占执行准入、持久化、预算、冲突判断和状态转换。

纳入：

1. `goal.query / goal.arm / goal.control / plan.query / plan.control / plan.turn.start` 的 ACP 路由与输入校验。
2. 使用 PR6 的 retained attachment、唯一 Turn observer 和 pending interaction 恢复路径，先观察再启动。
3. Goal 权威投影通知、Plan 变更提示及权威分页查询；重连后的状态刷新。
4. 准入响应与执行完成分离；重复请求、响应丢失、过期审批、外部控制、取消、close/EOF 的处理。
5. 官方 SDK → ACP stdio → 真实 Host 的执行验收，以及文档/能力声明。

不纳入：PR7 Artifact/Memory、ACP client/Antigravity、ACP v2、steering、新调度器、Plan/Goal 状态机、存储格式变更、通用 CRUD/RPC 框架、全量 PR6 资源所有权重构、Desktop UI 改造。PR8 仅依赖已合并 PR6；不导入 PR7 分支代码。

当前未跟踪的 `acp-session-restore-refactor-plan.zh-CN.md` 是独立重构提案，不是已存在的 SessionHandle 实现。PR8 可提取自己实际复用的窄接口，不应顺手完成该提案。

## 2. 已核实的事实与设计决定

| 当前事实 | PR8 决定 |
| --- | --- |
| `goal.arm` 保存 active Goal，独自调用不会启动 Turn | 保留原语义；以一次用户明确发出的普通 prompt 开始首次工作，此后 Host 自行续跑。不得暗发 prompt，或暗做 pause/resume 来启动 |
| `goal.control.resume` 通过 Host continuation 恢复驱动 | 调用前安装观察和交互客户端；不在 adapter 内轮询并调度下一轮 |
| `plan.control` 是状态转换；普通控制在活跃 root 下可返回 `session_busy` | 原样保留五种 control 输入及 Host 结果；不隐式停止 Turn |
| `plan.turn.start` 在 Host 内结合 approve/resume 与 root admission | 执行按钮直接调用此操作；不能先 `plan.control(approve)` 再 start |
| Plan control 有 `operationId`；Plan start 使用调用者提供的 `turnId`，Host 将它作为控制 operation identity | 原样传递，不以 JSON-RPC request id 替代，不在重试时重新生成 |
| Goal control 需要 `goalId + expectedRevision`；arm 没有幂等请求 ID | 不自动更新 revision 重试；不能承诺 arm 的 exactly-once 或把相同 condition 当作同一请求 |
| Plan query 是 `list_start/list_continue`，每页最多 16 条、结果最多 64 KiB，可能返回 `revision_changed` | 保留分页，禁止 adapter 无界合并所有历史计划或静默重启翻页 |
| `AcpTurnObservation` 已支持非 prompt Turn；`_maka/turn/status` 已有终态通知及能力协商 | 复用，不增加第二个 reader，不伪造 prompt response，也不改现有终态枚举 |
| Session channel 已有 `onGoalChanged`、`onSessionDomainChanged`、snapshot/recovery callback | 从原订阅刷新状态，不新增仅为状态刷新而开的 subscription |

关键代码依据：`packages/runtime-host/src/protocol/{goal,plan}.ts`、`server/{goal,plan}-coordinator.ts`、`packages/runtime/src/goal-continuation.ts`、`packages/cli/src/acp/{maka-acp-agent,session-registry,turn-observation}.ts`、`packages/cli/src/runtime-host-session-channel.ts`。

首次 Goal 流程明确为 `new/load → goal.arm → 用户的 session/prompt → Host continuation → goal.control`。验收“无需再发 prompt”指启动后的后台续跑、显式 Goal resume 和 Plan start，不改变 arm 的产品含义。

Plan 的“恢复”区分两种：`plan.turn.start(resume_execution)` 恢复计划执行；既有 `_maka/turn/resume` 恢复中断 Runtime Turn，仍受其安全计划约束。不可互相替代或级联调用。当前 Plan 状态是否可恢复由 Host 决定，不保证已取消计划可以恢复。

## 3. 模块结构与依赖

保持现有平铺目录，建议新增三个有实际消费者的模块；命名可随实现微调，责任不可合并回 Registry。

| 模块 | 责任 | 明确不拥有 |
| --- | --- | --- |
| `goal-plan-routes.ts` | 注册六个具体方法、复用 Host decoder、构造客户端上下文、声明能力 | Host 连接、Session Map、业务状态 |
| `goal-plan-operations.ts` | 六个类型化用例；编排观察准备、一次 Host 请求、结果/错误返回 | 第二套 attachment/Turn 索引、预算/审批政策 |
| `session-domain-observation.ts` | 每 attachment 的 Goal/Plan 通知、刷新合并、生命周期栅栏和有界投递 | 调度、持久化、Plan 状态机、完整历史缓存 |
| `session-registry.ts`（现有） | ownership、共享连接/attachment、关闭代次、用例装配 | 新增 Goal/Plan 业务算法和复制的刷新状态集合 |
| `turn-observation.ts`（现有） | 唯一输出消费者、admission/Stop/终态投递生命周期 | Goal/Plan 业务状态转换 |
| 现有 MCP、interactions、mapper、Session channel | 保留各自原责任 | 不为 PR8 分叉新实现 |

依赖方向：`agent → routes → typed operations → 窄 Session ports → 现有 Registry/channel/Host`；Domain observer 通过注入的 query/notify/lifetime 接口工作，不反向引用 Registry 类。

窄接口只暴露本 PR 用到的能力：检查 owned/open、取得指定 Session 的 Host 请求能力、准备 retained observation、为确定 turnId 建立 admitted observation、检查当前 attachment 身份/关闭代次。不要把整个 Registry、private Map、MCP manager 或 channel 内部队列传进新模块。

允许从现有路径提取两项真实复用逻辑：

- Host 错误映射：将现有 mapper 连同原调用点一起迁移到小模块；保留旧错误 data 语义，避免新增模块复制一份。
- 非 prompt admission 准备：在 PR6 `_maka/turn/resume` 与 PR8 `plan.turn.start` 两个实际消费者之间共用“安装 presentation/interaction、等待 MCP ready、attachment、预注册 observer、保留 unknown outcome”的机械步骤。恢复安全查询和 Plan 审批各自留在用例内，不抽象整个命令事务。

Goal arm/resume 只需 retained observation，不预造 turnId，也不创建虚假 admitted Turn。Domain observer 每个 attachment 最多一个，销毁和替换由 Registry 的现有生命周期统一触发。

## 4. 对外协议

### 4.1 请求与响应

| ACP 请求 | Host 操作 | 输入及成功响应 |
| --- | --- | --- |
| `_maka/goal/query` | `goal.query` | 原样 `GoalQueryInput → GoalQueryResult` |
| `_maka/goal/arm` | `goal.arm` | 原样 `GoalArmInput → GoalArmResult`；maxIterations/tokenBudget 的 null 保持 Host 含义 |
| `_maka/goal/control` | `goal.control` | 原样 `GoalControlInput → GoalControlResult`，action 为 pause/resume/clear |
| `_maka/plan/query` | `plan.query` | 原样 `PlanQueryInput → PlanQueryResult`，包括 revision_changed |
| `_maka/plan/control` | `plan.control` | 原样 `PlanControlInput → PlanControlResult`，保留 operationId |
| `_maka/plan/turn/start` | `plan.turn.start` | 原样 `PlanTurnStartInput → PlanTurnStartResult`，保留 plan outcome 和 TurnSnapshot |

复用 `HOST_OPERATION_SPECS[operation].decodeInput`，不重写 validation/constants。六个请求均要求本连接已通过 new/load/resume/copy 获得 Session ownership；知道 Session ID 不等于有控制权。Host 仍做自己的授权和业务校验。

Goal/Plan 成功响应表示 Host 已接受该操作，不表示任务成功完成。Plan start 返回 `{plan, turn}` 后，输出和交互继续走标准 ACP 通道，完成走已有 `_maka/turn/status`。

### 4.2 能力与状态通知

按 [ACP v1 扩展规范](https://agentclientprotocol.com/protocol/v1/extensibility)，自定义方法使用 `_maka/` 前缀，能力写进 `_meta`，不向标准对象根部添加自定义字段。

建议新增：

- Agent `agentCapabilities._meta["_maka/goalPlan"] = { version: 1 }`：表示本文六个请求和两种域通知契约可用。
- Client `clientCapabilities._meta["_maka/goalPlanStatus"] = true`：选择接收域通知；原 `_maka/turnStatus: true` 继续单独控制非 prompt Turn 终态。
- `_maka/goal/status`：`{sessionId, goal: GoalProjection | null}`，携带完整 Host 投影，包括 revision、预算和消耗。
- `_maka/plan/changed`：`{sessionId, storeVersion, latestProposalId, activeExecutionId}`，字段取自成功 `plan.query(list_start)` 的权威 page；这是刷新提示，不能当成完整 Plan 或执行终态。客户端用 query 的分页读取 proposal/execution/steps。

请求能力与通知偏好分开：未订阅通知的客户端仍可调用六个请求并主动 query；普通 ACP 客户端继续收标准文本/工具/交互。方法名称、版本及精确 payload 要在本 PR 的 README 和 SDK 路由测试中固定。

六个路由的观察策略：query 默认只读；若客户端选择域通知，则首次 query 同时通过原 attachment 安装 retained observation 并提供初始快照，后续 query 复用。所有 mutation 在派发前准备 retained observation；load/resume 在选择通知后恢复域观察。这样新建但尚未 prompt 的 Session 也能被观察，不新增 subscribe 方法。

域通知是最新权威状态，不是每次转换的审计日志。允许合并中间刷新；同一 attachment 内不得被迟到旧结果回退。Goal 以 goalId/revision 去重，Plan 以 storeVersion 去重；重连或 canonical replacement 必须失效旧请求并重新读取，不跨 Host epoch 盲比版本数。

Goal 与 Plan 域通知均为尽力投递：发送失败只记录 stderr，不自动重试；若没有后续域更新或 canonical replacement，客户端可能保留旧视图，应通过 `_maka/goal/query` 或 `_maka/plan/query` 恢复权威状态。有界退避只用于刷新 Plan 提示时的 Host 查询失败，不用于通知发送失败。

不保证响应先于通知：Host 可在请求尚未返回时产生输出或域变化，客户端必须先注册 handler，再按 Session、实体 ID 和版本关联。只有 Turn 终态通知需要严格等待该 Turn 的文本/工具输出 flush；域通知不充当输出完成屏障。

### 4.3 错误与未知结果

沿用 PR6 的 JSON-RPC 错误外壳和 `error.data.source/operation/code`；输入 decode 失败为 invalid params，保留 Host 的 operation_conflict、session_busy、session_archived、persistence_failed 等 code，不折叠成通用“失败”。

| 情形 | 对外行为与后续动作 |
| --- | --- |
| 本地取消/关闭发生在 dispatch 前 | 不发送 mutation；撤销本次未共享观察准备 |
| Host 明确拒绝 | 原错误；不更新 revision、换 ID 或重试；撤销本次独占准备，不破坏原 attachment |
| 命令已 dispatch 后连接丢失 | 返回带原 operation、sessionId、可用实体/operation/turn identity 和 `dispatch: dispatched` 的 outcome_unknown；不重发 |
| Plan start 丢响应 | 可复用 PR6 有界 `turn.query` 核实精确 turnId；只有完整且可关联的 plan 与 turn 结果都可建立才返回正常成功，否则保留 outcome_unknown，不伪造 PlanControlResult |
| Goal arm 丢响应 | query 可展示当前事实，但相同 condition/budget 不证明原请求成功；保留不确定性，不能据此自动重新 arm |
| Plan control persistence_failed | 保留 Host code 及未知结果含义；query 恢复可见状态，不自动变更 |
| Plan 状态刷新中的 Host 查询失败 | 不撤销已确认 mutation，不虚报业务终态；保留 dirty，限定重试，日志写 stderr；显式 query 仍能返回可诊断错误 |
| Goal/Plan 域通知发送失败 | 日志写 stderr，不自动重试发送，也不撤销已确认 mutation；客户端通过显式 query 恢复权威状态 |

未确认是否生效的 mutation 必须保留已准备的合法观察/交互资源，直到权威事实、close 或 dispose 决定其生命周期。请求 signal 的结束不等于 retained attachment 的结束。

## 5. 观察、顺序和资源生命周期

### 5.1 启动路径

1. Decode → owned/open 检查 → 获取共享连接，并在异步阶段后验证 Session close generation。
2. 安装或替换非 prompt presentation/interaction client，等待该 Session 的 MCP 当前发布 ready；不重配或清空已有 MCP。
3. 复用 `#ensureAttachment`，安装域 callback；从初始 snapshot/query 建立基线，同时处理其间已经到来的变化。
4. Plan start 用调用方 turnId 在原 observation 索引预注册消费者，然后只发一次 `plan.turn.start`。`onTurnStarted` 发现同一个 Turn 时必须复用它。Goal resume 则提前保留 context，由 callback 接管 Host 生成的 Turn。
5. 返回准入结果后保留 attachment。后续 Turn 通过原 started-turn barrier 顺序接管，文本/工具映射、pending interactions、transcript reconciliation 与 PR6 共用。

扩展启动的取消采用 PR6 admitted observation 的精确 identity 控制，不能只按 Session ID 停止一个可能已经接替的新 Turn。普通 prompt 已有消费者时，Goal/Plan 观察不能再启动第二个 `eventsForTurn` reader。

### 5.2 域状态刷新

Goal 从 `attachment.snapshot.goal` 初始化并消费 `onGoalChanged`；必要的恢复确认使用 goal.query。Plan 消费已有 `onSessionDomainChanged(domain === 'plan')`，触发 `plan.query(list_start)`，只发送有界 changed 提示，不自动扫描全部页。

Domain observer 内部仅持有：attachment/epoch identity、disposed 标记、每域 dirty、一个 in-flight refresh、最后已投递版本、最新待投递快照。刷新中再次收到变化则标 dirty，完成后补读一次；不能丢最后一次 invalidation，也不能为每帧建立无限 Promise 链。

重连时不仅依赖“Goal 值变了”：Plan 内容不在 Session snapshot 内，即使 root/Goal 未变也需要重新 query。复核 channel 的 `onRecovered` 触发条件（当前仅在 replacedLiveState 时调用）和 canonical `onSnapshotChanged` 路径；如现有回调不能可靠区分重建，新增一个明确、可选的 canonical-replacement callback，并由 ACP 实际消费。不得悄悄改变 TUI 的旧回调含义或新开订阅。

慢客户端采用一个在途通知加一个最新待发快照合并域状态；Turn 输出继续使用现有有界 mapper/channel。对 initial refresh 与后续刷新失败分别留测试，持续变更时不能用无界循环阻塞请求返回。

### 5.3 控制语义

| 操作 | 效果 | 不可隐式附加的动作 |
| --- | --- | --- |
| goal pause | 请求 Host 暂停 Goal 驱动，采用 Host 的现有在途处理 | 不承诺当前 Turn 已停、不改 Plan |
| goal resume | 请求 Host 恢复对应 Goal generation | 不创建替代 Goal、不发送普通 prompt |
| goal clear | 请求 Host 清除 Goal，保留返回的 cleared 投影 | 不删除 Session，不把 cleared 结果强行改成 null |
| session/cancel | 按现有逻辑停止所观察的精确当前 Turn | 不保证 Goal 永久暂停，不自动取消 Plan |
| plan.control cancel_execution | 请求取消计划状态；活跃 root 下允许 Host 返回 session_busy | 不偷偷 stop 后重试 |
| session/close、EOF | 保留 PR6 的当前 Turn stop 策略，再释放本连接 attachment、交互等待、MCP 和刷新资源 | 不额外 pause/clear Goal，不删除计划或 Session，不承诺 Host 的独立 Goal 调度永久停止 |

若客户端希望“停止当前工作并禁止 Goal 后续续跑”，应显式先 pause Goal，再 cancel 当前 Turn。若希望取消活跃 Plan，先 cancel 并等待权威终态，再 query 后显式 cancel_execution。Adapter 不将这些多步意图假装成原子操作。

Domain observer 跟随 attachment 的成功安装、失败撤回、detach、close、dispose、revision abandon 清理；旧 query/notify 完成后先校验身份，不能复活资源或向新 attachment 写状态。新的 query/wait 必须可被关闭中断，不能让 EOF 等一个失联 Host 无限挂起。

## 6. 重复、冲突和恢复契约

- Goal control 使用客户端显式提交的 goalId/revision。冲突返回后由客户端 query，再作新的决定；禁止借用配置 CAS 的透明重试。
- Plan control 的相同 operationId/输入由 Host receipt 判定；相同 ID、不同输入应保留冲突。Adapter 不建立持久化去重 store。
- Plan start 的重复 turnId 由 Host 的 admission/digest 规则判定；本地只复用一个 observer，绝不能导致第二次真实执行。并发重复请求不能因其中一个失败而 dispose 另一个已经接管的 observer。
- `revision_changed` 原样返回；客户端丢弃旧分页结果，从 list_start 重新阅读并重新审批。不能混合不同 storeVersion 的页。
- 同一连接重连只重建观察并查询事实，不重播 arm/control/start；新 ACP 进程需 load/resume 获得 ownership，域通知偏好重新协商。
- 不声称跨连接通知 exactly-once。重新 load 可重复展示历史；它与重复执行是两个不同问题。
- 不由“当前 Goal + 当前 Turn”推断因果归属。只发送 Host 确认的 identity；Goal/Plan 快照和 Turn 状态按 Session 关联展示，不虚构某个 Turn 的 goalId/executionId。

## 7. 实现任务与完成条件

以下是一个 PR 内的可审查提交切片；每片带自己的测试和生产消费者。若拆成多个 PR，必须遵循 tracker“仅依赖已合并前置”的规则，不能依赖未合并堆叠证明功能。

| 顺序 | 工作 | 完成证据 |
| --- | --- | --- |
| T0 基线 | 在独立 worktree 核对最新官方 main、PR6 已合入、PR7 是否仍未合并；读适用规则；重建并跑 ACP/Host 定向基线 | 记录 SHA、命令、已有失败；核对 SDK 仍按锁文件，不顺手升级 |
| T1 Goal 纵向切片 | 六路由的基础只先落实际 Goal 三路由；复用 decoder/错误映射，准备 retained observation，Goal status 初始值与变化 | SDK new→arm/query→prompt→后台续跑→pause/resume/clear；arm 本身不发起模型调用 |
| T2 Plan 读取与控制 | Plan query/control、分页/冲突、Plan changed、域观察器的最小刷新合并 | SDK 读取真实 proposal，多页与 revision_changed；五种 control 输入均到 Host；外部修改后通知并 query 得到新事实 |
| T3 Plan 启动 | 提取并迁移 PR6/PR8 共用的非 prompt admission 机械步骤，接入 plan.turn.start | approve/start 和 interrupted resume 都可得到 admission、标准输出/交互、终态；只发一次 Host 命令，无额外 prompt |
| T4 时序加固 | 并发重复、未知结果、presentation 替换、取消/close/EOF、canonical refresh | deferred/barrier 测试证明单订阅、单消费者、迟到结果不污染、未知结果保留可观察性、资源可释放 |
| T5 交付 | 更新 ACP README/VALIDATION、能力矩阵和 SDK 用例；完成相关回归 | 每项功能有真实路由证据，测试对应最终 SHA；清楚列出未运行平台/客户端检查 |

推荐依赖 `T0 → T1 → T2 → T3 → T4 → T5`。不要先创建尚无生产调用者的通用路由表或 admission 框架。文档和定向验证随每片更新，T5 只做最终集成核验。

## 8. 必须覆盖的验证矩阵

| 场景 | 验证断言 |
| --- | --- |
| Goal 首次驱动 | arm 保存正确预算/次数，无模型调用；显式首次 prompt 后，至少一轮 Host continuation 的文本、工具、交互无需额外 prompt 即到达 |
| Goal 控制 | pause/resume/clear 使用精确 generation；预算/终态来自 Host；过期 revision 不重试；resume 的后台 Turn 可观察 |
| Plan 真实生成 | 用可控模型服务经普通 plan-mode prompt 生成 proposal，再经 ACP query 读取；关键闭环不靠直接写数据库造计划 |
| Plan 执行 | query→plan.turn.start(approve)→真实输出/工具/交互→terminal；模型通过真实 update_plan 推进 steps，可 query 核验 |
| Plan 恢复与取消 | 中断执行后的 resume_execution 成功；活跃 control 返回忙；显式 stop/等待/取消状态链路正确；不可恢复状态保留 Host 拒绝 |
| 分页与审批 | 多页保持 storeVersion，翻页变化返回 revision_changed，旧审批 revision/storeVersion 冲突，不自动刷新并批准 |
| 重复请求 | 相同/不同 operationId 与输入组合、相同 turnId 并发/重连重发；实测模型运行次数不增加，观察者不互相释放 |
| 命令结果丢失 | mutation 已提交但响应丢失；adapter 零自动重发，精确身份保留；Goal 相同内容不被误判为同一次 arm |
| 外部控制 | 第二 Host 客户端改 Goal/Plan，原 ACP attachment 收更新并 query 得到权威状态，无第二订阅 |
| 输出顺序 | Turn 输出阻塞时 successor 已开始/结束，仍保持原 barrier；终态晚于其标准输出；没有无关 prompt response |
| 权限与交互 | pending permission/form 恢复、外部回答、客户端缺能力、通知失败；Host 保持答案权威；不能扩大 PR6 的停止策略 |
| 重连/恢复 | root/Goal 不变但 Plan 已改变，仍能刷新；旧 query 晚返回不得回退；新进程 load 后不重启执行 |
| 资源退出 | query/attach/dispatch/notify 各阶段取消、close、EOF、abandon；无残留监听、挂起刷新或 MCP 进程；等待共享消费者不互相撤销 |
| 标准兼容 | 不声明扩展通知能力时，普通 initialize/new/prompt/cancel/load/resume/close 与 PR6 行为一致 |

测试位置建议：`acp-agent.test.ts` 增加路由/能力/decoder；新增 `acp-goal-plan-operations.test.ts` 与 `acp-session-domain-observation.test.ts`；现有 registry/restore 测试保留回归断言；新增 `acp-goal-plan-child-process.test.ts`，复用现有官方 SDK 子进程 harness、可控模型服务及 MCP fixture。

内部假 Host 用于制造确定竞态，真实 ACP/Host 进程用于证明执行效果。时间同步用 deferred/事件屏障，timeout 只防挂，禁止用固定 sleep 当正确性断言。不需要外部模型 API key 来完成可控模型服务的测试。

## 9. 验证命令与发布门槛

以实施时 package.json/CI 为准；当前 CLI workspace 名是 `maka-agent`，不是 `@maka/cli`。

```sh
npm --workspace maka-agent run build:workspace-deps
npm --workspace maka-agent run build
node --test packages/cli/dist/__tests__/acp-*.test.js
npm --workspace maka-agent run test:dist
npm --workspace @maka/runtime-host run test:dist
npm run typecheck
npm run lint
npm run format:check
npm run check:cli-third-party-notices
npm run check:asf-headers
git diff --check
```

依赖构建若需要额外 workspace，按仓库真实依赖补齐；不能把旧 dist 通过算作新实现验证。共享 channel 改动必须补 TUI session driver 与 subscription/projector 回归；公共 Host seam 改动必须补 Host Goal/Plan、admission、continuity 回归。最终执行仓库要求的 build/test/协议兼容检查，平台 CI 覆盖按实际可用性记录。

不预期修改 Host wire schema、epoch、SDK 或依赖。如果发现做不到，先记录具体缺失契约及影响，再作独立小范围设计，不用更改 Host 状态机绕过 adapter 难题。Zed smoke 用于验证标准流程；它不替代私有扩展的官方 SDK 测试。

Done 同时要求：六个请求可用、Goal/Plan 真实执行可观察、命令不自动重发、控制/关闭语义明确、单订阅/单 Turn consumer、失败清理与跨客户端刷新有证据、文档匹配实际能力。PR7 未合并时不能宣称 #3132 整体完成。

## 10. 基线变化与交接约束

核对时官方 main 比本地多 4 个提交，其中 `8d5a3cac3`（#5721）删除 `form_interaction`、`transcript_changed` 及相应 CLI/Host 恢复分支，Host epoch 为 189。实现必须基于最新已合并代码复核恢复测试，不复制本地旧分支的这些已移除行为。其余提交主要为 UI，但依赖锁文件也有变化。

新任务应首先读取本文，将它复制进自己的独立 worktree 作为设计基线，再完成 T0。新任务可以实现、测试和整理本地提交；本轮交接不要求发布评论、合并、部署或自动修改 issue tracker。需要调整设计时，在本文记录已核实的原因与新契约，保持用户要求的清晰边界、稳定结构、低耦合和实际复用。

当前工作区已有另一份未跟踪设计文件，应原样保留。不要把本任务之外的工作区文件或改动带进实现提交。

## 11. 实施核对（2026-09-26）

独立 worktree 采用官方 main `87fc9f69cd11648f31048c1b633bb813aca5f515`，
已包含 PR6；核对时 PR7 #5685 仍为 open。SDK 维持锁文件中的 1.4.0，
未修改 Host wire schema、epoch 或依赖。#5721 删除的旧恢复路径未被重新引入。

六个请求、两类域通知与真实 SDK/stdio/Host/可控模型闭环已落地，实际协议
和本设计第 4 节一致。实现中唯一新增的 channel 契约是可选的
`onCanonicalReplacement(snapshot)` 回调：它只在真正替换权威订阅时触发，
用于即使 Goal/root 不变也刷新 Plan；原 `onRecovered` 和 TUI 语义不变。
丢失 Plan 启动响应时保留 `outcome_unknown` 与观察，并对精确 `turnId` 启动
已有的有界 admission query；不会从仅有的 Turn 事实伪造 Plan 结果。

验证记录见 `packages/cli/src/acp/VALIDATION.md`。尚未运行的客户端/平台检查
也列于该记录。
