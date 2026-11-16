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

Minimal Harbor evaluation runner for native Maka Host inside Docker containers.

[Source](src/main.rs) · [Cargo manifest](Cargo.toml)

## Overview

- **`maka-eval run`** ([`harbor.rs`](src/harbor.rs)): Materializes the embedded [`MakaHostAgent`](harbor/maka_host_agent.py) plugin and Harbor job configuration into `--out`, mounts a Linux target binary bundle (`maka`, `maka-python-worker`, `maka-eval`) read-only at `/opt/maka-agent`, executes the container trial via `harbor run`, always writes a concise `run-summary.json` indexing `guest-result.json`, `transcript.json`, and Harbor `result.json`, and validates trial evidence completeness through `validate_trial_evidence`.
- **`maka-eval guest-run`** ([`guest.rs`](src/guest.rs)): Invoked inside the Harbor container by [`MakaHostAgent`](harbor/maka_host_agent.py). It bootstraps an isolated State Root with `maka host init --settings-stdin` (`chatDefaults.sandboxMode`, `projectDirectoryRoots`, model connection, and default target), spawns `maka host serve --root`, drives the session directly through `HostClient` and `maka-app-client` (without ACP or an external HTTP proxy), waits for terminal `agent.execution` state, settles whole-root `settings.usageSummary` across the main session and any delegated subagents, collects all `settings.usage` attempt pages on the same `through` fence into `guest-result.json`, and exports paginated `agent.history` to `transcript.json`.

## Execution vs. Verifier Boundary

`GuestRunResult` separates infrastructure failures (`infraFailed`) from subject capability/policy stops (`subjectStopped`) and normal completion (`completed`). Unless `infraFailed` occurs, Harbor continues into Verifier scoring (`ctrf.json` / `reward`), and `validate_trial_evidence` accepts any finite Verifier `reward` provided no Harbor/Guest exception occurred, `transcript.json` was exported, completed runs left zero pending Host calls, and every successful model attempt reported complete input/output token counts. `completed` preserves the running Host and State Root across Verifier grading so background services survive until Harbor finalization tears down the trial environment, whereas `subjectStopped` and `infraFailed` retire the Host and remove the State Root immediately.
