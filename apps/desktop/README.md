# @maka/desktop

The Electron desktop app: `main` (Node/Electron main process) + `preload` (context bridge) + `renderer` (React UI). This file covers the three-layer split and the IPC contract. For build/test commands and the test-layer selection guide, see the top-level `README.md`; for the renderer interior, see `src/renderer/README.md`.

## macOS development permissions

`npm run dev` and `npm start` launch macOS development builds through a generated, ad-hoc-signed
`apps/desktop/.maka-dev/Maka Dev.app`. The stable bundle identity lets macOS TCC
retain Accessibility and Screen Recording grants while renderer and main-process
code change. The generated app is ignored by Git and is rebuilt automatically
when the installed Electron version changes. Run
`npm --workspace @maka/desktop run prepare:dev-app` to prepare it explicitly.

The scripts launch the bundle through macOS LaunchServices rather than executing
its internal binary from a terminal. This is required for TCC to attribute the
running process to `Maka Dev` and recognize the stored grants.
The launcher remains alive as the development-session supervisor until the
terminal receives Ctrl-C or SIGTERM. The generated bundle contains a small local
bootstrap that reads a PID-validated, per-worktree session file, restoring the
Vite URL and a curated environment-variable allowlist before importing the main
process. macOS's Screen Recording “Quit & Reopen” action can therefore reconnect
to the same HMR session without relying on command-line arguments that the
system restart discards. Session files live in the ignored
`apps/desktop/.maka-dev-session/` directory, outside the rebuildable app bundle,
and are written atomically with mode `0600`. Startup is acknowledged only after
the single-instance lock and main-process boot succeed; failures and timeouts are
reported in the terminal instead of leaving a windowless supervisor running.

The default profile is `~/Library/Application Support/Maka Dev-<worktree-id>`.
This keeps development isolated from the packaged Maka profile and lets separate
worktrees run concurrently. An explicit `--user-data-dir` still takes precedence.

Only one supervised Maka Dev session can use a worktree at a time. Runtime
preparation is protected by a PID lock, and shutdown targets the app PID recorded
by that supervisor rather than every process sharing the development bundle ID.
Runtime rebuilds refuse to proceed while that worktree has a live supervisor.

Grant permissions to **Maka Dev**, not a generic Electron entry. Screen Recording
changes require restarting the development app. Recreating the app or changing
its Electron version may require granting permissions again. Other platforms
continue to use their normal Electron development executable.

## Three layers

| Layer | Path | Role |
|---|---|---|
| main | `src/main/` | Node/Electron main process. Owns window lifecycle, credentials, attachments, permissions, IPC handlers, and the bridge to `@maka/runtime` + `@maka/storage`. |
| preload | `src/preload/preload.ts` (single file) | `contextBridge.exposeInMainWorld('maka', …)` — the only surface the renderer may call to reach Node/Electron. No Node API is directly exposed. |
| renderer | `src/renderer/` | React UI body. See `src/renderer/README.md`. |

## main process layout

`src/main/` is flat with a naming convention:

| Suffix | Role | Examples |
|---|---|---|
| `*-ipc-main.ts` | Exports a `register*Ipc(...)` that wires `ipcMain.handle` / `ipcMain.on` for one IPC domain | `connections-ipc-main`, `daily-review-ipc-main`, `memory-ipc-main`, `web-search-ipc-main`, `workspace-resources-ipc-main` |
| `*-main.ts` / `*-service.ts` | A service owned by main (no `ipcMain` calls of its own) | `daily-review-main`, `system-prompt-main`, `oauth-model-connections-main`, `local-memory-service` |
| `*-guard.ts` | Validation / security boundary | `external-link-guard`, `open-path-guard`, `permission-response-guard` |
| (other) | Window, state, platform wiring | `main.ts` (entry), `main-window`, `window-state`, `theme-source`, `credential-store`, `skills`, `attachment-*` |

