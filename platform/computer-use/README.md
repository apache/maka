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

# Computer Use

[简体中文](README.zh-CN.md)

Provides Maka's native app and browser API through an independent JavaScript REPL. `cua_repl` and `cua_reset` work with Code Mode disabled. The pinned Cua driver is selected in the [workspace manifest](../../Cargo.toml); the object API is documented in [src/api.md](src/api.md).

A Session owns its REPL variables, target bindings and observations. The Host owns permission checks and the native driver. Each operation uses current authority; keeping a JavaScript object does not keep a grant. The REPL has no ambient Node, filesystem or arbitrary network API.

Native embedders pass a trusted `InvocationContext` to `Session::invoke`. HTTP(S) page reads and input require its `BrowserAuthorization`; navigation checks the destination. A raw Session without that callback refuses protected site access. The callback belongs to the Host's actual invocation and grant system, and cannot be supplied by REPL commands.

For a fresh REPL, select an entrypoint and read its emitted state before acting:

```js
const app = await cua.getApp("Calculator");
```

Subsequent calls use indices from that observation. `cua.getState()` lists available surfaces. App and tab observations emit automatically. The bundled [maka-cua skill](skills/maka-cua/SKILL.md) explains target selection, screenshots and input.

## Desktop and browser configuration

The `desktop` setting defaults to `auto`: the Windows host in WSL, otherwise the local desktop. `local` selects Linux inside WSL; `windows` requires the Windows helper. Native releases prepare their matching Windows helper through the verified distribution cache. WSL interoperability and an interactive Windows desktop are required.

Browser providers are explicitly configured CDP connections to existing profiles. When no provider is configured, use a native browser window. Configuration and platform-specific methods are described by the API reference; a missing provider does not trigger a browser restart or enable debugging.

Computer output recording requires the explicit Host configuration `audio: true`, which defaults to false. It adds `cua.computer.start_audio_recording`, `stop_audio_recording` and `nodeRepl.emitAudio`; recordings capture output audio and never select a microphone. macOS also requires separate audio Session consent. Reset and Session cleanup discard owned recordings.

## Native and WSL development builds

The CLI enables the `native-desktop` Cargo feature by default. It includes the local driver and cursor renderer for Linux, macOS or Windows. Native dependencies require Xcode Command Line Tools on macOS and X11 development libraries on Linux.

`just run` automatically omits this feature in WSL, keeping the Windows bridge without compiling the Linux desktop driver. Set `MAKA_CUA_BUILD_MODE` to `auto` (the default), `native` or `bridge` to select the development build explicitly. For example, `MAKA_CUA_BUILD_MODE=native just run` includes the Linux driver in WSL. The runtime `desktop` setting still selects the destination; a bridge build rejects `local`, and `auto` requires WSL to select Windows.

Source builds need a Windows `maka.exe` built from the same source with its default native features. Build it on Windows and provide its absolute path as visible from WSL:

```sh
MAKA_CUA_WINDOWS_EXECUTABLE=/mnt/c/path/to/maka.exe just run
```

Plain `cargo run -p maka-cli` retains the native default. To build the bridge directly, use `cargo run --locked -p maka-cli --no-default-features -- ...`. Cargo features combine across selected packages, so another selected package enabling `native-desktop` restores native dependencies. `just build` and release packaging retain the full native product; the Linux desktop shell separately requires Linux GUI development libraries.

## Lifetime

Sessions own their temporary tabs; turn completion closes the tabs held by that turn. Other Sessions cannot list or acquire them. Reset clears this Session's bindings and closes its temporary tabs, preserving user apps and preexisting tabs. Navigation, window changes and fresh observations can invalidate previous input targets. Cancellation or timeout requires a reset; an uncertain action is never replayed automatically. Shutdown waits for accepted native work to settle.

Verify input and capture behavior on the target desktop; a REPL unit test cannot establish native focus or accessibility behavior.
