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

# Maka desktop smoke test plan

> Archived on 2026-07-13. This snapshot mixes completed PR acceptance paths and deferred designs. The current runbook is `apps/desktop/tests/smoke.md`; scripts, fixtures, and tests own scenario details.

Manual end-to-end paths that the V0.2 UI / credential / lifecycle work
relies on. Each path lists the precondition, the steps, and the
*observable* signal that proves the path is intact. If any of these
regress, that's the floor we lost — fix before shipping.

## Setup

Either start clean (`rm -rf ~/Library/Application\ Support/maka` on
macOS, equivalent path on Windows / Linux) or use an existing workspace
and follow the per-path preconditions. All paths happen in a single
launched build (`npm --workspace @maka/desktop run dev` or a packaged
build).

### Real Electron window smoke (PR-DESKTOP-SMOKE-0)

Visual-smoke screenshots do **not** prove native desktop behavior. Any PR
that touches the shell, sidebar, modal backdrop, window drag regions, or
top-level renderer lifecycle must also run the real-window smoke gate:

```bash
npm --workspace @maka/desktop run smoke:real-window
```

The script builds `@maka/core`, `@maka/ui`, and desktop, launches a real
Electron window with an isolated `--user-data-dir`, then prompts the
reviewer to confirm the checks that screenshots cannot exercise:

- clean launch with no ErrorBoundary / crash screen;
- dragging left / right / top / bottom edges resizes the window;
- dragging all four corners resizes diagonally;
- dragging an allowed titlebar / blank header area moves the window;
- rows, buttons, inputs, and modal controls do **not** drag the window;
- Search modal opens and closes via close button, backdrop, and Esc;
- Tab / Shift+Tab stays inside the modal and focus returns to the trigger;
- with Search modal open, window edges and corners still resize;
- after closing the modal and switching modules, no React hook error or
  ErrorBoundary appears.

Reports are written to
`apps/desktop/tests/real-window-smoke/<timestamp>.md` and `.json`.
If any check fails, the script exits non-zero. A UI-shell PR is not ready
to merge until this report is attached or summarized in the review
thread.

For deterministic visual smoke, launch a dev build with an isolated
fixture workspace:

```bash
MAKA_VISUAL_SMOKE_FIXTURE=all npm --workspace @maka/desktop run dev
```

Single-scenario launches are also supported:

```bash
MAKA_VISUAL_SMOKE_FIXTURE=first-run npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=provider-workspace npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=fallback-source npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=fetched-empty npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=connection-error npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=turn-narrative npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=streaming-sidebar npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=permission-destructive npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=artifact-pane npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=artifact-errors npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=stale-sessions npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=settings-data npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=settings-personalization npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=settings-network npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=settings-bots npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=settings-about npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=settings-theme npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=settings-daily-review npm --workspace @maka/desktop run dev
MAKA_VISUAL_SMOKE_FIXTURE=workstation-statuses npm --workspace @maka/desktop run dev
```

Fixture mode is dev/test-only and refuses packaged builds. It seeds
`workspaces/visual-smoke-*` from scratch on every launch, so screenshots
are repeatable and real user workspaces are not touched. `visualSmoke`
IPC returns `null` when the env var is unset; renderer smoke-only
streaming / permission state must never appear in normal usage.

### Automated screenshot capture (PR-IR-01)

Capture light/dark/narrow/reduced-motion baseline PNGs for every fixture
scenario using the driver script:

```bash
# Single scenario × all 8 variants (light/dark × 1280/990 × motion/reduced)
npm --workspace @maka/desktop run screenshots:single artifact-pane

# All scenarios × all variants (full regression baseline)
npm --workspace @maka/desktop run screenshots
```

Output: `apps/desktop/tests/screenshots/<scenario>/<variant>.png`.

Implementation: the script spawns `electron .` once per (scenario,
variant) with `MAKA_VISUAL_SMOKE_FIXTURE=<scenario>` +
`MAKA_VISUAL_SMOKE_AUTO_CAPTURE=<variant>` (+ optional
`MAKA_VISUAL_SMOKE_REDUCED_MOTION=1`). The renderer waits 2 RAFs + 400ms
idle after fixture settle, then calls `window.maka.visualSmoke.capture()`.
Main process writes the PNG via `webContents.capturePage()` and emits
a deterministic stdout marker `[visual-smoke] captured scenario=…
variant=… path=…`. The driver script greps for the marker, kills the
subprocess, and copies the PNG into the canonical screenshots
directory.

### Screenshot diff gate (PR-IR-02 stage 1)

`screenshots:diff:stable` is a blocking **capture sanity** gate for the
stable baseline subset (`artifact-pane`, `first-run`, `artifact-errors`):

```bash
npm --workspace @maka/desktop run screenshots
npm --workspace @maka/desktop run screenshots:diff:stable
```

**What this gate catches:**
- Missing, corrupt, or truncated PNGs.
- Broken capture IPC or fixture startup.
- Wrong dimensions, such as a `1280` variant captured at `990` width.
- Scenario/variant matrix drift between capture and diff scripts.

**What this gate does NOT catch:**
- Pixel-level UI regressions inside the image.
- Layout shifts that keep total image dimensions stable.
- Color, contrast, opacity, typography, or spacing regressions.

Electron/font rasterization drift makes byte-level diff impractical as
a blocker. Human review of the screenshots is still required until
pixel-level diff with calibrated tolerance and ignored dynamic regions
(PR-IR-02 v3) is added. That future gate should pilot on the stable
subset (`artifact-pane` / `first-run` / `artifact-errors`) first
before expanding to all scenarios.

To promote the current stable subset after intentional visual changes:

```bash
npm --workspace @maka/desktop run screenshots:baseline:stable
```

After the full baseline has been reviewed and promoted, use the same scripts
without the `:stable` suffix. The scenario inventory and output cardinality are
owned by `ALL_SCENARIOS` and `VARIANTS` in the capture script:

```bash
npm --workspace @maka/desktop run screenshots:diff      # all scenarios
npm --workspace @maka/desktop run screenshots:baseline  # full promotion
```

### Reduced-motion variant (PR-IR-04)

Combine `MAKA_VISUAL_SMOKE_REDUCED_MOTION=1` with any of the above to
collapse every animation/transition to ~0.01ms regardless of the host
OS accessibility setting. Used by the screenshot pipeline (PR-IR-01) to
capture a "reduced motion" variant per surface.

```bash
MAKA_VISUAL_SMOKE_FIXTURE=artifact-pane \
  MAKA_VISUAL_SMOKE_REDUCED_MOTION=1 \
  npm --workspace @maka/desktop run dev
```

Implementation: main process passes the flag through `VisualSmokeState`;
renderer applies `data-maka-reduced-motion="true"` to `<html>`; CSS in
`styles.css` matches that attribute selector with the same overrides as
the `prefers-reduced-motion: reduce` media query. Real users never reach
this code path because `visualSmoke.getState()` returns `null` unless
`MAKA_VISUAL_SMOKE_FIXTURE` is set.

---

## Path 1 — First launch with no real model

**Precondition.** Clean install, no enabled LlmConnection in settings.
Fixture scenario: `first-run`.

**Steps.**
1. Launch Maka.
2. Don't type into the composer; just look at the chat surface.

**Pass signal.**
- The chat surface renders **OnboardingHero** (the "Welcome to Maka"
  card with six featured provider tiles), not the `EmptyChatHero`
  ("想一起做点什么？") or a blank screen.
- Clicking any provider tile opens Settings · 模型.
- "先用 FakeBackend 走一遍流程 →" focuses the composer.

**Fail signals.**
- Empty chat hero shown despite no enabled connection.
- Onboarding hero shown forever even after connection is enabled.

---

## Path 2 — Add a connection and verify it

**Precondition.** Workspace exists; you have a real provider API key
(Anthropic / OpenAI / DeepSeek / Z.ai / etc.).

**Steps.**
1. ⌘K → "设置 · 模型" → Enter (PR64 palette routing).
2. Add an Anthropic connection, paste API key, save.
3. Switch to "设置 · 账号" via the nav.
4. Observe the new connection row: it should say **已配置 · 未验证**
   in an info-tone badge (no green check yet).
5. Click "测试连接" on that row.
6. Wait for the toast.

**Pass signal.**
- Success toast: "连接已验证" + latency + tested model.
- Row badge flips to **已验证可用** in green/success tone.
- Row card border + background shifts to success.
- Default connection (if set in Settings · 通用 or models flow) has a
  small "默认" pill on the name line.
- `lastTestAt` formatted timestamp visible under the badge.

**Fail signals.**
- Test button stuck disabled or spinning forever.
- Status doesn't refresh without closing/reopening Settings.
- Badge ever shows "disabled + verified" or any mixed label.

---

## Path 3 — Failing credential surfaces in chat header

**Precondition.** A previously verified connection. The session you
open uses this connection.
Fixture scenario for the chat header state: `connection-error`.

**Steps.**
1. Settings · 模型 → pick the connection → corrupt the API key
   (replace with a clearly bogus value) → save.
2. Settings · 账号 → click "测试连接" on that row.
3. Wait for the failure toast.
4. Close Settings, return to chat with that connection active.

**Pass signal.**
- Account row badge becomes **需要重新登录** (warning tone) or
  **连接出错** (destructive tone) depending on the underlying
  errorClass (401/403 → needs_reauth; 5xx/timeout/network → error).
