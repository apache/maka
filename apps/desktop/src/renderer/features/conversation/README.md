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

`ConversationProvider` owns the renderer's single Conversation workspace. The
Session Catalog remains the authority for requested selection and Host rows;
Conversation owns published transcript identity, durable/transient presentation,
load/retry state, and its private Session UI controller.

`ConversationLifecycle` owns transcript open/publication/disposal, event seed and
retry, interaction hydration, ShellRun hydration, health recovery, reading
position and live-to-durable handoff. It stays mounted when the transcript view
is hidden or unmounted. `ConversationTranscriptRegion` reads the publication in
the conditional message region. `ConversationComposerRegion` reads only pending
messages and matching request usage in the persistent Composer slot. The
cross-feature approval leaf uses `ConversationMessageConsumer`.

These components inject owned presentation directly into leaf surfaces. They
never return a full model or a render-prop result to AppShell. The private
context contains stable capabilities, not a changing publication. A content
publication does not notify Shell when its target and finite chrome facts are
unchanged, or Composer when its pending/usage projection is unchanged.
Catalog preview/activity bookkeeping also leaves the lifecycle reader unchanged;
status and profile changes still reach recovery and observation ownership.

`useAppShellSessionUiState` is now a transitional **reader/command adapter**,
not a construction hook. It exposes published/Host target identity, empty/history
facts, fixed Session reads and the selection commands the shell still owns
(activate, start a new task, retire a Session). The Stop claim and the send,
transient and interaction commands are no longer on it; the Composer
submission owner reads them from the controller. Its
published Session reference is a frozen getter, and consuming contracts declare
it readonly. It has no map setters, range
controller, publication callback, writable refs, or whole-state getter.
`readMessages()` is an invocation-time, readonly view of the **published range**;
it is used by Copy/Save and is not a full-history promise. Revision commands read
the same range from the controller inside the Composer submission owner.

The Desktop adapter supplies `ConversationObservationServices`. The feature
never imports the Desktop range implementation or accesses `window.maka`.
Requested Session, published Session, and non-shared Host owner are distinct:
a switch retains the old picture until an admitted publication arrives; a
pending local first-send Session is shown immediately without starting Host
reads. Effect-instance and selection fences reject retired publications and
errors. Seed completion before or after the first transcript publication is
supported. Subscription retry reuses the same transcript controller; disposal
closes it, unsubscribes both streams, discards held display events and cancels
pending retries.

Reading position and `LiveTurnReconciler` are private lifecycle components.
Reconciliation follows **every retained Turn**, including predecessors. Running
Turns have no durable transcript sequence, so reading intent keeps the Turn ID
until persistence supplies its sequence. Send preparation cancels restoration
and issues the viewport command without waiting for history reads.

### Integration seams and redesign triggers (R2 M2 / C)

- Composer migration keeps `activeId` as the published draft target and
  `ownerActiveId` as the readable, non-shared Host target. Selection leases,
  transient add/update/remove, `prepareSend`, `refreshMessages`, interaction
  settlement and draft restoration are semantic ports that the Composer
  submission owner consumes inside the feature; do not re-export the private
  workspace to reach them from the shell.
- The visible range is not an event watermark. Bounded-window work may extend
  the injected range controller and the private reading lifecycle, including
  return-to-latest and full-history export commands. It must preserve one
  observation owner and atomic publication of Session, rows and range metadata.
- Revisit the owner if an accepted decision introduces multiple simultaneous
  conversations or replaces the Host observer. Scope one workspace to each
  admitted viewer; do not add a second cache/observer in Shell or key/remount the
  persistent Composer to follow transcript windows.

`controllerOwners` fixes construction and observation at their JSX owners.
`featurePrivateModules` seals workspace/event/publication/reading internals and
context against production import or re-export outside Conversation. Tests use
`testing.ts`; no production compatibility constructor is retained.

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
The Conversation provider separately reads only its published queue.
`LiveTurnReconciler` still follows all retained Turns within that Session,
including predecessors; it must not subscribe only to the execution root.

State and reader construction modules are private under
`featurePrivateModules` in the architecture ledger. The public feature entry
exports reader contracts and consumer hooks, not state constructors or arbitrary
selectors. Whole-state inspection is available from `testing.ts` only.

Remaining transitional capabilities have explicit consumers and removal work:

| Capability | Current consumer | Removal module |
| --- | --- | --- |
| `useAppShellSessionUiReads` | AppShell chrome and Composer prop assembly | M3 regional readers; retain only required chrome |
| Invocation-time published-message read | Copy/Save | M3 command ownership / bounded-history export integration |

M2 owns presentation and observation; it does not add a Catalog, Host cache or
execution state machine, or complete the remaining Composer migration.

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

## Context compaction (R2 M2)

The Conversation controller owns the renderer's one context-compaction
presentation. `compactSession` calls the injected `sessions.compact` service and
opens the running notice; `ConversationLifecycle` hands the Host's terminal
`contextCompactionOutcome` to the same presentation, which dismisses that notice
and shows the outcome once. A reply that arrives after the Host has settled its
Turn adds nothing. A rejected request is reported against its Session only while
that Session is still published; a missing working directory keeps its own
notice, classified by `application/contracts/session-workspace-errors.ts`.

