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

Runs ACP v1 agents as public Executor plugins. Configuration, process ownership,
files, interaction, HTTP and private storage use the same capabilities available
to external plugins; no V8 is required.

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

- Text, thoughts, tool activity and file/permission callbacks become Host observations.
- Model and thinking choices use the agent's advertised config selectors.
- Each conversation retains its process. After restart, only advertised
  `session/load` may restore the persisted external identity.
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
