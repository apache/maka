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

[ENGLISH](./beyond-function-calling.md)

# Tool Call 不只是 Function Calling：Agent 如何真正触碰现实世界

## Deferred Tool：没有被调用的 Tool 也有成本

在普通程序里，一个从未被调用的函数几乎不会产生运行时成本。它可以存在于代码库或动态链接库中，只要执行路径没有经过它，就不会消耗 CPU，也不会占用调用栈。

Agent 里的 Tool 不是这样。

模型想要调用一个 Tool，首先必须知道这个 Tool 的名称、用途以及参数格式。因此，Runtime 会把 Tool Definition 连同 System Prompt 和对话历史一起发送给模型。一个 Tool 即使从未被调用，它的 Description 和 JSON Schema 也已经进入了每一次推理。

这意味着 Tool 在执行之前就开始产生成本。Schema 会占用上下文窗口，会参与模型对下一步动作的判断，也会改变可供 Provider 缓存的请求前缀。Tool 越多，模型能够采取的动作越多，但留给任务本身的上下文越少，选择动作时需要面对的干扰也越大。

当 Agent 只有 `Read`、`Write`、`Bash` 等少数工具时，这个问题并不明显。但随着 Browser、Computer Use、子 Agent、外部服务和 MCP Connector 不断加入，把所有 Tool Schema 常驻在每一次模型请求里，就不再是一种可以持续扩展的方式。

Maka 的 Deferred Tool 从这里出发。这里的 Deferred 不是延迟执行，也不是让 Tool 在后台异步完成，而是延迟向模型暴露完整的 Tool Schema。

Runtime 仍然持有当前 Run 可以使用的全部 Tool Binding，但模型在第一次推理时只看到一组高频基础工具，以及一个轻量的 `tool_search`。其余 Tool 只以分组和名称出现在 Search Inventory 中，不携带完整的 Description 和参数 Schema。

```text
Bound Tool Registry
        │
        ├── Direct Tools ───────────────→ 当前请求中的完整 Schema
        │
        └── Deferred Tools
                │
                └── 轻量 Search Inventory
                           │
                      tool_search
                           │
                    有界的匹配结果
                           │
                           ▼
                    下一次 Provider Step
                    注入匹配 Tool 的 Schema
```

`tool_search` 搜索的不是文件、网页或业务数据，而是 Runtime 已经拥有的能力。Maka 在本地根据 Tool 的名称、Description 和所属能力分组完成匹配，再选择数量与 Schema 体积都受限制的一组结果。返回给模型的只是被激活的 Tool 名称，完整 Schema 不会重复塞进 Tool Result，而是在下一次 Provider Request 中通过正常的 Tool Projection 出现。

这套机制把过去容易混在一起的几个概念拆开了：

- **Bound**：Runtime 持有可执行的 Tool Binding，它定义了本次运行的能力上限。
- **Discoverable**：Tool 出现在轻量 Inventory 中，模型知道某类能力存在。
- **Visible**：完整 Tool Schema 已经进入当前 Provider Request，模型可以据此生成调用。

搜索不会绑定新的 Tool，也不能突破当前 Run 已有的 Binding Ceiling。它只是改变下一次模型调用看到的 Tool Projection。

“下一次”是这里很重要的边界。Provider Step 开始后，这次请求包含哪些 Tool Schema 就已经确定。假如模型在同一个响应里同时生成下面两个调用：

```text
tool_search("browser click")
browser_click(...)
```

第二个调用仍然会被 Maka 拒绝。`tool_search` 的结果只能影响后续请求，不能反过来改写一份已经发送给 Provider 的 Schema 集合。直到下一个 Step，`browser_click` 的完整定义才会进入模型上下文，模型也才能基于自己真正见过的接口生成参数。

Deferred Tool 的激活状态只保留在当前 Turn 中。同一个 Turn 内，搜索得到的工具会单调累积，Provider 重试也会继承这份工作集；Turn 结束后，激活集合随之释放。下一轮对话重新从稳定的基础工具集开始，不会因为此前偶然使用过某项能力，就永久背负它的 Schema 成本。

Tool 的可见性也不等于执行授权。已经进入模型上下文的 Tool，真正调用时仍然需要经过权限判断、参数校验和 Runtime 的执行边界。`tool_search` 管理的是模型的认知范围，不是用户授予的权限范围。

因此，Deferred Tool 解决的并不是“工具怎样执行”，而是“哪些工具值得进入模型的下一次思考”。Runtime 保存完整的能力空间，模型看到的则是当前任务真正需要的工作集。

## Tool Call：让 LLM 长出手脚

Tool Schema 进入上下文之后，模型只是知道自己有哪些动作可以选择。直到它生成一个 Tool Call，一切仍然只是 Token。

LLM 本身不会读取文件，不会启动进程，也不会点击屏幕。它接收一段输入，再预测一段输出。即使模型回答“我已经修改了文件”，这句话本身也不会在磁盘上产生任何变化。语言描述的是世界，不能直接改变世界。

