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

# Phase 3: Desktop parity for settings and the sidebar pages

Status: started 2026-09-28. Decided by the user after comparing the client with Maka Desktop
0.2.0-dev.49: port the settings content and the sidebar pages the client lacks, and make
paste work in the composer.

## Decisions

- **Protocol pin.** The client follows upstream `apache/maka` main, checked out detached at
  `~/code/maka-pin` and recorded in `MAKA_PIN` (de4fc5ff9, compatibility epoch 197). Every
  page below is written against that checkout's Desktop and protocol. `~/code/maka-agent`
  is a working copy used for other work; nothing here builds or runs in it.
- **Scope.** Class A (pages whose data and actions are Runtime Host operations) and class D
  (WorkHub, remote access through chat bots, remote Hosts, appearance extras, the
  permissions page, updates), after a survey of what each needs from a non-Electron client.
- **Not in this phase** (the user did not pick them): class B, account logins through OAuth,
  the external agent (Antigravity) and scheduled-task local reminders, which all need the
  client to answer `client.capability.call`; class C, MCP, which Desktop runs in its main
  process with its own MCP clients. Where a D item needs the client-capability channel
  (WorkHub), that item builds the channel, and B can reuse it later.
- **gpui-kit from git, for now.** The changes panel and the transcript's diffs use the kit's
  Diff component (gpui-kit #3378, #3388), which is on `longbridge/gpui-kit` main only, so the
  root `Cargo.toml` pins `gpui-kit` to git rev 1e41f17 (2026-10-08). When the next crates.io
  release ships (expected 2026-10-12), move back to it: `gpui-kit = "<version>"` in place of
  the git line, then `cargo update -p gpui-kit`, and read the kit's release notes for what
  changed since 1e41f17.
- **Settings become a full-window surface**, as in Desktop: "← Back to app" at the top of a
  settings nav that takes the sidebar's place, grouped Preferences / Capabilities /
  Activity / System, each page with a title and a one-line description on the plate. Five
  sections fit a dialog; seventeen do not.

## Reference

The Desktop code at the pin: nav and scopes `apps/desktop/src/renderer/settings/settings-nav.ts`,
page components `apps/desktop/src/renderer/settings/*-page.tsx`, row kit `settings-rows.tsx`
and `settings-section.tsx`, copy `apps/desktop/src/renderer/locales/settings-*-copy.ts`
(Desktop's `zh-CN` / `zh-TW` are our zh-Hans / zh-Hant; use Desktop's strings), IPC in
`apps/desktop/src/main/*-ipc-main.ts`, operations in
`packages/runtime-host/src/protocol/operations.ts`. When Desktop's page and this document
disagree on a detail, Desktop wins unless this document says why not.

## Work packages

Two lanes run at once: the settings lane in `crates/settings` and the main-window lane in
`crates/app`, `crates/session` and `crates/conversation`. Both add operations to
`crates/host-protocol` and copy to `crates/shared/src/copy/`, in separate modules.

### Done

- Paste and drop in the composer (45dc38f, ed2da63): Cmd+V of Finder files or an image,
  files dropped on the dock, folders refused, images over 2000 px scaled to PNG, TIFF/BMP
  sent as PNG; a sent message shows its files above the bubble.

Status 2026-09-29: every package below is in main (1b2b8f9, 954 tests, clippy and fmt clean).
Status 2026-10-06: six review rounds (9–14, `docs/design/review/`) later, Opus 5.5 and
Fable 5.1 both judge every new surface READY at 8.5/10; the remaining should-fix items are
listed in `round-12.md` and `round-14.md`.

| Pkg | Commits | Left out (reason in the commit bodies) |
|---|---|---|
| P0 | 0a171df | `session.prompt-suggestion.generate` and other new operations unmodeled |
| S1 | f488797 | Runtime Host picker in the header (then D2b), narrow icon-only nav |
| S2 | 2527327, 609ce16 | terminal font size, Workbar switch, WorkHub switch, Dock bounce |
| S3 | 1480d39, 0d6e3d8, 38dd4c5 | account sign-in (class B), brand logos (licenses) |
| S4 | d0e3726 | memory tags (the Host's `remember` takes none) |
| S5+S6 | 11275e1, f15bf11, 9b262fc, 22c00bd | clear input history (no history kept), Desktop-only Health layers, updates |
| M1 | fad3d61, d7e0eb0 | MCP tab (class C), skill Use button (no skill mentions yet) |
| M2 | c1700ec, 05a1adb | the native-effect service for reminders (class B) |
| D1a/D1b | 396cbfe, 39345fb, 664cf48 | ⌘Tab icon (only an `unsafe` AppKit call sets it), pet shadow |
| D2a/D2b | 38b5584, 93c8f5b..1b2b8f9 | Direct peer, sharing this Host, credential rotation (need a service-managed Host) |
| D3a/D3b | 8aef744, 8c6053f..a0fccb3 | scheduled-task delivery to a bot (class B) |
| D4 | 8ee7e4d, b4d277f, ec8dea6, cb053e9 | permissions page and updater, as planned |

### P0. Protocol 197 (first, blocks the rest)

Types, fixtures, `MAKA_PIN`, default checkout `~/code/maka-pin`, drift check, demo root on a
197 Host.

### Settings lane

| Pkg | Sections | Operations |
|---|---|---|
| S1 | Frame: full-window settings, nav groups and descriptions, the row kit (toggle, select, text, value, mono path, action), every `runtime.policy.mutate` kind, the current five sections moved into the new IA (General: language with Follow system, default permission mode; Appearance: theme; Workspace: projects; Models: connections; About) | runtime.policy.* |
| S2 | General: display name, tone, incognito, completion notification, project instructions, Code Mode, default model, permission mode, Bash shell, network proxy with credential and test. Appearance: palettes, UI font size | runtime.policy (set_personalization, set_privacy, set_workspace_instructions, set_chat_defaults, set_shell), runtime.policy.network-proxy.update, network-proxy.test, credential.vault.*, connection.catalog.set-default-target |
| S3 | Models: provider catalog, edit name/key/URL, test, refresh the model list, add a model by hand, model parameters, request headers and extra body | connection.catalog.*, credential.vault.*, connection.models.fetch, connection.test.run, connection.request-headers.* |
| S4 | Subagents; Memory; Web search (Beta) | runtime.policy (set_subagents, set_memory, set_web_search), memory.query/mutate, web-search.execute, credential.vault.* |
| S5 | Usage; Health (connection, validation and recent-run layers) | usage.query, connection.catalog.query, host.diagnostics.query |
| S6 | Archived tasks; Import/export; Daily review; Data (path, open, copy, clear input history, configuration export/import in Desktop's file format); About (copy diagnostics, shortcuts, links) | session.catalog.*, session.lifecycle.set, session.remove*, external-session.*, session-bundle.*, daily-review.*, configuration.credentials.export, host.diagnostics.query |

### Main-window lane

| Pkg | Surface | Operations |
|---|---|---|
| M1 | A main-area router (the plate shows a page instead of a task); sidebar entries under New task; Extensions › Skills (installed and discover, detail with enable, pin, update review, delete, open SKILL.md, import a local skill). Also: every attachment chip gets its kind icon | skill.catalog.query/mutate/preview-update |
| M2 | Scheduled tasks: my tasks and runs, search, filter, sort, new/edit form with presets and repeat rules, enable, run now, snooze, clear history, duplicate, delete; the Daily review tab | scheduled-task.query/mutate, scheduled-task.changed, daily-review.* |

Local reminders and bot delivery of a scheduled task stay with Desktop until class B: a
task whose delivery needs a client service says so on its row instead of pretending.

### Class D

From a survey of the pin (2026-09-28). Each item ships its smallest coherent slice.

| Pkg | Slice | Why this slice | Size |
|---|---|---|---|
| D1 | Appearance: Desktop's 11 palettes (six base colours per palette in light and dark, surfaces derived the way `maka-tokens.css` derives them, converted from oklch), the app icon (Desktop's built-in set, a dark-mode variant, import of a PNG/JPEG cropped square), then the custom pet (`maka.pet/v1` packs from `<stateRoot>/pets/v1/`, drawn bottom right of the main window, reduced motion respected) | All client-side; the palettes are token sets and copy over directly | M |
| D2 | Remote Hosts, first the transports a user can set up by hand: a profile store, WebSocket over TLS (and plaintext with the explicit acknowledgement) with a bearer credential, an SSH `-L` tunnel in batch mode, pairing through `access.credential.finalize`, and a Host switcher. Then sharing this Host (connection code and `service peer enable|disable` through the Maka CLI, revoke through `access.principal.revoke`). Direct peer (libp2p) last | The handshake after the transport is the one the client already speaks; Desktop's connection code needs Direct peer, which means embedding `native/runtime-host-peer` | L |
| D3 | Remote access by chat bot: a Node sidecar that runs `@maka/runtime/bots` from the Maka checkout against the local Host, configured from the client's own file; Telegram first, Feishu next; settings page with credentials, enable, test | Desktop's bot runtime is plain Node inside its main process; a Rust port is one package per platform. Needs real bot accounts from the user to test | M + M |
| D4 | Packaging: `NSAppleEventsUsageDescription` in the bundle, notification authorization for the completion notification; a clear screen when the Host's epoch differs from the client's (both epochs, and what to update) | The permissions page serves Computer Use, which this client does not have; Desktop's updater feed ships Electron bundles | S |

Held back, with the reason given to the user: **WorkHub**. Upstream still keeps it behind a
dev-only switch ("WorkHub is not available yet"), and its turns are admitted only when the
client provides eight tools, including one that operates the Maka window and six embedded
browser tools. A second client could only register stubs for those, which bypasses the
contract; the clean path is an upstream profile without them. **Auto-update** and the
**permissions page** as pages, for the reasons in D4.

## Acceptance for every package

- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  `cargo test --workspace --locked`; tests for each action against the scripted Host.
- Copy in en, zh-Hans and zh-Hant, from Desktop's tables where Desktop has the string.
- Palette roles and type rungs from `docs/design/polish-2026-09-26.md`; no hex outside the
  theme module.
- Screenshots, light and dark, at 1512x885, taken by the main session with `--passive`
  against `target/demo-root`, compared with Desktop.
