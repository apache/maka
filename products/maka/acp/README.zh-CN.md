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

# maka-acp

[English](README.md)

通过普通 Host 客户端向客户端提供 ACP v1 和 v2 服务。`serve` 将协议请求转换为获准的 Agent 操作和观察，不持有执行或规范存储权限。Maka 调用外部 ACP Agent 的实现位于 `plugins/agent/acp-executor`。

运行 `maka acp`，通过 stdio 通信。SDK 根据 `initialize` 中的版本选择协议，无需版本参数。模型连接和凭据来自所选 Host Root（`maka acp --root /绝对路径/state-root`）；先在该 Root 配置默认模型，或通过会话配置选择模型。

Custom ACP Agent 的启动命令使用绝对路径：`/绝对路径/maka acp --root /绝对路径/state-root`。v1 支持创建会话、加载历史、列举会话、配置、文本和思考增量、工具调用、权限、表单交互和取消；v2 保留消息 ID、替换更新及独立完成状态。客户端传入的 MCP 服务器和附加目录会被拒绝，请通过 Maka 配置。

Lody 通常会在创建或加载会话时注入内置 MCP 服务器，该请求目前会被拒绝。支持 v1 握手尚不足以实现 Lody 的完整接入；还需要支持客户端提供的 MCP 服务器，或由客户端省略这些配置。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
