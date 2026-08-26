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

## `node-pty@1.2.0-beta.15`

On Unix, `CustomWriteStream` submits raw file-descriptor writes through libuv.
Those writes can survive PTY exit and target an unrelated file after descriptor
reuse. The patch keeps writes synchronous on node-pty's non-blocking PTY master,
checks an `fstat` fingerprint before retries, yields between attempts, and cancels
the queue at the native exit fence. See #2978.

Delete when node-pty ships an equivalent Unix write-lifecycle fix.

## `@ai-sdk/provider-utils@5.0.28`

Streaming tool-call association for gateways that reuse or omit `index` / `id`
(Ollama-style, Anthropic→OpenAI translators). See #1967 / #1976 and
`packages/runtime/src/__tests__/model-factory-tool-call-index.test.ts`.

Delete when that guard passes against an unpatched package.

## `@ai-sdk/open-responses@2.0.29`

The adapter drops every provider-defined tool and only decodes function-call
output items. Alibaba Token Plan exposes its provider-executed Harness web
search over the otherwise supported Responses wire, using
`tools: [{ type: "web_search" }]` and `web_search_call` output items. The patch
lowers that one published tool shape and maps its streamed call/result pair into
the AI SDK provider-executed tool protocol; all other provider-defined tools
remain unsupported. Product-level wire tests pin the request and result shape.

Delete when `@ai-sdk/open-responses` ships equivalent provider-tool support.

## `@astryxdesign/core@0.4.5`

Six published component seams drop host-owned state or semantics:

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

Blank UA-CH `navigator.userAgentData.platform` must also not mean "not Apple".
Electron builds with a rewritten identity ship `platform: ''`, which made every
`mod` hotkey listen for Ctrl and every `Kbd` draw Ctrl on macOS.

Streaming text and Markdown expose an explicit `settledText` seam so the
renderer can verify and advance the exact prefix already presented without
replaying it. The default remains progressive for a genuinely new stream, and
rewritten or later text still reveals and fades from a parsed-visible boundary.

Delete each hunk when the corresponding behavior ships in Astryx.
