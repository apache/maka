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
- `WorkbarProvider` is the application boundary for topology, shortcuts,
  dynamic resources and Side Chat visibility. It is the only production caller
  of `useWorkbarController`; that hook is intentionally absent from the
  production barrel. `AppShell` supplies only the active Session, workspace
  availability, authoritative Session ids, shell visibility and composer
  mention/model context.

## Public surface and render ownership

- `<WorkbarHost>` reads its controller-owned host model directly from
  `WorkbarProvider`; `AppShell` cannot accept or pass that model.
- The titlebar restore affordance reads only `available`, `collapsed`, and
  `onToggle` from its own context. Host-only changes do not repaint it.
- Cross-feature intents use the stable imperative commands on the per-shell
  `WorkbarShellBridge`. Replacing the controller publication does not re-render
  the shell.
- Ephemeral companion fork ids are the one reactive value another feature
  needs. Session Navigation equality-selects that external-store projection at
  its reader boundary before deriving the rail.

The bridge is created per `AppShell`; it is neither global state nor a service
locator. Controller-only updates re-render the provider and whichever narrow
context consumes the changed projection, while the provider retains the shell
element built by its parent.

## Lifecycle invariants

- Review, Tasks, Browser, Files and Inspector tabs are persisted globally.
- Terminal and Side Chat tabs, preview state and resource metadata are
  transient.
- `WORKBAR_TOOL_DEFINITIONS` is the authority for persistence, singleton
  behavior and default placement; storage and controller code consume it
  rather than maintaining parallel kind lists.
- Closing or leaving the owner session stops Terminal resources.
- A Terminal start is tagged with its source generation. If it resolves after
  a Session switch or controller disposal, the returned resource is stopped
  immediately and never enters the tab topology.
- Terminal ownership is registered as soon as `start` returns, before the tab
  state commits. Host projection excludes resources owned by another Session,
  so a Session switch cannot briefly reattach an old Terminal.
- Side Chat survives panel collapse and is cleaned only when its tab closes or
  when navigation leaves its source session.
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
