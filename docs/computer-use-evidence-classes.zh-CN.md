---
doc_id: computer-use-evidence-classes
title: "Computer Use 证据类别"
language: zh-CN
source_language: en
counterpart: ./computer-use-evidence-classes.md
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

# Computer Use 证据类别

[English](./computer-use-evidence-classes.md)

Computer Use 报告使用四种证据类别中的一种。类别属于资格验证边界的一部分，
并不是描述性文案。

## real-runtime

真实 provider 使用了生产 Runtime、Computer Use 工具、自有 fixture 与 executor 路径。
provider 资格验证还额外要求：

- `complete/end_turn`；
- 强制执行或显式上报的 policy provenance；
- 精确的 provider、model、producer 与 live transport 身份；
- 在 dispatch 前预算内成功执行或符合场景预期的动作；
- 针对每个目标动作的 fixture 进程实例 PID/window 归属，包括重启场景中的旧实例与替换实例；
- 每个与 observation 绑定的动作的 observation 谱系；
- 当场景声明了动作序列时，该场景的精确动作序列；
- 针对变更操作的 AX 或语义 dispatch 证据；
- 通过预期状态与禁止产生的效果的断言。

证据缺失即为无效或无法定论。绝不能仅凭 fixture 状态推断得出。

## fault-injection

真实 provider 与生产 Runtime 确实运行了，但所指名的故障是由 wrapper 注入的，而不是从真实
host 边界观测到的。`intervention-recovery` 目前归入此类，因为 wrapper 会在后端与 HID-age
guard 运行之前注入 `user_intervened`。

fault-injection 报告是有用的回归证据，但无法满足 `real-runtime` 的
provider 资格验证单元格。

## hermetic-protocol

本地 protocol server 验证了 provider URL、认证、model ID、流式 tool call、tool result
重注入、错误标志以及最终语义状态。不声称使用真实 provider credential 或执行网络模型。

## static-contract

仅限源码、schema 或确定性 harness 检查。已被取代的直接真机资格验证 runner 已被移除。五轮
进程重启 runner 仍保留为不参与资格验证的 soak，其资格验证检查已迁入规范的 Runtime-backed
harness。

### Lab fixture 准备

`real-ax` 与 `restart-soak` 命令要求本地有一份
[Codex Computer Use Lab](https://github.com/hqhq1025/codex-computer-use-lab) 的检出。
请将其克隆到本仓库之外，并导出其绝对仓库根路径：

```bash
git clone https://github.com/hqhq1025/codex-computer-use-lab.git ../codex-computer-use-lab
export MAKA_CU_AX_MODEL_LAB_ROOT="$(cd ../codex-computer-use-lab && pwd)"
```

该路径必须包含 `test-app/launch.sh`。启动器会调用该脚本；当 fixture 的 application
bundle 不存在时，该脚本会构建它。

导出该变量后，运行规范 operator 命令：

```bash
npm run computer-use -- real-ax
npm run computer-use -- real-ax --scenario restart-recovery
npm run computer-use -- real-model
```

不参与资格验证的五轮重启 soak 使用同一份 fixture 检出：

```bash
npm run computer-use -- restart-soak
```
