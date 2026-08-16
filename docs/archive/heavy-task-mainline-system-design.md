---
title: Maka heavy-task / Terminal-Bench 主线 System Design
document: MAKA_HEAVY_TASK_MAINLINE_SYSTEM_DESIGN_V1
version: 1.0
status: design draft with rationale
date: 2026-06-24
audience: "准备实现、评审或维护 Maka heavy-task / Terminal-Bench 路径的新工程师"
derived_from:
  - "Maka heavy-task / Terminal-Bench 主线教学手册 v1"
  - "Maka heavy-task teaching outline"
  - "issue #102 / PR #121-#183 chronology reader"
  - "current heavy-task code contract reader"
  - "discarded P1-b/P1-c/P1-d branch reader"
  - "Terminal-Bench trace behavior reader"
---

> Archived on 2026-07-13. This is a PR, trace, and rollout chronicle, not current policy authority. The Headless heavy-task mechanism it describes was retired by #2598.

# Maka heavy-task / Terminal-Bench 主线 System Design v1

这份文档不是教学手册的压缩版，而是从教学手册反推出来的一版系统设计文档。

教学手册回答的是：

> 新人应该怎样一步一步理解 issue #102 后的 Maka heavy-task 主线？

系统设计文档回答的是：

> 如果我们要把 heavy-task 作为 Maka 长期 benchmark task-run 能力，哪些边界、状态、事件、fallback、trace 解释和 rollout 纪律必须固定下来？

本文的中心设计判断是：

> Maka heavy-task 是一个薄的、公开的、持久的 benchmark 工程师循环。它把 inventory、todo、runnable artifact、public check、semantic self-check 和 compact evidence 变成可持久、可投影、可导出的路标，但不改变 official verifier/scorer 的外部权威。

换句话说，这不是一个 benchmark hint 系统，也不是一个 live proof-chain 框架。

它是 Maka 现有 headless task-run 主线上的一层 discipline：

```text
runTaskOnce
  -> resolve heavy-task mode
  -> append heavy-task policy
  -> project prior task-run state
  -> expose thin model-visible submit tools
  -> capture compact public evidence internally
  -> append task-run events
  -> project progress / semantic completion / official result
  -> export diagnosis without changing verifier authority
```

本文面向 Maka 新人开发者。读者不需要先记住 issue #102 的所有 PR，但需要知道 Maka 里大概有这些概念：

```text
headless task run
RuntimeRunner / AiSdkFlow / ModelAdapter
isolated tools
TaskRunStore
Terminal-Bench / Harbor
verifier / scorer / reward
public task files
hidden evaluator
```

## 0. 设计问题从哪里开始

heavy-task 的设计不是从某个工具名开始的，而是从一组冲突压力开始的。

最朴素的问题是：

> 一个长 benchmark task 为什么经常失败在“最后一步之前”？

常见答案是：

> 因为模型不够强，或者 prompt 不够长。

这个答案不够。Maka/Terminal-Bench 的 trace 显示，更真实的问题包括：

1. **长任务会丢状态。**
   一个 attempt 可以花几十分钟、几十到上百个工具调用。失败、超时或 retry 后，如果系统只给下一轮一段普通 transcript，模型很容易重新研究，不能直接继承工程进度。

2. **公开证据和 hidden verifier 有硬边界。**
   benchmark integrity 要求模型只能基于公开 task files、公开命令输出、公开 artifact 做判断。系统不能把 hidden evaluator、官方断言、任务专属阈值或 evaluator-only 文件泄露给模型。

3. **模型自检不是官方判分。**
   `self_check_submit(status=pass)` 只表示模型基于公开证据认为完成。official verifier/scorer 才决定 reward。

4. **维护状态也会消耗预算。**
   如果模型花太多步填写 audit record、repair chain、evidence chain，它会少写代码、少跑检查、少修 artifact。过重的 live bookkeeping 会让机制反过来伤害 benchmark。

5. **最终自检可能污染 verifier start state。**
   公开检查会生成临时输出。若这些输出留在 official verifier 可见的起始状态里，模型可能在公开自检中通过，却让官方运行从脏状态开始。

6. **timeout retry 不是 checkpoint resume。**
   当前 autonomous retry 能投影 prior heavy-task progress，但不是恢复同一个 model session、同一个 mutable workspace checkpoint 和未完成工具调用。把 retry 当成 resume 会误判产品能力。

所以 heavy-task 的设计问题不是“加更多提示”，而是：

> 在不泄露 hidden verifier、不新增重型审计热路径、不改变官方判分权威的前提下，怎样让长 benchmark task 的工程进度变得公开、持久、可投影、可解释？

## 1. 设计目标

### 1.1 持久公开进度

模型应该能把公开工程进度写进 task-run ledger：

```text
inventory: 我看到了哪些公开输入、文件、artifact，它们当前是什么状态
todo: 接下来要做什么，哪个 todo 是 runnable artifact，哪个是 public check
self-check: 基于公开证据，我为什么认为完成或未完成
```

这些状态必须跨 attempt 可投影。否则 retry 后只剩长 transcript，下一轮很难知道“已经走到哪一步”。

### 1.2 薄 live path

模型实时可见的 heavy-task 工具要少：

```text
inventory_submit
todo_update
self_check_submit
```

普通工程动作仍然通过已有 isolated tools 完成：

```text
Bash
Read
Write
Edit
Glob
Grep
agent_spawn
agent_list
agent_output
```

compact evidence 由工具执行后内部捕获，不暴露成模型要填写的工具。

目标是把模型推向：

```text
写 artifact -> 跑公开检查 -> 修复 -> 再检查 -> 公开语义自检
```

而不是推向：

```text
维护证明链 -> 补审计表 -> 解释每一步为什么合理 -> 最后没时间写 artifact
```

### 1.3 Benchmark integrity

所有 heavy-task 状态都必须是 public-source-bearing。

系统可以记录：

```text
公开命令 stdout/stderr 的摘要
公开 artifact 的路径、hash、metadata
公开任务文件的 inventory
模型基于公开证据写出的 self-check reason
```

系统不能记录或投影给模型：

```text
hidden evaluator 内容
official verifier 私有断言
evaluator-only 文件
任务专属答案提示
官方阈值泄露
```

### 1.4 Official verifier/scorer 权威不变

heavy-task semantic status 是诊断状态，不是 reward。

系统必须同时保留：

```text
semantic completion: 模型公开自检和 todo 状态是否说“完成”
runtime status: 当前 run 是否因为 step/tool/token/wall-time/budget cap 终止
official result: verifier/scorer 是否通过
```

任何情况下，official result 都不能被 self-check 覆盖。

### 1.5 可观测和可回退

task-run 事件必须 append-only。projection 可以升级，export 可以补字段，prompt replay 可以改窗口，但原始事件不应被改写。

设计需要允许：

```text
回放 task-run
解释为什么 semantic complete 但 reward 0.0
解释为什么 retry 后模型重新研究
解释为什么 finalization eligible 但 bounded final turn 没实现
安全删除或忽略过重的历史设计
```

## 2. 非目标

本设计明确不做这些事：

1. 不给模型 hidden verifier 信息。
2. 不加入任务专属 benchmark 解法提示。
3. 不把 `self_check_submit` pass 当作官方 pass。
4. 不恢复 `engineering_record` / `check_record` / `evidenceChain` 到 live model hot path。
5. 不要求模型维护完整 proof chain。
6. 不把 compact evidence 设计成可还原的完整证据链。
7. 不把 autonomous retry 宣称为 checkpoint resume。
8. 不在当前版本实现 bounded final turn，只暴露 finalization eligibility。
9. 不改变 Harbor/Terminal-Bench 官方 verifier/scorer 的权威。
10. 不把 sqlite-gcov 成功外推成 MIPS 一定成功。

这些非目标很重要。heavy-task 最容易失败的方式，是把“公开工程路标”扩张成“模型热路径审计系统”，或者把“语义完成”误当成“官方通过”。

## 2.5 从问题压力推导设计

### 压力一：长任务需要路标，但路标不能变成任务本身

MIPS trace 里，GLM 多次在前几十个工具调用里做静态分析，直到接近 timeout 才提交 inventory/todo，甚至没有写 `vm.js`。

这说明长任务确实需要状态路标。

但 P1-b/P1-c/P1-d 的回滚也说明，路标太多会变成另一种任务。模型会把维护 audit/proof-chain 当成工作本身。

设计结论：

> 只保留 inventory/todo/self-check 三个 live submit surface，把 compact evidence 改成内部自动捕获。

收益：

```text
模型有可持久路标
开发者能回放进度
retry 能投影关键状态
但模型不用维护审计链
```

失败模式：

```text
如果 surface 太少，模型没有跨 attempt 记忆
如果 surface 太多，模型把工程预算花在记录本身
```

### 压力二：模型要自检，但自检不能越权

sqlite-gcov 的成功 trace 显示，模型可以先构建、再跑公开 gcov 检查、最后提交 self-check，并拿到官方 reward 1.0。

MIPS 160-step trace 显示，模型也可以写 artifact、跑公开检查、提交 pass self-check，但官方 reward 仍可能是 0.0。

设计结论：

> self-check 是 public semantic assertion，不是 official pass。

收益：

```text
模型必须说明公开完成理由
系统能诊断“模型认为完成但官方失败”的差异
不会污染官方 benchmark result
```

失败模式：

```text
如果把 self-check 当官方 pass，会破坏 benchmark authority
如果完全没有 self-check，系统只知道失败，不知道模型基于什么公开证据认为完成
```

### 压力三：证据要可见，但不能泄露，也不能无限长

长任务需要证据投影，否则 retry 只能读长 transcript。

但 public evidence 可能很大，stdout/stderr 可能很长，artifact body 可能很敏感，official verifier artifact 不能成为模型依据。

设计结论：

> compact evidence 是 bounded public summary，不是 proof chain。

收益：

```text
retry prompt 能看到最近关键公开观察
export 能展示 progress 和 evidence 摘要
hidden/private/official-verifier pattern 不会进入模型上下文
```

失败模式：

```text
如果全量投影，prompt 爆炸并可能泄露
如果不投影，retry 失去上下文
如果把摘要当 proof chain，开发者会误读其权威性
```

### 压力四：retry 需要 prior state，但不能假装恢复现场

当前 `runAutonomousTask` 复用同一个 `taskRunStore`/`taskRunId`，下一 attempt 可以看到 prior heavy-task progress。

但它不是同一个模型上下文的 continuation，也不是 workspace checkpoint resume。

设计结论：

> retry projection 只是一种 state projection，不能命名或宣传成 checkpoint resume。

收益：

```text
系统诚实表达能力边界
可以先靠 projection 减少重复研究
未来还能单独设计 timeout checkpoint/resume
```

失败模式：

```text
如果产品把 retry 当 resume，用户会以为长 attempt 的动量能完整保留
如果实现把 retry 和 checkpoint 混在一起，状态、workspace、verifier 起点都会变得难以解释
```

### 压力五：最终公开检查可能污染 official 起点

MIPS 160-step trace 的 `vm.js` 在 clean replay 中官方 reward 1.0，但原 run reward 0.0。支持性解释是最终 self-check 留下了 verifier 可见的 generated output，例如 `/tmp/frame.bmp`，导致官方运行从脏状态开始。

