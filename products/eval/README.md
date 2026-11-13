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

[简体中文](README.zh-CN.md)

Measurement and control plane contracts for multi-arm benchmark experiments (`maka.eval.v1` and `maka.eval.v2`).

## Architecture

- [`contract`](src/contract.rs): Strict `maka.eval.v1` experiment and attempt projection contracts, native `maka.eval.v2` orthogonal attempt dimensions, condition-only `RunFingerprint`, and the semantic difference registry.
- [`measurement`](src/measurement.rs): Exact 6-counter token accounting (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `totalTokens` preserved without summation), `MeteringState` / `TokenBasis` semantics, and standardized `DEEPSEEK_V4_FLASH_COST` pricing.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
