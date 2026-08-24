---
title: Maka DeepSeek-Reasonix 成本运行线 System Design
document: DEEPSEEK_REASONIX_COST_RUNTIME_SYSTEM_DESIGN_V2
version: 2.0
status: design draft with rationale
date: 2026-06-24
audience: "准备实现或评审 Maka cost-runtime 方向的新工程师"
derived_from:
  - "Maka Runtime 主线教学手册 v2"
  - "Maka DeepSeek-Reasonix 成本运行线初学者教纲 v3"
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

> Archived on 2026-07-13. This is an implementation-slice and open-question chronicle, not current runtime authority. Current cost, request-shape, replay, and compaction mechanisms live in the backend architecture chapters and source.

# Maka DeepSeek-Reasonix 成本运行线 System Design v2

这份文档不是教学手册的压缩版，而是从两份教学材料反推出来的一版系统设计文档。

v2 在 v1 的基础上补上最重要的一层：为什么要这样设计。每个关键设计不只描述“怎么切”，还要回答：

1. 它面对的真实问题是什么？
2. 它为什么放在这个边界，而不是放在别处？
3. 它带来什么好处？
4. 如果不这样设计，系统会怎样退化？

教学手册回答的是：“新人应该怎样一步一步理解这条线？”

系统设计文档要回答的是：“如果我们要把这条线作为 Maka 的长期 runtime 设计，哪些边界、状态、数据结构、fallback 和取舍必须被固定下来？”

本文的中心设计判断是：

> DeepSeek-Reasonix 成本运行线不应该新建一条 agent flow。它应该沿着 Maka 已有的 `SessionManager -> RuntimeKernel -> AgentRun -> RuntimeRunner -> AiSdkFlow -> AiSdkBackend -> ModelAdapter/ToolRuntime` 主线，把 provider-visible request 的成本纪律安装到现有边界上。

换句话说，这不是一个 `CostRuntime` 设计，而是一个 cost-aware runtime discipline 设计。

## 0. 设计问题从哪里开始

最朴素的问题是：

> 一个 agent 会话为什么会越来越贵？

最常见的错误答案是：

> 因为历史越来越长，prompt token 越来越多。

这个答案只对了一半。DeepSeek 这类 provider 的成本不能只看 total input。Maka 已经观察过反直觉案例：history budget 让 total input 下降，但 cache miss 和估算成本反而上升。

所以本设计不以“压缩 prompt”为第一目标。它的第一目标是让系统能稳定回答四个问题：

1. Provider 到底看到了什么 request？
2. Provider 把哪些 token 当成 cache hit、cache miss、cache write、output、reasoning？
3. 如果成本变了，是 durable prefix 变了，还是 history projection 变了，还是 tool schema 变了？
4. 为了省成本而改变 replay 时，原始事实、来源和恢复路径是否还在？

这四个问题决定了整个设计。

还有第五个隐含问题：

> 新人为什么会觉得这些设计“绕”？

因为很多设计不是为了本轮能跑，而是为了长期能解释、能回退、能迁移、能做 checkpoint、能比较 paid matrix。一个只追求“这轮少传点 token”的实现，短期看更直接；但 Maka 要做的是 agent runtime，不是一次性 prompt 工具。它必须在成本、正确性、证据、可恢复、工具权限、UI 投影之间同时站住。

所以本文采用一种固定写法：每一层先讲设计压力，再讲边界选择，再讲收益和失败模式。读者不需要先相信结论，而是能从问题推导到结论。

## 1. 设计目标

### 1.1 可观察

每次 model request 都应该留下足够的 usage、cost、request-shape diagnostics，让后续能解释成本变化。

可观察不是只记录一个总 token 数。它至少要区分：

- input tokens
- cache hit input tokens
- cache miss input tokens
- cache write input tokens
- output tokens
- reasoning tokens
- miss counter 是 provider 明确给出的，还是 Maka 推导出来的
- durable prefix 是否变化
- full request shape 是否变化

### 1.2 可解释

当 cache miss 上升时，系统不能只说“本轮更贵”。它要能进一步说明：

- model/provider 是否变化
- system prompt 是否变化
- provider options 是否变化
- active tool schema 是否变化
- history projection 是否变化
- current turn tail 是否变化

这些解释不等价于 provider 内部 cache key。Maka 不知道 DeepSeek 的真实 cache key。Maka 做的是本地 request-shape 诊断。

### 1.3 可回退

历史裁剪、工具结果归档、summary 替换、archive hydration 都只能改变本轮 provider request 的 replay projection，不能改写原始 runtime facts。

如果 archive 失败，保留原文。

如果 synthesis cache 不可信，跳过 summary。

如果 provider-native replay 不支持，显式降级。

系统可以少省一点 token，但不能为了省 token 丢掉证据。

### 1.4 可维护

成本线不能复制模型/工具循环。

Maka 已有主线已经承担：

- session facade
- run lifecycle
- invocation terminal semantics
- legacy event 到 runtime event 的迁移适配
- provider request assembly
- model stream
- tool call/result
- permission
- abort
- usage
- telemetry

如果新建 `CostAwareAiSdkFlow`，它要么复制这些语义，要么绕回旧 backend。两种都不划算。

所以本设计选择把成本能力放到既有路径的关键边界，而不是开新路。

## 2. 非目标

本设计明确不解决以下问题：

1. 不定义 DeepSeek provider 内部 cache key。
2. 不把 `prefixHash` 当成真实 provider cache key。
3. 不引入新的 model/tool stepping engine。
4. 不重写 `AiSdkBackend` 的完整循环。
5. 不把 local memory 产品完整纳入成本系统，只处理和 prompt placement 有关的部分。
6. 不把 Harbor verifier、benchmark reward、task attempt retry 合并进 runtime terminal 语义。
7. 不承诺 history budget、summary、archive hydration 在所有 workload 上都必然省钱。

这些非目标很重要。成本设计最容易失败的方式，就是把“诊断工具”误当 provider 真相，或者把“一个 paid matrix 里的结论”误当全局定律。

## 2.5 从问题压力推导设计

在进入组件前，先把设计动机讲清楚。DeepSeek-Reasonix 成本线不是从某个抽象类开始的，而是从几组冲突压力推出来的。

### 压力一：token 少了，账单不一定少

普通 prompt 优化会把问题表述为：“上下文太长，所以要压短。”

但 DeepSeek 的 cache-sensitive billing 让这个说法不够用。一个 request 的 total input 下降，可能同时让 cache miss 上升。对成本更敏感的不是“总共有多少输入”，而是 provider 把哪些输入当成 fresh token、哪些当成 cache read、哪些写入 cache。

这带来第一个设计结论：

> 先建立可信的 usage/cost 账本，再谈压缩。

如果跳过这一步，所有 history budget、summary、tool economy 的评估都会变成错觉。系统可能庆祝 prompt 变短，却把真正付费的 cache miss 推高。

收益是：成本优化从感觉变成可测量事实。

失败模式是：团队只看 total token，反复上线“看起来更短、实际更贵”的策略。

### 压力二：成本变化必须能归因

知道本轮更贵，还不够。系统还要解释为什么更贵。

成本变化可能来自很多地方：

- system prompt 变了
- provider options 变了
- active tool schema 变了
- history projection 变了
- current turn tail 变了
- model/provider 变了