设计结论：

> heavy-task policy 需要一条通用 final self-check hygiene 纪律：最终自检前保留 solution files 和 required deliverables，但清理或恢复公开检查生成的临时 verifier-start-state 污染。

收益：

```text
不写 MIPS 专属提示
不泄露官方 verifier 细节
提醒模型把公开检查和最终提交起点分开
```

失败模式：

```text
如果不做 hygiene，公开检查可能改变官方测试起点
如果写成任务专属 cleanup，benchmark integrity 会被破坏
如果 blanket delete，可能删掉任务要求的最终 deliverable
```

## 3. 基础运行脊柱

heavy-task 不是一条新 runtime。它挂在 Maka 现有 headless task-run 主线上。

简化脊柱如下：

```text
runAutonomousTask
  creates/reuses taskRunStore + taskRunId across attempts
  records attempt decisions / verifier feedback / retry state
  calls runTaskOnce per attempt

runTaskOnce
  resolves heavy-task mode
  appends prompt policy when enabled
  projects prior task-run heavy state
  injects prior progress/self-check/evidence prompt fragments
  creates recorders when enabled
  builds isolated tools
  runs backend/model/tool loop
  records verifier/scorer/artifacts/status

TaskRunStore
  append-only task-run events
  projectTaskRun replays events into latest state
  result-export derives public export/progress/completion views
```

这条脊柱给 heavy-task 一个很重要的设计限制：

> heavy-task 只能增强 task-run discipline，不能重写 Maka model/tool stepping engine，也不能绕开 official verifier/scorer。

## 4. 核心系统模型

heavy-task 的核心对象可以分成六类。

### 4.1 ModeFacts

`HeavyTaskModeFacts` 表示本 task-run 是否启用 heavy-task，以及为什么启用。

关键字段：

```text
schemaVersion
enabled
triggerSource
triggerReason
policyVersion
```

设计要求：

```text
默认关闭
config 显式设置优先
config disable 胜过 task metadata enable
policyVersion 必须是安全已知版本
mode selection 必须持久记录到 task-run event
```

为什么要持久记录 mode？

因为后续 export、projection、debug 都需要知道：

```text
这个 run 失败时 heavy-task 到底有没有启用
启用是 benchmark metadata 触发，还是配置触发
当时使用哪版 policy
```

### 4.2 Inventory

Inventory 是模型对公开输入和当前 artifact 的盘点。

典型 item：

```text
path
kind
status
purpose
evidence
```

设计要求：

```text
记录完整 snapshot，不记录增量 patch
append 到 task-run event
prompt replay 只投影 bounded latest inventory
只能描述公开来源
```

Inventory 不是文件索引器。它的作用是让模型和后续 attempt 记住：

```text
哪些公开材料已经看过
哪些 artifact 已经存在
哪些东西是输入，哪些东西是输出
当前状态是否 still missing / inspected / generated
```

### 4.3 Todo

Todo 是可执行工程计划，不是长篇计划文档。

关键字段：

```text
id
content
kind
status
priority
evidence
```

重要 kind：

```text
runnable_artifact
public_check
repair
final_self_check
```

设计要求：

```text
记录完整 todo snapshot
最多一个 in_progress
semantic complete 要求所有 todo completed 或 cancelled-with-evidence
semantic complete 要求 completed runnable_artifact 和 public_check phase gates
```

Todo 的核心作用是把模型从“继续研究”推向“下一步可执行动作”。

如果 todo 没有 `runnable_artifact` 和 `public_check`，模型可能写出一个很好看的计划，但没有最小可运行产物和公开检查闭环。

### 4.4 SemanticSelfCheck

Self-check 是模型基于公开证据提交的语义判断。

关键字段：

```text
status: pass | fail | inconclusive
publicReason
commandEvidence
artifactEvidence
source guard result
accepted/rejected
```

设计要求：

```text
必须有 publicReason
必须至少有 command 或 artifact evidence
所有字符串经过 hidden/private/evaluator-only source guard
只有 accepted self-check 进入 latest projection
self-check pass 只影响 semantic status，不影响 official result
```

Self-check 的价值不是证明官方通过，而是给失败分析提供一条清晰分叉：

```text
模型没有自检就结束
模型自检 fail / inconclusive
模型自检 pass 但 official fail
模型自检 pass 且 official pass
```

### 4.5 CompactEvidenceEnvelope

Compact evidence 是 ordinary tools 和 runtime artifacts 的 bounded public 摘要。

它来自内部 recorder，而不是模型工具。

典型来源：

```text
Bash stdout/stderr summary
Read/Grep bounded observation
Write/Edit mutation summary without body/diff
Glob result summary
runtime artifact metadata
accepted self-check command/artifact evidence
```

设计要求：

```text
bounded excerpt
byte counts / truncation metadata
redact hidden/private/official-verifier-like patterns
Write/Edit 不捕获 mutation body
official verifier artifacts 不进入模型 evidence projection
prompt replay 只投影最近窗口
export 只给 recent bounded window
```

Compact evidence 的名字故意不叫 proof。

它回答：

> 最近有哪些公开观察可能帮助下一轮少重复？

它不回答：

> 这条链是否足以证明 official pass？

### 4.6 CompletionStatus

Completion status 分三层：

```text
runtime
semantic
finalization
```

`runtime` 表示 run 怎样终止。cap-like 包括：

```text
step cap
tool cap
token cap
wall-time cap
max attempts
timeout
budget cap
```

普通 verifier failure 不是 cap-like。

`semantic` 表示公开语义上是否完成：

```text
heavy-task enabled
latest accepted self-check exists
self-check status = pass
latest todos non-empty
all todos completed or cancelled with evidence
runnable_artifact and public_check phase gates completed
```

`finalization` 表示是否具备 bounded final turn 的条件：

```text
eligible = semantic complete && runtime cap-like
boundedTurnImplemented = false
```

这层设计避免把三个问题混在一起：

```text
模型是否认为完成？
运行是否因为限制终止？
官方是否通过？
```

## 5. 组件边界

### 5.1 `heavy-task-policy.ts`

职责：

```text
resolveHeavyTaskMode
append heavy-task system prompt policy
define policy version
normalize config / benchmark metadata / generic task signal
block unsafe policy version injection
```

设计边界：

```text
只负责是否启用和模型应该遵守的 public engineering loop
不记录 progress
不记录 evidence
不评价 semantic completion
不接触 official verifier
```

新人评审时重点看：

```text
prompt 是否保持 benchmark-generic
是否出现任务专属提示
是否恢复了 proof-chain/audit-chain 语言
是否清楚说明 self-check advisory / official authoritative
是否包含 final hygiene 的通用表达
```

### 5.2 `heavy-task-progress.ts`

职责：

```text
build inventory_submit tool
build todo_update tool
validate inventory/todo snapshot
append heavy_task_inventory_recorded / heavy_task_todos_recorded events
render bounded latest progress for prompt replay
```

设计边界：

```text
progress 是公开工程状态，不是官方结果
snapshot append-only，不原地改写
prompt rendering 有窗口，不把全部历史塞回模型
```

新人评审时重点看：

```text
todo 是否最多一个 in_progress
todo kind 是否支持 phase gate
cancelled todo 是否需要 evidence 才能 nonblocking
render 是否 bounded
```

### 5.3 `heavy-task-self-check.ts`

职责：

```text
build self_check_submit tool
validate public semantic self-check
source guard strings
append accepted self-check event
render latest accepted self-check for prompt replay
```

设计边界：

```text
self-check 是模型公开判断
accepted 只表示通过 source guard 和 schema
pass 不等于 official pass
rejected/private self-check 不进入 latest accepted projection
```

新人评审时重点看：

```text
是否要求 publicReason
是否要求 command/artifact evidence
source guard 是否覆盖 hidden/private/evaluator-only 词形
rejected self-check 是否不会污染 prompt/export
```

### 5.4 `heavy-task-evidence.ts`

职责：

```text
compact ordinary tool observations
compact runtime artifact metadata
compact accepted self-check evidence
redact non-public patterns
append heavy_task_evidence_recorded events
render recent compact evidence for prompt replay
```

设计边界：

```text
不是模型可见 tool
不是 proof chain
不捕获 Write/Edit body
不把 official verifier artifacts 当模型依据
```

新人评审时重点看：

```text
是否 bounded
是否保留 truncation metadata
是否遗漏 official/private redaction
是否把 artifact body 或 raw diff 放进 export
```

### 5.5 `heavy-task-finalization.ts`

职责：

```text
evaluate runtime / semantic / finalization status
classify cap-like runtime outcomes
check todos and phase gates
expose finalization eligibility
```

设计边界：

```text
不改变 task-run taxonomy
不改变 score/result truth
不实现 bounded final turn
不把 verifier failure 当 cap-like
```

新人评审时重点看：

```text
semantic complete 条件是否过松
verifier failure 是否错误进入 cap-like
finalization.eligible 是否被误用为 passed
boundedTurnImplemented 是否仍按真实实现设置
```

### 5.6 `task-run-store.ts`

职责：

```text
append task-run events
project task-run state by replay
derive latest heavy-task inventory/todos/self-check/evidence
derive heavyTaskCompletion
prefer authoritative verifier/score results
filter rejected/self-inconsistent heavy-task states
```

设计边界：

```text
event ledger 是事实
projection 是视图
projection 可以补 warning，但不能篡改 official result
```

新人评审时重点看：

```text
事件顺序 replay 是否稳定
latest pointer 是否按 append order
rejected/private events 是否被过滤
official verifier authority 是否优先
```

### 5.7 `result-export.ts`

职责：

```text
export policy.heavyTask
export heavyTask.completion
export latest/recent progress
export bounded compact evidence
filter non-public/rejected events
preserve legacy result truth
```

设计边界：

```text
export 是观察面，不是新判分面
progress 不能覆盖 score/verifier/taxonomy
compact export 不能泄露 raw private payload
```

新人评审时重点看：

```text
full export 和 compact export 是否都安全
recent window 是否 bounded
task-run taxonomy 是否仍来自 official/runtime truth
```

### 5.8 `tools.ts`

职责：

```text
build isolated headless tools
append inventory_submit / todo_update / self_check_submit when recorders exist
wire compact evidence recorder around ordinary tools
```

设计边界：

```text
model-visible heavy-task tools只有三个
compact evidence recorder 是内部能力
engineering_record / check_record / evidenceChain 不在 current surface
```

新人评审时重点看：

```text
默认工具列表是否没被污染
heavy-task enabled 是否只增加三个 submit tools
ordinary tool observation 是否捕获但不泄露
```

### 5.9 `task-agent-controller.ts`

职责：

```text
runTaskOnce
resolve mode
apply policy
project prior state
inject prior progress/self-check/evidence prompt fragments
create recorders
pass recorders into backend context
record verifier/scorer/artifacts/status
```

设计边界：

```text
这是 benchmark task-run heavy-task recorder wiring 的主入口
它不应该让 self-check 改写 verifier/scorer
它要把 tool identity 和 heavy-task state 都写进 task-run trace
```

新人评审时重点看：

