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

# `@maka-agent/cli`

[简体中文](README.zh-CN.md)

```sh
# Stable release (once published on @latest):
npm install --global @maka-agent/cli
# Developer nightly build (unofficial, NOT an ASF release):
npm install --global @maka-agent/cli@nightly
# Alias package:
npm install --global maka-agent@nightly
```

`@maka-agent/cli` is a thin platform launcher: it resolves an exact-version optional native dependency (`darwin-arm64`, `linux-x64-gnu`, `linux-arm64-gnu`, or `win32-x64`) and forwards arguments, stdio, and exit codes to the Rust `maka` executable (plus `Maka.app` on macOS or `maka-desktop-shell` on Linux/Windows). WSL uses the Linux binary alongside a matching Windows helper for Computer Use.

Official Apache Software Foundation releases are the signed source archives at [maka.apache.org/en/downloads](https://maka.apache.org/en/downloads/); pre-built npm packages are convenience binaries. Nightly builds on `@nightly` are unofficial developer previews not approved by an ASF release vote.

## Usage

- `maka` / `maka terminal-shell` — Open the NSH terminal workbench against `~/.maka/application/host` (override with `--root <path>` or `--session <id>`).
- `maka desktop --root <path>` — Open the native desktop window against the given State Root; closing the window detaches while accepted Host runs finish in the background.
- For a Windows shortcut with a custom State Root, target `maka-desktop-shell.exe --root "C:\path to\root"` to start directly without a console window.
- `maka update` — Check for and apply updates on this build's release channel.
- `maka --help` — List Host daemon (`host`), deployment (`application`), `code`, `checkpoint`, `inspect`, `sandbox`, and `acp` subcommands.

See [products/maka](../../products/maka/README.md) for shell architecture and [products/maka/bundle](../../products/maka/bundle/README.md) for deployment composition.

## Packaging and releases

Release and nightly binaries, installers, and npm packages are built and published via [`.github/workflows/release.yml`](../../.github/workflows/release.yml), [`.github/workflows/nightly.yml`](../../.github/workflows/nightly.yml), and [`scripts/rust/package-nightly.mjs`](../../scripts/rust/package-nightly.mjs). See [scripts/rust](../../scripts/rust/README.md) for V8 prebuilts and license notices, and [.github/ASF_SOURCE_RELEASE.md](../../.github/ASF_SOURCE_RELEASE.md) for ASF source release verification.
