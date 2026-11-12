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

# Architecture

[简体中文](ARCHITECTURE.zh-CN.md)

Maka assembles applications from plugins. A package declares what it provides and what it needs. A composition selects instances and binds their imports to exports. Host services own execution, permissions and durable state; UI plugins contribute NSH components to the shared terminal and desktop workbench.

## Code ownership

[Platform](platform/README.md) contains the package loader, composition kernel, persistence primitives, execution owners and native renderers. [Plugins](plugins/README.md) contain domain contracts, business features and their declarations. [The Maka product](products/maka/README.md) selects packages, native factories and startup entrypoints.

A leaf `package.ts` identifies an authored plugin (`host`, `ui` or `composition`). A Cargo crate identifies code compiled together. They need not correspond one-to-one: the Agent domain spans multiple crates with strict dependency boundaries, while related plugin entries can share one native implementation crate.

The composition kernel models Host, UI and structural instances in one committed source. `host-js` runs JavaScript Host services on the background V8 runtime. The [workbench](products/maka/workbench/README.md) runs trusted UI modules in one shared NSH VM across desktop and terminal shells, which inject the same Host bindings. NSH owns reactive layout, input and rendering; native file snapshots and clipboard resources live in [ui-support](platform/ui-support/README.md).

## From package to running application

1. The package loader validates immutable package bytes and computes their content reference.
2. The composition planner checks each Host, UI or structural node, its configuration schema and its bindings.
3. A State Root commits the desired source and package bytes at a new revision.
4. [Host runtime](platform/host-runtime/README.md) reconciles enabled Host services, while the workbench observes the same source and activates enabled UI contributions on demand.

Installation adds immutable packages to the available catalog; explicit composition nodes decide which contributions are active. Installed UI plugins run as trusted code in the workbench VM using its NSH and Host client capabilities, without a separate UI sandbox. Host call admission still checks the live caller activation, method grant, input schema and resource custody on every request. Local IPC connections carry only the method and recovery grants issued by their launcher.

Updating a composition preserves unchanged activations and their captured bindings. Modified or removed instances stop accepting new work and settle accepted calls and native resources before retirement. Accepted Host work and mutation receipts remain with their original owner even if a UI component unmounts or a client disconnects.

Desktop, terminal pixel rendering and terminal Unicode rendering execute the same TSX/NSH workbench. UI modules export `activate(context)` under an NSH reactive owner and register roots, views, commands, panels, settings pages and tool renderers; optional `prepareReload()` hands off JSON state across VM reloads for the same instance and package identity.

## Root persistence, receipts and resource custody

[EventLog](platform/event-log/README.md) (`maka-event-log`) owns generic State Root persistence: one exclusive OS file lease (`RootOwner`) and one SQLite database (`RootStore`) per Root. A single serialized writer queue commits mutations while independent reader lanes serve committed snapshots and a disposable observation lane maintains derived transcript and FTS caches. Domain crates register SQL migrations on `RootStore` rather than opening separate Agent databases or maintaining distributed/TTL leases.

Stable plugin state belongs to `(Root, deployment, instance)`. Package revisions and activation epochs identify code and live execution, never a new data namespace.

Side-effecting Host calls use a two-phase ledger separating caller intent from provider settlement:

- **Caller intent (`CallerIntent`)**: Before a mutation enters provider admission, the Host records the caller's locked `RecoveryRef` (target deployment, instance, export, method, operation UUID, request fingerprint and contract digest) together with an opaque caller-supplied recovery descriptor. A live native owner activation may query its own caller journal without gaining cross-provider execution or recovery grants.
- **Independent `Outcome` and `Cleanup`**: Provider receipts (`application_operations`) track business outcome (`NotExecuted`, `Returned`, `Unknown`) separately from physical resource cleanup (`Unconfirmed`, `Confirmed`, `Failed`), each advancing monotonically.
- **Strict non-execution and unknown boundaries**: Once caller intent is recorded, a missing provider receipt never proves non-execution. `NotExecuted` requires either authoritative absence from the caller's own intent journal or a provider proof that fences late admission. In-flight interruptions resolve to `Unknown`, which blocks automatic re-dispatch while still accepting late authoritative settlement (`OperationResolvedLate`) without rewriting already consumed history cuts.
- **Same-transaction state publication**: Pure native state mutations on the same Root commit atomically in the same SQLite writer transaction as their provider `Returned` receipt, with no network or subprocess I/O inside the transaction.
- **Evidence pinning and physical custody**: Unfinished runs, unresolved or `Unknown` operations, unconfirmed cleanups, active cells and immutable history snapshots independently pin their content-addressed blobs and receipts until both outcome and physical cleanup settle. Dropping an observer, stream EOF, timeout or Root retirement requests cancellation where applicable, but never proves resource cleanup.