```text
prior state 是否只注入一次
recorders 是否只在 enabled 时创建
backend context 是否携带正确 recorder
artifact/verifier/score authority 是否没被 heavy-task 覆盖
```

### 5.10 `autonomous-agent-loop.ts`

职责：

```text
runAutonomousTask
reuse taskRunStore/taskRunId across attempts
record decisions and feedback
build continuation prompt with prior heavy-task progress
return final projection
```

设计边界：

```text
retry projection 不是 checkpoint resume
continuation prompt 只是下一 attempt 的输入
workspace/session restoration 是另一个系统设计问题
```

新人评审时重点看：

```text
是否复用同一个 taskRunId
retry prompt 是否重复注入同一 evidence
timeout/cancel taxonomy 是否诚实
是否把 retry 误命名成 resume
```

### 5.11 `harbor-cell.ts`

职责：

```text
direct Harbor cell path resolves heavy-task mode for synthetic harbor-cell task
injects prompt policy when enabled
builds isolated tools with heavy-task options if supplied by surrounding context
writes cell output/runtime events
```

设计边界：

```text
standalone runHarborCell 不是完整 task-run recorder wiring
完整 heavy-task task-run persistence 在 runTaskOnce
Harbor cell 证明的是 prompt/tool pass-through boundary 更窄
```

新人评审时重点看：

```text
不要把 harbor-cell policy injection 误读成完整 heavy-task state persistence
benchmark task-run 路径要看 task-agent-controller
```

## 6. End-to-end 运行序列

在 system design 里，end-to-end sequence 不是函数调用表。对 heavy-task 来说，这条运行序列要固定的是四件事：

1. **控制权在哪里切换。**
   `runAutonomousTask` 决定 attempt/retry，`runTaskOnce` 负责单 attempt wiring，backend/model/tool loop 负责执行，Harbor/verifier/scorer 负责官方结果。

2. **状态在哪里落盘。**
   Mode、inventory、todo、self-check、compact evidence、verifier、score、terminal status 都必须成为 task-run events，而不是只停留在 prompt 或 stdout。

3. **哪些信息可以回灌给模型。**
   Prior progress/self-check/compact evidence 可以 bounded projection；official verifier internals、hidden evaluator、private payload 不可以。

4. **哪一层拥有 authority。**
   模型拥有 public semantic assertion；TaskRunStore 拥有 replay/projection；Harbor/verifier/scorer 拥有 official benchmark result。

如果只写普通步骤清单，新人会误解成“把这些函数串起来就行”。正确理解是：这是一条多平面运行协议。

### 6.1 三个平面

heavy-task 的 end-to-end flow 同时有三个平面。

```text
control plane
  runAutonomousTask / runTaskOnce / retry decision / timeout taxonomy

model-visible plane
  prompt policy / ordinary tools / inventory_submit / todo_update / self_check_submit

ledger-projection plane
  TaskRunStore events / projectTaskRun / result-export / compact evidence windows
```

这三个平面不能互相替代。

`model-visible plane` 里的 self-check pass 不能替代 `control plane` 的 terminal status，也不能替代 official verifier result。

`ledger-projection plane` 里的 compact evidence 不能替代 raw public command execution，也不能成为 hidden verifier proof。

`control plane` 里的 retry 不能替代 checkpoint resume，因为 retry 只重新启动 attempt，并用 projection 提供上下文。

### 6.2 端到端总览

设计级 sequence 如下：

```text
runAutonomousTask(task, config, budgets)
  |
  |-- create or reuse taskRunStore + taskRunId
  |-- decide attempt budget / wall-clock budget / retry policy
  |
  |-- attempt N:
        |
        |-- runTaskOnce(task, config, taskRunStore, taskRunId)
              |
              |-- resolve heavy-task mode
              |-- record mode facts
              |-- append prompt policy if enabled
              |-- project prior task-run heavy state
              |-- inject bounded prior state into user instruction
              |-- create recorders if enabled
              |-- build isolated model-visible tools
              |-- run backend/model/tool loop
                    |
                    |-- ordinary tools execute public engineering work
                    |-- compact evidence recorder observes ordinary tool outputs
                    |-- model submits inventory/todos/self-check snapshots
                    |-- recorders append typed task-run events
              |
              |-- run official verifier/scorer path when applicable
              |-- record verifier/score/artifacts/status events
              |-- project task-run
              |-- return projection/result to autonomous loop
        |
        |-- autonomous loop decides finish / retry / stop
  |
  |-- export final projected task-run
```

这张图有一个关键点：

> heavy-task 的 live state 不是单独的 memory store。它是 task-run event ledger 上的 typed events，再由 projection 变成 prompt/export/read-model。

因此，任何实现如果只把 inventory/todo 塞进 prompt，但不 append task-run event，都没有完成 heavy-task 设计。

任何实现如果只在 export 里补一个 summary，但模型 retry 时看不到 bounded projection，也没有完成 heavy-task 设计。

### 6.3 Attempt 启动前：mode 和 policy

单次 attempt 不是直接把模型叫起来。它先要决定：

```text
this task-run 是否启用 heavy-task？
为什么启用？
使用哪版 policy？
这次 attempt 能看到哪些 prior heavy-task state？
```

输入：

```text
task config
benchmark metadata
generic task signals
previous task-run events under same taskRunId
```

输出：

```text
HeavyTaskModeFacts
effective model config with or without heavy-task policy
bounded prior progress/self-check/evidence prompt fragments
```

边界规则：

```text
config explicit disable wins
unknown/unsafe policy version cannot inject model-visible prompt text
disabled mode must not expose half-enabled tools
prior state projection is read-only input to the next attempt
```

这一步的设计目的不是“让 prompt 更长”。它的目的是让每个 attempt 都有可解释的起点：

```text
为什么模型这次看到了 heavy-task policy？
为什么模型这次多了 submit tools？
为什么 retry prompt 里出现了上一轮 progress？
```

### 6.4 Attempt 初始化：recorders 和工具面

当 heavy-task enabled 时，`runTaskOnce` 创建三类 recorder：

```text
progress recorder
  records inventory/todo snapshots

self-check recorder
  validates and records public semantic self-checks

compact evidence recorder
  observes ordinary tool executions and runtime artifacts
```

同时构造模型可见工具面：

```text
ordinary isolated tools:
  Bash / Read / Write / Edit / Glob / Grep / agent_spawn / agent_list / agent_output

heavy-task submit tools:
  inventory_submit / todo_update / self_check_submit
```

这里有一个容易踩错的边界：

> compact evidence recorder 不是模型可见工具。模型不应该被要求手写 evidence envelope。

原因是 live model hot path 要保持薄。模型要做的是公开工程动作：

```text
inspect
write
run
repair
submit public progress/self-check
```

系统在旁边捕获 bounded evidence。这样既能让 retry/export 有证据，又不会让模型把预算花在写审计记录。

### 6.5 Model loop：公开工程微循环

model loop 的目标不是“尽快填完三个 submit tools”。正确的微循环是：

```text
public inventory
  -> next executable todo
  -> runnable artifact
  -> public check
  -> repair or continue
  -> final hygiene
  -> public semantic self-check
```

每一阶段的状态写入不同。

#### 6.5.1 Public inventory

模型应该把公开输入和当前 artifact 状态写成 inventory snapshot。

典型内容：

```text
task instructions / public files already inspected
source files relevant to solution
existing generated artifacts
missing required outputs
current runnable artifact path if present
```

写入事件：

```text
heavy_task_inventory_recorded
```

设计约束：

```text
inventory 不能引用 hidden evaluator
inventory 是 snapshot，不是 append-only todo log
retry projection 只需要 latest bounded inventory，不需要全部历史逐字回放
```

#### 6.5.2 Next executable todo

模型应该把下一组工程动作写成 todo snapshot。关键是要包含 phase-gate todo：

```text
runnable_artifact
public_check
```

写入事件：

```text
heavy_task_todos_recorded
```

设计约束：

```text
最多一个 in_progress
completed todo 要有 evidence
cancelled todo 只有带 evidence 才能 nonblocking
semantic complete 要求 runnable_artifact 和 public_check 都完成
```

这一步的核心不是“计划好看”，而是强迫系统能判断：

```text
模型是否真的进入了写 artifact？
模型是否真的跑过公开检查？
模型是否只是一直研究？
```

#### 6.5.3 Ordinary tools produce public work

模型通过普通工具做实际工程：

```text
Read/Grep/Glob: inspect public inputs
Write/Edit: create or repair runnable artifact
Bash: run public checks
agent_*: optional delegated public work
```

写入事件：

```text
ordinary tool events / task-run runtime events
heavy_task_evidence_recorded from compact evidence recorder
```

设计约束：

```text
Bash stdout/stderr can be summarized, not blindly replayed full-length
Write/Edit bodies are not captured as compact evidence bodies
official verifier artifacts are not model evidence
large output is truncated with metadata
```

这里的 authority 分层很重要：

```text
public Bash check can support self-check
public Bash check does not become official verifier
official verifier later remains external
```

#### 6.5.4 Repair loop

如果 public check 失败，模型应该更新 todo/evidence，然后修复 artifact。

典型事件顺序：

```text
Bash public check -> compact evidence records failure summary
todo_update marks check/repair state
Edit/Write repairs artifact
Bash reruns public check
todo_update marks repair/check completed with evidence
```

设计约束：

```text
repair evidence should point to public check output or artifact observation
do not create task-specific hidden-check claims
do not mark blocking todo completed without evidence
```

#### 6.5.5 Final hygiene

在最终 `self_check_submit` 前，模型需要把 public check 和 official verifier start state 分开。

这不是 MIPS 专属规则。通用规则是：

```text
preserve solution files
preserve task-required final deliverables
remove/reset/explain transient outputs generated only by public self-checks
avoid broad deletion
base cleanup only on visible task/workspace evidence
```

写入可以来自：

```text
Bash cleanup command
todo_update evidence
compact evidence summary
self_check_submit publicReason
```

设计目的：

```text
公开检查可以验证 artifact
但公开检查产生的临时输出不能污染 official verifier 起始状态
```

#### 6.5.6 Public semantic self-check

最后，模型提交 self-check。

输入：

```text
latest inventory
latest todos
public command evidence
public artifact evidence
final hygiene result if relevant
```

写入事件：

```text
heavy_task_self_check_recorded
```

设计约束：

```text
requires status
requires publicReason
requires command or artifact evidence
all strings source-guarded
accepted pass is semantic evidence only
official verifier authority unchanged
```

如果 self-check 被拒绝：

```text
it must not become latest accepted self-check
it must not make semantic status complete
it must not be projected as authoritative prior state
```

### 6.6 Official verifier/scorer：外部权威分叉

模型 loop 结束后，Maka 进入 official evaluation path。

输入：

```text
submitted workspace/artifact state
official benchmark runner/verifier/scorer
task-run runtime status
```

输出：

```text
verifier result
score result
official artifacts
task-run terminal status/taxonomy
```

写入事件：

```text
verifier/scorer/artifact/status task-run events
```

边界规则：

```text
self-check pass cannot skip verifier
self-check pass cannot rewrite score
compact evidence cannot become official evidence
official verifier artifacts cannot be projected back as public model evidence
authoritative verifier/score preference wins in projection/export
```

