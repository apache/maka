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

# External agents

[简体中文](README.zh-CN.md)

Runs ACP agents as public Executor plugins, preferring experimental v2 and
accepting v1 when the peer selects it during initialization. Configuration, process ownership,
files, interaction, HTTP and private storage use the same capabilities available
to external plugins; no V8 is required.

The official `agent-client-protocol` SDK owns version negotiation, typed requests,
callbacks and JSON-RPC framing. Its transport uses Host-owned process I/O. When
v1 fallback needs different capabilities, the probe process is closed before a
fresh v1 transport is opened. Connection checks and authentication negotiate the
same versions (`authenticate` in v1, `auth/login` in v2).
If typed v2 initialization fails with a parse error (including legacy peers that
echo v2 with a v1 envelope), one fresh native v1 initialization is allowed within
the same deadline. No response is rewritten and no business operation is retried.

Configure an absolute Host executable, arguments and non-secret environment in
the External agents settings page, then check the connection and select an
offered authentication method. Setup requests explicit authorization; ordinary
execution retains the Session sandbox. Credentials stay in the external agent's
own login store.

The optional Antigravity installer downloads version 1.2.1 directly from Google's
[registry-listed distributions](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json).
It supports macOS, Linux and Windows on x64/ARM64, verifies bounded ZIP contents,
and publishes an immutable private directory. macOS ARM64 has pinned archive and
file digests; all platforms retain download and file digests in Host KV, outside
the agent-writable file cache. Reuse verifies files against that record; missing
records require a fresh official download. These binaries are not bundled with
Maka. Installation returns a draft configuration; Save publishes the Executor.

- Text, thoughts, tool activity and permission callbacks become Host observations.
  Filesystem callbacks belong to the v1 surface; v2 agents own their filesystem access.
- V2 prompt acknowledgement is not completion: the adapter waits for the echoed
  message identity and foreground running-to-idle transition. Stable message IDs,
  replacement content and explicit clears are preserved. Because Host text deltas
  are append-only, v2 message text is committed after completion.
- Model and thinking choices use the agent's advertised config selectors.
- Each conversation retains its process. After restart, v1 uses advertised
  `session/load`; v2 uses `session/resume` without replay. A session cannot change
  protocol version during restoration.
- Creation and prompt intent are saved before sending. Unknown outcomes are
  never retried as a fresh conversation. Cancellation closes the owned process;
  an unconfirmed prompt cannot be continued.
- Attachments, external conversation forks, terminal callbacks and terminal
  authentication are not advertised. Unsupported input fails explicitly.
- Executors must opt into `historyCopy` to initialize from Host-owned copied history;
  this ACP adapter does not claim it can clone an opaque external conversation.
- Editing one agent leaves unchanged agents running. A failed activation does
  not undo saved configuration; reconciliation retries it.

Standalone Remote endpoints are `manage` (read/configure/reconcile/schema) and
`setup` (check/authenticate/install stream). Bundled clients use equivalent
digest-bound endpoints.

Run focused tests with `cargo nextest run -p maka-external-agent` and
`cargo nextest run -p maka-runtime-host --test external_agents`.
The ignored official installation test downloads a real release and checks ACP
initialization without signing in.
