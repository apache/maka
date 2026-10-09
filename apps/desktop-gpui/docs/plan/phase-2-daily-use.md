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

# Phase 2: daily use

Status: specification draft, written after the Phase 1 MVP loop was verified against a real
Host (commit 605d990). Ordered by what blocks daily use of the client for real work.

## What Phase 1 proved

- The Rust client speaks the Host protocol over local IPC with a persisted identity,
  liveness probing and reconnect. Protocol coverage is driven by fixtures recorded from a
  real Host, and a drift check pins the compatibility epoch.
- `transcript-model` folds subscription frames into a transcript without GPUI and is tested
  by replaying recorded sequences.
- One window: session sidebar, transcript with streaming markdown, tool cards, prompt cards,
  composer, stop, disconnected strip. A real Turn with a Bash tool call completes through
  the production view.

Known gaps carried into Phase 2: no real `sandbox_boundary` recording (needs a model that
calls `request_sandbox_boundary`), no comparison against the Electron transcript, no
Windows named pipes, no Host spawning from the app (done in W2).

## Work packages

### W1. Model and connection selection (blocks real work)

Status (2026-09-25): done for the composer and for adding an API-key connection.

- The composer's model picker lists every enabled model of every enabled connection
  (`workspace::ConnectionCatalog` over paged `connection.catalog.query`, reloaded on
  `connection.catalog.changed`), grouped by connection with the current model checked, and
  switches with `session.configuration.update` (explicit `modelTarget`, expected revision =
  the catalog projection's `revision`, one re-read and retry on `revision_conflict`). It is
  disabled while a turn runs, since the Host refuses (`session_busy`).
- The permission mode picker offers Read only / Auto / Full access with Maka's descriptions,
  through the same update, and stays available mid-turn (the Host allows widening and says
  so when it refuses a narrowing). Unlike Maka Desktop, `explore` is selectable and Full
  access has no confirmation dialog.
- "Add connection…" (last item of the model menu, and Host > Add Connection…) opens a sheet:
  provider (the API-key providers of `PROVIDER_REGISTRY`, copied into
  `host_protocol::ONBOARDING_PROVIDERS`), name, identifier, service URL, API key; Verify,
  the discovered models as checkboxes, Add connection, and "Use as the default model".
- Evidence: `#[gpui_kit::test]`s in `conversation` (model menu, exact update, conflict retry,
  refusal, busy turn, mode switch), `settings` (verify → models → save → default, refusals,
  stale answers, Escape), `app` (keyboard path from the model menu into the sheet, Escape
  returns focus to the picker); fixtures recorded from the dev Host for onboarding
  verify/save, set-default-target, and remove; live runs of `live_turn --switch` and
  `app --example live_add_connection` against the dev Host with Ollama.

Left for later: editing and removing connections in a settings window, refreshing an
existing connection's models (`connection.models.fetch`), providers without a key (Ollama and
LM Studio need `connection.catalog.create`), OAuth providers, Cloudflare Workers AI (URL
template), thinking level, and a model picker for new sessions (W4).

The dev root only worked because the default target was set by hand. Users need:

- a model picker in the composer region: `connection.catalog.query` → connections and
  enabled models; selection writes `session.configuration.update` with an explicit
  `modelTarget`. Reference: `packages/ui/src/model-picker*.tsx`, `chat-model-switcher.tsx`.
- an "Add connection" sheet: provider type, base URL, API key, `connection.onboarding.verify`
  then `connection.onboarding.save`, then optionally `connection.catalog.set-default-target`.
  Reference: `apps/desktop/src/renderer/features/connection-settings`.
- per-session permission mode switch (`explore` / `ask` / `bypass`) via
  `session.configuration.update`; show the current mode next to the composer.

### W2. Host lifecycle from the app

Status (2026-09-25): done for local Hosts started from a Maka checkout.

