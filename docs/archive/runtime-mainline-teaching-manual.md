---
title: Maka Runtime 主线教学手册
document: MAKA_RUNTIME_MAINLINE_TEACHING_MANUAL
version: 1.0
status: architecture teaching manual
date: 2026-06-24
audience: "第一次理解 Maka runtime 的工程师、后续 runtime 架构维护者"
scope: "用设计动机和心智模型解释当前 Maka runtime 为什么分层、每层解决什么问题、少一层会怎样；源码入口只作为文末简要索引。"
primary_spine:
  - SessionManager
  - RuntimeKernel
  - AgentRun
  - RuntimeRunner
  - AiSdkFlow
  - AiSdkBackend
  - ModelAdapter
  - ToolRuntime
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

> Archived on 2026-07-13. The Runtime discussion is historical; the Headless architecture it describes was retired by #2598. Start with `ARCHITECTURE.md`.

# Maka Runtime 主线教学手册

Maka runtime 的核心设计，不是把一条用户消息直接送给模型，而是把“一次对话回合”拆成可展示、可运行、可追溯、可恢复的几类事实。

如果只用一句话概括：

> Maka 用 `SessionManager -> RuntimeKernel -> AgentRun -> RuntimeRunner -> AiSdkFlow -> AiSdkBackend` 这条主线，把“用户看到的一轮对话”和“系统内部一次可记录的模型/工具运行”分开管理。

这句话里的重点不是类名，而是分工。用户看到的是一条消息进去，一串文本、工具调用、权限请求、完成状态出来。系统内部看到的不是一件事，而是至少三件事：这条消息属于哪个 session；这次运行是不是一个独立的 run；这次 run 产生了哪些可以以后 replay、检查、恢复或投影回 UI 的 runtime facts。

如果把这些事都塞进一个大函数，短期能跑，长期会很难回答几个问题：为什么 UI 还要展示旧格式事件？为什么模型历史不能只靠聊天记录字符串？为什么 headless、autonomous、Harbor 不能都各自重写一套 agent loop？为什么未来做 checkpoint / warm retry 时，不能只保存最后一段文本？

这篇手册尝试用一个新工程师能顺着读下去的方式解释这些问题。

## Runtime 到底在解决什么问题

Maka runtime 解决的不是“怎么调用一次 LLM API”这么窄的问题。如果只是调用模型，代码可以很简单：拿用户输入，拼历史，调用 provider，流式返回文本。但 Maka 要处理的是 agent 产品里的完整运行问题。

一个用户 turn 可能会产生模型文本、thinking、工具调用、工具结果、权限请求、token usage、错误、取消、完成状态。它还可能运行在桌面交互、headless benchmark、autonomous task、Harbor container 这些不同外壳里。

这些场景有共同的核心：都需要模型/工具循环。它们也有不同的外层责任：桌面关心 UI stream，headless 关心 workspace 和 verifier，autonomous 关心 attempt/retry，Harbor 关心 container 和 benchmark reward。Maka runtime 的分层，就是为了让“共同核心”可以复用，同时让“外层责任”不要污染模型循环。

这也是为什么当前主线看起来比普通聊天应用复杂：

`SessionManager -> RuntimeKernel -> AgentRun -> RuntimeRunner -> AiSdkFlow -> AiSdkBackend -> ModelAdapter/ToolRuntime`

每一层都在回答一个不同问题。`SessionManager` 回答外部调用者怎么发起一轮对话；`RuntimeKernel` 回答这轮对话怎么被组织成一次 runtime 执行；`AgentRun` 回答这次执行在持久世界里是谁、状态是什么、怎么收尾；`RuntimeRunner` 回答一次 invocation 的开始、结束、错误和 terminal 语义是什么；`AiSdkFlow` 回答旧 backend 产出的 UI 事件怎么变成新的 runtime facts；`AiSdkBackend` 回答真正的 provider request、stream、工具、权限、usage 怎么跑。

少掉任何一层，系统不是立刻不能工作，而是会把某类责任挤到错误的位置。

## 三个大心智模型

读 Maka runtime 前，最好先建立三个词：turn、run、event ledger。这三个词容易被混在一起，但它们不是同一件事。

