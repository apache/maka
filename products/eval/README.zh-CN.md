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

多臂基准评测实验的测量与控制平面契约底座（支持 `maka.eval.v1` 与 `maka.eval.v2`）。

## 模块结构

- [`contract`](src/contract.rs)：严格的 `maka.eval.v1` 实验规格校验与单元展开、不可变 `V2AttemptRecord` 及三关因果裁定（`BlockedIndeterminate` -> `RetryableInfra` -> `Selected`）、末端只读 `v2 -> v1` 投影，以及仅覆盖声明规格的 `SpecFingerprint`。
- [`measurement`](src/measurement.rs)：精确的 6 计数器 Token 核算（`inputTokens` 归一化后包含读写缓存；`totalTokens` 原样保留不重算求和），并以 `PricingRates`（`DEEPSEEK_V4_FLASH_COST`）作为唯一 USD 计价权威。

## 已裁定 `v2 -> v1` 语义规则

| 场景 | `v2` 裁定 | `v1` 投影与选样 |
| --- | --- | --- |
| 超时 + 有 reward + `LowerBound` | `Selected(SubjectFailed)` | `subject_failed`、保留 `score`、`costUsd: null`；直接入选且不重跑 |
| 审计日志截断 / 策略错误 | `Selected(Completed)` | `completed` 并输出完整 `egress-audit` 产物（含 `bytes`、`sha256`、`malformedLineCount`） |
| 缺失审计日志 / 关键产物 | `RetryableInfra`（若已被第一关判未决则保持未决） | `infra_failed`、`score: null`（比旧版 TS 保留分数更严格） |
| 迟到取消 | 验证前 `BlockedIndeterminate`；验证后 `Selected` | `indeterminate`（`score: null`）vs 保留分数并附加标记 |
| 事后证据恢复 | 通过 `PostHocRecovery` 单调叠加 | 派生视图更新状态与计量，不原地改写原始 attempt |

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
