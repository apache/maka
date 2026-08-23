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
terminal — `open` redirects them to `.maka-dev/app.log`, which the launcher
follows.

Everything the bundle needs is fixed when it is built, so a launch with no
arguments and no environment — the Dock, Spotlight, or Screen Recording's
“Quit & Reopen” — produces a correct app. There is no session protocol or
supervising process: the app instance and the dev session are separate
lifecycles. Application-control variables (API keys, `MAKA_*`, the Vite URL)
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

The default profile is `~/Library/Application Support/Maka Dev-<worktree-id>`,
which keeps development isolated from the packaged Maka profile; an explicit
`--user-data-dir` takes precedence. Shutdown matches this worktree's own bundle
path, so a concurrent worktree's app is unaffected. Because that lock is keyed
on the profile, a launch first reclaims any app left over from a hard-killed
session — otherwise the stale app would absorb the new launch and keep showing
its old, dead Vite URL.

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
| `*-ipc-main.ts` | Registers a client-local Electron or OS-facing IPC domain | `browser-ipc-main`, `notifications-ipc-main`, `workspace-search-ipc-main` |
| `*-service.ts` / `*-controller.ts` | A client-local service without direct IPC ownership | `app-update-service`, `project-management-service`, `project-root-controller` |
| `*-guard.ts` | Validation / security boundary | `external-link-guard`, `open-path-guard`, `permission-response-guard` |
| (other) | Window, state, platform wiring | `main.ts` (entry), `main-window`, `window-state`, `theme-source`, `credential-store`, `skills`, `attachment-*` |

Sub-folders hold OS-facing implementations such as `browser/`, `computer-use/`, `oauth/`, and `permission-overlay/`. Runtime Host adapters stay flat and carry the `runtime-host-` prefix so ownership is visible at the import boundary.

`main.ts` performs only pre-ready Electron identity and single-instance work. After `app.whenReady()`, it dynamically imports `runtime-host-boot.ts`. Boot validates the storage root before any Runtime Host state can be written, registers persistent client-local IPC, connects or spawns Runtime Host, registers connection-scoped Host IPC, and only then creates the first renderer window. The window remains hidden until the renderer's first AppShell paint (`window:notifyRendererReady`), with a fallback reveal timer for fail-soft startup.

## IPC contract

Three patterns, all rooted in preload's `maka` namespace. Channel names are `<domain>:<action>`.

- **Request/response** — `ipcRenderer.invoke('<domain>:<action>', …args)` in preload ↔ `ipcMain.handle('<domain>:<action>', …)`. Runtime domains are projected by `runtime-host-*-ipc-main.ts`; OS-facing client domains use a focused `*-ipc-main.ts` module.
- **Main→renderer push** — main sends through the safe-send guard (`safeSendToRenderer` via `mainWindowController.send`), not raw `webContents.send` (which throws when the window/`webContents` is destroyed); preload subscribes via `ipcRenderer.on` and returns an unsubscribe fn (e.g. `sessions:changed`, `scheduled-tasks:changed`, `artifacts:changed`). The safe-send contract test scans a fixed list of main-source files for direct `mainWindow.webContents.send(...)` forms — new `*-ipc-main.ts` files aren't auto-covered, so route sends through the guard in every new file (an alias for `mainWindow` can bypass the literal scan).
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
