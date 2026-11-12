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

## Native Host & Product Parity

Install matching `maka` and `maka-eval` binaries side by side inside the Trial image. Set `subject.config.makaExecutable` to the native `maka` path; `nodePath`, `shimPath`, legacy provider configuration, and benchmark-only profiles (`toolProfile`, `permissionMode: "bypass"`, `collaborationMode`, `orchestrationMode`) are rejected.

Maka subjects are configured strictly through public product interfaces (`provider`, `connectionSlug`, `connectionName`, `baseUrl`, `model`, optional `modelOverride`, `requestHeaders`, `requestBodyOverlay`, `sandboxMode`, `requestPermissions`, `thinkingLevel`, `language`, `workspaceInstructions`, and `apiKeyEnvironment`). The adapter initializes an isolated Root via `maka host init --settings-stdin`, applies only declared public Settings/Session configurations, and submits tasks through the production composer draft/receipt client without prompt injection, tool pruning, or synthetic model overrides. A non-mutating local metering gateway records provider usage while forwarding outbound JSON bodies verbatim. Pending interactive approvals or questions are never auto-bypassed in unattended runs; they settle explicitly as `unattended-interaction-blocked`, and host/environment constraints are reported as `environment-limitation`.

Product parity is a mandatory gate for `M3` acceptance and `M5` production delivery (`RunFingerprint` documents run conditions only and does not establish parity):
- `maka-eval parity <spec.json> [--subject <id>] [--out <report.json>]` runs both the normal Maka client path and the `maka-eval` entry point against a local probe under identical inputs and verifies committed `RunSpec`/`RequestSpec` facts plus wire payloads across product composition, effective instructions, tool exposure, and execution policies.
- `maka-eval report <spec.json> <dir> --milestone m3|m5 --parity-report <report.json>` enforces parity (and complete non-indeterminate settlement for `m5`).

`egressProxy` currently fails preflight because the native executor does not provision the required sidecar and mounts. Unconfirmed cleanup blocks further admission across runs until a `PostHocRecovery` entry confirms disposal. Both report versions read committed journal records; result JSON files are no longer a separate authority. Records without pricing evidence retain unknown cost.

For focused verification, build `maka-cli` first and supply its path as runtime `CARGO_BIN_EXE_maka` when running `cargo test -p maka-eval`. CI supplies and archives the native helper. The real Host and parity tests use local fake providers and no paid model calls.

## Architecture

- [`contract`](src/contract.rs): Strict `maka.eval.v1` experiment and attempt projection contracts, native `maka.eval.v2` orthogonal attempt dimensions (lifecycle phase, execution outcome, metering state, cleanup state), condition-only `RunFingerprint`, and the semantic difference registry.
- [`parity`](src/parity.rs): End-to-end Product Parity verification comparing normal Maka client execution against `maka-eval` across product composition, effective instructions, tool exposure (Code Mode, skills, schemas), and execution policies.
- [`measurement`](src/measurement.rs): Exact 6-counter token accounting (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `totalTokens` preserved without summation), non-mutating metering gateway, admission boundary cutoffs, HMAC-authenticated checkpoint recovery, receipt-vs-proxy reconciliation without double-counting, and standardized `DEEPSEEK_V4_FLASH_COST` pricing.
- [`store`](src/store.rs): Single-writer append-only experiment journal (`LaunchIntent`, `ResourceTagged`, `Checkpoint`, `Settled`, `PostHocRecovery`), pre-dispatch intent persistence, atomic settlement commits, critical artifact verification, and deterministic state reconstruction.
- [`runner`](src/runner.rs): Task-group admission (`maxConcurrentTaskGroups`), shared preparation cache boundary lock, phase-scoped deadline authority, bounded retry policy, earliest-valid-attempt canonical selection, and crash recovery.
- [`environment`](src/environment.rs): Per-attempt `TrialEnvironment` abstraction and version-pinned Harbor / Pier bridge with 1:1 attempt-to-trial mapping.
- [`subject`](src/subject.rs): Subject adapters for the Rust Maka Host (`maka host init --settings-stdin --root <ROOT_DIR>` isolated root bootstrap, public Settings/Session client execution, explicit unattended interaction & environment limitation reporting, durable receipt journal, and transcript/usage settlement) and external CLI harnesses (`exit-code` and `protocol-v1` bounded result frames).
- [`report`](src/report.rs): Deterministic journal projection to `v1` and `v2`, paired cohort summaries, `M3`/`M5` milestone parity acceptance gates, and 3-verdict differential oracle evaluation (`v1_parses`, `v1_matches_oracle`, `conditions_comparable`).

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
