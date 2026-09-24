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
- Contract types the shell fulfills for this feature live in `ports.ts`;
  controller files export only what they implement.
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

Those intents stay intents. Opening a Session also clears the active transcript
and leaves WorkHub, and the rail does not subscribe to either: it calls them
through `SessionNavigationPorts`, which the shell composes.

## Public surface

- `<SessionNavigationProvider>` is where the rail's state lives. It calls
  `useSessionNavigationController` and publishes what the rail reads as two
  contexts — its data and its chrome — so a re-render of AppShell is not a
  re-render of the rail (#4109).
- `useSessionNavigationController` owns layout, projections, and row mutation
  commands. It is called by the provider and nowhere else; calling it in a
  render body above the rail is what put the rail's state on the whole tree.
- `useSessionNavigationReads` is the shell's own narrow read: the rail
  projection it also needs for the command palette, the branch banner, the
  revision navigation, and the rail's width. It holds no state.
- `createSessionOpenCommand` composes an explicit Session jump out of the
  shell's own actions.
- `sessionRailLayoutStore` owns collapse, width, and grouping mode, with the
  existing persistence keys.

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

## Session visit history

`SessionHistoryNavigation` owns a window-local, bounded history of the last 100
Session visits. It observes the catalog's requested selection synchronously, so
rapid selections are recorded even before a transcript finishes loading. It
does not observe the displayed transcript as a second selection authority.
The shell supplies visibility, modal blocking, and its existing Session-open
command. Settings, WorkHub, module pages and an empty new-task surface are not
history entries. Restarting or reloading the window clears this history.

On the main conversation surface, a horizontal touchpad scroll moves backward
(`deltaX < 0`) or forward (`deltaX > 0`) through visits, not sidebar order.
Opening the current Session again is a no-op; opening another Session after
going back discards the forward branch. Confirmed catalog removals erase the
Session's visits. Missing or pending rows are skipped without erasing them:
temporary Host/catalog unavailability is not proof of deletion.

The gesture chooses its axis after 8 pixels, requires horizontal movement at
least twice the vertical movement, and triggers at 80 horizontal pixels. It
stays latched through the momentum tail until 250 ms without wheel input.
Vertical/diagonal input, modifiers, non-pixel wheel input, editable controls,
dialogs and horizontally overflowing content keep their gesture. Scrollable
code and tables retain horizontal scrolling even at either edge. Workbar,
terminal and embedded-browser surfaces are outside the marked conversation
surface. A nested interactive surface may also opt out with
`data-session-history-ignore`.

### Ownership, atomicity and failure

- **Owner:** Session Navigation owns history/cursor and gesture state. The
  existing catalog remains the only writer/read authority for the selected
  Session; the shell composes the existing open command.
- **Invariant:** one accepted gesture requests at most one history traversal.
  Traversal never records itself as a new visit or truncates forward history.
- **Atomicity boundary:** the synchronous open command and catalog selection
  acknowledgement. Re-entrant catalog notifications during that command are
  suppressed as new visits; the cursor advances only after acknowledgement.
  A rejected or throwing open leaves the cursor in place. Subsequent asynchronous
  transcript-load failures retain the selected target and existing error/retry
  behavior; they do not select a different Session silently.
- **State safety:** history stores IDs only. Drafts, transcripts and in-flight
  turns continue through the existing Session-open/lifecycle owners. No storage,
  runtime protocol, Host lifecycle or filesystem contract changes.
- **Rollback:** revert the navigation component's shell wiring and its supporting
  implementation. No migration or persistent-state cleanup is required.

### Platform scope and verification

| Platform | Input contract | Limitation |
| --- | --- | --- |
| Windows | Chromium pixel-mode horizontal wheel input, normally from a precision touchpad | Driver/system gestures must deliver input to the app |
| macOS | Same renderer input path | System gesture configuration and inertia need physical-device verification |
| Linux | Same renderer input path | Availability depends on touchpad driver and desktop configuration |

Wheel input does not expose finger count or a reliable momentum-end flag. This
is horizontal touchpad-style navigation, not a guarantee that only two fingers
can trigger it; a horizontal mouse wheel producing pixel events may also do so.
The idle timeout is a conservative gesture boundary, not native phase detection.

Node tests cover history branching, removal, selection ordering, rejected opens,
gesture latching and input exclusion. The focused Storybook interaction checks
actual Chromium overflow geometry and event propagation using the production
component, catalog, open command, ChatSurfaceLayout and MarkdownBody. Automated
input does not replace physical touchpad tuning on each platform.
