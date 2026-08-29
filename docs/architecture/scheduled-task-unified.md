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

# ScheduledTask — unified 定时任务

## Problem

Maka previously had multiple clocks:

1. Desktop-owned notification schedules
2. Runtime Host standalone session schedules
3. Daily Review's private scheduler, resident state, archive, and model-call path

The product word was one (“定时任务”), the data paths were two. Agent-created work never appeared in the desktop catalog.

## Design

One noun: **`ScheduledTask`**.

| Concern | Owner |
|---------|--------|
| Catalog + schedule math | Runtime Host `HostScheduledTaskCoordinator` + SQLite `workflow_scheduled_tasks` |
| Fire admission and recovery | Runtime Host (`workflow_scheduled_task_fires`) |
| Due effects | Runtime Host; Desktop is only a native delivery provider |
| Desktop/TUI/CLI access | bounded `scheduled-task.query` / `scheduled-task.mutate` protocol |
| Agent create/list/pause/resume/delete | `ScheduledTask` tool → Host coordinator directly |

### Effects

- `notify.local` / `notify.bot` — Host admits the fire, then invokes one Desktop native-effect
  provider. Desktop never reads or advances the catalog.
- `session_resume` — continue the creating Session with a new Turn and durable ScheduledTask origin.
- `agent_run` — freeze the execution template at create; on fire, Host creates a stable Session and
  admits the root AgentRun itself.

Daily Review is a Scheduled Tasks preset, not an effect or runtime domain. Existing enabled
Daily Review configuration upgrades once to a system-owned `ScheduledTask`. Existing reports
upgrade to ordinary Sessions with Markdown artifacts and transcript messages, after which the
legacy tables are retired. New review executions use `agent_run`; their transcript, recovery, and
artifacts therefore have the same owners as any other Session. If the old configuration cannot yet
resolve an immutable model Connection, report projection remains idempotent but retirement waits;
the inert legacy rows are retried on a later Host start after model setup and are never scheduled or
written by the new runtime.

### UI

The scheduled-task panel consumes `ScheduledTask` directly. Its preload facade uses the shared
`runtime-host:query` / `runtime-host:command` transport and the canonical Host protocol codecs.
Host change frames are signals only; Desktop re-queries the canonical record.

Daily Review remains visible under Automations, but it is now a product projection rather than a
runtime domain:

- Setup opens the ordinary Scheduled Task dialog with the Daily Review preset and freezes the
  current Agent execution template.
- Enablement, recurrence, next run, retry history, and manual trigger come from that
  `ScheduledTask`.
- The 1/7/30 day overview and its earlier/later navigation read ordinary Session activity and the
  canonical model-call usage ledger for the selected local-calendar range.
- Report history filters the Session catalog by the generic `scheduled-task:<taskId>` relation;
  migrated reports use the temporary `migrated:daily-review` provenance label.
- Opening a report enters the ordinary Session transcript, where its Markdown report is available
  as a normal Artifact. Existing transcript quoting and Artifact preview/copy/save actions replace
  the former report-only export controls.
- Managing the schedule selects the backing task directly in the Scheduled Tasks inspector. Agent
  tasks keep their frozen execution target while allowing their title, prompt, recurrence, and
  next fire time to be edited through the ordinary task form.

The migration banner is a retirement aid, not a permanent compatibility path. Once the legacy
snapshot has been materialized and its exact revision is still current, the migration drops the
old tables. New code never reads or writes them again, so there is no ongoing dual-read or
dual-write state.

### Authority invariant

Runtime Host is the only catalog writer, scheduler, clock, and fire admission authority. No
interactive client opens the ScheduledTask SQLite tables. Agent tools and every UI surface reach
the same coordinator, so ownership does not depend on which client initiated a Session.

Before an effect crosses its irreversible boundary, the Store persists one unique fire claim per
task. For `agent_run`, it also persists the stable Session/Turn/Run/message identity before Session
creation or execution admission. Recovery can therefore reconcile the exact Host execution
without creating a duplicate Session. Native delivery claims are not replayed after an unknown
outcome.

### Runtime boundary

Scheduled tasks keep Runtime Host resident even when the initiating client exits. `agent_run`
requires no Desktop. Local and bot notifications wait durably for a native-effect provider before
crossing the delivery boundary. Once invocation starts, an unknown outcome is recorded as failed
and is never replayed. Other interactive clients can create and manage the global catalog through
the same Host protocol. The separate Headless runtime is outside this interactive authority boundary.

## Key files

- `packages/core/src/scheduled-task.ts`
- `packages/storage/src/scheduled-task-store.ts`
- `packages/storage/src/legacy-daily-review-migration.ts` (one-time upgrade only)
- `packages/runtime/src/scheduled-task-tools.ts`
- `packages/runtime-host/src/protocol/scheduled-task.ts`
- `packages/runtime-host/src/server/scheduled-task-coordinator.ts`
- `apps/desktop/src/main/runtime-host-renderer-ipc-main.ts` (shared protocol transport)
- `apps/desktop/src/preload/runtime-host-renderer-operations.ts` (renderer allowlist)
- `apps/desktop/src/main/runtime-host-boot.ts` (native-effect provider)
