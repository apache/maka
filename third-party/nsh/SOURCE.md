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

This directory contains NSH from [`longbridge/nsh`](https://github.com/longbridge/nsh),
synchronized through revision `2452c93d450bfe0ee1e22da5248191ba0a391051`
(version 0.5.0). The original import came from `M4n5ter/nsh`, branch
`tui/terminal-backend`, at `de176695240d550f2b303643b8019146c7989e7f`.

`upstream.json` records the original import and current upstream revision.
`files` holds SHA-256 hashes of the original source bytes; `file_sources`
identifies each file's upstream repository and revision. Local modifications
never replace those provenance hashes. The inventory includes upstream files
excluded from the maintained tree. Original licenses, source, resources, tests
and independent workspaces retain their attribution.

## Upstream integration

Maka uses the canonical NSH component, event, ref, module and typed-style APIs.
Desktop `Input` uses the platform's native editing path; Windows uses upstream's
windowless RichEdit/TSF implementation. The structured skill composer uses
RichEditor's schema and node-view model, as upstream's structured editors do.

Lists, reactive item publication, component event traversal, input modality and
focus-visible behavior use upstream implementations. Immutable captured files
provide indexed rows through the same list items memo and cell publication,
without materializing a full JavaScript array. Asset builds use upstream
app roots and package-relative paths; built-in plugin builds declare the Maka
repository as their shared root. Callers migrate with upstream rather than
keeping aliases or older implementations.

Installed plugin modules are immutable compiled artifacts. A compiler contract
change requires rebuilding and repinning external UI packages; invalidating a
build cache alone cannot update installed modules. Built-in packages are rebuilt
and synchronized with the product.

`platform.idiom === "terminal"` distinguishes cell terminals from graphical
windows. `Environment::ctrl_for_command` maps Command shortcuts to Ctrl on
terminal surfaces. Desktop window operations take explicit `WindowRef` values.

## Retained local capabilities

- **Terminal transport:** `crates/nsh-terminal` and `third-party/icy_sixel`
  provide Kitty, Sixel and iTerm2 pixel transport, shared with the AppKit and
  Direct2D offscreen terminal surfaces and the TUI image store. GPUI and its
  embed example remain retired.
- **Embedding and packages:** configured host loading, lazy plugin chunks,
  `import.meta.assetBase` resource namespaces, main-thread lifecycle hooks and
  terminal inspection are required by Maka's shells and plugin composition.
- **Source-aware reading:** TextView preserves canonical source identity,
  byte offsets and reading anchors through Markdown rendering and repair.
  RichEditor exposes leased geometry for the composer and terminal surfaces.
- **Input ordering and scopes:** `inputAction`, `ScrollIntent`, scoped/fallback
  key bindings and focus-event fences preserve editor actions, IME, paste and
  reload ordering. Scoped lookups also enforce upstream window isolation.

## Maintenance and verification

Compare retained changes against each recorded upstream baseline. Remove local
patches when upstream supplies the same behavior; migrate all product, plugin,
fixture and build consumers together. Keep provenance, generated declarations,
browser bootstrap, dependency notices and CI input/archive coverage current.

Maka's `scripts/ci.mjs` owns the verification entrypoints. Relevant checks include
core/runtime and component behavior, application contracts, TUI and native
terminal input, plugin resource packaging and platform-native integration.
Windows RichEdit/TSF and AppKit behavior require their respective native runners.