这一步允许出现看似矛盾、实际合理的结果：

```text
semantic.status = complete
latest self-check = pass
official reward = 0.0
taxonomy = verification_failed
```

这不是系统不一致。它说明：

```text
模型基于公开证据认为完成
官方 verifier 基于外部权威判定失败
二者都要保留，供后续诊断
```

### 6.7 Projection/export：从事件变成读模型

`projectTaskRun` 不是简单读取最后一条 event。它要从 append-only ledger 重建：

```text
heavyTaskMode
heavyTaskInventory / latestHeavyTaskInventory
heavyTaskTodoStates / latestHeavyTaskTodos
heavyTaskSelfChecks / latestHeavyTaskSelfCheck
heavyTaskEvidence / latestHeavyTaskEvidence
heavyTaskCompletion
official result / verifier / score / taxonomy
warnings
```

projection 的派生顺序应该保持清楚：

```text
1. replay raw task-run events in append order
2. filter rejected/private/self-inconsistent heavy-task events from authority positions
3. derive latest public progress pointers
4. derive compact evidence windows
5. derive semantic completion from latest accepted self-check + latest todos + phase gates
6. derive runtime cap-like status from terminal outcome
7. derive finalization eligibility from semantic + runtime
8. preserve authoritative verifier/scorer result truth
```

`result-export` 再把 projection 变成外部可读结果。

导出目标：

```text
让人看懂 heavy-task 发生了什么
让人看懂 semantic/runtime/official 三层为什么不同
让人看懂 retry 时模型看到了哪些 bounded prior state
```

导出禁区：

```text
不导出 hidden/private payload
不把 rejected self-check 当 latest
不把 official verifier artifact 当 model evidence
不让 heavyTask.completion 改写 result.passed / reward / taxonomy
```

### 6.8 Retry：projection continuation，不是 checkpoint resume

retry 是独立 sequence，不能埋在单 attempt 里讲。

当 attempt N timeout/cancel/fail 后，`runAutonomousTask` 做的是：

```text
record attempt terminal state
record verifier/system feedback if any
record autonomous decision
start attempt N+1 with same taskRunStore/taskRunId
project prior heavy-task state
inject bounded prior state into next instruction
```

它没有保证：

```text
same model conversation object
same pending tool call
same mutable workspace snapshot
same provider continuation token
same exact runtime event cursor resume
```

所以正确叫法是：

```text
attempt-level retry with heavy-task state projection
```

不应该叫：

```text
checkpoint resume
live continuation
stateful timeout recovery
```

这一区分直接影响产品判断。

如果 attempt N 已经有：

```text
runnable artifact path
latest failing public check
clear next repair todo
compact evidence for failure
```

那么 attempt N+1 的 projection 很可能有用。

如果 attempt N 只有：

```text
大量 static-analysis compact evidence
late broad todo
no artifact
no public check
```

那么 attempt N+1 很可能继续研究。这是 projection input 质量问题，也是 phase-budget/timeout-resume 产品缺口，不是 self-check recorder 本身的问题。

### 6.9 四条典型分支

#### 6.9.1 Medium public task pass

形态：

```text
inventory_submit
todo_update with runnable_artifact/public_check
ordinary tools build/check
todo_update completed
self_check_submit pass
official verifier pass
export semantic complete + official pass
```

设计解释：

```text
thin loop 提供公开工程路标
没有显著阻碍实现
self-check 和 official result 一致
```

sqlite-gcov 成功 trace 属于这个分支。

#### 6.9.2 Semantic pass but official fail

形态：

```text
runnable artifact exists
public check passes
self_check_submit pass
official verifier fails
export semantic complete + official fail
```

设计解释：

```text
系统保留模型公开判断
系统保留官方失败
后续诊断要看 public check 是否不足、final hygiene 是否污染起点、artifact 是否只满足 smoke
```

MIPS 160-step 原始 run 属于这个分支；clean replay 进一步指向 final hygiene 问题。

#### 6.9.3 Timeout before artifact

形态：

```text
many Read/Bash inspections
late inventory/todo
no Write/Edit
no runnable artifact
timeout
retry sees sparse/research-heavy projection
```

设计解释：

```text
heavy-task state让失败可观测
但当前机制还不保证早期实现
需要 phase budget / early-artifact pressure / timeout checkpoint-resume follow-up
```

多次 GLM/MIPS rerun 属于这个分支。

#### 6.9.4 Runtime cap with semantic complete

形态：

```text
artifact/check/self-check complete
runtime hits cap-like outcome
semantic complete
finalization eligible
boundedTurnImplemented false
official result unchanged
```

设计解释：

```text
系统能诊断“如果有 bounded final turn，也许应该触发”
但当前没有实现特殊 final turn
因此只能导出 eligibility，不能宣称已经完成 finalization
```

### 6.10 Sequence invariants

实现和评审 end-to-end flow 时，至少守住这些 invariants。

```text
I1. Heavy-task enabled/disabled must be explainable from recorded mode facts.
I2. Model-visible heavy-task surface must stay inventory_submit/todo_update/self_check_submit.
I3. Compact evidence must be internal, bounded, public, and lossy.
I4. Inventory/todo/self-check must append typed task-run events.
I5. Prompt replay must use bounded latest/recent projection, not full unbounded ledger dump.
I6. Rejected/private self-checks must not become latest accepted state.
I7. Semantic complete must require accepted pass self-check and completed phase-gate todos.
I8. Official verifier/scorer must remain external authority.
I9. Verifier failure must not be classified as runtime cap-like.
I10. Retry projection must not be described as checkpoint resume.
I11. Final hygiene must remain benchmark-generic and preserve required deliverables.
I12. Export must show heavy-task diagnosis beside official result, never instead of official result.
```

### 6.11 这条序列有意不解决什么

这条 sequence 建立的是可观测、可持久、公开的工程循环。它不完整解决：

```text
model spends too many calls on static analysis before first artifact
timeout resumes from exact model/tool/workspace boundary
bounded final turn after cap-like runtime
automatic cleanup of transient public-check outputs
quantitative phase budgets per benchmark family
```

这些都是后续 system design。

当前 sequence 仍然是正确底座，因为它给 Maka 补上了缺失的状态基座：

```text
typed progress state
public self-check authority boundary
compact evidence projection
semantic/runtime/official split
traceable retry behavior
```

没有这个基座，后续 phase budget 或 checkpoint-resume 都没有干净的状态契约可以承接。

## 7. Event / State Contract

第 6 节定义了运行协议；第 7 节要把这条协议落成可实现、可回放、可评审的状态契约。

这里的重点不是列几个 TypeScript type。真正的 contract 要回答：

```text
谁可以写这个状态？
什么时候写？
写入前要验证什么？
projection 怎样读取它？
prompt replay 可以看到哪一部分？
export 可以看到哪一部分？
它是否有 official authority？
坏数据出现时系统怎样降级？
```

因此，heavy-task 的状态模型必须遵守五条总原则。

### 7.1 总原则

#### 7.1.1 Ledger first, prompt second

所有 heavy-task 事实先写入 task-run event ledger，再由 projection 产生 prompt/export/read-model。

不允许把某个关键状态只塞进 prompt：

```text
bad:
  retry prompt says "previous todo was X"
  but task-run events cannot prove X ever existed

good:
  heavy_task_todos_recorded event exists
  projectTaskRun derives latestHeavyTaskTodos
  prompt renderer uses bounded latest projection
```

这个原则保证两个能力：

```text
replay: 后续能重新投影同一条 task-run
explain: 人能回答模型为什么在 retry 里看到这些状态
```

#### 7.1.2 Full snapshot in ledger, bounded view in prompt

Inventory 和 todos 在 ledger 里记录完整 snapshot。

但 prompt replay 不能把所有历史 snapshot 原样塞回模型。prompt 只能看到 bounded latest/recent view。

理由：

```text
ledger 是事实层，追求完整和可回放
prompt 是执行层，追求小、清楚、能推动下一步
```

如果 prompt 无界回放，retry 会变成“读历史档案”，不是继续工程。

#### 7.1.3 Public source guard before authority

任何会成为模型后续依据的状态，都必须先过 public/source guard。

尤其是：

```text
self-check reason
command evidence summary
artifact evidence summary
compact evidence summary
inventory/todo evidence strings
```

Guard 的目的不是让状态“绝对正确”，而是确保它不跨越 benchmark integrity 边界。

#### 7.1.4 Advisory state cannot overwrite official state

heavy-task 状态有自己的价值，但不能改写 official verifier/scorer truth。

```text
semantic complete != official pass
compact evidence != official proof
self-check pass != scorer reward
finalization eligible != bounded final turn executed
```

projection/export 要允许这些状态并列出现，而不是互相覆盖。

#### 7.1.5 Rejected state may be diagnostic, but not authoritative

被拒绝的 self-check、non-public evidence、自相矛盾的 replay state，可以作为 warning 或 diagnostic 存在。

但它们不能成为：

```text
latest accepted self-check
semantic complete 的依据
retry prompt 的 authoritative prior state
official result 的替代物
```

### 7.2 State ownership map

| State | Writer | Validator | Projection owner | Prompt visibility | Export visibility | Authority |
| --- | --- | --- | --- | --- | --- | --- |
| `HeavyTaskModeFacts` | `runTaskOnce` / mode resolver | policy version + config precedence | `projectTaskRun` | indirect, via policy/tools | yes | config/task-run fact only |
| Inventory snapshot | model via `inventory_submit` | progress recorder schema/source discipline | `projectTaskRun` | bounded latest | latest + history/window | public progress, not result |
| Todo snapshot | model via `todo_update` | progress recorder schema + one `in_progress` | `projectTaskRun` | bounded latest | latest + history/window | public progress, semantic input |
| Self-check | model via `self_check_submit` | self-check recorder + source guard | `projectTaskRun` | latest accepted only | accepted/rejected filtered by export mode | advisory semantic only |
| Compact evidence | internal recorder | evidence compactor/redactor | `projectTaskRun` | recent bounded public window | latest/recent bounded public window | context/evidence summary only |
| Completion | derived | finalization evaluator | `projectTaskRun` | optional summary only | yes | diagnostic, not official result |
| Verifier/score | Harbor/verifier/scorer path | authority preference | `projectTaskRun` | no model feedback except safe retry summary | yes | official benchmark authority |

这张表是本节的主 contract。改代码前先问：这个 change 改的是哪一行？

### 7.3 Mode facts contract

Mode facts 回答一个问题：

> Why did this task-run behave like a heavy-task run?

Canonical event：

```text
heavy_task_mode_recorded
```

逻辑形态：

```text
schemaVersion
enabled
triggerSource
triggerReason
policyVersion
```

写入者：

```text
runTaskOnce after resolveHeavyTaskMode
```

验证：

```text
config explicit disable wins
known policy version only
unknown policy version cannot inject model-visible prompt
mode facts must be serializable and replayable
```

Projection：

```text
latest mode facts become projection.heavyTaskMode
export.policy.heavyTask derives from projection
```

Prompt 规则：

```text
模型不需要看到原始 mode event dump。
它只看到启用后的结果：policy text 和 submit tools。
```

失败语义：

