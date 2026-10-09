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

# `@maka/computer-use`

This package adapts the bundled Cua Driver CLI to Maka's existing `CuDispatchBackend`. Desktop verifies the pinned executable before selecting the backend. Runtime remains the authority for tool calls, sessions, observation binding, policy, and user-visible results.

The CLI runs as a private stdio MCP child in direct embedded mode. Its MCP tools are not registered with the agent; the agent sees only `maka_computer`. The driver reads and acts in the background by default. A foreground action is explicit and limited to one tool call: Maka asks the user to approve each `delivery_mode=foreground` call before dispatch and remembers nothing. Telemetry and update checks are disabled for every launch.

`node scripts/computer-use.mjs prepare` downloads the release pinned in `apps/desktop/bundled-tools.json`, verifies the archive, executable digest, version, and Developer ID signature, then stages `apps/desktop/resources/bin/cua-driver`. This binary is ignored by Git and included in macOS packages. The package uses the upstream signature unchanged so its runtime digest remains stable.

The executor is currently macOS-only. Selection fails closed when the file or digest is missing. An exited child invalidates its generation; an uncertain action is not replayed automatically. The backend never uses windowless desktop input.

The release source and license obligations are recorded in [`computer-use-provenance.md`](../../docs/computer-use-provenance.md). Packaged builds select the backend only while the manifest's `distributionReady` is true; the macOS release gate checks the same flag.
