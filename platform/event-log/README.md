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

# maka-event-log

[简体中文](README.zh-CN.md)

`maka-event-log` owns durable State Root storage: the exclusive OS process lock (`RootOwner`), the SQLite database (`RootStore`), two-phase Host operation journals, and immutable checkpoint publication. Higher-level Agent facts and projections register migrations on top of `RootStore` from [`maka-agent-state`](../../plugins/agent/state/src/lib.rs).

## Key modules

- [`root.rs`](src/root.rs) & [`root_store.rs`](src/root_store.rs) — Acquire the exclusive State Root lock and coordinate graceful shutdown with admitted in-flight operations.
- [`connection.rs`](src/connection.rs) & [`writeback.rs`](src/writeback.rs) — Run a single serialized SQLite writer FIFO alongside concurrent snapshot reader threads, publishing scoped invalidation signals only after commits succeed.
- [`root_store/data.rs`](src/root_store/data.rs) — Root- and Session-scoped SQL statements that let native services commit domain state atomically alongside a Host operation receipt.
- [`applications.rs`](src/applications.rs) — Persistence for deployment sources, caller intent records, and provider operation receipts (`Outcome` + physical `Cleanup`).
- [`checkpoints/`](src/checkpoints.rs) — Content-addressed workspace & history checkpoint publication, CAS Head updates, and crash-safe restore settlement.
- [`schema.rs`](src/schema.rs) & [`migration.rs`](src/migration.rs) — Base Root schema and composed domain migration verification.

## Checkpoint repositories

`checkpoints::repository` decouples immutable blob storage from logical Session bindings and CAS Head commits:

- **Default local authority (`RootStore::open`)** — Stores checkpoint Heads in the Root SQLite database and promotes verified staging files directly via zero-copy local links after `fsync`.
- **External repository authority (`RootStore::open_with_checkpoint_storage`)** — Accepts a pluggable `Storage` pair. `FileRepository::open` provides a multi-process local-filesystem reference adapter arbitrated by its own SQLite database outside worker Roots.

Exact checkout (`Storage::checkout_exact`) verifies all object digests and workspace closure against the persisted logical Session binding before returning the current Head, without granting execution authority.

## Testing

```sh
cargo nextest run -p maka-event-log
```