Tool Call 在两者之间建立了一条通道。模型不再只生成自然语言，而是按照 Tool Schema 输出一份结构化的动作意图，其中包含要调用的 Tool、传入的参数，以及用于关联结果的 Call ID。Runtime 接住这份意图，在真实环境中执行对应操作，再把执行结果送回模型。

```text
LLM
 │
 │  function_call(name, arguments, call_id)
 ▼
Runtime
 │
 ├── 查找 Tool Binding
 ├── 校验参数与执行边界
 ├── 请求必要的权限
 ├── 调用真实实现
 ▼
Filesystem / Process / Browser / Network / Human
 │
 │  function_response(call_id, result)
 ▼
LLM 的下一次推理
```

从这个闭环开始，模型才真正成为 Agent。读取文件让它获得对代码库的观察，执行命令让它得到编译器和测试系统的反馈，修改文件让它能够改变工作区，浏览器和网络工具把它连接到本地进程之外的环境，向用户提问则让它能够在信息不足时暂停并等待新的事实。

如果把 Tool 看作 Agent 的手脚，那么 Tool Result 就是感觉反馈。只有动作没有反馈，模型无法判断调用是否成功，也无法知道现实世界是否与自己的预测一致。一个完整的 Agent Step 因此不是“模型想了一次”，而是由意图、执行和观察共同组成：

```text
Reason → Act → Observe → Reason
```

这个循环看起来像普通的函数调用，但它们之间存在一个根本区别。程序调用内部函数时，调用者和被调用者通常共享同一个确定性的执行环境；模型生成 Tool Call 时，它只是在根据概率分布提出下一步动作。参数可能不完整，目标可能已经变化，对环境的理解也可能是错的。

因此，更准确地说，并不是 LLM 自己长出了手脚，而是 Runtime 把一组受控的手脚借给了它。

在 Maka 中，模型生成的调用不能直接越过 Runtime 接触外部世界。Runtime 会先确认 Tool 确实存在于当前 Binding 中，并检查它是否已经对当前 Step 可见；参数必须符合 Tool Schema，调用还要经过并发限制、权限策略和执行边界。只有这些条件都成立，Tool 的真实实现才会运行。

这条边界区分了模型的意图与系统的授权。模型可以请求执行某个动作，但不能仅凭生成了一个合法 Tool Call，就为自己创造能力或取得权限。Tool Schema 告诉模型怎样表达请求，Tool Binding 决定 Runtime 是否拥有这种能力，Permission 则决定这一次具体请求能否执行。

执行结束后，Runtime 会把结果转换成与 Provider 无关的 Tool Result，再通过 Call ID 与原始调用配对。在 Maka 的 `RuntimeEvent Log` 中，这两端分别成为 `function_call` 和 `function_response`。这样，模型提出过什么动作、Runtime 实际返回了什么结果，都会成为可以重放和审计的运行事实。

Call ID 在这里不只是消息格式中的一个字段。一个 Turn 可能同时发起多个 Tool Call，执行完成顺序也未必与发起顺序一致。Runtime 必须依靠稳定的身份关联，才能把每份 Result 送回正确的 Call，并在恢复历史时重新构造同一组因果关系。

Tool Call 由此完成了一次关键转换：模型输出的不再只是供人阅读的语言，而是可能读取隐私、消耗资源、启动进程或者修改数据的操作请求。Deferred Tool 决定哪些能力进入模型的思考范围，Tool Call 则让其中一个选择越过语言边界，成为对现实世界的一次尝试。

从这一刻开始，Agent 系统面对的问题也发生了变化。一次生成失败，最多得到一段不理想的文本；一次 Tool Call 失败，却可能发生在现实效果已经产生、结果尚未返回的时候。模型有了手脚之后，Runtime 就必须开始对这些动作的后果负责。

## Reliable Tool Call：Resume 重放历史，而不是重做动作

Tool Call 把模型连接到现实世界，也把现实世界的不确定性带进了 Agent Runtime。

假设模型调用 `Edit`，要求把配置文件中的端口从 `3000` 改成 `4000`。文件刚刚写完，Maka 的进程恰好崩溃。重启之后，Runtime 只能看到这次 Tool Call 没有返回结果，但这并不能说明文件没有被修改。

缺少 Tool Result 可能对应完全不同的现实：调用尚未开始，工具正在执行，副作用已经完成但结果没有落盘，或者外部状态在执行后又被其他进程改变。如果 Resume 简单地把这次调用重新执行一遍，就可能制造重复写入、重复发送、重复创建甚至重复付款。

这也是 Tool Call 和普通文本生成之间最重要的差异。文本没有返回，可以重新生成；一个已经越过进程边界的现实动作，却不能因为 Runtime 没看到结果就假定它没有发生。

Maka 用两个持久化边界夹住 Tool 的真实执行：

```text
Model 生成 function_call
          │
          ▼
参数、可用性、权限与执行边界检查
          │
          ▼
T1：提交 Tool Dispatch
          │
          ▼
执行现实世界中的操作
          │
          ▼
T2：提交 function_response
          │
          ▼
把 Tool Result 交给模型
```

T1 表示 Runtime 已经完成所有执行前检查，并正式跨过了派发边界。从这一刻开始，系统不能再安全地声称 Tool 一定没有运行。T1 必须先提交，Tool 的真实实现才会被调用；如果 T1 提交失败，副作用就不允许开始。