这些变化对 provider cache locality 的影响不同。把它们混成一个总 hash，评审者仍然不知道问题在哪里。

这带来第二个设计结论：

> provider-visible request 要拆成 durable prefix 和 full request shape 两层诊断。

收益是：当 cache miss 变多时，系统能说“稳定前缀没动，只是历史 projection 变了”，或者“工具 schema 进入 active set，prefix 发生了真实变化”。

失败模式是：成本 trace 只有一串 token 数，没有解释能力，团队只能靠猜。

### 压力三：当前事实有用，但会污染稳定前缀

cwd、git status、日期、刚批准的 memory update 都对当前回复有用。但它们每轮都变。如果把这些内容塞进 durable system prompt，prefix hash 会持续抖动。

这带来第三个设计结论：

> 稳定规则进入 durable system prompt，当前事实进入 turn tail。

收益是：模型仍然看到当前事实，但 prefix diagnostics 不会被无意义扰动。

失败模式是：团队以为 system prompt 没变，实际每轮都被日期、cwd、memory update 改写；cache miss 上升却找不到原因。

### 压力四：历史要变轻，但事实不能消失

长会话里最贵的往往不是用户文本，而是旧工具结果、网页内容、JSON、搜索结果、文件片段。直接删掉它们当然能省 token，但会丢证据。

这带来第四个设计结论：

> RuntimeEvent ledger 是事实，replay projection 才是本轮可优化视图。

收益是：本轮 provider request 可以变轻，系统仍然保留原始事实、来源和恢复路径。

失败模式是：优化策略把历史真的删了，后续 raw evidence、audit、checkpoint、debug 都失去依据。

### 压力五：summary 不能成为无来源记忆

summary 看起来是历史压缩的自然手段，但没有来源的 summary 会变成一种危险的新事实。它可能覆盖了哪些 turns、漏了哪些限制、从哪些 tool result 来，后面都说不清。

这带来第五个设计结论：

> synthesis cache 和 history compact 都必须是 source-bearing replay artifacts。

收益是：summary 可以作为 projection 优化，但仍然带 coverage、limitations、sources 和 fallback。

失败模式是：模型开始依赖一段没人能追溯的“总结”，错误会被长期 replay。

### 压力六：工具 schema 不是免费的

工具在本地执行，但工具 schema 会被 provider 看见。只要 schema 进入 request，它就是 provider-visible 成本和 prefix shape 的一部分。

这带来第六个设计结论：

> full dispatch registry 和 provider-visible active tools 必须分开。

收益是：本地仍保留完整能力，provider 初始只看到必要 schema；需要重工具时通过显式 `load_tools` 加载，并进入 ledger。

失败模式是：每轮都把全部工具 schema 发给 provider，初始 prompt 重、prefix 大、诊断不清；或者过度动态路由导致工具不可用和 prefix 抖动。

### 压力七：不能为了成本复制 runtime

DeepSeek 成本线涉及 provider request、history replay、tools、usage、telemetry，看起来像可以新建一个 `CostRuntime`。但 Maka 已经有完整模型/工具循环和 runtime ledger 迁移路径。

这带来第七个设计结论：

> 成本线应安装到现有 runtime path 上，而不是新建 flow。

收益是：权限、abort、tool result、usage、terminal semantics 仍然只有一套权威。

失败模式是：新 flow 复制旧 backend，形成两套不一致的 agent loop；未来 bug 修复、checkpoint、tool policy、telemetry 都要维护两遍。

这七个压力就是后面设计层的来源。后面的每一层都不是孤立技巧，而是在回答这些压力中的一部分。

## 3. 基础运行脊柱

成本线必须建立在 Maka runtime 主线上：

```text
SessionManager
  -> RuntimeKernel
    -> AgentRun
      -> RuntimeRunner
        -> AiSdkFlow
          -> AiSdkBackend
            -> ModelAdapter
            -> ToolRuntime
            -> ToolAvailabilityRuntime
```

这条主线不是为了让调用链变长，而是为了让事实归属清楚。

为什么成本线要先讲 runtime spine？

因为成本问题看起来在 provider request 上，实际会牵动整个 agent runtime：

- request 由谁组装
- prior history 从哪里来
- tool result 写到哪里
- usage 算在哪个 run 上
- UI 看到什么 projection
- replay 以后用哪套事实
- retry/checkpoint 以后从哪里恢复

如果没有这条 spine，成本策略很容易变成一堆散落的 prompt hack。今天在 desktop path 生效，明天 headless 不生效；今天 usage 写进 session，明天 replay 找不到；今天 tool result 被压缩，后天 checkpoint 没有原始证据。

所以设计的第一步不是“怎么省”，而是“省的动作发生在哪个权威边界上”。

这条 spine 带来的核心好处是：

- 外部入口稳定：调用者不需要理解 provider replay 细节。
- run 生命周期稳定：成本 telemetry 有归属。
- invocation 语义稳定：错误、abort、missing terminal 不被成本策略打散。
- backend request 权威稳定：不会出现多处拼 provider messages。
- legacy -> runtime-event 迁移稳定：成本优化不会绕开未来 ledger。

如果绕过这条 spine，成本优化短期可能更快，但长期会变成 runtime 分叉。

### 3.1 SessionManager

`SessionManager` 是外部 facade。桌面 UI、headless runner、测试入口不应该直接理解 run ledger、runtime-event store、provider replay plan。

成本线不应该把 policy 塞到 `SessionManager`。这里最多负责把外部请求送入 runtime。

设计约束：

- 不在这里计算 provider request shape。
- 不在这里做 context budget。
- 不在这里决定 tool schema economy。
- 不在这里直接归一化 provider usage。

为什么这样设计：

`SessionManager` 的价值是让产品入口慢变。成本策略属于 provider-visible request assembly，如果把它放到 facade，外部 API 就会被迫理解内部优化细节。

好处是：UI/headless/test 仍然只发起 session turn，不需要随着 request-shape、context-budget、tool economy 的演进反复改接口。

不这样做的后果是：每个入口都可能自己加一份成本逻辑，最后桌面和 headless 的成本行为不一致。

### 3.2 RuntimeKernel

`RuntimeKernel` 组织一轮 turn。它知道 active backend、active run、stop、permission response、child run、session status。

成本线仍然不应该在这里展开 provider request。它可以把当前 turn 的运行组织好，但 provider-visible request 的具体形状属于更内层。

设计约束：

- 保持 turn orchestration 边界。
- 不复制 `AiSdkBackend` request assembly。
- 不把 cost policy 做成 kernel 级分支 flow。

为什么这样设计：

`RuntimeKernel` 解决的是“一轮 turn 如何被组织”，不是“这一轮 provider request 具体长什么样”。它应该知道 active run 和 permission/stop 路由，但不应该决定 history projection 或 tool schema。

好处是：kernel 可以继续服务所有 runtime path，而 cost policy 可以在 backend/request 边界独立演进。

不这样做的后果是：kernel 会变成第二个 backend，开始同时管理 turn lifecycle 和 provider request assembly，边界会迅速失控。

### 3.3 AgentRun

`AgentRun` 是 durable run envelope。它让一次执行有 run id、session id、turn id、状态、lineage、terminal outcome。

成本线要依赖它提供的 run identity 和 runtime context，但不能让成本 projection 改写 run fact。

设计约束：

