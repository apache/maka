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

# 0001. Build a GPUI thin client over the Runtime Host protocol

Status: Proposed, 2026-09-25. Becomes Accepted when the plan in
`docs/plan/2026-09-25-gpui-client-plan.md` is approved.

## Context

The goal is a native GPUI desktop app for Maka. Maka is about 1.26 million
lines of TypeScript. Its architecture already places execution authority in
the Runtime Host. The Electron Desktop app (`apps/desktop`, about 170,000
lines), the TUI, and the CLI are thin clients of that Host.

The Host has a public protocol:

- Local transport is a Unix domain socket or a Windows named pipe; remote
  transport is WebSocket.
- Frames are one JSON object per line, `\n`-delimited, at most 768 KiB each.
- The handshake is `hello`, answered by `accepted` or `incompatible`. After
  it, requests are `{requestId, operation, input}` and responses are
  `{requestId, operation, ok, result | error}`. Push frames have operations
  starting with `subscription.`.
- There are 155 operations. A usable chat client needs roughly a dozen.

The Host can run on its own. The TUI spawns
`node packages/runtime-host/dist/execution-candidate-main.js` with `--root`,
`--expected-root-id`, and `--startup-attempt-id`, then reads
`registration.json` in the control directory to find the socket path. A new
client can do the same.

## Decision

Build a new Runtime Host client in Rust with GPUI, using the `gpui-kit` crate.
It takes the role of the Electron shell. The Runtime, Runtime Host, storage,
evaluation, and CLI stay in TypeScript and are not changed for this client.

The client consists of a protocol crate (wire types and frame codec, no I/O),
a client crate (transport, handshake, request multiplexing, subscriptions,
reconnect, Host spawn), and GPUI feature crates above them. It lives in a
separate repository while it is exploratory. Moving it into `apache/maka` is a
later decision.

## Consequences

- The Rust code stays small: presentation and desktop integration only. Host
  behavior has one implementation, shared by Desktop, TUI, CLI, and this
  client.
- The TypeScript protocol validators are hand-written (no zod, no JSON
  Schema), so the Rust serde types are hand-written too. Each type cites the
  TypeScript decoder it mirrors.
- The protocol carries a compatibility epoch (177 at the time of writing).
  When the Host bumps it, this client must follow. A drift check in CI
  compares the two constants.
- Capabilities that exist only in Electron Desktop are outside the Host
  protocol and must be rebuilt in Rust: native dialogs, auto update, system
  notifications, the floating pet, the Computer Use overlay, the browser
  panel, and others. They are handled as long-tail work, not a parity target.
- Running the client requires a built Maka Host and Node. Development uses a
  dedicated dev State Root so the user's live Maka data is never touched.
- gpui-kit's API still changes quickly. Code must be written against the real
  source, never against remembered or guessed signatures.
- This client does not commit to feature parity with Electron Desktop.