### Turn：用户视角的一轮

turn 是用户和 UI 最容易理解的单位。用户发一句话，系统回复一轮，这就是一个 turn。从产品视角看，turn 很自然。用户不关心 run id，也不关心 invocation id。用户只会问：我刚才这句话的回答在哪里？这轮是不是还在跑？能不能停止？能不能重试？

所以 Maka 需要保留 session/turn 这套外部接口。如果没有 turn 这个心智模型，runtime 会很容易变成内部 run ledger 的展示工具，UI 和用户操作会被迫理解太多底层概念。

### Run：系统视角的一次执行

run 是系统内部更精确的单位。一轮用户 turn 需要被真正执行一次，这次执行要有自己的身份、开始时间、状态、backend/model/cwd/permission 信息、失败原因、完成状态。这就是 `AgentRun` 想表达的东西。

run 不是单纯的 message，也不是单纯的 assistant reply。它是“这次 agent 运行”的 envelope。如果没有 run，系统会很难回答：这次运行有没有开始？它是完成、失败、取消，还是进程崩了之后留下的 stale 状态？它用了哪个 backend 和 model？它产生的 runtime events 属于哪次运行？它以后能不能作为 replay 历史的一部分？

### Event Ledger：可重建的事实账本

event ledger 是 runtime 的长期方向。聊天记录是给人看的，但 runtime facts 是给系统重建历史用的。

例如，模型说了一段文本，这当然可以进入聊天记录。但模型还发起了一个 tool call，工具返回了结构化结果，中间出现了 permission decision，最后 invocation 以某种 terminal status 结束。这些都不是普通文本能完整表达的。

所以 Maka 逐渐把 runtime 事实写成 `RuntimeEvent`。这些事件以后可以被投影回 UI，也可以用于模型 replay，也可以帮助恢复、检查和调度。如果只有聊天记录字符串，很多语义会被压扁：工具调用变成一段文本，thinking 是否可 replay 不清楚，terminal 状态和 verifier 状态容易混在一起。

这就是为什么 runtime-event ledger 很重要。

## 一条消息进入 Maka 后发生了什么

现在可以回到主线：

`SessionManager -> RuntimeKernel -> AgentRun -> RuntimeRunner -> AiSdkFlow -> AiSdkBackend -> ModelAdapter / ToolRuntime`

这条链不只是 call graph。它更像一组逐渐收窄的责任边界：外层越靠近产品和 session，内层越靠近 provider、stream 和工具执行，中间几层负责把两边翻译成稳定契约。

## 第一层：SessionManager 稳住外部入口

`SessionManager` 是外部世界最应该认识的 runtime 门面。桌面 UI、generic headless runner、测试入口、上层调用者，都不应该一上来就知道 `AgentRun`、`RuntimeRunner`、`RuntimeEventStore` 的细节。它们需要的是一个稳定动作：给某个 session 发送一条消息。

所以 `SessionManager.sendMessage()` 的意义不是“这里写了很多 runtime 逻辑”。恰恰相反，它应该尽量薄。它把外部调用者维持在 session API 上，然后把真正的 turn orchestration 交给 `RuntimeKernel.startTurn()`。

如果少了这一层，上层调用者会直接依赖 runtime 内部结构。今天可能还能跑，明天只要 run ledger 或 runtime-event replay 改了，桌面、headless、Harbor 入口就可能一起被迫改。

`SessionManager` 的教学重点是：它不是 runtime brain，而是 runtime 的公共门面。一个好的门面会让外部 API 慢变，让内部实现快变。

## 第二层：RuntimeKernel 组织一轮运行

`RuntimeKernel` 开始进入内部世界。它要处理的不是 provider stream，而是这轮运行怎么被组织起来。

它知道当前 session 有没有 active backend，知道如何创建 `AgentRun`，知道 stop 和 permission response 应该转发给谁，也知道怎么把 child run、session status、active run 注册这些状态接起来。这类状态放在 backend 里不合适。backend 应该专心处理模型和工具，不应该管理“这个 session 是否已经有 active backend”或“这个 run 怎么注册到 kernel 的 active maps 里”。

