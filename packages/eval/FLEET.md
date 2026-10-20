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

# Fleet scheduling (mock workers)

This implements the coordinator/worker contract proposed in [RFC #5284](https://github.com/apache/maka/issues/5284), with remote VM execution and transport mocked. The coordinator state machine, durable local storage, artifact checks, and worker outbox are exercised directly by a deterministic simulation. No cloud VM, Kubernetes, Docker, provider credentials, or live inference is needed to run it.

`maka eval run` continues to use the existing single-host runner. There is no network daemon or fleet CLI deployment command yet. The library exports `FleetCoordinator`, `FileFleetPersistence`, `FleetWorker`, their protocols, and the pure `transitionFleet` function for the next transport integration.

## Run and replay

With workspace dependencies built:

```sh
npm --workspace @maka/eval run simulate:fleet -- 42
node --test packages/eval/dist/__tests__/fleet.test.js
```

The simulation outputs its seed, virtual elapsed ticks, selected results, and event trace as JSON. Running the same seed produces the same trace and state, including attempt identities. Tests replay seed 42 twice and exercise seeds 0–15, checking invariants after every tick. To replay another seed, replace `42` with a uint32 value. CLI output can be redirected to retain a full run trace.

Three mock VMs dynamically process 40 task groups (120 cells). Faults include request loss, lost replies after a successful commit, a worker network partition, a worker process crash, coordinator disconnection/restart, delayed cell completions, and missing usage on otherwise valid outcomes. After a bounded fault window, connectivity returns and pending work must converge. Separate tests inject storage failure before and after commit, check filesystem recovery and artifact integrity, and exercise admission failures, retry exhaustion, and partial group recovery. This is a deterministic application simulation, not a simulation of a kernel, Docker, or cloud infrastructure.

## Ownership and capacity

- `ExperimentSpec.execution.maxConcurrentTaskGroups` is the global active-assignment cap. Each worker declares fixed group slots. A group remains assigned until all cell reports are committed and the worker finishes the group, or ownership expires.
- A group is `task × repetition`, and its pending cells run on one worker. A replacement assignment contains only cells without a selected result and with remaining attempts. A selected zero or subject failure is preserved.
- A worker ID identifies one process incarnation. A VM reboot must use a new ID; continuing to use an ID after losing its in-memory execution/outbox state is unsupported.
- `FleetPolicy.environmentId` names the required, reviewed code/benchmark/toolchain/image manifest. The current mock worker advertises that identity. A real adapter must verify it, not merely echo it. CPU/memory reservations cover a whole group's execution **and verification**, multiplied by worker slots. Deriving requirements and verifying real VM capabilities belong to the future adapter.
- Group retry waits for `retryBackoffMs`. `maxAttemptsPerCell` counts dispatches, including a dispatch lost before execution can be confirmed. Exhaustion remains incomplete evaluation, never a fabricated score.

## Recovery and evidence

Workers register, heartbeat with owned assignment IDs, and claim available work. Heartbeat replies also recover assignments whose claim acknowledgement was lost. Cell outputs stay in the worker outbox until artifact upload and result commit are acknowledged. Duplicate submission of the same report is idempotent; conflicting content is rejected. Outboxes currently survive network disconnection only; VM/process death loses uncommitted local state and invokes bounded cell retry.

Call `pause` when the coordinator's deployment detects its own disconnection or suspends scheduling. It freezes dispatch and lease expiry. Workers continue already assigned work and buffer results. Call `recover` before resuming; opening a coordinator performs this automatically. Recovery marks workers as needing reconciliation and grants outstanding assignments a recovery grace interval. It does not immediately expire every worker after a long local outage. Workers that fail to reconcile eventually expire. The core cannot infer a local network outage from missing worker heartbeats; detecting local connectivity belongs to the transport/deployment layer.

Each assignment has a new generation and each dispatched cell has a unique attempt ID. Expired assignments cannot supply selected results. Their late reports remain available as evidence and contribute to observed costs. Already selected results are immutable. Assignment expiry permits duplicate physical execution during partitions; it does not kill a remote process or guarantee exactly-once inference. Capacity limits apply to authoritative assignments, not unreachable zombie processes.

`FleetReport` separates execution, verification, usage, and cleanup evidence. Valid verification following completed/failed subject execution and confirmed cleanup is selectable, even if metering is incomplete. Raw reports are retained; the result summary projects the settled outcome independently of a coarse `indeterminate` status. Missing usage alone does not rerun a cell. Unknown execution or cleanup, or invalid/missing verification, requires a cell retry. Provider request recovery remains the execution adapter/Runtime Host's responsibility.

A deterministic `environmentFailure` pauses dispatch for this run until an operator issues `repair` with that reason. Already running groups are allowed to settle. This conservative run-wide block avoids repeating the same defect across workers; task-specific routing is not implemented. There is no verification-only recovery, environment snapshot restoration, or within-group straggler optimization.

## Local persistence

Use a separate fleet directory; its state format does not replace or import the existing local `FileAttemptStore` format:

```ts
const persistence = await FileFleetPersistence.open('/absolute/path/to/fleet-run');
const coordinator = await FleetCoordinator.open({
  persistence, spec, policy, now: Date.now,
});
// Inject a FleetTransport and FleetGroupExecution into each FleetWorker.
// Poll workers periodically and drive coordinator tick while online.
// Commands are serialized, and replies follow durable state commits.
await coordinator.close();
await persistence.close();
```

The spec and policy are frozen by run identity: reopening with different values fails. State uses an atomic, checksummed snapshot with fsync before acknowledgement; the parent directory is synced on POSIX. Artifacts use content-addressed files and are checked for length and SHA-256 before accepting their references. Only artifacts listed in `FleetReport.artifacts` have this durability contract; legacy metadata in `EvalResult.artifacts` is not a substitute for uploading bytes. These are evaluation artifacts, not a restorable VM snapshot.

The directory has one lifetime writer lock. Close the coordinator before its persistence. After a process crash, confirm that the old owner is dead before manually removing a stale `.writer.lock`; the library does not steal locks. Memory persistence provides the same interface for simulation but is not durable across host process death.

`summarizeFleet` separates selected results from the sum of all reported costs, including retries and late attempts. `observedCostUsd` is only the known subtotal. `usageComplete` is false if any dispatched attempt lacks a complete usage report; VM loss cannot be reported as zero usage. Provider quota scheduling and accounting for unobservable remote work remain outside this mock phase.
