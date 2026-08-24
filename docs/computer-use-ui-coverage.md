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

# Computer Use Semantic UI Coverage

Status: maintained source and runtime inventory for Maka Desktop's
Computer Use target, state, focus, action and effect semantics.

This document defines what "covered" means for Computer Use operability. A page
is not complete merely because it renders or because every button has a
non-empty name. Critical surfaces must expose an unambiguous target, state,
keyboard/focus behavior, and an observable effect.

This gate is not a claim of complete WCAG conformance or complete assistive
technology behavior. In particular, live-region and announcement completeness
are not measured here; they require separate accessibility testing.

## Automated surface inventory

| Surface | Runtime states | Semantic actions and effects |
|---|---|---|
| Settings | Every current top-level navigation entry is enumerated from the running UI; provider list/detail/catalog/add, subagent editor, memory populated, permission diagnostics, import empty/ready, usage variants, Daily Review selector and narrow states are in Storybook | Navigation exposes `aria-current`; focused nested stories exercise dialogs, disclosures, selectors and editors |
| Extensions | Skills empty/installed/bundled/update/disabled/narrow/inspector; MCP setup/marketplace/configured/inspector/editor/failure/narrow | Page selection, inspector/editor opening and actionable-node identity |
| Scheduled work | Empty/configured/long/narrow/task inspector; Daily Review loading/error/refreshing/report | Task selection, dialog focus, selector state and report actions |
| Conversation shell | New task, settled conversation, streaming, permission wait, native conversation, modes, context and inline completion | Composer submit effect, unique per-task and per-turn actions, current regions and workbar selection |
| Workbar | Launcher plus side chat, changes, active terminal, browser chrome, files, tasks and trace states | Selected tabs, terminal input reaches the PTY bridge, browser navigation reaches the browser bridge |
| Dialogs and overlays | Rename, scheduled-task form, Mermaid fullscreen, side-chat close, onboarding QR, WeChat QR, Runtime Host SSH and remote directory chooser | Dialog naming/focus, rename callback, close confirmation, SSH input, directory navigation and registration |
| Generated content | Markdown, tool output, attachments, Mermaid and HTML artifact iframe | Scoped copy actions, fullscreen dialog and sandboxed iframe semantics |
| Embedded browser page | Live `WebContentsView` on a loopback fixture | Separate observe -> semantic ref -> fill/click -> business-effect smoke through the production browser bridge |

The Storybook catalog is exhaustive for its source-defined entries and the
smoke runner carries a required Computer Use story manifest for critical
runtime boundaries. The Electron accessibility test dynamically enumerates
settings navigation, then covers modules, global overlays, conversations and
all workbar entry points.

## AX completion gates

Every measured final state fails on:

- an AX tree with zero exposed nodes, including trees containing only ignored
  Chromium source records;
- an actionable node without a name;
- two actionable nodes with the same role, name and semantic scope;
- more than one primary `main` landmark;
- a dialog without a name;
- a checkbox, radio, switch, menu checkbox/radio, option, tab, combobox,
  slider or spinbutton without its required state/value;
- focus inside an inert or `aria-hidden` surface;
- a visible modal dialog that does not own focus.

Critical stories and Electron journeys additionally assert action-specific
effects. Overlay journeys wait for the specifically named prior dialog to
close before opening and auditing the next one. Transport success or a generic
dialog match alone is not accepted.

Repeated message and answer actions use a bounded excerpt of visible text plus
a stable human-readable timestamp. Opaque storage IDs remain machine data and
are not spoken as the user-facing differentiator.

## Platform boundaries

- Renderer and same-process iframe semantics are validated through Chromium's
  full AX tree.
- Embedded browser content is a separate `WebContentsView`; it is validated
  through its production semantic snapshot/action bridge, not falsely claimed
  as part of the renderer tree.
- xterm surfaces run with `screenReaderMode` and have active PTY and SSH input
  fixtures.
- Third-party page markup, Chromium's PDF plugin, native file dialogs and
  operating-system permission dialogs remain owned by their respective
  platform/provider. Maka validates the controls it owns around those surfaces
  and fails closed when the external target is unavailable or ambiguous.
- Native macOS AX and Windows UIA packaged-app spot checks remain release gates;
  Linux CI cannot substitute for those platform trees.

## Performance contract

The product adds no accessibility dependency, production AX/DOM walker, global
`MutationObserver`, timer, polling loop, OCR model or hidden duplicate agent UI.
Semantic names and state are emitted by the existing React render. All full-tree
walking, duplicate detection and inventory enforcement run only in tests and
developer tooling. Existing lazy module, workbar and dialog loading remains
unchanged.
