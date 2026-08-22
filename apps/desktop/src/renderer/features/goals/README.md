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

# Goals feature

Goals is a vertical renderer feature. It owns the active Goal read model,
Goal-change subscription, arm/pause/resume/clear controls, dialog target, and
the Goal indicator projection consumed by the chat surface.

## Dependency direction

- Consumers import production APIs from `features/goals`.
- Tests and stories may additionally import `features/goals/testing`.
- Goals may use shared renderer copy, core types, and Maka UI.
- Goals must not import `AppShell`, the preload implementation, or the main process.
- Desktop I/O enters through `GoalServices`; feature code never reads the
  Desktop global bridge directly.
- `AppShell` supplies the active Session id and a session-scoped error reporter.
  It consumes only `<GoalHost>`, commands, and selectors.

## Lifecycle invariants

- A Goal is session-scoped. Switching Sessions clears the previous read model
  synchronously and fences late reads before fetching the new Goal.
- Only `active`, `waiting`, and well-formed `paused` Goals are projected. A
  settled Goal removes the indicator and composer active state.
- Goal-change broadcasts refresh the active Session; events for another
  Session do not.
- Pause and resume are mutually exclusive per Session while a control request
  is pending, preserving the existing re-entry guard.
- Opening the dialog snapshots the active Session id. Navigating while it is
  open cannot retarget the arm request to a different Session.
- Form input and errors reset on each open. Budgets are validated against core
  bounds and are never silently clamped.

## Public surface

- `host` is passed intact to `<GoalHost model={goals.host} />`.
- `commands.openDialog` is the shell entry for the composer action.
- `selectors.active` disables duplicate Goal creation and
  `selectors.indicator` feeds the active chat surface.

The Desktop adapter is created once in the renderer composition root. Tests
use `createFakeGoalServices` from `testing.ts`; production code must not import
that entry.
