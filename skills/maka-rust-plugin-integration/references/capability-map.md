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

# Rust Runtime Host plugin capability map

Use this as a routing index, then inspect the repository-relative source paths in the target checkout. Verified against `feat/runtime-host-rust` at `30d626ce67ef0b7264f6d67ace3543a136256bfa` on 2026-09-24. It is not a promise that every TypeScript extension API already has parity.

## The three states

| State | Owner and source | Consequence |
| --- | --- | --- |
| Desired plugin tree | `crates/plugins/src/composition/ledger.rs`; `crates/runtime-host/src/plugins/owner.rs` | Host persists package layers and overlays with a generation before installing the prepared tree into Kernel. A commit-unknown response fences further mutations until outcome is resolved. |
| Live instance | `crates/plugins/src/kernel.rs`; `crates/plugins/src/kernel/reconcile.rs`; `crates/plugins/src/fiber.rs` | One activation has a Fiber identity and owns tasks/effects. Failure can leave desired state intact and trigger retry. Retirement blocks fresh admissions and drains owned work. |
| Callable surface | `crates/plugins/src/contributions.rs` | `Staged` entries publish together after activation. A snapshot captures typed descriptors, while each call still checks registration and Fiber effectiveness. Session capture overlays Profile; Desktop UI is separate. |

`crates/runtime/src/scope.rs` defines `Profile`, `DesktopUi`, and `Session(String)`. `crates/plugins/src/kernel.rs` defines the common `Plugin` trait and `PluginContext` for native and loaded packages. `crates/runtime-host/src/server.rs` installs the built-ins, loader, Kernel and Host service issuer.

## Plugin contributions: what the feature adds

| Need | Native Rust seam | Public JS or Client seam | Working example |
| --- | --- | --- | --- |
| Model-visible tool | `maka_tool_catalog::plugins::PluginTool`, staged as a typed contribution | `ctx.tools.register` or `ctx.tools.bind` | `crates/web/src/plugin.rs`; `packages/plugin-sdk/src/host.ts` |
| Prompt and input preparation | `maka_plugins::prompt`, `maka_plugins::input` | `ctx.prompt.section/variable/context`, `ctx.input.prepare` | `crates/skills/src/plugin.rs`; SDK Host types |
| Session behavior | `maka_plugins::session::SessionBehavior` | `ctx.behaviors.register` | `crates/graph/src/plugin.rs`; `crates/plugins/src/session.rs` |
| Model protocol adapter | `maka_plugins::model::Adapter` / `ProviderAdapter` | `ctx.modelAdapters.register` | `crates/runtime-host/src/plugins/models.rs`; `crates/plugins/src/model.rs`; `packages/plugin-sdk/src/models.ts` |
| External executor | `maka_plugins::executor::Executor` | `ctx.executors.register` | `crates/runtime-host/tests/fixtures/workflow/host.mjs` |
| Client-facing operation | `maka_plugins::remote::Endpoint` | `ctx.remote.method/stream` | `crates/web/src/plugin/remote.rs`; workflow fixture |
| Long-lived pending work | `maka_plugins::background::BackgroundWork` | `ctx.background.pending` | `crates/scheduler/src/plugin.rs`; SDK README |
| Desktop UI | `maka_plugins::client::Client` and bundle in a `DesktopUi` Entry | `ctx.slots.register`, `ctx.remote.method/stream` on Client side | `crates/runtime-host/src/plugins/web.rs`; `packages/plugin-sdk/src/client.ts` |

The Client slot keys include `tool.detail`, `settings.page`, `application.overlay`, `session.header.actions`, `session.inspector.overview`, `turn.footer`, `workspace.composer.before`, and `workspace.manage`. Read `packages/plugin-sdk/src/client.ts` for the current full set. Slot arguments locate a view; they do not mint permission to execute on that Session.

## Host-issued services: what the feature may request

`crates/plugins/src/host.rs::Services` groups the Rust contracts. `crates/runtime-host/src/plugins/host.rs::Issuer` binds them to a Fiber owner, rather than handing out the Host object. The JS equivalent is the scoped Host/Call context in `packages/plugin-sdk/src/host.ts`.

