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
- [assistant](assistant/README.zh-CN.md)、[goal](goal/README.zh-CN.md)、[scheduler](scheduler/engine/README.zh-CN.md)、[insights](insights/README.zh-CN.md)、[session-import](session-import/README.zh-CN.md)、[session-recap](session-recap/README.zh-CN.md) 和 [session-title](session-title/README.zh-CN.md)管理各自功能。
- [acp-executor](acp-executor/native/README.zh-CN.md)通过显式进程与回调服务连接外部 ACP Agent。

终端和桌面 shell 运行的[工作台](../../products/maka/workbench/README.zh-CN.md)消费这些公共 Host 契约。产品组装位于 [products/maka](../../products/maka/README.zh-CN.md)；工作台管理自己的草稿编辑器与交互生命周期。

## 子 Agent 预设管理

Agent 服务提供 `presets`、`preset`、`createPreset`、`updatePreset` 和 `deletePreset`，字段见[协议](api/src/preset.rs)。预设初始为空，持久化在业务 Host 的 Agent 作用域内。列表不加载 instruction，详情保留完整正文；模型引用不保存凭据。

修改和删除必须提供 `expectedRevision`。修改时省略字段表示保留；`instruction: ""` 清空指令，`thinkingLevel: {"kind":"default"}` 恢复模型默认，`{"kind":"set","value":"high"}` 设置思考强度。修改模型或思考强度时校验原生模型；连接失效后仍可修改其他字段或删除。名称去除首尾空白，并在作用域内保证唯一。

持久化变更与返回结果通过 Host 操作日志原子提交。丢失响应时恢复原操作引用，不重新提交变更。默认产品通过 `SubagentPresetList/Read/Create/Update/Delete` 暴露这些方法。`SessionCreate` 按 ID 应用预设，`SessionSend` 提供本次任务。