T2 表示 Tool 的结果已经成为持久化的 `function_response`。只有 T2 提交成功，这份结果才可以进入下一次模型推理。即使 Tool 已经返回成功，如果 T2 没有落盘，Runtime 也不能把一个无法在重启后重建的结果临时交给模型。

Maka 没有尝试用一个数据库事务包住整个 Tool Call。文件操作、Shell 命令、浏览器动作和网络请求可能持续几秒甚至几小时，SQLite 不可能与这些外部系统共同完成一个真正的分布式事务。Maka 能做的是用两个很短的事务明确副作用窗口：

```text
Committed T1 → External Side Effect → Committed T2
```

这样一来，进程无论在哪里崩溃，重启后的 Runtime 都可以根据 Append-Only Log 中已经提交的前缀做出确定判断：

| 日志事实 | Runtime 能够得出的结论 |
|---|---|
| 没有跨过 T1 | Tool 确定没有被派发 |
| T1 和 T2 都存在 | Tool 已经完成，直接使用既有 Result，不能重复执行 |
| T1 存在但 T2 缺失 | 副作用状态未知，需要 Reconcile 或 Park |
| Call、Dispatch、Response 的身份或顺序冲突 | Ledger 损坏，Fail Closed |

其中最危险的是 T1 与 T2 之间。系统只知道 Tool 已经获得执行资格，却不知道现实效果是否完成。Maka 不会让模型根据上下文猜测，也不会把“没有 Result”自动解释成“没有执行”。Tool Binding 可以声明自己的恢复语义，例如操作是否天然幂等、能否重新观察结果，或者永远不能自动重试；缺少足够证据时，Runtime 会把这次操作 Park，等待更可靠的观察或人工处理。

这种恢复同样遵循 Append-Only。Runtime 不会回头修改原来的 `function_call` 或假装补上一段过去没有发生的历史。正常的 Dispatch、Outcome，以及后续可能产生的 Reconcile 和 Recovery Decision，都会作为新的事实继续追加到 Log 尾部。旧事实保持不变，新的事实负责解释旧操作最终收敛到了什么状态。

当所有 Tool Call 都已经被判定为 Completed 或 Definitely Not Dispatched，Resume 才具备安全重放的基础。

这里的“重放”很容易被误解。Maka 不会重新执行历史中的 Tool，也不会复活崩溃前的 Promise、JavaScript 调用栈、网络连接或宿主进程。它重放的是模型当时已经看到的合法历史：User Message、模型输出、成对的 `function_call` 与 `function_response`，以及其他可以进入 Provider Context 的确定事实。

```text
Immutable RuntimeEvent Prefix
            │
            ├── 解析并收敛 Tool Operation
            ├── 丢弃流式 Partial
            ├── 保留成对的 Call / Response
            ├── 裁掉无法构成合法历史的中断尾部
            └── 校验 High-Water 与 Digest
                         │
                         ▼
              Verified Provider Replay
                         │
                         ▼
              New Run / Invocation / Turn
```

Append-Only 结构让这件事变得自然。Resume 不需要猜测旧进程内存中曾经有哪些对象，也不需要从 UI 状态反推出执行进度。它只读取截至某个 High-Water 的不可变事件前缀，验证这段前缀的 Digest，再从中投影出下一次 Provider 调用需要看到的历史。

新的执行会获得全新的 Run、Invocation 和 Turn 身份，并记录自己从哪个 Source Run、哪个 Event High-Water 继续。原始 User Message 不会再复制一遍，已经完成的 Tool Call 也不会再次执行。Continuation 继承的是一段经过验证的因果历史，而不是一份准备重新运行的命令列表。

在真正调用模型之前，Maka 还会重新检查这段历史赖以成立的外部条件：Workspace 是否仍是同一个 Workspace，历史中使用过的 Tool 是否仍然存在，后台进程和子任务是否已经收敛，以及是否已经有另一个 Continuation 占用了同一恢复边界。任何一个条件无法证明，Resume 都会停在 Park，而不是带着旧结论进入一个已经变化的现实世界。

因此，Maka 的 Resume 并不是“从崩溃的位置继续执行代码”，而是先让每一次现实动作在日志中获得可信的结论，再从一段不可变、可验证的历史创建新的执行。Tool Call Recovery 解决了动作是否已经发生的问题，Append-Only Log 解决了模型应该从哪些事实继续的问题。

一旦现实动作能够稳定地沉淀为 Log 中的事实，Resume 就不再是对旧进程的抢救，而变成了一个从历史构造新 Runtime 的 Replay 问题。

## Code Mode：当 Tool Call 变成一段程序

到这里为止，我们讨论的 Tool Call 都是一次一个的。

模型先判断下一步要调用什么，Runtime 执行 Tool，再把 Result 放回上下文。模型读到结果之后，重新推理，决定是否调用下一个 Tool。对于每一步都需要语义判断的任务，这正是 Agent 应有的工作方式。

但并不是每一步都值得重新调用一次模型。

