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

# Conversation feature

Conversation owns runtime-only Session presentation state and the policies
that connect transcript identity to the Desktop bounded-range controller. Its
public API includes task-readiness presentation and a headless
`TranscriptReadingPositionController` component. That component owns bookmark
restoration, landmark refresh, and history navigation, while exposing explicit
capture, send preparation, and history commands to AppShell.

`LiveTurnReconciler` owns the handoff of every retained Turn's content to the
durable transcript. It subscribes to the whole buffer; selecting only the Host
execution root would miss late predecessor content. AppShell continues to use
the low-frequency summary for its chrome.

Successful send preparation publishes a one-shot viewport command through the
Session UI controller. The message surface forwards that port to ChatView,
where the scroll authority follows the tail. History catches up in the background
so local Message admission does not wait for it. Message growth and bookmark
updates do not replay the command; the range controller rejects stale catch-up results.
Accepted store updates reach the message surface through the existing transcript
projection; navigation completion only settles bookmark state.

Running Turns have no durable sequence in the RuntimeEvent transcript. Reading
intent therefore carries the Turn ID until persistence supplies its sequence;
later Turns must not displace it just because it began in the live projection.

The feature does not access the Desktop bridge. AppShell supplies bounded-range
and landmark ports plus current Session and controller identities; the feature
rejects stale completions against those identities. Session Navigation supplies explicit navigation intent
only; it does not own transcript state.

## Session read capabilities (R2 M0/M1)

The controller has no whole-state getter or subscription. Its `reads` surface
creates fixed-purpose, Session-bound readers for load/restore, retry, stop,
interaction, queue, chrome summary, live content and ShellRun records. The
streaming-membership reader is the intentional global projection; Session
Navigation subscribes to it directly instead of receiving shell state.

Readers expose only `getSnapshot` and `subscribe`, without arbitrary selectors
or mutation commands. The existing authority publishes
only changed projections and refreshes subscribed snapshots before invoking
listeners. It may evaluate active projections on a state change; this is a
notification-isolation contract, not a claim that all projection work is free.
Inactive/abandoned readers have no subscription-registry entry. React binds a
new target during render, so switching targets cannot expose the old snapshot.

`ChatMessageSurface` receives only its live-content and ShellRun read ports,
with viewport navigation passed separately. `LiveTurnReconciler` receives only
the live-content reader and its existing semantic reconciliation command.
Neither reader receives the complete controller.

The shell's temporary `useAppShellSessionUiReads` projection uses the published
Session for content/queue/pending and the owner Session for interactions.
The workspace publication hook separately reads only its published queue.
`LiveTurnReconciler` still follows all retained Turns within that Session,
including predecessors; it must not subscribe only to the execution root.

State and reader construction modules are private under
`featurePrivateModules` in the architecture ledger. The public feature entry
exports reader contracts and consumer hooks, not state constructors or arbitrary
selectors. Whole-state inspection is available from `testing.ts` only.

Remaining transitional capabilities have explicit consumers and removal work:

| Capability | Current consumer | Removal module |
| --- | --- | --- |
| Controller map setters, live-content/health/reading refs and publication | AppShell subscription wiring, workspace and transcript lifecycle | M2 Conversation owner |
| Pending claims and send/retry mutation bundle | AppShell chat actions and composer submission | M2/M3 semantic commands and persistent Composer owner |
| `useAppShellSessionUiReads` | AppShell chrome and Composer prop assembly | M2/M3 regional readers; retain only required chrome |

This slice does not complete their regional ownership or introduce a second
Catalog/Host observer.

## Plan ownership

`PlanProvider` alone calls the internal `usePlanModeState`. AppShell supplies
only the existing Session target; it receives no Plan model or setters.
`PlanChatView` owns the proposal projection at the transcript reader and
`PlanExecutionSurface` reads execution state beside the persistent Composer.
The provider retains its children across Plan updates, so those updates do not
rebuild the shell/frame or remount the Composer.

The public entry exports these components and `PlanServicesProvider`, not the
controller or a full-state reader. `controllerOwners` fixes the production call
site; controller access through `testing.ts` is test-only. Desktop composition
injects the narrow Plan service contract through the existing bridge adapter.
Session Settings continues to own entering/leaving Plan mode; the Plan owner
observes and controls proposals/executions without duplicating those writes.

Preserve the automatic-query gate, latest-read wins, captured Session scope,
confirmation ownership, and exact approval/resume retry inputs. Plan remains
Session-scoped and uses the existing observer/control APIs. Revisit this boundary
if an accepted architecture decision changes that target or moves Plan into an
independent domain; do not restore a full-model export to adapt callers.