这类状态也不应该放在 `SessionManager`。门面如果背太多状态，就会变成无法替换的巨大 runtime brain。所以 `RuntimeKernel` 是 orchestration boundary。它把一轮 turn 从“外部 API 调用”变成“内部可执行的 run”。

如果少了这一层，状态会向两边泄漏：上层要懂 backend lifecycle，backend 要懂 session/run orchestration。后面想换 flow、换 backend、做 child run 或统一 headless，就会更困难。

## 第三层：AgentRun 给一次执行套上 Durable Envelope

`AgentRun` 的名字容易让人误会，以为它负责“跑 agent”。更准确地说，它负责让一次 agent 运行在持久系统里有身份、有状态、有记录。

它在开始时确定 run id、session id、turn id、lineage。它创建 operational run record。对需要 session projection 的顶层 run，它还会写用户消息和 running turn state。它会构造 prior runtime context，确保后端能看到该看的历史。

运行过程中，它接收 legacy `SessionEvent` 和新的 `RuntimeEvent`，把它们写到正确的地方。结束时，它更新 session header，写 terminal turn state，注销 active run，并把 run 标成完成或失败。这层的核心是“生命周期”，不是“模型算法”。

如果少了 `AgentRun`，一次 turn 产生的各种事实会散落在 session store、backend stream、runtime event store、run status 更新里。系统还能输出文本，但很难可靠地恢复、审计、重试或投影。

一个新工程师可以把 `AgentRun` 理解成执行护照：这次运行是谁，从哪个 session 和 turn 来，运行到哪里了，结束时该留下什么记录，以后读历史时能不能信它。这个比喻只到这里为止。它不是业务对象的花名，而是 durable lifecycle boundary。

## 第四层：RuntimeRunner 定义 Invocation 语义

`RuntimeRunner` 是很多人第一次读时最容易跳过的一层，因为它看起来像“又包了一层 flow”。但它解决的是一个关键问题：不同 backend 或 flow 都可以产生事件，但一次 invocation 的基本语义必须一致。

例如，初始 user runtime event 应该什么时候出现？flow 产出的 events 怎样收集？没有 terminal event 算什么？abort、error、permission、finish reason 怎样归类？invocation result 应该怎样结构化返回？这些语义如果交给每个 backend 自己决定，未来就很难做统一 read model、checkpoint、调度、测试和恢复。

`RuntimeRunner` 因此是 backend-neutral invocation shell。它不直接写 storage，不关心 provider，不执行工具。它定义“一次 invocation 应该如何开始、如何遍历 flow、如何判断结束、如何归类结果”。

如果少了这一层，`AiSdkBackend` 可能直接 stream 给 UI，同时顺手定义 terminal 语义。短期少一层，长期会把 provider 细节和 runtime 语义绑死。这也是它对未来很重要的原因：checkpoint / warm retry 需要先知道 invocation 的边界在哪里。没有统一 invocation 边界，就很难说“恢复到哪一步”。

## 第五层：AiSdkFlow 做迁移适配

`AiSdkFlow` 不是新的模型 backend。它是一个 adapter。

当前 Maka 已经有 `AiSdkBackend` 能产生 renderer-facing `SessionEvent`。这些事件服务 UI 和旧 session projection 很久了，不能一下子全部丢掉。但新 runtime 需要 canonical `RuntimeEvent`。

`AiSdkFlow` 的工作就是把旧 backend stream 接入新 runtime 世界：它调用 `backend.send()`，把每个 `SessionEvent` 映射成 `RuntimeEvent`，同时继续让 legacy event 往外流。

这是一种迁移设计。它让系统不必一次性重写整个模型/工具循环，也能开始积累 runtime-event ledger。如果少了 `AiSdkFlow`，要么旧 backend 直接被迫产出新 runtime events，要么 runtime 只能继续依赖旧 UI event。这两种都不理想：前者迁移风险大，后者无法建立新的语义账本。

所以 `AiSdkFlow` 的价值是过渡而不是炫技。它承认旧世界还存在，同时把旧世界翻译给新世界。

## 第六层：AiSdkBackend 仍是模型和工具循环的大块核心