```text
如果 mode 不能安全解析，优先 disabled/known-safe，而不是 partial enablement。
绝不能在没有对应 recorder 的情况下暴露 submit tools。
绝不能只追加 prompt policy，却让 store/export 不知道 heavy-task mode。
```

### 7.4 Inventory contract

Inventory 回答：

> What public task/workspace facts does the model believe are relevant right now?

Canonical event：

```text
heavy_task_inventory_recorded
```

逻辑形态：

```text
items[]
  id/path/name where useful
  kind
  status
  purpose
  public evidence string
```

写入者：

```text
model through inventory_submit
```

验证：

```text
well-formed snapshot
public evidence only
bounded field sizes
no hidden/evaluator/private claims
```

Projection：

```text
append to heavyTaskInventory[]
latest snapshot becomes latestHeavyTaskInventory
render prompt from latest bounded snapshot
```

设计意图：

Inventory 不应该变成完整文件目录。它只需要小到足以回答：

```text
which public inputs matter?
which artifact exists?
which required output is missing?
what public evidence supports that statement?
```

坏的 inventory：

```text
lists every file recursively
quotes huge source chunks
claims hidden tests require X
keeps stale artifact status after repair
```

好的 inventory：

```text
/app/vm.js: runnable artifact, generated, checked by node vm.js
/tmp/frame.bmp: transient public-check output, generated by local run, should not be final verifier input unless required
/tests/task description: public requirement source, inspected
```

Prompt/export 分层：

```text
prompt: latest bounded inventory
export: latest plus historical snapshots if full export requests it
```

### 7.5 Todo contract

Todos 回答：

> What executable public engineering work remains, and what evidence closes it?

Canonical event：

```text
heavy_task_todos_recorded
```

逻辑形态：

```text
todos[]
  id
  content
  kind
  status
  priority
  evidence
```

重要的 `kind` 值：

```text
runnable_artifact
public_check
repair
final_self_check
```

写入者：

```text
model through todo_update
```

验证：

```text
full snapshot, not incremental patch
at most one in_progress
completed todo should carry public evidence
cancelled todo is nonblocking only with evidence
phase-gate kinds are stable enough for finalization evaluator
```

Projection：

```text
append to heavyTaskTodoStates[]
latest snapshot becomes latestHeavyTaskTodos
semantic finalization reads only latest snapshot
```

设计意图：

Todo 不是项目管理看板，而是当前工程循环的最小 durable representation。

它必须让系统能区分：

```text
planned but never built
built but never publicly checked
checked but failed
failed then repaired
ready for semantic self-check
```

Semantic 依赖：

```text
semantic complete requires:
  latest todos non-empty
  every todo completed or cancelled-with-evidence
  completed runnable_artifact todo exists
  completed public_check todo exists
```

失败例子：

```text
A broad todo "implement interpreter" completed without evidence is weak and should not close semantic completion.
A cancelled todo "run check" without evidence should remain blocking.
两个 `in_progress` todo 表示这个 snapshot 不是单一当前动作状态。
```

### 7.6 Self-check contract

Self-check 回答：

> Based only on public evidence, does the model believe the task is complete?

Canonical event：

```text
heavy_task_self_check_recorded
```

逻辑形态：

```text
status: pass | fail | inconclusive
publicReason
commandEvidence[]
artifactEvidence[]
accepted / rejected
rejection reason where applicable
```

写入者：

```text
model through self_check_submit
```

验证：

```text
status exists
publicReason exists
at least one command or artifact evidence item exists
all user/model strings pass source guard
hidden/private/evaluator-only claims are rejected
```

Projection：

```text
accepted public self-checks append to heavyTaskSelfChecks[]
latest accepted self-check becomes latestHeavyTaskSelfCheck
rejected self-checks may appear only in diagnostic/event export, not authority slots
```

Authority 边界：

```text
pass -> may contribute to semantic complete
fail/inconclusive -> semantic incomplete
accepted -> means public/source-valid, not necessarily true
official verifier remains authoritative
```

Prompt 规则：

```text
retry may see latest accepted self-check as advisory prior state
retry must not see rejected/private self-check as authoritative prior state
```

好的 self-check：

```text
status=pass
publicReason cites local public command and artifact evidence
mentions final hygiene if public check produced transient output
avoids official hidden assertions
```

坏的 self-check：

```text
"I know hidden verifier will pass"
"official threshold is X"
"private evaluator expects Y"
"pass" without command/artifact evidence
```

### 7.7 Compact evidence contract

Compact evidence 回答：

> What recent public observations should help replay, retry, export, and diagnosis without replaying raw logs?

Canonical event：

```text
heavy_task_evidence_recorded
```

写入者：

```text
internal compact evidence recorder around ordinary tools
projection from eligible runtime/self-check artifacts
accepted self-check evidence expansion
```

不是写入者：

```text
the model
```

这一点很重要：compact evidence 故意不是模型可见的 authoring surface。

逻辑形态：

```text
id
kind: tool | artifact | check | observation
source tool/artifact/check reference
public flag / authority metadata
bounded summary
byte/truncation metadata
redaction metadata where useful
```

验证 / compaction 规则：

```text
Bash stdout/stderr bounded and truncated
Read/Grep excerpts bounded
Write/Edit bodies omitted
raw diffs omitted
artifact body omitted
metadata sanitized
hidden/private/official-verifier patterns redacted
non-authoritative runtime artifacts may be summarized
official verifier artifacts excluded from model evidence projection
```

Projection：

```text
append public matching envelopes
latestHeavyTaskEvidence points to latest accepted envelope
prompt renderer uses last 8 envelopes
export progress uses recent bounded window, currently larger than prompt window
```

Authority 边界：

```text
compact evidence helps the model remember and helps humans inspect
it is not a proof chain
it is not retrievable raw evidence unless a separate storage system makes refs real
it is not official verifier evidence
```

### 7.8 Completion projection contract

Completion 回答：

> How should humans interpret the heavy-task state alongside runtime and official result?

它是派生状态，不是 model-authored 状态。

逻辑形态：

```text
runtime
  status
  capLike
  capKind

semantic
  status: complete | incomplete
  reasons / missing gates / unresolved todos

finalization
  eligible
  boundedTurnImplemented
```

Runtime 派生：

```text
capLike true only for cap/budget/timeout-like terminal outcomes
verifier failure is not cap-like
normal completion is not automatically cap-like
```

Semantic 派生：

```text
mode enabled
latest accepted self-check exists
latest accepted self-check status is pass
latest todos non-empty
all latest todos completed or cancelled-with-evidence
runnable_artifact phase gate completed
public_check phase gate completed
```

Finalization 派生：

```text
eligible = semantic complete && runtime capLike
boundedTurnImplemented = false until a real bounded final-turn mechanism exists
```

Authority 边界：

```text
completion projection cannot mutate result.passed
completion projection cannot mutate reward
completion projection cannot rewrite verifier/scorer taxonomy
```

这个 contract 有意允许：

```text
semantic complete + official fail
semantic incomplete + official pass
finalization eligible + boundedTurnImplemented false
official fail + compact evidence that looks promising
```

这些组合不是 bug，而是诊断状态。

### 7.9 Projection/read-model contract

`TaskRunStore` and `projectTaskRun` are the boundary between raw events and product-facing state.

Projection 必须：

```text
replay events in append order
preserve latest pointers deterministically
filter rejected/private events from authority slots
record warnings instead of throwing on recoverable inconsistent heavy-task state
prefer authoritative verifier/score results
derive compact evidence only from eligible public/non-authoritative runtime artifacts
exclude official verifier artifacts from model evidence
compute heavyTaskCompletion after replay
```

Projection 不能：

```text
invent model progress that no event recorded
repair missing evidence silently
turn compact evidence into proof
turn semantic status into official result
hide authoritative verifier failure behind advisory completion
```

### 7.10 Compatibility and migration contract

因为 task-run ledger 是 append-only，未来改动必须保留旧事件语义。

允许改动：

```text
add optional fields with schemaVersion
add projection warnings
add export-only derived fields
change prompt rendering window
add new diagnostic classification over existing events
```

高风险改动：

```text
renaming event types
changing semantic meaning of todo kind
making old accepted self-checks invalid without migration path
using official verifier artifacts as compact public evidence
changing finalization.eligible into an executed action without a new field/event
```

未来 PR 如果改这个 contract，必须包含：

```text
migration note
projection regression over old events
export compatibility assertion
prompt replay assertion
```

## 8. Failure / Fallback Semantics

失败语义是设计的一部分，不是测试后的补丁。heavy-task 在 benchmark 路径上，两个错误代价很高：

```text
false authority: claiming a run passed or resumed when it did not
false opacity: losing enough state that no one can diagnose why the run failed
```

因此 fallback policy 是：

> fail closed on integrity/authority boundaries; degrade gracefully on optional prompt/export context.

### 8.1 Integrity failures: fail closed

Integrity failure 指继续执行会泄露 hidden data、制造 false authority，或暴露 half-enabled model surface 的情况。

例子：

```text
unknown policy version would inject prompt text
self-check contains hidden/private/evaluator-only claims
submit tool exists but recorder is missing
heavy-task tool claims accepted state but event append failed
export would include private payload
```

期望行为：

```text
reject the tool call or disable the unsafe surface
append no authoritative heavy-task event
return a public, repairable error where model action can fix it
record diagnostic warning where useful
```

不要通过静默接受 unsafe state 来恢复。

### 8.2 Context failures: degrade gracefully

Context failure 指 model/export 失去可选帮助，但 official correctness 不受影响的情况。

例子：

```text
compact evidence too large to render
artifact metadata cannot be safely summarized
old event has an unknown optional field
prior progress prompt fragment exceeds window
```

期望行为：

```text
truncate, omit, or warn
preserve raw event where already recorded
keep official verifier/scorer path unchanged
```

不要只因为 optional compact context 渲染失败就让 benchmark 失败。

### 8.3 Mode disabled or partially unavailable

如果 heavy-task disabled：

```text
no policy injection
no submit tools
no heavy-task recorders
normal task-run behavior
export says absent/disabled if needed
```

如果系统不能安全启用全部组件：

```text
prefer disabled over half-enabled
never expose inventory_submit/todo_update/self_check_submit without matching recorder and taskRunStore
never append policy text without mode facts that explain it
```

### 8.4 Invalid model-authored progress

Invalid progress 应该是 model-repairable。

例子：

```text
two in_progress todos
missing todo id/status
completed todo without evidence where semantic closure would depend on it
inventory evidence claims hidden evaluator knowledge
```

期望行为：

```text
reject or mark invalid
append no authoritative snapshot
return a clear public error
let model submit corrected snapshot
```

Projection 不应该猜一个修正后的 todo list。

### 8.5 Invalid or private self-check

Self-check 更严格，因为它可能关闭 semantic status。

期望行为：

```text
source-guard before acceptance
if rejected, do not make it latest accepted self-check
do not let rejected self-check complete semantic status
do not project it as retry authority
optionally export rejection reason for diagnostics if safe
```

### 8.6 Evidence compaction failure

Evidence compaction 有帮助，但没有 authority。

期望行为：

```text
if safe summary can be produced, append bounded envelope
if safety is uncertain, omit envelope
if output is huge, truncate with metadata
if artifact is official verifier authority, do not project as model evidence
```

