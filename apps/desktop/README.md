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

# @maka/desktop

The Electron desktop app: `main` (Node/Electron main process) + `preload` (context bridge) + `renderer` (React UI). This file covers the three-layer split and the IPC contract. For build/test commands and the test-layer selection guide, see the top-level `README.md`; for the renderer interior, see `src/renderer/README.md`.

## Personal assistant web chat (first version)

The web chat connects to the default Host's existing personal assistant. Enable
Personal Assistant in desktop settings and open it once before connecting. It
shares the owner conversation, Inbox admission and SendUser output; opening the
page does not create another Bot or start discovery/index maintenance.

Build and start from the repository root (workspace dependencies must already be built):

```sh
npm run build --workspace @maka/desktop
MAKA_ASSISTANT_WEB_PORT=8787 npm start --workspace @maka/desktop
```

Open `http://127.0.0.1:8787`. The listener is off unless
`MAKA_ASSISTANT_WEB_PORT` is supplied and closes with the desktop app.
Only loopback bindings (`127.0.0.1`, `::1`, `localhost`) are accepted. Direct
LAN/public bindings such as `0.0.0.0` are rejected because this listener has no
built-in authentication.
For phone or remote access, use an authenticated HTTPS reverse proxy (for example
Cloudflare Access) and set `MAKA_ASSISTANT_WEB_ORIGIN=https://your-hostname`.
The proxy must protect the page and all `/api/` routes; configuring an origin is
not authentication. Host headers must match a loopback address at the listener's
port or the configured public origin's host. Origins are independently checked;
forwarded headers do not grant access. This prevents DNS-rebinding domains from
using their own matching Host/Origin pair to reach the local assistant.

The page supports text, Markdown, optional authored summaries, older history,
typing state and live updates. An SSE connection announces transcript changes;
the page reads the canonical transcript from its last position on reconnect.
Retries retain their message ID, and an unconfirmed send is kept in browser tab
storage for manual retry. Host/session identity prevents a stale page from
sending into another assistant. Runtime subscription cursors are scoped and
validated; an expired cursor reloads a fresh history tail.

Only user-facing user/assistant rows are displayed. File transfer, desktop-only
artifact/original links, configuration and background mobile push notifications
are not part of this version. Maka must remain running; missed messages become
visible when the page reconnects. No additional conversation database is created.

Focused validation:

```sh
npm run build:main --workspace @maka/desktop
npm run build:assistant-web --workspace @maka/desktop
npm run typecheck:assistant-web --workspace @maka/desktop
node --test apps/desktop/dist/main/__tests__/assistant-web.test.js
```

## Managed HTML Artifact previews

Generated Files → the HTML file's menu → **Open in default app** opens a
Desktop-owned HTTP snapshot in the system browser. The session-bound
`ArtifactPreview({ artifactId })` tool prepares the same kind of endpoint for
browser tools without starting a shell server or relaxing the `file://` policy.
Save As and Show in Folder still export the original, unrestricted file.

Snapshots support self-contained interactive HTML: inline scripts/styles and
embedded images/fonts. A response CSP sandbox blocks same-origin authority,
fetch requests, remote subresources, forms, frames and popups. This is not an
OS network sandbox: an external browser can still navigate away from the
document. Referenced workspace files are not served. Use Save As for documents
requiring external resources.

Each snapshot gets its own loopback port and a 256-bit bearer URL. Do not share
the URL. There is no directory listing, CORS access, persistent disk copy or
cache. The server checks the exact Host and path, accepts GET/HEAD only, caps
each snapshot at 8 MiB and reserves at most 16 concurrent snapshots. Listeners
and memory are released after 30 minutes, on Artifact deletion through the
Desktop, on host-target retirement, or when the app exits. A remote Host's
Artifact is streamed to the Desktop through the existing authenticated client;
the resulting URL belongs to the Desktop machine, not the Host's localhost.