Sub-folders: `browser/` (embedded browser view), `oauth/`, `search/` (thread search), `web-search/`, `types/`. The browser IPC handler itself (`browser-ipc-main.ts`) is flat in `src/main/`, not under `browser/`.

`main.ts` startup order: stores and the runtime/controller are created synchronously at module load; `registerIpc()` runs at top level, **before** `app.whenReady()`; inside `whenReady`, the main window is created **hidden** early and background startup (connection bootstrapping, telemetry, bots, schedulers) runs concurrently without blocking first paint. The window is created hidden and revealed after the renderer's first AppShell paint (the `window:notifyRendererReady` gate in `app.tsx`); a fallback timer reveals it if the renderer never signals, so a fail-soft loading state can show (e.g. if `main.tsx`'s onboarding prefetch times out). The real invariant for IPC: handlers must be registered before the renderer entry runs, because `main.tsx` prefetches the onboarding snapshot before mounting React. Background startup may mutate state after the renderer's first read, so don't assume it has already settled when wiring the UI.

## IPC contract

Three patterns, all rooted in preload's `maka` namespace. Channel names are `<domain>:<action>`.

- **Request/response** — `ipcRenderer.invoke('<domain>:<action>', …args)` in preload ↔ `ipcMain.handle('<domain>:<action>', …)`. The handler lives either inline in `main.ts` (e.g. `sessions:list`, `settings:get`) or in a `*-ipc-main.ts` extracted by domain (e.g. `connections-ipc-main`, `daily-review-ipc-main`). Both forms coexist; prefer extracting a new domain to its own `*-ipc-main.ts`.
- **Main→renderer push** — main sends through the safe-send guard (`safeSendToRenderer` via `mainWindowController.send`), not raw `webContents.send` (which throws when the window/`webContents` is destroyed); preload subscribes via `ipcRenderer.on` and returns an unsubscribe fn (e.g. `sessions:changed`, `plans:changed`, `artifacts:changed`). The safe-send contract test scans a fixed list of main-source files for direct `mainWindow.webContents.send(...)` forms — new `*-ipc-main.ts` files aren't auto-covered, so route sends through the guard in every new file (an alias for `mainWindow` can bypass the literal scan).
- **Renderer→main fire-and-forget** — `ipcRenderer.send('<domain>:<action>', …)` in preload ↔ `ipcMain.on('<domain>:<action>', …)`. Used when no response is needed (e.g. `browser:active-session`, `browser:setViewport`).

Adding a new IPC surface: if extracting, write the `*-ipc-main.ts` exporting a `register*Ipc(...)`, import it in `main.ts`, and call it inside `registerIpc()`; add the matching method to the `maka` namespace in `preload.ts`; add the method to the `window.maka` type in `src/global.d.ts` (the renderer's typed bridge — without it, renderer calls get a TS error); keep the `<domain>:<action>` channel naming. A handler file that isn't registered in `registerIpc()` compiles but never mounts.

## Data flow

```
renderer (React)
  └─ window.maka.<ns>.<method>(…)        // typed surface, see preload.ts
      └─ ipcRenderer.invoke / send / on
          └─ main: safeSendToRenderer / ipcMain.handle / ipcMain.on
              └─ @maka/runtime (agent runtime) + @maka/storage (JSONL persistence)
```

The renderer never imports `@maka/runtime` or `@maka/storage` at runtime — all Node-side access goes through the preload `maka` bridge. The renderer only pulls `import type` from them for a few shared types. Types shared across the IPC boundary mostly come from `@maka/core`, with some from `@maka/runtime`, `@maka/storage`, and `@maka/ui` (see `preload.ts` imports).

## Convergence note

The renderer side carries the frontend convergence debt (hand-rolled CSS, primitive overrides); see `src/renderer/README.md`. The main process itself is not part of that convergence — its boundaries (IPC channel names, the preload bridge, the `*-guard.ts` files) are stable contract seams.
