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

# ACP

[简体中文](README.zh-CN.md)

Exposes Maka through the official `agent-client-protocol` SDK. This crate uses
only the public Host client; execution, permissions and durable facts stay in Host.

```sh
maka acp
maka acp --root /absolute/state/root
```

The CLI connects to or starts the local Host. Standard input/output carry ACP;
diagnostics go to standard error. The default state root is shared with the TUI.

- Inbound protocol: experimental ACP v2 (`unstable_protocol_v2`).
- Sessions: create, list, resume, close and model/thinking/collaboration/sandbox
  selectors. Resume can replay from the start using canonical message identities.
- Prompts: text, images, embedded resources and explicitly supplied local file links.
  Admission returns the durable user message ID before model completion; updates
  stream until the terminal idle state.
- Interactions: permission requests and capability-negotiated form elicitation.
  Host validates the exact answer; a rejected or cancelled callback never grants permission.
- Cancellation targets this connection's exact foreground turn. Closing a session
  cancels and settles its foreground without deleting history. A late admission
  receipt remains owned through cancellation; unknown outcomes are not resubmitted.

Client MCP servers, additional workspace directories, arbitrary replay cursors
and ACP authentication are not advertised. Attachments in replay retain descriptive
metadata rather than exposing Host-private paths. Resume requires an idle Host
session. Each connection supports up to eight attached sessions.

The SDK owns JSON-RPC parsing, correlation and dispatch; the transport adapter
bounds line size and output waits. The outbound Executor adapter lives in
[`external-agent`](../external-agent/README.md), where SDK negotiation also supports v1.

```sh
cargo nextest run -p maka-acp
cargo nextest run -p maka-runtime-host --test acp_server
```
