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

`maka-computer-use` drives native desktop applications and browser tabs through a dedicated, session-scoped JavaScript REPL (`cua_repl` and `cua_reset`), independent of Code Mode. See [`locales/docs/api.en.md`](locales/docs/api.en.md) for the guest object reference and [`skills/maka-cua/SKILL.md`](skills/maka-cua/SKILL.md) for usage patterns.

Each Agent session owns its REPL bindings and latest accessibility/screenshot observations, while the Host enforces live permission grants on every call. Holding a JavaScript handle across turns never bypasses current Host authorization, and the REPL exposes no ambient Node, filesystem, or network globals.

```js
const state = await cua.getState();
const app = await cua.getApp("Calculator");
```

## Browser connectors

Browser control supports configured CDP endpoints as well as Chrome/Chromium extension connectors (`cua.listBrowsers()`, `cua.getBrowser({ id })`):

- **Automatic ChatGPT connector handoff** — When the ChatGPT Chrome/Chromium extension is already installed on the host OS, Maka discovers it automatically (preferring Chrome) and leases the native-messaging channel on demand, restoring the original native host once the session releases the browser (`await browser.release()` or turn/session close). To explicitly pin an extension ID or target Chromium, run `maka browser install --provider chatgpt --extension-id <EXTENSION_ID> --on-demand [--browser chromium]`; run `maka browser restore` if an abnormal crash ever leaves a lease behind.
- **Bundled Maka Chrome extension** — Export the extension source to an empty directory, load it unpacked in Google Chrome, then register its extension ID:

```sh
maka browser extension --output /absolute/path/maka-browser-extension
maka browser install --provider maka --extension-id <EXTENSION_ID>
```

Use `maka browser uninstall --provider maka|chatgpt` to remove native-host registration.

Temporary tabs opened by a session close at turn end unless marked with `markDeliverable()` (keep open for the user) or `markHandoff()` (retain for subsequent turns).

## Native desktop and WSL builds

Native desktop control uses the `native-desktop` Cargo feature (enabled by default in `maka-cli`), requiring Xcode Command Line Tools on macOS or X11 development libraries on Linux.

Inside WSL, `just run` omits `native-desktop` and bridges Computer Use to the Windows host desktop by default (`MAKA_CUA_BUILD_MODE=auto|native|bridge`). When running from source in WSL, point `MAKA_CUA_WINDOWS_EXECUTABLE` to a matching Windows `maka.exe`:

```sh
MAKA_CUA_WINDOWS_EXECUTABLE=/mnt/c/path/to/maka.exe just run
```

Optional output-audio capture (`cua.computer.start_audio_recording` / `stop_audio_recording`) defaults to off and requires `audio: true` in Host configuration (never captures microphone input).

## Computer Stage

`SessionOwner::preview()` exposes an independent, bounded registry of actual bound app/tab targets. Preview JPEGs are latest-only, limited to 1600 pixels per edge and 2 MiB, and never enter canonical model output automatically. Retained bytes must match the current source revision and pass `authorize()` at delivery; native owner/window and browser document/claim identities are rechecked. Retiring an epoch prevents late publication and old pixels or capabilities from returning.

The Host supplies read-only `PreviewAuthority` for the original producer execution and permission basis. Presenting a front card uses a separate client mutation and `ForegroundAuthority`, with its own work/effect custody. Windows targets retain the accepted native child source and complete owner/application stamp; metadata-only calls cannot supply a presentation source. Viewer cancellation preserves the shared target, while Stop, reset, permission and execution changes retire the applicable capabilities.
