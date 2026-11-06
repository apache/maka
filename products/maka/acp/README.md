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

# maka-acp

[简体中文](README.zh-CN.md)

Serves ACP v1 and v2 to clients through the ordinary Host client. `serve` translates protocol requests into admitted Agent operations and observations. It owns neither execution nor canonical storage. For invoking an external ACP agent from Maka, see `plugins/agent/acp-executor`.

Run `maka acp` over stdio. The SDK routes each connection by its `initialize` version; no version flag is needed. Model connections and credentials come from the selected Host Root (`maka acp --root /absolute/state/root`). Configure a default model there or select one through the session configuration options.

For Lody, add a Custom ACP Agent with the absolute launch command `/absolute/path/to/maka acp --root /absolute/state/root`. V1 supports new sessions, history loading, listing, configuration, appended text/thought chunks, tool calls, permissions, form elicitation and cancellation. V2 retains message IDs, replacement updates and independent completion state.

Run the ACP process and the selected Host with the same updated Maka build; restart an older Host before attaching client MCP servers.

Client MCP servers over stdio and Streamable HTTP are attached only to the corresponding session through a Host-owned subscription. Loading or resuming replaces the connections; disconnecting revokes the lease and settles its original work before closing the transports. Server environment variables and HTTP headers are not saved as installation settings. Tools retain Maka's workspace permissions and approval requirements; server annotations do not grant access. Additional directories and SSE MCP servers are unsupported.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