假设 Agent 需要读取二十个文件，找出包含某个依赖的文件，再分别读取它们的配置，最后只把版本不一致的项目列出来。如果沿用普通 Tool Call，整个过程会变成：模型发起一次读取，看到结果，再发起下一次读取；所有中间结果都进入上下文，循环、筛选和聚合也都靠一次又一次推理来推进。

```text
Reason → Call → Observe → Reason → Call → Observe → ...
```

这里真正需要模型判断的，也许只有任务开始时的执行计划，以及最后如何解释异常。中间大量工作只是确定性的控制流。让 LLM 逐步扮演 `for` 循环，不仅慢，也会让每一份原始 Tool Result 都成为后续上下文的负担。

Code Mode 改变的就是这一层。

模型不再为每个动作分别生成一次顶层 Tool Call，而是先生成一小段程序，由这段程序调用多个 Tool。循环、并发、条件分支、字段提取和结果聚合在受限的代码执行环境中完成，模型只需要看到程序最终选择输出的内容。

```text
                  ┌─ Tool A ─┐
Reason → Program ─┼─ Tool B ─┼→ Filter / Join / Reduce → Observe → Reason
                  └─ Tool C ─┘
```

OpenAI 的 Codex 把这种执行形态称作 Code Mode。在公开的 Responses API 中，同一类能力被称为 Programmatic Tool Calling：模型生成 JavaScript，在隔离的 V8 Runtime 中通过 `tools.*` 编排可用工具。Claude 也提供 Programmatic Tool Calling，只是让 Claude 在 Code Execution Container 中生成 Python，并通过 `allowed_callers` 指定哪些 Tool 可以从程序内部调用。

两种协议的实现细节不同，但表达的是同一个判断：LLM 擅长提出计划和处理语义不确定性，程序更适合执行已经明确的控制流。

这不是给模型一台没有边界的机器。Code Mode 中的程序能够触达什么，仍然由 Runtime 提供的 Tool 集合决定。它不能仅凭写下一段网络请求代码就获得网络，也不能因为生成了文件操作代码就绕过文件系统权限。程序只是 Tool 的编排层，不是新的权限来源。

它也没有取代 Tool Call。恰恰相反，Programmatic Tool Calling 把一个线性的 Tool Call 序列变成了一棵调用树：最外层是模型生成的 Program，下面是程序实际发起的 Tool Call。每个叶子节点最终仍要由 Runtime 校验、授权和执行。

```text
Program / exec
├── Tool Call 1
├── Tool Call 2
│   └── Tool Result 2
└── Tool Call 3
    └── Tool Result 3
         │
         ▼
   Program Result
```

这种结构最直接的收益是减少模型往返。原本需要多次采样才能完成的循环或批量查询，可以在一个 Program 中执行。另一个同样重要的收益是减少上下文污染：程序可以先处理几十份原始结果，只把筛选后的几行结论交回模型。Tool Result 没有消失，只是其中不需要模型理解的部分没有进入它的状态空间。

因此，Code Mode 与 Deferred Tool 正好解决 Tool Context 的两个不同问题。Deferred Tool 减少的是推理开始前加载的 Tool Definition；Code Mode 减少的是执行过程中积累的 Tool Result 和模型往返。前者控制能力说明的工作集，后者控制执行结果的工作集。

当然，并不是 Tool Call 越多，越应该塞进一段程序。一次写入是否需要用户批准，搜索结果是否改变了下一步调查方向，页面上一个异常提示究竟意味着什么，这些都需要模型在观察之后重新判断。涉及不可逆副作用时，让动作保持为清晰、独立的顶层 Tool Call，往往也更容易被人理解和控制。Code Mode 适合下沉确定性的部分，不适合把所有 Agent 决策藏进代码。

Maka 的 Code Mode 延续了这个边界。模型通过一个 `exec` Tool 提交 JavaScript Cell，Cell 只能调用当前已经激活、并且允许嵌套的 Tool。执行环境本身没有进程、文件系统或网络能力，并受到运行时间、内存、源码体积、结果体积、调用次数和并发数的限制。

更关键的是，Cell 内部的调用仍然回到同一个 `ToolRuntime`。参数校验、权限判断、执行边界以及上一节讨论的 T1/T2 持久化语义都不会因为调用来自代码而消失。Maka 会为这些嵌套调用分配独立身份，并记录它们与外层 `exec` 的父子关系。

这些内部调用是 Durable 的，但不会作为一长串 Call / Result 再次塞给模型。它们在 Runtime Event Log 中标记为来自 Code Mode，对模型历史则是 Hidden；模型看到的是外层 `exec` 及其最终结果。这里又出现了 Maka 一贯的结构：Log 保存完整事实，Provider Context 只是对事实的一种 Projection。

Code Mode 也让恢复问题变得更尖锐。一段程序可能已经成功执行了前三个 Tool，却在第四个 Tool 等待结果时崩溃。如果重启后把整段程序重新运行一次，就会把已经完成的现实动作也重新做一遍。因此，Maka 不会自动重试一个中断的 `exec`。嵌套 Tool 的既有结果保留在日志中，外层 Cell 则获得一个明确的 Interrupted Result，之后由新的模型推理决定如何继续。

