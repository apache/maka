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

# Antigravity ACP 1.1.1 observed behavior

Observed on macOS arm64 on 2026-09-10.

Source: [Google's official macOS arm64 ACP 1.1.1 archive](https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip).

- `initialize` returned protocol 1 and agent version `agy_acp_server_1.1.1`.
- Advertised methods: `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`. PR1 uses only Google personal OAuth.
- `authenticate` printed `Open the following link to authenticate the ACP server: ` followed by an HTTPS Google authorization URL to stderr. Unbuffered stderr was sufficient; no stdout prefix rewriting was needed.
- The user completed Google browser authorization. The official authenticate request then returned JSON-RPC error -32000: account ineligible because Antigravity is unavailable in the current location. This observed response maps to the sanitized account_ineligible result.

SHA-256 of the verified distribution files:

```text
agy_acp_server.par    9d900b93031fc42397f88206e14eba4193729bbef631a70b18e7a19631a6dfac
localharness_external e0a8ef9d80a1ffb178f945159dda33f73d4a5be65516642542352584b834fa2a
```
