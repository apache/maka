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

# maka-provider-protocol

[English](README.md)

编码 Chat Completions 兼容协议与 Anthropic Messages 请求，解码完整响应及流式响应。原生输入和输出类型将协议状态与 Host 的规范历史分开，提供商扩展在协议边界以明确的 JSON 值承载。

本 crate 负责增量 SSE 分帧、工具身份、推理、引用、用量和托管工具结果回放。[maka-model](../model/README.zh-CN.md) 提供已授权的传输、凭据、取消、超时及字节预留。本 crate 不执行网络或运行时操作。

Chat Completions 编解码器面向兼容协议厂商；OpenAI 专有模型策略由原生 Responses 路由处理。Messages 编解码器不包含 Files、Batch、Decisions 或 Skills 管理端点。

行为已使用未修改的上游选定测试验证，固定版本记录在[来源审计](../../../docs/code-origin-audit.md)中。临时上游测试和验证绑定位于产品之外，第一方回归测试与协议实现共同维护。

SSE 解码器只将单条未结束记录限制为 64 MiB，以约束异常或缺少结束符的提供商输入，并为超过 32 MiB 的原子记录留出余量。完成记录直接移交缓冲区，不继续保留峰值容量；完整响应的累计记录数和长度不受此限额约束。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
