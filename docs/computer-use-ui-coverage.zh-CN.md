---
doc_id: computer-use-ui-coverage
title: "Computer Use 语义 UI 覆盖清单"
language: zh-CN
source_language: en
counterpart: ./computer-use-ui-coverage.md
implementation_status: current
document_status: current
translation_status: synced
last_verified: 2026-09-11
owners:
  - maka-backend
---
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

# Computer Use 语义 UI 覆盖清单

[English](./computer-use-ui-coverage.md)

状态：这是为 Maka Desktop 的 Computer Use 目标、状态、焦点、动作与效果语义
持续维护的源码与运行时清单。

本文档定义了 Computer Use 可操作性中“已覆盖”的含义。一个页面并非只要能够渲染、
或每个按钮都有非空名称就算完整。关键界面必须暴露无歧义的目标、状态、
键盘/焦点行为，以及可观测的效果。

这道门禁并不声称已经完整符合 WCAG，也不声称辅助技术行为已经完整。尤其是，
实时区域（live region）与播报（announcement）的完整性不在本文的测量范围内；
它们需要单独的无障碍测试。

## 自动化界面清单

| 界面 | 运行时状态 | 语义动作与效果 |
|---|---|---|
| Settings | 顶层导航项通过 Storybook 的 settings-pages stories 覆盖；provider list/detail/catalog/add、subagent editor、memory populated、permission diagnostics、import empty/ready、usage variants、Daily Review selector 与 narrow 状态均在 Storybook 中（Electron 端的动态枚举已由 #4803 退役） | 导航暴露 `aria-current`；聚焦的嵌套 story 会演练对话框、展开面板、选择器与编辑器 |
| Extensions | Skills empty/installed/bundled/update/disabled/narrow/inspector；MCP setup/marketplace/configured/inspector/editor/failure/narrow | 页面选择、inspector/editor 打开，以及可操作节点的身份 |
| Scheduled work | Empty/configured/long/narrow/task inspector；Daily Review loading/error/refreshing/report | 任务选择、对话框焦点、选择器状态与报告操作 |
| Conversation shell | New task、settled conversation、streaming、permission wait、native conversation、modes、context 与 inline completion | Composer 提交效果、每个任务与每个轮次独有的动作、当前区域以及 workbar 选择 |
| Workbar | Launcher plus side chat、changes、active terminal、browser chrome、files、tasks 与 trace 状态 | 选中的标签页、终端输入到达 PTY bridge、浏览器导航到达 browser bridge |
| Dialogs and overlays | Rename、scheduled-task form、Mermaid fullscreen、side-chat close、onboarding QR、WeChat QR、Runtime Host SSH 与 remote directory chooser | 对话框命名/焦点、rename 回调、关闭确认、SSH 输入、目录导航与注册 |
| Generated content | Markdown、tool output、attachments、Mermaid 与 HTML artifact iframe | 限定作用域的复制动作、全屏对话框与沙箱化 iframe 语义 |
| Embedded browser page | 运行在 loopback fixture 上的真实 `WebContentsView` | 通过生产浏览器桥执行的独立 observe -> semantic ref -> fill/click -> business-effect smoke |

Storybook 目录对其源码定义的条目是穷尽的，smoke runner 则为关键运行时边界带有一份必需的
Computer Use story manifest。Electron 端的广域路由清单（一个先动态枚举设置导航，再枚举
module、全局 overlay、会话与全部 workbar 入口的 spec）已由 #4803 退役而非迁移；保留下来的
Electron journey 只覆盖 revision、WorkHub 与草稿焦点等边界。

## AX 完成度门禁

每个被测的最终状态在以下任一情形下都判定失败：

- AX 树中暴露节点数为零，包括只包含被忽略的 Chromium source record 的树；
- 可操作节点没有名称；
- 两个 role、name 与 semantic scope 相同的可操作节点；
- 多于一个 primary `main` landmark；
- 没有名称的对话框；
- checkbox、radio、switch、menu checkbox/radio、option、tab、combobox、slider 或
  spinbutton 缺少必需的状态/值；
- 焦点位于 inert 或 `aria-hidden` 界面内；
- 可见的模态对话框未拥有焦点。

关键 story 还会额外断言动作特有的效果。（一个 Electron 变体曾先等待具有指定名称的
前一个对话框关闭，再去审计下一个；它属于已退役的 route-inventory spec；保留下来的
journey 并不包含它。）仅凭 transport 成功或一次泛化的对话框匹配，都不被接受。

重复出现的消息与回答动作使用可见文本的有界摘录，加上一个稳定、人类可读的时间戳。
不透明的 storage ID 仍属于机器数据，不会被朗读为面向用户的区分标识。

## 平台边界

- Renderer 与同进程 iframe 的语义通过 Chromium 的完整 AX 树验证。
- 嵌入式浏览器内容是独立的 `WebContentsView`；它通过其生产语义快照/动作桥验证，
  而不会被错误地宣称为 renderer 树的一部分。
- xterm 界面以 `screenReaderMode` 运行，并带有活跃的 PTY 与 SSH 输入 fixture。
- 第三方页面标记、Chromium 的 PDF 插件、原生文件对话框以及操作系统权限对话框，
  仍由其各自的平台/provider 拥有。Maka 只验证它围绕这些界面所拥有的控件，并在外部
  目标不可用或存在歧义时 fail closed。
- 原生 macOS AX 与 Windows UIA 打包应用的抽查仍是发布门禁；Linux CI 无法替代这些平台树。

## 性能契约

产品没有新增无障碍依赖、生产环境的 AX/DOM walker、全局 `MutationObserver`、定时器、
轮询循环、OCR 模型，也没有隐藏的重复 agent UI。语义名称与状态由现有的 React 渲染发出。
所有全树遍历、重复检测与清单强制都只在测试和开发者工具中运行。现有的 lazy module、
workbar 与对话框加载保持不变。
