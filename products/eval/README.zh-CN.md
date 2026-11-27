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

- **`maka-eval run`**（[`src/harbor.rs`](src/harbor.rs)）— 将内嵌的 [`MakaHostAgent`](harbor/maka_host_agent.py) 适配器与任务配置写入 `--out`，把 Linux 原生二进制包（`maka`、`maka-python-worker`、`maka-eval`）只读挂载到容器 `/opt/maka-agent` 后拉起 `harbor run`（支持 `--thinking-level`、默认不限步的 `--max-steps`、默认跟随 `task.toml` `[agent].timeout_sec` 并额外预留收尾宽限的 `--timeout-ms`，以及只接收宿主环境变量引用 `KEY` 或 `KEY=${HOST_VAR}`、拒收字面值并透传给 Harbor `--verifier-env` 以防落盘泄露的 `--verifier-env`），在 `guest-run` 非零退出或容器 exec/upload 失败时抛出 `MakaInfraError` 阻止进入 Verifier 判分，在 `run()` 中与 `run-summary.json` 共同消费 `guest-result.json` 里的单源 Rust 结算结果并回填 Harbor `AgentContext`，最后校验评测证据完整性。
- **`maka-eval batch`**（[`src/batch.rs`](src/batch.rs)）— 按 `--concurrency` 并发调度 `(task × repeat × subject)` 矩阵，通过 `--task` / `--tasks-dir` 以及单配置 CLI 参数或 `--subjects-file` JSON 数组声明被测对象。每格复用 `run_trial` 遵循题目原生预算并将日志与产物保存在 `cells/<task>/<subject>/r<repeat>/`，原子写入 `plan.json` 与每格 `cell.json`；支持 `--resume`（仅补未完成格）与 `--retry-infra`（仅补跑 `pending` 与 `infra_failed` 格，绝不重抽已 `scored` 格），最终原子输出 `summary.json` 及多 subject 时的 `paired.csv`；存在 `infra_failed` 或 `pending` 时仍写出完整报告但返回非零退出码。
- **`maka-eval guest-run`**（[`src/guest.rs`](src/guest.rs)）— 在评测容器内部执行：通过 `maka host init --settings-stdin` 初始化独立 State Root，拉起 `maka host serve --root`，直接经由 `HostClient` / `maka-app-client` 驱动会话跑完任务，在同一 `through` 水位线下汇总主会话及全部子会话的 Token 用量写入 `guest-result.json`，并导出完整对话记录到 `transcript.json`。

## 结果分类与生命周期

`GuestRunResult` 区分基础设施与计量故障（`infraFailed`）、被测 Agent 策略/能力终止（`subjectStopped`）与正常完结（`completed`）。`infraFailed` 会保留已采到的原始证据，并通过 `override_error_policy` 同时阻止 `MakaInfraError` 与外层 `AgentTimeoutError` 进入 Verifier 判分；其余状态继续执行 Verifier 判分，其中 `completed` 在判分阶段保持 Host 与后台服务存活，直到容器销毁时一并回收。
