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

Browser providers include explicitly configured CDP endpoints for existing profiles and connected Extension browser providers. Use `cua.listBrowsers()` to discover their full IDs, then `cua.getBrowser({id})` to select one. Exact provider IDs take precedence. Only without an exact match do the `maka` and `chatgpt` shortcuts select one current Extension endpoint; multiple endpoints require its full ID. Direct CDP profiles retain their configured IDs. Missing providers do not restart a browser or enable remote debugging; native browser-window control remains available through `getApp`.

Set up the Maka or ChatGPT Extension provider with a `native-desktop` Maka build on Google Chrome's OS and under the same user. Setup registers Chrome's current-user extension host; it is not forwarded by the WSL Windows bridge. On Linux and macOS, Chrome's default user configuration directory must already exist. Registration also writes installation metadata next to the selected Maka executable, so those paths must be writable.

For Maka, export the bundled Chrome connector source to an absolute empty directory under an existing parent:

```sh
maka browser extension --output /absolute/path/maka-browser-extension
```

Load and enable that directory through Chrome's extension UI, then register its actual extension ID:

```sh
maka browser install --provider maka --extension-id ACTUAL_MAKA_EXTENSION_ID
```

To use an already installed ChatGPT extension, select its adapter explicitly instead:

```sh
maka browser install --provider chatgpt --extension-id ACTUAL_CHATGPT_EXTENSION_ID
```

These are alternative registration selections for an executable. Host installation refuses conflicting registrations. Re-export refuses to overwrite modified extension source. Setup does not install extensions, change browser policies or grant site access. Remove the matching extension-host registration with `maka browser uninstall --provider maka` for Maka or `maka browser uninstall --provider chatgpt` for ChatGPT; removal does not uninstall the extension or delete exported source.

Extension providers expose `browser.user` for user-tab discovery and claiming. The [API reference](src/api.md) covers its permission rules, the `tab.ax` facade, Playwright, clipboard and downloads. Host `browserPreparation` defaults to `popup: false` and `requestHeaders: []`; nonempty headers also enable effective popup adoption/relay. These controls grant no site access and do not prove ChatGPT page hooks are off. See the [typed configuration](../../plugins/workspace/api/src/computer.rs).

Customize the Maka connector through [facade.js](src/facade.js), typed commands in [protocol.rs](src/protocol.rs) and dispatch in [browser.rs](src/browser.rs). ChatGPT and stock OpenCLI integration is best effort. OpenCLI selection can fall back to one available provider before creating or claiming a tab; exact IDs and existing handles remain bound to their provider.

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

Sessions own temporary tabs. At turn end, unmarked tabs close; `markDeliverable()` keeps a tab for the user, and `markHandoff()` preserves it for a later turn. Reusing a retained tab requires current authorization. Reset and disconnect request cleanup while preserving retention marks. Navigation and window changes can invalidate observations. Uncertain input is never replayed automatically.

Native Computer Use requires an interactive desktop; Linux native methods require X11. On Windows, screenshot IDs select image coordinates; omitting the ID uses the window's logical viewport. Browser uploads accept authorized regular files; directory uploads and child-frame choosers are unsupported. Files still selected when the browser host exits are not reclaimed automatically.
