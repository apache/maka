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

Maka separates runtime infrastructure, domain plugins, and product assembly into three layers:

- **[Platform](platform/README.md)** — package loader, composition planner, SQLite persistence (`maka-event-log`), Host service lifecycle, V8/Python sandboxes, OS process isolation, Computer Use, and NSH UI support.
- **[Plugins](plugins/README.md)** — business capabilities (`agent`, `workspace`, `skills`, `settings`, `interactions`) and their public wire contracts.
- **[Products](products/maka/README.md)** — native factory registration, default plugin composition, the shared NSH workbench, CLI, ACP server, and terminal/desktop shells.

A plugin package (`package.ts`) is an authored deployment unit (`host`, `ui`, or `composition`), whereas a Cargo crate is a Rust compilation boundary. The two do not map 1:1: the Agent domain splits across multiple crates with strict one-way dependencies, while smaller plugin entries can share a single native crate.

## Package composition and UI runtime

1. The package loader validates immutable `.maka-plugin` bytes and addresses them by content digest.
2. The composition planner type-checks Host, UI, and composition instances against their configuration schemas and import/export contracts.
3. The State Root commits the desired deployment source and package bytes at a new monotonic revision.
4. `maka-host-runtime` reconciles enabled Host services in the background, while the NSH workbench observes the same source and mounts enabled UI contributions.

Installing a package adds it to the local store without activating it; explicit composition nodes control what runs. Reconfiguring a deployment keeps unchanged service activations alive, while modified or removed instances stop admitting new requests and drain in-flight operations before retiring.

Both the terminal shell (cell grid or pixel graphics) and the desktop window execute the same TSX/NSH workbench in a single shared VM. Trusted UI modules export `activate(context)` to register roots, views, commands, panels, settings pages, and tool cards; an optional `prepareReload()` hands off JSON state across live UI reloads for the same instance identity.

## State Root and two-phase operation journal

[maka-event-log](platform/event-log/README.md) owns persistence for each State Root: one exclusive OS file lock (`RootOwner`) and one SQLite database (`RootStore`). A single writer queue serializes commits, independent reader connections serve consistent snapshots, and a disposable background lane maintains derived transcript and FTS indexes. Domain crates register SQL migrations on `RootStore` instead of opening separate databases.

Persistent plugin state is keyed by `(Root, deployment, instance)`. Updating package bytes or restarting an activation never creates a new state namespace.

Side-effecting Host calls use a two-phase ledger that separates caller intent from provider settlement:

- **Caller intent (`CallerIntent`)** — Before a mutation reaches a provider, the Host records the caller's `RecoveryRef` (target instance, method, operation UUID, request fingerprint, and contract digest). On retry or restart, an owner inspects its own intent journal rather than blindly re-issuing mutations.
- **Independent `Outcome` and `Cleanup`** — Provider receipts (`application_operations`) track business `Outcome` (`NotExecuted`, `Returned`, `Unknown`) separately from physical resource `Cleanup` (`Unconfirmed`, `Confirmed`, `Failed`). Both advance monotonically.
- **Honest uncertainty** — Once caller intent is recorded, a missing receipt never proves non-execution. In-flight interruptions settle to `Unknown`, blocking automatic replay while still accepting late authoritative completion (`OperationObserved`) without rewriting historical cuts.
- **Atomic local mutations** — Pure state mutations on the same Root commit in the same SQLite transaction as their `Returned` receipt, with no network or subprocess I/O inside the write lock.
- **Evidence pinning** — Active runs, `Unknown` operations, unconfirmed cleanups, live Code Mode cells, and history snapshots pin their content-addressed blobs until both outcome and cleanup settle.

## Agent execution and crash recovery

The [Agent domain](plugins/agent/README.md) enforces a one-way crate dependency chain:

- **`facts`, `api`, `ports`** — persisted record types, public wire schemas, and execution traits (no live Host handles).
- **`state`** — SQLite migrations, canonical fact appends, and deterministic in-transaction projections (active run frontier, level-triggered waits, Code Mode cells, `SessionData`, artifacts, snapshots, catalog, usage, and Recall).
- **`engine`** — the deterministic reconciler and turn driver. Live turns, user approvals, model retries, context compaction, and cold-restart recovery all step through the same frontier loop.
- **`authority`, `native`** — live activation custody, workspace permission intersection, model/tool/executor bindings, and background run scheduling.

Core execution guarantees:

- **Stable `RunId`** — One logical run keeps its `RunId` across approvals, retries, compaction, and Host restarts, decomposed into `StepId`s and upstream `ModelAttempt`s. Continuing after a terminal `Failed` or `Cancelled` run starts a new `RunId` over a verified history cut.
- **Obligation frontier** — Streamed tool calls, user prompts, and background cells form an explicit obligation set. On restart, the engine reconciles original receipts first; if an effect's outcome cannot be established, the run fails explicitly rather than re-running side effects under a new ID.
- **Code Mode (`Cell` and `SessionData`)** — Code Mode persists cell lifecycles, nested tool bindings, and key-value `SessionData` (published atomically when a cell completes). Maka never snapshots V8/Python heaps or replays scripts on recovery.
- **External CLI executors** — Built-in adapters for Claude Code, Codex, and Antigravity run in the user's workspace under `TaskOwner` process custody, while the ACP service adapter (`acp-executor`) runs in an isolated workspace and publishes accepted edits through the Host.

## Build, SDK generation, and CI

`maka-schema` (`tools/schema`) exports Rust contracts into [`@maka-agent/plugin-sdk`](packages/plugin-sdk/README.md) without compiling V8 or the full product. CLI builds embed the default product bundle and workbench UI, while installed plugins load dynamically from the package store. Local `just` recipes and GitHub Actions share change-based test routing and `cargo nextest` archive execution in [`scripts/ci.mjs`](scripts/ci.mjs).