- `lastTestMessage` shows a generalized phrase like
  `Authentication failed` / `Request timed out` — never a raw provider
  body or API key.
- Chat header now shows a small clickable pill matching the row tone
  ("需要重新登录" warning or "上次连接失败" destructive).
- Clicking the pill jumps directly to Settings · 账号.

**Fail signals.**
- Chat header alert missing when the row already shows the failure.
- Generalized message includes raw `sk-...` / Bearer token / URL with
  query secret.
- Connection auto-disabled after a single failure (failure should be a
  status, not a lifecycle change — user disables manually).

---

## Path 4 — Streaming + delete-active-session safety

**Precondition.** At least one verified connection. Active session has
the model picked.

**Steps.**
1. Send a prompt; the model starts streaming.
2. Verify the composer toolbar swaps in **"Maka 正在思考…"** with the
   pulsing accent dot, the Send button disappears, and the only
   primary action is a red **Stop** button.
3. Try pressing Esc inside the textarea — it should call onStop and
   the stream should cancel.
4. Send a fresh prompt and let it run.
5. Delete the currently-active session mid-stream. Options, easiest
   first:
   - **IPC-level (preferred for automated test runs)**: from DevTools
     console, fire `window.maka.sessions.remove(activeSessionId)`. The
     `sessions:changed { reason: 'deleted', sessionId }` broadcast is
     the contract under test, not the right-click affordance.
   - **GUI**: from a *second* Maka window pointed at the same workspace
     (open a new BrowserWindow if needed), right-click the row → 删除
     → confirm. The original window must observe the broadcast.

**Pass signal.**
- The sidebar removes the row (via `sessions:changed` broadcast).
- The chat surface clears: active session unset, messages emptied,
  no stuck streaming bubble.
- No "send into a deleted session" error follows; the composer remains
  responsive and the user can start a new chat.

**Fail signals.**
- Composer keeps showing the streaming hint after the underlying
  session is gone.
- Renderer crashes or shows the previous session's messages on top of
  an empty title.
- Tool activity from the deleted session keeps streaming into the new
  one.

---

## Path 5 — PermissionDialog destructive path

**Precondition.** A connection that lets the model invoke tools (e.g.
default agent setup). User is in **Ask** permission mode.
Fixture scenario: `permission-destructive`.

**Important — do not actually run the destructive command.** The goal is
to verify the *dialog presentation*, not to delete real files. Either:
- Ask the assistant to *propose* the action so it surfaces a
  PermissionRequest, then **Deny**. Or
- Inject a synthetic permission request via DevTools by simulating the
  IPC event so the dialog mounts without any tool actually pending.

**Steps.**
1. Cause the runtime to produce a destructive PermissionRequest
   (e.g. tell the model "我会自己跑，先告诉我你打算执行什么 rm 命令"
   so it issues an `fs_destructive` request you can refuse), or inject
   a synthetic request in DevTools.
2. Wait for the PermissionDialog to appear.

**Pass signal.**
- Dialog icon is **AlertOctagon** (red), label reads
  **不可恢复的文件系统操作**.
- Summary section shows the exact shell command in a code block + a
  timeout meta line if the runtime supplied one.
- Below the "本轮对话内记住选择" checkbox, the red emphasis note
  **"这类操作不可恢复，确认前请再读一遍上面的参数。"** is visible.
- The primary button reads **"我已确认，允许"** in destructive tone
  (red), not the usual blue "允许".
- The "记住本轮" caption explicitly says
  "(同类型工具不再询问，关闭/切换对话后失效)".
- Clicking Deny does not run the command; the assistant gets a denial
  signal.

**Fail signals.**
- The dialog renders the action with neutral / info tone (no red
  treatment) for an obviously destructive operation.
- "记住本轮" persists across sessions or app restarts (should be
  per-turn only).
- Permission dialog can be dismissed with Esc (it shouldn't be — Esc
  is explicitly disabled for permission decisions).

---

## Path 6 — ModelTable workspace (UI-02)

**Precondition.** A verified Z.ai or OpenAI-protocol connection with
>6 models available. Settings open on 模型 → click into that
connection.
Fixture scenarios: `provider-workspace`, `fallback-source`, and
`fetched-empty`.

**Steps.**
1. Verify the source line under the model count reads
   *"实时拉取的 N 个模型（X 拉取）"* (green tone). Click "从 API
   刷新" once; the line should update to "刚刚拉取" (or similar).
2. With more than 6 models, type into the search box. Filter to a
   substring that excludes the current default.
3. Observe the hidden-default hint above the list: *"当前默认 `…` 不
   在搜索结果中 · 点这里清空搜索"*. Click it; search clears, default
   row visible.
4. Tab into the model list; press ArrowDown several times.
5. Press Home, then End.

**Pass signal.**
- Source label tone matches: success (green) for fetched, info for
  fallback, fetched-empty branch for "0 models from provider".
- ArrowDown/ArrowRight moves focus AND ticks the selected default
  radio down by one. ArrowUp/ArrowLeft moves it up. Home jumps to
  first row; End jumps to last.
- The default radio dot and "默认" badge follow the active row.
- Wrapping: ArrowDown on the last row wraps to first; ArrowUp on
  the first wraps to last.
- Hidden-default hint mounts only while search filters out the
  default; disappears when search is cleared.

**Fail signals.**
- Source label says "实时拉取" but the cached models look stale (e.g.
  `glm-4.5/4.6/4.7` exact fallback list) — that's the silent-fallback
  regression PR91 closed.
- ArrowDown only moves focus without selecting (UI-04 ARIA
  radiogroup regression).
- Search filter hides default with no hint — the user thinks the
  default got deleted.

---

## Path 7 — Chat turn narrative (UI-04)

**Precondition.** Any verified connection. Active session with a
multi-step exchange (user message → tool call → assistant final).
Fixture scenario: `turn-narrative`.

**Steps.**
1. Ask: *"读一下 README.md 并总结"* (or any prompt that triggers a
   Read tool call).
2. Wait for the full turn to land.
3. Observe the structure inside the chat surface.

**Pass signal.**
- The user message, the tool activity panel, and the assistant
  answer are visually grouped as **one turn block** (`<section
  class="maka-turn">`), not three free-floating items.
