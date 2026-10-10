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

# Upstream issues to fix ourselves

Problems found while building this client that belong upstream (apache/maka, gpui-kit). Each
entry says where it was seen, why it happens, and the fix we have in mind. Nothing here has been
reported yet.

## Maka: a ninth interactive terminal shuts the Runtime Host down

Found 2026-10-10 while building the terminal (Phase 4, F33/F35). Seen at apache/maka
`de4fc5ff9` (2026-09-28, compatibility epoch 197); check main before fixing.

**What happens.** `runtime.resource.start` for an interactive terminal, when the Host already
has 8 live PTY runs, answers `internal_failure` ("Runtime Resource operation failed") and then
shuts the whole Host down. Every client connection drops, running turns are cut off, and the
live terminals come back `orphaned` after the restart. Maka Desktop is exposed the same way: its
terminal tab calls the same operation.

The cap is easy to reach without opening eight terminal tabs. It is manager-wide, shared by every
session, and the agent's own interactive background tasks count against it.

**Why.**

1. `packages/runtime/src/shell-run-manager.ts:1941-1948` (`reserveSlot`): when
   `reservedPtyRuns >= maxLivePtyRuns`, it throws a plain `Error` ("No free interactive (PTY)
   background task slot …"). The limit is `DEFAULT_MAX_LIVE_PTY_RUNS = 8` in
   `shell-run-contract.ts:45`.
   - The non-PTY cap (`DEFAULT_MAX_LIVE_SHELL_RUNS = 64`, lines 1933-1939) takes the same path.
   - When the agent hits a cap through its own tool, this message is fine: it reaches the tool
     result and tells the model to wait.
2. `packages/runtime-host/src/server/runtime-resource-coordinator.ts:755-769`
   (`#resourceFailure`): every error that is not `isNotFoundError` calls `this.#requestDrain()`
   and returns `internal_failure` with a fixed message. The manager's explanation is dropped.
3. `packages/runtime-host/src/server/host-kernel.ts:350-359` (`#requestDrain`): marks the
   shutdown as requested, arms the shutdown deadline and begins draining the composition. The
   Host exits once it is quiet.

The drain exists for broken state, such as an unreadable projection or session header. A full
slot is an expected refusal, and the caller should be able to recover from it.

**Fix we have in mind.**

- **Typed error.** In `shell-run-manager.ts`, throw a typed capacity error (for example
  `ShellRunCapacityError { mode: 'pty' | 'background', limit }`) instead of a plain `Error`.
- **No drain for the cap.** In `#resourceFailure`, map that error to a mutation failure without
  draining and keep the manager's message. `MUTATION_ERRORS` (`protocol/runtime-resource.ts:61-70`)
  has no capacity code, so there are two options:
  - Reuse `operation_conflict`. The wire shape does not change and the epoch is not bumped.
  - Add a dedicated code such as `capacity_exceeded`. This is cleaner, but it is a closed-shape
    change, so it must bump the compatibility epoch.
  - Either way, Desktop's terminal tab and this client should then show "limit reached" instead
    of a disconnect.
- **Reads drain too.** `runtime.resource.query` drains the Host when a task's resources cannot be read (`#queryFailure`, line 386), so listing an unreadable task shuts the Host down; this is why the client does not list every task to count live PTYs (F41).
- **Audit the other drains.** Check the other `#requestDrain()` calls in the same coordinator
  (lines 386, 750) and the same pattern in `artifact-coordinator.ts` (166, 500). Keep the drain
  only for broken state, never for an expected refusal.
- **Test.** A coordinator test where the manager is at its PTY cap: `start` gets the typed
  failure with the manager's message, and the Host is not draining.
- **Repro.** Run a Host on a scratch State Root with `maxLivePtyRuns: 1` (or start nine
  terminals). The second (or ninth) `runtime.resource.start` returns `internal_failure`, and the
  Host logs its shutdown.

**Mitigation in this client.** F35 refuses a start when the PTYs it can see live across tasks
reach 8, and treats an `internal_failure` from start as "the Host is restarting". It counts the
terminals and the agent's interactive runs of each task it has listed, waits for the selected
task's list before a start, and stops counting a run once a change the Host reports shows it
ended. It does not see tasks it has not listed, or runs started since, so another window, Maka
Desktop or the agent can still push the Host over the cap.

## gpui-kit

- **Diff tint.** The diff tints changed rows with a fixed `success.opacity(0.12)` / `danger`
  (`crates/component/src/diff/mod.rs:1682`, rev 1e41f17). An application cannot lower it, and a
  new file shows as a solid green block. Proposal: a tint strength on the `Diff` builder, or
  theme roles for row backgrounds.
- **Line numbers.** The diff has no single-column line numbers for narrow panels. For an added
  file, the old column is blank and the gutters take about 110 pt of a 480 pt panel.
- **Rendered text off-view.** `RenderedText::new` is `pub(super)`, so an application cannot get
  the rendered text of Markdown it has not laid out. F32 re-derives the visible text from the
  `markdown` crate to match it. A public constructor from source, using the view's extension
  set, would remove that duplicate.
- **Links open anything.** The text view's default link handler hands any `href` to the
  platform, `javascript:` and `file:` included; a `file:` link to an app bundle starts the app.
  The client now sets a handler on every rendered text (`shared::links`, Desktop's
  `isExternalUrl`). Proposal: a safe default (web and mail only) with an opt-in for others.
- **HTML view.** `TextView::html` drops `<script>` and `<style>` only where a block stands (inside
  a table cell or a paragraph their code shows as text), draws `<title>` as the first line, and
  collapses the whitespace of `<pre>`. The Files face strips the hidden elements before parsing
  (`files::policy::renderable_html`); `<pre>` is left as the kit draws it.
