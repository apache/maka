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

多臂基准评测实验的测量与控制平面（支持 `maka.eval.v1` 与 `maka.eval.v2`）。`maka-eval` 负责实验契约解析、任务组并发调度、阶段截止时间权威、持久化只追加（append-only）尝试日志、Token 与成本计量对账、Trial 环境编排及确定性对照报告生成。

## 模块结构

- [`contract`](src/contract.rs)：严格的 `maka.eval.v1` 实验与结果投影契约、原生的 `maka.eval.v2` 正交尝试维度（生命周期阶段、执行结果、计量完整性、环境清理状态）、运行指纹、产品默认运行时组合配置及语义差异注册表。
- [`measurement`](src/measurement.rs)：精确的 6 计数器 Token 核算（保留 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`、`totalTokens`，不进行重算求和）、准入截止边界、HMAC 鉴权检查点恢复、回执与代理日志去重对账及标准 `DEEPSEEK_V4_FLASH_COST` 计价。
- [`store`](src/store.rs)：单写者只追加实验日志（`LaunchIntent`、`ResourceTagged`、`Checkpoint`、`Settled`、`PostHocRecovery`）、派发前意图落盘、原子结算提交、关键产物校验与确定性状态重建。
- [`runner`](src/runner.rs)：任务组并发准入（`maxConcurrentTaskGroups`）、共享预备缓存边界锁、分阶段截止时间控制、有界重试策略、最早有效尝试（`sequence >= 1`）规范结果选择及崩溃恢复。
- [`environment`](src/environment.rs)：单次尝试级 `TrialEnvironment` 抽象及版本锁定的 Harbor / Pier 桥接（1:1 尝试与 Trial 映射）。
- [`subject`](src/subject.rs)：被测系统适配器，包含 Rust Maka Host 适配器（通过 `maka host init --settings-stdin --root <ROOT_DIR>` 引导隔离的 Host Root、公共 Host 客户端执行、持久化回执日志与历史/用量结算）和外部 CLI 适配器（`exit-code` 与 `protocol-v1` 有界结果帧）。
- [`report`](src/report.rs)：从日志确定性重建 `v1` 与 `v2` 结果、生成成对队列汇总报告及三项裁决差分对比报告（`v1_parses`、`v1_matches_oracle`、`conditions_comparable`）。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
