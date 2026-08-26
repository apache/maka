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

# Session Navigation feature

Session Navigation is the renderer feature boundary for the Session rail. It
owns:

- rail membership, linked-session highlighting, Project/Runtime Host grouping,
  worktree badges, branch banners, and revision navigation;
- collapsed/expanded state, width, grouping mode, and their existing local
  persistence keys;
- explicit jumps into a Session, including search turn targets; and
- flag, archive, restore, rename, delete, and archived-task purge lifecycles.

## Dependency direction

- Consumers import production APIs from `features/session-navigation`.
- Tests may additionally import `features/session-navigation/testing`.
- Desktop Sessions bridge calls go through `SessionNavigationServices`; only
  `platform/desktop/create-session-navigation-services.ts` reads that bridge.
- Session Navigation may use shared renderer storage/copy, core types, and Maka
  UI, but must not import AppShell, preload implementation, or main-process
  code.

AppShell remains responsible for the authoritative catalog snapshot and for
composing explicit cross-feature intents: top-level destination selection,
WorkHub exit, active-Session selection, transcript clearing, and renderer-state
cleanup. Session Navigation does not own catalog authority, transcript/runtime
state, Session controls, task submission, or Module Hub routing.

## Public surface

- `useSessionNavigationController` owns layout, projections, jumps, and row
  mutation commands.
- `<SessionNavigationHost>` maps that controller onto the complete
  `SessionListPanel` surface.
- `selectors.activeParentSession`, `branchBanner`, and `revisionNavigation`
  are the narrow projections still consumed by shell/conversation chrome.

## Lifecycle invariants

- Archived, linked-subagent, and hidden companion Sessions follow the existing
  single-rail projection; a linked child highlights its visible root.
- Local Sessions group by Project while remote Sessions group by Runtime Host.
- Opening a Session first exits WorkHub, selects the Sessions destination, then
  activates the Session and replaces or clears the turn-scroll target.
- At most one row mutation runs per Session. Mutations retain revision-family
  semantics, and renderer state is cleared only after the Host confirms removal.
- Width persistence remains trailing-debounced; width, collapse, and grouping
  reuse the existing local-storage keys and hydration rules.