- Turn meta (model id e.g. `claude-sonnet-4-5`, duration `X.X s`, cost
  `$X.XXXX`) lives in the footer's info-action tooltip, shown on hover
  (#546 removed the top summary chip strip).
- If the model supplied thinking, a collapsed `<details>` block
  *"查看思考过程 — 模型推理草稿，不是最终答案"* appears above the
  assistant answer; expanding it shows the reasoning with its own
  "复制思考过程" button.
- For an in-progress turn (user sent, assistant hasn't landed), no
  duration is shown — the footer info tooltip omits the duration line
  until the assistant turn lands.

**Fail signals.**
- Tool activity at the very bottom of the chat instead of inside its
  turn (old "message stack + tools panel" layout).
- Thinking block included in the default "Copy message" button
  (should be exclusive to the dedicated "复制思考过程" button).
- Token cost hover shows `$0.0000` when costUsd isn't known.

---

## Path 8 — Sidebar streaming + multi-session indicator (PR85)

**Precondition.** At least two sessions exist. Open one of them.
Fixture scenario: `streaming-sidebar`.

**Steps.**
1. Send a prompt in session A; let it start streaming.
2. Without waiting for the stream to finish, switch to session B by
   clicking in the sidebar.
3. Observe session A's row in the sidebar.

**Pass signal.**
- Session A's row shows a small pulsing accent-tinted dot next to
  the session name.
- The row preview text shows *"Maka 正在思考…"* (overrides the
  prior `lastMessagePreview`).
- The unread halo dot is suppressed for streaming rows (streaming
  takes precedence per PR85).
- Once the stream completes, the pulse dot disappears and the row
  may show the unread halo + the updated `lastMessagePreview`.

**Fail signals.**
- Streaming session looks identical to an idle session (lost the
  indicator).
- Pulse + unread dot both rendered at the same time (priority
  violation).

---

## Path 9 — Command palette diagnostics + export (UI-05, PR86)

**Precondition.** Maka running with at least one verified connection
and an active chat session with several turns.
Fixture scenario: `all`.

**Steps.**
1. Press ⌘K. Scan groups: 操作 / 主题 / 设置 / 诊断 / 连接 / 会话.
2. Type "测试默认". The "测试默认连接 · {name}" command should
   surface in the 诊断 group; press Enter.
3. ⌘K again, type "导出". The "导出当前对话为 Markdown" command
   should surface; press Enter.
4. Paste the clipboard into a markdown viewer.
5. ⌘K once more, type "设置 · 模型" and press Enter (with Settings
   not currently open).

**Pass signal.**
- ⌘K palette opens with the same five-section nav (操作/主题/设置/
  诊断/连接) plus the per-session entries at the bottom.
- "测试默认连接" runs the connection test, surfaces a success or
  failure toast, and the Account row's `lastTestStatus` badge
  refreshes without closing the palette → reopening Settings.
- "导出当前对话为 Markdown" lands a structured markdown doc on the
  clipboard with `# {sessionName}` + `## 你` / `## Maka` sections;
  thinking blocks are NOT included; tool calls appear as a bulleted
  list with names + intent (intent passes through `redactSecrets`).
- "设置 · 模型" opens Settings directly on the 模型 section, even if
  Settings was already open on a different section.

**Fail signals.**
- "设置 · ..." command requires a second click to actually navigate
  (warm-switch via `requestedSection` regressed).
- Markdown export contains thinking blocks (security regression per
  @kenji's PR86 review).

---

## Path 10 — Sandbox bridge sanity

**Precondition.** Maka running in fixture mode (`MAKA_VISUAL_SMOKE_FIXTURE=all`)
or a normal dev workspace with at least one configured provider. This path
exists because the BrowserWindow renderer runs with `sandbox: true`,
`contextIsolation: true`, and `nodeIntegration: false`; all app behavior
must still flow through `window.maka`.

**Steps.**
1. Open Settings, change a harmless appearance preference, and close.
2. ⌘K → "打开工作区文件夹"; verify the OS opens the allowlisted folder.
3. ⌘K → "测试默认连接" in a configured workspace, or in fixture mode
   click a connection test action and observe the toast path.
4. In a real configured workspace, send a prompt and press Stop while
   streaming. In fixture mode, verify the streaming sidebar row and
   permission dialog still render from `visualSmoke.getState()`.

**Pass signal.**
- `window.maka.settings`, `window.maka.app.openPath`,
  `window.maka.connections`, `window.maka.sessions`, and
  `window.maka.visualSmoke` all respond through preload IPC.
- No external page opens inside the Maka BrowserWindow; allowed http(s) /
  mailto links go through the OS, and dropped files do not navigate the
  renderer.

**Fail signals.**
- Settings, connection test, openPath, send/stop, or fixture state breaks
  after sandbox hardening.
- A clicked markdown link or dropped file replaces the React app surface.

---

## Path 11 — Artifact pane (UI-02 follow-on, §9.1)

**Precondition.** Fixture scenario `artifact-pane` — seeds a session named
"Artifact Pane 验收" with 3 live artifacts (`report.html`, `patch.diff`,
`notes.md`) under the workspace `artifacts/` root.

```bash
MAKA_VISUAL_SMOKE_FIXTURE=artifact-pane npm --workspace @maka/desktop run dev
```

**Steps.**
1. Launch Maka with the fixture above. The artifact session is activated
   automatically via `visualSmoke.getState()`.
2. Verify the right-side **ArtifactPane** is visible with a count badge of
   **3** in the header and three rows in the list (newest first).
3. Click the row for **report.html**. Confirm the preview region renders a
   sandboxed `<iframe>` with the document body and a top status bar reading
   *"此预览中已禁用外部链接 · 1 个链接"*.
4. With DevTools open, inspect the iframe element. Its `sandbox` attribute
   must be exactly `allow-scripts` — NO `allow-same-origin`,
   `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals`.
5. Click the disabled link inside the iframe. Nothing should happen (no
   navigation, no popup, no console error in the parent renderer).
6. Click the **patch.diff** row. Preview switches to a diff view with
   red/green line coloring (`data-line="add"` / `data-line="del"`).
7. Click the **notes.md** row. Preview switches to the markdown file
   content rendered in a monospace `<pre>`.
8. Take screenshots in light theme, dark theme, and a narrow window
   (~900 px width). At narrow width, verify ArtifactPane renders as a
   bottom sheet below the composer instead of a right rail.
9. Click the collapse toggle in the pane header. Pane should shrink to a
   narrow strip; reload the page (⌘R / F5). Pane should still be
   collapsed (persisted via localStorage `maka-artifact-pane-collapsed-v1`).
10. Expand again. Verify the list still shows 3 artifacts after reload.
11. With keyboard focus inside the artifact list or preview, press
    `Escape`. The pane collapses and focus returns to the composer. With
    Command Palette / modal open, pressing `Escape` closes that overlay
    normally; ArtifactPane must not steal Esc outside its own focus subtree.

**Pass signal.**
- ArtifactPane header shows count `3` and three rows: `report.html`,
  `patch.diff`, `notes.md`.
- HTML preview renders inside an iframe whose only sandbox token is
  `allow-scripts`. The status bar reads *"此预览中已禁用外部链接 · 1 个
  链接"* (the fixture HTML contains one `<a href>`).
- Diff preview shows the patch with red/green line tagging.
- Markdown preview shows the raw file text in monospace.
- Toolbar shows「在 Finder 中打开」+「另存为」for all kinds; only the
  text-backed kinds (file / diff / html) additionally show「复制文本」 —
  `image` / `pdf` rows do NOT (review gate #5).
- Collapse state persists across reload via localStorage; the list still
  has 3 entries after reload.
- Narrow width shows ArtifactPane as a bottom sheet below the composer;
  composer textarea and Send/Stop button remain visible and usable.
- Esc inside the ArtifactPane focus subtree collapses the pane and returns
  focus to the composer; Esc outside the pane keeps global modal/palette
  priority intact.

**Fail signals.**
- Blank pane despite the fixture seeding three artifacts (subscription /
  list IPC regressed).
- HTML preview shows raw HTML source as text instead of rendering inside
  the iframe.
- External-link status bar missing or count = 0 even though the fixture
  HTML contains an `<a href="https://example.com">`.
- Clicking a link inside the iframe navigates the parent renderer or opens
  a popup (sandbox should block both).
- `sandbox` attribute on the iframe contains any of `allow-same-origin`,
  `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals`.
- `image` or `pdf` rows render a 复制 button (binary kinds must not).
- Narrow window keeps the pane as a squeezed right rail, covers the
  composer, or makes the Send/Stop button unreachable.
- ArtifactPane handles Esc while focus is in Command Palette / Settings /
  permission dialogs.

---

## Path 12 — Sidebar shows "已过期" pill for stale sessions

**Precondition.** Fixture scenario `stale-sessions`:

```bash
MAKA_VISUAL_SMOKE_FIXTURE=stale-sessions npm --workspace @maka/desktop run dev
```

This seeds a workspace reproducing the on-disk state that triggered the
P0 — three sessions in the sidebar:
- 「旧的 FakeBackend 演示」 — `backend='fake'`, slug `fake` (stale)
- 「旧的 Claude backend 会话」 — `backend='claude'`, slug `fake-claude` (stale, legacy)
- 「正常会话（Z.ai Live）」 — `backend='ai-sdk'`, slug `zai-live` (healthy)

The active session is intentionally the FakeBackend stale row — the
fixture is designed to verify the @kenji active-stale gate (active row
must still show the pill).

**Steps.**
1. Launch Maka against the workspace.
2. Open the sidebar; observe the visible session rows.
3. Click into a stale session so it becomes active.
4. Click into the healthy session (`backend='ai-sdk'`, real slug).

**Pass signals.**
- Each stale session row is **dimmed (opacity ≈ 0.7)** AND shows a small
  amber pill labelled **「已过期」** to the right of the session name.
- The healthy session row is fully opaque, no pill.
- When the stale session is **active** (clicked into):
  - Row opacity is back to **1.0** (active highlight wins over dim).
  - **「已过期」pill is still rendered** — the active highlight must not
    erase the warning signal (@kenji review gate).
  - Chat header surfaces the matching banner from PR108e:
    `backend='fake'` → "会话已过期 · ..."; missing slug → "原连接已删除..."
- Switching back to the healthy session removes both the pill and the
  header banner; nothing else changes about the sidebar.

**Fail signals.**
- Stale row looks identical to the healthy row (pill missing OR dim
  treatment missing).
- Active stale row HIDES the pill (regression on @kenji's gate — once a
  user clicks into a broken session the sidebar should still flag it as
  broken; without this they think the session is fine).
- Healthy row gets the pill / dim treatment (over-flagging — the
  `staleSessionIds` Set should NOT include `slug`s that resolve to a
  current connection).
- Pill color matches the destructive (red) tone instead of warning
  (amber); destructive is reserved for cases where send will actually
  fail despite @xuan's silent rebind.

---

## Path 13 — Artifact pane failure states and Save As (§9.1)

**Precondition.** Fixture scenario `artifact-errors` — seeds the normal
artifact session plus three failure rows:

- `deleted.md` with `status: deleted` tombstone
- `unsupported.bin` with binary bytes that fail MIME sniffing
- `missing.md` metadata whose backing file is absent

```bash
MAKA_VISUAL_SMOKE_FIXTURE=artifact-errors npm --workspace @maka/desktop run dev
```

**Steps.**
1. Launch Maka with the fixture above. The "Artifact Pane 验收" session
   is activated automatically.
2. Verify the pane count includes six rows, while deleted rows are
   visually marked with an "已删除" badge.
3. Select `deleted.md`. The preview must show the explicit deleted
   failure state and must not read the backing file even if it exists.
4. Select `unsupported.bin`. The preview must show "不支持的文件类型"
   and must not display raw bytes or a copy button.
5. Select `missing.md`. The preview must show "无法读取 artifact 文件".
6. Select `report.html`, click「另存为」, cancel the save dialog. No error
   toast should appear.
7. Click「另存为」again and choose a temporary destination. The file should
   be copied there and a success toast should appear.

**Pass signal.**
- `deleted.md`, `unsupported.bin`, and `missing.md` each render distinct
  failure copy; no blank preview state.
- Deleted artifact reads are blocked by tombstone semantics, not by file
  absence.
- Unsupported MIME never sends raw bytes into the renderer preview.
- Save As uses a real OS save dialog and copies the artifact file; it no
  longer aliases to "在 Finder 中打开".
- Canceling Save As is silent.

**Fail signals.**
- Any failure row renders a blank preview.
- Deleted artifact content remains readable.
- Unsupported MIME displays mojibake/raw binary.
- Save As reveals the file in Finder instead of opening a save dialog.
- Canceling Save As shows an error toast.

---

## Path 14 — Workstation sidebar status grouping (§9.8)

**Precondition.** Fixture scenario `workstation-statuses` — seeds 11
sessions covering every SessionStatus (including aborted) plus 4
blocked variants (one per SessionBlockedReason):

```bash
MAKA_VISUAL_SMOKE_FIXTURE=workstation-statuses npm --workspace @maka/desktop run dev
```

The active session is the running one so the chat header status
badge ("进行中") is visible in the screenshot alongside the sidebar.

**Steps.**
1. Launch Maka with the fixture above. The "正在生成报告" session is
   active.
2. Observe the sidebar groups in order. Expected from top to bottom:
   `进行中`, `等待你`, `已阻塞`, `会话`, `待审核`, `已完成`, `归档`,
   `已中止`. Both `归档` and `已中止` are collapsed by default.
3. Hover each row's status icon. Tooltip reads the status label
   (and the generalized blocked-reason copy for the 4 blocked rows
   — never the raw enum identifier).
4. Click the `归档` group header to toggle expanded state.
5. Click any of the blocked rows. Verify the chat header status
   badge updates with the matching reason copy.

**Pass signals.**
- Group ordering matches: `进行中 / 等待你 / 已阻塞 / 会话 / 待审核 /
  已完成 / 归档 / 已中止`. Both `归档` and `已中止` are collapsible
  groups defaulting to collapsed; expanding either reveals its row(s).
- Each non-active session row shows the SessionStatusIcon to the
  left of the session name with the matching tone (running=accent
  pulse, waiting=warning, blocked=destructive, review=info,
  done=success, archived=muted, aborted=muted).
- Blocked rows show the generalized reason via hover tooltip:
  - `缺少可用模型连接`
  - `需要重新登录`
  - `等待权限确认`
  - `工具调用失败`
  - `运行中断`
- The chat header badge "进行中" is visible (because the active
  session is running).
- `归档` group is collapsed by default; clicking the header expands
  it; expanded state persists across re-renders within the session
  (but not across launches — that's intentional, archived is dormant).
- All visible labels are Chinese; no raw enum strings leak to the UI.

**Fail signals.**
- Group ordering differs (e.g. `归档` floats to the top, or `已完成`
  appears before `进行中`).
- `已中止` group is silently hidden (regression on @kenji PR109b
  review — aborted is dormant but must remain visible).
- Blocked tooltips expose the raw enum (`NO_REAL_CONNECTION`, `auth`,
  `permission_required`, `tool_failed`, `unknown` — these are
  internal identifiers, not user copy).
- `归档` group defaults to expanded (should be collapsed by default;
  PR108k-yj convention).
- Running session shows no spinning indicator (the `Loader2` icon
  should spin via CSS `animation` unless `prefers-reduced-motion` is
  active or `MAKA_VISUAL_SMOKE_REDUCED_MOTION=1` is set).
- Chat header lifecycle badge missing despite the active session
  having `status !== 'active'`.

---

## Path 15 — Turn control contract API + UI (§9.9, PR109c / PR109d / PR109e / PR109f)

**Scope.** PR109c shipped the contract/runtime; PR109d–f layer the
UI on top: turn footer actions, aborted marker, failed banner,
forward + reverse lineage badges, branched-session banner.

**Fixture.** `turn-control-history` state family — three scenarios
sharing one on-disk seed and differing only in active session:

| Scenario                          | Active session                        | What it verifies                                          |
| --------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| `turn-control-history`            | `…-primary`                           | lineage badges, aborted marker, failed banner             |
| `turn-control-branch-visible`     | `…-branch-visible`                    | branch banner copy `分自 ${primaryName}` renders          |
| `turn-control-branch-orphan`      | `…-branch-orphan`                     | branch banner is ABSENT (parent missing from list)        |

The three variants are the same state family — only the active session
flips. The orphan branch's `parentSessionId` points to a session id
that is intentionally **not** seeded on disk, so the renderer's
`deriveBranchBanner()` resolves the parent as missing.

**Run.**

```bash
MAKA_VISUAL_SMOKE_FIXTURE=turn-control-history MAKA_VISUAL_SMOKE_THEME=light \
  MAKA_VISUAL_SMOKE_AUTO_CAPTURE=primary-light-1280 npm run dev
```

Repeat with `turn-control-branch-visible` and `turn-control-branch-orphan`.

**Path 15 acceptance matrix (6 observable signals).**

- **S1 — failed banner copy.** The `turn-failed` row in the primary
  session renders a destructive banner with the Chinese generalized
  phrase for `errorClass='timeout'` ("请求超时"). The raw enum
  identifier (`timeout`) MUST NOT appear in the rendered DOM.
  Sub-string check on screenshot DOM:
  `not contains(/(timeout|auth|rate_limit|network|provider_unavailable|tool_failed|permission_required|unknown)/i)`.
- **S2 — aborted turn marker.** The `turn-aborted` row shows a muted
  inline marker "(已中断)" beside the assistant text; partial output is
  preserved (the user can still read what was generated before abort).
- **S3 — lineage badges scroll.**
  - *Forward (descendant top):* on `turn-regen-new` the badge reads
    "重新生成自 turn turn-regen" and clicking it scrolls `turn-regen-origin`
    into the center of the viewport.
  - *Reverse (origin footer):* on `turn-regen-origin` the badge reads
    "已重新生成 → turn turn-regen" and clicking it scrolls `turn-regen-new`
    into the center of the viewport.
- **S4 — branch banner positive vs negative.**
  - In `turn-control-branch-visible`, the chat header shows
    `分自 ${primary.name}`. The banner is a clickable button that
    navigates to the primary session.
  - In `turn-control-branch-orphan`, NO banner appears in the chat
    header — and there is no disabled/dead button placeholder either.
    DOM check: `.maka-session-branch-banner` must not exist.
- **S5 — visual-smoke collapses smooth scroll.** Lineage badge clicks
  in any of the three variants use `scrollIntoView({ behavior: 'auto' })`
  because the fixture sets `data-maka-visual-smoke="true"` on `<html>`.
  Verified by `scroll-motion-policy.test.ts` (visual-smoke alone is
  sufficient — the reduced-motion attribute is not required).
- **S6 — no raw enum leak.** Across all three variants, the rendered
  DOM contains no occurrence of `timeout`, `auth`, `rate_limit`,
  `network`, `provider_unavailable`, `tool_failed`, `permission_required`,
  `unknown` as raw substrings. The same gate
  applies to `SessionBlockedReason` (`NO_REAL_CONNECTION` etc.).

**Automated coverage backing the matrix.**

- Helper tests:
  - `session-status-presentation.test.ts` — S1, S6 (Chinese-only,
    no raw enum)
  - `turn-footer-actions.test.ts` — footer matrix per TurnStatus
  - `branch-banner.test.ts` — S4 (missing parent → undefined)
  - `scroll-motion-policy.test.ts` — S5 (visual-smoke alone → `auto`)
  - `turn-control-matrix.test.ts` — cross-cutting matrix gate
- Fixture seed tests in `visual-smoke-fixture.test.ts`:
  - All three scenarios seed the same three sessions
  - Primary session log carries the expected `turn_state` records
    (retry, regenerate, aborted, failed with `errorClass='timeout'`)
  - The orphan parent is **never** written to disk

**Original PR109c contract gates (still apply).**
- Old turns are immutable after retry/regenerate; no old assistant
  output is overwritten.
- Branch from an aborted turn is allowed; the child session copies to
  the interrupted turn boundary. Current UI surfaces "从中断前" only in
  the branch action tooltip (PR109d); the session banner stays at
  "分自 ${parentName}" until parent-turn preloading lands so it never
  claims an aborted boundary without proof.
- `SessionChangedReason` includes `turn-status-change` so renderer
  reloads turn metadata without pretending this is a session lifecycle
  status change.

---

## Path 17 — UI trust-boundary + Settings persistence contracts

Single landing page for the gate contracts behind nine UI / Settings
PRs that landed between **2026-05-23 → 2026-05-24** (final main HEAD
at consolidation time: `7a2b6eb`). Each gate is intentionally short:
the **contract invariants** are what merge gate must enforce going
forward; implementation history lives in commit messages.

Doc convention used in every gate below:
- **Contract invariant** — 1–3 final-state bullets the gate enforces.
- **Targeted tests** — node:test files / case names that fail closed
  if the invariant breaks.
- **Source-gate grep** — patterns the merge reviewer actually runs.
- **Deferred** — only items still open for a future PR. Already-
  completed work isn't repeated here.

### S1 — A3: tool output stream chokepoint

**Contract invariant.**
- Tool output chunks must run through `applyToolOutputChunk` BEFORE
  reaching React state. Raw `event.text` from `tool_output_delta`
  is never appended directly to `outputChunks`.
- Secondary `redactSecrets` always fires at the renderer chokepoint;
  the `redacted` flag the upstream claimed never escalates downward.
- Per-chunk + per-tool count + per-tool total-chars caps drop oldest
  chunks; truncation is signalled via the `已截断` pill on the tool
  item, never silent.

**Targeted tests** (`apps/desktop/src/main/__tests__/tool-output-stream.test.ts`):
- `Authorization: Bearer …` / `sk-…` text → masked in stored chunk;
  `redacted: true` regardless of upstream claim.
- Single oversize chunk → tail-kept to `maxChunkChars` with marker.
- 1000 small chunks → list capped at `maxChunks`; oldest drops first.
- Total-chars cap drops oldest until under budget.
- Dedup-by-seq + sort-by-seq still hold for out-of-order arrival.

**Source-gate grep.**
- `applyLiveTurnEvent` must route `tool_output_delta` through
  `applyToolOutputChunk(base.outputChunks, chunk)` before updating the
  matching tool inside `LiveTurnProjection`; no direct raw append shortcut.

### S2 — C0: extended-thinking stream chokepoint

**Contract invariant.**
- Anthropic `ThinkingDeltaEvent` / `ThinkingCompleteEvent` text only
  enters a live step through `applyLiveTurnEvent` →
  `applyThinkingDelta` / `applyThinkingComplete`; both helpers run
  `redactSecrets` BEFORE state and enforce per-delta + per-step caps.
- `LiveTurnStepProjection.thinking.truncated` is monotonic-OR for
  deltas (sticks once true) and replace-on-complete (matches the
  source-of-truth semantics of `thinking_complete`).
- Terminal events complete the thinking slot through
  `terminalizeLiveSteps`; persisted-evidence reconciliation removes
  the transient only after history covers it.

**Targeted tests** (`apps/desktop/src/main/__tests__/thinking-stream.test.ts`):
- Multi-MB single delta → tail-kept with head marker; `truncated: true`.
- Per-session accumulated over total cap → tail-kept (latest reasoning
  preserved, oldest dropped); `truncated: true`.
- Secret embedded mid-delta → redacted before state; `redacted: true`.
- `thinking_complete` replaces (does not append) the buffer.

**Source-gate grep.**
- `applyLiveTurnEvent` must call the pure thinking helpers; no direct
  `step.thinking.text + event.text` append shortcut.

### S3 — C1: smoother prefix-leak gate

**Contract invariant.**
- The smoother (`useSmoothStreamContent`) typewriters PREFIXES of its
  input; every prefix it sees must already be secret-free.
- `prepareSmoothStreamText(raw)` (which runs `redactSecrets` on the
  FULL raw text) is called at every smoother callsite — both the
  streaming assistant bubble and the reasoning panel — BEFORE
  passing text to the smoother hook.

**Targeted tests** (`apps/desktop/src/main/__tests__/smooth-stream.test.ts`):
- Raw text containing `Authorization: Bearer sk-…` is masked by
  `prepareSmoothStreamText` before reaching the smoother; the
  intermediate prefix `Authorization: Bearer s` cannot reach the DOM
  unmasked.
- Existing smoother grapheme / EMA / continuous catch-up behavior
  remains unchanged on already-safe text.

**Source-gate grep.**
- Every `useSmoothStreamContent(...)` call must be wrapped in
  `prepareSmoothStreamText(...)` (or call something that does).

### S4 — C2: `maka://` internal markdown URI router

**Contract invariant.**
- `parseMakaUri(href)` is **strict** (lowercase `maka:` only) and
  closed-world: only `maka://settings/<SettingsSection>` and
  `maka://compose?text=...` resolve to typed `MakaUriDest`. Any
  other shape returns `null` and surfaces as an inline broken-link
  span with a typed `data-reason`.
- `isMakaUriCandidate(href)` is case-insensitive (`/^maka:/i`) — it
  exists so case-variants (`Maka://settings/account`) route to the
  broken-link inline error and **never** fall through to
  `<a target=_blank>` / `openExternal`.
- External links go through `isSafeExternalScheme(href)`, which
  parses via `new URL(...)` and allows ONLY `http:` / `https:` /
  `mailto:`. `javascript:` / `data:` / `file:` / `vbscript:` /
  unknown schemes all fail closed to the broken-link span.

**Targeted tests** (`apps/desktop/src/main/__tests__/maka-uri.test.ts`,
41 cases total — 29 from PR-UI-RENDER-2 + 12 from C2 fixup):
- Lowercase `maka://settings/account` → typed destination.
- `Maka://settings/account` (case-variant) → `parseMakaUri` returns
  `null` but `isMakaUriCandidate` returns `true`.
- `MAKA://settings/account` → same as above.
- `javascript:alert(1)`, `data:text/html,…`, `file:///etc/passwd`,
  `vbscript:msgbox` → `isSafeExternalScheme` returns `false`.
- `mailto:user@example.com` → `isSafeExternalScheme` returns `true`
  via `URL().protocol`, not naive prefix match.
- `maka-info://...` (similar prefix) → not a candidate.

**Source-gate grep.**
- `MarkdownLink` renderer dispatches via `isMakaUriCandidate(href)` →
  `parseMakaUri(href)` → internal button OR broken span; external
  branch only renders `<a target=_blank>` when
  `isSafeExternalScheme(href)` is true.

### S5 — C3: artifact preview registry (PR-RENDER-3a)

**Contract invariant.**
- Pure `resolvePreviewKind(input: ArtifactPreviewInput)` is the L1
  classifier (kind gate + MIME allowlist + ext fallback + size cap
  pre-load). Input is narrow — never the full `ArtifactRecord` — so
  the registry cannot see `relativePath` or any path-like data.
- L2 post-load decision goes through `decideImageReadOutcome` →
  `decideImagePostLoad`. Cap is enforced via
  `IMAGE_PAYLOAD_MAX_BASE64_LENGTH` string-length compare. **No
  `atob` decode** to check the cap.
- `<img src="data:<mime>;base64,...">` is built from `safeMime` (the
  main-process sniffed MIME re-validated through
  `normalizeAllowedImageMime`), never from the metadata MIME the
  resolver consulted.
- The renderer hook state is `ImagePreviewLoadState` —
  `{loading} | {image, safeMime, base64} | {unsupported, reason}` —
  closed union, `unsupported` branch carries NO base64. The L2
  decision runs INSIDE the async, BEFORE `setState`; raw
  `ArtifactBinaryReadResult` never lives in React state.
- IPC failure routes to `reason: 'read_failed'` with a distinct
  "加载预览失败" copy, never collapsed into `'kind_disallowed'`.

**Targeted tests** (`apps/desktop/src/main/__tests__/artifact-preview-registry.test.ts`):
- L1 kind gate: `file` / `diff` / `html` / `pdf` → `unsupported(kind_disallowed)`.
- L1 MIME match: `image/png` / `image/jpeg` / `image/gif` / `image/webp` /
  `image/avif` accepted; SVG / HEIC rejected.
- L1 ext fallback when MIME missing.
- L2 cross-layer: metadata `image/png` + sniffed `image/svg+xml` →
  `unsupported(mime_disallowed)`.
- L2 oversize takes precedence over MIME.
- IPC failure (all 6 `ArtifactBinaryReadFailureReason` variants) →
  `unsupported(read_failed)`.
- Oversize / mime_disallowed outcome → NO `base64` property in the
  outcome (kenji-gate runtime assert: `outcome.base64 === undefined`).

**Visual-smoke fixtures** (path-leak guard, `visual-smoke-fixture.test.ts`):
- `artifact-preview-image` — real 1×1 transparent PNG (67 B) →
  `image(mime_match)`.
- `artifact-preview-unsupported` — `kind=image` + `mimeType=image/heic` →
  L1 `unsupported(mime_disallowed)`; `readBinary` is never called.
- `artifact-preview-oversize` — `sizeBytesOverride=3MB` + `skipFile` →
  L1 `unsupported(oversize)`; file is never written to disk.
- All three: `relativePath` MUST start with `visual-smoke-artifact/`,
  MUST NOT start with `/`; metadata.jsonl MUST NOT contain `/Users/`
  or `/private/`.

**Source-gate grep.**
- `RegistryArtifactPreview` dispatch must use `resolvePreviewKind`;
  `ImageArtifactPreview` hook state must be `ImagePreviewLoadState`,
  not `ArtifactBinaryReadResult`.

**Deferred.**
- SVG (PR-RENDER-3b): needs sandboxed `<iframe srcDoc>` + CSP +
  threat-model doc.
- HTML (PR-RENDER-3c): same.
- Mermaid (PR-RENDER-3d): runtime evaluator threat surface.
- Screenshot baselines: capture is environment-sensitive; lock
  baselines from a clean CI run before declaring 3a-smoke done.

### S6 — Cx: assistant streaming chokepoint

**Contract invariant.**
- `text_delta` raw `event.text` flows through `applyAssistantDelta`
  as input only; the helper is the SINGLE sink. `setState` never
  receives raw text.
- The helper pipeline runs **per-delta redact → per-delta cap →
  append → cross-delta redact → total cap**. The cross-delta
  redaction on the freshly-appended candidate is load-bearing —
  it catches tokens that span delta seams (e.g. `"Bearer sk-"` in
  delta N + `"abcdef…"` in delta N+1) that per-delta redaction
  cannot see.
- Per-session total cap is **head-keep** with a trailing marker
  (assistant text is read top-down). Once buffer ends with the
  trailing marker AND is at the total cap, subsequent deltas are
  dropped entirely.
- Renderer state is one `LiveTurnProjection` per session. Each
  `text_delta` runs through ONE functional updater and updates
  `LiveTurnStepProjection.text`; no parallel text/truncation maps or
  outer-closure mutation between multiple `setState` calls.
- Terminal events complete the text slot in place. The smoother owns
  the final text until its visible backlog drains; persisted-evidence
  reconciliation then removes the transient step.

**Targeted tests** (`apps/desktop/src/main/__tests__/assistant-stream.test.ts`,
25 cases):
- Cross-delta long-opaque token split at the seam (24 hex + 22 hex =
  46 hex) → L4 post-append catches it; per-delta L1 does not
  (verifies the gate is genuinely cross-delta, not per-delta).
- Char-by-char streaming of a 35-char `sk-…` token across 50+ deltas
  → final accumulated state contains no raw token.
- Prev `"Token: sk-"` + delta `"abcdef…"` → caught by L4.
- Oversize delta + embedded secret near start or tail-keep area →
  no raw secret survives.
- Once buffer at total cap with trailing marker, subsequent deltas
  short-circuit (drop entirely; `truncated: true` still propagates).
- Non-string raw delta → prev unchanged, no claimed redaction.

**Source-gate grep.**
- `applyLiveTurnEvent` must call
  `applyAssistantDelta(step.text?.text ?? '', event.text)`; no direct
  append.
- Renderer session UI state must carry one
  `Record<string, LiveTurnProjection>`; no parallel streaming text or
  truncation maps.

### S7 — B2: unavailable OAuth subscription providers stay out of the model catalog

**Contract invariant.**
- `<ProvidersPanel>` only lists provider types that are configurable
  now: API key, local, and custom OpenAI-compatible endpoints.
- `claude-subscription`, `codex-subscription`, and `gemini-cli` stay
  in the core provider type/default registry for account-state and
  future migration paths, but they are not present in
  `CATALOG_PROVIDER_TYPES` until their send path is open.
- The provider catalog does not render an empty OAuth tab and does
  not advertise future account-login work as a model-provider
  affordance.

**Targeted gate.**
- `CATALOG_PROVIDER_TYPES` excludes the three subscription provider
  types.
- `ProvidersPanel.tsx` has no OAuth catalog tab and no header copy
  telling users that subscription login is coming later.

**Source-gate grep.**
- `ProvidersPanel.tsx`: no `{ id: 'oauth' }`.
- `packages/core/src/llm-connections.ts`: no subscription provider
  literal inside the `CATALOG_PROVIDER_TYPES` array body.

**Deferred.**
- Codex/Gemini account paths remain deferred. Claude subscription still
  requires product/legal sign-off and a real send-path smoke before it can
  become a ready model provider.

### S8 — Provider polish: file-wide disabled-actionable guard

**Contract invariant.**
- Every interactive selector on `.providerCatalogCard` in
  `apps/desktop/src/renderer/styles.css` must be scoped to
  `:not([data-disabled="true"])`. Disabled provider tiles never
  receive actionable affordance (lift, accent halo, shadow,
  translate, accent border).
- The disabled focus-visible affordance is muted (dashed
  `--foreground-40` outline, no accent), keyboard-discoverable but
  reads as "currently not actionable".
- `[data-disabled="true"]` always has `cursor: not-allowed`.

**Source-gate grep** (file-wide on `styles.css`, not just changed
lines):
- `.providerCatalogCard:hover`, `.providerCatalogCard:focus-visible`,
  `.providerCatalogCard:active` — every actionable variant must
  carry the `:not([data-disabled="true"])` guard.
- `.providerCatalogCard[data-disabled="true"]:focus-visible` must
  emit only muted outline; no `transform`, no accent halo, no
  box-shadow.
- `.providerCatalogCard[data-status="unavailable"]:hover` reset is
  orthogonal and may remain (covers a different attribute).

### S9 — Tool/Artifact polish: design-token radius alignment + collapse-toggle a11y

**Contract invariant.**
- Tool card / diff / terminal radius family unified at 10 px
  (chip 10 / card 12 / panel 14 / modal 18 design-system rhythm).
- ArtifactPane collapse toggle has a discoverable `:focus-visible`
  affordance (3 px accent halo); icon button size lands at 24×24
  for comfortable hit target.
- No new collapse-affordance semantics; toggle behavior unchanged.

**Source-gate grep.**
- `.maka-tool`, `.maka-tool-diff`, `.maka-tool-terminal` — radius
  10 px (was 8 px).
- `.maka-artifact-pane-collapse` `:focus-visible` selector present
  with accent ring tokens.

### S10 — D1: theme palette settings contract

**Contract invariant.**
- `THEME_PALETTES` is a closed `as const` allowlist of 11 string
  literals (`default` / `onedark` / `catppuccin-mocha` /
  `tokyo-night` / `nord` / `coral` / `azure` / `forest` / `dusk` /
  `sand` / `mono`); `ThemePalette = typeof THEME_PALETTES[number]`.
- `isThemePalette(value)` is the type guard. Case-sensitive,
  rejects everything else (undefined / non-string / unknown string /
  case-variant).
- `normalizeSettings()` falls `appearance.palette` closed to
  `'default'` on any miss (missing / unknown / non-string). The
  same normalize pass must NOT silently reset unrelated fields
  (theme / palette ↔ toastPosition / personalization /
  network).
- `createDefaultSettings()` seeds `appearance.palette: 'default'`.
- Renderer path: `applyThemePalette(palette)` writes
  `<html data-maka-theme="<palette>">`; `'default'` removes the
  attribute. CSS variable overrides live in `maka-tokens.css` under
  static `[data-maka-theme="..."]` selectors.

**Targeted tests** (`packages/core/src/__tests__/settings.test.ts`,
10 cases under `theme palette settings contract`):
- Allowlist shape, type guard accept/reject (incl. case-variants),
  default seed, missing-field migration, unknown-string fail-closed,
  non-string fail-closed, valid value survives, no-silent-reset,
  patch surface round-trip, malformed-patch + normalize round-trip.

**Source-gate grep.**
- `THEME_PALETTES` / `isThemePalette` / single `appearance:` block
  in `normalizeSettings` validating BOTH palette and toastPosition.
- Renderer: `applyThemePalette` consumed only from normalized
  settings; no raw `localStorage.getItem('maka-theme-palette-v1')`
  read path today.

**Deferred / future-contract lock.**
- If a pre-React palette read is added later (FOUC prevention),
  it MUST reuse the `THEME_PALETTES` allowlist via
  `isThemePalette()`; unknown values fall through to default /
  remove the attribute. Raw localStorage string MUST NOT be
  written directly to `data-maka-theme`.

### S11 — D2: toast position settings contract

**Contract invariant.**
- `TOAST_POSITIONS` is a closed `as const` allowlist of 6 grid
  corners (`top-left` / `top-center` / `top-right` / `bottom-left` /
  `bottom-center` / `bottom-right`); `ToastPosition = typeof
  TOAST_POSITIONS[number]`.
- `isToastPosition(value)` is the type guard. Case-sensitive,
  closed-enum rejection.
- `normalizeSettings()` falls `appearance.toastPosition` closed to
  `'bottom-right'` on any miss. The single `appearance:` block in
  the normalize return validates both `palette` (D1) and
  `toastPosition` (D2) without resetting unrelated fields.
- `createDefaultSettings()` seeds `appearance.toastPosition:
  'bottom-right'` (matches the v1 hardcoded behavior).
- Source-of-truth for live UI is `App.toastPosition` (React state),
  threaded through `AppShell → SettingsModal → SettingsSurface →
  SettingsPage → ThemeSettingsPage`. `ToastProvider position={...}`
  reads it; `ToastViewport data-position={position}` is React-
  driven. **No `querySelector` / DOM mutation** from anywhere.
- `localStorage('maka-toast-position-v1')` is a pre-React boot
  mirror. It is ONLY written from:
  - `AppShell` settings-load: the normalized value just read from
    disk;
  - `ThemeSettingsPage` picker click: the normalized server return
    from a SUCCESSFUL `onUpdate(...)`. On `onUpdate` failure, the
    mirror is NOT touched.
- Pre-React `readPersistedToastPosition()` reads the mirror through
  `isToastPosition()`; out-of-band raw strings can never reach
  `data-position`.

**Targeted tests** (`packages/core/src/__tests__/settings.test.ts`,
11 cases under `toast position settings contract` + 1 cross-
contract case):
- Allowlist shape (6 corners), type guard accept/reject incl. case-
  variants and synonyms, default seed `bottom-right`, missing-field
  migration, unknown-string fail-closed, non-string fail-closed,
  valid value survives, no-silent-reset, patch surface round-trip,
  malformed-patch + normalize round-trip, **D1 + D2 cross-contract
  independence** (both malformed → each falls back to its own
  default, no interference).

**Source-gate grep.**
- `TOAST_POSITIONS` / `isToastPosition` / merged `appearance:`
  normalize block (single block for both D1 + D2).
- `localStorage.getItem('maka-toast-position-v1')` → only flows
  through `isToastPosition()`.
- `localStorage.setItem('maka-toast-position-v1', …)` writes only
  settings-load normalized value or post-onUpdate-success
  normalized return.
- Active code must contain NO `querySelector('.maka-toast-viewport')`
  / `dataset.position` mutation paths.

**Residual / non-blocking.**
- `setToastPosition` keeps optimistic React state if `onUpdate(...)`
  throws; matches existing theme/palette semantics. A stricter
  catch-revert path can land in a follow-up if needed; not gated
  by D2.

---

## Path 18 — Computer Use overlay threat model (PR-UI-CU-0)

**Status**: contract-only. No Maka Computer Use implementation
exists yet. This path locks the gate criteria a future PR-UI-CU-1
(overlay implementation) and PR-RUNTIME-CU (action runner) MUST
satisfy before merge. The threat model is captured here so the
implementation cannot be reviewed against an aspirational verbal
description; the gate is what reviewers grep.

Reference: a separate signed helper bundle (`LSUIElement`, AX +
ScreenCaptureKit + CGEvent, NDJSON over a Unix socket) is the
architectural prior art that informs these boundaries. Maka's
eventual implementation does not have to mirror the same wire
shape, but each contract below applies regardless of whether the
runner lives in a helper process or inline in the main process.

Doc convention is the same as Path 17:
- **Contract invariant** — 1-3 final-state bullets the gate will enforce
- **Source-gate grep** — patterns the merge reviewer will run when
  PR-UI-CU-1 lands; today these all fail-closed by absence
- **Deferred** — items intentionally left to PR-UI-CU-1 or
  PR-RUNTIME-CU

### S12 — Permission source: TCC-only, never claimed by the renderer

**Contract invariant.**
- Computer Use permission ALWAYS comes from macOS TCC
  (`com.apple.tcc` → `kTCCServiceAccessibility` +
  `kTCCServiceScreenCapture`). The renderer NEVER asserts CU
  permission; it only displays a state derived from a main-process
  IPC that queried TCC.
- A CU action MUST NOT be initiated unless both TCC permissions are
  granted at the moment of the action; cached "previously granted"
  state is insufficient because user can revoke at any time via
  System Settings → Privacy & Security.
- The renderer's CU affordance (button enabled / disabled / first-
  run setup) reflects this live TCC status; no path lets the
  renderer fake a granted state.

**Source-gate grep.**
- Renderer never calls TCC-affecting APIs directly. Search for
  `ApplicationServices` / `kTCCService` / `AXIsProcessTrusted` —
  must only appear in main process (or a separately-signed helper)
  source, never under `apps/desktop/src/renderer/`.
- Renderer CU state derives from a typed IPC result; no path
  builds the "permission granted" state from a renderer-local
  boolean.

**Deferred.**
- Per-action TCC verification (a CU action that begins must
  re-check TCC at action-start) — wired in PR-RUNTIME-CU.
- TCC prompt UX (when permission missing, surface a typed
  `MissingPermissionState` from the runtime; the renderer shows a
  "Open System Settings → ..." affordance via `app:openExternal`
  with the canonical TCC URL pre-allowlisted in the openExternal
  guard) — wired in PR-UI-CU-1.

### S13 — Overlay lifecycle: action-scoped, never persistent

**Contract invariant.**
- The CU overlay (the highlight ring / target box / cursor halo
  that shows where Maka is about to click) exists ONLY during an
  in-flight CU action. It is mounted on action-begin and unmounted
  on action-end. No idle / "ambient" overlay state.
- Overlay teardown MUST fire on every action-terminating event:
  `tool_complete` / `tool_error` / abort / runtime crash / user
  closes Maka / permission revoked mid-action.
- No overlay state survives across sessions, across LLM turns, or
  across renderer reloads. A renderer mount with no in-flight CU
  action MUST NOT render the overlay component at all.

**Source-gate grep.**
- `<ComputerUseOverlay>` (or equivalent) renderer mount must be
  gated by a per-session in-flight CU action — likely a
  `liveTurnBySession[sessionId].steps[].tools` entry whose tool name
  matches a known CU verb. No `&& true` / `&& isDev` overrides.
- Teardown must be wired in the same lifecycle bag as
  `clearTurnTransientState(sessionId)` (or an equivalent dedicated
  action-end cleanup) in abort/error/complete branches.
- No `setTimeout` / `setInterval` keeps the overlay alive past the
  action; teardown is event-driven only.

**Deferred.**
- Reduced-motion: overlay animations respect
  `prefers-reduced-motion` (same `data-maka-reduced-motion` channel
  Path 17 S1-S11 use) — wired in PR-UI-CU-1.

### S14 — Focus + click pass-through: overlay must never steal input

**Contract invariant.**
- The overlay window MUST call Electron's
  `BrowserWindow.setIgnoreMouseEvents(true, { forward: true })`
  (or equivalent for the chosen overlay mechanism) AND construct
  with `focusable: false`. It is purely a visual affordance; the
  underlying app is what receives clicks / keystrokes from the CU
  runtime via the action runner's `CGEventPostToPid` / accessibility
  dispatch path.
- Overlay never becomes a `<button>` / `<a>` / tab-order target /
  ARIA-interactive element in the renderer. The user CANNOT
  interact with the overlay itself; their input lands on the
  target app (or, if Maka window is foreground, on Maka).
- Overlay `pointer-events: none` (CSS) is the renderer-side mirror
  of the BrowserWindow `setIgnoreMouseEvents(true)` constraint.
  Both must hold; the BrowserWindow setting is load-bearing
  because CSS alone doesn't stop the OS-level window from
  grabbing focus on click.

**Source-gate grep.**
- `<ComputerUseOverlay>` root element carries `pointer-events: none`
  (CSS class or inline style) and NEVER mounts inside a
  `<button>` / `<a>` / role-button context.
- The overlay BrowserWindow (in the main process) is configured
  with `focusable: false`, and the runtime calls
  `setIgnoreMouseEvents(true, { forward: true })` on it before
  showing. Grep main process: any `new BrowserWindow({ ... })`
  flagged as the CU overlay window must satisfy both invariants.
  No `focusable: true`; no missing `setIgnoreMouseEvents`.
- No keyboard event handler attaches to the overlay
  (`addEventListener('keydown'` / `onKeyDown`).

**Deferred.**
- Multi-monitor placement: overlay placement on the active screen
  the action targets — wired in PR-RUNTIME-CU.

### S15 — Coordinate authority + screenshot binary display path

**Contract invariant.**
- Coordinate authority: ONLY the runtime (main process or signed
  helper) decides where to click / type / scroll. The renderer
  NEVER initiates a raw `{x, y}` click. The renderer's role is
  display-only: it shows the runtime's planned action as overlay,
  and surfaces user abort.
- Screenshot pixels (binary `Uint8Array` / PNG / JPEG) MUST flow
  through the artifact preview registry (S5) — sniffed MIME
  through `normalizeAllowedImageMime` allowlist, base64 length
  cap via `IMAGE_PAYLOAD_MAX_BASE64_LENGTH` (no `atob` decode),
  oversize → `unsupported(oversize)` with a Finder-open
  affordance instead of inline base64. Pixels MUST NOT travel any
  "fast path" that skips this gate.
- Text-shaped data captured ALONGSIDE a screenshot — window title,
  app bundle id, focused element label, URL bar contents — IS
  text and IS subject to S16's `redactSecrets` chokepoint before
  reaching React state, the artifact pane, or session log.
- `redactSecrets` is text-only and CANNOT clean screenshot pixels.
  Removing sensitive pixels happens upstream (per-app sensitivity
  blocks, OS-level screen-capture exclusion, per-frame masking
  the runtime applies before delivery) — never as a renderer-side
  pass over a base64 string.
- The metadata MIME the runtime claims (e.g. `image/png`) is
  untrusted; the renderer MUST build the final `<img src="data:…">`
  attribute from main-process **sniffed** MIME re-validated
  through `normalizeAllowedImageMime` (same gate as S5).

**Source-gate grep.**
- Renderer never imports a coordinate-click IPC and never calls
  `window.maka.computerUse.click({ x, y })` from user input
  handlers. The only caller path is the LLM-driven
  `tool_use(computer-use:*)` event flow that arrives via
  `session.subscribeEvents`.
- CU screenshot delivery into the artifact pane goes through
  the artifact preview registry (S5) for the image component;
  text metadata around it goes through `applyToolOutputChunk`
  (S1). No separate "fast path" that bypasses either gate.
- `redactSecrets(screenshot.base64)` MUST NOT appear anywhere
  (text helper applied to binary is a sign the boundary is
  misunderstood).
- Look for `data:image/...;base64,` strings in renderer code —
  these may ONLY come from `safeMime + base64` post the
  `decideImageReadOutcome` chokepoint.

**Deferred.**
- Per-app sensitivity policy: per-bundle-id denylist (1Password,
  banking apps, password fields detected via AX tree) where the
  runtime drops the frame BEFORE upload, BEFORE persistence, and
  BEFORE display — wired in PR-RUNTIME-CU.

### S15b — Provider exposure boundary: screen content sent to LLM

**Contract invariant.**
- macOS TCC permission to capture the screen ≠ user consent to
  upload that capture to a remote LLM provider. The two are
  separate gates; the user-facing connection setup that grants
  CU access to a provider must surface "screenshot uploads will
  reach this provider" explicitly. (Renderer copy beyond this
  gate's scope; the gate locks the runtime side.)
- Any screenshot frame the runtime sends to an LLM/provider call
  MUST be wrapped in a typed `ComputerUseScreenFrame` (or
  equivalent) carrying:
  - the `actionId` that scoped the capture (so the frame belongs
    to ONE in-flight action; cross-action reuse is invalid),
  - the source kind (`'live-capture' | 'cached-still'`) so the
    review path can distinguish a fresh frame from a stale one,
  - a max-size invariant matching the artifact preview cap
    (`IMAGE_PAYLOAD_MAX_BYTES` = 2 MB; oversize → sensitivity
    block, not silent downscale-and-upload).
- A screenshot frame MUST NOT be persisted raw to the session log.
  The session log records the action's outcome + a redacted text
  summary; the raw frame is held in main-process memory for the
  duration of the action and discarded on action end. If the user
  saves it explicitly via the artifact pane "Save As" affordance,
  that's a separate write path the user opts into.
- The provider route is **explicit**: if a provider does not
  support image input, OR if the user's account-level vision
  toggle is off, the CU action returns
  `error: 'sensitivity_blocked'` with `reason: 'no_vision_route'`.
  There is NO silent fallback that converts a planned vision
  call into a text-only call (which would mean the screenshot
  was silently dropped and the LLM made decisions without seeing
  it).
- `sensitivity_blocked` (the closed error from S17) applies
  BEFORE provider upload, not only before renderer display.
  A frame the runtime won't render is also a frame the runtime
  won't upload.

**Source-gate grep.**
- Provider client call sites that accept `imageContent` /
  `imageUrl` / `base64Image` parameters: every such call site
  must consume a `ComputerUseScreenFrame` (or equivalent typed
  shape), never a raw `string` / `Uint8Array` directly from a
  capture call.
- `appendToSessionLog` (or whatever the writer is) must reject
  raw screenshot payloads. Look for any path that writes
  `kind: 'image'` content WITH `base64` data into a session log
  record — that's a contract violation; the log should hold a
  reference to the artifact id, never the inline frame.
- "no_vision_route" sensitivity-block path must exist in every
  provider client that supports vision. Look for capability
  checks like `if (provider.supportsVision) { … } else { …
  return error('sensitivity_blocked', 'no_vision_route') }`. No
  silent fallback to text-only.

**Deferred.**
- Per-provider differential consent: separate the "I configured
  this provider" act from the "I let CU upload screenshots to
  this provider" act. UX surface for the second consent — wired
  in PR-UI-CU-1.
- Frame retention metering: how many frames the runtime is
  allowed to hold in memory across a single LLM turn (a long
  CU plan = many captures). Default and per-provider limit —
  wired in PR-RUNTIME-CU.

### S16 — Screen-derived text redaction: runtime-side, before LLM sees it

**Contract invariant.**
- Any text Maka extracts from a screen — OCR output, AX tree dump,
  selected-text query result, clipboard sample, window title, app
  bundle id, focused element label, URL bar contents — MUST run
  through the runtime's `redactSecrets` (the `@maka/runtime`
  re-export of the same helper the renderer uses) BEFORE it
  lands in the LLM's tool result message, BEFORE it lands in the
  session log, and BEFORE it lands in the artifact pane.
- Scope clarification (refer to S15 / S15b for the non-text path):
  this gate is **text-only**. Screenshot pixels are not text and
  flow through the artifact preview registry (S15) for display and
  the `ComputerUseScreenFrame` provider boundary (S15b) for LLM
  exposure. Applying `redactSecrets` to a base64 image string is
  a category error — pixels can carry sensitive content
  `redactSecrets` cannot see.
- The runtime-side redaction on screen-derived text is the
  SOURCE-OF-TRUTH gate. The renderer's `applyToolOutputChunk`
  secondary redaction (S1) is defense-in-depth, not the primary
  boundary — CU screen-state can contain credentials the model
  would never intentionally emit but a capture-without-redaction
  would leak.

**Source-gate grep.**
- Every CU action handler in `@maka/runtime` that returns
  `ToolResultContent` containing screen-derived TEXT must call
  `redactSecrets(value)` on that text before constructing the
  result. No `JSON.stringify(rawScreenState)` straight into a
  result block.
- Session log writer must call redact before `appendToLog`;
  look for any path that bypasses the existing log redaction wrap.
- `redactSecrets(screenshot.base64)` MUST NOT appear (S15 grep
  also locks this; both gates flag it).

**Deferred.**
- Per-app redaction policies (e.g. 1Password / browser password
  field detection → drop entirely rather than mask) — beyond
  initial scope; locked here only as a known gap to revisit.
  Related: per-app pixel-side denylist is the S15 deferred item;
  these two policies should land in the same runtime PR.

### S17 — Fail-closed: every gate failure aborts the action, never silently continues

**Contract invariant.**
- TCC permission missing at action-start → action returns
  `ToolResultContent` with `error: 'permission_missing'`. No
  retry; no "best-effort" partial click.
- Overlay setup failure (window creation rejected, monitor not
  available, focus-pass-through assertion failed) → action
  returns `error: 'overlay_failed'`. The action does NOT proceed
  without the overlay — the user's safety affordance MUST be
  visible before any click lands.
- Coordinate validation failure (target coordinate outside any
  screen bounds, NaN, negative, > screen width/height) → action
  returns `error: 'invalid_coordinate'`. No clamp / no snap-to-
  edge; bad input means abort.
- Screenshot capture failure → action returns
  `error: 'capture_failed'`. The runtime does NOT fabricate a
  blank screenshot to satisfy the LLM contract; the LLM sees the
  error and decides whether to retry.
- Sensitivity check failure (e.g. the target window is a known
  password field, or the OS is in fast-user-switching mid-state)
  → action returns `error: 'sensitivity_blocked'`. No bypass.

**Source-gate grep.**
- Every `catch` inside a CU action handler converts to a typed
  error in the `ToolResultContent`. Look for swallowed `catch`
  blocks (`catch (e) {}` or `catch { return … defaultState }`) —
  these MUST NOT exist in the CU path.
- No `try / catch` returns "success-shaped" content with a soft
  error string; the result is either `kind: 'tool_result'` with
  `error` set OR a true success. No middle ground.
- Closed error enum: `permission_missing` / `overlay_failed` /
  `invalid_coordinate` / `capture_failed` / `sensitivity_blocked` /
  `aborted` / `timeout`. Adding a new error mode is a type-surgery
  change AND a smoke.md S17 update.

**Deferred.**
- Per-action timeout policy: each CU verb has a max-wall-time;
  blow past it → `error: 'timeout'`. Default and per-verb
  override table — wired in PR-RUNTIME-CU.

### S18 — Abort semantics: <100ms teardown, no orphan clicks

**Contract invariant.**
- User-initiated abort (Esc, "Cancel" button in chat, close Maka,
  switch session) MUST tear down the in-flight CU action within
  100 ms. By "tear down" we mean:
  - Overlay window destroyed
  - Pending coordinate dispatch cancelled (the next planned
    `CGEventPost` MUST NOT fire after the abort signal lands)
  - Runtime tool state marked `aborted` (status enum), result
    block returned with `error: 'aborted'`
  - All ephemeral state (target coordinate, planned action,
    screenshot in flight) cleared from main-process memory
- An action that ABORTS mid-stream (after a click landed, before
  the planned next click) MUST report `error: 'aborted'` AND must
  include in its result block the count of completed sub-steps,
  so the LLM knows how much of a multi-step plan was actually
  performed. No silently-completed partial sequences.
- Permission revocation detected during action (e.g. user toggled
  off Accessibility in System Settings) is a special case of
  abort: same `<100ms` teardown, `error: 'permission_missing'`
  (not `'aborted'`, because the cause differs from user intent).

**Source-gate grep.**
- `AbortSignal` (or equivalent cancellation token) is threaded
  through every CU action handler — no handler is "fire and
  forget" without an abort hook.
- Renderer abort affordance (Esc in chat, Cancel button) wires
  through to `window.maka.computerUse.abort(actionId)`. No
  fake-shaped local UI revert that pretends to abort without
  reaching the runtime.
- Permission-revoked detection: runtime checks TCC at every
  action step; if revocation observed mid-action, raises the
  abort signal internally with the `'permission_missing'` error.

**Deferred.**
- Per-step granularity: long CU sequences ("open browser, search,
  click first result") can be a single LLM tool call. Abort
  granularity at sub-step level (vs whole-sequence) — wired in
  PR-RUNTIME-CU.

---

**Cross-cutting notes (not gates, but record for future PR-UI-CU-1
/ PR-RUNTIME-CU reviewers).**

- Maka's eventual CU implementation does NOT have to use a separate
  signed helper bundle. Inline-in-main-process is also acceptable,
  provided ALL the boundaries above hold. The main-
  process Electron context is already a trust boundary vs the
  renderer; an additional process boundary is defense-in-depth, not
  a contract requirement.
- The Maka workspace's existing IPC allowlist patterns
  (`app:openExternal`, `app:openPath`, etc.) are the model: each
  surface is a named, typed IPC channel with input validation in
  main process. CU should follow the same shape.
- The `redactSecrets` helper currently lives in `@maka/ui`. A CU
  threat model implementation will need a runtime-side import
  path (already exists at `@maka/runtime` re-export); the renderer
  defense-in-depth in `@maka/ui` stays unchanged.
- This Path 18 is contract-only. PR-UI-CU-1 (overlay
  implementation) and PR-RUNTIME-CU (action runner) will land each
  S12-S18 gate's targeted tests + source-grep CI hooks; until
  then, the gates fail-closed by absence (no CU code exists).

---

## When to run

- Before merging any large UI / runtime / credential / permission
  change to main.
- After any change that touches `LlmConnection`, `sessions:changed`
  payload shape, `ConnectionUiStatus` derivation, `TurnViewModel`,
  `nextRadioId`, or PermissionDialog rendering.
- Before tagging a release.

Each path is < 1 minute. The full path run is ~ 11–13 minutes.
Worth doing.