- usage/cost 可以成为 run 的 telemetry fact。
- runtime-event ledger 是 replay 的事实来源。
- context budget 只能派生 projection，不能改变 run ledger。

为什么这样设计：

一次成本数据必须属于某个 run，否则 later trace 无法回答“这笔钱是哪次执行产生的”。但 run ledger 本身不是压缩对象。它记录的是执行事实，不是为了下一次 request 省 token 的临时视图。

好处是：usage/cost、request shape、terminal state 可以一起归属到同一个 durable run；未来 checkpoint 或 replay 时可以追溯。

不这样做的后果是：成本数据散落在 session text 或 backend logs 里，后续无法把一次 cache miss spike 和具体 run、history projection、tool schema 变化连起来。

### 3.4 RuntimeRunner

`RuntimeRunner` 定义 invocation 语义：开始、遍历 flow、收集 event、判断 terminal、归类 abort/error/missing terminal。

成本线不应该绕开它。否则同一次 provider request 的 terminal 语义会散落到 backend 或新 flow。

设计约束：

- cost-aware replay 仍然发生在一次 invocation 里面。
- invocation terminal 仍然由 `RuntimeRunner` 统一归类。
- future checkpoint/warm retry 需要这个边界。

为什么这样设计：

成本策略可能影响 provider request，但不应该重定义一次 invocation 怎样开始、怎样结束、怎样失败。terminal 语义一旦分叉，runtime read model、task retry、checkpoint high-water mark 都会受影响。

好处是：不管是否启用 history budget、tool schema economy、synthesis cache，一次 invocation 的结束语义仍然一致。

不这样做的后果是：某些成本路径可能把 provider error 当 completed，或者把 missing terminal 隐藏掉，最终让 UI、task runner、Harbor 对同一次运行得出不同结论。

### 3.5 AiSdkFlow

`AiSdkFlow` 是迁移 adapter。它调用旧 `AiSdkBackend`，把 legacy `SessionEvent` 转成 canonical `RuntimeEvent`。

成本线不应该把 `AiSdkFlow` 升级成新的 cost engine。它仍然是 adapter。

设计约束：

- 不在这里复制 tool loop。
- 不在这里独立拼 provider messages。
- 不在这里定义新的 usage model。

为什么这样设计：

`AiSdkFlow` 是迁移桥，不是新 engine。它存在的原因是 Maka 正在从 legacy `SessionEvent` 迁向 canonical `RuntimeEvent`。如果把成本 engine 放在这里，它就会同时承担迁移 adapter 和 provider runtime 两种责任。

好处是：旧 UI 事件和新 runtime facts 可以继续双轨迁移，而成本逻辑仍然在真正组装 request 的 backend 层。

不这样做的后果是：flow 层开始知道太多 provider/tool 细节，迁移桥会变成不可替换的 runtime brain。

### 3.6 AiSdkBackend

`AiSdkBackend` 是成本线的主安装点。

它已经负责：

- provider/model resolution
- system prompt 和 current user message 组装
- turn tail 拼接
- prior message replay
- context budget
- active tools
- AI SDK stream
- tool call/result
- permission
- usage/cost/telemetry

这意味着 DeepSeek-Reasonix 成本能力主要应该安装在这里和它调用的 helper 边界上。

设计约束：

- 保持 provider request assembly 的单一权威。
- 在 request 发出前计算 request-shape diagnostics。
- 在 stream 完成后归一化 usage 并计算 cost。
- 让 history economy 和 tool schema economy 都进入 diagnostics。

为什么这样设计：

`AiSdkBackend` 是唯一同时看见 system prompt、turn tail、prior messages、active tools、provider options、stream usage 和 tool execution 的位置。成本线需要解释 provider-visible request，因此必须靠近这个边界。

好处是：所有改变 request shape 的动作都能在同一个地方被诊断，usage/cost 也能和 request shape 对齐。

不这样做的后果是：prompt placement 在桌面，history budget 在 context helper，tool schema 在 tool runtime，usage 在 adapter，各自写 telemetry，却没有一处能解释“这次 provider 到底看到了什么”。

## 4. 三套账本的权威边界

成本线依赖三套存储，但不能混用它们的权威性。

```text
SessionStore        -> UI/session projection
AgentRunStore       -> run lifecycle ledger
RuntimeEventStore   -> semantic replay ledger
```

### 4.1 SessionStore

`SessionStore` 仍然服务 UI 和兼容投影。它保存用户看得懂的 session transcript。

成本线不能只从 `SessionStore` 拼历史，因为展示文本会压扁 runtime semantics。

### 4.2 AgentRunStore

`AgentRunStore` 记录一次 run 的生命周期。它回答 run 是否 created、started、completed、failed、cancelled、stale。

成本线可以把 usage/cost 作为 run telemetry，但不要把 replay projection 当成 run state。

### 4.3 RuntimeEventStore

`RuntimeEventStore` 是 replay 的语义事实来源。它记录 user event、model text/thinking、function call、function response、permission、usage、terminal facts。

成本线对历史做的所有优化，都应该从 `RuntimeEvent` 派生 projection，而不是改写 ledger。

## 5. 设计层一：先把钱算对

第一层设计只处理 usage normalization 和 cost computation。

本层解决的问题：

> 团队不能用错误的成本指标来评估成本优化。

为什么必须先做这一层？因为后续所有策略都要靠它验收。history budget、archive pruning、synthesis cache、tool schema economy 看起来都在减少输入，但真正要比较的是 cache miss、cache write、cache read、output、reasoning 的组合成本。

好处：

- 能解释“input 少了但更贵”的情况。
- 能避免用 total token 指挥 DeepSeek 策略。
- 能把 provider 明确给出的 miss 和 Maka 推导出的 miss 区分开。
- 能为 paid matrix 提供可信数据。

不这样做的后果：

- 优化方向会被 total input 误导。
- derived counter 会被误当 provider fact。
- cost regression 可能被误报成 improvement。
- 后续 request-shape diagnostics 没有可信 usage 可绑定。

### 5.1 输入

Provider 或 AI SDK 返回的 usage 字段可能不统一：

- 有的 provider 明确给 cache hit/miss。
- 有的 provider 只给 cached token details。
- 有的 provider 给 reasoning token details。
- 有的字段需要 Maka 推导。

### 5.2 输出

Maka 需要统一成内部 usage 结构，至少包含：

```text
inputTokens
cacheHitInputTokens
cacheMissInputTokens
cacheWriteInputTokens
cacheMissInputSource
outputTokens
reasoningTokens
```

其中 `cacheMissInputSource` 很关键：

- `explicit` 表示 provider 明确给了 miss counter。
- `derived` 表示 Maka 用 input/cache-hit/cache-write 推导。
- 缺失时不得假装精确。

### 5.3 组件归属

`ModelAdapter` 负责 provider/AI SDK usage normalization。

`telemetry/cost.ts` 负责把 normalized usage 转成估算成本。

设计约束：

- 不用 total input 直接估算 DeepSeek 成本。
- cache hit/cache miss/cache write/output 分开计价。
- usage 缺失时仍记录诊断，不伪造 provider counter。

## 6. 设计层二：把钱绑定到 request shape

只知道本轮花了多少钱还不够。系统还要知道这笔钱对应什么 request。

本层解决的问题：

> 成本数字本身没有解释力，必须和 provider-visible request 的形状绑定。

