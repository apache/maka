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

# maka-decisions-api

[English](README.md)

通过 JEV 和 OpenAI Decisions 两种协议执行结构化决策。公共模型使用 `input`、按名称关联的问题，以及 Predicate / Choice / Score / Refusal 答案。私有适配器构造请求并校验完整响应，提供方元数据不进入公共契约。

设置必须明确指定 `protocol`（`jev` 或 `openai_decisions`）、完整端点 URL、模型和正数超时。新实例默认禁用，使用 JEV。OpenRouter 使用 `jev`、`https://openrouter.ai/api/v1/systemone` 和 `~typesafe/jev-latest`；其 Alpha Decisions 端点也采用 JEV 格式，而非 OpenAI 格式。OpenAI 使用 `openai_decisions`、`https://api.openai.com/v1/decisions` 和 `gpt-6-luna`。

JEV 保留结构化指令、标准和评分 legend。布尔选项值仅用于 OpenAI；OpenAI 要求选项和等级描述为文本，每次最多 400 题、2–255 个选项、2–10 个评分等级。不支持的输入在发送前失败，不做隐式转换、协议探测、重试或回退。拒答是单题结果。Score 是等级索引的概率加权平均；confidence 阈值需针对所选模型验证。

调用使用有作用域的 HTTP 资源、端点绑定密钥和调用方执行期限。取消、超时、网络错误或结算未确认可能使远端结果不确定。引擎缓冲完整 JSON 响应，保留实际模型标识和提供方概率；usage 暴露输入/输出总量，不重复累加分项。

[源码](src/lib.rs) · [Cargo 清单](Cargo.toml)
