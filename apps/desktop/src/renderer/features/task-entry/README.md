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

# Task Entry / Workspace feature

Task Entry owns the renderer state that chooses where a new task will run. It
loads the Runtime Host/Project catalog, preserves a selection per Host, derives
the new-task target and draft identity, projects the Workspace Picker, and owns
add/relink plus remote-directory handoff lifecycles.

## Dependency direction

- Consumers import production APIs from `features/task-entry`.
- Tests and stories may additionally import `features/task-entry/testing`.
- Task Entry may use shared renderer copy, shared project UI, core/runtime-host
  types, and Maka UI.
- Task Entry must not import `AppShell`, preload, or the main process.
- Desktop catalog I/O enters through `TaskEntryServices`; feature code never
  reads the Desktop global bridge directly.
- `AppShell` supplies explicit navigation/error intents and consumes only the
  target, Host defaults, project path, draft identity, and Workspace Picker.

## Lifecycle invariants

- Catalog refreshes are generation-fenced. A stale response cannot overwrite a
  newer Host/Project snapshot or drive an imperative directory handoff,
  including after unmount or locale changes.
- The current Host remains selected while it is available. Otherwise selection
  falls back to the available default Host, the first available Host, then the
  default/first unavailable catalog row for honest loading/error presentation.
- Project selection is remembered per Host. Missing, archived, and unavailable
  projects fall back through Host default, Host selected Project, then the
  explicit no-Project capability.
- Add/relink mutations are single-flight. Cancellation stays silent; failures
  preserve the selected target and retain the existing localized diagnostic.
- Remote directory registration is accepted only for the Host that opened the
  picker. Closing or completing the picker restores focus to its opener.
- Draft identity is target-scoped. An unresolved catalog always uses the stable
  unresolved new-task key, preserving reload and target-switch handoff behavior.

## Non-ownership

Session creation, first-send/task submission, Composer state, attachments,
readiness, Project Settings, and the shared remote-directory browser internals
remain separate. Task Entry supplies their target/workspace inputs but does not
own their lifecycles.

The Desktop adapter is created once in the renderer composition root. Tests use
`createFakeTaskEntryServices` from `testing.ts`; production code must not import
that entry.
