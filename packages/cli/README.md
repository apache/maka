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

**The `rust-preview` distribution is an independent, experimental preview. It is not an official Apache Software Foundation release and is not approved, endorsed or supported by the ASF.**

```sh
npm install --global @maka-agent/cli@rust-preview
```

`@maka-agent/cli` is a thin platform launcher: it resolves an exact-version optional native dependency (`darwin-arm64`, `linux-x64-gnu`, or `win32-x64`) and forwards arguments, stdio, and exit codes to the Rust `maka` executable (plus `Maka.app` on macOS or `maka-desktop-shell` on Linux/Windows). WSL uses the Linux binary alongside a matching Windows helper for Computer Use.

The `latest` tags remain empty placeholders, including the separate `maka-agent` package. They contain no CLI, runtime, dependencies or install scripts. Placeholder source lives in [`placeholder/`](placeholder/README.md); preview builds publish exclusively under `rust-preview`.

## Usage

- `maka` / `maka terminal-shell` — Open the NSH terminal workbench against `~/.maka/application/host` (override with `--root <path>` or `--session <id>`).
- `maka desktop --root <path>` — Open the native desktop window against the given State Root; closing the window detaches while accepted Host runs finish in the background.
- `maka --help` — List Host daemon (`host`), deployment (`application`), `code`, `checkpoint`, `inspect`, `sandbox`, and `acp` subcommands.

See [products/maka](../../products/maka/README.md) for shell architecture and [products/maka/bundle](../../products/maka/bundle/README.md) for deployment composition.

## Building and publishing previews

Export a verified source archive from a committed Git revision (`just source <version>`), build all three platform packages from that exact tarball, then stage, verify, and publish:

```sh
just package <source.tar.gz> <target> <build-id> native-preview

just release-prepare native-preview
just release-check native-preview
just publish native-preview
```

`release-check` installs and smoke-tests the staged tarballs offline on each target OS. Native platform packages upload before the launcher, and interrupted runs retry the same staged artifacts under a single publisher.

Unofficial `rust-preview` npm publishing runs only from `M4n5ter/maka-agent` (`npm-rust-preview` environment, explicit `publish=true`), never from the `apache/maka` repository. See [scripts/rust](../../scripts/rust/README.md) for V8 prebuilts and license notices, and [.github/ASF_SOURCE_RELEASE.md](../../.github/ASF_SOURCE_RELEASE.md) for ASF source release verification.
