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

# Maka desktop shell

[简体中文](README.zh-CN.md)

`maka-desktop-shell` runs the [workbench](../workbench/README.md) in a window of its own through NSH's AppKit backend on macOS, its Direct2D backend on Windows and GTK on Linux. It is the application the [terminal shell](../terminal-shell/README.md) runs, compiled into the executable. On a graphical desktop the workbench's headers are the window's title bar, and the application menu carries its commands and their shortcuts.

Build from the repository root:

```sh
just build
# Or: just build --release
```

This builds the CLI and the shell. On macOS it stages `Maka.app` beside `maka`: the shell in `Contents/MacOS`, with an `Info.plist` and icon (from `assets/logo.png`), so the system shows the window as Maka with its icon. `maka desktop` starts the shell in that bundle, so after rebuilding the shell with Cargo alone, run `just build` again to refresh it. `--target TRIPLE` selects another Rust target. Native packages carry `bin/maka` and `bin/maka-desktop-shell` (plus Windows executable suffixes and its service helper); the macOS package carries `bin/maka` and `bin/Maka.app/`.

`Maka.app` is signed ad-hoc, so each build is a new app to macOS and loses its Screen Recording and Accessibility grants. To keep them across rebuilds, create a code-signing certificate (an Apple Development certificate from Xcode, or a self-signed one from Keychain Access) and build with `MAKA_CODESIGN_IDENTITY` set to its name; after the first build with it, reset the old grants with `tccutil reset ScreenCapture org.apache.maka.desktop` and `tccutil reset Accessibility org.apache.maka.desktop`.

On Windows the shell embeds `maka.ico`, derived from `assets/logo.png`, as its application icon in both debug and release builds.

Start it with the launcher:

```sh
/absolute/path/to/maka desktop
# Or select another Host Root:
/absolute/path/to/maka desktop --root /absolute/path/to/business-host
```

`--root` selects the business Host Root and defaults to `~/.maka/application/host`. The launcher initializes a missing Root with the standard read-only business Host or reopens its saved deployment, verifies discovery against the connected Host endpoint, source and epoch, and supplies `MAKA_HOST_ROOT`, `MAKA_HOST_ENDPOINT` and `MAKA_HOST_EPOCH` to the shell, with its own path in `MAKA_LAUNCHER`. The shell admits itself to that Host as the terminal shell does and keeps its client data under the Root.

Opened directly, from Finder, the Dock or a file manager, the shell has none of these variables. It then runs `maka desktop` from the directory it was staged in, beside `Maka.app` on macOS or beside the shell elsewhere, and exits; that launcher opens the window for the default Root.

Closing the window hides it and keeps its one UI engine and Host client; the tray's Open brings it back. On Linux without a panel that hosts the tray, closing quits instead, and a panel that leaves brings a hidden window back. Quit from the tray, the application menu or the quit key closes the desktop and launcher sessions. The last client to quit shuts down an ephemeral Host and settles the work it owns. A shared or managed Host continues serving its clients.

The Linux GTK window restores its normal size and full-screen or maximized state from `clients/desktop-window.json` in the Root. The desktop compositor chooses its position and monitor. GTK provides native menus, file drops, clipboard access, folder dialogs and system notifications. UI reloads pause physical input, drain admitted edits, and resume input after cancellation or replacement. Build prerequisites are listed in [NSH’s Linux guide](../../../third-party/nsh/docs/dev/linux.md).

If the Host stops while the AppKit or Linux window is open (it crashed, or was retired over its clients), the shell notices within a few seconds, connects to the Root's next Host, starting one through the launcher as `maka desktop` does, and loads the workbench again in the same window. The workbench starts over, as when the desktop opens; a turn the stopped Host was running shows as stopped. On AppKit, the old UI stops accepting actions and all permission setup windows close; on Linux, the last workbench remains visible but its actions fail. The shell retries with growing pauses of up to 30 seconds. It reconnects only while the Root it opened is still at its path: a moved or deleted Root is not initialized afresh.

On macOS the AppKit window saves its frame in the application's defaults rather than in `clients/desktop-window.json`, without the full-screen state. It follows Host replacements as described above. A plugin change that needs a UI reload takes effect on the Host, but the window keeps the old UI until it is reopened. A completed skill reference in the composer is deleted a character at a time, since AppKit input has no `tokens`. The window posts no system notifications.

## Computer permission setup

Linux and Windows retain the inline permission flow; separate setup windows are currently supported on macOS only.

AppKit opens system-permission setup in a separate resizable window, keyed by the original Host source and request. Reopening that request focuses its existing window. Closing it or pressing Escape dismisses only setup; cancelling the original interaction remains an explicit UI action. Closing the main workbench closes its setup windows as well.

On macOS's AppKit backend, a verified local application is shown with its actual system icon and can be dragged into System Settings as a file URL. Neither the UI nor component props choose the dragged path. The source starts only one session per mouse gesture; a cancelled or rejected drag leaves the window open and can be tried again with a new gesture. Setup uses the same client storage and appearance settings as the main workbench, but its bindings remain scoped to the request's original Host service, including remote sources. Host replacement disposes of all old setup surfaces before loading a fresh workbench. AppKit opens only the permission utility at floating level, docked inside the active screen’s upper-right work area, so System Settings does not cover it. Reopening the same request focuses its window without changing a position the user adjusted; the main workbench never floats.


## Windows Direct2D

Run in an ordinary PowerShell terminal, from the repository root:

```powershell
npm ci
cargo build -p maka-cli -p maka-desktop-shell
.\target\debug\maka.exe desktop --root "$env:USERPROFILE\.maka\direct2d"
```

Use the Windows Rust/MSVC prerequisites in [native build tooling](../../../scripts/rust/README.md) and [NSH's Windows guide](../../../third-party/nsh/docs/dev/windows.md). Install the lockfile's JavaScript dependencies before building: missing npm packages can otherwise survive as unresolved runtime imports in generated plugin bundles. Rebuild the CLI's embedded UI packages after correcting an incomplete dependency installation.

Windows has one desktop backend: Direct2D. Its native directory chooser runs on a dedicated COM apartment thread. This runner connects to the admitted Host for the lifetime of its window and does not reconnect after that Host stops. It rejects UI reload requests and system notifications explicitly. Separate system-permission setup windows are unsupported, so the workbench keeps the inline permission flow. Window activation follows Win32 activation messages, text-size changes apply immediately, and the workbench's exit command closes the native window.

## Verification

```powershell
cargo test -p maka-desktop-shell
cargo test --manifest-path third-party/nsh/Cargo.toml -p nsh-platform-windows --lib
cargo clippy --manifest-path third-party/nsh/Cargo.toml -p nsh-platform-windows --all-targets -- -D warnings
```

For performance comparisons, build both shells with the same release profile and use the same Host executable, viewport and initial data. Measure shell startup separately from Host admission. Do not compare an error-boundary screen against a fully loaded workbench.
