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
cargo build --release -p maka-mock-ai --bin maka-mock-ai
node tools/harness-bench/run.mjs preflight
node tools/harness-bench/run.mjs preflight --harnesses ref-agent,codex-http --json
node tools/harness-bench/run.mjs run --scenario smoke-edit --harnesses ref-agent --lanes 4 --runs 2
node tools/harness-bench/run.mjs calibrate --lanes 16
node tools/harness-bench/run.mjs stress --suite deep-grind --harnesses ref-agent --turns 300 --output-bytes 65536
node tools/harness-bench/run.mjs stress --suite cliff-ramp --harnesses pi-durable-shared,opencode-serve --steps 4,8,16,32,64,128
node tools/harness-bench/run.mjs matrix --harnesses ref-agent,codex-http --scenarios mcp-smoke-edit
node --test tools/harness-bench/bench.test.mjs
```

The runner searches `target/release` and then `target/debug` for `maka-mock-ai`. Build with `--release` for performance comparisons. Use `--mock-bin /path/to/maka-mock-ai` for a binary under a custom Cargo target directory or to pin the exact build. Preflight reports binary paths, versions, tracks and install hints. Its version probes use temporary config and working directories.

`run` accepts a built-in scenario name or a JSON path. Each repeat runs the candidates in a rotated order with `--lanes` clients in parallel per candidate. Both `--lanes` and `--runs` default to one. Use the same scenario, lane count and profile when comparing candidates. `--latency-profile` accepts `instant` (default), `frontier` and `degraded`. `--provider-dialect` forwards the selected mock dialect, such as `standard-openai`, `deepseek-chat`, `kimi-chat`, `anthropic-messages` or `openai-responses`.

`--timeout-ms` sets a process deadline per segment and defaults to `120000`. `--sigkill-after-ms` kills the first client process group after the given delay. Add `--resume-after-kill` to launch a second client against the same workspace, isolated config and mock session. The reference agent checkpoints completed tool batches and compaction state in this mode. Other adapters relaunch their configured CLI with its existing state and may fail to recover. A kill during a tool write can leave incomplete work. A kill during a stream can produce an `abandoned_stream` watchdog violation and a nonzero exit even when the restarted client finishes the task.

`calibrate` uses `ref-agent` with `instant`, one batch and 16 lanes by default. Compare median mock union time, median outside-mock time, verified lanes per second and the before/after `/admin/metrics` snapshots across lane counts. Union time measures the overlap-adjusted mock service intervals during a session. Outside-mock time covers the rest of the registration-to-finalization window, including runner and client overhead. Process wall time uses the measured CLI segments. Warm and shared daemons contribute to the concurrent batch RSS. The calibration measures the local benchmark workload at the chosen lane count.

`matrix` runs all five built-ins by default. Use `--scenarios a,b` to select scenarios. It writes `matrix-report.md` with links to each exercised scenario. Unsupported tracks show `N/A`. An adapter that supports the track but fails to launch or verify is a failed result.

## Built-in scenarios

| Scenario | Track | Workload |
| --- | --- | --- |
| `smoke-edit` | Native | Read and edit a source file, then verify the change with a parallel read and grep. |
| `concurrency-fanout` | Native | Create an artifact and verify successive state transitions, with a parallel read and shell check. Increase `--lanes` to exercise fanout. |
| `long-compaction` | Native | Generate 128 KiB of tool output, hit a context limit and adopt a checkpoint before completing the edit. |
| `chaos-recovery` | Native | Recover from HTTP 429, HTTP 503 and a mid-stream disconnect, and report errors for malformed and unknown calls. |
| `mcp-smoke-edit` | Shared MCP | Perform the smoke edit over the benchmark stdio MCP tools and reconcile their audit with the workspace and mock receipts. |

## Stress suites

Generated scenarios are deterministic. The exact input is written as `<suite>/scenario.json`. Use `--suite all` to run all five suites. `--lanes`, `--turns` and `--output-bytes` override suite defaults where applicable. Stress accepts `--latency-profile instant|frontier` and uses `instant` by default.

| Suite | Default | Workload and controls |
| --- | --- | --- |
| `deep-grind` | 60 turns, 1 lane | Read, write, edit and verify a file, then emit 16 KiB of real shell output every fifth round. Use 150 or 300 turns and 64 KiB per output to grow the retained history into multiple MiB. |
| `burst-flood` | 6 turns, 1 lane | 16 independent tool calls per turn, including reads, writes, simultaneous `sleep 0.1` probes and a 256 KiB UTF-8 output. Set `--parallel 8\|16\|32` and `--output-bytes` up to 1048576. Compare the tool-round interval with the serialized sleep budget. |
| `cliff-ramp` | 12 turns per lane | Run each harness at `--steps 4,8,16,32,64,128`. Each harness advances independently after a fully verified stage. Its first failed stage and highest passing stage are in `leaderboard.md` and `leaderboard.json`. A failed stage yields a nonzero exit after the leaderboard is written. |
| `chaos-storm` | 10 turns, 8 lanes | Scheduled 429, 503 and a disconnect after the first complete tool call. The scenario also tests invalid arguments and an undeclared tool. Native wire poisoning is enabled. HTTP clients receive `Retry-After-Ms: 80` through a loopback proxy. The WebSocket adapter receives the mock's protocol-native 429. |
| `firehose` | 25 turns, 8 lanes | Write multibyte content from streamed tool arguments and reassemble a multibyte final answer. Always uses instant pacing. Tune chunk size with `--chunk-chars` (16 by default) and add `--wire-poison` to exercise framing boundaries. |

Use a freshly built mock with `--chunk-chars` and `--wire-poison` support. Wire poisoning applies the mock's native SSE or WebSocket framing perturbations. An instant profile still includes codec, transport and scheduling time.

## Adapters

| Adapter | Model protocol | Tracks |
| --- | --- | --- |
| `ref-agent` | Chat Completions | Native, Shared MCP |
| `maka-direct` | Chat Completions | Native, Shared MCP |
| `maka-codemode` | Chat Completions | Native |
| `maka-host-direct` | Chat Completions | Native, Shared MCP |
| `maka-host-codemode` | Chat Completions | Native |
| `claude` | Anthropic Messages | Native, Shared MCP |
| `codex-ws` | Responses WebSocket | Native, Shared MCP |
| `codex-http` | Responses HTTP | Native, Shared MCP |
| `opencode-cold` | Chat Completions | Native, Shared MCP |
| `opencode-attach` | Chat Completions | Native, Shared MCP |
| `opencode-serve` | Chat Completions | Native |
| `pi` | Chat Completions | Native |
| `pi-durable` | Chat Completions | Native |
| `pi-durable-shared` | Chat Completions | Native |
| `dim` | Chat Completions | Native, Shared MCP |
| `dsh` | Chat Completions | Native, Shared MCP |
| `zcode` | Chat Completions | Native, Shared MCP |
| `kimi-openai` | Chat Completions | Native, Shared MCP |
| `kimi-responses` | Responses HTTP | Native, Shared MCP |
| `kimi-anthropic` | Anthropic Messages | Native, Shared MCP |

Use `preflight` for installation hints and environment requirements. For the Maka adapters, use a disposable OS account or container and point `HARNESS_BENCH_MAKA_ACCOUNT_HOME` at that account's home. `MAKA_BENCH_BINARY` can select the Maka binary.

## Isolation and artifacts

Each run starts a strict scenario server on `127.0.0.1:0`. Each lane has a unique scoped model endpoint and test credential, its own fixture workspace and private HOME, XDG, config, cache and temp directories. The adapter supplies these settings to the client. Native tools operate with the OS permissions of the benchmark account. Use a disposable account or container when you need OS-level file or network isolation. The Shared MCP server restricts benchmark tools to each lane's workspace and structured commands. Maka starts one Host per candidate batch with one connection per lane. Its ACP clients select the lane's connection using `session/set_config_option` and attach the stdio MCP server with `session/new`. Shared MCP runs issue a real `tool_search` discovery call through the loopback adapter before the canonical calls. The discovery call belongs to the adapter and stays outside the mock's canonical receipts. Both `maka-host-*` IDs use the same shared topology as their `maka-*` counterparts.

`opencode-serve` and native `opencode-attach` use one OpenCode v2 server, with `lane-N/gpt-4.1` providers and one `run --server` client per lane. Shared MCP `opencode-attach` retains a server per lane to keep the server-owned MCP workspace and audit distinct. `pi-durable-shared` opens one Node process, Harness and SQLite database and runs ownerless conversations concurrently. Each conversation has its own pinned provider and workspace. `pi-durable` keeps one process and database per lane.

A single process snapshot per batch samples descendant and daemon RSS and process count every 100 ms. Shared processes are counted once in the batch total. `--max-cluster-rss-gib` defaults to 32 GiB. The sampler aborts the batch with `cluster_rss_limit_exceeded` when it observes a sample above the threshold. Timeouts and SIGINT/SIGTERM also stop the process groups and tracked descendants. The cap is sampled, so short-lived spikes between samples can exceed it. The runner and mock model run outside the candidate's RSS accounting.

Use `--output` with a new or empty directory. With no flag, the runner creates a temp directory and prints its path. The output retains the fixtures and final files, per-segment process samples and log tails, mock session exports, and MCP audit logs where applicable. `manifest.json` records candidate order and options. `results.json` contains lane outcomes and mock metrics. `report.md` summarizes comparisons and failures. Timing and RSS/CPU samples cover each CLI and its live descendants. The monitor keeps up to 256 KiB each of stdout and stderr per segment and records truncation in `lane.json`.

A successful lane has a clean CLI result, independent workspace proof and a finalized mock session with a verified final response. The runner exports telemetry before acknowledging its cursor and deleting the session. A failed lane or run error makes the command exit nonzero after writing diagnostics.


Each batch in `results.json` reports `peakClusterRssMib`, `peakClusterProcessCount` and `throughputTurnsPerSec`. Throughput divides verified tool-round receipts by the wall-clock window from the first client start to the last exit, including any restart gaps. Daemon setup, evidence export and cleanup happen outside that window. `diskStateMib` reports peak logical bytes under each isolated state directory and the batch's `shared-state` directory. Workspace files and runner logs have separate artifacts.

Each lane's `turnLatencyCurve` measures time between successive canonical main requests from `mock-session.json`. It includes streaming, tools, persistence and retry delay. The ratio compares the last five intervals with the first five and is available after ten intervals.
