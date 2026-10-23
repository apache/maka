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

`maka-desktop-shell` runs the [workbench](../workbench/README.md) in a window of its own through NSH's GPUI backend, on macOS, Windows and Linux. It is the application the [terminal shell](../terminal-shell/README.md) runs, compiled into the executable. On a graphical desktop the workbench's headers are the window's title bar, and the application menu carries its commands and their shortcuts.

Build from the repository root:

```sh
just build
# Or: just build --release
```

This builds the CLI and the shell. On macOS it stages `Maka.app` beside `maka`: the shell in `Contents/MacOS`, with an `Info.plist` and icon (from `assets/logo.png`), so the system shows the window as Maka with its icon. `maka desktop` starts the shell in that bundle, so after rebuilding the shell with Cargo alone, run `just build` again to refresh it. `--target TRIPLE` selects another Rust target. Native packages carry `bin/maka` and `bin/maka-desktop-shell` (plus Windows executable suffixes and its service helper); the macOS package carries `bin/maka` and `bin/Maka.app/`.

Start it with the launcher:

```sh
/absolute/path/to/maka desktop --root /absolute/path/to/business-host
```

`--root` is required and names the actual business Host Root. The launcher initializes a missing Root with the standard read-only business Host or reopens its saved deployment, verifies discovery against the connected Host endpoint, source and epoch, and supplies `MAKA_HOST_ROOT`, `MAKA_HOST_ENDPOINT` and `MAKA_HOST_EPOCH` to the shell, with its own path in `MAKA_LAUNCHER`. The shell admits itself to that Host as the terminal shell does and keeps its client data under the Root.

Closing the window, the quit menu item and the quit key all close the window; the shell then detaches from the Host and exits. The launcher detaches as well, so the Host finishes the work it accepted and stops once no client is left. Cancelling the launcher stops only its shell.

The window opens on the display, at the position and size, and in the full-screen or maximized state it had when it last closed, as recorded in `clients/desktop-window.json` in the Root. If that display is gone it opens centered on the main display; if too little of its top edge would be on the display to grab, it opens centered there.

If the Host stops while the window is open (it crashed, or was retired over its clients), the shell notices within a few seconds, connects to the Root's next Host, starting one through the launcher as `maka desktop` does, and loads the workbench again in the same window. The workbench starts over, as when the desktop opens; a turn the stopped Host was running shows as stopped. Until a Host is reached the window keeps the last workbench, whose actions fail, and the shell retries with growing pauses of up to 30 seconds. It reconnects only while the Root it opened is still at its path: a moved or deleted Root is not initialized afresh.
