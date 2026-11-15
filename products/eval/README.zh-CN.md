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

面向 Harbor Docker 容器的原生 Maka Host 最小端到端评测运行器。

[源码](src/main.rs) · [Cargo 配置](Cargo.toml)

## 职责说明

- **`maka-eval run`**（[`harbor.rs`](src/harbor.rs)）：生成 Harbor 作业配置，将包含 `maka`、`maka-python-worker`、`maka-eval` 的 Linux 目标运行包只读挂载到容器 `/opt/maka-agent`，调用 `harbor run` 执行 Trial，写出 `run-summary.json`，并通过 `validate_trial_evidence` 校验执行、转录与计量证据完整性。
- **`maka-eval guest-run`**（[`guest.rs`](src/guest.rs)）：由 Harbor 插件 [`MakaHostAgent`](harbor/maka_host_agent.py) 在容器内拉起，通过 `maka host init --settings-stdin` 预设 `chatDefaults.sandboxMode`、`projectDirectoryRoots`、模型连接与默认目标后启动 `maka host serve --root`，直接使用 `HostClient` 与 `maka-app-client` 驱动原生会话（不经由 ACP 或外挂 HTTP 代理），等待 `agent.execution` 终态，轮询 `settings.usageSummary` 至 `pending.models == 0`，沿同一 `through` fence 翻页汇总 `settings.usage` 明细，并分页导出 `agent.history` 为 `transcript.json`。

## 被测停止与 Verifier 判分边界

`GuestRunStatus` 将基础设施故障（`infraFailed`）与被测智能体自身停止（`subjectStopped`）及正常完成（`completed`）明确区分。非基础设施异常均继续交由 Harbor Verifier 判分（`ctrf.json` / `reward`）；`validate_trial_evidence` 在零异常、转录完整且 Host 账本已结清的前提下接受任意有限数值型 `reward`。
