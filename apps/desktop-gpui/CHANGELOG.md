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

# Changelog

All notable changes to Maka GPUI are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version lives only in the workspace `Cargo.toml`. A release moves the
`Unreleased` entries under `## [<version>] - <YYYY-MM-DD>`, and
`scripts/release-check.sh` refuses a release tag without that section (see
`packaging/README.md`).

## [Unreleased]

### Added

- Runtime Host protocol types and frame codec, with golden fixtures recorded
  from a real Host and a drift check that pins the compatibility epoch to
  Maka's (`just drift`).
- Host client over local IPC: handshake, request multiplexing, subscriptions,
  a persisted client instance id, liveness probes, and reconnect with
  backoff.
- Named pipe transport for Windows (compiled and unit-tested; not yet run on
  Windows).
- Remote Runtime Hosts: WebSocket over TLS (or plaintext, explicitly
  acknowledged) with a bearer credential, SSH forwards in batch mode with or
  without operator activation, pairing with a pending credential, and a
  profile store in the client's config directory. Settings › Workspace ›
  Runtime Host chooses the default Host, offers others, and adds one by
  connection code (Direct peer codes are refused) or by hand; a window talks
  to one Host and switches from settings or the sidebar footer, and on a
  remote Host offers the Host's own folders for projects and hides what a
  remote owner may not do.
- Transcript model that folds subscription frames into a transcript, tested
  by replaying frames recorded from a real Host.
- Main window with a task sidebar, a transcript with streaming Markdown and
  tool cards, a composer with Stop, and the connection state in the sidebar
  footer.
- Permission and sandbox-boundary prompts answered in the transcript.
- Keyboard scrolling of the transcript (Page Up, Page Down, Home, End).
- Switching the task's model and permission mode from the composer.
- Adding an API-key model connection from the composer or from Settings.
- Starting a local Runtime Host when none is registered for the State Root,
  with progress, failure, and Retry in the window.
- Choosing where Maka keeps its data on first launch, and switching the State
  Root later (Host > Switch State Root…).
- Settings in place of the sidebar and the task view, as in Maka Desktop:
  "Back to app", Desktop's sections under its four groups with a section
  search, and General (the interface language, which can follow the
  system's, and the default permission mode), Appearance, Workspace (the
  projects), Models (the connections), and About.
- Task actions: rename, flag, archive, and delete, from a context menu or the
  keyboard.
- Task list grouped by day or by project.
- Projects: register a folder, manage projects, and create new tasks in the
  chosen project.
- Older history loaded when the transcript reaches its top.
- Model reasoning shown as its own collapsed row.
- Messages sent through the Host's queue: follow-ups and steering, with Send
  now, Edit, and Remove.
- File attachments in the composer, uploaded into the task.
- Pasting files or a screenshot into the composer, and dropping files on it,
  attaches them; images are scaled down to 2000 px on the longest edge, and
  TIFF and BMP are sent as PNG.
- A sent message shows the files it carries above its bubble.
- Every attachment chip, in the composer and on a sent message, leads with
  its kind's glyph (image, PDF, document, code, or any other file).
- Extensions and Scheduled tasks under New task in the sidebar, each a page
  on the plate with its title in the header row, reached from the command
  palette, Back and Forward, and `--open-page`. Extensions › Skills lists
  the project's installed Skills and the built-in and local-source ones to
  install, with each Skill's detail (enable, pin to the skill context,
  review and apply a source update, open SKILL.md, delete) and, for a Host
  on this machine, importing a local SKILL.md and opening the Skill
  locations.
- Scheduled tasks lists the Host's scheduled tasks and their run history,
  with each task's detail (enable or pause, trigger now, snooze 10 minutes,
  clear its history, edit, duplicate, delete) and a form to create or edit
  one: quick times, Maka Desktop's templates, daily, weekly, monthly, or
  cron repeats, a local notification or a bot chat. Its sidebar entry counts
  the active tasks, and a task that fires is announced with the way to the
  page. Local notifications and bot messages are delivered by Maka Desktop;
  a task whose fire waits for it says so. The Daily review tab shows the
  activity of a day or the last 7 or 30 days and generates a report, which
  can be copied, added to the composer, or saved as Markdown. On macOS,
  Keep system awake keeps the machine from idle sleep so tasks fire on time.
