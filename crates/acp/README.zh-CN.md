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

# ACP

[English](README.md)

通过官方 `agent-client-protocol` SDK 对外提供 Maka。此 crate 只使用公共 Host
客户端；执行、权限和持久事实仍由 Host 管理。

```sh
maka acp
maka acp --root /absolute/state/root
```

CLI 连接或启动本机 Host。标准输入／输出只传输 ACP，诊断写入标准错误。
默认使用与 TUI 相同的状态目录。

- 接入协议：实验性的 ACP v2（`unstable_protocol_v2`）。
- 会话：创建、列表、恢复、关闭，以及模型、思考、协作和沙箱选项。
  恢复支持从头重放，保留规范消息身份。
- 输入：文本、图片、嵌入资源及客户端明确提供的本地文件链接。
  接收后先返回持久用户消息 ID，再流式发送更新，直到终态 idle。
- 交互：权限请求，以及按客户端能力启用的表单询问。
  Host 校验精确回答；拒绝或取消不会授予权限。
- 取消精确定位当前连接的前台 Turn。关闭会话会取消并结算前台工作，
  不删除历史。迟到的接收回执在取消期间仍由连接持有；未知结果不会重新提交。

不声明支持客户端 MCP 服务、额外工作区目录、任意重放游标或 ACP 身份认证。
附件重放保留描述元数据，不暴露 Host 私有路径。恢复要求 Host 会话空闲；
每条连接最多打开八个会话。

SDK 负责 JSON-RPC 解析、请求关联和派发，传输适配层限制行大小及输出等待时间。
调用外部 Agent 的 Executor 适配在
[`external-agent`](../external-agent/README.zh-CN.md)，通过 SDK 协商同时支持 v1。

```sh
cargo nextest run -p maka-acp
cargo nextest run -p maka-runtime-host --test acp_server
```
