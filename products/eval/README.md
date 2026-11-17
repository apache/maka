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

- **`maka-eval run`** ([`src/harbor.rs`](src/harbor.rs)) — Writes the embedded [`MakaHostAgent`](harbor/maka_host_agent.py) adapter and Harbor job config into `--out`, bind-mounts a Linux binary bundle (`maka`, `maka-python-worker`, `maka-eval`) read-only at `/opt/maka-agent`, invokes `harbor run` (forwarding optional `--verifier-env KEY=VALUE` to Harbor's `verifier.env`), settles whole-root Host usage and per-request `Quote` pricing into `run-summary.json` (`metering`: `complete` or `lower_bound`, `costUsd` / `meteringError`, plus paths to `guest-result.json`, `transcript.json`, and Harbor's `result.json`), and validates trial evidence completeness.
- **`maka-eval batch`** ([`src/batch.rs`](src/batch.rs)) — Expands `tasks × repetitions × subjects` from `--spec`, locks and resumes an append-only `attempts.jsonl` under `--out`, retries only `infra_failed` attempts up to `maxRetries` while keeping `completed` / `subject_failed` outcomes (and blocking `indeterminate` cells), and writes `summary.json`.
- **`maka-eval guest-run`** ([`src/guest.rs`](src/guest.rs)) — Executed inside the trial container. Initializes a fresh State Root (`maka host init --settings-stdin`), starts `maka host serve --root`, drives the task directly over `HostClient` / `maka-app-client`, waits for terminal `agent.execution` state, reconciles token usage across the root session and any spawned subagents into `guest-result.json`, and exports the full transcript to `transcript.json`.

## Trial settlement

`GuestRunResult` distinguishes harness/container failures (`infraFailed`) from model/policy stops (`subjectStopped`) and clean finishes (`completed`). Unless `infraFailed` occurs, Harbor proceeds to Verifier grading (`ctrf.json` / `reward`). `completed` trials keep the Host and State Root alive through Verifier execution so background processes started by the agent remain testable until container teardown.