这说明 Program 并没有成为绕过可靠性的捷径。它压缩了模型与 Runtime 之间的推理回合，却不能压缩现实世界已经发生过的事实。程序可以是临时的，调用栈可以随着 Cell 一起消失；但每一次真正越过边界的 Tool Call，仍然必须留下可审计、可恢复的 Log。

Tool Call 让模型从语言走向行动。Code Mode 又向前走了一步：模型开始生成的不只是一个动作，而是动作之间的结构。

## Parallel Tool Call：Agent Runtime 里的 Async I/O

Code Mode 可以在程序中并发调用多个 Tool。即使没有 Code Mode，今天的模型也可以在一个 Assistant Step 中一次生成多个 Tool Call。

这通常被叫作 Parallel Tool Call，但这里的“并行”需要先说清楚。模型并不是一边观察第一个调用的结果，一边决定第二个调用。它在同一次生成中已经把整组调用全部交给了 Runtime，因此这些调用之间不可能存在基于 Tool Result 的数据依赖。

如果第二个动作必须读取第一个动作的结果，它就不属于这一批，而应该出现在下一次模型推理中。

```text
同一个 Assistant Step

        ┌── Tool Call A ──→ Result A ──┐
Model ──┼── Tool Call B ──→ Result B ──┼──→ 下一次 Model Step
        └── Tool Call C ──→ Result C ──┘

                    Fan-out / Fan-in
```

从 Runtime 的角度看，这与经典 Async I/O 非常接近。每个 Tool Call 被转换成一个可以独立等待的 Task。Task 开始之后，Runtime 不需要为它占住一个同步调用栈，可以继续启动其他已经 Ready 的 Task；等到底层文件系统、进程、网络或远端服务返回结果，再唤醒对应的 Continuation。整批 Task 全部进入终态后，Runtime 才把 Tool Results 交给模型，开始下一轮推理。

这种结构的价值并不只是“更快”。更准确地说，它让等待可以重叠。一个 Web Search 正在等待网络时，另一个 Search、文件读取或子 Agent 不必陪它一起空等。Agent 的执行时间从多个 I/O 延迟之和，逐渐接近关键路径上的最长延迟。

但没有数据依赖，不等于没有资源冲突。

模型可以同时生成 `Read(a)` 和 `Edit(a)`，也可以同时要求两个 Tool 改写同一份 Session State。两个调用都不依赖对方的返回值，却可能争用同一个现实资源。如果 Runtime 只是把这一批调用全部交给 `Promise.allSettled()`，那么谁先观察、谁先写入、后写是否覆盖前写，就会取决于不可预测的执行时序。

