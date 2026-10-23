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

# Goal 事件等待消费者

[English](./goal-event-wait-consumers.md)

Host 观测将来源事实与消费方式分离。持久等待记录不是新的执行所有者，也不授予重放工具的权限。模型消息、工具结果与终止事实仍以 Runtime Event Log 为权威。

## 消费边界

| 消费者 | 登记依据 | 结果消费 | 控制与恢复 |
| --- | --- | --- | --- |
| v2 `tool_invocation` | 已接纳的 Run/invocation 和已提交的 T1 工具派发；Host 绑定 operation 与 tool-call ID | 原操作中的一条 T2 结果，随后确认消费；确认可重建 | 不 yield Turn、不建立 Goal gate、不创建后继；沿用 Run 取消与 Runtime 恢复 |
| v2 `goal_waiting` | 自然结束的 Turn、评估 checkpoint、Goal 身份与控制代际 | 原有 pending Goal continuation，由 Root 接纳原子确认 | 沿用 Goal 控制与替换规则，只替换等待定时器 |

新显式等待保留 `sessionId`、`turnId`、`runId`、`invocationId`、`operationId` 和 `toolCallId`。它不结束 Turn，不释放 Root 执行位置，不插入用户消息，不运行 Goal evaluator，不重置 maxSteps，不返还迭代，也不豁免实际 token 用量。原 Turn 在真正结束时结算一次。多个等待具有独立身份，可以并存或连续执行。

Host 将 Goal 等待能力绑定到具体已接纳 Run。随后暂停、清除或替换 Goal，不会停止该 Run 或撤销其普通工具能力。其他 Run 不继承此能力。普通 Session 在未来明确开放前保持原行为。

自然等待先结算已经结束的 Turn，并持久保存 waiting outbox，再开始来源准备。来源暂时不可用不能继续占用原 Turn 的 Root 接纳位置。outbox 在登记前保存精确的结构化条件；恢复复用已提交的条件。新的真实 Turn 或 Goal 控制变更会替换待完成的准备。

## 来源观测与期限

所有受支持消费者共用观测器的来源并发、派发预留、Retry-After 和 cooldown authority。通知只触发权威重读，不能直接授权或完成等待。没有通知的来源使用受控 Host 轮询；订阅容量不足时仍通过协调读取推进。

v2 使用可空的绝对 deadline。`null` 不增加等待专属期限，已有执行限制仍有效。显式绝对期限贯穿登记、重试、steering 后重新等待和恢复，不会重置。恢复被中断的等待时，将返回的 `waitId` 作为 `resumeWaitId`；相同条件的并行等待必须指定该身份，确保各自期限不会混用。滚动观测 checkpoint 限制计数器大小，不将内部尝试次数或七天调度限制变成新的业务失败。中立的 v1 观测契约仍用于 Assistant Matter 等现有非 Goal 消费者，不携带 Goal lease 或 Goal continuation delivery 状态。

本次使用已有的[受管 ShellRun 来源](../packages/runtime/README.md#explicit-event-waits)。观测和交付重验共用 Host 资源边界，并验证可信 Run provenance。GitHub CI、GitHub PR/review 和文件就绪属于独立来源功能，不包含在本次提交中。

计算机文字观测和 ACP Host 工具桥不属于本次范围。计算机工具保留既有本地等待行为，ACP 执行器保留既有工具集合。已移除原型的功能及适合独立引入的条件记录在[接入范围记录](./archive/goal-wait-deferred-integrations-2026-10-24.zh-CN.md)。Runtime 子任务 join 订阅原 Run 的完成权威，替换重复读取，不建立新的任务生命周期。

## 输入与取消

`current_turn` 输入中断活动工具等待，并进入既有持久 steering 边界；通知方不取走或确认输入。`next_turn` 继续排队。Code Mode 收到可信中断后停止新嵌套派发，已派发工作仍需完成清理。显式 Host 等待通过内置 AI SDK 后端的直接工具和 Code Mode 使用；本次不向 ACP 执行器开放。

Stop 取消 Run。取消单个工具等待只向该操作返回普通取消结果，不暂停 Goal，也不停止后台进程。自然 Goal waiting 的取消使用 Goal 控制代际和 revision，保留既有 Goal 语义。UI 与 CLI 在 Session 层独立展示等待，清除 Goal 不会隐藏已接纳的活动工具。

`session.event-waits.query` 按有界页面返回等待。`session.event-wait.cancel` 校验精确消费者身份：工具等待使用 Run/invocation/operation，自然等待使用 Goal/代际/revision。过时控制不能取消替换后的消费者。PR3 的 Goal 专属取消协议和投影一并删除。

`event_wait` Session domain 通知覆盖分页集合任意位置的变化，包括注册和持久消费/退役。客户端收到通知或恢复订阅后重新读取有界分页；continuity 首页相同不代表整个集合未变化。通知只用于刷新，不能作为消费证据。CLI 状态查询读取全部分页。continuity 等待预览是可选缓存；组合快照超过字节预算时省略预览，已接纳队列、交互和 Root/Goal 事实仍遵守原有容量检查。预览缺失不代表没有等待；完整分页查询和失效通知仍可用。

## 持久完成与恢复

登记校验原已提交 T1 和受支持参数。来源结果先持久化再交付；异步检查后重验来源权限与当前记录。Runtime 提交一条普通 T2，只有该精确结果能够证明消费。

消费确认在 T2 后执行，不阻塞模型循环。确认失败或通知丢失时，有界 Host 扫描从原持久结果重建确认。错误 T2 退役消费者。若 Runtime 恢复结束原 invocation 而没有结果，其终止事实允许退役；等待记录自身不会重放工具或创建 Goal Turn。跨重启执行保证沿用 Runtime 恢复契约。

PR3 的 Goal-yield 记录、gate、continuation 和恢复链全部删除，不提供迁移或兼容回退。中立观测记录与两类新消费者继续严格解码。Memory 与 SQLite 独立实现同一消费契约。跨根 Session 复制排除等待权威；同根备份保存持久事实，但不授权重复观测或交付。归档和删除清理保留的观测与消费者。