- `host_client::connect_or_spawn` mirrors the TS election: it prepares the
  State Root as `resolveStorageRoot` does (marker created by hard link,
  identity checked), connects to a registered Host, and otherwise spawns
  `execution-candidate-main.js` detached with `--root`, `--expected-root-id`,
  `--startup-attempt-id` and `--initial-connection-timeout-ms`, with the TS
  deadline (75 s, `MAKA_RUNTIME_HOST_ELECTION_DEADLINE_MS`), backoff, and
  250 ms candidate interval. Exit codes map to the startup failure reasons and
  messages; the candidate's startup diagnostic is read into the error. Node
  comes from `MAKA_NODE`, then `PATH`, then the newest nvm install ≥ 22.19;
  the checkout from `MAKA_REPO` (default `~/code/maka-agent`).
- `RootConnector::spawning` runs it on every supervised attempt, so the first
  connection and every reconnect start a Host when the registration is gone.
  The disconnected strip shows "Starting Maka…" with a spinner, then the
  failure text with Retry; the serve command stays as the fallback. The
  spawned Host is ephemeral and idles out after the app quits.
- First launch without `--root` asks where Maka keeps its data (proposing
  `~/Library/Application Support/maka-gpui/state-root`, native folder picker,
  Maka Desktop's data directory refused) and remembers the choice in
  `state-root.json`; `--root` overrides it for one launch; Host > Switch State
  Root… asks again and replaces the window's Workbench.
- Evidence: election tests against a fake candidate script and fake Host
  socket (spawn, existing Host, lost election, permanent and transient
  startup failures, timeout, supervised respawn); `real_candidate` (ignored)
  against the real Host from `MAKA_REPO`; `#[gpui_kit::test]`s for the
  starting and failure strip and for the dialog (first launch, Escape, Enter,
  refusal, failed save, switch and cancel); the app run against fresh roots
  (spawned, slow start, too-old Node).

Left for later: the released Maka CLI package as an installation source, the
TS launcher's managed-deployment and composition pre-checks (the candidate
refuses those roots itself), selecting and clearing the chosen startup
diagnostic file, Windows (named pipes and root identity), and a setsid-style
detach (the candidate gets its own process group).

The original scope:

- Spawn the local Host when none is registered: mirror `client/connect-or-spawn.ts`,
  `launcher.ts`, `candidate-cli.ts` (`--root`, `--expected-root-id`, `--startup-attempt-id`).
  Requires locating a Maka installation (env `MAKA_REPO` for development, the released CLI
  package later). Show progress states in the disconnected strip.
- Choose or create a State Root on first launch; never default to the user's live Maka root
  without an explicit choice.

### W3. Transcript completeness

Status (2026-09-25): older history, reasoning, the message queue, and
attachments done; tool progress, shell-run output, system notes, compaction
and retry markers, and full `form`/`client_capability` prompts remain.

- Older history: the transcript's first row stands for older messages. When it
  scrolls into view, or on Home, `session.transcript.page` `older` reads the
  previous 64 KiB with the tail's cursor at the tail's watermark; the row
  shows "Loading earlier messages", whole Turns go above, and the topmost
  visible row is scrolled back to where it was, so the view does not move.
  At the Session's first row it says "Beginning of task". A read that fails
  shows the reason with Retry; a refused cursor reopens the subscription.
- Evidence: replay of `long_history.jsonl` (recorded from the dev Host,
  `capture_fixtures --long-history`), synthetic older-page tests,
  `#[gpui_kit::test]`s for Home, the unmoved view, a short transcript, retry,
  and a refused cursor; the app on the dev Host with `--scroll-to-top`
  (`docs/design/screenshots/older-history.png`).
- Reasoning: `thinking` deltas and the durable rows' `thinking` field are a
  `Thinking` item of their own, before the step's text and never inside it.
  The row is one quiet line: "Thinking…" shimmering while it streams
  (still text under reduced motion), then "Thinking — <first line>";
  Enter, Space, or a click expands the muted text, with a note when the
  earliest reasoning was cut (tail-keep, 32K UTF-16 units).
