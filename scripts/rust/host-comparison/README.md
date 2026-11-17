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

# Offline Host Benchmark Harness

Linux benchmark scripts comparing production Host builds end-to-end over public RPC clients, real provider protocol decoders, SQLite state commits, and a local loopback SSE model server (no external API calls or GUI rendering).

## Building and running

Build the Rust CLI and benchmark client in release mode on an idle Linux machine:

```sh
cargo build --release -p maka-cli --bin maka --example host_benchmark_client
```

Run a comparison campaign (`compare.py --help` lists workload flags, concurrency settings, and adapter options) and aggregate results into Markdown/JSON summaries:

```sh
python3 scripts/rust/host-comparison/compare.py --help
python3 scripts/rust/host-comparison/summarize.py <results-dir>
```

`compare.py` verifies canonical transcript outputs across runs and records per-process RSS, CPU time, and I/O telemetry via `telemetry.py`.
