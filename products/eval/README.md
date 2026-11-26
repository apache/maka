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

`maka-eval` runs containerized [Harbor](https://github.com/laude-institute/harbor) benchmark trials against the native Maka Host inside Docker.

## Subcommands

- **`maka-eval run`** ([`src/harbor.rs`](src/harbor.rs)) — Writes the embedded [`MakaHostAgent`](harbor/maka_host_agent.py) adapter and Harbor job config into `--out`, bind-mounts a Linux binary bundle (`maka`, `maka-python-worker`, `maka-eval`) read-only at `/opt/maka-agent`, invokes `harbor run` (forwarding optional `--thinking-level`, `--max-steps` defaulting to unlimited, `--timeout-ms` defaulting to `task.toml` `[agent].timeout_sec` with separate teardown grace, and `--verifier-env KEY[=${HOST_VAR}]` accepting host env references only so secrets are never written to Harbor artifacts), raises `MakaInfraError` on non-zero `guest-run` exit or container exec/upload failures to block verifier grading, populates `AgentContext` during `run()` from the single-source Rust settlement in `guest-result.json`, writes `run-summary.json` (`metering`: `complete` or `lower_bound` on evidenced trials, plus paths to `guest-result.json`, `transcript.json`, and Harbor's `result.json`), and validates trial evidence completeness.
- **`maka-eval batch`** ([`src/batch.rs`](src/batch.rs)) — Runs a `(task × repeat × subject)` matrix concurrently (`--concurrency`) from `--task` / `--tasks-dir` using either single-subject CLI flags (`--bundle-dir`, `--provider`, `--model`, `--api-key-env`, `--base-url`, `--thinking-level`, `--sandbox-mode`, `--max-steps`, `--timeout-ms`) or a `--subjects-file` JSON array, plus `--repeats` and `--verifier-env`. Each cell runs through `run_trial` (honoring task-native `task.toml` timeouts and writing logs under `cells/<task>/<subject>/r<repeat>/`), atomically commits `plan.json` and per-cell `cell.json`, supports `--resume` (pending cells only) and `--retry-infra` (pending + `infra_failed` cells, never resampling `scored` cells), and exports `summary.json` and (for 2+ subjects) `paired.csv`. Exits non-zero if any cell is `infra_failed` or `pending` while still persisting complete reports.
- **`maka-eval guest-run`** ([`src/guest.rs`](src/guest.rs)) — Executed inside the trial container. Initializes a fresh State Root (`maka host init --settings-stdin`), starts `maka host serve --root`, drives the task directly over `HostClient` / `maka-app-client`, waits for terminal `agent.execution` state, reconciles token usage across the root session and any spawned subagents into `guest-result.json`, and exports the full transcript to `transcript.json`.

## Trial settlement

`GuestRunResult` distinguishes harness/container/metering failures (`infraFailed`) from model/policy stops (`subjectStopped`) and clean finishes (`completed`). `infraFailed` still preserves any collected raw evidence while preventing Harbor verifier grading (`override_error_policy` for `MakaInfraError` and outer `AgentTimeoutError`). Unless `infraFailed` or `AgentTimeoutError` occurs, Harbor proceeds to Verifier grading (`ctrf.json` / `reward`). `completed` trials keep the Host and State Root alive through Verifier execution so background processes started by the agent remain testable until container teardown.
