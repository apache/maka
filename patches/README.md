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

# patches

Applied on root `postinstall` via `scripts/apply-dependency-patches.mjs`
(`patch-package --error-on-fail`). After bumping a patched dependency, re-run
`npx patch-package <name>` so the filename tracks the installed version.

Keep this directory small. Prefer product code that uses the dependency's
published API; only patch for bugs that block shipping and cannot be worked
around at the call site.

## `@tufjs/models@5.0.0` and `@sigstore/core@4.0.1`

The published ECDSA verification paths rely on Node choosing a digest when
`crypto.verify` receives `undefined`. Electron 43's crypto runtime rejects that
call with `ERR_OSSL_EVP_NO_DEFAULT_DIGEST`, so packaged Desktop cannot load the
Sigstore TUF root or verify Rekor and DSSE signatures for an update. The patches
select SHA-256 for RSA/ECDSA and preserve digest-free EdDSA verification at the
two shared crypto seams.

Delete each patch when the corresponding package ships explicit SHA-256
verification and the Electron regression tests pass without it.

## `node-pty@1.2.0-beta.15`

On Unix, `CustomWriteStream` submits raw file-descriptor writes through libuv.
Those writes can survive PTY exit and target an unrelated file after descriptor
reuse. The patch keeps writes synchronous on node-pty's non-blocking PTY master,
checks an `fstat` fingerprint before retries, yields between attempts, and cancels
the queue at the native exit fence. See #2978.

Delete when node-pty ships an equivalent Unix write-lifecycle fix.

## `@ai-sdk/provider-utils@5.0.34`

Streaming tool-call association for gateways that reuse or omit `index` / `id`
(Ollama-style, Anthropic→OpenAI translators). See #1967 / #1976 and
`packages/runtime/src/__tests__/model-factory-tool-call-index.test.ts`.

Delete when that guard passes against an unpatched package.

## `@astryxdesign/core@0.5.2`

Five published component seams drop host-owned state or semantics:

- `ChatLayout` needs a conversation identity that resets scroll/unread state
  without remounting its composer slot and discarding the live draft.
- `ChatLayout` owns auto-follow and publishes no way to say "this scroll is
  deliberate navigation, release it". Its scroll-direction unlock cannot infer
  that: it discards any scroll event carrying a changed `scrollHeight` as a
  resize artefact, and a host that mounts a turn before scrolling to it
  produces exactly that. Without the seam the prompt rail's jump into an
  unmounted turn is dragged straight back to the bottom (#2923), and no call
  site can fix it — re-aiming frame by frame wins the mount and then loses to
  the follow spring that outlives it. `unlockAutoFollow` on
  `ChatLayoutContextValue` publishes the hook's existing `unlock`.
- `ChatToolCalls` needs a stable row slot for product styling and E2E geometry.
- `List` must forward its published `aria-label` to the rendered list element.
- `SideNavItem` needs an interactive `trailingAction` sibling between its
  navigation control and nested items. `endContent` renders inside the primary
  control, while a sibling outside `SideNavItem` can only come before the
  project control or after all of its tasks; neither produces the visual Tab
  order used by the task rail.
- `DropdownMenuItem` must forward `aria-busy` to its row. The composer's
  Skills entry holds its look steady while the Skill catalog refreshes and
  defers activation meanwhile; without the attribute the row announces
  "available" to assistive technology and silently ignores the action.

Streaming text and Markdown expose an explicit `settledText` seam so the
renderer can verify and advance the exact prefix already presented without
replaying it. The default remains progressive for a genuinely new stream, and
rewritten or later text still reveals and fades from a parsed-visible boundary.
Markdown can also transform the displayed prefix immediately before its
existing incremental parser, so host syntax such as math stays behind the
streaming cursor without adding another parser or scheduler.

One hunk is a geometry fix rather than a seam. `ChatLayout`'s frosted dock
layer is a per-density constant (80/100/120px) while the dock it fades is
sized by its content. At `balanced` the 100px layer starts 90px inside the
opaque composer, so the ramp is invisible wherever the composer paints and
134px of transcript stays crisp under the dock — the fade only ever shows in
the gutters flanking the composer. The layer now fills the dock container and
sits behind its chrome, so the scroll button still reads crisply on top of it.
No product override can reach this: the layer renders with `stylex.props()`
alone — no `themeProps`, no `data-*`, no custom property — so the only handle
is a structural selector that breaks the moment a caller passes
`scrollButton={null}`. See #3446.

Delete each hunk when the corresponding behavior ships in Astryx.
