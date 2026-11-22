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

# `maka-mock-ai`

Single-port, multi-protocol simulated AI provider & chaos/load simulator for Maka integration tests, evals, and high-concurrency / ultra-long-session stress testing.

## Capabilities

- **Protocols & Transports**: OpenAI Chat Completions (HTTP SSE/JSON), OpenAI Responses (HTTP SSE/JSON + WebSocket with connection-local `store: false` baseline tracking), Anthropic Messages (HTTP SSE/JSON), plus control-plane discovery/usage/storage endpoints.
- **Physics-Based Pacing & Live Hot-Tuning**: Prefill/cache-aware TTFT, concurrency-knee congestion curves, log-normal tail jitter, streaming TPS + micro-stalls, SSE keep-alive pings, repeating `ScenarioSchedule` traffic waves, and live `GET/PUT/DELETE /admin/profile`.
- **Stateful Rate Limiting**: Token-bucket RPM / ITPM / post-turn OTPM + RAII `max_concurrent` slots scoped globally, per API key, per model, or per (key, model) with real `x-ratelimit-*` and `retry-after-ms` headers.
- **JSON Schema Tool Synthesis & Wire Fuzzing**: Automatically synthesizes schema-conforming tool calls (or controlled `MissingRequired` / `WrongType` / `MalformedJson` / `UnknownTool` / `HugePayload` faults), mid-UTF-8 SSE byte splits, CRLF line endings, SSE comments, `context_length_exceeded` 400s, and `max_output_tokens` truncation.
- **Inline Protocol Invariant Watchdog**: Detects unapplied/unreplayed compaction, duplicate/unknown `tool_result` IDs, unbounded prompt growth, invalid `previous_response_id`, and abandoned streams with bounded violation capture (`GET/DELETE /admin/violations`).
- **Observability**: Lock-free global & per-(protocol, model, status) atomic histograms (p50/p90/p95/p99/max) over `/admin/metrics` and Prometheus `GET /metrics`.
- **Transparent Proxy Record & Speed-Scaled Replay**: Record real HTTP SSE/JSON and WebSocket provider sessions into redacted NDJSON cassettes and replay offline at any speed multiplier (`--proxy-record` / `--replay`).

## Standalone CLI Examples

```bash
# High-concurrency stress with frontier latency physics, RPM/TPM caps, and Prometheus /metrics
cargo run -p maka-mock-ai --bin maka-mock-ai -- \
  --listen 127.0.0.1:4014 \
  --preset stress \
  --latency-profile frontier \
  --rpm 600 --itpm 2000000 --max-concurrent 64 \
  --admin --metrics-only

# Repeating 3-phase incident wave + wire chaos fuzzing
cargo run -p maka-mock-ai --bin maka-mock-ai -- \
  --preset chaos-fuzz --incident-wave --admin --metrics-only

# Record real upstream traffic into a redacted NDJSON cassette
cargo run -p maka-mock-ai --bin maka-mock-ai -- \
  --proxy-record https://api.openai.com --cassette ./trace.ndjson

# Replay cassette offline at 10x speed using semantic fingerprint matching
cargo run -p maka-mock-ai --bin maka-mock-ai -- \
  --replay ./trace.ndjson --replay-speed 10 --replay-match fingerprint
```
