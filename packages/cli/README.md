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

# Maka npm launcher

[简体中文](README.zh-CN.md)

**The `rust-preview` distribution is an independent, experimental preview. It is not an official Apache Software Foundation release and is not approved, endorsed or supported by the ASF.**

```sh
npm install --global @maka-agent/cli@rust-preview
```

The launcher selects the matching native executable and forwards arguments, standard I/O and exit status. Exact-version optional dependencies carry the CLI, which includes `maka terminal-shell`, and the desktop shell. On macOS the desktop shell is inside `Maka.app`; other platforms carry `maka-desktop-shell`. The preview targets macOS arm64, Linux x64 with glibc, and Windows x64. WSL uses the Linux executable with a matching Windows helper for Computer Use.

The `latest` tags remain empty placeholders, including the separate `maka-agent` package. They contain no CLI, runtime, dependencies or install scripts. The placeholder source lives in [placeholder](placeholder/README.md); preview artifacts must stay on `rust-preview`.

Run `maka` to open the NSH terminal workbench. It discovers or starts the Host at `~/.maka/application/host`; use `--root HOST_ROOT` to select another Host and `--session SESSION_ID` to open an existing conversation. `maka --help` lists automation commands. See [the product guide](../../products/maka/bundle/README.md) for composition and installation commands.

Launch the desktop with `maka desktop --root HOST_ROOT`. This required path selects the business Host: a missing Root gets the standard read-only Host, and an existing Root reopens its saved deployment. The launcher keeps its verified Host client until the shell exits, then detaches: the Host finishes the work it accepted and stops once no client is left. See [desktop-shell](../../products/maka/desktop-shell/README.md) for the desktop's layout and lifecycle.

Launch the NSH terminal workbench with `maka terminal-shell`. It discovers or starts the Host at `~/.maka/application/host`; use `--root HOST_ROOT` for another Root or `--session SESSION_ID` for an existing conversation. `maka terminal-shell --help` lists its options. See [terminal-shell](../../products/maka/terminal-shell/README.md) for source builds.

## Build and publish

Create a source candidate from a committed revision with `just source <version>`. Build each native target from that same archive:

```sh
just package <source.tar.gz> <target> <build-id> native-preview
```

Collect all three native packages and receipts, plus the source archive and SHA-512 sidecar. Then run:

```sh
just release-prepare native-preview
just release-check native-preview
just publish native-preview
```

`release-check` installs and exercises the prepared artifacts offline; run it on each target platform. Publication uploads native components before the launcher and verifies the channel tags. Retry the same artifacts after interruption. Use one publisher per channel because npm tags have no conditional update operation.

The [publication workflow](../../.github/workflows/npm-publication.yml) can build and verify with `publish=false`. Unofficial publishing runs in `M4n5ter/maka-agent` on `feat/runtime-host-rust`, requires explicit `publish=true`, and uses its dedicated `npm-rust-preview` environment. It does not publish from the ASF repository.

See [native build tooling](../../scripts/rust/README.md) for dependencies, V8 caching and notices, and [source releases](../../.github/ASF_SOURCE_RELEASE.md) for archive verification and signing.
