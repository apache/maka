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

# Maka TUI

[English](README.md)

Runtime Host 的终端客户端，通过 `maka tui` 启动。

侧栏按工作区组织会话，**待处理**直接筛选目录，保留当前对话。窄窗口或专注模式下，`Ctrl+B` 通过浮层打开导航，`Esc` 返回原草稿。Tab 跨过列表和字段，方向键在列表内移动；`F1` 在当前页面上打开帮助，Host 连接详情位于设置中。

- `maka-client` 负责传输和协议校验；TUI 负责呈现和输入。
- 提供商设置使用公开的描述、配置与认证契约。
- 本地状态保存草稿和恢复身份，不保存认证输入。写入结果不确定时查询事实，不自动重放。
- Fluent 文案覆盖英文、简体中文和繁体中文。
