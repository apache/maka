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

# Assistant 插件

[English](README.md)

通过公共 Host 能力实现的原生 Assistant、Todo、Recall 和 Plan 插件。

## Plan

`maka.plan` 在插件命名空间存储中拥有提案、审批、进度和恢复策略；Host 拥有权限、
准入、规范执行及结算。后端不依赖前端 bundle，Plan UI 后置。

模型 Session 的 collaboration mode 为 `plan` 时选择 `default:plan`。工具上限只允许
检查、提问和提交提案，排除 Shell、工作区编辑及自主工作流。完全绕过时额外允许用户
明确要求的文件／Shell 副作用，但不因此自动批准实施。

- `SubmitPlan` 保存带版本的提案，在工具结果持久化后结束规划 Turn。
- 审批精确提案版本后，持久化冻结的提交和显式 Session 执行授权，不授予沙箱权限。
  执行使用已注册的 `maka.plan.execute` behavior，不修改 Session 默认模式。
- `update_plan` 报告全部步骤 ID，最多一个步骤进行中。只有全部步骤完成／跳过，
  且 Host 执行成功后，Plan 才完成；步骤完成仍是模型报告，不是独立验收。
- `cancel_plan` 持久化取消意图并结束当前 Turn；取消始终针对原操作，不停止该
  Session 后来无关的 Turn。

工具只在对应的冻结 behavior 中可见，在 Code Mode 中也必须直接调用。计划正文和进度
每逻辑模型步骤重新捕获，物理重试保持原快照。

## 后端控制

通过 `{ packageId: 'maka.plan', method: 'manage', sessionId }` 绑定独立 Remote。
Session 来自 Host 绑定，不从请求正文获取。

| 请求 | 行为 |
| --- | --- |
| `read` | 当前 revision、提案元数据、执行进度及阶段。 |
| `artifact { source, revision? }` | 完整提案或执行计划，source 为 `proposal` 或 `execution`。 |
| `history { throughRevision?, after? }` | 固定 revision 水位下的历史，每页一份摘要。 |
| `control { operationId, expectedRevision, action }` | 带修订检查的不可变决策；相同重试返回原回执。 |

action 使用 `kind` 区分：

- `approve { proposalId, proposalRevision, grant }`。
- `revise { proposalId }` 或 `abandon { proposalId }`。
- `resume { executionId, grant }`：确认中断后显式续跑。
- `cancel { executionId, reason, grant? }`。
- `reconcile { executionId, grant }`：为尚未结算的原工作更新观察／准入授权，
  包括授权撤销后的恢复。

应用通过现有 `plugin.authorization` 为此 Remote 绑定获得授权，目标必须是精确的
Session，能力包含 `executions`。读取及原回执查询仍检查当前 Session 访问权；新的
审批或授权更新检查当前 consent，已接受的旧决策不要求原后台授权继续存活。

## 终端视图

Plan 通过公共 Terminal View 契约贡献会话页面、检查器面板和状态行。提案与执行
标签展示审阅过的计划及已记录进度；历史、完整概述／风险和步骤详情读取不可变
修订。大计划通过有界详情视图完整可读，已结束工作不常驻编辑器状态行。

批准、请求修改、放弃、继续、更新授权和停止均复用其他客户端使用的 Host 控制
路径；执行权限仍需明确 consent。确认期间固定已审阅版本，实时更新等到确认关闭。
每次决策绑定稳定操作身份；即使后续状态已改变，也可只读查询原持久回执，不更新
旧授权、不重放工作。查不到回执表示尚未记录，不等于确认失败。

## 恢复与边界

先持久化派发意图，再提交 Host。重启查询原操作，重试保持原身份和冻结内容。
待取消的未知工作不会重投；回执仍未知时，Plan 保持未结算且不能被替换，但不阻止
空闲 Host 退出。

Host 执行失败／取消，或成功结束但步骤未完成，都会中断 Plan。显式恢复把已有进度
冻结进新提交，不自动重放未知副作用。封口的 Host 交接仍属于原操作，应通过公共
Session 控制恢复该 Run。插件停用停止新插件工作，Host 继续结算已接受执行；
重新启用后在当前授权下协调原回执。

计划允许 1–50 个步骤，编码后的 JSON 最多 40 KiB；进度最多 12 KiB。Remote 摘要
省略授权引用和重复的冻结提交正文，计划正文另行获取，保持在 64 KiB Remote 上限内。

领域测试覆盖真实 SQLite 持久化、精确重试和过期身份；Host 集成测试覆盖规划限制、
审批、结算、停用、重启、授权撤销／更新、显式恢复和不重放的取消。