为什么要拆 request shape？因为 cache miss 上升不是单一原因。可能是稳定前缀变了，也可能只是历史自然增长。没有结构化拆分，所有变化都混在一起。

好处：

- 能把 durable prefix 变化和 history projection 变化分开。
- 能把 tool schema 变化显式暴露出来。
- 能让 paid matrix 的每一组结果都有 request 形状上下文。
- 能帮助评审判断某个策略是在优化历史，还是无意中扰动了前缀。

不这样做的后果：

- 每次 cache miss spike 都只能靠人工猜。
- 系统 prompt、工具 schema、history rewrite 的影响会混在一起。
- 优化策略之间不可比较。
- prefix locality 问题会被误判为“历史太长”。

### 6.1 Request shape 分解

一次 provider-visible request 可以拆成：

```text
provider-visible request
  durable prefix
    model/provider
    system prompt
    provider options
    active tool schema
  history projection
  current user content
  turn tail
```

注意：这里的分解是 Maka 的诊断模型，不是 DeepSeek 的内部实现。

### 6.2 两个 hash

`prefixHash`：

- model/provider
- system prompt
- provider options
- active tool schema

`requestShapeHash`：

- model/provider
- system prompt
- provider options
- active tool schema
- history projection
- current user content / turn tail 所形成的完整 request shape

### 6.3 设计意义

这让系统能区分：

- durable prefix 没变，只是 history projection 自然变了。
- tool schema 变了，可能影响 prefix locality。
- system prompt 被 volatile facts 污染了。
- provider options 或 model 变了。

### 6.4 组件归属

`request-shape.ts` 负责：

- `RequestShapeDiagnostic`
- component hash
- `prefixHash`
- `requestShapeHash`
- durable prefix change classification
- full request shape change classification

设计约束：

- `prefixHash` 只能作为 Maka 本地诊断。
- diagnostics 必须和 normalized usage 一起看。
- active tool schema 必须只看本轮 provider-visible tools，不看 full local registry。

## 7. 设计层三：稳定前缀和 turn tail 分离

如果每一轮都把当前 cwd、git 状态、日期、刚批准的 memory update 塞进 system prompt，durable prefix 会无意义抖动。

所以本设计把 prompt placement 作为成本线的一部分。

本层解决的问题：

> 有些信息必须让模型知道，但不应该进入稳定前缀。

这是成本线里很容易被低估的一层。prompt placement 看起来像产品提示词组织问题，实际上直接影响 prefix diagnostics。如果 volatile facts 混入 system prompt，系统会错误地认为 durable prefix 每轮都变。

好处：

- 当前事实仍然可见。
- 稳定 prompt 更容易保持 locality。
- request-shape diagnostics 更干净。
- memory update 的生命周期更清楚：本轮 tail，下轮 durable state。

不这样做的后果：

- 日期、cwd、git status 会造成 prefix hash 抖动。
- local memory 刚批准的更新可能被重复拼进 stable prompt。
- cache miss 变多时无法区分是策略变化还是临时事实变化。

### 7.1 Durable system prompt

适合放进 system prompt 的内容：

- 稳定行为规则
- 用户长期偏好
- workspace instructions
- skills instructions
- opt-in 且状态 OK 的 active local memory

这些内容变化较慢，适合进入 durable prefix。

### 7.2 Turn tail

适合放进 turn tail 的内容：

- 当前 cwd
- 当前 git 状态
- 当前日期
- 当前平台
- 本轮刚发生的 memory update
- 本轮临时环境事实

这些内容对当前回复有用，但不应该污染 durable system prompt。

### 7.3 组件归属

`apps/desktop/src/main/main.ts` 负责：

- `buildSystemPrompt()`
- `buildTurnTailPrompt()`
- `buildLocalMemoryPromptFragment()`
- `buildLocalMemoryUpdateTailFragment()`

`AiSdkBackend` 在组装当前 user content 时追加 turn tail。

设计约束：

- 当前事实仍然让模型可见。
- volatile facts 不进入 durable prefix。
- fresh memory update 当前轮进 tail，下轮从 durable state 重新读取。

## 8. 设计层四：不新建 CostRuntime flow

到了这里，已经能看出成本线需要的能力：

- usage normalization
- cost computation
- request-shape diagnostics
- prompt placement
- history projection
- tool schema economy

这些都在现有 `AiSdkBackend` path 周围，不需要新的 stepping engine。

本层解决的问题：

> 成本策略很容易被误设计成一个新 runtime，但真正需要的是现有 runtime 的边界纪律。

为什么不新建 flow？因为 flow 不只是拼 prompt。它要承接 stream、tool calls、permission、abort、usage、terminal semantics、legacy event mapping。成本线如果复制这些，就会创造一条平行 agent loop。

好处：

- 工具循环只有一套。
- 权限和 abort 语义不分叉。
- usage/cost telemetry 仍然贴在真实 provider request 上。
- runtime-event migration 不被绕开。
- 后续 checkpoint/read-model 仍然能站在同一条主线上。

不这样做的后果：

- `CostAwareAiSdkFlow` 很快会复制 `AiSdkBackend`。
- 两套 flow 对同一个 tool result、permission denial、finish reason 可能得出不同语义。
- bug fix 需要双写。
- 新人会以为成本优化是另一个 agent 产品，而不是 runtime discipline。

### 8.1 被拒绝的设计

不建议引入：

```text
RuntimeRunner
  -> CostAwareAiSdkFlow
    -> CostRuntime
      -> AiSdkBackend 或新 backend
```

问题是：

- 如果复制 tool loop，就会出现两套权限、abort、usage、telemetry 语义。
- 如果绕回 `AiSdkBackend`，新 flow 就只是换壳。
- 如果只为了 DeepSeek 建新 engine，会让 provider-specific cost policy 污染 runtime abstraction。

### 8.2 被接受的设计

接受的设计是：

```text
RuntimeRunner
  -> AiSdkFlow
    -> AiSdkBackend
      -> request-shape diagnostics
      -> context-budget replay projection
      -> tool availability economy
      -> ModelAdapter usage normalization
      -> cost telemetry
```

设计约束：

- 新能力以 helper/component 形式进入现有 path。
- 不改变 invocation terminal 语义。
- 不复制 tool loop。
- 不改变 provider request assembly 的单一权威。

## 9. 设计层五：历史不是删除，而是 projection

长会话成本优化的核心，不是改写历史，而是从 ledger 派生本轮 request projection。

```text
RuntimeEvent ledger     -> immutable semantic facts
Replay projection       -> current provider-visible history view
Provider messages       -> materialized request messages
```

本层解决的问题：

> 历史太重需要变轻，但历史事实不能被成本策略破坏。

为什么要引入 projection 这个概念？因为“删历史”把两个动作混在了一起：一个是原始事实保存，另一个是本轮 provider request 视图。Maka 需要优化第二个，保留第一个。

好处：

- 可以针对本轮 request 压缩 replay。
- 原始 RuntimeEvent 仍然保留。
- 未来 raw evidence、audit、checkpoint、read model 都有事实基础。
- 不同 projection 策略可以在同一个 ledger 上比较。

不这样做的后果：

- history budget 会变成 destructive deletion。
- summary 或 placeholder 会逐渐替代原始事实。
- 调试时无法回到“模型当时基于什么工具结果回答”。
- checkpoint 只能保存压缩后的 prompt，不能恢复语义状态。

### 9.1 Replay 构造顺序

