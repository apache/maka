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

# Agent 执行与恢复

[English](durable-agent-execution.md)

Maka 为每次执行分配稳定的 `runId`。进程重启、观察流断开或插件重载，不等于任务失败。重新打开同一本地状态目录（State Root）后，系统会依据持久化记录、原调用回执与当前权限对未终结的原 Run 自动核对并推进。

## 执行语义与恢复边界

- **原回执核对，不换号重发**：模型流中断后不保证原地断点续接。对已准入但结果未知的工具调用或外部副作用，系统先核查原调用回执，不会更换新 ID 自动重发。若无法确认原执行结果，Run 以失败结束，并保留原操作身份和结果未知的原因。
- **业务结果与资源清理分离**：确定的执行响应既可能是业务成功，也可能是业务错误（业务错误同样可能已产生外部副作用）。结果一旦确定，不会被后续的资源清理状态改写。收到业务结果不代表底层进程或工具已物理退出；清理尚未确认也不能反证业务未执行。
- **Stop 不是回滚**：执行 Stop 会取消后续步骤并请求终止在途工作，但不会回滚已产生的外部效果。Run 进入 `cancelled` 表示逻辑取消，不代表外部进程或资源已全部退出；残留资源的清理会继续独立追踪。

## 权限、预算与执行环境约束

- **恢复不会扩大权限或预算**：恢复推进同时受“原任务开局时的权限上限”和“恢复时的当前实时权限”约束。持久化保存的审批记录或配置不等于跨重启直接生效的实时权限；权限不足时 Run 等待实时权限恢复，系统不会自动扩大权限。原任务的预算与重试约束在恢复后继续有效。普通父子会话、Goal 与 Scheduler 均遵循同一套执行恢复规则，不会因重启自动扩充预算或授权。
- **Code Mode**：系统持久保存 Cell 记录、已发布的 `SessionData` 和已发现的工具，并按原记录核对嵌套副作用；但不保存 VM 堆内存或变量执行栈，也不会通过从头重放任意 JS/Python 脚本来模拟恢复。若脚本依赖无法重建的内存状态，原副作用可核对时会将 Cell 中断报告交给模型，无法核对时结束 Run。
- **外部执行器**：仅当外部执行器提供可验证的原 job/turn 协议时，系统才按原任务身份查询或恢复；不会把新建外部任务当作原任务恢复，也不会仅凭本地 PID 消失、EOF 或超时就判定外部任务已完成。缺乏可靠恢复协议时，Run 以失败结束，保留原任务身份及诊断信息。

## 执行状态

通过 `execution` 读取原 Run 的执行回执，其中的 `state` 分为：

- `admitted` / `running`：已准入或正在执行。
- `waiting`：等待实时权限恢复、计时到期、原操作结果或具体的用户答复。只有实际待答的交互请求进入「等待你的回复」。
- `completed` / `failed` / `cancelled`：Run 已终结。

Run 失败后，原操作的结果仍可能未知，清理也可能尚未完成。Host 保留原回执，独立跟踪清理。原副作用及清理确认前，该会话的续接和新任务会被拦住。

## API 调用与续接规则

- **保留原标识，断流先查原任务**：调用一次 `send` 后，应保存执行回执中的 `runId`；若请求已排队，则保存原 `messageId`。观察流中断或结果不明时，先查询原任务状态；再次调用 `send` 会发起全新任务，而不是恢复原任务。
- **状态查询与分页观察**：
  - 向 `execution` 传入 `sessionId` 和 `runId`，读取原 Run 的最新回执。
  - 向 `work` 传入 `sessionId`、`target` 和可选的 `cursor`，观察执行进展与分页答复。`target` 为 `{kind: 'run', runId}` 或 `{kind: 'message', messageId}`。
  - `work` 答复分页游标取自返回结果中的 `answer.next`，它与状态推进水位 `execution.highWater` 用途不同，不可混用。
- **区分自动恢复与 `continueRun`**：
  - 未终结的原 Run 由系统自动核对，并按等待或阻塞原因处理，**不能**调用 `continueRun` 来恢复。
  - `continueRun` 仅适用于**已终结**的 Run，校验通过后会创建一个**新 Run**，不会重新打开旧 Run。调用前可用 `continuationAvailability` 查询是否满足继续条件；调用时需传入 `sessionId`、`sourceRunId`、`sourceHighWater`、`model` 及可选的 `thinkingLevel`，其中 `sourceHighWater` 必须使用最新 `execution` 返回的确切值。

具体字段与返回结构见[执行 API 契约](../../plugins/agent/api/src/contract/execution.rs)。