读到这里，不能误以为 runtime 已经把 AI SDK backend 抽空了。当前真正的 provider/model/tool loop 仍然主要在 `AiSdkBackend.send()` 里。

它要做很多事：解析 provider 和 model；决定本轮模型可见哪些工具；构造 prior messages 和当前 user message；选择 runtime-event replay、text-only replay 或 stored-message fallback；启动 AI SDK stream；处理 text、thinking、finish reason、usage；让 `ToolRuntime` 执行工具、处理权限、写 tool call/result；记录 request shape、usage、cost、telemetry。

这不是简单的“调用模型”。它更像一次 provider request 的总装线。

`ModelAdapter` 把 AI SDK 和 provider 差异包住，负责调用形状、stream chunk 归一化、usage 字段归一化。`ToolRuntime` 把工具执行和权限包住，负责 tool call、permission coroutine、tool result、异常归一化、输出 delta 和工具 telemetry。`ToolAvailabilityRuntime` 控制工具面，决定哪些工具对模型可见，并在执行边界继续防守。

但这些组件的顺序仍然由 `AiSdkBackend` 组织。如果过早把它拆碎，最危险的不是代码编译不过，而是改变模型看到的 request shape：工具 schema 顺序、history replay 策略、context budget、permission 事件、usage 归因都可能悄悄变化。

所以后续拆分应该先保护执行顺序，再谈文件大小。

## 三套存储为什么要分开

Maka runtime 当前最容易让新人困惑的地方，是为什么同时有 `SessionStore`、`AgentRunStore`、`RuntimeEventStore`。直觉上，一个系统不是应该只有一份聊天记录吗？问题在于，它们回答的问题不同。

### SessionStore：给 Session 和 UI 的投影

`SessionStore` 保存的是 session JSONL：第一行 session header，后面是 `StoredMessage`。它对 UI、旧 API、active run 展示、兼容读写都很重要。用户看到的消息、assistant 文本、tool rows、permission decision、token usage、turn state，都可以在这个世界里出现。

所以 `SessionStore` 不是已经被废弃。它仍然在写，仍然在读，仍然是迁移期重要的 compatibility projection。但它不适合作为唯一的语义来源，因为 `StoredMessage` 更像展示和兼容格式。它可以表达很多东西，但不是 runtime 的 canonical fact model。

如果只保留 `SessionStore`，后续 replay 会经常面对“这段展示消息背后到底是 tool call、tool result、permission 还是 terminal fact”的问题。

### AgentRunStore：给 Run 生命周期的账本

`AgentRunStore` 保存 run header 和 operational events。它关心的是一次 run 的生命周期：created、started、running、completed、failed、usage、permission、tool operational facts。

它适合回答：这个 run 是什么状态？它什么时候开始？它是否 stale？恢复时应该把它归为什么状态？它和哪个 session/turn/backend/model 相关？

这不是 UI transcript，也不是模型 replay 历史。如果没有 `AgentRunStore`，系统也许还能展示聊天，但很难可靠管理 run 状态。崩溃恢复、任务调度、超时归因、attempt 记录都会变得含糊。

### RuntimeEventStore：给语义 Replay 的账本

`RuntimeEventStore` 保存 canonical `RuntimeEvent`。这是最接近 runtime 真相的一层。

它记录 initial user event、model text/thinking、function call、function response、permission/token usage actions、terminal runtime facts。它的目标不是替代 UI，而是让系统以后能从语义事实重建历史。

这对模型 replay 尤其关键。文本 transcript 可以告诉模型“之前说了什么”。runtime events 还能告诉系统“之前调用过什么工具、工具返回是什么、thinking 是否可作为 provider-native 语义保留、terminal 状态是什么”。

如果没有 `RuntimeEventStore`，Maka 只能继续依赖 legacy projection。那会让 provider-native replay、read model、checkpoint high-water mark 都缺少可靠基础。

### 三者的关系

可以这样理解：`SessionStore` 是给人和旧系统看的投影，`AgentRunStore` 是给运行生命周期看的账本，`RuntimeEventStore` 是给语义 replay 和未来恢复看的账本。