`AiSdkBackend.buildPriorMessages()` 的设计顺序应该保持清晰：

1. 从 prior `RuntimeEvent` 出发。
2. 准备 context budget policy。
3. 调用 `applyRuntimeEventContextBudget()`。
4. 运行 history search。
5. 选择 synthesis cache。
6. 需要时做 archive hydration。
7. materialize 成 provider messages。

这个顺序体现了设计原则：

- 先确定事实来源。
- 再决定本轮视图。
- 再选择 summary/archive/raw evidence。
- 最后才拼 provider messages。

### 9.2 Context budget 内部顺序

`applyRuntimeEventContextBudget()` 至少要保持：

1. stale tool result prune
2. history compact
3. token/turn budget selection
4. diagnostics

设计约束：

- projection 变化必须可诊断。
- budget 不得改写 ledger。
- partial or unsupported replay 必须显式降级。

## 10. 设计层六：旧大工具结果先 archive，再 placeholder

长会话里最重的内容往往是旧工具结果。直接删除不安全，因为工具结果可能是后续回答的证据来源。

本层解决的问题：

> 大工具结果是最高杠杆的成本来源，但也是最重要的证据来源。

为什么必须先 archive 再 placeholder？因为 placeholder 本身没有证据价值。它只有在能指回一个可信 artifact 时，才是安全的 replay rewrite。

好处：

- 旧大结果不再每轮完整 replay。
- 原始工具结果仍然可恢复。
- placeholder 能携带 hash、size、source event、tool identity。
- archive failure 不会破坏 correctness。

不这样做的后果：

- 直接删：后续无法追溯证据。
- 直接 placeholder：看似保留引用，实际没有可恢复原文。
- archive 失败仍替换：系统产生一个无法兑现的证据承诺。
- 只做 summary：raw evidence request 无法满足。

### 10.1 Archive-backed pruning

设计动作分三步：

1. 找候选：旧的、过大的、超出保护窗口的 tool result。
2. 先归档：host 写 artifact，记录 hash、bytes、estimated tokens、tool identity、tool call id。
3. 再占位：只有 archive ref 匹配时，projection 里才把原始 tool result 换成 placeholder。

### 10.2 Fail open

如果 archive 失败：

```text
archive failed -> keep original tool result in replay projection
```

这会牺牲本轮节省，但保住证据。

### 10.3 Placeholder 必须携带的信息

placeholder 至少需要：

- artifact id
- body hash
- original bytes
- estimated tokens
- tool name
- tool call id
- rewrite reason
- source runtime event ref

设计约束：

- 不允许“无来源的省略”。
- 不允许 archive 失败后仍替换成 placeholder。
- placeholder 是 replay artifact，不是 ledger fact 的替代品。

## 11. 设计层七：Archive hydration 按需恢复

归档以后，模型什么时候应该看到原文？

本设计提供三种策略位置：

```text
prune-only
eager hydration
history-search-gated hydration
```

本层解决的问题：

> 省略旧工具结果以后，系统需要知道什么时候把原文拿回来。

archive-backed pruning 只解决“怎么安全拿掉”。hydration 解决“什么时候恢复”。这两者必须成对出现，否则 archive 只是延迟删除。

好处：

- prune-only 可以用于不需要原文的场景。
- eager hydration 可以保护 raw evidence correctness。
- history-search-gated hydration 可以在相关性和成本之间做折中。
- 每次恢复都有 hash/session/source/bounds 校验。

不这样做的后果：

- 模型永远只看到 placeholder，无法回答需要原文的问题。
- 或者每次都恢复所有 archive，成本节省被抵消。
- 或者恢复未校验 artifact，引入跨 session、hash mismatch、过大内容等风险。

### 11.1 Prune-only

最省，但可能错。适合模型不需要旧原文的场景。

### 11.2 Eager hydration

看到 placeholder 就按 bounds 尝试恢复。正确性更强，但可能读回太多 archive。

### 11.3 History-search-gated hydration

先用 lightweight history search 找相关 turns，再只恢复相关 archive。

这不是全局最优保证。它只是一个在相关性、正确性和成本之间更保守的选择。

### 11.4 Hydration 校验

恢复 archive 时必须校验：

- artifact exists
- source kind
- session id
- source event ref
- hash
- max bytes
- total retrieved tokens bounds

设计约束：

- raw evidence request 应该跳过 summary，倾向恢复原文。
- hydration 失败不能伪造原文。
- retrieval diagnostics 必须写入 telemetry。

## 12. 设计层八：Summary 也必须 source-bearing

不是每次 follow-up 都需要恢复完整旧工具结果。很多场景用 summary 更合理。

但普通 summary 有风险：它可能成为无来源记忆。

本设计只接受 source-bearing replay artifacts。

本层解决的问题：

> summary 是必要的历史经济手段，但无来源 summary 会污染长期记忆。

为什么 summary 必须 source-bearing？因为 summary 本身不是事实，它是从事实派生出来的 projection artifact。它要告诉系统覆盖了哪些事实、有哪些限制、什么时候失效、用户要原文时怎么回去。

好处：

- 普通 follow-up 不必恢复完整旧历史。
- summary 可以参与 replay，但不伪装成原始事实。
- source mismatch、raw evidence request、updated tool result 都能让 summary 失效。
- 新人能区分“事实 ledger”和“帮助模型理解的压缩视图”。

不这样做的后果：

- summary 一旦错误，会被长期 replay。
- 后续无法判断它覆盖或遗漏了什么。
- 用户要原始证据时，系统只能给一段摘要。
- compact 历史会变成黑箱。

### 12.1 Synthesis cache block

一个 synthesis cache block 应包含：

- summary
- coverage
- limitations
- source refs
- source hash
- invalidation constraints
- token estimate

使用前要检查：

- 是否属于当前 session
- 是否覆盖当前 query
- source hash 是否匹配
- token 是否超限
- 是否被更新的相关 tool result invalidated
- 用户是否在请求 raw evidence

### 12.2 History compact block

history compact block 是把更旧 turns 折叠成一个有来源的 compact view。

它也必须包含：

- folded coverage
- retained recent tail boundary
- limitations
- sources
- archive refs if any

### 12.3 组件归属

`context-budget.ts` 负责：

- `selectSynthesisCacheForReplay()`
- `renderSynthesisCacheBlock()`
- `renderHistoryCompactBlock()`

Host 侧 artifact 服务负责：

- `synthesis-cache-artifacts.ts`
- `history-compact-artifacts.ts`

设计约束：

- summary 是 projection artifact，不是新的事实来源。
- source refs 不可信时跳过 summary。
- 用户要 raw evidence 时不要拿 summary 冒充原文。

## 13. 设计层九：工具 schema 也是成本面

工具 schema 只要被广告给 provider，就属于 provider-visible request 的一部分。

因此工具不是纯本地能力。工具 schema economy 是成本线的一部分。

本层解决的问题：

> 工具能力在本地执行，但工具 schema 在 provider request 里付成本。

为什么要把 full registry 和 active tools 分开？因为 Maka 需要本地保留完整执行能力，同时不想每轮都把全部 schema 广告给 provider。schema visibility 是 request shape；dispatch capability 是本地执行能力。二者不是同一件事。

好处：

- 初始 request 更轻。
- active tool schema hash 更有解释力。
- group load 是显式行为，可以进入 ledger。
- 权限系统仍然独立，不被 schema visibility 混淆。

