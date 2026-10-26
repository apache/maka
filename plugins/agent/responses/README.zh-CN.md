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

# maka-responses

[English](README.md)

实现 Responses 协议，包括请求编码、流解码、SSE 处理和连接通道。连接属于可丢弃的传输状态；规范会话和执行事实仍归 Agent 所有者管理。入口是 `Adapter`、`request` 和 `stream`。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)

请求持有不可变的 prepared wire 视图。HTTP 直接读取有界 JSON 分块，WebSocket 将同一数据发送为 Text/Continuation 分帧，不再组装完整请求文本。重试重新打开同一捕获视图。前缀身份与后缀索引元数据验证增量续接，不再读取旧消息正文。

连接缓存只保留请求属性和响应 ID。规范记录中的 accepted-item 元数据保存 phase、status、annotations 和文本分段边界，不复制正文，因此重连或压缩后的完整重放仍能保留这些字段。取消进行中的分片发送会退役连接，并释放数据源与 I/O 缓冲。

只有明确构造的小型内存请求会在发送时逐条编码。持久化请求必须提供 codec 匹配的 prepared wire；缺失或不匹配时需要重新捕获。脏组准备仍遵循源 Message 的分配契约，普通 HTTP/WebSocket 上传缓冲则与历史总量及单条正文大小无关。
