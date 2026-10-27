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

# Maka product

[English](README.md)

这个目录将可复用插件和平台所有者组装成 Maka 应用。

| 目录 | 职责 |
| --- | --- |
| [bundle](bundle/README.zh-CN.md) | 选择包并生成 Host/UI 组合 |
| [native](native/README.zh-CN.md) | 选择编译进程序的 Host 工厂 |
| [cli](cli/README.zh-CN.md) | 启动终端产品，提供 CLI 命令 |
| [desktop-shell](desktop-shell/README.zh-CN.md) | 在桌面窗口中运行工作台，连接公共 Host 服务 |
| [acp](acp/README.zh-CN.md) | 通过 ACP 服务编辑器客户端 |

在仓库根目录运行 `just run`。它先构建 TypeScript 产品，再启动 Cargo。开发二进制从磁盘读取 bundle，因此仅修改 TypeScript 不会触发 Rust 重编译；发布二进制嵌入相同 bundle。

通过 `just build` 构建 CLI 和桌面 shell，支持 `--release` 和 `--target`；macOS 上 shell 放在 `Maka.app` 中。运行 `target/debug/maka desktop --root HOST_ROOT` 初始化或重开业务 Host，并从任意工作目录启动桌面；启动器校验 endpoint 和 epoch，在子进程退出前保留自己的客户端，随后断开连接，Host 会完成已接受的工作。

在终端界面的 **设置 → 外观 → 语言** 中选择共享语言。选择后自动保存在业务 Root 中，与各终端界面的主题和自定义颜色分开；其他已打开的终端界面在重新进入设置或显式刷新时更新，不持续广播。原先分别保存的终端界面语言需要重新选择一次，外观数据保留。

该偏好也决定既有会话和 WorkHub 新工作的内置 Agent 指令语言。已接受的工作保留原语言，用户内容和自定义指令保持原文。

内置包是安装输入。重新打开已有安装时，使用的是已提交的配置和包内容；重建仓库不会覆盖用户的组合。

在 macOS 或 Linux 上测量 Agent 并发性能时，先运行 `cargo test --release -p maka-agent-native --lib --no-run`，再将输出的测试程序路径传给 `python3 scripts/agent-scale.py --binary PATH`。默认对 10、100、1000 个 Agent 各测五轮，经过实际 Host、原生 owner 和共享模型 SDK。本地 HTTP 服务等待所有请求同时活跃后才开始输出；测试校验持久化结果、取消、连接关闭及恢复。JSON 报告保留所有样本、前台查询延迟、CPU 和峰值内存。测量时应停止竞争编译任务；结果不包含 TUI 渲染及外部模型延迟。