Maka 在 [PR #4542](https://github.com/apache/maka/pull/4542) 中讨论的正是这个问题：一批 Tool Call 应该如何在保留独立 I/O 并发的同时，让访问同一资源的操作获得确定顺序。

这里很容易把所有责任都放进一个中央 Tool Scheduler。Scheduler 预先计算每个调用会读取或写入哪些资源，不冲突的立即执行，冲突的按照模型生成顺序排队。这种做法能够提供清晰的 Batch 编排，却不应该成为资源正确性的唯一来源。

经典 Async I/O 对这件事有一个很有用的职责划分：Executor 调度 Task，Resource Authority 管理资源。

一个 Tokio Executor 不会分析 Future 是否访问了同一个 Redis Key，也不会猜测两段异步代码最终是否写入同一个文件。它负责运行已经 Ready 的 Future。互斥、读写公平性、容量和唤醒通常由更靠近资源的一层负责，例如 Async Mutex、RwLock、Semaphore，或者独占状态的 Actor。

同样的边界也适用于 Agent Runtime：

```text
Tool Batch
    │  创建 Task、保留结果槽位、传播取消
    ▼
Resource Authority
    │  确认资源身份、排队、互斥、版本检查、唤醒
    ▼
Filesystem / Terminal / Browser / Session / Remote Service
```

为什么资源身份必须由 Authority 确认？因为真正的资源往往不是 Tool 参数中的那段字符串。`link/a` 和 `real/a` 可能通过符号链接指向同一个文件；两个不同的 UI Tool 可能操作同一个 Browser Tab；两个 MCP Tool 也可能共享同一个远端 Session。只有实际拥有或执行这个资源的一层，才能知道它们是否是同一个东西，以及操作在哪一个瞬间真正生效。

如果互斥只存在于当前 Tool Batch 的 Scheduler 中，它也无法约束另一个 Turn、另一个 Agent、另一个进程，或者任何绕过该 Scheduler 到达同一资源的执行路径。正确性必须在最靠近副作用的位置依然成立。Batch Scheduler 可以减少无谓竞争并提供确定性，但它更适合成为编排层，而不是唯一的锁。

不同资源也不必被塞进同一种冲突模型。文件适合按 Canonical Path 建立带写者公平性的读写 Lease；Terminal 和 Browser 更像拥有单一状态的 Actor；远端 Provider、MCP Server 和子 Agent 的并发上限是 Capacity 问题，更适合用 Semaphore 表达；带 Revision 的 Session State 则可以使用 CAS 检查。它们共享的是异步生命周期，不是同一种锁。

这也解释了为什么“资源冲突”和“容量限制”必须分开：

- 资源冲突回答两个动作能否正确地同时发生。
- 容量限制回答系统愿意同时承担多少个动作。

把 API QPS 限制伪装成一个与所有资源都冲突的全局锁，虽然能降低并发，却会制造不必要的 Head-of-Line Blocking。一个慢请求会挡住与它完全无关的文件读取。相反，Async I/O 追求的是只阻塞真正尚未 Ready 的 Task，让独立工作继续前进。

对于确实冲突的调用，Provider 返回的数组顺序可以作为一个稳定的 Tie-breaker，但不能被解释为数据依赖。模型在生成这一批调用时没有看见任何中间结果，这个顺序只能表示“发生冲突时谁先获得资源”，不能表示后一个调用消费了前一个调用的结果。

因此，Parallel Tool Call 中至少存在四种不同的顺序：

```text
模型生成顺序
    ≠ Task 启动顺序
    ≠ Task 完成顺序
    ≠ Runtime Event 到达顺序
```

不冲突的后续 Task 可以先启动，也可以先完成。实时事件应该按照实际发生的时序进入 Log，并通过 Tool Call ID 保持因果关联；而发送给 Provider 的 Tool Result，则可以按照原始调用顺序重新组装。事实顺序与模型协议顺序不必相同，它们是同一次执行的不同 Projection。

取消和失败同样要遵守 Async I/O 的生命周期。还在队列中的 Task 被取消后不能偷偷开始；已经跨过 T1 的 Task 则不能假装不存在，Runtime 必须等待它收敛并记录结果。普通的 Tool 业务失败可以作为一个 Result 与同批其他任务一起返回，但如果 T1/T2 持久化失败，新的排队任务就不应继续获得派发资格。已经 Active 的工作需要安全结束，尚未开始的工作应该被冻结。

这正是经典 Async Runtime 中 Structured Concurrency 的味道：父级 Batch 不只是启动一堆 Promise 然后离开，它拥有这些 Task 的生命周期。下一次模型推理开始之前，每个子 Task 都必须已经完成、被取消，或者进入一个明确可恢复的状态。

Parallel Tool Call 因而不是一句“工具可以同时调用”就结束了。真正困难的是在三个目标之间建立边界：让独立 I/O 充分重叠，让共享资源保持正确，让整个 Batch 在取消、失败和恢复时仍然拥有清楚的生命周期。

模型提供并发的意图，Batch Runtime 负责结构化地汇合，Resource Authority 决定现实世界允许怎样的并发。

## Sandbox 与 Serverless：给 Agent 一台随时可以丢掉的计算机

Tool Call 最终必须在某个地方运行。

模型可以生成调用意图，可以写出一段编排程序，却不能凭空产生 CPU、内存、文件系统和网络连接。真正执行 JavaScript、启动 Python、安装依赖、运行测试或操作浏览器的，始终是一块现实中的计算资源。

最轻量的环境可以是一个 JavaScript V8 Isolate。它启动快、边界清楚，适合运行 Code Mode 中短小的控制流。需要数据分析和丰富 Library 时，可以给 Agent 一个 Python Runtime。再往下，当 Tool 需要完整文件系统、系统命令、编译器和后台进程时，自然会走向 Container，甚至 MicroVM。

```text
LLM 生成意图
      │
      ▼
Agent Runtime
      │  选择执行环境与 Capability
      ▼
┌──────────┬──────────────┬─────────────┐
│ V8       │ Python       │ MicroVM     │
│ 编排调用 │ 数据与脚本   │ 完整 OS Tool│
└──────────┴──────────────┴─────────────┘
      │
      ▼
Filesystem / Process / Network / Browser
```

这些环境不是越重越好。让每个简单 Tool Call 都启动一台 VM 很浪费，让不受信任的系统命令与 Runtime 运行在同一个进程里又过于危险。Agent Runtime 需要根据任务真正需要的能力，选择足够轻、同时又足够隔离的执行载体。

Sandbox 因此不只是防止模型运行危险代码的围墙。它还是一次 Agent Execution 的资源边界、故障边界和生命周期边界。

Runtime 可以限制一个 Sandbox 能使用多少 CPU、内存、磁盘、并发和运行时间；可以决定它是否拥有网络、可以看到哪些目录、能够调用哪些外部服务；也可以在代码死循环、内存耗尽或进程崩溃时，直接终止这个环境，而不让故障扩散到整个 Agent 系统。

更重要的是，Sandbox 把“Agent”与“运行 Agent 的那台机器”分开了。

传统桌面程序往往默认进程和本地状态长期存在。Agent 的执行环境则应该被假设为随时可能消失：V8 Cell 运行结束就销毁，Container 空闲后可以回收，MicroVM 可以因为超时、迁移或宿主故障而终止。只要系统把 Agent 的真实状态寄托在这些临时环境里，恢复就会变得异常困难。

这也是 Append-Only Log 再次出现的地方。

对话、Tool Call、Tool Result、权限决定和恢复结论保存在 Durable Log 中；文件、图片和大型结果进入外部 Artifact Storage；Workspace 可以通过持久卷、快照或对象存储恢复。Sandbox 只承载当前正在运行的计算。它可以被销毁，也可以在另一台机器上重新创建。

```text
Durable State                         Ephemeral Compute

RuntimeEvent Log ─┐                 ┌─ V8 Isolate
Artifact Storage ─┼─→ Rehydrate ────┼─ Container
Workspace Snapshot┘                 └─ MicroVM

        保存“发生过什么”              执行“下一步做什么”
```

Serverless 与 Agent 天然契合的原因也在这里。Agent 工作负载通常是突发的：模型思考时 Sandbox 可能无事可做，Tool Call 到来时又需要迅速获得计算；有些任务只运行几十毫秒，有些任务要编译大型项目或等待长时间 I/O。理想的计算层应该能够按需创建、闲时归零，并根据 Tool 的资源声明分配不同规格。

但 Agent Serverless 不能只是传统 Function as a Service 的简单翻版。普通函数通常接收输入、计算并返回结果；Agent 还会保有 Workspace，启动后台进程，等待用户批准，调用外部 Tool，并在数小时后 Resume。它需要的不是一段永不消失的进程，而是一套能够把 Durable State 与 Ephemeral Compute 重新接合起来的协议。

一个 Sandbox 消失以后，Runtime 不应该尝试恢复它原来的内存、Promise 和调用栈。它应该先根据 Log 判断哪些 Tool 已经发生、哪些结果已经提交，再把 Workspace 和必要 Artifact 装载到新的环境，从可信的历史前缀开始下一段执行。

换句话说，Serverless 的重点不是 Agent 没有状态，而是它的状态不属于任何一台计算机。

这种架构也会改变权限的实现方式。Sandbox 不需要持有所有云服务的永久凭证，也不应该天然拥有完整网络。它只得到本次任务需要的 Capability；真正的 Secret、审批和 Resource Authority 留在 Sandbox 外部。代码可以请求一个动作，但外部 Runtime 仍然决定这个动作能否越过边界。

当这样的计算层足够便宜之后，Agent 才能真正扩大规模。一个 Agent 可以为一次短暂编排申请 V8，为一次数据处理申请 Python Container，为一次完整软件构建申请 MicroVM；也可以同时创建多个隔离环境，让子 Agent 在不同 Workspace 中并行工作，结束后立即释放资源。

再沿着这个方向往前走一步，会得到一个更有意思的形态：所有 Session 都沉到廉价的 S3-Compatible Object Storage 中，计算层则完全由廉价、短暂、可以被替换的执行资源组成。

这是一种彻底的存算分离。

Session 不再对应某个进程中的对象，也不对应某台机器上的目录。它是一组持久对象：Append-Only Event Segments、Artifact、Workspace Snapshot、Compaction Projection，以及指向当前可信前缀的 Manifest。一次对话结束之后，不需要有任何 Runtime 继续驻留在内存里。Session 可以安静地躺在对象存储中，除了存储本身几乎不消耗计算资源。

```text
                    Cheap Durable Storage

Session A ── Events / Artifacts / Workspace Snapshots ─┐
Session B ── Events / Artifacts / Workspace Snapshots ─┼── S3
Session C ── Events / Artifacts / Workspace Snapshots ─┘
                                                       │
                         Event / User / Schedule        │
                                   │                   │
                                   ▼                   │
                         Rehydrate a Session ◀─────────┘
                                   │
                       ┌───────────┼───────────┐
                       ▼           ▼           ▼
                      V8        Python      MicroVM
                       │           │           │
                       └───────────┴───────────┘
                                   │
                              Append Facts
                                   │
                                   └──────────────→ S3
```

所谓“长期运行的 Agent”，也就不再要求一台机器长期运行。

它可以绝大多数时间都处于休眠状态。用户发来消息、定时器到期、Webhook 抵达或者后台任务完成时，调度层读取 Session Manifest，加载必要的 Log Prefix 与 Workspace Snapshot，为它分配一个新的 Sandbox。任务完成后，新事实和 Artifact 回写对象存储，计算环境随即释放。

Agent 不是一直活着，只是随时可以被重新唤醒。

这里的 S3 也不再只是备份介质，而可以成为 Agent State 的事实存储。热机器上的内存、SQLite、Local SSD、向量索引和 Provider Context 都只是缓存或 Projection。它们可以提高读取速度，却不应该决定 Session 是否仍然存在。机器丢了，缓存可以重建；只要对象存储里的可信历史仍在，Agent 就仍在。

当然，把 Session 放进 S3，不意味着对同一个大对象不断执行原地 Append。更自然的实现是写入不可变的 Event Segment 和 Artifact，再用很小的 Manifest 或 Head Pointer 指向最新的已提交前缀。Lease、CAS、幂等键和正在执行的 Operation 仍然需要一个强一致的控制面，但庞大的历史正文、Tool Result、文件快照和媒体内容都可以进入廉价对象存储。

于是整个系统会自然分成两层：

- Data Plane 保存不可变、体积巨大、很少修改的 Session State。
- Control Plane 保存体积很小、需要强一致的 Head、Lease、Admission 和 Operation 状态。

这与现代数据库的存算分离很像。对象存储提供近乎无限、廉价而持久的容量，计算节点只在查询或写入发生时出现。只不过这里被查询和继续执行的，不是一张表，而是一个 Agent 的历史。

从这个角度看，Model Context 本身也是一次 Query。Runtime 从 S3 中读取 Session 的 Durable State，应用 Compaction、Tool Result Prune、Visibility 和 Provider Compatibility 等 Projection，构造出这一轮模型真正需要看到的上下文。模型完成推理后，新的输出不去修改过去，而是继续追加新的事实。

```text
Session on S3
      │
      ├── Projection ──→ Model Context ──→ LLM
      │                                      │
      ├── Rehydrate ───→ Sandbox ───────→ Tool Call
      │                                      │
      └──────────────── Append New Facts ◀───┘
```

这样一来，LLM 和 Sandbox 都只是计算资源。

模型可以根据任务难度临时选择，轻任务使用便宜模型，复杂决策使用更强模型；执行环境也可以根据 Capability 临时选择，简单编排进入 Isolate，普通脚本进入 Container，完整系统操作进入 MicroVM。同一个 Session 不属于任何一个模型，也不属于任何一种 Sandbox。

这会带来一种新的 Agent Economics。系统成本不再主要取决于保存了多少 Session，而取决于此刻有多少 Session 正在思考和行动。一千万个休眠 Session 可以只是对象存储中的一千万组前缀；只有被事件唤醒的那一小部分，才占用模型 Token、CPU 和内存。

最便宜的 Agent，不是运行在一台更小的服务器上，而是睡着时根本没有服务器。

存算分离也让抢占式计算真正可用。计算节点可以来自低价实例、共享 Worker Pool，甚至随时可能消失的 Capacity。过去，杀死一台正在运行 Agent 的机器意味着丢失整个会话；当状态已经外置，失去一个 Worker 只是失去一份临时执行。Runtime 根据 T1/T2 判断现实动作的状态，再把 Session 放到另一块计算资源上继续。

Branch 和 Fork 也会变得非常便宜。Append-Only History 与 Copy-on-Write Workspace Snapshot 天然允许多个 Agent 共享同一段历史前缀，再从不同位置长出各自的后缀。创建一个子 Agent 不必复制整个 Session，只需要记录它从哪个 Prefix 和 Snapshot 出发。没有修改的 Artifact 继续共享，只有新的事实产生新的存储。

甚至模型升级也不必迁移 Session。历史保留的是 Provider-Neutral 的 Runtime Fact，新模型只需要获得适合自己的 Context Projection。同一份 Durable Session 可以在今天由一个模型执行，几个月后由另一个模型 Resume。Agent 的身份来自它经历过的历史，而不是当前装载它的模型权重。

安全边界也因此变得更干净。S3 保存的是加密且可审计的长期状态，Sandbox 只在短暂生命周期内获得最小 Capability。Secret 不必写进 Workspace Snapshot，云账户的永久凭证也不必进入 MicroVM；需要访问外部资源时，Sandbox 通过外部 Authority 请求一次受约束的操作。计算环境被攻破之后，其权限会随着环境销毁而失效。

当然，廉价计算不会自动带来正确性。一个 MicroVM 再便宜，也不能让重复付款变得安全；一个 Container 再容易重启，也不能回答崩溃前的邮件是否已经发送。越是把 Worker 视为可以随时抛弃，越需要 Reliable Tool Call、幂等 Operation、Resource Authority 和 Append-Only Log 来证明现实世界中发生过什么。

所以这并不是一句简单的“把 Agent 跑在 Serverless 上”。更准确的说法是，我们正在为 Agent 构造一种新的计算机：

```text
S3                 是它廉价而持久的磁盘
Append-Only Log     是它可恢复的状态
LLM                 是它按需租用的推理单元
Sandbox / MicroVM   是它按需租用的身体
Agent Runtime       是连接这一切的操作系统
```

今天谈 Agent，注意力往往集中在模型上。但模型只负责产生判断和意图。让这些意图安全、可靠、低成本地作用于现实世界，需要大量随取随用的执行环境，以及比这些环境活得更久的 Session State。

未来 Agent 的核心基础设施，一定包含极其廉价的存储和极其廉价的计算。存储让数以亿计的 Session 可以长期存在，计算让其中任何一个 Session 都能在需要时迅速醒来。两者之间依靠的不是某台机器的内存，而是一条可以重放、验证和继续追加的历史。

回头看整条 Tool 链路，Deferred Tool 决定模型此刻需要知道哪些能力，Tool Call 把语言转换成行动，Reliable Execution 让行动成为可信事实，Code Mode 组织动作之间的结构，Async Runtime 让等待彼此重叠，而 Sandbox 与 Serverless 则为这一切提供真正可以消耗的 CPU、内存和隔离边界。

最终，Agent 不是一个恰好会保存状态的长驻进程。

**Agent 是一份持久状态，在需要思考和行动时，暂时租用一个模型和一台计算机。**

它沉睡在廉价的 S3 中。事件到来时，Log 告诉它曾经是谁，Sandbox 决定它现在能够做什么，廉价计算让它继续向前。
