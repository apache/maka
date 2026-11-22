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

# 平台层（Platform）

[English](README.md)

`platform/` 提供承载上层[业务插件](../plugins/README.zh-CN.md)的运行时底座：插件包加载、组合规划、SQLite 状态存储、Host 服务调度、脚本沙箱、操作系统级隔离、Computer Use 以及 NSH 客户端原生支撑。

| Crate | 目录 | 职责 |
| --- | --- | --- |
| `maka-plugin-core` | [`plugin-core/`](plugin-core/src/lib.rs) | 插件清单、组合图、协议契约模型与操作回执基础类型 |
| `maka-packages` | [`packages/`](packages/src/lib.rs) | 内容寻址的 `.maka-plugin` 归档校验与不可变包存储 |
| `maka-capabilities` | [`capabilities/`](capabilities/src/lib.rs) | 作用域受限的底层能力句柄（调用、文件、HTTP、进程、终端、凭据、存储） |
| `maka-event-log` | [`event-log/`](event-log/README.zh-CN.md) | State Root 独占锁、SQLite 读写通道、两阶段操作日志与检查点仓库 |
| `maka-host-runtime` | [`host-runtime/`](host-runtime/src/lib.rs) | Host 部署调谐、调用准入控制、实例生命周期与本地 RPC 服务 |
| `maka-js-runtime` | [`js-runtime/`](js-runtime/src/lib.rs) | 面向 Code Mode 与插件脚本的嵌入式 V8 Isolate 运行时 |
| `maka-host-js` | [`host-js/`](host-js/src/lib.rs) | 运行在 V8 上的 JavaScript `HostService` 适配器 |
| `maka-python-runtime` | [`python-runtime/`](python-runtime/src/lib.rs) | 面向 Python Code Mode 单元的受限 Monty 子进程运行时 |
| `maka-sandbox` | [`sandbox/`](sandbox/README.zh-CN.md) | 操作系统级命令沙箱（macOS Seatbelt、Linux bubblewrap/netns、Windows MXC 与低权限账户） |
| `maka-process` | [`process/`](process/src/lib.rs) | 进程组、管道、Unix PTY / Windows ConPTY 与物理资源回收跟踪 |
| `maka-network` | [`network/`](network/src/lib.rs) | TLS/HTTP 连接管理、代理配置与受限目标网关 |
| `maka-computer-use` | [`computer-use/`](computer-use/README.zh-CN.md) | 驱动原生桌面无障碍接口与浏览器扩展的独立 JavaScript REPL |
| `maka-transport` | [`transport/`](transport/src/lib.rs) | 前端壳层/CLI 与 Host 之间的本地 IPC 帧传输 |
| `maka-background-health` | [`background-health/`](background-health/src/lib.rs) | 后台进程与任务的存活探测 |
| `maka-presentation` | [`presentation/`](presentation/src/lib.rs) | 工具活动与会话历史的结构化展示描述 |
| `maka-ui-support` | [`ui-support/`](ui-support/src/lib.rs) | 面向 NSH 工作台的文件/剪贴板不可变快照与系统语言检测 |

核心生命周期 crate（`plugin-core`、`packages`、`capabilities`、`event-log`、`host-runtime`）不依赖 V8 或 Agent 引擎，便于独立编译轻量工具与系统辅助进程。
