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

The CLI runs as a private stdio MCP child in direct embedded mode. Its MCP tools are not registered with the agent; the agent sees only `maka_computer`. The driver reads and acts in the background by default. A foreground action is explicit and limited to one tool call. When background delivery fails or a fresh observation proves it had no effect, the agent must tell the user which app, window, and action need foreground access, wait for an explicit reply, then observe again before retrying that action with `delivery_mode=foreground`. Maka does not maintain a separate foreground approval state.

`node scripts/computer-use.mjs prepare` downloads the pinned macOS universal release, verifies the release archive, executable digest, version, and Developer ID signature, then stages `apps/desktop/resources/bin/cua-driver`. This binary is ignored by Git and included in macOS packages. The package uses the upstream signature unchanged so its runtime digest remains stable. A complete signed and notarized package still needs release validation.

The executor is currently macOS-only. Selection fails closed when the file or digest is missing. An exited child invalidates its generation; an uncertain action is not replayed automatically. The backend never uses windowless desktop input.

The release source and license obligations are recorded in [`computer-use-provenance.md`](../../docs/computer-use-provenance.md). The driver includes MPL-2.0 dependencies, so the top-level MIT license alone is not sufficient to qualify a binary release.
The manifest keeps `distributionReady: false` until the complete binary dependency notices and ASF release review are finished. Development builds can exercise the adapter, while packaged macOS builds fail the release gate.
