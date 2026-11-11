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

Measurement and control plane for multi-arm benchmark experiments (`maka.eval.v1` and `maka.eval.v2`). `maka-eval` owns experiment decoding, task-group scheduling, deadline authority, durable append-only attempt journaling, token/cost metering reconciliation, trial environment orchestration, and deterministic cohort reporting.

## Architecture

- [`contract`](src/contract.rs): Strict `maka.eval.v1` experiment and attempt projection contracts, native `maka.eval.v2` orthogonal attempt dimensions (lifecycle phase, execution outcome, metering state, cleanup state), run fingerprinting, product default runtime composition profile, and the semantic difference registry.
- [`measurement`](src/measurement.rs): Exact 6-counter token accounting (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `totalTokens` preserved without summation), admission boundary cutoffs, HMAC-authenticated checkpoint recovery, receipt-vs-proxy reconciliation without double-counting, and standardized `DEEPSEEK_V4_FLASH_COST` pricing.
- [`store`](src/store.rs): Single-writer append-only experiment journal (`LaunchIntent`, `ResourceTagged`, `Checkpoint`, `Settled`, `PostHocRecovery`), pre-dispatch intent persistence, atomic settlement commits, critical artifact verification, and deterministic state reconstruction.
- [`runner`](src/runner.rs): Task-group admission (`maxConcurrentTaskGroups`), shared preparation cache boundary lock, phase-scoped deadline authority, bounded retry policy, earliest-valid-attempt canonical selection, and crash recovery.
- [`environment`](src/environment.rs): Per-attempt `TrialEnvironment` abstraction and version-pinned Harbor / Pier bridge with 1:1 attempt-to-trial mapping.
- [`subject`](src/subject.rs): Subject adapters for the Rust Maka Host (`maka host init --settings-stdin --root <ROOT_DIR>` isolated root bootstrap, public Host client execution, durable receipt journal, and transcript/usage settlement) and external CLI harnesses (`exit-code` and `protocol-v1` bounded result frames).
- [`report`](src/report.rs): Deterministic journal projection to `v1` and `v2`, paired cohort summaries, and 3-verdict differential oracle evaluation (`v1_parses`, `v1_matches_oracle`, `conditions_comparable`).

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
