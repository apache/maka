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

- **`maka-eval run`** ([`harbor.rs`](src/harbor.rs)): Writes a Harbor job configuration, mounts a Linux target binary bundle (`maka`, `maka-python-worker`, `maka-eval`) read-only at `/opt/maka-agent`, executes the container trial via `harbor run`, writes `run-summary.json`, and validates completeness through `validate_trial_evidence`.
- **`maka-eval guest-run`** ([`guest.rs`](src/guest.rs)): Invoked inside the Harbor container by [`MakaHostAgent`](harbor/maka_host_agent.py). It bootstraps an isolated State Root with `maka host init --settings-stdin` (`chatDefaults.sandboxMode`, `projectDirectoryRoots`, model connection, and default target), spawns `maka host serve --root`, drives the session directly through `HostClient` and `maka-app-client` (without ACP or an external HTTP proxy), waits for terminal `agent.execution` state, polls `settings.usageSummary` until `pending.models == 0 && pending.tools == 0`, collects all `settings.usage` attempt pages on the same `through` fence, and exports paginated `agent.history` to `transcript.json`.

## Execution vs. Verifier Boundary

`GuestRunResult` separates infrastructure failures (`infraFailed`) from subject capability/policy stops (`subjectStopped`) and normal completion (`completed`). Unless `infraFailed` occurs, Harbor continues into Verifier scoring (`ctrf.json` / `reward`), and `validate_trial_evidence` accepts any finite Verifier `reward` as long as no Harbor/Guest exception occurred and both transcript and settled Host usage accounting are complete.
