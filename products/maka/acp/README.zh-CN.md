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

在 Lody 中添加 Custom ACP Agent，使用绝对路径启动：`/绝对路径/maka acp --root /绝对路径/state-root`。v1 支持创建会话、加载历史、列举会话、配置、文本和思考增量、工具调用、权限、表单交互和取消；v2 保留消息 ID、替换更新及独立完成状态。

ACP 进程与所选 Host 须使用同一新版 Maka 构建；接入客户端 MCP 前，先用新构建重启旧 Host。

客户端提供的 stdio 和 Streamable HTTP MCP 服务器通过 Host 订阅仅绑定对应会话。加载或恢复会话时替换连接；断开时撤销租约，等待原执行清理后关闭传输。服务器环境变量和 HTTP 请求头不会保存为安装配置。工具仍遵循 Maka 的工作区权限和审批要求，服务器注解不授予权限。目前不支持附加目录和 SSE MCP 服务器。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
