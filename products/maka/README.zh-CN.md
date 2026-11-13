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

在仓库根目录运行 `just run`。开发构建与检查任务会先执行 `just setup`；锁文件、工作区包清单和补丁未变化时会直接复用已有 JavaScript 依赖。Cargo 编译选中的插件和共享工作台，并将它们嵌入 CLI，debug 与 release 构建均如此。修改这些源文件后需重新构建，无需提前单独构建产品 bundle。

通过 `just build` 构建 CLI、桌面 shell 和 Python worker，支持 `--release` 和 `--target`。`--release` 按本机系统构建；明确指定 Linux release 目标时，使用 Zig 和分发所需的 glibc 基线。加上 `--timings` 可以生成 Cargo 构建耗时报告。构建和运行都遵循 Cargo 的产物目录配置，包括 `CARGO_TARGET_DIR`；macOS 上 shell 放在 `Maka.app` 中。运行 `target/debug/maka desktop` 初始化或重开 `~/.maka/application/host` 的业务 Host，并从任意工作目录启动桌面，`--root HOST_ROOT` 可指定其他 Root；启动器校验 endpoint 和 epoch，在子进程退出前保留自己的客户端，随后断开连接，Host 会完成已接受的工作。

在终端界面的 **设置 → 外观 → 语言** 中选择共享语言。选择后自动保存在业务 Root 中，与各终端界面的主题和自定义颜色分开；其他已打开的终端界面在重新进入设置或显式刷新时更新，不持续广播。原先分别保存的终端界面语言需要重新选择一次，外观数据保留。

该偏好也决定既有会话中新工作的内置 Agent 指令语言。已接受的工作保留原语言，用户内容和自定义指令保持原文。

回复期间发送消息，会在 Direct Mode 和 Code Mode 中修正当前工作方向；发送菜单中的 **加入队列** 可留到单独一轮处理。停止按钮始终独立于发送按钮。发送后可继续编辑新草稿，失败的原消息保留在输入区附近，供恢复或重试。Steering 会中断当前模型请求和工具观察等待，已派发的工具继续由原运行持有，随后报告真实结果。

脚本自动化使用 Maka 内嵌的 Deno 运行时，在会话工作目录和进程沙箱下运行 JavaScript 或 TypeScript。标准输出的最后一行应是 `true` 或 `false`，结果变为 `true` 时触发。更新旧脚本时，用 `Deno.readTextFile` 和 `fetch` 替换 `tools.Read` 和 `tools.Fetch`，并将返回布尔值改为打印布尔值。

在 **设置 → 常规 → 消息预测** 中管理下一句消息建议。预测沿用会话的模型与推理强度，并在原模型请求前缀之后追加指令。如果输入框中已有草稿或附件，尚未开始的预测会被跳过；已开始的预测可以继续完成。按 Tab、右箭头、Enter 或点击建议按钮，会将建议填入可修改的草稿，不会自动发送；按 Escape 可忽略，正常输入或使用输入法时会隐藏预览。没有预测时 Tab 正常切换焦点，Shift+Tab 始终向前一个控件切换焦点。配置表格可调整回复结束后和打开会话时的预测频率、自定义提示词，也可恢复随语言切换的内置提示词。

内置包是安装输入。重新打开已有安装时，使用的是已提交的配置和包内容；重建仓库不会覆盖用户的组合。
