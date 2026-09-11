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
(`patch-package --error-on-fail`). To update a patch, edit the installed package
in `node_modules`, then run `node node_modules/patch-package/index.js <name>`.
After a dependency upgrade, apply the still-needed edits to the new version
before regenerating. The command records the installed files, not the old
patch text.

Keep this directory small. Prefer product code that uses the dependency's
published API; only patch for bugs that block shipping and cannot be worked
around at the call site.

## `run@2.1.4` and `@ai-sdk/code-mode@1.0.56`

Code Mode awaits normal Runtime tools, including user interactions. The upstream
wall deadline aborts those waits. The opt-in `timeoutMode: 'execution'` instead
counts cumulative synchronous QuickJS execution, retaining the VM and normal
Promise completion order during asynchronous host waits. Cancellation and worker
pool/memory bounds remain in effect. Wall mode is unchanged. Execution mode
rejects synchronous host functions/module loaders, which Maka does not expose.
Callers must supply a reachable cancellation signal: a guest Promise that never
settles retains its Worker until cancelled, even without an outstanding Host tool.
There is no automatic liveness deadline or deadlock detector.

The patched package requires Maka's Node >=22.19 baseline and drops the optional
TypeScript peer used only by upstream's older-Node fallback. Maka uses native
`node:module.stripTypeScriptTypes`, so a second compiler is unnecessary and the
upstream peer range otherwise conflicts with the repository's TypeScript 7.

The SDK patch only forwards this policy. Its nested patch path follows the locked
workspace installation through `node_modules/@maka/runtime`. No continuation,
replay, result ordering, or Worker pool is added to Maka.

`run-2.1.4-source.diff` is the readable source corresponding to the run patch.
To rebuild, check out upstream `vercel-labs/run` tag `run@2.1.4`
(`0207eebde4fc9c04b35d8414773a7dea6c552115`), apply that diff, install with
`pnpm install --frozen-lockfile --ignore-scripts --filter run...`, and run
`pnpm --filter run build`. Copy the changed `dist` files into the installed run
package and regenerate with `node node_modules/patch-package/index.js run`.
Copy the patched package manifest as well, and pass `--exclude '^$'` when
regenerating so patch-package includes that manifest change.
The large generated hunk is the inline Worker with unchanged embedded WASM;
`run-2.1.4-notices.md` retains its embedded dependency notices.

Remove both patches and the run override when published versions support the
same execution budget semantics. Regression coverage lives in
`packages/runtime/src/__tests__/code-mode.test.ts`: long host waits with dependent
Promise.race progress, pending-host compute timeout, cumulative compute across
awaits, and the existing cancellation/drain and resource-limit cases.

## `@earendil-works/pi-tui@0.84.4`


Editor undo snapshots deep-clone all stored paste strings for each typed word,
so a 1 MiB paste followed by 60 words retains roughly 60 MiB of duplicate text.
The editor now copies its mutable state, lines array, and paste Map while
sharing immutable strings. All undo steps, paste renumbering, and submission
cleanup are preserved; the generic undo stack used by Input stays unchanged.
Snapshot creation and storage are private, with no published clone policy
that product code can configure.

Delete the patch when upstream shares immutable paste strings across undo snapshots.

## `zod@4.5.4`

Recursive schemas retain their last parse context and bucket in schema closures,
keeping the input and output graphs alive for the schema's lifetime. Containers
also leave entries on the global allocation stack when synchronous parsing
throws, including cycles through transforms. The patch keeps memoization in the
parse context and restores allocation state in `finally`, including a pending
outer allocation during reentrant parsing. Recursive cycles and shared aliases
still use the existing per-parse memoization.

Delete the patch when upstream releases completed parse state in both ESM and CJS.
Before upgrading Zod, re-verify allocation handoff, reentrant parsing, and cycle/alias
identity against the new memoizer and container implementations.
The Runtime `zod-recursive-contract.test.ts` suite covers both shipped entry points.

## `@modelcontextprotocol/client@2.0.0`

Pending transport sends retain settled request arguments and results through
error observers, even after response, abort, timeout, or connection close.
The ESM and CJS patches scope cancellation observers independently and revoke
the request observer's native `reject` reference in request cleanup. Late send
errors still remove progress handlers, and cancellation send errors still reach
`onerror`; queued frames and connection behavior stay intact. The private SDK
request funnel has no public observer-lifetime hook for a call-site fix.

Delete the patch when upstream releases settled request observers despite transport backpressure.

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

## `@ai-sdk/provider-utils@5.0.40`

Streaming tool-call association for gateways that reuse or omit `index` / `id`
(Ollama-style, Anthropic→OpenAI translators). See #1967 / #1976 and
`packages/runtime/src/__tests__/model-factory-tool-call-index.test.ts`.

Delete when that guard passes against an unpatched package.

## `@astryxdesign/core@0.5.2`

The shared code tokenizer caches only valid language definitions. Caching `null`
for arbitrary unsupported fence labels grows a process-lifetime map; a short
label can also be a sliced string retaining its entire Markdown message after
unmount. Unknown labels keep their plain-text fallback, and known languages
keep reusing compiled regexes. A call-site language filter would duplicate the
dependency's language list, discard the displayed label, and miss the shared
CodeEditor path. Delete this hunk when upstream stops caching unsupported labels.

`CodeBlock` retains memoized line chunks, but lays them out without guessed
intrinsic heights. Replacing those estimates on first visibility changed the
transcript scroll range (#5184). Keep layout/style/paint containment. Remove
this hunk when upstream offers equivalent stable geometry; the default-mode
geometry CI covers 1200 lines without any ablation override.

`ChatComposerInput` synchronizes external controlled values into its editable
DOM in a layout effect. A passive effect can leave the old multiline draft
visible for a frame after the sent message is rendered; clearing it later
shrinks the dock and moves the already-positioned transcript. The existing
echo and selection guards stay unchanged.
The short, multiline, tall and completion submission stories in
`apps/desktop/stories/app-shell.stories.tsx` protect this layout contract.

The other component changes preserve host-owned state and semantics:

- `ChatLayout.autoScroll` forwards the existing hook's `enabled` option so
  Maka's transcript authority can own scrolling without competing with the
  dependency's auto-follow listeners and writes.
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
