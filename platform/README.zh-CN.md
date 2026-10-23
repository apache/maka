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

# Platform

[English](README.md)

平台负责加载包、校验组合、管理执行资源和呈现已提交的 UI 帧。产品功能位于 [plugins](../plugins/README.zh-CN.md)。

| 领域 | Crate |
| --- | --- |
| 声明与包内容 | [plugin-core](plugin-core/README.zh-CN.md)、[packages](packages/README.zh-CN.md) |
| 资源权限与持久化 | [capabilities](capabilities/README.zh-CN.md)、[event-log](event-log/README.zh-CN.md) |
| 服务与组件所有者 | [host-runtime](host-runtime/README.zh-CN.md)、[ui-runtime](ui-runtime/README.zh-CN.md) |
| JavaScript 执行 | [js-runtime](js-runtime/README.zh-CN.md)、[host-js](host-js/README.zh-CN.md)、[ui-js](ui-js/README.zh-CN.md) |
| 原生呈现 | [presentation](presentation/README.zh-CN.md) |
| I/O 与隔离 | [network](network/README.zh-CN.md)、[process](process/README.zh-CN.md)、[sandbox](sandbox/README.zh-CN.md)、[computer-use](computer-use/README.zh-CN.md) |
| 连接与健康状态 | [transport](transport/README.zh-CN.md)、[background-health](background-health/README.zh-CN.md) |

Host 和 UI 共用插件生命周期内核，通过可选的执行适配器运行 JavaScript 插件。[工作台](../products/maka/workbench/README.zh-CN.md) 是通过公共 Host 服务连接的 NSH 应用；[终端 shell](../products/maka/terminal-shell/README.zh-CN.md) 在终端中渲染它，[桌面 shell](../products/maka/desktop-shell/README.zh-CN.md) 在窗口中渲染它。

依赖边界是明确的：Host 与 UI 生命周期 crate 无需 V8 或 Agent 引擎即可编译。部分平台代码仍依赖存储与呈现所需的 Agent 共用事实类型；这些数据依赖明确列在 Cargo 配置中。
