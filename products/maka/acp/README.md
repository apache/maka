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

Use `maka acp` as the launch command in your ACP client. The SDK routes each stdio connection by its `initialize` version. Model connections and credentials come from the same Host Root as Maka Desktop. Use `--root` to select a different Root, or choose a model through the session configuration options.

V1 supports new sessions, history loading, listing, configuration, appended text/thought chunks, tool calls, permissions, form elicitation and cancellation. V2 retains message IDs, replacement updates and independent completion state.

Run the ACP process and the selected Host with the same updated Maka build; restart an older Host before attaching client MCP servers.

Client MCP servers over stdio and Streamable HTTP are attached only to the corresponding session through a Host-owned subscription. Loading or resuming replaces the connections; disconnecting revokes the lease and settles its original work before closing the transports. Server environment variables and HTTP headers are not saved as installation settings. Tools retain Maka's workspace permissions and approval requirements; server annotations do not grant access. Additional directories and SSE MCP servers are unsupported.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
