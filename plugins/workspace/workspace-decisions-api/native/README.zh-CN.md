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

# maka-decisions-api-native

[English](README.md)

原生 `maka.workspace.decisions_api` 实现，导出端点设置、密钥管理和评估的 Decisions API 契约。共享引擎明确选择 JEV 或 OpenAI 协议。HTTP 准入受已配置端点和设置/密钥 revision 约束，重定向不会转发密钥。

设置和密钥使用 `maka.workspace.decisions_api` namespace。密钥绑定完整原始端点 URL；保存的设置明确指定协议。

[源码](src/lib.rs) · [引擎](../engine/README.zh-CN.md)