三者都重要，只是权威性取决于你问的问题。问 UI 当前要展示什么，`SessionStore` 仍然重要。问 run 是否完成，`AgentRunStore` 更重要。问 completed run 的模型历史怎么 replay，`RuntimeEventStore` 是更好的起点。

当前 Maka 是迁移态，所以会双写、会 fallback、会比较 projection。这不是设计混乱，而是为了在不打断现有产品路径的情况下，把语义权威逐步迁到 runtime events。

## Runtime-event Replay 为什么不是简单重放日志

`RuntimeEventStore` 很重要，但不能被误解成“把 runtime-events.jsonl 从头到尾喂给模型就行”。Maka 的 replay 是有 gate 的。

它只把 prior top-level terminal runs 纳入默认 replay。child runs 默认不混进顶层 transcript。它要求 terminal prior run 有 runtime-event ledger，并且有 terminal runtime fact。它会丢弃 partial events，诊断 action-only facts、terminal facts、unsupported content、unmatched tool results 等情况。它会根据 provider 能力选择 provider-native replay、text-only replay 或 stored-message fallback。

这套 gate 的意义是：不要把不完整或 provider 不支持的语义假装成完整历史。例如，tool call/result 如果能以 provider-native 形式 replay，语义最好；如果 provider 不支持，那就不能盲目把它塞成普通文本还假装等价。系统可以 fallback，但应该知道自己损失了语义。

所以 runtime-event replay 的目标不是“永远不用 StoredMessage”。它的目标是：有可靠语义时用语义；语义不完整或不支持时，明确降级。

## Headless、Autonomous、Harbor 为什么在 Runtime 外面

理解完核心 runtime，再看外层会清楚很多。headless、autonomous、Harbor 都不是另一套 runtime。它们是在不同运行环境里包住 runtime。

### Generic Headless：最薄的外壳

generic headless runner 基本复用交互式路径。它准备 workspace，创建 `SessionManager`，创建 session，然后 drain `sendMessage()`。

runtime 完成之后，它才进入 headless 自己的世界：freeze workspace、准备 scoring workspace、跑 verifier、调用 scorer。这说明 verifier/scorer 不是 runtime terminal。runtime terminal 只说明模型/工具 invocation 怎么结束。benchmark pass/fail 是 runtime 之后，基于 workspace 和 verifier 计算出来的结果。

如果把 verifier 塞进 runtime，runtime 就会变得只服务 benchmark，而不是通用 agent execution。

### Task Controller：复用核心组件，但有自己的任务账本

task controller 更复杂。它要记录 task-run、attempt、workspace lease、isolation facts、permission grants、runtime feedback、verifier result、score result。这些都不是普通 interactive session 的责任。

所以它没有简单走 `SessionManager` facade，而是手动组装 `AgentRun -> AiSdkFlow -> RuntimeRunner` 这条核心链。这带来一点重复：`runRuntimeAttempt()` 和 `RuntimeKernel.runAgentTurn()` 很像。

但重复背后有原因。task path 需要非 streaming attempt result，需要 task-run WAL，需要 isolated backend lifecycle，需要 verifier/scorer 边界。这不是说重复永远应该保留。未来可以抽一个 shared turn runner。

教学上要先理解：task controller 不是在重新实现模型循环，它是在 runtime 周围加任务评测语义。

### Autonomous：多 Attempt 策略，不是 Invocation Resume

autonomous loop 又往外一层。它关心 attempts、预算、feedback、自检、verifier feedback、retry/continue decision。每个 attempt 调一次 `runTaskOnce()`。

如果要继续或重试，它会开始新的 attempt，并用 instruction override 或 feedback prompt 把上轮结果带过去。这不是 same-session checkpoint resume，也不是把中断的 `RuntimeRunner` 从半路接起来。它是 task-level retry/continue。

如果把 autonomous retry 误写成 invocation resume，后续 checkpoint 设计会站在错误基础上。

### Harbor：Benchmark / Container 外壳

Harbor 更外层。host-side runner 负责生成 Harbor job config、启动 `harbor run`、收集 reward 和 artifacts。

