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

# 收集 Desktop 会话问题的排障材料

[English](./session-diagnostics.md)

收集材料前，先打开出问题的任务。需要让助手阅读对话时，将其保存为
Markdown；排查崩溃、请求失败或 Runtime Host 断连时，再复制诊断信息。
这些导出内容分别回答不同的问题。

## Trace 里的文件路径去哪了？

以前的“记录文件”一栏显示的是工作区共享的 `runtime.sqlite` 数据库，
并不是当前会话独有的文本文件。该入口于 2026 年 8 月 8 日通过
[#2196](https://github.com/apache/maka/pull/2196) 加入，随后在 2026 年
8 月 23 日通过 [#3610](https://github.com/apache/maka/pull/3610) 显式删除，
不再使用的 service 和 bridge 字段也一起移除了。

当前 Trace 面板从 Runtime Host 读取特定 Session 的投影，包括用量、上下文
构成和轮次时间线，没有提供替代的数据库路径按钮。删除提交能证明具体改动，
但没有说明取消路径访问入口的更广泛产品理由。

## 保存可读的对话文本

1. 选中出问题的任务。长对话应先加载需要的较早消息：导出使用当前界面已加载
   的消息，不会查询完整的持久化记录。
2. 按 **Cmd+K**（macOS）或 **Ctrl+K**（Windows/Linux）打开命令面板。
3. 选择**保存当前任务为 .md 文件**，在系统保存对话框中选择位置，再将保存的
   文件交给排障助手。也可以选择**导出当前任务为 Markdown**，将相同内容
   复制到剪贴板。

Markdown 包含用户消息、助手回答，以及工具名称和调用意图；不包含思考内容、
原始工具结果、token 用量记录和权限决定。因此，它适合帮助理解对话经过，
但不是完整执行轨迹。用户文字按输入内容保留，助手文字和工具意图会经过
密钥脱敏。分享前应检查选定内容。

## 为失败操作复制诊断信息

保持问题任务打开，在命令面板选择**复制诊断信息**。快捷键为
**Cmd+Shift+D**（macOS）或 **Ctrl+Shift+D**（Windows/Linux）。报告会写入
剪贴板，可粘贴到文本文件或问题报告中。一般应用问题也可以使用
**设置 → 关于 → 复制诊断信息**。

报告包含 Desktop 环境、最近的主进程日志，以及可获取的 Runtime Host
诊断信息。针对任务收集时，会解析该任务所属的 Host；Host 不可用时会如实
报告。报告会进行密钥脱敏，并缩短用户主目录路径，但不包含完整对话。
提交材料时，请同时写明失败操作、发生的大致时间，并附上 Trace 面板中相关
错误或截图。

## 需要更多状态时导出可迁移的 Session

包含 [#5197](https://github.com/apache/maka/pull/5197)（2026 年 9 月 12 日
合并）的构建，还为 **Local** Host 提供
**设置 → 导入/导出任务 → 导出任务**。选择任务，导出 `.maka-session` 文件。
应先等待任务及其子 Agent 停止运行；如果出现确认框，确认一并导出的子 Agent
对话。远程 Host 不显示这个 Desktop 导出入口。

导出包包含选定的 Session、其子 Agent 子树，以及引用的产物和上下文卸载数据；
不包含连接凭据和用户项目目录。它还会有意省略 provider 请求捕获、model-call
attempt 和 stream 诊断等事件，因此不能替代诊断报告。对话和产物内容仍可能
包含隐私信息。

`.maka-session` 用于导入兼容的 Maka 安装，不是可直接阅读的文本文件。
如果助手只需要阅读对话，应使用 Markdown。旧版本没有导出页面时，可以使用
该版本已有的 Markdown 和诊断命令。

## 实现依据

- [当前 Trace 面板](../apps/desktop/src/renderer/features/workbar/tools/inspector/session-inspector-panel.tsx)
- [命令操作与已加载消息导出](../apps/desktop/src/renderer/app-shell-command-actions.ts)
- [Markdown 字段与脱敏](../apps/desktop/src/renderer/conversation-markdown.ts)
- [诊断收集与格式化](../apps/desktop/src/main/main-process-diagnostics.ts)
- [Local Session 导出界面](../apps/desktop/src/renderer/features/session-bundle/session-bundle-tasks.tsx)
- [导出包契约](../packages/runtime/src/session-export.ts)及[省略的诊断事件](../packages/storage/src/session-bundle-policy.ts)
