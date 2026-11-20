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

## Execution authority

`checkpoints::execution::ExecutionAuthority` is a trusted control-plane port, separate from the immutable object store. Its grant binds a logical Session, stable activation ID, generation, exact starting Head and sandbox/tool ceilings. `claim` and `renew` replay their original durable result for the same request, including rejection; an old successful receipt does not mean the grant is active now. Use `observe` for current status.

A trusted embedding claims the grant, calls `Execution::attach`, then supplies `Storage::with_execution` to `RootStore::open_with_checkpoint_storage` before opening the Host. This first increment binds one native Session in its existing Root/deployment/namespace; it does not load or resume that identity in a different Root. A Root remembers its execution configuration and cannot reopen as unrestricted local storage. Opting in is allowed for a Root with no local checkpoint identity or publication, or an existing shared repository with no unfinished publication. Changing an established grant requires a separate activation/migration flow.

The native Owner checks the grant at message/run admission and at live model/tool authorization. Tool selection and sandbox permission are intersections with the grant ceiling. External executor backends are not admitted in this first increment. Host observation runs every 250 ms; each observation has a five-second deadline. Revocation, expiry or an observation failure cancels local work irreversibly and starts Host shutdown. This is cooperative cancellation of admitted work, not instantaneous revocation of remote side effects. An authority adapter must authenticate callers and provide linearizable decisions; possession of serialized grant fields is not a bearer credential.

`FileRepository` also provides a durable single-machine reference coordinator. Its generation check, expected-Head CAS and original publication receipt share one SQL transaction. Once a Session has been managed, plain repository commits cannot bypass execution checks. Replaying a committed operation after revocation returns its original receipt without writing again. The reference adapter is not a distributed lease service and makes no automatic takeover promise based on wall-clock expiry.

For planned handoff the supervisor calls `Host::stop_execution`. The Host closes transports, cancels/drains plugins and managed processes, and awaits Root/SQL cleanup before acknowledging `Stopped`. Cleanup failures remain failures on repeated shutdown. Only that acknowledgement permits another generation; timeout, lease expiry, loss of contact or a failed cleanup leave takeover blocked. An external `Environment` adapter must cover the original environment and all managed writers, not merely kill a parent PID. Unmanaged editors or remote third-party effects require their own isolation/settlement; this interface does not make an unverified Workspace snapshot consistent.

Default local Hosts remain outside this optional execution mode. These Rust ports introduce no cloud vendor, Kubernetes, CLI configuration, cross-Root activation or automatic checkpoint trigger.

## Testing

```sh
cargo nextest run -p maka-event-log
```