`reachable: true` is evidence that a bounded Desktop HTTP probe succeeded.
`loaded: false` deliberately does **not** assert browser rendering. An OS
launch success also does not prove page load; browser observation is required
before reporting that the page loaded or its interaction worked (#5235).

`browser_navigate`, `browser_snapshot` and `browser_click` return structured
evidence through the existing Client Capability result. `status` distinguishes
completed actions, failures, timeouts, unsupported surfaces, unknown observations
and invalidated evidence. `opened`/`loaded` describe the observed browser document;
they require a completed load event for the current document, not just a stopped
spinner or readable DOM. A truncated response fails verification; stopping a
pending load invalidates its evidence. Partial pages remain usable in the UI.
These results do not verify the intended content. Check the snapshot title and requested
marker before reporting a preview verified. A click reports matches with
`interaction: not_verified`: compare the requested change in a subsequent
snapshot with the same `documentId`. Navigation or view replacement invalidates
that comparison. Observed URLs omit credentials, query and fragment, and managed
preview bearer paths are redacted. No observed URL is synthesized from a request.

Focused regression checks (build workspace dependencies first):

```sh
npm run build:main --workspace apps/desktop
node --test apps/desktop/dist/main/__tests__/managed-artifact-preview.test.js apps/desktop/dist/main/__tests__/runtime-host-artifacts-ipc-main.test.js
npm --workspace @maka/desktop run smoke:preview:run
```

The preview smoke uses a temporary Electron profile, actual managed previews,
production browser tools and real Chromium JavaScript/clicks. It covers the
title/marker/counter workflow, revoked/expired URLs, an unreachable endpoint,
HTTP errors, truncated responses, stopped loads and an unfinished load. Artifact storage reads are fixture data;
this focused smoke does not replace a model-driven `dev:worktree` check.

## Worktree development profiles

Run `npm run dev:worktree` from the repository root to start desktop HMR with
an independent data directory for this checkout. This prevents experimental
branches from reading or writing another checkout's settings, sessions, and
runtime policy. The first launch opens onboarding with an empty configuration;
existing data and credentials are not copied. Only the profile is separate:
user-level state outside it, such as skills in `~/.maka/skills` and
`~/.agents/skills`, stays shared with every checkout.

The launcher prints the selected directory before building. It uses the
checkout's canonical path, not its branch name: restarting or switching branches
in the same checkout reuses the profile; distinct checkouts get separate
profiles, even when their directory names match. Symlink aliases reuse the same
profile. Moving a checkout selects a new profile and leaves its old data intact.

Profiles live in `Maka Dev Worktrees/<checkout-name>-<path-hash>` beneath:

- macOS: `~/Library/Application Support`
- Windows: `%APPDATA%` (defaults to `%USERPROFILE%\AppData\Roaming`)
- Linux: `$XDG_CONFIG_HOME` (defaults to `~/.config`)

An explicit directory takes precedence, with relative paths resolved against the
checkout root. Both argument forms are accepted:

```sh
npm run dev:worktree -- --user-data-dir="/path/to/my profile"
npm run dev:worktree -- --user-data-dir "/path/to/my profile"
MAKA_DEV_TCC=1 npm run dev:worktree  # macOS permission development
```

This command uses the existing desktop launcher, including its process cleanup
and macOS TCC support. `npm run dev`, `npm start`, and the CLI retain their
existing profile selection. With `MAKA_DEV_TCC=1`, every launch republishes the
profile of this checkout's app bundle, so reopening the bundle from the Dock,
Spotlight, or a permission prompt uses the profile of the last TCC launch here:
after a TCC `npm run dev` or `npm start`, run `dev:worktree` again before
reopening it. Removing a Git worktree does not remove its data, and a checkout
later created at the same path reuses it: quit the app and manually remove its
printed profile directory when it is no longer needed.

## macOS development permissions

`npm run dev` and `npm start` use the plain Electron executable on every
platform. Working on Accessibility or Screen Recording is the exception: macOS
TCC will not keep a grant for an unsigned executable launched from a terminal.
Set `MAKA_DEV_TCC=1` to launch through a generated, ad-hoc-signed
`apps/desktop/.maka-dev/Maka Dev.app` instead.

```sh
MAKA_DEV_TCC=1 npm run dev
```

The bundle gives TCC a stable identity (`com.maka.dev.<worktree-id>`), a
verifiable signature, and a responsible process that is the app, not the terminal.
It is launched through LaunchServices for the same reason — running its inner
binary directly puts the terminal back in the responsibility chain. The
generated app is ignored by Git and rebuilt when the installed Electron version
or this repository's path changes; run
`npm --workspace @maka/desktop run prepare:dev-app` to prepare it explicitly.

This workflow is opt-in because it costs a codesign rebuild and puts an extra
app in your Dock and in System Settings. Developers who are not touching OS
permissions should not pay for it. Main-process logs are still streamed to the
terminal. Each TCC launch gets separate private log and result files: logs are
observation only, while the one-shot result carries the single-instance verdict.

Everything the bundle needs is fixed when it is built, so a launch with no
arguments and no environment — the Dock, Spotlight, or Screen Recording's
“Quit & Reopen” — produces a correct app. There is no long-lived session
protocol or supervising process: the app instance and the dev session are
separate lifecycles. Ctrl-C stops the launcher and, for `npm run dev`, its Vite
server; it does not quit a TCC app launched through LaunchServices. Quit that
app with Cmd-Q. Likewise, quitting the TCC app does not stop the dev server.
Application-control variables (API keys, `MAKA_*`, the Vite URL)
are published to an ignored `0600` file at `.maka-dev/dev-env.json` rather than
a command line. That file, not the shell, is what makes a Dock or “Quit &
Reopen” launch work, since those have no parent shell at all. `PATH` is not
recorded in it: a stored `PATH` goes stale, and `shell-env.ts` resolves the
login-shell `PATH` in the main process for exactly this case.

The bundle identifier is scoped to the worktree because TCC keys its rows on
that identifier: a shared one would make each worktree overwrite the previous
one's stored requirement and silently break it. Scoping it gives every worktree
its own durable, independently revocable grant.

The ad-hoc signature keeps its default designated requirement, a bare `cdhash`.
That means a rebuild costs a re-grant — but a rebuild happens only on an
Electron bump or a repository move, not on an ordinary `npm run dev`. Pinning
the identifier instead would survive rebuilds, and it is tempting for exactly
that reason, but `codesign --sign -` is available to every unprivileged process:
any binary anywhere on the disk could claim the identifier and satisfy the
requirement. Since TCC rows outlive the code they were granted to, that would
leave a permanently redeemable Accessibility and Screen Recording token behind
even after this repository is deleted. Re-granting after an Electron bump is the
cheaper side of that trade.

Note that the payload at `dist/main/main.js` is loaded from outside the
signature seal. Write access to this repository is therefore a deliberate trust
assumption of the development workflow — a separate matter from who may claim
the bundle's identity.

The default profile is `~/Library/Application Support/Maka Dev`, which keeps
development isolated from the packaged Maka profile and is shared by the plain
dev build and the TCC dev build; an explicit `--user-data-dir` takes
precedence. (The README previously also claimed the repository CLI
(`npm run cli:dev`) shares it — unverified; the CLI entry does not go through
the desktop dev launcher, so this claim is dropped until verified.) Electron's
single-instance lock is the only authority for the shared development profile.
A second launch exits with an explicit conflict instead of scanning for or
terminating an existing Electron process. Plain dev owns its direct child;
the TCC launcher consumes only the one-shot lock verdict and never owns or
signals the detached app process.

Known limitation: Chromium may kill an unresponsive lock holder after its
20-second acknowledgement timeout and let the new instance take the lock.
Sharing the profile widens the launch pairs that can reach this existing
behavior; investigation and evidence live in #3539.

Known limitation: `dev-env.json` outlives the session, so launching from the
Dock long after `npm run dev` has stopped points the app at a Vite URL that is
no longer served, and the window stays blank. Start a dev session first. If
another worktree has since taken that port, the window loads *its* renderer
instead, which looks like it worked.

Grant permissions to **Maka Dev**, not a generic Electron entry. Screen
Recording changes require restarting the development app. Without
`MAKA_DEV_TCC`, the permission overlay still runs, but its drag target is the
npm Electron bundle, which macOS will not accept as a durable grant.

## Three layers

| Layer | Path | Role |
|---|---|---|
| main | `src/main/` | Node/Electron client process. Owns windows, OS capabilities, client-local settings, IPC projection, and the Runtime Host connection. Runtime execution and canonical runtime policy belong to Runtime Host. |
| preload | `src/preload/preload.ts` (single file) | `contextBridge.exposeInMainWorld('maka', …)` — the only surface the renderer may call to reach Node/Electron. No Node API is directly exposed. |
| renderer | `src/renderer/` | React UI body. See `src/renderer/README.md`. |

## main process layout

`src/main/` is flat with a naming convention:

| Suffix | Role | Examples |
|---|---|---|
| `runtime-host-*-ipc-main.ts` | Projects one Runtime Host protocol domain onto renderer IPC | `runtime-host-connections-ipc-main`, `runtime-host-session-execution-ipc-main`, `runtime-host-settings-ipc-main` |
| `*-ipc-main.ts` | Registers a client-local Electron or OS-facing IPC domain | `browser-ipc-main`, `workspace-search-ipc-main` |
| `*-service.ts` / `*-controller.ts` | A client-local service without direct IPC ownership | `app-update-service`, `project-management-service`, `project-root-controller` |
| `*-guard.ts` | Validation / security boundary | `external-link-guard`, `open-path-guard`, `permission-response-guard` |
| (other) | Window, state, platform wiring | `main.ts` (entry), `main-window`, `window-state`, `theme-source`, `credential-store`, `skills`, `attachment-*` |

Sub-folders hold OS-facing implementations such as `browser/`, `computer-use/`, `oauth/`, and `permission-overlay/`. Runtime Host adapters stay flat and carry the `runtime-host-` prefix so ownership is visible at the import boundary.

`main.ts` performs only pre-ready Electron identity and single-instance work. After `app.whenReady()`, it dynamically imports `runtime-host-boot.ts`. Boot validates the storage root before any Runtime Host state can be written, registers persistent client-local IPC, connects or spawns Runtime Host, registers connection-scoped Host IPC, and only then creates the first renderer window. The window remains hidden until the renderer's first AppShell paint (`window:notifyRendererReady`), with a fallback reveal timer for fail-soft startup.

## IPC contract

Three patterns, all rooted in preload's `maka` namespace. Channel names are `<domain>:<action>`.

- **Request/response** — `ipcRenderer.invoke('<domain>:<action>', …args)` in preload ↔ `ipcMain.handle('<domain>:<action>', …)`. Runtime domains are projected by `runtime-host-*-ipc-main.ts`; OS-facing client domains use a focused `*-ipc-main.ts` module.
- **Main→renderer push** — main sends through the safe-send guard (`safeSendToRenderer` via `mainWindowController.send`), not raw `webContents.send` (which throws when the window/`webContents` is destroyed); preload subscribes via `ipcRenderer.on` and returns an unsubscribe fn (e.g. `sessions:changed`, `scheduled-tasks:changed`). The guard checks both the `BrowserWindow` and its `webContents` before delivery. Route every new main-window push through it.
- **Renderer→main fire-and-forget** — `ipcRenderer.send('<domain>:<action>', …)` in preload ↔ `ipcMain.on('<domain>:<action>', …)`. Used when no response is needed (e.g. `browser:active-session`, `browser:setViewport`).

Adding a new IPC surface: if extracting, write the `*-ipc-main.ts` exporting a `register*Ipc(...)`, import it in `main.ts`, and call it inside `registerIpc()`; add the matching method to the `maka` namespace in `preload.ts`; add the method to the `window.maka` type in `src/global.d.ts` (the renderer's typed bridge — without it, renderer calls get a TS error); keep the `<domain>:<action>` channel naming. A handler file that isn't registered in `registerIpc()` compiles but never mounts.

## Data flow

```
renderer (React)
  └─ window.maka.<ns>.<method>(…)        // typed surface, see preload.ts
      └─ ipcRenderer.invoke / send / on
          └─ main: safeSendToRenderer / ipcMain.handle / ipcMain.on
              └─ Runtime Host protocol → @maka/runtime + @maka/storage
```

The renderer never imports `@maka/runtime` or `@maka/storage` at runtime — all Node-side access goes through the preload `maka` bridge. The renderer only pulls `import type` from them for a few shared types. Types shared across the IPC boundary mostly come from `@maka/core`, with some from `@maka/runtime`, `@maka/storage`, and `@maka/ui` (see `preload.ts` imports).

## Convergence note

The renderer side carries the frontend convergence debt (hand-rolled CSS, primitive overrides); see `src/renderer/README.md`. The main process itself is not part of that convergence — its boundaries (IPC channel names, the preload bridge, the `*-guard.ts` files) are stable contract seams.

### WeChat personal assistant transport

All eight IM channels offer Personal assistant, Separate task and WorkHub targets.
The overview sets the global default; each channel can inherit it or override it.
Existing explicit channel choices are preserved. New channels inherit the default. The existing task and WorkHub routes remain available. In assistant
mode, WeChat uses the enabled, existing personal assistant. Open the assistant once on desktop, then scan
to connect WeChat. QR onboarding limits access to the scanning user. Existing local
bridge configurations must explicitly allow exactly one private-chat user; group
chats cannot reach the assistant. Telegram, Feishu, WeCom, WeChat, Discord, DingTalk, QQ and Slack use the same assistant routing.
Assistant mode requires exactly one allowed user and rejects group chats. For channels
whose chat IDs differ from user IDs, the first authorized private message binds the
reply destination; no destination is guessed from the allowlist. The binding and
delivery receipts survive restart.

New `SendUser` messages (including discovery and delegated task results) are mirrored
as full text, without replaying pre-binding history. Delivery runs independently of
incoming messages and the Agent. It attempts at most twice, with a short delay;
failures and attempt receipts persist in the desktop user-data `assistant-wechat`
directory. Crash-uncertain attempts count toward the limit. Delivery is best effort,
not exactly-once or guaranteed receipt. Desktop/web history remains authoritative.

iLink reply contexts are stored per account/credential in `wechat-reply-context`
with file mode 0600, refreshed from incoming messages, and checked via send business
return codes. Persisting a context cannot extend its server-side validity. The initial
connection confirmation may fail until the user sends a WeChat message. Disabling
the channel/assistant or selecting another mode stops subsequent assistant delivery; changing the bound account or owner
conversation starts a new boundary. No second Bot or ordinary task Session is created.


In personal-assistant mode, WeChat's typing hint follows the Bot's current work,
refreshes at most every four seconds, and clears on sleep, error, mode changes or
shutdown. It does not follow delegated Matters that are waiting in the background.
Typing/config calls run independently from message delivery. iLink startup/shutdown
notifications are advisory and do not gate chat availability. These auxiliary requests
have short transport timeouts; they do not impose an Agent execution time limit.

The adapter preserves the server's message ID when present (otherwise its local
client ID). Assistant delivery receipts store that acknowledgement, which does not
prove delivery to the phone or that the user has read it. No delivery/read-receipt
API is assumed. Text and provided voice transcriptions remain supported; binary
image/file/video ingestion and sending are not implemented by this assistant transport.


### Feishu personal assistant transport

Feishu/Lark can select Personal assistant, Separate task or WorkHub, or inherit
the global target, just like the other channels. Enable and open the desktop assistant
first. Quick onboarding requests the scanning user's `open_id` and binds that user.
Manual setup requires exactly one allowed `open_id` in assistant mode. Missing or
multiple owners deny access, rather than opening the personal assistant to everyone.
Group messages do not enter the personal assistant. The shared transport uses the
same owner Session as desktop/web and WeChat; it never creates another Agent.

New SendUser rows, including proactive discoveries and delegated task results, are
mirrored independently with one retry and persisted receipts. Existing history is
not replayed. Feishu sends use provider UUIDs stable across retries (deduplication is
subject to Feishu's server retention window, not an exactly-once guarantee).
Markdown is preserved. Replies without summaries use ordinary rich-text posts, not cards.
AI-authored summaries become expandable JSON 2.0 cards;
long bodies are split without dropping text. The first message ID is retained when
a reply needs multiple cards. Existing task/WorkHub reply threading is unchanged.

While the assistant Bot is working, the latest inbound message gets a `Typing`
reaction. Repeated status checks reuse that reaction, and sleep/stop removes it.
This is a processing reaction, not native chat typing. The app needs message-reaction
write permission. Reaction errors never prevent receiving or sending chat messages.
Feishu's read-users API is queried for the latest acknowledged assistant message,
at most once every 30 seconds and for at most a day. Results live in the private
transport receipt, not a desktop/web read badge. Missing read permissions mean
`unknown`, never falsely `unread` or `read`; acceptance alone is not proof of delivery.
For split replies, this observation applies only to the first card.

The bot needs permission to receive direct messages and send as the bot; reactions
and read-user queries additionally depend on the permissions granted to that app.
This change does not grant scopes automatically. It retains the existing long
connection and Feishu/Lark region setting. Picture/file/audio/video messages receive
an explicit unsupported notice; binary attachment ingestion is not implemented.
No source indexing/synchronization settings are changed by the IM entry point.
