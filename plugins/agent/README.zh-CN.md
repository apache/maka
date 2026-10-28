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

# Agent plugins

[English](README.md)

这个插件族管理 Agent 行为及其界面。叶目录的 `package.ts` 声明可独立组合的功能；下列 Rust crate 支撑这些声明，目录名表示代码归属，不会自动激活功能。

- [facts](facts/README.zh-CN.md)、[api](api/README.zh-CN.md) 和 [ports](ports/README.zh-CN.md)分别定义持久数据、协议契约和业务接口。
- [authority](authority/README.zh-CN.md)检查原始调用权限，[native](native/README.zh-CN.md)提供 Host 服务，[engine](engine/README.zh-CN.md)执行 Agent 工作。
- [provider-protocol](provider-protocol/README.zh-CN.md) 管理三种协议的编解码，[model](model/README.zh-CN.md) 管理执行适配器，[providers](providers/README.zh-CN.md) 管理提供商定义、认证和发现。
- [tool-catalog](tool-catalog/README.zh-CN.md)选择工具，[tools](tools/README.zh-CN.md)分发调用并提供 Code Mode。
- [assistant](assistant/README.zh-CN.md)、[goal](goal/README.zh-CN.md)、[graph](graph/README.zh-CN.md)、[scheduler](scheduler/engine/README.zh-CN.md)、[insights](insights/README.zh-CN.md)、[session-import](session-import/README.zh-CN.md)、[session-recap](session-recap/README.zh-CN.md) 和 [session-title](session-title/README.zh-CN.md)管理各自功能。
- [acp-executor](acp-executor/native/README.zh-CN.md)通过显式进程与回调服务连接外部 ACP Agent。

终端和桌面 shell 运行的[工作台](../../products/maka/workbench/README.zh-CN.md)消费这些公共 Host 契约。产品组装位于 [products/maka](../../products/maka/README.zh-CN.md)；工作台管理自己的草稿编辑器与交互生命周期。