## Durable Agent execution and interruption recovery

[Agent plugins](plugins/agent/README.md) separate canonical data, deterministic storage folding, execution decisions and live Host capabilities along a one-way crate boundary:

- **`facts`, `api` and `ports`**: Define canonical persisted records, public service contracts and execution traits without live Host handles.
- **`state` (`maka-agent-state`)**: Owns Agent SQL migrations on `RootStore`, canonical fact appends and same-transaction deterministic projection folding (concurrent run frontier, level-triggered waits, Code Mode cells, session data, artifacts, immutable history snapshots, session catalog, token usage and Recall). `state` never chooses next actions, schedules work or issues capabilities.
- **`engine` (`maka-agent-engine`)**: Implements the single typed durable reconciler and driver. Online turns, tool approvals and forms, model backoff retries, semantic context compaction and cold-restart recovery all advance through the same frontier reconciliation loop.
- **`authority` and `native` (`maka-agent-authority`, `maka-agent-native`)**: Hold live `Activation` custody and single-driver claims, intersect opening `RunSpec` bounds with current workspace permissions, bind model/tool/executor adapters and drive indexed ready or due runs.

Key execution invariants:

- **Stable identities, no physical handoff chains**: A logical run keeps one `RunId` across approvals, retries, context compaction and Host restarts, structured into stable `StepId`s and upstream `ModelAttempt`s (a new `ModelAttempt` represents an actual upstream generation request, not a local driver restart). Manual continuation after a terminal `Failed` or `Cancelled` run starts a new `RunId` over a verified historical source cut.
- **Concurrent obligation frontier and original outcome reconciliation**: Streamed model tool calls, local/service tool dispatches, user interactions and background cells form an explicit obligation set. The Host checks original receipts before proceeding. If it cannot reconcile an effect, the Run fails with that uncertainty preserved and further work stays fenced while the effect is unsettled.
- **Code Mode (`Cell` and `SessionData`)**: Code Mode persists `Cell` lifecycles (`CellStarted`, `CellCompleted`, `CellInterrupted`), nested child-effect bindings, discovered tools and session key-value updates (`SessionData` published atomically with accepted cell completion). Interrupted cells reconcile all admitted child effects before replanning; Maka never snapshots V8/Python heaps or replays arbitrary scripts on recovery.
- **External executors**: The built-in Claude Code, Codex and Antigravity CLI adapters run in the original workspace with native full access. `TaskOwner` owns their process and records its evidence. The separate ACP service adapter (`acp-executor`) uses a private workspace and publishes accepted changes through the Host. Stored transcripts, metadata and workspace snapshots never grant execution or permission authority. The running Host closes its original process groups during graceful shutdown. Recovery after Host loss reads the original evidence and keeps the task outcome unknown when the evidence cannot establish it.
- **Higher-level Agent coordination**: Ordinary parent/child Agent sessions, `Assistant` (Bot), `Goal` and `Scheduler` coordinate through public Session contracts, durable token/step budgets and stable `RunId`s.

## Development, CI and distribution

Each CLI build embeds the authored product bundle, and each workbench build embeds its TSX application. UI plugin packages load through the immutable package store, so installing or updating plugins requires no client rebuild, and rebuilding executables preserves an installation's committed composition.

Rust contracts generate [`@maka-agent/plugin-sdk`](packages/plugin-sdk/README.md) through [maka-schema](tools/schema/README.md) without building V8 or the full product. `just` and GitHub Actions share suite routing, `cargo nextest` archive packaging and isolated replay definitions in [`scripts/ci.mjs`](scripts/ci.mjs). The npm [`@maka-agent/cli`](packages/cli/README.md) package is a thin launcher for platform-specific native executables.