AppShell no longer builds the presentation, calls the bridge, or threads the
outcome into the lifecycle. It forwards the stable `compactSession` command to
composer submission's `/compact` port until M3 moves submission below the
Composer owner. `model/context-compaction.ts` is private; tests use `testing.ts`.
Side Chat keeps its fork-scoped presentation in Workbar.

## Composer staging ownership (R2 M3, first slice)

`ComposerStagingProvider` is the sole owner of the Desktop staging controller.
It stays mounted across Session and section switches. `StagedComposer` reads
files, directory references and quote chips at the actual Composer;
`StagedQuoteChatView` reads quote annotations at the transcript, and
`ComposerMentionsProvider` reads the same quotes for the session-reference limit.
No staging state or reactive read port is returned to AppShell. The private
context/binding modules and the controller owner entry seal this boundary.
The Desktop attachment service is injected at the composition root.
`StagedQuoteChatView` also takes the transcript's image `readBytes` from that
service (R2 M5); AppShell and `ChatMessageSurface` cannot pass another reader.

The shell holds only stable commands. Submission captures a draft-bound snapshot
before awaiting revision preparation or delivery. Cleanup stays bound to that
draft; directory references retain their originating Host. Quotes
are copied at invocation, including session references added in the same tick.
Accepted sends remove only captured quote entries, preserving later additions
and edits: the submitted note is sent once, while a note edited during delivery
remains an unsent draft for the user's next send. Failed sends keep their staging.
`createStagedFollowUp` applies the same capture/cleanup rule to the Shell's actual
follow-up callback; tests exercise it through the production enqueue action.
There is no public restore command without a production consumer. Delivery
recovery may introduce one when that later M3 slice defines its ownership.
This does not change Host admission,
queue routing, revision-copy ordering or the new-task text handoff.

The existing file-picker rule still targets the visible draft when I/O completes;
directory pickers still require the original draft and Host to remain current.
Staging uses `activeId ?? NEW_TASK_PENDING_KEY`; the editor's new-task persistence
key remains distinct. Do not key this provider or the Composer's parent by Session.

Delivery recovery is later M3 work. It can use captured submission commands
without restoring root subscriptions or acquiring the private controller.

## Composer submission ownership (R2 M3)

`ComposerSubmissionProvider` alone calls the submission controller. It is
mounted beside the staging and readiness owners and stays mounted across Session
and section switches. It owns the send-pending flag, the edit-and-resend draft
(with the catalog watch that retires it), the retracted workspace references and
the submit, follow-up, Stop, Turn-branch and interaction-answer paths.
`createRevisionAwareOnSend`, the staged follow-up and the chat, revision, Stop
and Turn actions are assembled here, not in AppShell, and none of them is
exported from `index.ts`. Local delivery recovery (`SessionLocalMessages`)
mounts inside the owner for the published Session; its recovery policy is
unchanged.

The Host operations reach the owner as `ComposerSubmissionServices`, one named
operation each; the Desktop adapter is the only caller of those bridge paths.
The shell supplies a `shell` port of commands it already owns (surface
ownership, navigation, catalog refresh, execution-boundary reload, the Workbar's
form answer, side chat and new-task resolver, the model-setup toast, the
Turn-action pending registry the transcript renders, and the selected Session's
orchestration write) and a `newTask`
projection read at send time. Session Settings owns the new-task Plan, orchestration and permission
choices; the projection carries them, and creation consumes the permission
choice through `clearPermissionChoice`.

`ConversationComposerRegion` reads the owner in the persistent Composer slot: it
injects `onSend`, `newTaskSendPending`, `onStop`/`stop` with the published
Session's Stop claim, the interaction answers and the revision notice, and
narrows the shell's picker gates while a draft is open. The shell keeps only the
stable `ComposerSubmissionCommands` handle, whose `beginEditUserMessage` and
`handleTurnFooterAction` serve the transcript. The handle throws
while the owner is unmounted. The binding and reader context are private.

## Task readiness ownership (R2 M3)

`TaskReadinessProvider` alone calls the readiness controller. It is mounted
beside `ComposerStagingProvider` and stays mounted across Session and section
switches, so hiding the transcript neither drops nor restarts the read. AppShell
supplies the request projection (model target and working directory), the owner
Session or new-task target, the onboarding snapshot as a refresh key, and the
Session whose workspace recovery a blocker opens, with the stable recovery and
Add Project commands. The provider resolves the picker action from those facts,
so a shell render with the same facts leaves the notice reader alone. It
receives no snapshot, refresh command or notice.
`TaskReadinessNoticeConsumer` is the only reader: the transcript surface renders
it in the notice slot, a workspace blocker opens the picker, and every other
action reads again.

The Desktop adapter injects the two Host reads as `TaskReadinessServices`; the
feature does not access `window.maka`. A changed request, target or refresh key
clears the previous snapshot before reading again, and a sequence fence admits
only the latest read. A shared Session has neither an owner Session nor a
new-task target and reads nothing. The snapshot context is module-local and
`controllerOwners` fixes the controller at the provider. Send-time admission
(`checkTaskSubmissionReadiness`) does not read this snapshot; it moves with
submission ownership.
