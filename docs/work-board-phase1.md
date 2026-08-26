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

# Work Board Phase 1 — capture/list MVP

## Surface

A compact Work Board tab in the session workbar, next to Tasks, with:

- global Inbox and current-project filtering;
- manual create, rename, move (Inbox <-> project), complete / reopen,
  archive / restore, and delete (archived items only);
- empty, loading, and error states;
- local-first persistence through the existing operational-state database.

## Boundary

- The Desktop main process owns `WorkBoardStore`; the renderer is a read-only
  IPC projection that reloads on the `workBoard:changed` signal.
- No Runtime Host involvement, no model-visible tools, no turn-tail injection.
- `linkedSessions` and the linked-session projection remain deferred to Phase 3.

## Why a dedicated store instead of a project file

A project `TODO.md` / issue would cover the literal capture-and-list atom, but
the one thing that justifies a store is **provenance + Session linking**:
side-conversation captures must keep typed source references and a bounded
excerpt after the temporary fork is deleted, and Phase 3 must link a board item
to the Session it starts. Typed provenance and stable item identity also let
concurrent Desktop writers mutate items with revision CAS instead of parsing a
file. If provenance and Session linking were not in scope, a project file would
suffice.

## Assumption

We are betting that users will return to the board and start tasks from it.
Phase 3 must prove this.

## Sequencing

Per maintainer review, the thin capture -> revisit -> start-as-task loop is
validated **before** Phase 2 (side-chat capture) and Phase 4 (evidence /
refinement): a minimal, flag-gated Phase 3 spike wires one hard-coded item ->
"Start task" -> new Session -> link back, with no polish. Only if the loop
shows real use do we resume Phases 2 and 4.

## Implementation

- Main: `apps/desktop/src/main/work-board-ipc-main.ts`
  (`workBoard:list/create/update/archive/unarchive/remove` + change signal).
- Preload: `window.maka.workBoard` in `apps/desktop/src/preload/preload.ts`.
- Renderer: `useWorkBoard` hook and `WorkBoardPanel`, wired as a workbar tab in
  `session-workbar.tsx`.
