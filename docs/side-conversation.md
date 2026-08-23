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

# Side Conversation

## Current Product Behavior

Maka `v0.1.6` already ships a quote companion that forks the active Session at
its latest completed turn, inherits the model, workspace context, and permission
profile, hides it from the conversation list, and removes it when the panel
closes.

The generic side-conversation entry extends that foundation:

- the titlebar can open a side conversation without requiring a text selection;
- the command palette exposes Side Chat as a first-class action with the same
  keyboard shortcut shown by the workbar launcher;
- `/side` opens an empty side chat, while `/side <prompt>` creates a titled
  side chat and sends the prompt as its first turn;
- the Composer `/` suggestion layer exposes Side with its icon and description;
  selecting it executes the command and removes the query instead of creating a
  fake Skill token;
- an empty side chat adopts its first accepted prompt as the tab title and
  keeps that title stable through later follow-ups and panel moves;
- selecting transcript text still appends quote context to the same panel;
- the fork is created eagerly when the panel opens, with a short preparation
  state before the Composer receives focus;
- the child receives the `mode:side_conversation` label, which adds a system
  boundary declaring inherited parent history reference-only;
- the main Session and its active turn continue independently;
- only instructions submitted in the side chat are active; explicit side-chat
  actions may use the inherited permission profile, and the permission can be
  changed from the side Composer;
- a running side turn accepts a Steer message at the next model step while Stop
  remains available;
- the side Composer shares `/` Skill discovery, `@` file references, files,
  quotes, and draft ownership with the main Composer;
- settled side answers expose Copy, Info, and Regenerate without navigating the
  user out of the temporary side tab;
- the side Session is deleted when the panel closes;
- every created temporary fork is registered with the main-process cleanup
  authority, so a process-level interruption removes the orphan on restart.

## Codex Reference

Codex implements `/side` as an ephemeral thread fork.

The TUI uses `thread/fork` with `excludeTurns`, injects a hidden boundary item,
keeps separate parent/side UI state, and interrupts plus unsubscribes the side
thread during cleanup. The Desktop app marks the fork as a `sideConversation`,
opens it in a `sidechat:<thread-id>` right-panel tab, excludes it from recent
conversation surfaces, and confirms before permanently closing a non-empty
temporary chat.

Primary references:

- `openai/codex#18190` introduced `/side`.
- `openai/codex#34198` stopped replaying inherited turns in the side UI.
- `openai/codex#35011` kept a side conversation open while toggling to its
  parent.
- `openai/codex#35887` moved interrupt/unsubscribe cleanup to the background.

## Desktop Architecture Snapshot

The current local Codex Desktop snapshot inspected on 2026-08-06 is app build
`26.730.61639` (bundle build `6234`, packaged on 2026-08-05). Its side chat is a
tab type inside a generic application-shell panel system, not a dedicated
drawer.

The shell creates independent `right` and `bottom` tab controllers. Each
controller owns:

- ordered tab ids, active tab, per-tab state, and activation history;
- open, activate, close, close-others, close-to-right, reorder, and pin;
- moving a tab between controllers through `moveTabTo` / `receiveMovedTab`;
- preview tabs that are replaced by the next preview unless pinned;
- tab descriptors carrying component, props, icon, title, close hooks, move
  hooks, context-menu items, and an optional durable route.

Closing an active tab does not merely choose the next array item. The controller
tracks opener relationships and recent activation so a child tab can return to
its opener before falling back to an adjacent tab.

The persisted layout is a topology snapshot containing right and bottom tab
order, active ids, open state, focus area, full-width state, and restorable
routes. Preview tabs are excluded. Browser tabs additionally persist browser
storage ids, restore URLs, device-toolbar state, and target panel.

The New Tab page is therefore a registry surface over available tab types
(Review, Terminal, Browser, Files, Side chat, and feature-gated additions), not
a fixed menu wired to the side-chat feature.

## Desktop Side-Chat Lifecycle

Opening a new side chat first installs a non-closable
`sidechat-loading:<parent>:<index>` tab. It then forks the latest parent state
and replaces the loading tab with `sidechat:<conversation-id>`.

