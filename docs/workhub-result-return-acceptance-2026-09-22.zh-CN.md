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

# WorkHub 结果回包：真实模型验收 — 2026-09-22

分支：`feat/workhub-result-return`。以下记录包含首次验收及后续修复后的录屏验收。

## 测试方式

使用构建后的真实 Electron、preload、Main、Runtime Host 和现有 DeepSeek 连接。
模型 ID 为 `deepseek-v4-flash`，本机模型目录标注为 DeepSeek V4.1 Flash；目标任务使用 `high`。
没有启用 `MAKA_E2E`，没有注入 FakeBackend、路由决定或模型响应。
使用既有真实模型隔离开关 `MAKA_CU_REAL_MODEL_E2E`，仅用于独立 profile 和限制无关的电脑控制能力。
测试驱动通过真实 preload 接口发送 WorkHub 用户请求、读取记录和提交测试用户答案。

隔离数据：`/private/tmp/maka-workhub-result-real-20260922-r2`。
只复制现有模型连接配置；任务、工作目录和 Session 全部新建。
验收结束后已关闭测试应用并清理临时 profile 及复制的凭据，保留消息记录、模型调用证据与实际文件产物。

## 验收结果

| 场景 | 结果 | 直接证据 |
| --- | --- | --- |
| WorkHub 派发给已有任务，任务完成后自动回包 | 通过 | 真实任务读取 CSV 并写入 `completion/report.json`，独立读取文件确认 `paid_count=3`、`paid_total=40` |
| 回包唤醒模型并读取完整结果 | 通过 | 新的 `workhub_result` Turn 自动调用 `WorkHubResult.read`，成功持久化工具结果并用中文汇报数值与文件路径；没有第二条用户消息 |
| 任务中的待答问题转交 WorkHub | 通过 | 目标任务调用 `AskUserQuestion`，Host 自动唤醒 WorkHub；模型调用 `WorkHubResult.ask_question`，两端问题及选项完全一致 |
| WorkHub 用户答案恢复原任务 | 通过 | 测试驱动只回答 WorkHub 的问题“详细”，没有直接回答目标任务；原任务继续执行并生成 `question/choice.json`，内容为 `{"format":"详细"}` |
| 恢复后的最终结果再次自动回包 | 通过 | 新的 `workhub_result` Turn 读取结果并汇报“详细”及文件位置；两端无残留待答交互 |
| Desktop 与 Host 重启后去重 | 通过 | 确认旧 Host 已退出、新 Host 进程已启动；Turn、消息数不变，模型调用记录仍为 19 次 |

本轮只发送 **2 条用户任务请求**，产生 **3 次自动结果通知**：订单任务完成、问题待答、回答后完成。
最终 **5 个 WorkHub Turn + 2 个目标 Turn 全部 completed**，工具错误为 0。
持久化 usage ledger 记录 **19 次真实主模型调用，全部 completed**；不是将工具调用数当成模型调用数。

订单回包的 Turn：`whf_2f5c0afa147718fed88a85a7e37b62a97822fcd1dcc097c9`。
问题转交 Turn：`whf_28f8cd87205ad1188b61ff20796f05ddbce0ba77ccf811a9`。
回答后完成 Turn：`whf_19b6d16ff8029e08866a7c23a7f9b221ab3a61a77758ddb7`。

## 实测发现并修复的问题

首次实测使用另一个隔离 profile，不能算通过：目标文件和自动通知虽已产生，
但模型主动读取完成结果时，返回对象含有 `details: undefined`，被 RuntimeEvent 的无损 JSON 持久化检查拒绝，导致当前 WorkHub Turn 失败。
修复为明确的 JSON 值，并增加 completed、failed、cancelled 三种结果的 JSON 无损往返回归测试。

同时首次模型在派发后反复调用工具等待。现明确说明异步通知契约：派发后确认并结束当前回复，
等待 Host 唤醒；提前读取结果返回正常的 `pending`，而不是误报“委派无效”。
修复后在新的干净 profile 完整重跑上述两条链路，派发轮只执行候选发现及一次派发，没有轮询。

## 本地证据

隔离验收目录保留以下文件，未将凭据写入报告：

- `completion-snapshot.json`：订单派发、目标执行和自动回包的完整消息记录。
- `question-pending-snapshot.json`、`answer-evidence.json`：两端原始问题一致、回答前未生成文件，以及仅在 WorkHub 回答的证据。
- `final-snapshot.json`：两条链路最终 Turn、工具调用、模型回复与交互状态。
- `model-calls-summary.json`：真实模型调用状态汇总。
- `restart-snapshot.json`、`restart-evidence.json`：新 Host 进程及重启去重结果。
- `completion/report.json`、`question/choice.json`：独立检查的实际产物。

修复后相关工具/序列化测试 27 项通过，WorkHub 生产装配回归 12 项通过；整仓类型检查通过。
这是两条功能链路的真实模型验收，不代表完成所有取消、权限、模型中断或跨 Host 场景的真实模型压力测试。

## 2026-09-23 修复后桌面录屏

[观看 WorkHub 真实桌面回包录屏](images/pr/workhub-result-return/return-demo.mp4)。视频时长 25.44 秒，由 Playwright 直接录制实际 Electron WorkHub 窗口；未用静态组件渲染代替运行界面。测试使用独立 profile、现有 DeepSeek V4.1 Flash 连接和真实模型响应，`MAKA_E2E` 未启用。

在 WorkHub 界面发送一条订单汇总委派请求。目标任务实际读取 `orders.csv` 并写出 `report.json`；独立读取文件确认 `paid_count=3`、`paid_total=40`。WorkHub 先说明任务仍在运行，随后自动出现“任务结果更新”并通过 `WorkHubResult` 读取结果；没有发送第二条用户消息。自动回包 Turn `whf_e2f97ba9fc98a917222f92a0e01a6b415335d8379ab7236c` 为 completed。

本次还增加了执行前取消、已送达结果避免重复读取完整记录，以及原任务问题被直接回答后关闭 WorkHub 复制问题的回归测试。录屏展示正常完成路径；这三个边界条件由代码及自动化测试验收，没有声称在这段视频里触发。
