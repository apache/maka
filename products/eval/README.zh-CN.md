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

- **`maka-eval run`**（[`harbor.rs`](src/harbor.rs)）：在 `--out` 下释放内嵌的 [`MakaHostAgent`](harbor/maka_host_agent.py) 插件与 Harbor 作业配置，将包含 `maka`、`maka-python-worker`、`maka-eval` 的 Linux 目标运行包只读挂载到容器 `/opt/maka-agent`，调用 `harbor run` 执行 Trial，始终写出顶层摘要 `run-summary.json`（记录汇总结论及 `guest-result.json`、`transcript.json`、Harbor `result.json` 路径索引），并通过 `validate_trial_evidence` 校验执行、转录与计量证据完整性。
- **`maka-eval guest-run`**（[`guest.rs`](src/guest.rs)）：由 Harbor 插件 [`MakaHostAgent`](harbor/maka_host_agent.py) 在容器内拉起，通过 `maka host init --settings-stdin` 预设 `chatDefaults.sandboxMode`、`projectDirectoryRoots`、模型连接与默认目标后启动 `maka host serve --root`，直接使用 `HostClient` 与 `maka-app-client` 驱动原生会话（不经由 ACP 或外挂 HTTP 代理），等待 `agent.execution` 终态，汇总整棵隔离 State Root（含主会话及委托子会话）的 `settings.usageSummary`，沿同一 `through` fence 翻页归集 `settings.usage` 明细写入 `guest-result.json`，并分页导出 `agent.history` 为 `transcript.json`。

## 被测停止与 Verifier 判分边界

`GuestRunResult` 将基础设施故障（`infraFailed`）与被测智能体自身停止（`subjectStopped`）及正常完成（`completed`）明确区分。非基础设施异常均继续交由 Harbor Verifier 判分（`ctrf.json` / `reward`）；`validate_trial_evidence` 在零异常、转录完整、正常完成零挂起调用且全部成功模型调用均上报完整输入/输出 token 的前提下接受任意有限数值型 `reward`。其中 `completed` 会在 Verifier 判分期间保留运行中的 Host 与 State Root，确保后台服务持续存活直至 Harbor 收尾销毁试验环境；而 `subjectStopped` 与 `infraFailed` 会立即停机 Host 并清理 State Root。