| Concern | Service examples | Boundary to preserve |
| --- | --- | --- |
| Business data | `storage`, `preferences`, `inputs` | Storage is package/scope namespaced with revisions; a borrowed read view is not a write or execution grant. |
| Secrets and approval | `credentials`, `authorizations`, `permissions` | Credentials remain in Host vault. Approval is checked again at the actual effect; a returned description is not a transferable token. |
| Runtime work | `executions`, `models`, `executors`, `clients` | Discovery does not grant execution. Accepted work and its receipts remain Host facts after a plugin stops. |
| Observation | `sessions`, `history`, `usage`, `pricing` | Read scope and authorization vary by Agent, Remote, and background caller. These queries do not create a new canonical Session or usage record. |
| Effects | `files`, `http`, `processes`, `terminals` | Use scoped calls so Host can apply permission, cancellation, resource ownership, and settlement. External effects with unknown outcomes require reconciliation. |

## Choosing Rust or JS

**Native Rust:** implement `Plugin::supports_scope`, `validate`, and `activate`; stage contributions; register a `Definition` and Composition `Entry` in `crates/runtime-host/src/plugins/<feature>.rs`, then install it from `server.rs`. Use `crates/web/src/plugin.rs` and its Host wiring as the concrete pattern. A Desktop UI Entry cannot use Host services; the Web and Scheduler built-ins show separate UI/backend entries.

**External JS:** the minimal public fixture lives in `crates/runtime-host/tests/fixtures/workflow/`. `maka.extension.json` identifies the package and SDK 1 entrypoints; `maka.composition.yml` inserts Host and Desktop UI Entries; `host.mjs` uses the public Host SDK; `client.tsx` uses the Client SDK and is built into `client.js`. `packages/plugin-sdk/README.zh-CN.md` describes the current contract; this SDK workspace is not yet published. The package loader verifies immutable bytes and chooses shared or dedicated V8 from the manifest; both implement the same Kernel `Plugin` entrypoint. Neither mode is an OS sandbox.

### Follow one feature through both sides

For WebFetch, `crates/runtime-host/src/server.rs` calls `plugins::web::install`. That installer adds a `Definition` for `maka.web` and Composition Entries for the Profile backend and Desktop UI. `crates/web/src/plugin.rs` branches by scope: the backend takes bound `host.http`, `host.storage`, `host.credentials`, and preferences, then inserts `PluginTool` values into `Staged`; the Desktop UI Entry publishes a `Client` bundle. Kernel activates the Fiber and commits the staged batch. At each model step, `crates/agent/src/steps.rs` and `crates/tool-catalog/src/plugins.rs` capture the current tool registration. This is the complete route from package identity to actual caller visibility; copying only `staged.insert` omits installation and scope.

For an installable package, the workflow fixture follows the parallel route. Its `maka.extension.json` declares `runtime: { entry: "host.mjs", sdkVersion: 1 }`, an optional Client entry, and a composition patch. The patch inserts Host and Desktop UI Entries. `host.mjs` registers an Executor and Remote methods, persists intent with storage revisions, then uses authorized `createRoot` / `submit` / `query` with stable operation IDs. `client.tsx` registers a Client slot and calls Remote. The fixture README checks disable, re-enable, Host restart, authorization revoke, and stable receipt recovery.

## Architecture checks while integrating

- The plugin owns business policy, domain state format, retries, and UI; Host owns canonical Session/Turn/Run identity, execution admission, Event Log, authorization, secrets, effect settlement, and protocol routing. `docs/rust-parity.zh-CN.md` records migration intent and current gaps; confirm its claims against code because the branch moves quickly.
- A Remote method is a Client request, not an Agent tool call. Its Host binding captures the original connection/document and registration target; it cannot inherit an Agent invocation from a payload. See `crates/plugins/src/remote.rs` and `crates/runtime-host/src/server/plugin_remote.rs`.
- If a domain needs durable background work, persist intent first and restore it on activation. If an operation's reply is lost, query its stable ID or receipt. Do not equate cancellation of observation with cancellation of accepted execution.
- Stop new admissions on retirement; wait for owned resource cleanup before replacement. Verify disable, re-enable, Host restart, and authorization revocation on the actual consumer path. `crates/runtime-host/tests/plugins.rs` and the workflow fixture cover important platform behavior.
