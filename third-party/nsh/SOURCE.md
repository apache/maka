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

The complete upstream tree is synchronized through release `v0.4.0`
(`e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`). Earlier selective imports are
consolidated into this baseline; the terminal backend and other local
adaptations remain in this tree.

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

`platform.desktop` is the canonical graphical-desktop check, including desktop
browsers and excluding terminal rendering. `platform.idiom` describes the
device, so a terminal on a desktop OS may still report `"desktop"`.
`platform.select` on terminals selects `terminal`, the host OS, `native`, then
`default`; `nsh/desktop.isAvailable` includes the terminal title and menu APIs.

## Retained local capabilities

Local modifications in `third-party/nsh` are kept minimal to ease periodic synchronization with `longbridge/nsh`:

- **GPUI removal and `nsh-terminal`**: `crates/gpui`, `third-party/gpui-wgpu` and `examples/embed-gpui` are removed. `crates/nsh-terminal` provides Kitty, Sixel and iTerm2 pixel frame encoding and damage/slot state shared with `nsh-platform-macos` and `nsh-platform-windows` (`terminal` feature).
- **Focus-fence input ordering (`nsh-engine`, `nsh-platform-macos`, `nsh-platform-windows`, `nsh-platform-linux`)**: `EngineControl::events_sent` pairs with `MountSink::handled` so editing keys, shortcuts, IME/composition, paste and `pause_input` barriers wait for in-flight focus-triggering engine events and pending `autoFocus` targets even when no text is queued. Terminal composition commits and pastes re-validate `(NodeId, focus_generation)` before applying.
- **Desktop and terminal composing `Escape`**: Pressing `Escape` during active IME/marked-text preedit cancels composition without firing `onKeyPress("Escape")`, blurring the editor, matching `keymap` `Escape` bindings, or dismissing an enclosing `Modal`/popover across AppKit, Win32/DirectWrite and GTK4.
- **Scoped/fallback key bindings and `replaceRange` across desktop and TUI**: AppKit, Win32, GTK4 and TUI advertise `native_focus_scopes` and `fallback_key_bindings`, run `fallback` bindings only after focused editing, selection, scrolling and navigation leave a key unhandled, and implement `Command::ReplaceRange` (`InputRef.replaceRange`) with UTF-16 boundary, `maxLength`, selection and edit-count checks. GTK4 also honors `Command::Focus`/`Blur` on focus-stop `NshView`s.
- **Desktop shell and terminal-surface host hooks**: AppKit (`load_with_config`, `run_app_with_config`, `with_running_view`, `choose_directory`, `min_size`, `frame_autosave_name`, `pressable_bounds`, clean Apple Event quit), Windows (`AppSource::Config`, `load_with_config`, `run_app` activation observer, `with_running_view`, `quit_app`, modal-scoped `pressable_bounds`, hidden/detached focus invalidation, keyboard Enter/Space press state machine, Direct2D/DirectWrite thread-local teardown before graphics device state) and GTK4 (`load_with_config`, `run_app_with_config`, `with_running_view`, `quit_app`, `pause_input`/`resume_input`, host `image_assets`) expose the hooks required by Maka's desktop shell and real-Host integration tests.
- **Terminal backend (`nsh-platform-tui`) and `RichEditor` / headless fixes**: `nsh-platform-tui` retains `AppView::load_with_config`, cell-aware selection and `TextEngine::measure_canvas`, `Input` `tokens` and `replaceRange`. `nsh-base`'s `RichEditor` forwards reactive `readonly` state to its native `Input` sink, and `nsh-testing`'s headless list falls back to the surface viewport on reinsertion before parent layout bounds arrive.

## Verification and future synchronization

Develop and verify the vendored code together with its Maka callers. Reuse Maka's CI (`scripts/ci.mjs`) for freshly generated declarations, application TypeScript checking, nested `nsh` tests, and native platform suites on Linux (`xvfb-run` GTK4), macOS (AppKit + offscreen terminal) and Windows (Win32/Direct2D + offscreen terminal).

For the next sync, compare each file with its recorded upstream baseline in `upstream.json`, drop local patches superseded by upstream `longbridge/nsh`, migrate consumers to canonical upstream APIs and refresh hashes from the upstream tree.
