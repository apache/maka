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

- [`contract`](src/contract.rs)：严格的 `maka.eval.v1` 实验与结果投影契约、原生的 `maka.eval.v2` 正交尝试维度、仅记录运行条件的 `RunFingerprint` 及语义差异注册表。
- [`measurement`](src/measurement.rs)：精确的 6 计数器 Token 核算（保留 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`、`totalTokens`，不重算求和）、`MeteringState` / `TokenBasis` 语义及标准 `DEEPSEEK_V4_FLASH_COST` 计价。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
