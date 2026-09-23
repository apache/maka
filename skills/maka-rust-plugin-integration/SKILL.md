---
name: maka-rust-plugin-integration
description: Implement, extend, or review plugins against Maka's Rust Runtime Host plugin platform, including native Rust contributions, external JS packages, Host services, Remote and Client slots. Use for the Rust rewrite branch; do not apply its contracts to the older TypeScript plugin platform.
license: Apache-2.0
---
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

# Maka Rust Plugin Integration

Use this skill to connect a **product feature** to the Rust Runtime Host plugin platform. A Skill is developer guidance; it is not the runtime Plugin being built. The platform changes quickly, so inspect the target checkout before relying on an API name or status from this file. Source paths below are relative to the Maka repository root.

## Locate the seam

1. Identify the feature's business owner, durable state, side effects, UI, and callers. Decide which policy and presentation belong to the plugin and which canonical facts or authorization decisions must remain with Host. Do not create a second owner for Session identity, Turn admission, event log, permissions, credentials, or accepted execution receipts.
2. Choose the scope of each contribution: `Profile`, `Session(id)`, or `DesktopUi`. A Session capture overlays Profile contributions; a Desktop UI Entry does not receive Host services. A visible Client slot or Remote method does not itself grant execution or filesystem access.
3. Choose **native Rust** for a built-in feature registered by Host, or **external JS** for an installable package using the public SDK. Follow an existing consumer before inventing another platform primitive. Read [capability map](references/capability-map.md) when selecting contribution or Host service APIs.

## Native Rust path

- Start with `crates/web/src/plugin.rs` and `crates/runtime-host/src/plugins/web.rs` for a small complete path. `crates/graph/src/plugin.rs` shows `SessionBehavior`; `crates/scheduler/src/plugin.rs` shows background work and a separate Desktop UI Entry.
- Implement `maka_plugins::kernel::Plugin`: validate supported scope/config, use `PluginContext`'s bound capabilities, and return typed `Staged` contributions from `activate`. Use `context.lifecycle` for tasks and cleanup. Host wiring creates a `Definition` and Composition layer/Entry; registration alone does not make a feature visible.
- For Desktop UI, publish a `Client` from a `DesktopUi` Entry and use a separate Host-side Entry for business state. Connect them through the existing bounded service/Remote path. Verify the actual target code before copying a pattern.

## External JS path

- Follow `crates/runtime-host/tests/fixtures/workflow/`: `maka.extension.json`, `maka.composition.yml`, `host.mjs`, and optional `client.tsx`. The manifest pins Host and Client SDK versions; its composition patch creates the Entries. Build the Client bundle with `@maka-agent/plugin-sdk/build` when UI is needed.
- Use `@maka-agent/plugin-sdk/host` for tools, behaviors, executors, model adapters, prompt/input, Remote, storage, and scoped calls. Use `@maka-agent/plugin-sdk/client` for slots and a Remote client. The JS package is a trusted extension, not an OS sandbox or Node environment.
- Store durable business intent before acting on it, use stable operation IDs and receipts for retryable Host commands, and recover uncertain outcomes by querying the original operation. `ctx.run` alone does not keep Host awake; register background pending work when persistent work requires it.

## Verify the boundary, then the feature

- Exercise the product's real consumer path, not only `activate`: composition change → Fiber activation → contribution capture → caller admission → effect/receipt → retirement and restart. Check that partial activation publishes nothing and a retired registration refuses new calls.
- Cover the feature's relevant permission and scope refusals, cancellation, result-unknown path, duplicate submission, and Host restart. Previously accepted Host work retains its Host owner when the plugin retires; plugin policy must reconcile its own durable intent.
- Run focused Rust tests for touched crates and `npm --workspace @maka-agent/plugin-sdk run typecheck` when the public JS SDK or fixture changes. Use the external workflow fixture for an end-to-end package path when applicable. Report exactly what ran and what remains unverified.

## Keep the status honest

Read `docs/rust-runtime.zh-CN.md`, `docs/rust-parity.zh-CN.md`, and the current SDK source before claiming parity. Distinguish implemented capabilities from migration targets. Old TypeScript plugin source is not directly compatible. If a needed public service is missing, identify the narrow Host contract and a real consumer; do not pass a private Host handle into a plugin or add a generic hook bus to bypass the boundary.