Python `MakaAgent` 是 Harbor installed agent。它在 Harbor 环境里拿到任务指令，必要时启动 host-side Node cell，并把模型可见的工具执行通过 HTTP executor 转回 Harbor task container。

真正的 Maka runtime session 在 Node cell 里创建。cell 创建 stores、backend registry、`SessionManager`、session，然后 drain `sendMessage()`，最后写 `runtime-events.jsonl` 和 `maka-cell-output.json`。

Harbor 因此不是 runtime backend。它是 benchmark/container/tool-execution boundary。这个边界很重要：LLM key 可以留在 host，工具命令可以在 container 里执行，runtime events 可以作为 cell artifact 出来，verifier reward 由 Harbor 产生。

如果把 Harbor 当成 runtime backend，就会混淆 credential、container、tool executor、runtime session、verifier reward 这几层责任。

## 为什么这套设计对未来 Checkpoint / Scheduling 有意义

当前 Maka 还没有把所有 checkpoint / warm retry 问题都解决。但现在的分层已经在为这些问题铺路。

未来如果一个长任务超时，系统至少要分清几个层级：invocation 是否有 terminal runtime fact；run header 是 completed、failed、cancelled，还是 stale；runtime-event ledger 写到了哪个 high-water mark；workspace 有没有可恢复 snapshot；外层 task attempt 是不是已经 verifier 过；Harbor container 和 reward 状态是否还存在。

这些问题不属于同一层。`RuntimeRunner` 帮你定义 invocation 边界。`AgentRunStore` 帮你定义 run lifecycle。`RuntimeEventStore` 帮你找到语义事件高水位。task controller 帮你定义 attempt、workspace、verifier/scorer。Harbor 帮你定义 container trial 和 benchmark artifacts。

如果没有这些分层，checkpoint 设计会很容易变成一句笼统的“保存上下文并重试”。但真正难的是保存哪种上下文。

只保存文本 transcript，可能丢 tool semantics。只保存 runtime events，可能缺 workspace snapshot。只保存 workspace snapshot，可能不知道模型已经看过什么、工具已经返回什么。只保存 task attempt，可能只能 cold retry，不能 warm resume。

所以未来设计要把 runtime high-water mark、run status、workspace snapshot、task/Harbor 状态配对起来。这篇手册不把 checkpoint 当成已完成能力来描述，只说明为什么当前 runtime 分层让这个问题有机会被严肃建模。

## 新人最容易误解的地方

第一个误解：`SessionManager` 是 runtime 的全部。更准确地说，`SessionManager` 是外部入口。它让调用者不用知道内部运行结构。

第二个误解：`AgentRun` 就是模型循环。`AgentRun` 是 durable run envelope。真正的模型/工具循环主要还在 `AiSdkBackend`。

第三个误解：`RuntimeRunner` 只是多包了一层。它定义 invocation 语义。没有它，terminal、error、abort、missing terminal 等语义会散在 backend 里。

第四个误解：`AiSdkFlow` 已经替代了 `AiSdkBackend`。没有。`AiSdkFlow` 是迁移 adapter，负责把 legacy `SessionEvent` 转成 canonical `RuntimeEvent`。

第五个误解：`SessionStore` 已经可以删。不能。active UI、兼容 projection、旧读写路径仍然依赖它。

第六个误解：runtime-events 可以无条件 replay。不能。partial、terminal fact、provider-native support、unsupported diagnostics 都要经过 gate。

第七个误解：autonomous retry 就是 checkpoint resume。当前更像新 attempt 加反馈 prompt，不是从同一个 invocation 中点恢复。

第八个误解：Harbor 是 Maka runtime 的一种 backend。不是。Harbor 是 benchmark/container/tool-execution 外壳；Maka runtime session 在 Node cell 里。

第九个误解：runtime 成功等于 benchmark 成功。runtime 成功只说明 invocation 完成。benchmark 还要看 workspace、verifier、scorer 和 reward。

第十个误解：以后拆 `AiSdkBackend` 只要按文件大小拆。不行。要先保护 provider request shape、tool visibility、history replay、permission path、usage/cost 归因这些顺序契约。

## 设计取舍和仍未完全回答的问题