重要区别：

```text
omitting compact evidence may reduce retry quality
it must not change official score
```

### 8.7 Store append / projection inconsistency

Store append failure 很严重，因为它破坏 ledger-first contract。

期望行为：

```text
if a submit tool cannot append its event, the tool should report failure
model should not be told the state was accepted
projection should warn on inconsistent historical state rather than fabricating authority
```

Projection inconsistency 例子：

```text
self-check event marked accepted but later source guard rejects it
compact evidence event claims public=false
old event shape missing fields
```

期望 projection 行为：

```text
filter from authority slots
preserve warning
continue replay where safe
```

### 8.8 Semantic pass but official fail

这是 first-class state，不是异常。

期望 export：

```text
latest accepted self-check: pass
semantic.status: complete, if todos/gates also satisfy contract
official result: failed
reward/taxonomy: official failure preserved
```

诊断应分叉到：

```text
public check was too weak
artifact only satisfied local smoke
final hygiene polluted verifier start state
hidden official requirement was not inferable from public evidence
model made a wrong public inference
```

系统不能通过修改 reward 来“解决”这个分歧。

### 8.9 Runtime cap with semantic complete

这也是 first-class state。

期望 export：

```text
runtime.capLike: true
semantic.status: complete
finalization.eligible: true
boundedTurnImplemented: false unless real mechanism exists
official result unchanged
```

解释：

```text
这个 run 有足够 public semantic evidence，说明 bounded final turn 可能有用。
但当前实现仍然没有执行这种 final turn。
```

### 8.10 Timeout/cancel retry

当前 retry 语义：

```text
same taskRunStore/taskRunId
new attempt
projected prior heavy-task state
bounded prompt injection
new model/run/workspace path according to existing autonomous loop behavior
```

不保证：

```text
same model session
same mutable workspace checkpoint
same pending tool call
same provider continuation
same exact trace high-water resume
```

Fallback：

```text
if prior projection is useful, retry can continue from public state
if prior projection is weak, retry may repeat analysis
classify that as retry/projection quality or checkpoint-resume gap, not as official verifier behavior
```

## 9. Trace Evidence as Design Feedback

Trace evidence 不应该被当成 scoreboard anecdote。它在本文中的作用，是验证或反证设计压力。

读每条 trace 时，问：

```text
系统捕获了哪些状态？
哪个转折发生太晚，或根本没发生？
model-visible surface 是帮了忙，还是分散了注意力？
official authority 是否保持分离？
这条 trace 之后还剩什么产品缺口？
```

### 9.1 Sqlite-gcov: thin loop has acceptable overhead

观察到的形态：

```text
inventory_submit after initial public inspection
todo_update before build/check
public build/gcov checks
completed todo_update
accepted self_check_submit
official reward 1.0
```

设计解释：

```text
inventory/todo/self-check can be a lightweight engineering scaffold
self-check did not need hidden verifier information
thin submit tools did not prevent official pass
```

推导出的设计约束：

```text
Do not add required audit tools just because richer export would be nice.
A medium public build task can pass with only the thin loop.
```

### 9.2 MIPS P1-d: too much live audit pressure harms transition

观察到的形态：

```text
many static-analysis Bash/Read calls
late inventory/todo
engineering/check surfaces available but not productively used
runnable artifact appeared late or not at all before timeout/cancel
```

设计解释：

```text
The model did not lack schema.
It lacked pressure to move from research to artifact/check.
```

推导出的设计约束：

```text
Do not restore engineering_record/check_record/evidenceChain as required live model work.
Move retrospective/audit needs to trace-derived export where possible.
```

### 9.3 First thin MIPS reruns: removing audit tools is necessary but insufficient

观察到的形态：

```text
audit tools removed
model still performed long static inspection
phase-gate todo sometimes appeared late
no artifact before stop in some runs
```

设计解释：

```text
Thin surface removes one source of drag, but does not by itself enforce phase transition.
```

推导出的设计约束：

```text
Next product improvement should be phase-budget / early-artifact pressure / retry state ranking, not larger live proof schemas.
```

### 9.4 MIPS 2h/160: artifact path can succeed, final hygiene matters

观察到的形态：

```text
inventory/todo -> Write vm.js -> local public check -> frame artifact -> completed todos -> accepted pass self-check
original official reward 0.0
clean replay of same vm.js official reward 1.0
```

设计解释：

```text
The model reached a real runnable artifact and semantic self-check.
The official failure is best explained by verifier-start-state pollution from public self-check output.
```

推导出的设计约束：

```text
Final hygiene must be generic and explicit.
It must preserve solution/required deliverables while cleaning transient public-check outputs.
It must not mention MIPS/Doom/frame/stdout/task-specific details.
```

### 9.5 Final-hygiene rerun: no evidence about hygiene path, strong evidence about timeout gap

观察到的形态：

```text
run did not reach artifact/self-check/final hygiene
attempt timed out/cancelled during static analysis
retry projection had weak state and analysis continued
```

设计解释：

```text
This does not validate or invalidate PR #183.
It validates the separate need for timeout checkpoint/resume or stronger retry anchors.
```

推导出的设计约束：

```text
Keep retry projection honest.
Do not claim checkpoint resume until workspace/model/tool high-water semantics exist.
```

### 9.6 OpenCode comparison: copy behavior target, not architecture wholesale

观察到的形态：

```text
OpenCode also inspected for a while
once plan existed, transition was steep: todo -> write -> edit -> public check
```

设计解释：

```text
The useful target is plan-to-artifact-to-check continuity.
```

推导出的设计约束：

```text
Maka should improve phase transition and retry anchors.
It does not need to import a new live audit architecture.
```

### 9.7 Trace-derived telemetry needed next

The current design should make future trace reports answer:

```text
first inventory index/time
first runnable_artifact todo index/time
first Write/Edit artifact index/time
first public_check todo/index/time
first public check command index/time
first accepted self_check index/time
number of compact evidence envelopes by source
retry projection size and top anchors
whether official fail followed semantic pass
whether final hygiene step ran before self-check
```

这些指标是产品反馈，不应该变成新的模型可见填表义务。

## 10. Decision Records

这里的 decision record 是写给未来 reviewer 的。每条都说明设计压力、最终决策、明确不采用的方案，以及怎样判断这个决策正在被破坏。

### DR-001: Keep heavy-task inside the existing task-run spine

设计压力：

```text
Heavy-task needs verifier/scorer authority, isolated tools, retry, artifacts, task-run export, and event replay.
Those already live on the headless task-run path.
```

决策：

```text
Integrate through runTaskOnce, TaskRunStore, isolated tools, autonomous retry, and result-export.
Do not create a separate heavy-task runtime loop.
```

未采用方案：

```text
A separate HeavyTaskRuntime or benchmark-specific runner that owns its own tool loop and result semantics.
```

原因：

```text
A second runtime would duplicate terminal semantics and risk diverging from official verifier/scorer authority.
```

违背信号：

```text
Heavy-task code starts deciding pass/fail outside task-run projection.
A new loop bypasses runTaskOnce verifier/scorer recording.
Exports disagree depending on which runtime path produced them.
```

### DR-002: Keep live model-visible surface thin

设计压力：

```text
Long tasks need durable state, but model steps are scarce.
Historical audit/proof-chain tools made the hot path heavier.
```

决策：

```text
Model-visible heavy-task tools are inventory_submit, todo_update, and self_check_submit.
Compact evidence is captured internally.
```

未采用方案：

```text
Require engineering_record, check_record, evidenceChain, repair records, patch records, and proof links as live model-authored work.
```

原因：

```text
The model should spend budget on artifact/check/repair, while trace/export derives richer retrospectives later.
```

违背信号：

```text
Prompt asks for live proof chains.
Tools expose engineering_record/check_record again.
Semantic completion depends on model-maintained evidence-chain ids.
```

### DR-003: Treat self-check as advisory public semantics

设计压力：

```text
The model should explain why it believes the task is complete, but benchmark authority must remain external.
```

决策：

```text
self_check_submit records public semantic assertion after source guard.
It can complete semantic status, not official result.
```

未采用方案：

```text
Treat self-check pass as benchmark pass or skip official verifier when self-check passes.
```

原因：

```text
Official verifier/scorer may fail for reasons public smoke did not catch.
```

违背信号：

```text
result.passed changes because self-check passed.
reward is inferred from semantic status.
verifier failure is hidden or downgraded after accepted self-check.
```

### DR-004: Compact evidence is context, not proof

设计压力：

```text
Retry and export need small public anchors, but raw outputs/artifacts can be huge or unsafe.
```

决策：

```text
Capture bounded public evidence summaries internally.
Use recent windows for prompt/export.
Exclude official/private evidence from model projection.
```

未采用方案：

```text
Full raw stdout/stderr/artifact/diff replay.
Model-authored proof chain.
Official verifier artifacts as prompt evidence.
```

原因：

```text
Bounded summaries preserve useful context without turning evidence into a leakage or prompt-budget problem.
```

违背信号：

```text
Write/Edit bodies appear in compact evidence.
Official verifier artifacts are replayed to the model.
Prompt includes unbounded tool output history.
```

### DR-005: Phase gates are semantic gates, not extra audit tools

设计压力：

```text
Trace showed late transition from research to runnable artifact.
```

决策：

```text
Use todo kind markers for runnable_artifact and public_check.
Semantic complete requires both completed.
```

未采用方案：

```text
Require separate check_record / repair_chain tools to prove each phase.
```

原因：

```text
The important live pressure is "build and check", not "author a normalized audit chain".
```

违背信号：

```text
Semantic completion can pass without runnable_artifact/public_check.
Phase-gate todos become optional prose only.
Model is asked to fill audit forms before first artifact.
```

### DR-006: Final hygiene is generic verifier-start-state discipline

设计压力：

```text
Public checks can generate files that pollute official verifier start state.
MIPS clean replay showed this can flip reward.
```

决策：

```text
Before final self-check, prompt model to restore verifier start state generically while preserving solution files and task-required deliverables.
```

未采用方案：

```text
MIPS-specific cleanup hints.
Automatic blanket deletion.
No hygiene guidance.
```

原因：

```text
Benchmark integrity requires generic discipline, not task-specific evaluator knowledge.
```

违背信号：

```text
Prompt mentions task-specific files or expected stdout.
Prompt tells model to delete broadly.
Prompt allows public-check transient outputs to remain unexplained before final self-check.
```

### DR-007: Retry projection is not checkpoint resume

设计压力：

```text
Timeout/cancel attempts need continuity, but current autonomous retry does not preserve exact live execution state.
```

决策：

```text
Reuse taskRunStore/taskRunId and project bounded prior state into new attempts.
Keep true checkpoint/resume as a separate design.
```

未采用方案：

```text
Calling attempt-level retry "resume".
Pretending projected summary restores model/tool/workspace high-water state.
```

原因：

```text
Incorrect resume claims make failures impossible to reason about.
```

违背信号：

```text
Docs/UI call retry a checkpoint resume.
Retry starts a new workspace/session but reports live continuation.
Timeout taxonomy hides whether checkpoint was missing or resume failed.
```

### DR-008: Export must show disagreement, not smooth it over

设计压力：