不这样做的后果：

- 全量 schema 每轮进入 durable prefix，成本和 cache locality 都受影响。
- 过度动态隐藏工具会造成模型需要工具时看不到。
- 没有 execute boundary guard 时，模型可能在 schema 未 active 的 step 调用工具。
- 加载工具和授权工具混为一谈，安全边界被误读。

### 13.1 两个集合

```text
Full dispatch registry
  Maka 本地可执行的完整工具集合

Provider-visible active tools
  本轮或当前 AI SDK step 广告给模型的工具 schema
```

这两个集合必须分开。

### 13.2 Group activation

在 economy mode：

- ungrouped tools 初始 visible。
- grouped tools 初始 hidden。
- 模型先看到轻量 `load_tools({ group })`。
- 加载某组后，从下一 step 开始，该组 schema 进入 active tools。
- 加载事件写入 `RuntimeEvent` ledger。
- 下一 turn 通过 ledger reseed 保持 active set 稳定。

### 13.3 为什么不做过度动态路由

per-turn semantic routing 看起来更省，但会带来：

- prefix 更容易抖动
- 误隐藏工具导致任务失败
- 诊断困难
- 权限和可见性容易混淆

Maka 选择 conservative group activation，是为了在减少 initial schema 成本和保持行为稳定之间取平衡。

### 13.4 Execute boundary guard

如果模型在同一个 step 里先 `load_tools(browser)`，又立刻调用 `browser_click`，`browser_click` 还没有在 step-start active set 里。

`ToolRuntime` 必须在执行边界拒绝。

设计约束：

- tool availability 控制 schema visibility。
- PermissionEngine 控制安全授权。
- load group 不等于获得权限。
- active tool schema hash 只看 provider-visible active tools。

## 14. 设计层十：Local memory 只进入 prompt placement 设计

Local memory 是完整产品能力，但在成本线里只处理 prompt placement。

本层解决的问题：

> memory 对模型有长期价值，但 memory 产品本身不应该被成本线吞掉。

为什么这里只讲 prompt placement？因为本设计关注 provider-visible request。memory 的 approval、隐私、同步、UX 是另一套产品问题。成本线只需要决定稳定 active memory 是否进入 durable prompt，以及本轮 fresh updates 是否进入 turn tail。

好处：

- memory 对当前回复和长期偏好都能生效。
- incognito/settings gate 仍由 memory service 控制。
- fresh update 不会立刻污染 durable prefix。
- 成本设计不会扩张成 memory 产品设计。

不这样做的后果：

- 刚发生的 memory update 进入 stable prompt，导致 prefix 抖动。
- memory disabled/incognito 情况下可能泄漏内容。
- 成本文档开始承担 memory 产品语义，边界失焦。

### 14.1 Active memory

满足以下条件的 active memory 可以进入 durable system prompt：

- 用户 opt-in
- 非 incognito
- 状态 OK
- 内容经过 secret redaction
- 长度受控

### 14.2 Fresh memory update

本轮刚发生的 memory writes、approval、archive/restore 更新进入 current-turn tail。

下一轮再从 durable memory state 读取。

设计约束：

- 不把 fresh update 直接并入 durable prefix。
- incognito/settings gate 必须在 host/service 层生效。
- memory 文本长度要可控。

## 15. End-to-end request sequence

下面是一轮 cost-aware request 的设计级顺序：

```text
1. SessionManager.sendMessage()
   - 接收外部 turn 请求

2. RuntimeKernel.startTurn()
   - 创建/注册 active run
   - 连接 stop/permission/session 状态

3. AgentRun.begin()
   - 创建 durable run envelope
   - 准备 prior runtime context

4. RuntimeRunner.invoke()
   - 定义 invocation boundary
   - 遍历 flow events
   - 统一 terminal/error/abort semantics

5. AiSdkFlow.run()
   - 调用 AiSdkBackend
   - 映射 legacy SessionEvent -> RuntimeEvent

6. AiSdkBackend.send()
   - resolve model/provider
   - build stable system prompt
   - build current turn tail
   - prepare ToolAvailabilityRuntime
   - build prior messages from RuntimeEvents
   - apply context budget
   - select synthesis/cache/archive hydration
   - compute request shape diagnostics
   - start provider stream through ModelAdapter
   - execute tools through ToolRuntime
   - normalize usage
   - compute cost
   - emit telemetry/session/runtime events

7. AgentRun.finish()
   - persist terminal run state
   - update session projection
   - close active run
```

这个顺序里，真正改变 provider-visible request 的点只有几个：

- system prompt / turn tail placement
- prior history projection
- synthesis/compact/archive hydration
- active tool schema
- provider options/model

这些点必须进入 request-shape diagnostics。

## 15.5 设计收益总表

新人读完整套设计后，应该能把每个设计点和它解决的问题对应起来。下面这张表是整篇文档的压缩版。

| 问题压力 | 设计选择 | 直接收益 | 不这样做会怎样 |
| --- | --- | --- | --- |
| total input 下降不一定更便宜 | 先 normalize usage，再按 cache miss/read/write/output/reasoning 算 cost | 评估成本策略时不被 token 总量误导 | 上线“更短但更贵”的策略 |
| 成本变化无法归因 | request-shape diagnostics，拆 `prefixHash` 和 `requestShapeHash` | cache miss 变化能关联到 prefix/history/tool/schema | 每次 regression 都靠人工猜 |
| 当前事实每轮变化 | stable system prompt + current turn tail | 模型看到当前事实，durable prefix 不乱抖 | 日期/cwd/git/memory update 污染前缀 |
| 成本线容易变成新 flow | 不新建 `CostRuntime`，沿现有 `AiSdkBackend` path 安装纪律 | 工具、权限、usage、terminal 只有一套语义 | 出现两套 agent loop |
| 历史太重但不能丢 | RuntimeEvent ledger + replay projection | 本轮 request 可变轻，事实仍保留 | 历史优化变成 destructive deletion |
| 旧大工具结果最贵 | archive-backed pruning | 省 replay token，同时保留 raw evidence | placeholder 没有可恢复原文 |
| 省略后还要能恢复 | bounded archive hydration | 需要原文时可校验恢复 | prune-only 便宜但可能错，eager 全恢复又贵 |
| summary 可能污染事实 | source-bearing synthesis/compact artifact | summary 有 coverage、limitations、sources | 无来源 summary 长期污染 replay |
| 工具 schema 也是 request 成本 | full registry 和 active tools 分离，`load_tools` group activation | 初始 schema 轻，prefix 变化可解释 | 每轮发全量工具，或动态路由不可诊断 |
| memory 既稳定又会更新 | active memory 进 durable prompt，fresh update 进 tail | 长期偏好稳定，本轮更新可见 | memory update 造成 prefix 抖动或隐私边界混乱 |

这张表也说明了一个更深层的设计收益：

> Maka 把成本优化从“压 prompt”升级成“管理 provider-visible request 的事实边界”。

这句话对新人很重要。压 prompt 是局部技巧；管理 request fact boundary 是 runtime 设计。前者只关心本轮少一点，后者还关心下轮能不能解释、出错能不能回退、证据能不能追溯、checkpoint 能不能站住。

## 15.6 新人理解这套设计的三层收益

### 第一层收益：成本可观测

