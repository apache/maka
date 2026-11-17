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

# Platform

[简体中文](README.zh-CN.md)

`platform/` implements the runtime kernel beneath Maka's business [plugins](../plugins/README.md): package loading, composition planning, SQLite state roots, Host service orchestration, guest script runtimes, OS sandboxing, Computer Use, and native NSH client support.

| Crate | Directory | Responsibility |
| --- | --- | --- |
| `maka-plugin-core` | [`plugin-core/`](plugin-core/src/lib.rs) | Package manifests, composition graphs, contract schemas, and operation receipt types |
| `maka-packages` | [`packages/`](packages/src/lib.rs) | Content-addressed `.maka-plugin` archive validation and immutable package store |
| `maka-capabilities` | [`capabilities/`](capabilities/src/lib.rs) | Scoped Host capability handles (calls, files, HTTP, processes, PTYs, secrets, storage) |
| `maka-event-log` | [`event-log/`](event-log/README.md) | State Root lock, SQLite writer/reader lanes, two-phase operation journal, and checkpoints |
| `maka-host-runtime` | [`host-runtime/`](host-runtime/src/lib.rs) | Host deployment reconciliation, call admission, activation lifecycle, and local RPC server |
| `maka-js-runtime` | [`js-runtime/`](js-runtime/src/lib.rs) | Embedded V8 isolate management for Code Mode cells and guest JavaScript |
| `maka-host-js` | [`host-js/`](host-js/src/lib.rs) | JavaScript `HostService` adapter running on V8 |
| `maka-python-runtime` | [`python-runtime/`](python-runtime/src/lib.rs) | Bounded Monty subprocess worker for Python Code Mode cells |
| `maka-sandbox` | [`sandbox/`](sandbox/README.md) | OS command isolation (macOS Seatbelt, Linux bubblewrap/netns, Windows MXC and job accounts) |
| `maka-process` | [`process/`](process/src/lib.rs) | Child process groups, pipes, ConPTY/Unix PTY streams, and physical cleanup tracking |
| `maka-network` | [`network/`](network/src/lib.rs) | TLS/HTTP client pool, proxy routing, and destination-restricted gateways |
| `maka-computer-use` | [`computer-use/`](computer-use/README.md) | Independent JavaScript REPL driving native desktop accessibility and browser connectors |
| `maka-transport` | [`transport/`](transport/src/lib.rs) | Framed local IPC and RPC streams between shells/CLIs and the Host |
| `maka-background-health` | [`background-health/`](background-health/src/lib.rs) | Liveness and resource probes for background tasks |
| `maka-presentation` | [`presentation/`](presentation/src/lib.rs) | Shared tool-activity and transcript presentation descriptors |
| `maka-ui-support` | [`ui-support/`](ui-support/src/lib.rs) | File/clipboard snapshots and locale detection for the NSH workbench |

Core lifecycle crates (`plugin-core`, `packages`, `capabilities`, `event-log`, `host-runtime`) compile without V8 or the Agent engine so lightweight tools and native helpers avoid pulling in heavy guest runtimes.