```text
Heavy-task can produce semantic complete while official verifier fails.
Humans need both facts.
```

决策：

```text
Export heavyTask progress/completion beside official result.
Never let heavyTask fields override score/taxonomy/reward.
```

未采用方案：

```text
A single "pass" field derived from whichever signal looks most favorable.
```

原因：

```text
Disagreement is useful diagnostic information.
```

违背信号：

```text
Export hides official failure.
Export omits semantic completion details after official fail.
Export consumers cannot tell verifier authority from self-check authority.
```

## 11. Export / Telemetry Contract

Export 是面向人的 read model。它应该解释 run，而不是改变 run。

### 11.1 Export audience

Export 面向三类读者：

```text
operator: why did this benchmark run pass/fail/timeout?
developer: which part of heavy-task state behaved incorrectly?
researcher: did policy/tooling improve phase transition or only add overhead?
```

好的 export 应该让这三类人不必先读 20 万行 raw trace，就能回答各自的问题。

### 11.2 Export shape

推荐的 heavy-task 顶层 read model：

```text
policy.heavyTask
  enabled
  triggerSource
  triggerReason
  policyVersion

heavyTask.progress
  latestInventory
  latestTodos
  latestSelfCheck
  latestEvidence
  recentEvidence[]

heavyTask.completion
  runtime
  semantic
  finalization

heavyTask.diagnostics
  warnings[]
  rejectedSelfCheckCount
  omittedEvidenceCount
  promptProjectionWindow
  phaseTransitionMetrics where available

result / verifier / score / taxonomy
  existing official/runtime truth
```

### 11.3 Required authority labels

容易和 official result 混淆的 export 对象，必须带清楚的 authority 标识。

例子：

```text
selfCheck.authority = "model_public_semantic"
compactEvidence.authority = "public_summary"
verifier.authority = "official" | "non_authoritative" depending existing contract
score.authority = "official" where applicable
```

即使代码里的字段名不同，这个概念也必须保留：读者不能只靠字段位置推断 authority。

### 11.4 Prompt and export windows differ

Prompt window 应该小于 export window。

```text
prompt evidence window: optimized for next model action
export recent window: optimized for human inspection
full event export: optional, filtered, diagnostic
```

设计规则：

```text
Do not increase prompt replay size just because export needs more context.
Do not shrink export truth just because prompt should be small.
```

### 11.5 Redaction/export safety

Export 必须守住这些安全规则：

```text
no hidden/private/evaluator-only strings
no raw Write/Edit bodies from compact evidence
no official verifier artifacts as model evidence
bounded large stdout/stderr
truncation metadata preserved
rejected self-checks filtered or clearly diagnostic
```

### 11.6 Telemetry to add around phase behavior

未来 telemetry 应该关注行为转折，而不是增加 live model 表单。

推荐字段：

```text
firstInventoryToolIndex / time
firstTodoToolIndex / time
firstRunnableArtifactTodoIndex / time
firstWriteOrEditIndex / time
firstPublicCheckTodoIndex / time
firstPublicCheckCommandIndex / time
firstAcceptedSelfCheckIndex / time
staticAnalysisToolCallsBeforeFirstWrite
retryProjectionEvidenceCount
retryProjectionTodoCount
semanticOfficialDisagreementKind
finalHygieneObservedBeforeSelfCheck
```

这些指标应从 trace/events 派生，不应该要求模型再填写一个工具。

## 12. Rollout / Implementation Slices

这一节不是 backlog 愿望清单，而是定义怎样演进设计，同时不退回已回滚的 heavy branch。

### 12.1 Slice A: Protect current thin baseline

范围：

```text
mode facts
policy injection
inventory/todo submit tools
self_check_submit source guard
compact evidence internal recorder
semantic/runtime/official split
result export progress
phase-gate semantic completion
final hygiene prompt
```

退出标准：

```text
all existing focused tests pass
no old audit tools appear in provider-visible schema
prompt contains no proof-chain obligations
official result remains authoritative
```

### 12.2 Slice B: Improve phase transition with minimal new surface

问题：

```text
MIPS-like tasks still over-invest in static analysis before first artifact.
```

允许方向：

```text
policy language that limits open-ended inspection
retry prompt ranking that foregrounds artifact/failing check/next action
phase-budget diagnostics
optional runtime warning when too many tools happen before first runnable artifact
```

不允许方向：

```text
restore engineering_record/check_record/evidenceChain
require model-authored proof chain before implementation
add task-specific hints
```

退出标准：

```text
trace metrics show earlier Write/Edit or public check on long tasks
sqlite-like tasks do not gain large overhead
semantic/official authority unchanged
```

### 12.3 Slice C: Make timeout resume a separate product capability

问题：

```text
attempt-level retry with projection is not enough for long timeout-heavy tasks.
```

必需设计对象：

```text
checkpoint event
runtime event high-water mark
workspace snapshot/diff reference
resume attempt taxonomy
fallback reason when checkpoint missing/invalid/resume failed
```

不可让步的边界：

```text
Do not rename current retry to resume.
Do not hide fallback retry behind a successful resume label.
```

退出标准：

```text
export distinguishes retry vs checkpoint resume
resume failure is classified
workspace/model/tool high-water semantics are documented
```

### 12.4 Slice D: Implement bounded final turn only with new events

问题：

```text
finalization.eligible exists, but bounded final turn is not implemented.
```

实现前必须定义：

```text
new event type or explicit final-turn marker
hard tool/time budget
allowed action list
forbidden action list
export field proving it ran
```

允许的 final-turn 动作：

```text
inspect latest accepted public state
perform minimal generic final hygiene
submit final public semantic status
```

禁止的 final-turn 动作：

```text
hidden verifier inspection
broad new research
full rewrite
unbounded public checks
```

退出标准：

```text
boundedTurnImplemented changes only when final turn actually ran
official result remains authoritative
```

### 12.5 Slice E: Trace-derived retrospective, not live audit

问题：

```text
Humans still need rich postmortems: hypotheses, failed checks, repairs, patch summaries.
```

设计方向：

```text
derive retrospective from task-run/tool/evidence events after the run
optionally generate a review artifact outside model hot path
keep live model tools thin
```

退出标准：

```text
postmortem quality improves
provider-visible tool schema stays unchanged
model prompt does not ask for proof-chain maintenance
```

## 13. Test Strategy

测试要保护 contract，而不只是覆盖代码行。

### 13.1 Policy tests

必须断言：

```text
default disabled
config enable works
benchmark metadata enable works
explicit disable wins
unknown policy version cannot inject prompt
prompt includes inventory -> runnable_artifact -> public_check -> repair_or_continue -> semantic_self_check
prompt says self-check advisory and official scoring authoritative
prompt includes generic final hygiene
prompt excludes task-specific cleanup terms
prompt excludes engineering_record/check_record/evidenceChain/proof-chain obligations
```

### 13.2 Tool-surface tests

必须断言：

```text
default isolated tool surface has ordinary tools only
heavy-task enabled adds exactly inventory_submit/todo_update/self_check_submit
compact evidence recorder does not appear as a model tool
old audit tools are absent from provider-visible schema
```

### 13.3 Progress-state tests

必须断言：

```text
inventory snapshot appends event
latest inventory projection uses replay order
todo snapshot appends event
one in_progress max
completed/cancelled evidence rules enforced
runnable_artifact/public_check kinds survive replay
prompt rendering is bounded
invalid submit does not append accepted state
```

### 13.4 Self-check tests

必须断言：

```text
status required
publicReason required
command or artifact evidence required
hidden/private/evaluator-only strings rejected
accepted pass becomes latest accepted advisory state
fail/inconclusive do not complete semantic status
rejected self-check does not become latest accepted state
prompt rendering labels self-check advisory
```

### 13.5 Evidence tests

必须断言：

```text
Bash output bounded/truncated
Read/Grep excerpts bounded
Write/Edit bodies omitted
raw diffs omitted
artifact metadata sanitized
hidden/private/official-verifier patterns redacted
official verifier artifacts excluded from model evidence projection
prompt evidence window bounded
export evidence window bounded
```

### 13.6 Projection/finalization tests

必须断言：

```text
append-order replay deterministic
warnings for inconsistent/rejected state
semantic complete requires accepted pass self-check
semantic complete requires resolved/nonblocking todos
semantic complete requires runnable_artifact and public_check phase gates
verifier failure is not cap-like
runtime caps classify narrowly
finalization eligible requires semantic complete + cap-like runtime
boundedTurnImplemented remains false until real final-turn implementation
```

### 13.7 Export tests

必须断言：

```text
policy.heavyTask exported
latest progress exported
recent compact evidence exported safely
private/rejected payloads filtered
official verifier/scorer truth preserved
semantic complete + official fail can coexist
export fields carry enough authority labels/context to avoid misread
```

### 13.8 Integration/trace tests

Integration suite 至少要覆盖三类场景。

中等 public build task：

```text
thin loop appears
artifact/check/self-check path completes
official pass remains official pass
overhead is small enough to be acceptable
```

长研究型 task：

```text
measure first inventory/todo/write/check/self-check positions
classify static-analysis-before-artifact pattern
verify phase-gate todos are early enough to matter
verify final hygiene path if reached
```

Timeout/retry task：

```text
attempt N records terminal timeout/cancel
attempt N+1 sees bounded projection
export labels retry, not checkpoint resume
weak projection leading to repeated research is observable
```

### 13.9 Regression tests against historical failure modes

需要补 focused regression：

```text
no task-specific final hygiene wording
no blanket deletion prompt
no old audit tools in tool schema
no self-check override of official verifier failure
no official artifact projected as compact model evidence
no semantic completion without phase gates
no retry labeled resume
```

## 14. Acceptance Matrix

| Scenario | Required state behavior | Required authority behavior | Reject if |
| --- | --- | --- | --- |
| Heavy-task disabled | No policy, no submit tools, no recorders | Normal result path | Any half-enabled submit tool appears |
| Config enable | Mode event explains config trigger | Official verifier unchanged | Prompt injected without mode facts |
| Metadata enable | Mode event explains metadata trigger | Official verifier unchanged | Config disable is ignored |
| Inventory submit | Snapshot event appended, latest projection updated | No result change | Invalid/private inventory becomes prompt authority |
| Todo submit | Snapshot event appended, one current action | Semantic only reads latest valid todos | Two `in_progress` todos accepted |
| Runnable artifact missing | Semantic incomplete | Official result unchanged | Self-check alone completes semantic status |
| Public check missing | Semantic incomplete | Official result unchanged | Completion ignores phase gate |
| Self-check pass | Latest accepted advisory state | No score/reward mutation | `result.passed` changes from self-check |
| Self-check private | Rejected/not authoritative | No semantic completion | Hidden/evaluator claim enters retry prompt |
| Compact evidence huge output | Truncated bounded summary | No result change | Raw huge stdout dumped into prompt/export |
| Write/Edit evidence | Mutation body omitted | No result change | Raw patch/body appears in compact evidence |
| Official verifier artifact | Excluded from model evidence | Official result exported as authority | Verifier artifact projected into model prompt |
| Semantic pass + official fail | Both states visible | Official failure preserved | Export hides either side |
| Runtime cap + semantic complete | finalization eligible, bounded false | Official result preserved | Eligibility is reported as executed finalization |
| Timeout retry | Same taskRunId projection, new attempt | Labeled retry/projection | Labeled checkpoint resume without checkpoint semantics |
| Harbor cell direct path | Prompt/tool pass-through only unless context supplies recorders | No implied task-run persistence | Docs imply direct cell creates full task-run recorders |