Maka now matches that user-visible loading contract while keeping its stable
panel id: the tab shows a spinner and cannot be closed, dragged, reordered, or
moved until the eager fork is ready. It then becomes the ordinary closeable
Side Chat tab without remounting the panel draft.

The fork is marked both ephemeral and side-conversation, excluded from recent
conversation surfaces, and receives a developer boundary that:

- treats inherited history and tools as reference-only;
- activates only instructions submitted after the side-chat boundary;
- prohibits continuing parent work or using sub-agents;
- allows non-mutating inspection by default;
- permits a mutation only when the user explicitly requests it in the side
  chat.

A side-chat tab can move between right and bottom panels. Closing a non-empty
temporary side chat runs an `onBeforeClose` confirmation (with a persisted
"don't ask again" preference), then discards the conversation from cache in its
close hook. Existing retained side chats can instead resume and opt into
`preserveOnClose`.

The panel visibility controller deliberately distinguishes hiding, closing, and
moving:

- activating or opening a tab reveals its target panel;
- the loading tab means a newly created side chat reveals the panel immediately;
- manually hiding a panel preserves its tabs, active tab, draft, and stream;
- selected-text follow-up searches the right panel first, then the bottom
  panel, preferring each panel's active side chat before its first side chat;
- closing one tab keeps the panel open when another tab remains;
- closing the final tab closes the panel;
- moving the final tab out does not count as closing it, so the source panel may
  remain open on its New Tab page while the target panel opens.

The inspected right and bottom visibility atoms default to closed and are not
backed by a localStorage preference. Tab and route restoration are separate
mechanisms from whether the panel is currently visible.

The current product still has known recovery and focus gaps. Open upstream
reports cover unrecoverable closed chats, expiration after inactivity, focus
switching between the main and side composers, and crashes involving multiple
side chats plus Browser tabs. Maka should not copy those failure modes merely
for visual parity.

The inspected Desktop bundle registers a Composer slash command with id
`side`. Its parser accepts only `/side` or `/side <prompt>`. A non-empty prompt
is sanitized into the tab title and sent as the first side turn. The command is
unavailable inside a side chat and before the parent conversation exists. The
current Desktop bundle does not register `/btw`; that alias belongs to other
Codex surfaces.

## Codex Terminal Architecture

The same Codex build uses a real xterm surface rather than a command field over
terminal result cards. The renderer loads xterm, `FitAddon`, `WebLinksAddon`,
and `ClipboardAddon`. Every terminal owns a stable session id and is represented
by a dynamic `terminal:<session-id>` tab with a durable route carrying cwd,
host id, and session id.

The renderer does not own the process. A singleton terminal controller owns:

- conversation-to-session and session-to-conversation mappings;
- active session selection and numbered tab titles;
- a bounded raw ANSI replay buffer plus live stream listeners;
- pending writes until both the host session and renderer listener are ready;
- terminal size, workspace binding, title, and user-interaction state;
- DEC alternate-screen mode across xterm unmount/remount.

The main process owns local `node-pty` and remote process-session backends. It
enforces window ownership, creates or attaches sessions, streams raw data,
resizes, writes, closes, and retains a bounded replay buffer. Moving a tab
between right and bottom panels remounts or relocates the xterm view while the
PTY remains under the same main-process session. Closing the tab closes the
session. Opening another Terminal creates another PTY and another dynamic tab.

Dynamic verification matched the static chain: opening right and bottom
Terminals in the inspected build created two direct child login shells on
different PTYs. Both surfaces remained live simultaneously.

## Codex Review Architecture

Codex uses one fixed `diff` tab whose source changes inside the panel. It is not
an aggregation of tool-result messages. The Review model issues Git queries
against repository snapshots and supports:

- branch, last-turn, uncommitted, staged, unstaged, and commit sources;
- target branch selection and multi-repository selection;
- batched per-file `review-diff` requests with snapshot generations and stale
  snapshot rejection;
- refresh, jump-to-file, unified/split view, wrapping, whitespace filtering,
  full-file loading, and rich previews;
- stage, unstage, and revert actions at section, file, and hunk scope.

