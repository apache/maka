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

Owns the State Root's SQLite database, physical writer lease, application records,
Session resources and checkpoint publication. Agent facts, history, indexes and
content ownership live in [`maka-agent-state`](../../plugins/agent/state).

- [`root`](src/root.rs) and [`root_store`](src/root_store.rs) bind work to the current
  Root and coordinate shutdown with accepted operations.
- [`connection`](src/connection.rs) runs a bounded writer FIFO and read lanes on
  dedicated threads. [`writeback`](src/writeback.rs) commits typed statements and
  publishes their scoped invalidation hints only after a confirmed commit.
- [`root_store::data`](src/root_store/data.rs) supplies Root- and Session-scoped SQL
  access. Domains can commit their state with an original Host operation receipt
  in the same transaction.
- [`applications`](src/applications.rs) stores application sources, deployments,
  intents and operation outcomes.
- [`checkpoints`](src/checkpoints.rs) and
  [`root_store::checkpoints`](src/root_store/checkpoints.rs) publish immutable
  snapshots and Workspace objects, verify exact Heads and settle prepared
  restores after a process restart. The domain supplies the history snapshot.
- [`schema`](src/schema.rs) defines the current Root schema;
  [`migration`](src/migration.rs) validates the composed migration ledger.
  Products compose Root and domain migrations when opening the store.

## Checkpoint repository assembly

[`checkpoints::repository`](src/checkpoints/repository.rs) separates immutable
object storage from logical Session identity, Head CAS and original commit
receipts. A logical Session/agent binding is durable; Root/scope/native Session
remain source provenance. A missing expected revision means create-if-absent;
conflicts never retry against a newer Head. Exact checkout verifies all
object bytes and Workspace closure, compares Manifest provenance with the persisted
logical Session Binding, and rejects a Head or Binding that moves during verification. The canonical history owner remains responsible for its format
and semantic validation.

The existing publisher and reads use these ports. `RootStore::open` keeps the
local adapter and existing Head table. Trusted bootstrap can instead pass a
`Storage` pair to `RootStore::open_with_checkpoint_storage` before opening a
Host. `FileRepository::open` supplies a durable reference implementation outside
worker Roots: SQLite arbitrates independent processes and files hold immutable
objects. Each adapter owns a bounded connection worker; clones share that worker,
while independent adapters/processes arbitrate through SQLite. Its schema and identity
column are independent of the worker Root migration catalog. Initialize this blocking
adapter on a physical I/O lane. It supports
Unix local filesystems, not network-filesystem or distributed-database leases.

A shared Root keeps capture/recovery records but no local Head. The repository
commits Head and its receipt together; a lost response is resolved by querying
the original operation, without recapture. Transient object-read failures leave
prepared publications recoverable; missing or invalid material cannot advance
Head. Head lookup does not claim a new source scope. Startup requires the same repository,
object-store and agent binding. Existing local publications require an explicit
migration before switching authorities. The reference adapter's directory must
be private and outside the captured Workspace. Objects are retained without GC;
external streaming publication uses an independent temporary copy before durable storage.
The local adapter promotes already verified private staging files without copying and
syncs the object directory before recording Prepared. Fresh local commits carry that
capture's verification witness; recovery and external publication verify retained bytes.
Root-private SQL stays in `root_store::checkpoints::local` and Root assembly in `authority`.

`Storage::checkout_exact` can read a logical Session after its source Root is
gone. It selects only the current retained Head: publishing r2 makes r1 unavailable to
checkout even while its objects and original receipt remain. It grants no execution authority. Shared loading/restore, activation leases,
cross-Root handoff and concrete cloud transports are separate follow-ups. Local
restore and portable export retain their existing behavior; the operator CLI
is not an external-repository configuration surface. Credentials, runtime images
and full auxiliary Agent state are not added to checkpoint payloads.

Run `cargo nextest run -p maka-event-log` for the registered tests. The
`root_lease`, `checkpoint_restore` and `checkpoint_repository` integration
binaries isolate their process-spawning checks from other tests' Root leases.
