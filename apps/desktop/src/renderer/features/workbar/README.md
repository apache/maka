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

# Workbar feature

Workbar is a vertical renderer feature. Its application-level model owns the
right/bottom panel topology, active tabs, dimensions and persisted collapse
state. Tool data remains session-scoped, and the session content surface is
remounted when the active session changes.

## Dependency direction

- Consumers import production APIs from `features/workbar`.
- Node test suites may additionally import `features/workbar/testing`.
- Storybook may additionally import `features/workbar/stories`, which exposes
  `WorkbarSurface`. It stays out of the production entry because `workbar-host`
  reaches the surface through `lazy()`, and out of `testing` because that entry
  is loaded by `node --test` against tsc output while the surface and its tool
  panels use extensionless relative specifiers only a bundler resolves.
- Workbar may use shared renderer primitives, core types and Maka UI.
- Workbar must not import shell composition, Desktop bridge, or main-process implementation.
- Desktop I/O enters through `WorkbarServices`; tool code does not read
  the Desktop global bridge directly.
- `useWorkbarController` is the application boundary for topology, shortcuts,
  dynamic resources and Side Chat visibility. `WorkbarProvider` is its sole
  production owner; `AppShell` supplies only the active Session, workspace
  availability, authoritative Session ids, shell visibility and composer
  mention/model context as the provider's `input`.

## Shell boundary

`WorkbarShellRoot` sits above `AppShellContent` beside the other feature
roots and hands it the Workbar projection, so the shell body calls no Workbar
hook. The root owns a per-shell bridge and reads its equality-selected shell
state, without calling the controller. `WorkbarProvider` publishes each
committed controller into that bridge, so tab switches, panel topology and
resize drags re-render the provider and the host model's readers, not the
shell.

- `commands` are stable delegates to the latest committed controller:
  `openTool`, `openSideChatWithQuote`, `toggleRight`, `toggleTool`,
  `setWorkbarCollapsed`, the interaction responders and
  `bindNewTaskSessionResolver`. Before the provider publishes they are no-ops.
- `selectors.hiddenSessionIds` filters ephemeral companion forks from the rail
  and the command palette; `selectors.rightCollapsed` and `selectors.ready`
  drive WorkHub's dock and navigation. The shell re-renders only when one of
  these values changes.
- `WorkbarHost` and `WorkbarTitlebarActions` read the host model from the
  provider's context. The provider also publishes
  `--maka-session-workbar-width` on an inherited custom property, so the frame
  and titlebar size from it without a shell render. Storybook renders the
  environment-free `WorkbarHostView` and `WorkbarTitlebarActionsView` with its
  own model.

## Review comparison preference

`WorkbarServices.reviewBaseBranchPreference` is the feature-owned persistence
port. It stores only an explicit qualified ref for one Session; `null` leaves
the comparison unpinned so reads follow the repository default. New Sessions
start unpinned, and existing choices survive panel remounts and app restarts.
The panel owns selection and invalid-branch recovery. The Desktop adapter owns
the localStorage key, JSON format, validation and best-effort error handling.
Tests and Storybook use an isolated in-memory implementation through the same
port; they do not persist review choices into the browser profile.

## Lifecycle invariants

- Review, Work Board, Browser, Files and Inspector tabs are persisted globally.
- Terminal and Side Chat tabs and their resource metadata are transient.
- `WORKBAR_TOOL_DEFINITIONS` is the authority for persistence, singleton
  behavior, default placement, icon and shortcut; storage, controller and UI
  code consume it rather than maintaining parallel kind lists.
- A face is opened and closed only from the strip's `[+]` menu, which lists
  every registered tool and marks the open ones. Tabs carry no close control:
  `Tab` renders `endContent` inside its own `<button>`, so a per-tab close
  would nest a button in a button. Tabs are never reordered, so the strip's
  order is the order the faces were opened in.
- Host Sessions own Terminal processes. Switching Sessions, collapsing a panel,
  or disposing a window never stops them; disposal releases xterm and its control
  connection. Explicit close removes a tab only after Host confirms Stop.
- Main's Host target owns pending and uncertain Close intents across renderer
  and connection replacement. A successful Stop closes the exact owner/ref in
  the current topology; a failed attempt remains available for explicit retry.
  No Close history or terminal contents are persisted for recovery.
- Activation and reconnect restore live desktop Terminal entries from Host.
  Presentation is transient and reconstructible, never the resource inventory.
  Recovery preserves panel visibility and selection, and excludes inherited,
  completed, and model-created resources. Late start results stay with Host if
  their requesting view has disappeared.
- Natural completion detaches live controls and subscriptions but may retain
  the current local xterm picture until its view closes. Late output can be
  lost; completion does not promise a final output snapshot or replay.
- Removing a Session from the authoritative catalog retires its Terminal views.
  Host owns admission of Session retirement while processes are live.
- Side Chat survives panel collapse and is cleaned only when its tab closes or
  when navigation leaves its source session.
- Fork creation hides the internal Session until cleanup succeeds. Catalog
  absence does not confirm cleanup because a snapshot may predate creation.
- Disposed Side Chat operations are fenced at every fork/send boundary; a late
  fork is cleaned and a late send cannot write back into an abandoned panel.
- Inactive tabs stay mounted; their hooks receive the existing active/hidden
  signal and decide whether to subscribe.
- Inspector keeps two authorities separate: Session events refresh its paged
  timeline/context window, while usage-change events refresh the complete
  Session usage summary. Re-activation and head refresh preserve the requested
  trace page depth.

## Adding a tool

Add its metadata, define the smallest service port it needs, implement its hook
and surface under `tools/`, register fake-service story states, and pin both its
state transitions and resource cleanup in tests.