Last Turn can aggregate changes across all repositories. Git-backed sources can
be disabled independently, while Last Turn remains available from conversation
diff state. Maka's existing `ToolResultPreview` remains a good renderer to
reuse, but persisted `file_diff` tool results are not an equivalent data
authority.

## Deliberate Differences

| Boundary | Codex | Maka |
| --- | --- | --- |
| Entry | `/side`, keyboard shortcut, Desktop actions | `/side`, titlebar, command palette, keyboard shortcut, and selected-text actions |
| Initial transcript | parent history hidden | parent history hidden; only side turns render |
| Parent history | reference-only developer instruction plus hidden boundary | reference-only system prompt from the side label |
| Tool policy | read-mostly guidance; explicit side requests may mutate under the active permission profile | inherited permission profile; only explicit side-chat requests are active |
| Lifetime | temporary, with Desktop confirmation and some retained-tab behavior | temporary; close deletes the fork with durable cleanup recovery |
| Conversation list | suppressed | suppressed |
| Recovery | expired/closed side chats are not reliably recoverable | intentionally not recoverable; cleanup is reliable |

## Maka Parity Status

Maka now has the first usable slice of the same architecture:

- a dynamic right-side tab state instead of a fixed tab union;
- a registry-backed New Tab page rather than a fixed tab switcher;
- a Side conversation-first New Tab page, followed by Review, Terminal,
  Browser, and Files, then Maka-specific Tasks and Trace;
- Review now has Branch, Unstaged, Staged, and Last Turn sources inside one
  fixed tab;
- Branch exposes an explicit base-branch selector;
- Branch, Unstaged, and Staged use a main-process Git snapshot authority derived
  from the Session cwd; the renderer cannot provide a cwd or arbitrary Git
  command;
- Branch resolves a different local/default branch when available and includes
  committed branch changes, staged changes, unstaged changes, and untracked
  files;
- snapshots are bounded by file and diff-byte limits and carry a revision hash;
  Stage and Unstage re-read that revision and admit only a path present in the
  authoritative snapshot before mutating the index;
- Unstaged files can be reverted after a destructive confirmation;
- Last Turn reuses the most recent turn that produced persisted `file_diff`
  results, through the same highlighted diff renderer;
- Terminal is now a dynamic `terminal:<ref>` multi-tab surface backed by xterm
  and `FitAddon`;
- the existing ShellRun process manager remains the sole process, resize, stop,
  persistence, and Runtime Resource authority;
- ShellRun additionally publishes sequenced raw PTY deltas and a bounded replay
  snapshot to Desktop, while model/tool surfaces keep using the sanitized
  durable screen snapshot;
- moving a Terminal between right and bottom panels preserves the PTY and xterm
  output; closing its tab stops the PTY;
- Terminal tabs are intentionally excluded from static layout persistence
  because ShellRun processes do not survive an application restart;
- integrated login shells suppress oh-my-zsh's automatic update prompt so it
  cannot consume the first typed command;
- titlebar launcher and panel-toggle actions;
- command-palette Side Chat action with `side`, `btw`, `侧聊`, and `追问`
  search terms;
- Composer `/side` and `/side <prompt>` handling with automatic first-turn
  send and a prompt-derived transient tab title;
- Composer slash-menu discovery for Side in the same trigger layer as Skills,
  without changing Skill token serialization or draft ownership;
- first-prompt title adoption for side chats opened from the titlebar,
  launcher, command palette, or selected-text flow;
- a non-closable, non-draggable loading tab while the eager fork is prepared;
- stable per-kind tab icons, with Side Chat switching from its normal icon to
  a spinner while a turn is active;
- one replaceable preview tab per panel for automatically opened artifacts;
  opening it manually, double-clicking its tab, using its context-menu Pin
  action, or interacting with its content converts it to a normal tab;
- preview tabs are excluded from layout persistence until pinned;
- closeable tabs with adjacent fallback and duplicate-open activation;
- most-recent activation history, so closing a tab returns to the tab the user
  came from before falling back to adjacency;
