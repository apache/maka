---
doc_id: computer-use-model-loop-foundation
title: "Computer Use 模型循环基础"
language: zh-CN
source_language: en
counterpart: ./computer-use-model-loop-foundation.md
implementation_status: current
document_status: current
translation_status: synced
last_verified: 2026-09-11
owners:
  - maka-backend
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

# Computer Use 模型循环基础

[English](./computer-use-model-loop-foundation.md)

## 产品边界

主模型路径是经由 `AiSdkBackend` 的、与 provider 无关的 `maka_computer` function
tool。模型先观察 Accessibility tree，然后使用 `click_element`、`set_value` 或另一项
语义 action，并携带来自该次 observation 的 ID。

这与还原出的 Codex 分层结构一致：

```text
model function/tool call
  -> Computer Use facade
  -> observed AX element identity
  -> stale-element refetch and uniqueness checks
  -> element executor
  -> AXPick / AXPress / AXValue when supported
  -> synthetic event fallback only inside the native executor
```

Codex 目前在捕获到的 production 请求中并未暴露顶层的原生 `computer` tool。它延迟
加载的 Computer Use wrapper 暴露的是 AX facade。Accessibility 优先的 dispatch 发生
在 element 执行内部，而不是把模型的每个 coordinate 隐式转换为一个 AX element。

## 当前安全策略

Maka 保持同样的职责分离：

- `maka_computer` 是主要的面向模型的路径；
- 保留语义 element action，以及经过验证的 AX/CDP value 更新；
- coordinate click、scroll、drag、key input 和 pixel fallback 被描述为已禁用，并
  fail closed；
- provider adapter 使用同一个 `maka_computer` contract，而不是单独的原生 Computer
  Use loop。

任何 provider adapter 都不得推断缺失的 observation ID，也不得静默地把 action 绑定
到当前 frame。

## 真实 Provider 结果

以下运行使用了位于 `127.0.0.1:8538` 的本地 Azure Responses bridge 与位于
`127.0.0.1:8537` 的 coproxy Anthropic endpoint，且未持久化 credential，也未持久化
原始 provider 响应。

### OpenAI Responses

`gpt-5.6-sol` 完成了 product 路径：

```text
list_apps -> observe -> set_value -> verified finish
```

完整的 product 路径通过：

```text
getAIModel
  -> OpenAI Responses model
  -> AiSdkBackend / streamText
  -> ToolRuntime
  -> maka_computer
  -> synthetic AX semantic backend
```

product 路径持久化了 tool call 与结果，发出了 permission-safe telemetry，并到达了
经过验证的最终值。

### Anthropic

`claude-sonnet-4-6` 经由 coproxy 完成了同一个语义任务。

有一次运行从 `set_value` 中省略了 `observation_id`。harness 返回了一个带类型的
tool error，要求重新进行 observation；模型自行恢复，而不是让 executor 去猜测
frame。这一行为是未来 provider adapter 必须覆盖的 regression 场景。

### Kimi 和 MiniMax

本机上未配置任何可用的 Kimi 或 MiniMax credential。它们的 product 路径是作为
hermetic protocol evidence 覆盖的，而非真实 provider evidence。

`kimi-coding-plan` 和 `minimax-coding-plan` 都通过各自完全一致的
Anthropic-compatible URL/auth contract 完成了同一个多步语义 loop：

```text
getAIModel -> streaming tool_use -> AiSdkBackend -> ToolRuntime
  -> maka_computer -> list_apps -> observe -> set_value -> final response
```

## Provider Schema 发现

OpenAI strict function schema 要求每个 property 都列在 `required` 中。可选字段必须
以 nullable 表示。由于一个 function schema 服务于多个 action variant，模型可能会
填充与所选 action 无关的已知字段。

因此，OpenAI adapter 会：

1. 将所有 property 都输出为 required 且 nullable；
2. 拒绝未知 key 与 accessor property；
3. 只投影所选 action 允许的已知 key；
4. 记录被丢弃的非 null key；
5. 将投影后的值传给现有的严格 action parser。

核心的 `maka_computer` parser 保持严格且与 provider 无关。

## 非声明事项

本基础阶段不做以下事项：

- 重新接入兼容性 CGEvent 路径；
- 添加真正的 AppKit AX provider runner（那属于下一个 evidence-layer PR）；
- 解决 PID 复用、过期 driver node 或 executor 生命周期加固问题；
- 取代 executor-hardening 与 stacked-PR restack 相关工作。
