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

`maka-desktop-shell` runs the authored [app](app/) with the retained GPUI shell and QuickJS runtime. Its native modules expose the public Host client, selected files and system locale; the app owns its views and commands.

The transcript follows new output while at the end. Scrolling up pauses following; returning to the end or sending a message accepted by the Host resumes it. Rejected sends leave the reading position alone.

Language is shared with the connected Host's assistant preferences. The app reads it at startup and whenever Settings opens, and applies a change after the Host confirms it and returns the saved preferences. Automatic language follows the Host's system; an unset preference follows its configured default. Already accepted work retains its captured language. Conflicts and failed saves are shown without automatically retrying the mutation. Appearance remains local to the app.

Build from the repository root:

```sh
just build
# Or: just build --release
```

This builds the CLI and shell and stages the complete app beside the executable. On macOS it stages `Maka.app` beside `maka` instead: the shell in `Contents/MacOS`, the app in `Contents/Resources/app`, and an `Info.plist` and icon (from `assets/logo.png`), so the system shows the window as Maka with its icon. `maka desktop` starts the shell in that bundle, so after rebuilding the shell with Cargo alone, run `just build` again to refresh it. `--target TRIPLE` selects another Rust target. Native packages carry `bin/maka`, `bin/maka-desktop-shell` and `bin/app/` (plus Windows executable suffixes and its service helper); the macOS package carries `bin/maka` and `bin/Maka.app/`. The packaged shell started without arguments finds its app beside it, or inside its bundle on macOS, including when launched from another working directory.

Use the owned launcher:

```sh
/absolute/path/to/maka desktop --root /absolute/path/to/business-host
```

`--root` is required and names the actual business Host Root. The existing local connection path initializes a missing Root with the standard read-only business Host or reopens its saved deployment. The launcher verifies discovery against the connected Host endpoint, source and epoch, then supplies `MAKA_HOST_ENDPOINT` and `MAKA_HOST_EPOCH` to the child. It holds its own Host client while the shell runs. Child exit or launch failure settles that client; quitting requests idle shutdown while other connected clients retain the Host. Cancellation stops only this launcher's child.

For direct authoring, keep an existing Host available and supply its endpoint (and, when known, epoch). The shell retains its normal commands:

```sh
export MAKA_HOST_ENDPOINT=/path/to/host.sock
export MAKA_HOST_EPOCH=UUID
target/debug/maka-desktop-shell run --dir products/maka/desktop-shell/app
target/debug/maka-desktop-shell dev --dir products/maka/desktop-shell/app
target/debug/maka-desktop-shell check --dir products/maka/desktop-shell/app
```

`dev` reloads the source app; Host-backed actions require the same connection environment. `check` loads the application description and reports diagnostics. `--help` and `--version` answer without opening a window or starting a Host.
