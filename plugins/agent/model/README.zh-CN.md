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

# maka-model

[English](README.md)

通过提供商适配器构造模型请求并接收流式响应。`ModelExecutor` 管理请求，`Conversation` 构造会话输入，`reasoning` 处理推理配置。凭据通过 `AuthResolver` 提供，调用方传入已授权的网络与计量上下文。

[`adapters`](src/adapters.rs) 管理 Responses、Chat Completions、Anthropic Messages 和 Codex 订阅的执行适配。它将规范事实投影到纯 Rust [协议核心](../provider-protocol/README.zh-CN.md)，再将协议事件转换为模型事件。提供商定义、认证和发现留在 [providers](../providers/README.zh-CN.md)。

适配器拥有 HTTP/WebSocket 传输与可丢弃的连接状态。请求消费不可变的预编码分块，重试重新打开同一份捕获来源。Codex 先从完整提示词准备 instructions，再由 Responses 连接选择续接后缀。未消费输出共享 32 MiB 字节窗口；更大的原子事件独占窗口，直到其持久化分片全部消费。这是背压，不是响应大小上限。空闲期限覆盖网络等待，不包含输出背压等待。

HTTP、SSE、WebSocket 及持久重建保留完整的规范响应条目和文本。分块与有界通道施加背压，不另设整个响应的配额。可丢弃的续接缓存允许淘汰，恢复依据仍是规范历史。请求 token 选择、提供商协议校验及原有空闲、取消清理与内容保留分开处理。

HTTP 连接失败保留底层原因，不包含请求 URL。嵌套的连接错误（包括 TLS 握手 EOF）沿用现有网络重试策略；无效 TLS 仍不自动重试。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
