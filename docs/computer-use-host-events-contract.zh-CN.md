---
doc_id: computer-use-host-events-contract
title: "Computer Use 宿主事件契约"
language: zh-CN
source_language: en
counterpart: ./computer-use-host-events-contract.md
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

# Computer Use 宿主事件契约

[English](./computer-use-host-events-contract.md)

本层只接通具备类型化、可归属来源的事件。

## 已接通的生产者

- 类型化 dispatch 结果：
  - `user_intervened` -> re-observe
  - `screen_locked` -> locked
  - `blocked_url` -> 终态 URL 拦截
  - `outcome_unknown`、服务不可用或服务不匹配 -> re-observe
- Executor 服务释放：
  - 清理 executor 本地的 observation 与 keyboard ownership
  - 把对应的 Runtime 会话推进到 re-observe
- Turn/会话终止事件：
  - 同步清理 Runtime、executor 与 overlay 的所有权

## 有意保留的缺口

- Maka 不会从 AX 或 DOM 的内容变化推断物理用户输入。
- 在拥有可靠、可归属的 macOS 事件源之前，Maka 不声称存在全局物理输入生产者。
- Maka 不会调用 Codex 签名的 `turn-ended` helper。该 helper 使用 Codex 原生服务特有的
  Apple Event 生命周期，而 helper 进程退出并不能证明服务清理已经完成。
- Runtime 的 URL、锁定与介入状态要求类型化的 driver 结果；原始错误信息匹配不是被认可的
  生产者。
- 当前 driver 不暴露任何可信的介入 debounce 截止时间，因此类型化的介入会直接推进到
  re-observe。两阶段 debounce 状态仍预留给未来可归属的截止时间生产者。
- Maka 目前按 PID/window/content/page identity 绑定目标。V10 逆向得出的边界更强：
  canonical app 路径加上当前存活的进程实例。在 executor 或原生宿主 API 能提供原子、
  高精度的进程标识之前，Maka 不声称具备该边界。

## 验证

跨层确定性 harness 覆盖以下内容：

- 已绑定目标的传播；
- observation 绑定的 presentation 与 dispatch；
- 动作后的全新 observation；
- 重复与过期结果的拒绝；
- 类型化目标变更的取消；
- 未知结果需要重新 observation；
- 显式的会话清理；
- 从持久化的 tool 文本中省略私有 UI 内容，而当前 turn 的模型投影保留执行动作所需的
  UI 证据。

目标/诱饵执行、真实进程重启、持久化层隐私、Desktop terminal 生命周期、真实 macOS 事件
产生，以及真实窗口下的 Electron 累积验证，仍然是彼此独立的发布门禁。
