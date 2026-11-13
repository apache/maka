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

- [`contract`](src/contract.rs): Strict `maka.eval.v1` spec validation and cell expansion, immutable `V2AttemptRecord` with 3-gate causal adjudication (`BlockedIndeterminate` -> `RetryableInfra` -> `Selected`), leaf `v2 -> v1` projection, and spec-only `SpecFingerprint`.
- [`measurement`](src/measurement.rs): Exact 6-counter token accounting (`inputTokens` normalized inclusive of cache reads/writes; `totalTokens` preserved without summation) and `PricingRates` (`DEEPSEEK_V4_FLASH_COST`) as the sole USD pricing authority.

## Adjudicated `v2 -> v1` Rules

| Scenario | `v2` Disposition | `v1` Projection & Selection |
| --- | --- | --- |
| Timeout + reward + `LowerBound` | `Selected(SubjectFailed)` | `subject_failed`, raw `score`, `costUsd: null`; selected & never resampled |
| Audit truncated / policy error | `Selected(Completed)` | `completed` with `egress-audit` metadata (`bytes`, `sha256`, `malformedLineCount`) |
| Missing audit / critical artifacts | `RetryableInfra` (unless Gate 1 indeterminate) | `infra_failed`, `score: null` (stricter than legacy TS when score existed) |
| Late cancellation | Before verify: `BlockedIndeterminate`; After: `Selected` | `indeterminate` (`score: null`) vs preserved score + marker |
| Post-hoc evidence recovery | `PostHocRecovery` appended monotonically | Derived view updates status/usage/cost without mutating the base attempt |

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