## 15. Open Questions / Follow-up Designs

Open questions 必须保持显式，否则会偷偷变成当前版本的承诺。

### 15.1 Phase budgets

问题：

```text
Should heavy-task impose explicit budgets before first runnable artifact and first public check?
```

设计选项：

```text
prompt-only budget guidance
runtime diagnostic warning
autonomous loop intervention
benchmark-family-specific budget profiles
```

风险：

```text
Too strict hurts tasks requiring real upfront reading.
Too loose leaves MIPS-style static-analysis loops unchanged.
```

当前立场：

```text
Needed as follow-up, but do not solve by restoring audit tools.
```

### 15.2 Retry projection ranking

问题：

```text
What should retry prompt foreground when prior state is large?
```

候选优先级：

```text
current runnable artifact
latest failing public check
next executable todo
latest accepted self-check if any
small recent compact evidence window
```

风险：

```text
Too much history restarts research.
Too little history loses constraints.
```

### 15.3 Checkpoint/resume

问题：

```text
What exact state is required to call a timeout continuation a resume?
```

大概率需要：

```text
runtime event high-water mark
workspace snapshot/diff reference
model/tool boundary checkpoint
resume taxonomy
fallback retry taxonomy
```

当前立场：

```text
Separate system design. Current retry must remain honestly labeled.
```

### 15.4 Bounded final turn

问题：

```text
When finalization.eligible is true, should Maka run a bounded final turn?
```

需要定义：

```text
allowed tools
time/tool budget
whether final turn can edit files
whether final turn can run public hygiene commands
how final-turn events appear in export
```

当前立场：

```text
Eligibility exists; execution does not.
```

### 15.5 Post-run retrospective generation

问题：

```text
Can we recover the useful parts of engineering_record/check_record after the run, without model hot-path burden?
```

候选方向：

```text
trace-derived postmortem artifact
source-bearing summaries from events/evidence
human-readable failure taxonomy
no provider-visible schema expansion
```

当前立场：

```text
Promising, but separate from live heavy-task loop.
```

### 15.6 Evidence storage refs

问题：

```text
If compact evidence has truncation refs, what owns the raw evidence?
```

需要定义：

```text
storage authority
retention
privacy classification
access control
retrieval API
prompt replay eligibility
```

当前立场：

```text
Do not imply refs are retrievable proof until this exists.
```

## 16. Review Checklist

评审任何 heavy-task PR 或文档改动时，用这份 checklist。

### 16.1 Boundary checklist

```text
Does the change preserve official verifier/scorer authority?
Does it avoid hidden/private/evaluator-only leakage?
Does it keep self-check advisory?
Does it avoid task-specific benchmark hints?
Does it distinguish retry projection from checkpoint resume?
```

### 16.2 Model hot-path checklist

```text
Does the provider-visible tool surface remain thin?
Does the prompt push toward runnable artifact and public check?
Does the change avoid proof-chain/live audit obligations?
Does it reduce rather than increase open-ended inspection?
```

### 16.3 State contract checklist

```text
Is every new authoritative state backed by a task-run event?
Who writes the event?
Who validates it?
How does projection read it?
What part can prompt replay see?
What part can export see?
What happens to rejected/private/old versions?
```

### 16.4 Failure semantics checklist

```text
Does unsafe state fail closed?
Does optional context degrade safely?
Are warnings visible for projection inconsistency?
Is verifier failure kept separate from runtime cap?
Is semantic/official disagreement exported rather than hidden?
```

### 16.5 Trace/telemetry checklist

```text
Can we measure first inventory/todo/write/check/self-check?
Can we detect research-heavy loops?
Can we tell whether final hygiene ran?
Can we tell whether retry had useful anchors?
Does this require new model-authored audit work? If yes, reconsider.
```

## 17. Source Index

这个 source index 按 contract area 组织，而不是按文件名排序。

### 17.1 Mode and prompt policy

```text
packages/headless/src/heavy-task-policy.ts
  HEAVY_TASK_POLICY_VERSION
  resolveHeavyTaskMode
  normalizeTaskMetadataMode
  normalizeTaskSignalMode
  buildHeavyTaskSystemPromptPolicy
  appendHeavyTaskPolicyToSystemPrompt
  configWithHeavyTaskPolicy

packages/headless/src/__tests__/heavy-task-policy.test.ts
  default/config/metadata enablement
  unsafe policy version guard
  thin loop prompt assertions
  final hygiene prompt guardrails
  absence of old audit/proof-chain terms
```

### 17.2 Progress and self-check

```text
packages/headless/src/heavy-task-progress.ts
  createHeavyTaskProgressRecorder
  buildHeavyTaskProgressTools
  renderHeavyTaskProgressForPrompt
  inventory_submit / todo_update schemas

packages/headless/src/heavy-task-self-check.ts
  createHeavyTaskSelfCheckRecorder
  buildHeavyTaskSelfCheckTools
  validateHeavyTaskPublicSelfCheck
  isAcceptedHeavyTaskSelfCheck
  renderHeavyTaskSelfCheckForPrompt

packages/headless/src/__tests__/heavy-task-progress.test.ts
packages/headless/src/__tests__/heavy-task-self-check.test.ts
```

### 17.3 Evidence and finalization

```text
packages/headless/src/heavy-task-evidence.ts
  compactTextEvidence
  compactToolEvidence
  compactArtifactEvidence
  compactSelfCheckEvidence
  createHeavyTaskEvidenceRecorder
  renderHeavyTaskEvidenceForPrompt

packages/headless/src/heavy-task-finalization.ts
  evaluateHeavyTaskCompletionStatus
  semanticStatusFromInput
  classifyCapKind
  missingPhaseGateKindsFrom

packages/headless/src/__tests__/heavy-task-evidence.test.ts
packages/headless/src/__tests__/heavy-task-finalization.test.ts
```

### 17.4 Event ledger, projection, export

```text
packages/headless/src/task-contracts.ts
  HeavyTaskModeFacts
  HeavyTaskInventoryState
  HeavyTaskTodoState
  HeavyTaskSemanticSelfCheckState
  HeavyTaskCompactEvidenceEnvelope
  heavy-task task events

packages/headless/src/task-run-store.ts
  TaskRunProjection
  projectTaskRun
  appendCompactEvidence
  isCompactEvidenceEligibleArtifact
  preferredVerifierResult
  preferredScoreResult

packages/headless/src/result-export.ts
  TaskRunExport
  taskRunExportFromProjection
  progressFromProjection
  exportableTaskEvents

packages/headless/src/__tests__/task-run-store.test.ts
packages/headless/src/__tests__/result-export.test.ts
packages/headless/src/__tests__/scorer.test.ts
```

### 17.5 Tool surface and runtime wiring

```text
packages/headless/src/tools.ts
  buildIsolatedHeadlessTools
  ordinary isolated tool builders
  heavy-task submit tool wiring
  compact evidence recorder wiring

packages/headless/src/task-agent-controller.ts
  runTaskOnce
  withOptionalStatePrompts
  toolNamesForIdentity
  heavy-task recorder creation and backend context wiring

packages/headless/src/autonomous-agent-loop.ts
  runAutonomousTask
  defaultContinuationPrompt
  shared taskRunStore/taskRunId across attempts

packages/headless/src/harbor-cell.ts
  runHarborCell
  buildHarborCellAiSdkTools
  direct Harbor cell prompt/tool pass-through boundary

packages/headless/src/__tests__/tools.test.ts
packages/headless/src/__tests__/task-agent-controller.test.ts
packages/headless/src/__tests__/autonomous-agent-loop.test.ts
packages/headless/src/__tests__/harbor-cell.test.ts
```

### 17.6 Historical PR map

```text
Issue #102: heavy-task benchmark policy and public self-check direction
PR #121: policy boundary
PR #123: progress run state
PR #124: semantic self-check guard
PR #128: dual completion status
PR #132: compact evidence envelopes
PR #138: reverted engineering_record/check_record branch
PR #146: reverted evidence-chain finalization branch
PR #151: reverted synthetic repair-chain / heavy self-check policy branch
PR #181: revert over-heavy P1-b/P1-c/P1-d, retain P0/P1-a
PR #182: thin phase gate with runnable_artifact/public_check todos
PR #183: generic final self-check hygiene
```

### 17.7 Rive drafting artifacts

```text
01-issue-pr-chronology-reader.md
02-current-code-contract-reader.md
03-discarded-branch-reader.md
04-trace-behavior-reader.md
00-final-heavy-task-mainline-teaching-manual.md
00-final-heavy-task-teaching-outline.md
00-final-heavy-task-teaching-manual.md
```

### 17.8 Trace anchors

```text
sqlite-gcov thin self-check success:
maka-p1d-sqlite-gcov-agent-owned-selfcheck-v4pro-20260623b / sqlite-with-gcov__d4sAyT9

MIPS thin 2h/160 self-check trace:
maka-mips-glm52-thin-selfcheck-2h-160steps-20260624a / make-mips-interpreter__nEaN77x

MIPS clean replay pass:
replay-mips-clean-frame-20260624a / make-mips-interpreter__7XZDQER

OpenCode MIPS comparison:
opencode-mips-glm52-harbor-wrapper-20260622b / make-mips-interpreter__EuTy5Dy
```

## 18. Final Design Conclusion

评判 heavy-task 设计，只看一个问题：

> Does it help a long benchmark task keep public engineering momentum without turning the model hot path into an audit/proof workflow or weakening official verifier authority?

当前答案是一条 thin persistent loop：

```text
mode facts explain why heavy-task is active
prompt policy pushes inventory -> runnable artifact -> public check -> repair -> self-check
inventory/todo tools persist public engineering state
self_check_submit records advisory public semantic status
compact evidence records bounded public observations internally
TaskRunStore replays append-only events into prompt/export state
semantic/runtime/official status stay separate
retry receives bounded projection but is not checkpoint resume
final hygiene is generic verifier-start-state discipline
official verifier/scorer remains authoritative
```

这条设计不能退回到：

```text
hidden verifier hints
task-specific cleanup instructions
model-authored proof chains
engineering_record/check_record live audit burden
evidenceChain finalization as hot-path requirement
self-check overriding score
retry marketed as resume
```

对新人来说，最短的正确心智模型是：

> heavy-task gives Maka a public, durable engineering memory for long benchmark runs. It records what the model has publicly inspected, what artifact/check work remains, what public evidence supports completion, and how that state should be projected across attempts. It does not decide official success. It makes success and failure more explainable while keeping the official verifier/scorer as the final authority.

对实现者来说，最重要的 invariant 是：

> Every authoritative heavy-task state must be event-backed, public-source-safe, bounded when replayed to the model, and unable to overwrite official benchmark results.

对 reviewer 来说，最重要的 warning sign 是：

> If a change makes the model spend more live steps proving work than doing runnable artifact + public check work, it is probably moving back toward the reverted branch.
