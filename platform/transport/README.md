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

# maka-transport

[简体中文](README.zh-CN.md)

Provides process stdio adapters, confirmed Root-store startup, and the public Host transport contracts. The shared NSH workbench connects through `maka-app-client`; Host session ownership, discovery and authenticated IPC live in `maka-host-runtime`.

Trusted local applications can use one public entry point with an explicit `startup::Request` selecting the Root, deployment and endpoint grants:

```rust
let mut client = maka_host_runtime::application::host::startup::connect(&maka_executable, request).await?;
// Use the authenticated Client's catalogue and calls.
client.close().await?;
```

The executable must be an absolute path to the trusted Maka CLI. The entry point reuses a live Host or asks that CLI to start it, verifies the Root and Host incarnation, and admits the caller within 40 seconds. It uses the current account's Root namespaces and does not install, update or repair a deployment. Endpoint/native selections prepare startup; a live Host retains its published catalogue and grants. `close` detaches this session; `quit` requests shutdown when no other session remains. Keep original calls through their cleanup acknowledgement, and resolve uncertain mutations through their original receipts; reconnecting does not retry them. `refresh` captures current registrations for the session’s original endpoint selections after live configuration changes, preserving its grants and accepted calls. External UI peers continue to use explicit captured approval.

Remote registration data describes available services. It cannot create permission, choose a different caller or retarget an accepted operation. Normal quit asks the Host to stop if no other session remains, atomically with session admission. Closing a client session detaches it and preserves accepted work until the original calls finish.

Local and WebSocket channels carry complete JSON frames with a four-byte unsigned length prefix. The codec has no separate whole-message quota. Variable startup and opening requests use the same complete framing; the fixed canonical Ready response retains its shape bound. Partial reads retain received bytes across cancellation and preserve following frames and raw resource chunks. Encoding and decoding still hold complete JSON values in memory; the prefix alone does not reserve the advertised body size.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
