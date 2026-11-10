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

Run `cargo nextest run -p maka-event-log` for the registered tests. The
`root_lease` and `checkpoint_restore` integration binaries isolate their
process-spawning checks from other tests' Root leases.
