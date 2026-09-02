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

# TUI ctx 实时更新：人话讲解（#4545）

英文正式设计见 [tui-live-ctx-updates.md](./tui-live-ctx-updates.md)。这篇用大白话讲清楚：
问题是什么、desktop 已经怎么做的、我们要抄什么、以及那些名词都是什么意思。

## 一句话版本

TUI 底部状态栏有个 `ctx 45k/200k 23%` 的指示器，告诉你"上下文装满多少了"。
现在它**每轮对话结束才刷新一次**；而 desktop 版 maka 是**模型每跑完一步就刷新**。
方案：把 desktop 的刷新方式原样搬到 TUI，只改 CLI 包，不动任何协议。

## 先搞懂名词

| 名词 | 人话解释 |
|------|----------|
| **token** | 模型读/写文字的最小计费单位，约等于一个词的碎片。你给它的和它回你的都按 token 算。 |
| **上下文窗口（context window）** | 模型一次能看到的最大 token 总量，比如 200k。系统提示、历史消息、工具定义、工具结果全塞在里面。装满了就必须压缩（compact），否则报错或降智。 |
| **ctx 指示器** | TUI 状态栏上的 `ctx 已用/总量 百分比`，告诉你窗口还剩多少。 |
| **turn（轮）** | 你按一次回车 → agent 完全停下来，这整个过程。agentic 场景下，一个 turn 里模型可能反复"想一步、调个工具、再想一步"，跑几分钟。 |
| **step（步）** | 一个 turn 内部的每一次"模型调用 + 工具执行"循环。一个 turn = 很多 step。ctx 就是在 step 之间涨上去的（工具结果塞进了上下文）。 |
| **请求结算（settle）** | 一次模型请求跑完，provider（模型厂商）上报"这次实际用了多少 token"。**只有结算时才能拿到精确数字**——流式输出途中谁也不知道这次请求的输入到底多少 token，所以"token 级实时"在原理上就不可能，谁也做不到。 |
| **token_usage 事件** | runtime 在**整个 turn 结束后**发的一条消息，里面有这次 turn 的用量账单。TUI 现在的 ctx 就靠它刷新——这就是"每轮才更新"的根源。 |
| **快照（latest-context snapshot）** | Host（后端进程）在**每次请求结算时**写的一行记录："最近一次请求，输入 X token，窗口 Y。" 每个 step 都会更新，不用等 turn 结束。desktop 的 ctx 条就是读这行记录。 |
| **pull（拉）vs push（推）** | push = 后端主动把数据塞给界面（token_usage 事件就是 push，但一轮只推一次）。pull = 界面自己开口问："现在上下文多满了？" desktop 用的是 pull。 |
| **防抖（debounce）** | 事件密集来时（一步里可能连发好几个事件），等 400ms 合并成一次查询，避免刷屏。desktop 就是这么做的，我们照抄。 |
| **busy gate（忙锁）** | TUI 自己的一把锁：turn 运行时禁止执行 `/model`、`/session` 这类会改状态的命令，防止打架。`/context` 命令现在也被它挡住——但注意，这是 TUI 自己的规定，**不是后端禁止查询**。我们的刷新钩子绕开这把锁直接问后端，合法。 |
| **竞态（race）** | "查询发出时数据还没写好"的风险。已排除：后端是先落库快照、再发事件给界面（顺序有 await 保证），所以界面收到事件时快照必然已就绪。 |

## 问题到底是怎么回事

```
你 → 发消息 ── turn 开始 ────────────────────────────── turn 结束
                step1  step2  step3  ...  step20          │
                 │      │      │            │             │
              ctx 涨了 又涨了 又涨了     又涨了      token_usage 事件
                 │      │      │            │             │
TUI 状态栏:   【旧值】【旧值】【旧值】...【旧值】   【终于更新!】
desktop:     【更新】【更新】【更新】...【更新】   【更新】
```

最讽刺的是：**数据后端早就有**——每个 step 结束都记了账（审计 #4/#6），
只是没人告诉 TUI 的界面。desktop 会主动去问，TUI 不会。

## 方案（抄 desktop 的作业）

在 TUI 的事件处理入口（`onEvent`，每个 live 事件都经过这里）挂一个钩子：

1. 收到 `tool_start` / `tool_result` 等"上下文可能变了"的事件 → 触发防抖刷新；
2. 400ms 防抖后，调 `driver.getContextDiagnostics()`（现成的接口，desktop 同款）
   问 Host："最新快照是啥？"；
3. 拿到 `inputTokens`（已用）和 `contextWindow`（总量）→ 更新状态栏数字；
4. 防护措施照抄 desktop：
   - **版本号防乱序**：两次查询先后发出、后发先至时，丢弃过期的结果；
   - **失败保留旧值**：查询失败不清空，原来的数字继续站着；
   - **会话切换丢弃**：查询回来时如果用户已经换了会话，结果作废。

turn 结束时原本的 `token_usage` 事件照常到达——它和快照说的是同一次请求，
数字天然一致，不打架。

## 为什么不选别的路

- **新加 push 事件**：要动核心事件协议、runtime 发射点、host 转发、持久化语义，
  还会造成"同一个数两条来源"的漂移风险。pull 方案零协议改动，且 TUI 和
  desktop 读的是同一行记录，永远不会不一致。
- **复用 token_usage 事件发半成品**：它会累加计费字段，发半个会把账算重复，
  违反仓库"用量不完整就当没有"（#972）的原则。
- **请求发出前用字节数/4 估一个值**：误差太大（图片附件的 base64 会严重失真），
  不值得。

## 改动范围

只动 `packages/cli`：

- 新增 `tui-context-refresh.ts`：事件过滤器 + 防抖器（约几十行，仿 desktop 的
  `session-trace-refresh.ts`）；
- `pi-tui-runner.ts`：`onEvent` 里挂钩子、写结果、渲染；
- 测试：中途刷新、防抖合并、乱序丢弃、失败保留、切会话丢弃、turn 末事件回归。
