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

# Memory Network — Maka plugin

A shared history organization layer, independent of task execution. Agent-defined indexes have free-form criteria and entries; every entry cites immutable original fragments. Reverse links let an Agent move from an entry to evidence and on to another index. Recall stays available for direct historical search.

## Use

Install the extension package in a Maka build containing the generic `sessionQuery.historyList/historyRead` capability. Enable its profile composition entry. No UI or scheduler is required; its tools become available to ordinary and continuing conversations.

Ask the Agent, for example: “Create a procurement timeline and a candidate Todo index from my session history. Keep citations; verify candidates against later records before suggesting action.” The Agent uses its existing runtime to organize batches, rather than running a second hidden decision loop.

- `MemoryIndexCreate`: define name, instructions, optional Session IDs. Empty scope includes all currently Recall-visible Sessions and future Sessions. Returns the first batch; creation is not a claim that indexing is complete.
- `MemoryIndexRead`: synchronize history and return existing entries plus the next unorganized batch. Reading alone never advances coverage.
- `MemoryIndexEntries`: page older entries.
- `MemoryOriginal`: original fragment, adjacent source locations, and backlinks across indexes.
- `MemoryIndexCommit`: edit/remove entries and advance coverage atomically for a specific issued batch. Same-batch replay is idempotent; stale competing submissions fail.

Index text has no fixed task/status schema. A changed criterion should get a new index. No candidate Todo automatically becomes a task or authorizes an external action.

## Storage and consistency

Plugin-owned SQLite uses WAL. Original message JSON is retained as immutable versions with Session/message identity and observation time. Long records are split into lossless 8,000-character fragments; references identify exact versions and parts. No rewriting of Maka's session store. Links and index coverage are committed together, with an append-only commit audit.

Coverage is a local observed-fragment sequence, not wall-clock time. Each batch freezes its revision, visible scope and upper bound. New source arrivals remain unprocessed; update crashes cannot advance coverage. New Sessions append as incremental originals without rescanning old history. Restoring visibility to older cached originals rewinds coverage only as far as needed, without deleting original evidence or entries. Deleted entries remove derived links only. Unavailable or private history is not silently marked covered; historical cached sources are gated by current Host visibility when read.

Source synchronization currently reads full visible Session snapshots through the Host API on create/read. It is correct but not optimized for huge histories; new source ingestion is on demand, not a background subscription. Batch organization is resumable and bounded; model semantic accuracy is not enforced by SQLite. Initial full organization takes as many batches as the corpus requires. No periodic model maintenance, email/calendar connector or graph UI is included yet.

## Build and verify

Requires Node 22.19+ and repository dependencies for the Host test adapter.

```sh
npm install
npm run verify
```

The bundle is `release/memory-network.maka-extension`. `dataDirectory` is optional; an isolated path is persisted through Maka plugin storage by default. No API key or extra model service is needed: the calling Agent organizes the index.

Validation results and the opt-in real Flash scenario are documented in [TEST-REPORT.md](./TEST-REPORT.md). The first release is tool-only: no graph UI, automatic background model maintenance or external-source connector.
