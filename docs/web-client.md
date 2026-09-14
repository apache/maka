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

# Maka Web client (Chrome / Brave)

`npm run maka-web` opens the full Maka app in system Chrome/Brave. It is the
same React App the Electron GUI runs — not a reimplementation — fed through a
loopback WebSocket tunnel instead of Electron IPC.

## Running it

Terminal 1: `npm run maka-gui`
In the GUI: Settings → Web access → passphrase (12+ chars), scan the QR in Aegis / 1Password / Google Authenticator, confirm the 6-digit code, save recovery codes, enable.

Terminal 2: `npm run maka-web -- --no-open`
It prints `http://localhost:5173/login` and:

    tailscale serve --bg http://127.0.0.1:5173

Same machine: open the localhost login URL.
Other devices: open the `https://…ts.net` URL Tailscale prints. Maka never holds the TLS key.

Without a running GUI the browser lands on the picker tier: a self-contained
page that validates a typed server-local directory and tells you how to open
it in the GUI/CLI. It never touches the bridge.

## How it works

- **Main process** (`apps/desktop/src/main/web-bridge/`): a `ws` WebSocket
  server on fixed loopback port `53217` (`port.ts`). `ScopedIpcMain` mirrors
  every per-target `handle` registration into the bridge registry with the
  identical scope-validating listener, so channels, validation, and behavior
  match Electron 1:1. `safeSendToRenderer` tees every main→renderer broadcast
  to connected browsers. Handlers see a per-tab virtual sender (`id < 0`)
  implementing exactly `RuntimeHostRendererTarget` (`send`, `once/off
  'destroyed'`, `isDestroyed`), so session observation streams, transcript
  consumers, and attachment approvals scope per browser tab the way Electron
  scopes them per WebContents.
- **Renderer** (`apps/desktop/src/renderer/platform/web/`): `electron-shim.ts`
  backs `ipcRenderer`/`contextBridge` over the socket (vite aliases
  `electron` to it; the Electron renderer never imports `electron`, so the
  alias is inert there). `web-boot.ts` connects, then executes the real
  `src/preload/preload.ts` source, so `window.maka` is the identical bridge
  object — `main.tsx` then boots the unchanged desktop App.
- **Transport**: same-origin only. Vite proxies `/bridge` (WebSocket) and
  `/api` (picker API) to loopback, which keeps the pinned renderer entry CSP
  (`connect-src 'self'`) satisfied. The fixed port exists so the static proxy
  config has a static target. The gateway attaches the disk bridge token only
  on the loopback hop; browsers authenticate with a session cookie, not a URL
  query token.

## Security posture

- Loopback-only Vite + loopback web-bridge (`127.0.0.1:53217`).
- Web login: owner passphrase (Argon2id) + TOTP (or one-time recovery). No SQL.
- Session: httpOnly, Secure, SameSite=Strict cookie. Bridge token stays on disk and is attached only on the loopback hop.
- Origin allowlist: `http://localhost|127.0.0.1` and `https://*.ts.net`.
- Origin on `/bridge` must match this Host.
- GUI does not prompt for MFA.
- Vite `/@fs` and HMR paths are not session-gated (dev-only source disclosure if Serve is up before login).

## Known limits (v1)

- The GUI must be running — it owns the backend. (Closing all GUI windows
  quits the app on Linux and drops browser sessions.)
- Native pickers (`Add project`, attachments) open their dialogs on the GUI
  machine — correct locally, confusing over any remote setup (not supported).
- Embedded browser views, computer-use mirror, OAuth popups, and auto-update
  are Electron-only and fail closed with bridge errors in the browser.
- One bridge per profile (fixed port); last GUI to boot does not steal —
  the second gets no bridge.
