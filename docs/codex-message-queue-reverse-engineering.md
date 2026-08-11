# Codex message queue reverse engineering

## Evidence snapshot

Observed from the locally installed Codex desktop surface shipped inside:

- app bundle: `/Applications/ChatGPT.app`
- product version: `26.730.61639`
- build: `6234`
- renderer bundle: `Contents/Resources/app.asar`
- queue component: `webview/assets/queued-message-list-C99nHasl.js`
- main renderer state and submit flow: `webview/assets/app-initial-CKNQDTeE.js`
- General Settings surface: `webview/assets/general-settings-2iEePJwo.js`
- Simplified Chinese catalog: `webview/assets/zh-CN-GwJD95VL.js`

This is an implementation observation, not an API guarantee. Names in minified
bundles may change between Codex builds.

## Product model

Codex separates follow-up input during an active turn into two placements:

| UI term | Runtime effect |
| --- | --- |
| Queue | Persist the message for a later turn. |
| Steer | Submit the message to the active turn without interrupting it. |

The persisted preference is named `followUpQueueMode`. Missing values default
to Queue. A legacy `interrupt` value is normalized to Steer.

General Settings describes the behavior as:

- queue follow-ups while Codex runs, or steer the current run;
- use the inverse shortcut for one message without changing the default.

The active composer resolves its submit action from the preference and active
turn state. Shift+Enter inverts Queue and Steer for that submission.

## Queued message state

Codex stores queued follow-ups separately from the transcript. The renderer
contains a persisted `queued-follow-ups` state key and a queue manager with:

- enqueue;
- get and update;
- remove;
- reorder;
- resume interrupted steering attempts;
- send-lock acquisition and release.

Automatic delivery acquires a per-message lock before submitting a queued
follow-up. The lock is released with a `sent` outcome, which prevents two
clients or two renderer effects from sending the same queue entry.

If delivery fails, the row is retained with a paused reason. The queue does not
silently discard it or continue past an unresolved failed entry.

## Queue UI

The Codex queue list is mounted directly above the composer and is bounded to
30 percent of the dynamic viewport height. Each row supports:

- one-line message preview;
- optional image or pasted-text context preview;
- drag handle and reorder;
- Send now, implemented as Steer;
- retry for a paused row;
- delete;
- edit;
- open in side chat;
- switch the global default between Queue and Steer.

An interrupted turn pauses automatic queue delivery and shows a Resume action.

The Simplified Chinese copy observed in this build includes:

- `跟进行为`
- `排队`
- `引导`
- `加入队列`
- `调整方向`
- `提交，但不中断模型运行`
- `由于你中断了当前响应，队列已暂停`

## Maka before this change

Maka already had most runtime primitives:

- embedded Runtime `steer`, `queueMessage`, `drainFollowup`, and `retractQueue`;
- durable steering leases with persist-before-provider injection;
- `queue_update` events with separate steering and follow-up lanes;
- Runtime Host `current_turn` and `next_turn` placements;
- Runtime Host durable queue projection, capacity bounds, retract, and automatic
  successor-turn admission;
- CLI Queue/Steer behavior, pending queue rendering, and retract-to-editor.

The Desktop gaps were the actual blocker:

1. `queue_update` reached the renderer event stream but was ignored by the
   Desktop live projection.
2. Desktop exposed only `sessions.steer`; it had no next-turn enqueue or retract
   bridge.
3. The running composer replaced Send with Stop, so Queue and Steer had no
   explicit action surface.
4. Embedded Desktop had no owner that drained follow-ups into serial successor
   turns. Only the CLI performed that orchestration.
5. No persisted Desktop preference selected Queue versus Steer.

## Maka implementation in this change

The Desktop now has:

- persisted `chatDefaults.followUpMode`, defaulting to Queue;
- a General Settings Queue/Steer segmented control;
- Desktop IPC for rich enqueue, mutation, and retract;
- Runtime Host mapping to `next_turn`, durable `queue.mutate`, and retract;
- an independent per-session renderer queue projection driven by
  `queue_update`;
- a composer workband showing current-turn steering and next-turn follow-ups;
- a retract-to-editor action;
- stable entry identity with inline edit, delete, drag reorder, and Send now;
- attachment and quote preservation with visible context counts;
- a running composer with Queue/Steer selection, a separate Stop button, and a
  placement-specific primary submit button;
- Shift+Enter inversion while a turn is active;
- one automatic successor turn per queued entry in both Embedded Runtime and
  Runtime Host;
- queue preservation after a failed turn;
- Embedded Desktop interruption pauses queued work and exposes Resume. A
  steering lease already in flight remains owned by the durability decision
  and is not duplicated into the queue.

## Remaining parity gaps

These Codex capabilities are not yet reproduced:

- durable interrupted-queue pause and Resume in Runtime Host composition;
- per-entry failed-delivery reasons and Retry after a successor turn cannot
  start;
- Open in side chat from an individual queued row;
- explicit Skill and voice operations inside queued follow-ups. Rich files,
  quotes, and inline workspace references are supported;
- cross-process send locks for Embedded Runtime. Runtime Host mutations and
  successor admission are already serialized by the Session admission gate and
  durable receipts.

