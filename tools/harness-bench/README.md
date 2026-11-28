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

# Harness benchmark

Run coding agents against the same deterministic, loopback mock model and check the resulting workspace, session telemetry and, on the Shared MCP track, tool audit. Use Node.js 26 and a Unix environment with `ps` available.

## Build and run

```sh
cargo build -p maka-mock-ai --bin maka-mock-ai
node tools/harness-bench/run.mjs preflight
node tools/harness-bench/run.mjs preflight --harnesses ref-agent,codex-http --json
node tools/harness-bench/run.mjs run --scenario smoke-edit --harnesses ref-agent --lanes 4 --runs 2
node tools/harness-bench/run.mjs calibrate --lanes 16
node tools/harness-bench/run.mjs matrix --harnesses ref-agent,codex-http --scenarios mcp-smoke-edit
node --test tools/harness-bench/bench.test.mjs
```

The runner searches `target/release` and then `target/debug` for `maka-mock-ai`. Build with `--release` for performance comparisons. Use `--mock-bin /path/to/maka-mock-ai` for a binary under a custom Cargo target directory or to pin the exact build. Preflight reports binary paths, versions, tracks and install hints. Its version probes use temporary config and working directories.

`run` accepts a built-in scenario name or a JSON path. Each repeat runs the candidates in a rotated order with `--lanes` clients in parallel per candidate. Both `--lanes` and `--runs` default to one. Use the same scenario, lane count and profile when comparing candidates. `--latency-profile` accepts `instant` (default), `frontier` and `degraded`. `--provider-dialect` forwards the selected mock dialect, such as `standard-openai`, `deepseek-chat`, `kimi-chat`, `anthropic-messages` or `openai-responses`.

`--timeout-ms` sets a process deadline per segment and defaults to `120000`. `--sigkill-after-ms` kills the first client process group after the given delay. Add `--resume-after-kill` to launch a second client against the same workspace, isolated config and mock session. The reference agent checkpoints completed tool batches and compaction state in this mode. Other adapters relaunch their configured CLI with its existing state and may fail to recover. A kill during a tool write can leave incomplete work. A kill during a stream can produce an `abandoned_stream` watchdog violation and a nonzero exit even when the restarted client finishes the task.

`calibrate` uses `ref-agent` with `instant`, one batch and 16 lanes by default. Compare median mock union time, median outside-mock time, verified lanes per second and the before/after `/admin/metrics` snapshots across lane counts. Union time measures the overlap-adjusted mock service intervals during a session. Outside-mock time covers the rest of the registration-to-finalization window, including runner and client overhead. Process wall time uses the measured CLI segments. A warm daemon lives outside the CLI process tree. The calibration measures the local benchmark workload at the chosen lane count.

`matrix` runs all five built-ins by default. Use `--scenarios a,b` to select scenarios. It writes `matrix-report.md` with links to each exercised scenario. Unsupported tracks show `N/A`. An adapter that supports the track but fails to launch or verify is a failed result.

## Built-in scenarios

| Scenario | Track | Workload |
| --- | --- | --- |
| `smoke-edit` | Native | Read and edit a source file, then verify the change with a parallel read and grep. |
| `concurrency-fanout` | Native | Create an artifact and verify successive state transitions, with a parallel read and shell check. Increase `--lanes` to exercise fanout. |
| `long-compaction` | Native | Generate 128 KiB of tool output, hit a context limit and adopt a checkpoint before completing the edit. |
| `chaos-recovery` | Native | Recover from HTTP 429, HTTP 503 and a mid-stream disconnect, and report errors for malformed and unknown calls. |
| `mcp-smoke-edit` | Shared MCP | Perform the smoke edit over the benchmark stdio MCP tools and reconcile their audit with the workspace and mock receipts. |

## Adapters

| Adapter | Model protocol | Tracks |
| --- | --- | --- |
| `ref-agent` | Chat Completions | Native, Shared MCP |
| `maka-direct` | Chat Completions | Native, Shared MCP |
| `maka-codemode` | Chat Completions | Native |
| `claude` | Anthropic Messages | Native, Shared MCP |
| `codex-ws` | Responses WebSocket | Native, Shared MCP |
| `codex-http` | Responses HTTP | Native, Shared MCP |
| `opencode-cold` | Chat Completions | Native, Shared MCP |
| `opencode-attach` | Chat Completions | Native, Shared MCP |
| `pi` | Chat Completions | Native |
| `pi-durable` | Chat Completions | Native |
| `dim` | Chat Completions | Native, Shared MCP |
| `dsh` | Chat Completions | Native, Shared MCP |
| `zcode` | Chat Completions | Native, Shared MCP |
| `kimi-openai` | Chat Completions | Native, Shared MCP |
| `kimi-responses` | Responses HTTP | Native, Shared MCP |
| `kimi-anthropic` | Anthropic Messages | Native, Shared MCP |

Use `preflight` for installation hints and environment requirements. For either Maka adapter, use a disposable OS account or container and point `HARNESS_BENCH_MAKA_ACCOUNT_HOME` at that account's home. `MAKA_BENCH_BINARY` can select the Maka binary.

## Isolation and artifacts

Each run starts a strict scenario server on `127.0.0.1:0`. Each lane has a unique scoped model endpoint and test credential, its own fixture workspace and private HOME, XDG, config, cache and temp directories. The adapter supplies these settings to the client. Native tools operate with the OS permissions of the benchmark account. Use a disposable account or container when you need OS-level file or network isolation. The Shared MCP server restricts benchmark tools to each lane's workspace and structured commands. Warm Maka and OpenCode attach adapters start a daemon per lane so their workspaces and session routes stay independent.

Use `--output` with a new or empty directory. With no flag, the runner creates a temp directory and prints its path. The output retains the fixtures and final files, per-segment process samples and log tails, mock session exports, and MCP audit logs where applicable. `manifest.json` records candidate order and options. `results.json` contains lane outcomes and mock metrics. `report.md` summarizes comparisons and failures. Timing and RSS/CPU samples cover each CLI and its live descendants. The monitor keeps up to 256 KiB each of stdout and stderr per segment and records truncation in `lane.json`.

A successful lane has a clean CLI result, independent workspace proof and a finalized mock session with a verified final response. The runner exports telemetry before acknowledging its cursor and deleting the session. A failed lane or run error makes the command exit nonzero after writing diagnostics.