- Interface in English, Simplified Chinese, and Traditional Chinese, or in
  the system's language when it is one of them.
- Light, dark, or system appearance.
- The app icon, in Settings › Appearance as Maka Desktop has it: its 40
  icons in their groups, a separate icon for dark appearance, and importing
  a PNG or JPEG (cropped to its centre square, scaled to 1024 px). The
  macOS Dock shows the choice for the appearance the app is in.
- Custom pets: importing a `maka.pet/v1` pack from a folder into the State
  Root's library (`pets/v1`, shared with Maka Desktop on the same root),
  choosing one, turning it off, and removing packs. The chosen pet sits at
  the bottom right of the main window and plays the state of the task shown
  (idle, working, needs input, ready once a turn ends, blocked), holding
  still when the system reduces motion.
- Settings › Daily Review, as Maka Desktop has it: scheduled analysis on
  or off, its local run time, and the model that writes the report.
- Settings › Usage: the range (24 hours, 7 or 30 days, all), model calls,
  cost, tokens and cache tokens, and the activity log (filtered by model or
  tool and by status, fifty rows a page, each task one click away), with
  the breakdowns by provider, model and tool and the pricing in effect.
- Settings › Health: each model connection's configuration or validation,
  and the default connection's last real run, with a status filter and the
  count of what blocks sending.
- Settings › Archived tasks: search, restore, delete for good, and delete
  every archived task (or the ones found) after asking; the sidebar follows.
- Settings › Import/export tasks: import Codex, Claude Code, or OpenCode
  conversations one at a time (the task opens) or as a marked batch
  (reported on the page), with search and archived conversations; import a
  `.maka-session` file; export a task, with its subagent conversations after
  asking, to one.
- Settings › Data: the workspace path (open its folder, copy it), the backup
  and restore note, and the configuration file in Maka Desktop's format:
  export model connections, the Host's settings, MEMORY.md and (after a
  plain-text warning) credentials, and import them with same-named
  connections skipped or overwritten. A file either app writes imports in
  the other.
- Settings › About: the license and Maka's source and release notes, Copy
  diagnostics (this client and the Host's own report, on the clipboard),
  Report an issue, and the keyboard shortcuts.
- Command palette (⌘K or ⇧⌘P).
- Keyboard shortcuts sheet (⌘/).
- macOS app bundle, `target/bundle/Maka GPUI.app`, built with `just bundle`
  and signed ad hoc.
- The bundle carries the purpose strings macOS needs to ask, rather than
  refuse, when a Runtime Host the app started automates another app or uses
  the camera, microphone, system audio or Bluetooth, the set Maka Desktop
  declares.
- A screen in place of the task view when a Runtime Host of another protocol
  epoch refuses the client (both epochs, the newer side, the pinned commit,
  and the commands that fix it), or when no built Maka checkout is there to
  start a Host from (the path it looked at, and the commands that build it).
- A running turn's status line shows that the turn is alive, as Maka
  Desktop's does: a working phrase that changes every 20 seconds (the first
  one only, with motion reduced) and the time since the message was sent,
  counted each second. While the Runtime retries a provider request the
  line gives the reason and counts down to the attempt, or says the attempt
  is under way.

### Changed

- Speaks Runtime Host compatibility epoch 197, the protocol of the apache/maka
  commit `MAKA_PIN` names; Hosts start from `~/code/maka-pin` unless
  `MAKA_REPO` names another checkout.
- A connection to an endpoint Maka does not know is added as a Custom
  connection with its API protocol (OpenAI Chat, OpenAI Responses, or
  Anthropic Messages), replacing the three custom relay providers.
