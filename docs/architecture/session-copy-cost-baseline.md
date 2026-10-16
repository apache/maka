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

# Session copy cost baseline

This document records the current storage boundary for Session branch/revision
copies and defines the reproducible baseline for issue #5439.

## Current boundary

The Host treats a branch or revision as a materialized, self-contained Session.
`packages/runtime-host/src/server/session-revision-coordinator.ts` captures a
settled source slice, creates the target Session, then publishes copied state
across the following stores:

| Domain | Current copy behavior | Identity after copy |
| --- | --- | --- |
| Session header | New target row; source metadata is projected into it | New Session id |
| transcript messages | Runtime ledger is replayed into target projections | New message/run/event ids where the domain owns identity |
| Runtime Events | Immutable events are cloned into the target Session | New target Session/run/event identities |
| AgentRun operational events | Copied for the selected run closure | New target run/event identities |
| model-call facts | Rebuilt from the copied run ledger and projection transitions | New target ledger facts; source usage facts are not shared |
| task ledger / Todo | Target Todo state is initialized from the selected branch boundary | New target Session ownership |
| artifacts | Payloads are copied into target-owned artifact records | New artifact ids and target paths |
| context-offload references | Reference rows are copied, while the content-addressed `blobId` is reused | New target reference; shared blob payload |
| linked child Sessions | Rejected, preserved with validated external ids, or snapshotted depending on copy kind | Explicitly controlled per reference mode |

The important existing sharing boundary is context offload: `copyReferences`
creates target-Session references without duplicating the blob bytes. The
ordinary conversation copy path does not currently apply that ownership/payload
split to transcript, Runtime Events, model-call facts, Todo state, or artifact
payloads.

## Measurement

Run the benchmark after building the workspaces:

```sh
npm run build
npm --workspace @maka/runtime-host run benchmark:session-copy
```

The benchmark creates real settled turns through the Runtime Host, invokes the
production `session.branch.create` handler, and reports:

- median copy latency in milliseconds after one warmup copy and five measured
  samples;
- storage bytes added under the temporary interactive root;
- source and child projected message counts;
- source and child invocation counts;
- message-count amplification.

The default fixtures use 4, 16, 64, and 128 settled turns. Each turn contains a
256-byte user payload and uses the deterministic FakeBackend. This is a
transcript/runtime-ledger baseline; it intentionally does not claim artifact or
context-offload coverage until fixtures for those payload classes are added.

The byte delta is measured after the warmup copy and immediately before and
after the measured copies, then reported per measured copy. It includes SQLite
journaling and metadata writes, so the number is an operational write-volume
proxy rather than a logical row-size estimate. Run the same command on a clean
machine and record the output with the commit, Node version, filesystem, and
platform.

## Interpretation

This baseline answers the first question in #5439: whether the current copy
cost grows with the retained history and whether the dominant growth is in
runtime/transcript state. It does not choose a shared-prefix design. A future
prototype must add comparable measurements for:

1. artifact payloads and `session_file` references;
2. context-offload references and shared blob bytes;
3. export/import closure materialization;
4. parent continuation, parent deletion, repair, and restart stability.

The baseline should be kept as the materialized-copy control group when those
experiments land.
