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

# Work Board Phase 3 — Start-task validation spike

This is a temporary, default-off experiment validating the
`capture -> revisit -> start` loop.

For local dogfooding, enable it only in a development renderer with
`VITE_MAKA_WORK_BOARD_START_TASK=1`; production builds keep the entry hidden.

## Scope

- only project-scoped items whose project identity resolves through the Task
  Entry catalog to one available, non-archived `(profileId, hostId, projectId)`;
- Inbox items and ambiguous/unavailable Host targets remain disabled;
- the existing New Task surface and Composer first-send path create the Session;
- the draft contains only the bounded item title and optional notes;
- a successful first send adds an idempotent Host-scoped `linkedSessions` entry;
- opening a link navigates through the existing Desktop Session identity path.

The spike does not add side-chat capture, model-visible Work Board tools,
turn-tail injection, execution-state projection, result refs, automatic
completion, prioritization, or a persisted feature setting.

## Evidence checklist

For each dogfooding run record whether the item pre-existed, the resolved Host
and project, normal first-send completion, restart/reopen behavior, duplicate or
orphan Sessions, and any manual repair. Record an explicit `go` or `stop`
decision before starting Phase 2 or Phase 4.

## Run record

**Run:** 2026-09-28 local development renderer, with
`VITE_MAKA_WORK_BOARD_START_TASK=1`.

- **Item:** `Phase 3 dogfood fixed`; the item did **not** pre-exist. It was
  created in the Work Board's current-project view and then revisited from the
  board before selecting **Start task**.
- **Resolved target:** profile `local`, Host
  `ceeaf9c96959c19f67f044adc9e05ba959f4810d576ff13498922e2da1ecaffe`, project
  `cf023c18-e57a-4dbc-9a47-fbe277892e63` (`maka`, the checked-out project).
- **First send:** Start task opened the normal New Task surface with the item
  title pre-filled. The first send entered streaming and completed normally in
  approximately 2 minutes 35 seconds.
- **Revisit/reopen:** after closing and restarting the development app, the
  Session reopened with the same title and transcript. Selecting **Current
  project** in Work Board showed the item with **Open session**; selecting it
  resolved to the same Session ID
  `9a5a1cd1-c0a1-4be0-9510-97cef234db28`.
- **Duplicate/orphan check:** the persisted item had revision `2` and exactly
  one `linkedSessions` entry for that Host/Session pair. No duplicate or orphan
  Session was observed.
- **Manual repair:** none.
- **Evidence commands:** `node scripts/apply-dependency-patches.mjs && npm run
  build`; focused Work Board command
  `node --test apps/desktop/dist/main/__tests__/workbar-controller.test.js
  apps/desktop/dist/main/__tests__/work-board-panel.test.js
  apps/desktop/dist/main/__tests__/work-board-ipc-main.test.js
  apps/desktop/dist/main/__tests__/task-entry-controller.test.js
  packages/core/dist/__tests__/work-board.test.js
  packages/storage/dist/__tests__/work-board-store.test.js` (106 passed, 0
  failed); and a direct SQLite read of `workflow_work_board_items` confirmed
  the revision, link count, Host ID, and Session ID above. These are local
  development-run observations; CI did not perform the manual renderer run.

## Decision

**GO** (2026-09-28, based on the run record above). The loop was dogfooded on a
development renderer with `VITE_MAKA_WORK_BOARD_START_TASK=1`, and the full
capture -> revisit -> start chain was verified:

- a project-scoped item can start a task;
- a normal Session is created with the item title pre-filled;
- the first send completes normally;
- `linkedSessions` persists with exactly one Host-scoped link;
- restarting Maka restores the same Session;
- "Open session" from the Work Board still resolves to the original Session;
- the build and the 106 focused tests pass.

A few React development-time console warnings were observed and do not affect
the chain above.

This decision covers the Phase 3 validation spike only. It is not approval to
start Phase 2 or Phase 4; those still follow the maintainer's roadmap decision.