这套设计的第一个代价是迁移期复杂。旧 `SessionEvent` / `StoredMessage` 不能立刻消失，新 `RuntimeEvent` 又必须开始承担 replay/read-model 语义。于是系统会同时写投影、run ledger、runtime ledger。改事件映射时，维护者要考虑 UI、session projection、run status、runtime replay、read model 多个面。

第二个代价是 `AiSdkBackend` 仍然很重。它承担了 provider resolution、tool availability、history replay、context budget、stream pump、tool execution、usage/cost、telemetry 等编排。这个模块未来值得拆，但拆分需要设计顺序依赖图。

第三个代价是 task controller 复制了一段 kernel turn shell。它这样做有任务评测上的理由，但长期看可能需要 shared turn runner。问题是这个 shared API 必须允许 task path 注入 task-run WAL、permission intervention、isolated backend lifecycle、非 streaming result 和 verifier/scorer 后处理。

第四个代价是 Harbor 横跨 host、container、runtime 三个边界。这对 benchmark isolation 有价值，但 timeout/cancel/tool executor failure/credential handling 的 taxonomy 会更复杂。未来 warm retry 要清楚区分 runtime failure、tool executor failure、Harbor infra failure、verifier failure。

第五个开放问题是 child run replay。当前默认 top-level transcript/read-model 排除 child runs，避免子代理内部细节污染主会话。未来如果要把子代理成果纳入主历史，可能需要显式 subagent summary 或 source-bearing replay policy，而不是直接混入所有 child runtime events。

第六个开放问题是 `SessionStore` 的长期地位。它可能逐渐变成 derived projection，也可能因为 UI/compatibility 需要长期保留。现在不能提前假设它已经过时。

## 最后总结

Maka runtime 当前的设计可以从一个简单问题开始理解：一条消息进入 Maka 后，为什么不直接丢给模型？

答案是：因为 Maka 需要的不只是模型回复，还需要 session 兼容展示、run 生命周期、invocation 语义、runtime-event replay、工具/权限执行、headless/task/Harbor 外壳，以及未来可恢复和可调度的事实边界。

`SessionManager` 稳住外部入口。`RuntimeKernel` 组织一轮运行。`AgentRun` 记录一次 durable run。`RuntimeRunner` 定义 invocation 语义。`AiSdkFlow` 把旧事件流翻译成新 runtime facts。`AiSdkBackend` 驱动模型和工具循环。

`SessionStore`、`AgentRunStore`、`RuntimeEventStore` 分别承担 session projection、run lifecycle、semantic replay ledger。headless、autonomous、Harbor 则在 runtime 外面处理 workspace、attempt、verifier、scorer、container、reward。

这套结构的价值，不是让调用链变长，而是让每一类事实有自己的归属。只有归属清楚，未来才可能安全地做 read model、checkpoint、warm retry、调度集成和 backend 拆分。

## 简要来源索引

相关文档：

- `docs/archive/runtime-kernel.md`
- `docs/archive/runtime-v2-architecture-evolution.md`
- `docs/archive/runtime-v2-implementation-notes.md`

少量源码证据入口：

- `packages/runtime/src/session-manager.ts`
- `packages/runtime/src/runtime-kernel.ts`
- `packages/runtime/src/agent-run.ts`
- `packages/runtime/src/runtime-runner.ts`
- `packages/runtime/src/ai-sdk-flow.ts`
- `packages/runtime/src/ai-sdk-backend.ts`
- `packages/runtime/src/model-adapter.ts`
- `packages/runtime/src/tool-runtime.ts`
- `packages/runtime/src/tool-availability.ts`
- `packages/runtime/src/model-history.ts`
- `packages/runtime/src/runtime-read-model.ts`
- `packages/storage/src/session-store.ts`
- `packages/storage/src/agent-run-store.ts`
- `packages/core/src/runtime-event.ts`
- `packages/headless/src/runner.ts`
- `packages/headless/src/task-agent-controller.ts`
- `packages/headless/src/autonomous-agent-loop.ts`
- `packages/headless/src/harbor-task-runner.ts`
- `packages/headless/src/harbor-cell.ts`
- `packages/headless/harbor/maka_agent.py`
