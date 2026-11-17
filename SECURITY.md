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

# Security Policy

Report security vulnerabilities privately to **security@maka.app** with the Maka version, affected component, operating system, and a minimal reproduction. Do not open public GitHub issues for undisclosed vulnerabilities.

## Trust boundaries

- **Runtime Host authority** — The Host owns call admission, capability scopes, canonical SQLite state, and resource cleanup. Neither UI clients nor model outputs can escalate their own capabilities; every service call executes strictly within the grants bound to its activation and invocation scope.
- **OS sandboxing** — Native workspace tools enforce filesystem, subprocess, and network restrictions using Seatbelt on macOS, bubblewrap + network namespaces on Linux, and Microsoft MXC (or restricted low-privilege job accounts) on Windows; see [platform/sandbox](platform/sandbox/README.md). User approval authorizes one concrete capability grant without trusting untrusted text or stale observations.
- **Code Mode isolation** — Code Mode runs JavaScript in an embedded V8 isolate and optional Python in a bounded Monty subprocess. Neither guest runtime has ambient filesystem, network, or subprocess APIs; every external action goes through authorized Host tool bindings, and cancelled cells wait for admitted effects to settle.
- **Plugins and MCP servers** — Installed Host/UI plugins and configured MCP servers are trusted extensions. Stdio MCP servers run under the Host OS account outside session filesystem sandboxes, and HTTP MCP servers control their own remote side effects. Session permissions and per-call approvals gate tool invocation, not server startup; only explicitly configured secrets are passed beyond a minimal stdio environment. See [MCP servers](plugins/agent/README.md#mcp-servers).
- **Computer Use** — Native desktop and browser automation run in a dedicated session lifecycle gated by platform accessibility/screen-recording permissions and Host domain authorization; see [platform/computer-use](platform/computer-use/README.md).
- **State and credentials** — Conversation history and configuration live under the selected State Root. Credentials flow through dedicated Host secret capabilities—never store raw secrets in plugin configuration, tool output, or UI state.

## Release integrity

Native npm preview packages verify target platform, version, archive hashes, and source provenance before publication, and the `@maka-agent/cli` launcher binds to an exact-version native package. Official ASF source release signing and verification procedures are documented in [.github/ASF_SOURCE_RELEASE.md](.github/ASF_SOURCE_RELEASE.md).
