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

# 暂缓的 Goal 等待接入

[English](./goal-wait-deferred-integrations-2026-10-24.en.md)

日期：2026-10-24。本文记录 `codex/goal-host-observation` 在 `5d046a81` 之后移除的两项原型，说明其功能和有条件的引入必要性，不代表交付承诺。当前契约见 [Goal 事件等待消费者](../goal-event-wait-consumers.zh-CN.md)。

## 范围决定

本次保留普通 in-turn `WaitForEvent`、内置 AI SDK 直接工具及 Code Mode、自然 Goal waiting 和已有 ShellRun 来源。计算机观测与 ACP Host 工具桥作为独立扩展移除，连同其专属协议字段、持久化分支及测试一并清除；既有计算机工具与 ACP 执行能力保持 main 中的行为。

| 接入 | 职责 | 与哪些功能独立 |
| --- | --- | --- |
| 计算机文字观测 | 观察指定应用窗口中文字出现或消失的来源适配器 | ShellRun、GitHub CI、PR/review、文件就绪来源 |
| ACP Host 工具桥 | 让外部 Agent 调用 Maka 工具的执行通道 | 一次 `WaitForEvent` 实际观察哪种来源 |

## 计算机文字观测

已有 `maka_computer` 等待支持 `wait_for_text` 和 `wait_for_text_gone`，例如等待“上传完成”出现，或等待“正在加载”消失。它检查此前观察窗口的辅助功能控件名称和值，并保留原有超时及公开结果格式。

已移除原型注册了 `computer_use` 来源及文字出现/消失条件。Host 通过既有 Desktop capability 连接调度窗口快照读取，新增 request、probe、probe-cancel、snapshot、result 五类专属消息。可信工具派发绑定关联原 Session、Turn 和窗口；工具结果附带的观测证明将消费确认关联到原持久工具结果。

该原型底层仍通过快照轮询读取；适配器声明 250ms 间隔，但实际频率受 Host 最小间隔、容量和退避策略约束。收益是统一 Host 调度、取消及资源管理，并未实现操作系统主动推送文字变化，也不能据此宣称消除了本地轮询。

当范围明确要求把既有计算机等待也纳入 Host 观测时，这项接入才有必要。它不是让显式 ShellRun `WaitForEvent` 保持原 Turn 的前置条件。移除后，既有计算机等待继续使用原循环。

将来独立实现时，需要保留窗口身份和重新观察规则、文字出现/消失及窗口丢失的结果、原期限与最后一次已接纳的本地读取、取消、系统权限及断连清理。不能直接混用 Host 与客户端时钟。可靠结果必须关联原工具操作，不能重放桌面动作。真正的本地事件订阅还需要另行设计和验证。

## ACP Host 工具桥

内置 AI SDK 后端由 Maka 直接管理模型工具目录；ACP 执行器则把工作交给外部 Agent，后者不会自动获得 Maka 内部工具。已移除工具桥向外部 Agent 提供 MCP 工具目录，并将调用转发到已有 Runtime 工具边界。

原型采用 stdio MCP 转发程序与监听 `127.0.0.1` 的本机 HTTP 服务。服务随保留的 ACP Session 存活，各次调用绑定当前 invocation，处理工具列表、目录变化、调用、取消和结果。生产目录只暴露 `WaitForEvent`，传输层本身是通用的。外部 Agent 可以借此等待 ShellRun 等已有来源；ACP 本身并不是新的外部事件来源。

当范围明确要求外部 ACP Agent 调用 Maka 的 `WaitForEvent` 时，这项桥接才有必要。内置 AI SDK 的直接工具和 Code Mode 不依赖它。移除后保留既有 ACP Session、工具和执行能力，但不向 ACP Agent 暴露 Host 事件等待工具。

将来独立实现时，需要保留原 Run/invocation 和持久派发/结果边界，妥善结束调用方放弃的调用，约束迟到回调及复用的 ACP Session，清理传输资源，并通过既有持久输入归属处理当前 Turn 的追加输入。能力协商必须允许未实现 Host 工具的执行器继续工作，包括工具目录为空的普通非 Goal Run。已移除原型曾因动态空目录而错误拒绝这类执行器；这种行为不能成为引入功能的代价。

## 保留与暂缓的边界

不为这些原型保留注册占位、未启用开关、计算机专属派发绑定/结果附带字段或仅供 ACP 使用的能力订阅。普通 `WaitForEvent` 结果及其持久消费确认仍有当前消费者，因此保留。

自然 Goal waiting 是已注册来源的消费者；子 Run 完成和当前 Turn 输入使用内部通知；Code Mode 是执行入口。这些都不是其它外部事件来源。默认生产注册只保留 ShellRun；GitHub CI、PR/review 和文件就绪仍不属于本次范围。

后续提案应明确引入的是新的可观测条件，还是新支持的执行器，并独立验证授权、生命周期及端到端接线。覆盖所有 Goal 等待属于后续范围决定，当前收敛后的提交不作此承诺。