新人最先应该看到的是：系统不再只说“贵了”或“便宜了”。它能说：

- 哪些 token 是 cache miss。
- 哪些 token 是 cache hit/read。
- 哪些 token 写入 cache。
- output/reasoning 花了多少。
- 这组数字对应哪个 request shape。

这让成本问题从感受变成 trace。

### 第二层收益：优化可解释

下一层收益是解释力。系统可以把一次成本变化归因到：

- durable prefix
- history projection
- tool schema
- provider options
- current turn tail
- model/provider

这让工程评审可以讨论具体设计，而不是讨论“模型是不是抽风”。

### 第三层收益：正确性可保护

最深一层收益是 correctness。Maka 不因为省 token 就丢掉事实：

- ledger 保留原始 runtime facts。
- archive 保留旧大工具结果。
- placeholder 有 hash/source/artifact。
- summary 有 sources/limitations。
- hydration 有 bounds 和校验。
- tool availability 不绕过 permission。

这让成本优化不会破坏 future replay、audit、checkpoint、raw evidence request。

一个新人如果只看到第一层，会以为这是成本 telemetry。看到第二层，会理解 request-shape diagnostics。看到第三层，才会理解为什么这是一条 runtime design line，而不是一组 prompt-compression patches。

## 16. 数据结构草案

以下不是最终 TypeScript API，而是设计所需的字段集合。

### 16.1 NormalizedUsage

```ts
type CacheMissInputSource = "explicit" | "derived" | "unavailable";

interface NormalizedUsage {
  inputTokens?: number;
  cacheHitInputTokens?: number;
  cacheMissInputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheMissInputSource?: CacheMissInputSource;
  outputTokens?: number;
  reasoningTokens?: number;
}
```

### 16.2 CostBreakdown

```ts
interface CostBreakdown {
  inputCacheMissCost?: number;
  inputCacheHitCost?: number;
  inputCacheWriteCost?: number;
  outputCost?: number;
  reasoningCost?: number;
  estimatedTotalCost?: number;
  pricingSource?: string;
}
```

### 16.3 RequestShapeDiagnostic

```ts
interface RequestShapeDiagnostic {
  modelProviderHash: string;
  systemPromptHash: string;
  providerOptionsHash: string;
  activeToolSchemaHash: string;
  historyProjectionHash: string;
  prefixHash: string;
  requestShapeHash: string;
  durablePrefixChange?: string;
  requestShapeChange?: string;
}
```

### 16.4 ToolResultArchivePlaceholder

```ts
interface ToolResultArchivePlaceholder {
  kind: "archived_tool_result";
  artifactId: string;
  bodyHash: string;
  originalBytes: number;
  estimatedTokens?: number;
  toolName: string;
  toolCallId: string;
  sourceRuntimeEventId: string;
  rewriteReason: string;
}
```

### 16.5 SourceBearingReplayArtifact

```ts
interface SourceBearingReplayArtifact {
  kind: "synthesis_cache" | "history_compact";
  summary: string;
  coverage: string;
  limitations: string[];
  sourceRefs: string[];
  sourceHash: string;
  tokenEstimate?: number;
}
```

### 16.6 ToolAvailabilityState

```ts
interface ToolAvailabilityState {
  mode: "full" | "economy";
  fullRegistryVersion: string;
  activeToolNames: string[];
  loadedGroups: string[];
  stepStartActiveToolNames: string[];
}
```

## 17. Decision records

### DR-1: 不新建 CostRuntime flow

结论：不新建。

原因：

- 成本线需要的是 provider-visible request discipline，不是新 engine。
- 复制 tool loop 会引入语义分叉。
- 现有 `AiSdkBackend` 已经是 request assembly 的权威。

### DR-2: prefixHash 是诊断，不是 provider cache key

结论：只作为 Maka 本地诊断。

原因：

- DeepSeek 内部 cache key 不可见。
- hash 只能说明 Maka 自己送出的 durable prefix 是否变化。
- 成本判断仍以 provider usage counter 为准。

### DR-3: context budget 改 projection，不改 ledger

结论：只改变本轮 replay projection。

原因：

- RuntimeEvent ledger 是语义事实来源。
- 删除或改写 ledger 会破坏 replay、audit、future checkpoint。
- projection 可以针对 provider request 优化。

### DR-4: archive pruning 必须 fail open

结论：archive 失败时保留原始 tool result。

原因：

- 成本节省不能优先于证据保留。
- placeholder 没有可信 artifact ref 时没有恢复路径。

### DR-5: 工具 schema 采用 conservative group activation

结论：不做过度动态的 semantic routing。

原因：

- active schema 是 durable prefix 的一部分。
- 频繁动态路由可能增加 prefix 抖动。
- 显式 `load_tools` 更容易进入 ledger 和 diagnostics。

### DR-6: Local memory 在本设计里只处理 prompt placement

结论：不把 memory 产品语义扩进成本系统。

原因：

- memory 的 UX、approval、隐私和同步是独立问题。
- 成本线只关心 stable memory 是否进入 durable prefix、fresh updates 是否进入 turn tail。

## 18. Fallback and failure semantics

### 18.1 Provider usage 缺失

行为：

- 记录可获得字段。
- 标记 unavailable 或 derived。
- 不伪造 explicit cache miss。

### 18.2 Request-shape diagnostic 失败

行为：

- provider request 仍可继续。
- telemetry 标记 diagnostic failure。
- 不让诊断失败变成用户请求失败，除非它暴露了真正无法构造 request 的错误。

### 18.3 Archive 写入失败

行为：

- 不替换成 placeholder。
- 保留原 tool result。
- 记录 archive failure diagnostic。

### 18.4 Archive hydration 失败

行为：

- 保留 placeholder 或选择其他 fallback projection。
- 不伪造 raw evidence。
- 如果用户明确请求 raw evidence，应暴露无法恢复的诊断。

### 18.5 Synthesis cache invalid

行为：

- 跳过 synthesis block。
- 回到 archive hydration 或 raw runtime-event replay。

### 18.6 Tool group 未加载却被调用

行为：

- `ToolRuntime` 在执行边界拒绝。
- 不进入真实工具实现。
- 不绕过 PermissionEngine。

### 18.7 Incognito 或 memory disabled

行为：

- active memory 不进入 durable system prompt。
- memory update tail 不应暴露禁用状态下的私有信息。

## 19. Telemetry contract

一次 request 的 telemetry 至少应该能把以下事实关联起来：

```text
run id
session id
turn id
model/provider
normalized usage
cost breakdown
prefixHash
requestShapeHash
component hashes
context budget diagnostics
archive prune/hydration diagnostics
synthesis/compact diagnostics
active tool schema diagnostics
tool availability mode
```

这些字段的关系比任何单个字段都重要。

例如，cache miss 上升时，评审者应该能同屏看到：

- cache miss 数字
- cache miss source
- prefixHash 是否变化
- active tool schema hash 是否变化
- history projection hash 是否变化
- 本轮是否发生 archive hydration 或 synthesis 替换

## 20. 测试策略

### 20.1 Usage normalization tests

覆盖：

- explicit DeepSeek cache miss
- derived cache miss
- missing cache fields
- reasoning token extraction
- cost split computation

### 20.2 Request shape tests

覆盖：

- system prompt 改变 -> prefixHash 改变
- history projection 改变 -> requestShapeHash 改变，prefixHash 不变
- active tool schema 改变 -> prefixHash 改变
- current turn tail 改变不应被误归类为 stable system prompt change