- Evidence: `reasoning.jsonl`, recorded from the dev Host with `qwen3:0.6b`
  on Ollama (`capture_fixtures --sequences <dir> --only-sequence reasoning
  --connection-slug ollama-local --model qwen3:0.6b`), replayed in
  transcript-model; synthetic tests for streaming beside the text, the
  durable hand-off, a stop, and a reopen mid-stream; a `#[gpui_kit::test]`
  for the collapsed row and the keyboard expansion; the app on that session
  (`docs/design/screenshots/reasoning.png`).
- Messages go through `turn.message.submit` with `next_turn`, as in Maka
  Desktop: the Host starts a turn when the session is idle and otherwise
  queues the message as a follow-up; Cmd+Enter queues it as steering
  (`current_turn`). Send stays available while a turn runs ("Queue after
  the current turn"); with an empty draft the round button is Stop. The
  queue shows right above the composer card (as Desktop's pending plate),
  grouped into steering and follow-ups, each with Send now
  (`queue.entry.promote`), Edit in place (`queue.entry.update` at the queue
  revision it started from; Enter saves, Escape cancels), and Remove
  (`queue.entry.retract`); a steering message the turn took reads
  "Sending…". `turn.start` stays in host-protocol for the examples and
  fixtures.
- Evidence: `message_queue.jsonl` recorded from the dev Host
  (`--only-sequence message_queue`: a started turn, three follow-ups, an
  edit, a reorder, a promote, a retract, the steering event, and a
  follow-up running as the next turn), decoded in host-protocol and
  replayed in transcript-model; `#[gpui_kit::test]`s for queueing,
  Cmd+Enter steering, the plate's commands, and a refusal; the app on the
  dev Host with two `--send` messages
  (`docs/design/screenshots/message-queue.png`).
- Left for later: reordering by drag (`queue.entries.reorder` is modeled
  and recorded), `queue.retract` of the whole queue, and `turn.interrupt`.
- Attachments: "+" in the composer opens the platform file dialog
  (`prompt_for_paths`, several files). Each file becomes a chip under the
  draft (thumbnail for an image, else a file icon; name; size; remove),
  refused past 8 files or 50 MB (`MAX_ATTACHMENT_COUNT`,
  `MAX_ATTACHMENT_BYTES`) with the reason in the card. Sending uploads each
  file into the session through the public `artifact.ingest` (`begin` with
  size and SHA-256, 48 KiB `chunk`s, `commit`, `abort` after a failure, as
  the Desktop's `ingestAttachment`), with the media type decided as
  `resolveAttachmentMimeType` does, then submits the message with the
  returned `AttachmentRef`s. The model gets them as `maka://runtime/…`
  resources it reads with Read. No Desktop-only store is involved.
- Evidence: `attachment_ingest.jsonl` recorded from the dev Host
  (`--only-sequence attachment_ingest`), decoded in host-protocol;
  `#[gpui_kit::test]`s for the dialog, the chips and limits, the upload and
  the submitted content, and a failed upload; the app on the dev Host with
  `--attach` (`docs/design/screenshots/attachments.png`).
- Paste and drop (2026-09-28): Cmd+V attaches files copied in Finder
  (their paths win over their names as text) or an image as
  `clipboard-image.png`, and otherwise pastes plain text; files dropped on
  the dock attach the same way (the rest of the window takes no drop), and
  the dock's ring turns into the focus ring while files hover it. A folder
  is refused with the reason. Before upload an image the model can see is
  scaled down to 2000 px on its longest edge and re-encoded as PNG when it
  is larger, and a TIFF or BMP is sent as PNG, as the Desktop's
  `resizeImageForAttachment` does; the 50 MB cap applies to the bytes
  uploaded as well as to the file picked.
- Sent attachments (2026-09-28): a user message's `AttachmentRef`s (from
  `session.transcript.page` rows and live steering alike) show above its
  bubble as the composer's chips without the remove button, trailing; a
  message of files alone has no bubble. An image's chip leads with a
  file-image icon where the Desktop shows a thumbnail, because reading the
  Artifact's bytes back needs a request this client does not model.
- Left for later: image thumbnails on sent messages, and upload progress
  per file.

The original scope:

- Older-history paging with `session.transcript.page` when the user scrolls to the top.
- Reasoning blocks, tool progress and shell-run output, system notes, compaction and retry
  markers (transcript-model Phase 2 list in `docs/transcript-model.md`).
- Message queue: `queue.*` operations, queued messages shown under the composer, reorder and
  retract. Reference: `docs/desktop-message-queue.md`.
- `form` and `client_capability` interactions rendered fully.
- Attachments in the composer (images and files) once `MessageContent` attachment shapes are
  modeled; native file picker through GPUI's platform API.

### W4. Sessions and projects

Status (2026-09-25): done except search and moving a task to another project.

- Each task row has a context menu (right-click, a "…" button on hover and under the
  keyboard cursor, Shift-F10 or the Menu key): Rename in place (also F2; Enter commits
  through `session.metadata.update`, Escape cancels, one retry at the revision a conflict
  names), Flag/Unflag (`isFlagged`, a flag before the age), Archive/Unarchive
  (`session.lifecycle.set`; archived tasks move to a folded Archived group at the end, and
  archiving the selected task selects its neighbour), Copy task ID, and, on archived tasks
  only as in Maka Desktop, Delete… behind an alert dialog that states the subtasks
  `session.remove.preview` counts, then `session.remove` at the listed revision.
- A By time / By project switch under the folder row groups the list by day or by
  workspace folder (headed by the project's name), for the life of the window.
- The folder row opens a picker of the Host's projects (name over folder, current checked,
  missing folders disabled), "Choose a folder…" (native dialog, then
  `project.catalog.mutate` `register` with `prefer: true`) and "Manage projects…".
  Settings › Projects lists every project with Rename, Archive/Restore, Relink… (when the
  folder is gone) and Add project….
- New task (⌘N) creates the task in the chosen project by id on the catalog default model
  and the Host's default permission mode, selects it, and focuses the composer; the empty
  state names the project. With no project it opens the folder dialog first, never
  reusing another task's folder.
- Evidence: `#[gpui_kit::test]`s in `session` (menu, rename commit and cancel, conflict
  retry, archive and the Archived group, flag, copy, delete confirmation, by-project
  grouping, folder picker, registration against a scripted Host), `settings` (Projects
  rename, archive, restore, relink), `app` (⌘N target and focus, Manage projects…);
  fixtures recorded from the dev Host (`capture_fixtures --task-actions`); the
  `live_sidebar` example against the dev Host.

Left for later: task search, moving a task to another project
(`session.workspace.relocate`), labels, bulk selection, and remembering the grouping across
launches.

The original scope:

- Rename, archive, delete, flag; grouping by project; search. `session.metadata.update`,
  `session.retirement.*`. Reference: `packages/ui/src/session-history-list.tsx`.
- Project catalog: add, remove, pick a directory with the native dialog;
  `project.catalog.mutate`.
- New-session flow: project first, then model, then permission mode, with sensible defaults.

### W5. Shell polish

Status (2026-09-26): done. Localization, the command palette, keyboard help, and a design
review pass (`docs/design/review-2026-09-26.md`).

- Every visible string is a key of `shared::copy` (`Text`: English, 简体中文, 繁體中文;
  Chinese reuses Maka Desktop's terms). Sentences with a variable part are templates with
  `{name}` placeholders; counted phrases pick a form with `plural`; relative times follow
  `Intl.RelativeTimeFormat` (`3分钟前`, `前天`, `3 分鐘前`) and past a week show the local date
  per locale. The `Locale` global is set from the saved preference (or `--locale` for one
  launch); Language in the footer menu or Settings › General redraws every window at once,
  including what entities cached in words (task list headings, transcript rows, input
  placeholders) and the menu bar. gpui-kit's own strings follow through its `set_locale`.
- Evidence: a table test walks every key (all three locales present, translated, same
  placeholders, no three dots); relative-time and date tests against `Intl` output; a
  `#[gpui_kit::test]` switching the language from the footer menu and back; the app in
  简体中文 (`docs/design/screenshots/i18n-main-zh.png`, `i18n-settings-zh.png`).
- Left for later: a failure message already on screen keeps the language it was written in
  until it is replaced; reasons from the Runtime Host stay English.
- Command palette: ⌘K or ⇧⌘P (View › Command Palette…, and the search button beside the app
  name) opens gpui-kit's `Command` in a dialog. It lists the commands of the window's table
  (`app::commands::COMMANDS`) that can run now, with their key bindings, then the model,
  permission mode, appearance, and language choices (current checked), the settings
  sections, and the tasks by title. The search is fuzzy (in order, word starts and runs
  score more) over the label in the current language and in English; Enter runs the best
  match after the dialog has closed and returned focus, so Focus composer and a task keep
  it; Escape clears the query, then closes. Archive task and Flag task act on the selected
  task.
- Evidence: fuzzy-score unit tests; `#[gpui_kit::test]`s for ⌘K / ⇧⌘P, filtering, Enter
  running a command, Escape, focus return, opening a task from the sidebar's search button,
  and the new Tab stop; the app with `--open-command-palette [<query>]`
  (`docs/design/screenshots/command-palette.png`).
- Keyboard help: ⌘/ (View › Keyboard Shortcuts…, and the palette) shows a dialog of every
  command of the same table that has a key binding, in two columns (what runs anywhere; the
  task list's and the transcript's keys, which the table carries with their key context),
  each binding drawn with `Kbd` from the keymap in force.
- Evidence: a `#[gpui_kit::test]` that the sheet's rows are exactly the table's bound
  commands, that every palette command with a binding is among them, the labels and keys,
  and Escape returning focus; the app with `--open-shortcuts`
  (`docs/design/screenshots/keyboard-shortcuts.png`).
- Theme and review: the dialog backdrop dims in both modes (the `overlay` token set to 20% /
  50% black after every theme change; gpui-kit's 20% was invisible in dark), the sidebar
  toggle is the plain panel icon, provider rows show gpui-kit `Avatar` monogram discs
  tinted per letter and legible in both themes, commands that open a dialog end in an
  ellipsis in the palette and the sheet, and the Settings search finds a section by the
  settings it holds. The Design review and Accessibility checklists, per surface, with
  light and dark screenshots and what remains, are in `docs/design/review-2026-09-26.md`.

The original scope:

- Command palette (`Command` component) exposing every action; keyboard help.
- Theme: follow the system, light and dark verified with the design review checklist.
- i18n: English and Simplified Chinese through a small copy table in `shared`; no
  concatenated sentences.
- Settings window skeleton with the sections Phase 2 needs (connections, permissions,
  appearance, about).

### W6. Platform reach

Status (2026-09-26): the Windows named pipe transport (compiled and unit-tested, not yet
run on Windows; State Root preparation there still unsupported, see `docs/dev-host.md`,
Windows), the ad-hoc signed macOS bundle (`just bundle`, built in CI), `CHANGELOG.md` and
`scripts/release-check.sh` done; Developer ID signing and notarization remain
(`packaging/README.md`).

- Windows named pipe transport in `host-client`; `cargo check` already passes on Windows.
- Release packaging for macOS: signed app bundle, `CHANGELOG.md` as the release notes
  source, version from the workspace `Cargo.toml`.

## Acceptance for Phase 2

A user with a fresh machine and a Maka checkout can start the app, have it spawn a Host on a
chosen State Root, add a connection, create a session in a project, run a multi-turn task
with tool calls and at least one prompt, switch models mid-session, and reopen the app to
find the transcript intact. All of it without the Electron Desktop installed.

## Out of scope for Phase 2

Agent Graph, WorkHub, Plan mode, Skills and MCP management, remote Hosts (WebSocket, SSH,
peer mesh), collaboration, automation, computer use, terminal panel, git review, browser
panel, auto-update.
