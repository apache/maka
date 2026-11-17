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

# maka-eval

[English](README.md)

`maka-eval` 用于在 Docker 容器内驱动原生 Maka Host 跑 [Harbor](https://github.com/laude-institute/harbor) 基准评测。

## 子命令

- **`maka-eval run`**（[`src/harbor.rs`](src/harbor.rs)）— 将内嵌的 [`MakaHostAgent`](harbor/maka_host_agent.py) 适配器与任务配置写入 `--out`，把 Linux 原生二进制包（`maka`、`maka-python-worker`、`maka-eval`）只读挂载到容器 `/opt/maka-agent` 后拉起 `harbor run`，汇总生成 `run-summary.json`（索引 `guest-result.json`、`transcript.json` 与 Harbor `result.json`）并校验评测证据完整性。
- **`maka-eval guest-run`**（[`src/guest.rs`](src/guest.rs)）— 在评测容器内部执行：通过 `maka host init --settings-stdin` 初始化独立 State Root，拉起 `maka host serve --root`，直接经由 `HostClient` / `maka-app-client` 驱动会话跑完任务，在同一 `through` 水位线下汇总主会话及全部子会话的 Token 用量写入 `guest-result.json`，并导出完整对话记录到 `transcript.json`。

## 结果分类与生命周期

`GuestRunResult` 区分基础设施故障（`infraFailed`）、被测 Agent 策略/能力终止（`subjectStopped`）与正常完结（`completed`）。除 `infraFailed` 外，Harbor 均会继续执行 Verifier 判分；其中 `completed` 状态在判分阶段保持 Host 与后台服务存活，直到容器销毁时一并回收。