- pointer drag reordering plus context-menu move-left / move-right actions;
- standard desktop tab keyboard navigation with ArrowLeft, ArrowRight, Home,
  and End;
- New Tab focus handoff, ArrowUp/ArrowDown/Home/End menu navigation, and Escape
  return to the previously active tab;
- independent right and bottom panel controllers with simultaneous active tabs;
- cross-panel tab movement that preserves Side Chat forks/drafts/streams and
  Browser page state;
- persisted right/bottom static-tab topology, panel visibility, and bottom
  panel height, including v2 right-panel migration;
- context-menu close, close-other, and close-to-right actions with batched
  side-chat confirmation and cleanup;
- persisted static tab order and active tab, with side chats excluded;
- Browser, Files, and Side conversation shortcuts;
- side-chat draft and streaming state preserved while the workbar is
  collapsed or the New Tab page is active;
- multiple numbered side-chat tabs with independent drafts, forks, streams, and
  quote queues;
- the same Composer shell as the main conversation, including a functional
  attachment menu, Skill and file mentions, inherited permission menu, and
  mid-turn Steer submission;
- the same answer metadata surface for Copy, Info, and Regenerate, with Branch
  withheld because it would navigate outside the temporary side-tab lifecycle;
- no content-area close action: Side Chat lifetime belongs exclusively to tab
  chrome and its close confirmation;
- non-empty close confirmation with a persisted "don't ask again" preference;
- fork cleanup when the side-chat tab closes or its owning session changes;
- startup cleanup for temporary forks orphaned by an interrupted app process.

Maka now also mirrors Codex's panel transition rules: hiding preserves live
tabs, closing the final tab closes that panel, moving the final tab leaves the
source panel on New Tab, and selected text reuses right-side chats before
bottom-side chats. Maka intentionally continues persisting general workbar
visibility across restarts; Codex's inspected visibility atoms are in-memory.

### Inserted-message rendering

The first Side Chat steering implementation delivered inserted text correctly
but projected it incorrectly. A `steering_message` shares the active turn id
with the original prompt. The settled turn projection stored only one
`turn.user`, so the later steering row replaced the prompt; the live projection
also ignored `steering_message`, leaving the inserted text invisible until
settlement.

Turns now preserve their first user row as the prompt and project later
same-turn user rows as `userInterjections`. The live projection adds a steering
interjection as soon as Runtime acknowledges it, and the settled overlay
deduplicates that optimistic row by message id. The Side Chat regression test
requires both user bubbles to appear immediately after insertion and to remain
after the assistant response settles. Because the fix lives in the shared turn
projection, the main conversation gets the same behavior.

## Validation Note

The renderer production build remains split at the workbar boundary. After the
panel-lifecycle changes, direct `gzip -9` measurement reported 22,237 bytes for
the `session-workbar` chunk and 75,703 bytes for the main `index` chunk, both
slightly below the previous 22,260-byte and 75,801-byte snapshots.

It does not yet have general durable route restoration or retained side-chat
recovery after leaving the owning session. Terminal launch remains local and
deliberately narrow: the renderer can request a login shell for the current
Session, but cannot yet choose a remote host, arbitrary launch command, or cwd.
Review still lacks commit-source browsing, hunk-level actions, filesystem
watching, and multi-repository aggregation.

The visual shell is low-to-medium difficulty. Full controller parity is a
separate medium-to-high effort because it changes ownership, persistence,
focus, and cleanup behavior across every workbar surface.

## UI and Performance Verification

The panel shell was checked in light and dark themes at 320px, approximately
480px, 600px, and in the bottom placement. Two layout bugs found during that
pass were fixed at their ownership boundaries:

- Astryx Toolbar's start slot kept its intrinsic tab width, so narrowing the
  panel pushed the New Tab button outside the panel. The workbar now constrains
  that slot and scrolls only the tab list, never the outer panel.
- The shared Composer footer wrapped its model onto a second row at 320px. The
  right-side Side Chat now uses a compact single-row footer with an ellipsized
  inherited model and a responsive 160px maximum; the wider bottom panel keeps
  the normal Composer geometry.

