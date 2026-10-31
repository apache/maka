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

This directory initially imported the complete tracked source of
[`M4n5ter/nsh`, `tui/terminal-backend`](https://github.com/M4n5ter/nsh/tree/tui/terminal-backend)
at `de176695240d550f2b303643b8019146c7989e7f`. The maintained upstream is
[`longbridge/nsh`](https://github.com/longbridge/nsh).

The complete upstream tree is synchronized through main revision
`a5036af48ddc193b5023ece9b9196c76b8f8d3f5`. Earlier selective imports are
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

The GPUI backend uses upstream's shared image loader while retaining isolation
between host asset loaders and reload identities. Reads retain priority and
cancellation without a fixed queue-length rejection; local files keep their
existing unrestricted read path, while HTTP responses retain the download
size boundary. List integration keeps the
local source-publication fence, `ProjectRoot` projection and `RetireListCell`
ownership model. The existing model already preserves keyed row owners when
indices change, covering upstream #740 without a second item-memo mechanism.
Built-in List scrollbars remain independent decoration roots and stay above
projected rows across rebinds and theme replacement.

## Retained local capabilities

The terminal backend (`nsh-platform-tui`), terminal hosts, packaging, examples,
fonts and terminal-specific documentation remain maintained here. Terminal
selection and text measurement retain cell-aware behavior and the
`TextEngine::measure_canvas` override. Selectable roots, popup scopes,
focus return and root retirement retain their existing ownership rules.
Code Editor and RichEditor terminal input sinks use `BoxNone` for pointer hits
and native post-mount `autoFocus`. The terminal backend evaluates native
component animated slots and ignores Shader drawing while retaining its
background and children.

GPUI input targets carry weak editor identities, focus generations and native
owner admission tokens. Delayed edits cannot move to a replacement editor.
Composition preserves UTF-16 replacement ranges, marked selections and
cancellation; held key releases follow their presses. Reload drains admitted
operations before draft saving, without time-based edit expiry. NSH owns the
editor and rendering; Maka owns ordered delivery and admission for the
experimental OSC 777 `nsh-text-input` extension. This does not establish
stock-terminal IME support.

GPUI, terminal and AppKit input support `InputRef.replaceRange` for one undoable
completion edit after checking the observed source, selection and edit count.
Generic GPUI and terminal input `tokens` derive styled and atomic ranges from
committed text; plain text remains authoritative and IME preedit stays separate.
Scoped `keymap.bind` fallback bindings run after native editing, selection and
navigation leave a key unhandled. Host keyboard conventions, explicit event
policy and custom binding precedence remain local contracts.

The AppKit `AppView::load_with_config`, `run_app_with_config`,
`with_running_view`, `AppView::choose_directory`, `AppOptions::min_size` and
`AppOptions::frame_autosave_name` let Maka's desktop shell run its own
`EngineConfig` on an opt-in path. An accessibility press and scoped and fallback
key bindings complete that path; AppKit input has no `tokens`.

Host-provided GPUI paste and terminal bracketed paste follow the focused
editor's existing `onPaste` and `pasteBehavior` policy. A complete pasted path
list becomes files only for inputs listening for file drops, and is delivered
once without inserting path text. GPUI external file dragging remains a local
adaptation submitted as upstream #591; paused input installs no drop layer.
`AppView::pressable_bounds` lets Maka's real-Host tests locate accessible
pressable views through the production window tree.

Retained JS row values return only to their owning function table, and a changed
retention handle remains a prop change even when numeric columns match.
`Registry::value` provides lazy host-owned values shared by imports and
`nativeModule` within one VM. Layout observation uses allocation lifetimes
independent of reusable slab indices. RichEditor geometry remains owned by
its thread and retires its subscription before dropping the payload.

Workbench modules use `importModule` and `EngineConfig.chunk_loader` through
the existing chunk runtime. `ChunkSource` provides the module asset directory
for `import.meta.assetBase`; engine shutdown cancels outstanding loads.
Terminal `AppView::load_with_config` retains host services, assets and the
loader while using actual terminal geometry. Bundled assets retain distinct
logical package paths and physical sources; content-based resource families
include bitmap density variants. Packaging, serving, watching and lazy font
loading use the same mapping. Windows UNC adaptation proves native file
identity before changing Rolldown entry spelling.

Android preserves local mount opcodes 34 (retire), 35 (project), 36 (component
slots) and 37 (Shader), separately from accessibility role indices. Maka keeps
its version-30 GPU dependencies and GPUI patches for input admission and
cancellation. The vendored GPUI owning workspaces reuse those containing-Maka
patches. Live code blocks retain their language header and actions; shared
gallery styling stays in the private `examples/nsh-gallery-ui` package.

## Verification and future synchronization

Develop and verify the vendored code together with its Maka callers. Reuse
Maka's existing CI for freshly generated declarations and application
TypeScript checking, plus its nested NSH suites; root workspace tests alone do
not select the independent workspaces. The nested checks cover core, base,
engine, JS, headless, terminal, bundler and development tooling, portable Web
text behavior and selected offscreen GPUI ownership/queue behavior. Native
window dispatch, browser rendering and device behavior require their supported
environments; source synchronization does not itself establish those results.

For the next sync, compare each file with its recorded upstream baseline,
merge still-required local behavior, migrate consumers to upstream APIs and
refresh hashes from the original upstream tree. This uses the existing source
records and CI rather than adding a separate synchronization framework.
