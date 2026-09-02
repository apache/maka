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

# Module Hub feature slice

`module-hub` owns the Desktop renderer behavior behind Extensions and
Automations:

- installed, managed-source, and bundled-catalog Skills projections and
  mutations;
- Scheduled Tasks projection, mutations, due/change subscriptions, and the
  create-dialog request nonce;
- the keep-system-awake client setting shown by Scheduled Tasks;
- Daily Review page bridge, page actions, and Command Palette commands;
- selection and header composition for Skills, MCP, Scheduled Tasks, and Daily
  Review.

`ModuleHubProvider` owns the controller below `AppShell`. `AppShell` still owns
top-level `NavSelection`, module-memory persistence, Session/Project
navigation, and the Composer. Those capabilities cross the boundary only as
intents. Commands return through a stable imperative port because the Shell
calls them only from event handlers. Two typed boundaries hand the read-only
Scheduled Tasks projection to the Session rail and the Skill catalog revision
to Composer mentions through a `render` prop at their actual readers, so the
readers' props stay required and the compiler checks the wiring; Module Hub
updates therefore do not subscribe or re-render `AppShell`.

## Dependency direction

Production consumers import only `features/module-hub/index`. Tests and
Storybook may import `features/module-hub/testing`. The feature imports core/UI
types and renderer-neutral locale/formatting helpers, but it must not import
AppShell, preload, or main-process modules and must not access `window.maka` or
`navigator`.

All environment I/O is represented by `ModuleHubServices` and mapped once by
`platform/desktop/create-module-hub-services.ts`. The adapter is also where an
older preload is converted into an unsupported keep-awake capability.

MCP is the explicit exception to I/O ownership in this slice. `McpPage` keeps
its existing page-owned controller and direct Desktop bridge. `ModuleHubHost`
only selects and mounts that leaf; moving MCP internals is a separate change.

The production entry deliberately does not export `useModuleHubController`.
The renderer architecture policy records its implementation and
`ModuleHubProvider` as the unique production owner. Moving, duplicating, or
re-exporting that controller fails the central architecture check; tests may
reach it only through `testing.ts`.

## Lifecycle invariants

- The three Skills projections and Scheduled Tasks each have independent
  generation fences.
- Host-scoped reads re-check the current default Runtime Host before committing.
  Late reads, mutation feedback, and diagnostics from an old Host are dropped.
- Initial Skills and Scheduled Tasks refresh remains deferred to the first
  animation frame. A ready default-Host change refreshes both clusters.
- Scheduled Task change and due subscriptions are disposed with the controller;
  due notifications retain the navigation action.
- Mutation feedback is live-surface fenced. Confirmation continuations are
  also abandoned after leaving Scheduled Tasks.
- Keep-awake reads, external updates, and writes share a generation so a slow
  completion cannot overwrite newer confirmed settings; failed writes still
  reject for the panel's optimistic revert.
- The Daily Review page bridge is stable for one services/locale pair. Page
  feedback is live-surface fenced, while Command Palette commands remain usable
  off-page.
- Daily Review paste captures the active Composer before its first await and
  validates the Session, navigation owner, and Composer handle before append and
  feedback.
- Opening Scheduled Task creation selects the page and increments the request
  nonce; the page acknowledgement resets it to zero.
- The Provider remains mounted across all routes. Navigation may hide every
  Module Hub page, but it must not tear down default-Host refresh, Scheduled
  Task subscriptions, Daily Review command state, or the create nonce.
- The command port connects and disconnects in a layout effect. A stale
  Provider cleanup cannot detach a newer controller target.

There is intentionally no feature-level reducer or store: these projections and
commands have real lifecycle ownership, while navigation persistence remains a
Shell concern.