The eager fork also has a short accessible preparation status. Once ready, the
empty transcript returns to the same blank state as an ordinary chat, and the
side Composer receives focus. An interrupted development process was also
restarted against the same workspace to verify that its orphaned fork was
removed before the session list rendered.

The latest visual pass covered the dark command palette, dark right-panel
loading and ready states, and the light bottom-panel state. The loading tab
keeps a stable footprint, removes its close affordance while busy, and restores
the normal tab chrome after the fork commits.

The active-turn pass confirms that Side Chat changes only its tab icon to a
spinner while processing. The close affordance remains available during a
turn, then the normal Side Chat icon returns without changing the tab title or
layout footprint.

The `/side <prompt>` visual pass additionally confirms that the command never
appears in the parent transcript, the prompt is sent in the side transcript,
and the tab uses the prompt as its ellipsized title with the full title
available on hover.

One real-model failure found during the final dev-app check had two independent
causes:

- the active tool-result archive placeholder used a URI with `sha256` and
  `bytes` query parameters; Nemotron copied the artifact id and hash into its
  `ArchiveRead` call but dropped the second query parameter, so the strict
  parser returned `invalid_ref`;
- the side fork selected the latest non-running parent turn, which included
  failed and aborted turns. A short side prompt could therefore look like a
  continuation of unfinished parent work to a weaker model.

Archive refs now encode artifact id, hash, and byte length as path segments,
while the parser still accepts the old query form for persisted compatibility.
Side forks now inherit only through the latest successfully completed parent
turn and start empty when no completed turn exists. A live Nemotron validation
read one 10,982-character archived result in three successful pages, and a new
side chat opened over an aborted parent turn answered `你好` directly without
calling Glob, Read, or ArchiveRead.

The slash-suggestion pass confirms that `/si` renders a single Side command
above the Composer with the normal Side Chat icon and explanatory secondary
text. Keyboard selection clears the query and opens an empty side chat.

Measured performance checks on the implemented surfaces:

- Git Review with 84 changed files improved from 335ms to 90ms median for
  Branch and from 229ms to 69ms for Unstaged.
- A 220-file untracked snapshot stayed bounded to 200 files, completed in
  36.4ms, and added about 5.3MB of heap.
- Review mounts file diffs in pages of 20.
- A 5MB PTY stream dropped from 5,120 renderer IPC events to 80 while preserving
  every byte. The focused Runtime coalescing test also keeps a 1MB stream within
  32 events.
- The loading-tab, command-palette, `/side`, slash suggestion, dynamic-title,
  and tab-icon polish added about 0.70KB gzip to the main renderer chunk and
  about 0.28KB gzip to the lazy workbar chunk
  in the measured production build.
- Nested lazy boundaries then reduced the `session-workbar` chunk from 120,835
  bytes gzip to 21,832 bytes gzip, approximately 82%. Terminal is now an
  86,747-byte on-demand chunk, Files is 7,756 bytes, and Review, Browser, and
  Trace are independent 2.4-4.3KB chunks. The main `index` chunk moved from
  75,717 to 75,941 bytes gzip, an increase of 224 bytes.

The 19-test workbar interaction suite covers Side Chat, slash and command
palette entry, Review, Terminal, tab reordering, panel movement, persistence,
and the 320px layout. The shared UI suite passes 432 tests, and the 13-test
Skill/mention E2E set confirms that adding Side to the `/` menu did not change
Skill token or draft behavior. Full Runtime and Desktop suites can expose
timing-sensitive child-process tests under sustained machine load; every such
failure observed in this pass succeeded when rerun in isolation.

## Follow-up Work

1. Extract the remaining surface switch into a registered tab descriptor model
   before adding third-party panel types.
2. Surface parent status in the panel when the main Session needs input,
   approval, or completes.
3. Decide whether an explicit user request should be able to promote a side
   conversation to a durable ordinary Session before adding write access.
4. Add commit selection to Review, then hunk-level stage/unstage/revert
   actions.
5. Add filesystem watching and multi-repository aggregation to Review.
6. Add remote-host Terminal creation and a restorable route only after the
   Runtime can reattach or recreate a terminal honestly across app restart.