## Streaming performance follow-up

Real Desktop profiling against `gpt-5.6-sol` found that provider delivery was
not the source of visible stutter. A representative 8,892-character answer
arrived as 282 provider deltas over 37.4 seconds, but Astryx's Markdown display
cursor split each already-streamed delta into additional 10-character animation
ticks. That produced 1,041 DOM mutation batches and 3,003 mutation records:
about 3.69 React commits and 10.65 DOM mutations per provider delta.

Maka now keeps Astryx's streaming-safe incremental parser, incomplete-Markdown
handling, and streaming component set, while selecting an instant display
cursor for buffers that already arrive incrementally from Runtime Host. A
second real-provider run produced 316 provider deltas and 367 DOM mutation
batches with 370 mutation records: about 1.16 commits and 1.17 DOM mutations
per provider delta. Long tasks above 50 ms fell from four to two in the
instrumented runs.

The Astryx patch adds a `streamingSpeed` seam rather than disabling streaming
mode. Remove it when the published Markdown component exposes an equivalent
way to retain incremental parsing without replaying the received stream as a
second character animation.

## Queue interaction performance

The first sortable implementation kept dnd-kit in the eager Composer graph.
That meant every Desktop launch preloaded the drag runtime even when no message
was queued. The queue is now a lazy, memoized UI boundary: its edit state,
mutation gate, retract state, sensors, and sortable rows mount only when the
session can use or is showing queued work. The small chunk is prefetched when a
turn enters follow-up mode, after initial render but before a user normally
submits the next message.

A production renderer build reduced eager JavaScript from 505,660 to 491,823
gzip bytes. The shared UI chunk fell from about 423 KB to 372 KB raw, while the
queue and sortable chunks left the initial modulepreload graph.

Queue submission also has a renderer-owned optimistic projection. The click
adds a pending row immediately, but that row cannot be dragged, edited, or
mutated until the Runtime Host publishes its authoritative `queue_update`.
Authority replaces the whole projection; a rejected enqueue or a race that
starts a turn rolls back only the matching pending row. In a real Electron run,
the pending DOM row appeared 13.4 ms after the click event and the authoritative
entry replaced it at 153.2 ms.

## Burst submission and scroll stability

A burst of follow-up submissions exposed a routing race after the first send:
the Composer released its local pending gate when IPC returned, while its
`streaming` prop still needed another React commit to reflect the synchronous
live-turn arm. A follow-up entered during that window called `sessions:send`
again, and Runtime Host correctly rejected `turn.start` with `session_busy`.
Each rejection created a separate identical error toast.

Desktop submission routing now checks `liveTurnBySessionRef` at the moment of
submission. A non-terminal local arm, or an authoritative running turn, routes
through the configured Queue/Steer mode even when the Composer prop is one
frame behind. Identical active toast content also overwrites in place instead
of stacking.

The visible output twitch had a separate cause. Astryx's locked chat scroller
used a spring for every content resize. With instant provider-buffer rendering,
11 transcript height changes produced 99 scroll events, including 85 movement
frames below 3 px, and the viewport lagged the bottom by as much as 156 px.
Maka now selects instant following for automatic content growth while retaining
the spring for the user-triggered scroll-to-bottom action. A repeat run produced
18 height changes and 16 scroll events, with zero sub-3px movement frames and
zero observed distance from the bottom.

## Latest-main integration

Rebasing onto the August 11 mainline exposed two integration boundaries:

- Session catalog projections now carry the authoritative working directory as
  `session.workspace.hostCwd`; rich queued attachments use that field rather
  than the retired top-level `cwd`.
- Entering the new-task surface explicitly collapses the right workbar. The
  workbar is absent before the first Session exists, so retaining an expanded
  state made it appear only after the first send and looked like send had opened
  it. Existing Sessions still preserve a workbar the user opened deliberately.

## Review hardening

The August 11 correctness review found five boundaries that happy-path tests
had not exercised:

- Stop carried a renderer-only preservation flag. Runtime Host now owns a
  paused queue state: the stop fence folds undelivered steering into follow-up,
  terminal transition does not auto-admit a successor, and `queue.mutate`
  `resume` admits exactly the queue head before clearing `paused`.
- Assistant delta coalescing accepted terminal frames. Coalescing is now
  restricted to ordinary append deltas; `reset` and `complete` retain their own
  sequence and wire semantics behind a blocked sink.
- Queue mutation could apply a candidate prepared before runtime pull/ack/nack.
  Revision, generation, reservation, and run ownership are revalidated after
  asynchronous snapshot preflight and before live mutation.
- Retract-to-editor projected rich content to text. IPC now returns aggregated
  `MessageContent`; Desktop restores retained attachment refs, quotes, and
  workspace-reference metadata and sends them back through validated fields.
- Text editing preserved positional inline references from the previous text.
  Update preparation, live state, and root-admission proof now clear those
  positions together, while preserving attachments and quotes.

Regression coverage includes a blocked-sink delta-plus-completion test, a
runtime-consumption mutation race, Host pause/resume admission, structured
retract IPC, and a real Electron Stop-to-Resume successor flow.
