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
- Projection transport contexts live with the authoritative Maka UI prop
  contracts. GoalProvider writes them; the two authorized Desktop leaves read
  and hand them to the real UI prop sites without owning or accepting those
  values from AppShell. The feature must not import the leaves back into the slice.
- Goals must not import `AppShell`, the preload implementation, or the main process.
- Desktop I/O enters through `GoalServices`; feature code never reads the
  Desktop global bridge directly.
- `AppShell` supplies the active Session id, whether the current interaction may
  open the dialog, and a session-scoped error-reporting intent. It does not read
  the controller, its model, or a Goal context.

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
- A reconnecting arm result closes only when the Host confirms a new Goal.
  Reconciled or unavailable results lock the form and show the authoritative
  outcome, preventing an accidental duplicate arm request.
- Form input and errors reset on each open. Budgets are validated against core
  bounds and are never silently clamped.

## Public surface and render ownership

- `<GoalProvider>` is the only production caller of `useGoalController`. The
  controller hook is intentionally absent from the production barrel.
- `ChatComposerRegion` consumes only `openDialog` and `active`, then binds them
  at the authoritative `Composer` props.
- `ChatMessageSurface` consumes only the Goal indicator, then binds it at the
  authoritative `ChatView` prop.
- `<GoalHost>` reads the dialog model directly from the provider.

The three projections use separate contexts. Iteration/token updates therefore
do not repaint the Composer, and dialog state does not repaint either chat
surface. A non-reader child under `GoalProvider` retains the element built by
its parent and does not re-render for Goal-only updates. The transport keeps
AppShell out of the values and gives TypeScript a checked prop handoff at each
actual UI reader instead of relying on a structurally loose cloned element.
Other Composer and ChatView instances under AppShell do not consume these
contexts, so WorkHub and Workbar cannot inherit the main Session's Goal.

Production code must not export or invoke `useGoalController` outside
`GoalProvider`, pass a controller model back through `AppShell`, or replace the
narrow contexts with one catch-all controller context. The AppShell hook gate,
renderer debt ledger, and Goals boundary tests lock those constraints.

The Desktop adapter is created once in the renderer composition root. Tests
use `createFakeGoalServices` from `testing.ts`; production code must not import
that entry.