### 20.3 Context budget tests

覆盖：

- ledger 不被 budget 改写
- stale tool result archive 成功后 placeholder
- archive 失败后保留原文
- synthesis cache source mismatch 后跳过
- raw evidence request 跳过 synthesis
- history compact block 带 coverage/limitations/sources

### 20.4 Tool availability tests

覆盖：

- economy mode 初始只暴露 ungrouped tools 和 `load_tools`
- group load 后下一 step 可见
- same step 未加载工具调用被拒绝
- loaded group 从 ledger reseed
- PermissionEngine 仍然独立执行

### 20.5 End-to-end paid or trace tests

覆盖：

- total input 下降但 cache miss 上升的反例能被解释
- archive hydration gated/eager/prune-only matrix 能比较 correctness/cost
- tool schema economy 对 request shape diagnostics 可见
- prompt placement 能减少无意义 durable prefix 抖动

## 21. 实施切片

这条线应该按可验证边界落地，而不是一次性大改。

### Slice 1: Usage and cost are trustworthy

目标：

- normalized usage 字段稳定。
- cost breakdown 不再只看 total input。
- telemetry 能区分 explicit/derived/unavailable。

验收：

- focused tests 覆盖 DeepSeek/OpenAI-compatible usage shapes。
- 真实 trace 能看到 cache hit/miss/write/output 拆分。

### Slice 2: Request shape is explainable

目标：

- `prefixHash` / `requestShapeHash` 稳定输出。
- component hash 能解释变化来源。

验收：

- 改 system prompt、history、tool schema 的 fixture 能分别命中不同 diagnostic。

### Slice 3: Prompt placement is disciplined

目标：

- volatile facts 进入 turn tail。
- stable rules/memory 进入 durable system prompt。

验收：

- cwd/git/date 变化不造成 system prompt hash 抖动。
- fresh memory update 只在当前 turn tail 出现。

### Slice 4: Replay projection is budgeted but recoverable

目标：

- context budget 只改 projection。
- stale tool result archive-backed prune。
- hydration 有校验和 bounds。

验收：

- archive 成功才 placeholder。
- archive 失败保留原文。
- raw evidence 可以恢复或明确失败。

### Slice 5: Summary artifacts are source-bearing

目标：

- synthesis/compact block 都带 coverage、limitations、sources。
- source mismatch 或 raw evidence request 时跳过。

验收：

- summary 无来源不能进入 replay projection。
- invalidation 规则有测试。

### Slice 6: Tool schema economy is active-set based

目标：

- full registry 和 active provider-visible tools 分离。
- `load_tools` group activation 进入 ledger。
- active-only schema hash 进入 request-shape diagnostics。

验收：

- same-step unavailable tool execution 被拒绝。
- loaded groups 在下一 turn 可 reseed。

## 22. 开放问题

### 22.1 Request shape diagnostics 的持久位置

现在需要决定 diagnostics 最终应该写在哪里：

- run telemetry
- runtime event action
- session projection metadata
- 独立 request trace table

建议优先写到 run/request telemetry，再视 UI/read model 需要投影。

### 22.2 Context budget policy 的配置边界

DeepSeek 默认是否启用某些 budget 策略，不能只凭 total input。需要基于 paid matrix 和 workload 分类。

建议默认保守，先 expose diagnostics，再逐步启用策略。

### 22.3 Child run replay 和 subagent summary

当前 top-level replay 默认不混入 child runs。未来如果子代理成果需要进入主历史，应该通过 explicit source-bearing summary，而不是直接混入 child runtime events。

### 22.4 Checkpoint / warm retry

成本线为 checkpoint 提供了更清楚的事实边界：

- run status
- invocation terminal
- runtime-event high-water mark
- workspace snapshot
- context budget projection
- provider request diagnostics

但本设计不直接实现 checkpoint。它只是避免成本 projection 破坏 future checkpoint 的事实基础。

## 23. 评审清单

评审这条线时，可以按以下问题检查：

1. 这个改动有没有复制模型/工具循环？
2. 这个改动有没有改变 provider-visible request shape？如果有，diagnostics 能解释吗？
3. 这个改动有没有把 volatile facts 放进 durable system prompt？
4. 这个改动有没有把 projection 改写成 ledger fact？
5. 这个改动有没有无来源地删除 tool result？
6. 这个改动有没有把 summary 当事实来源？
7. 这个改动有没有混淆 tool schema visibility 和 permission authorization？
8. 这个改动有没有把 prefixHash 当 provider cache key？
9. 这个改动的 fallback 是 fail safe 还是 fail closed/hidden？
10. 这个改动能否通过 trace 解释 cache miss 变化？

## 24. 最终设计结论

Maka DeepSeek-Reasonix 成本运行线的系统设计，不是“把 prompt 压短”，也不是“为 DeepSeek 新建一个 flow”。

它是一套沿着现有 runtime 主线建立的 provider-visible request discipline：

```text
算清 usage
  -> 绑定 request shape
    -> 稳住 durable prefix
      -> 把 volatile facts 放进 turn tail
        -> 从 RuntimeEvent ledger 派生 replay projection
          -> 对旧大工具结果先 archive 再 placeholder
            -> 按相关性和 bounds 恢复 archive
              -> 用 source-bearing summary/compact 替代无来源压缩
                -> 按需暴露 provider-visible tool schema
                  -> 把所有变化写进可解释 telemetry
```

这条线的价值不在于某一个优化技巧，而在于把成本问题变成可以观察、可以解释、可以回退、可以维护的 runtime 设计。

如果未来要继续演进，最重要的不是先增加更多 budget 策略，而是守住本文的几个边界：

- 现有 runtime path 是主路。
- Provider-visible request shape 必须可诊断。
- RuntimeEvent ledger 是事实，不是压缩对象。
- Replay projection 可以优化，但必须有来源和 fallback。
- Tool schema visibility 是成本面，但不是权限面。
- Local memory 只在 prompt placement 维度参与成本线。

守住这些边界，Maka 才能在不牺牲 correctness 和可恢复性的前提下，继续把 DeepSeek 这类 cache-sensitive provider 的成本问题做深。

## 25. Source index

教学和设计材料：

- `docs/architecture/runtime-core-architecture-draft.zh-CN.md`
- `docs/architecture/durable-task-loop-headless-draft.zh-CN.md`
- DeepSeek-Reasonix cost-runtime Rive reading artifacts from workflow
  `maka.deepseek-reasonix-cost-mainline`
- DeepSeek-Reasonix beginner teaching guide and fine outline from workflow
  `maka.deepseek-reasonix-deep-read`

主要源码入口：

- `packages/runtime/src/model-adapter.ts`
- `packages/runtime/src/telemetry/cost.ts`
- `packages/runtime/src/request-shape.ts`
- `packages/runtime/src/ai-sdk-backend.ts`
- `packages/runtime/src/context-budget.ts`
- `packages/runtime/src/tool-availability.ts`
- `packages/runtime/src/tool-runtime.ts`
- `apps/desktop/src/main/main.ts`
- `apps/desktop/src/main/synthesis-cache-artifacts.ts`
- `packages/runtime/src/history-compact-artifacts.ts`
- `packages/core/src/local-memory.ts`
- `apps/desktop/src/main/local-memory-service.ts`
