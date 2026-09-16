---
doc_id: architecture.external-session-import-interaction
title: "外部会话导入交互"
language: zh-CN
source_language: zh-CN
counterpart: ./external-session-import-interaction.md
implementation_status: current
document_status: current
translation_status: synced
last_verified: 2026-09-16
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

[English](./external-session-import-interaction.md)

# 外部会话导入交互

## 用户契约

每次明确发起导入，都会创建一份独立的原生 Maka Session 快照；同一来源可以重复导入。成功时返回并打开本次创建的准确 Session，导入本身不会启动模型回合。Desktop 和 TUI 展示该来源当前已发布的 Maka Session 数量，并可打开其中创建时间最近的一份。

请求已发出但结果未知时，客户端明确提示结果未知，不宣称成功或失败，不打开可能属于别人的 Session，也不自动重发。用户可以查看 Maka 任务列表、打开外部 catalog 中显示的已发布副本，或明确再次导入。再次导入是新请求，可能创建另一份独立 Session。Host 正在导入的来源不能从 catalog 再发起导入；已经发布的副本仍可打开。

外部来源 catalog 与 Maka 任务列表是两个视图：前者的行代表外部会话，后者的行代表已发布任务。刚导入的一段旧对话未必排在任务列表顶部，因为任务列表依据会话活动时间排序，而不是导入时间。

## Authority 与模块边界

| 义务 | 唯一 authority | 接口与使用方 |
| --- | --- | --- |
| 来源枚举、转换、提交、暂存、恢复及同一来源正在进行的导入合并 | Runtime Host external-session coordinator 与来源 adapter | `external-session.catalog.query` 和 `external-session.import`；Desktop Main 与 TUI 使用结果 |
| 已导入数量与最近导入的 Session ID | Storage Session authority，由 Host 查询 | `lookupExternalSessionImports(adapterId, sourceSessionIds, limit)`；catalog 通过 `importState` 展示 |
| 导入结果分类 | Host 操作结果，结合客户端传输层的派发证据 | Desktop Main 将 Host 和传输结果映射为 IPC reason；TUI 读取 Host 结果或错误 |
| Desktop Session 身份与导航 | Desktop preload 与 shell | Preload 将 Host Session ID 限定在所选 Host；renderer 展示 `importState` 并请求 shell 导航 |
| TUI Session 导航 | `MakaSessionDriver` | runner 对新导入成功和已有副本都调用现有的 `switchSession(sessionId)` |
| 单次请求警告和操作菜单 | Desktop 导入页与 TUI runner | 只负责展示；客户端不向 catalog 添加 unknown 标记，也不推断某条 catalog 记录由哪次请求产生 |

Storage 统计 `externalOrigin` 与 adapter、来源 ID 匹配且仍存在的已发布 Session。已归档 Session 计入；已删除和暂存的 Session 不计入。有限的最近 ID 列表按 Maka Session 创建时间排序，也可能包含另一个客户端导入的副本。“打开最近导入的任务”只表示打开 Host 当前返回的第一个 ID，不表示打开那次结果未知请求的产物。

## 客户端流程

Desktop 保留独立的行操作：有最近 ID 时显示“打开最近导入的任务”；Host 未在导入该来源时显示“导入”或“再次导入”。当前页面观察到的单条或批量请求若结果未知，页面展示该请求的警告。页面卸载后重新挂载会重新读取 Host catalog，不恢复 unknown 锁。批量统计不会把 unknown 算成成功或确定失败。

TUI 对没有已导入副本的来源直接调用 `external-session.import`。选择有最近导入 ID 的来源时，显示操作菜单：打开最近导入的任务、在 Host 未导入该来源时再次导入，以及按 Esc 取消。打开操作使用 Host catalog 返回的 ID，不调用导入。如果打开失败，提示该 ID，用户仍可用 `/session` 查找；不会因此自动开始导入。

Host 保留现有的进行中请求合并、暂存恢复与 typed error 语义。此交互不增加协议字段、持久化客户端状态、TTL、缓存或“导入尝试到 Session”的关联。结果未知的请求可能已经创建任务，因此不能自动重试；之后用户明确点击再次导入，属于一项新的、可能创建独立任务的操作。

## 验证义务

- Host 与 Storage 测试负责已导入数量、排序、暂存排除、恢复和进行中请求合并。
- Desktop Main 测试负责 unknown 映射和 catalog 原样投影；renderer 测试负责再次导入资格、单次请求警告、批量统计以及打开 Host 给出的最近 ID。
- TUI runner 测试负责首次直接导入、打开或再次导入的选择、unknown 后由用户明确重试、Host 正在导入时禁止重入、取消和打开失败；copy 测试负责语言变量一致性。
