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

# Native Shell (NSH)

This tree retires `crates/gpui`, `third-party/gpui-wgpu` and `examples/embed-gpui`. Desktop rendering uses AppKit (`nsh-platform-macos`), Direct2D (`nsh-platform-windows`) and GTK4 (`nsh-platform-linux`); terminal pixel transport uses `crates/nsh-terminal` together with the AppKit and Direct2D offscreen terminal surfaces. The original upstream inventory in `upstream.json` remains provenance for the imported snapshot, including files subsequently removed.


This directory initially imported the complete tracked source of
[`M4n5ter/nsh`, `tui/terminal-backend`](https://github.com/M4n5ter/nsh/tree/tui/terminal-backend)
at `de176695240d550f2b303643b8019146c7989e7f`. The maintained upstream is
[`longbridge/nsh`](https://github.com/longbridge/nsh).

The complete upstream tree is synchronized through `longbridge/nsh` revision
`323a8663f6fdb63340c634a50da9bbb820037b69`. Earlier selective imports are
consolidated into this baseline; the pixel terminal transport and minimal
retained adaptations remain in this tree.

`upstream.json` retains the initial fork's `repository` and `revision`.
`upstream_revision` records the integrated upstream revision. `files` contains
SHA-256 hashes of original imported bytes; `file_sources` identifies the
repository and revision of each upstream file's baseline. Fork-only files keep
their original hashes and implicit initial-fork source. Merged local content
is never substituted for upstream source bytes. Upstream deletions remove their
source records. The source, tests, resources, original licenses and independent
workspaces are retained; `SOURCE.md` and `upstream.json` are Maka provenance files.

## Current upstream integration

The latest integration uses a three-way merge against each file's recorded
baseline, rather than assuming that previous selective imports shared one
revision. Reusable changes should go to `longbridge/nsh`; later synchronizations
should replace local patches when upstream provides their required behavior.

Maka and retained examples use the current canonical API directly: Rust element
helpers come from `nsh_core::element` and its prelude; JavaScript host services
live in `nsh`, mobile services in `nsh/mobile`, and Input in `nsh/base`. Named
event payloads, element-specific refs and typed styles replace old shapes.
Upstream `ItemAlign` replaces the local `LayoutAlign` declaration helper.
Subscriptions use the unified `on()` API and its returned stop function, with
reactive-owner cleanup; callers no longer expect subscription objects with
`remove()`. Migrate consumers and rebuild declarations and bundles together,
then remove superseded APIs rather than retaining aliases.

`platform.idiom` reports `"terminal"` on cell-based terminals while
`platform.desktop` remains `true` on desktop and terminal surfaces alike; use
`platform.idiom === "terminal"` to distinguish cell terminals from graphical
desktop windows. `Environment::ctrl_for_command` remaps `Command`-based keymap
shortcuts to `Ctrl` on terminal surfaces (including pixel-terminal offscreen
AppKit/Direct2D surfaces). `nsh/desktop` window operations take an explicit
`WindowRef` (`mainWindow()`).

## Retained local capabilities

Local modifications in `third-party/nsh` are kept minimal to ease periodic synchronization with `longbridge/nsh`:

- **GPUI removal and `nsh-terminal`**: `crates/gpui`, `third-party/gpui-wgpu` and `examples/embed-gpui` are removed. `crates/nsh-terminal` and `third-party/icy_sixel` provide Kitty, Sixel and iTerm2 pixel frame encoding and damage/slot state shared with `nsh-platform-macos` (`terminal` feature), `nsh-platform-windows` (`terminal` feature) and `nsh-platform-tui` (`ImageStore`).
- **Chunk loading, `ScrollIntent` and `inputAction`**: `nsh-engine` exposes `ChunkLoader` (`EngineConfig::chunk_loader`) for lazy plugin chunk evaluation; `nsh-core` and `nsh-js` retain `EventKind::ScrollIntent` and `inputAction` for structured editor/reader interactions.
- **Text reading and `RichEditor` integration (`nsh-core`, `nsh-base`)**: `TextView` retains its piecewise `Source` mapping and reading-anchor pipeline alongside upstream Markdown selection, and `RichEditor` exposes `geometry_handle` and honors `Environment::ctrl_for_command` on macOS terminal surfaces.
- **Reactive list and component event fixes (`nsh-core`, `nsh-js`)**: `Core::deliver_component_event` preserves sibling listeners and nested emits, and `ListState` separates deferred length updates from reactive binds while refreshing retained keyed cell `item` values even when zero structural splices occur.
- **Focus-fence ordering, composing `Escape`, and scoped/fallback key bindings**: `EngineControl::events_sent` pairs with `MountSink::handled` so editing keys, shortcuts, IME/composition, paste and `pause_input` barriers wait for in-flight focus-triggering engine events and pending `autoFocus` targets across AppKit, Win32/Direct2D, GTK4 and TUI. Composing `Escape` cancels active preedit cleanly, and `within`/`fallback` key bindings run in scope order without stealing keys handled by focused controls.
- **Desktop shell and terminal-surface host hooks**: AppKit, Win32/Direct2D, GTK4 and `nsh-platform-tui` (`AppView` + `LocalEngine` driver) retain `load_with_config`, `run_app_with_config`, `with_running_view`, `quit_app`, `pause_input`/`resume_input`, `pressable_bounds`, and headless inspection helpers required by Maka's desktop shell, terminal shell and real-Host integration tests.

## Verification and future synchronization

Develop and verify the vendored code together with its Maka callers. Reuse Maka's CI (`scripts/ci.mjs`) for freshly generated declarations, application TypeScript checking, nested `nsh` tests, and native platform suites on Linux (`xvfb-run` GTK4), macOS (AppKit + offscreen terminal) and Windows (Win32/Direct2D + offscreen terminal).

For the next sync, compare each file with its recorded upstream baseline in `upstream.json`, drop local patches superseded by upstream `longbridge/nsh`, migrate consumers to canonical upstream APIs and refresh hashes from the upstream tree.
