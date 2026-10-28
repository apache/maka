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

# maka-providers

[English](README.md)

提供编译进程序的模型提供商定义。`api` 覆盖 API 提供商，`codex` 实现 Codex 提供商集成。原生服务显式选择定义，传输与凭据使用调用方提供的能力和配置。

Codex 管理订阅配置、认证和模型发现。执行适配器位于 [model::adapters](../model/src/adapters.rs)，组合通用 Responses 适配器。提供商定义不拥有模型执行会话。

API 请求选项遵循解析后的实际协议，覆盖提供商别名、模型覆盖和备选协议。模型可选元数据、主请求、自动标题和回顾使用相同的思考档位准备策略；显式禁用 Anthropic 并行工具调用会编码进请求。原生准备诊断保留固定的本地拒绝原因，同时隐藏提供商的任意错误文本。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)

模型发现跟随供应商分页直到终止响应，并拒绝重复游标；编号分页根据经过检查的页码推进。分页大小和并发账户请求约束同时进行的工作，不限制完整账户或模型目录。模型元数据和认证值完整保留，Host 负责传输准入和清理结算。OAuth 设备授权过期与令牌刷新遵循供应商生命周期语义。
