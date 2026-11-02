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

<h1 align="center"><img src="assets/logo.png" alt="Maka" width="72" /> Apache Maka (Incubating)</h1>

[简体中文](README.zh-CN.md)

Apache Maka (Incubating) is a high-performance agent workspace that keeps a complete record of everything it did.

Maka provides a terminal workbench and a native desktop shell. A Runtime Host owns execution, permissions and durable state. Model providers, tools and business capabilities use public plugin interfaces.

## Run from source

Install Rust stable, Node.js 26, npm 12.2.1 and [just](https://github.com/casey/just). Native Computer Use additionally needs Xcode Command Line Tools on macOS or the X11 development libraries on Linux.

```sh
git clone https://github.com/apache/maka.git
cd maka
just setup
just run
```

`just run` opens the [NSH terminal workbench](products/maka/terminal-shell/README.md), the default `maka` interface. It discovers or starts the Host at `~/.maka/application/host`; `--root PATH` selects another Host and `--session ID` opens an existing conversation. Use `just run --help` for CLI commands. `just build --release` produces `target/release/maka` and `maka-desktop-shell` (executables use `.exe` on Windows; on macOS the desktop shell is staged in `Maka.app`). The build entry supports `--release` and `--target`. Model protocols run in Rust. Node.js bundles the authored product; the CLI runs plugin and Code Mode JavaScript in V8. The desktop shell runs the same NSH workbench as the terminal, in a window. Product authoring and installation are described in [the product guide](products/maka/bundle/README.md).

In WSL, `just run` builds the CLI without the local `native-desktop` capability or its Linux X11 dependencies; Computer Use selects the Windows desktop by default. Source builds need `MAKA_CUA_WINDOWS_EXECUTABLE` set to the absolute WSL-visible path of a matching Windows `maka.exe`. `MAKA_CUA_BUILD_MODE=auto|native|bridge` controls this development build selection. See [Computer Use](platform/computer-use/README.md) for setup. `just build` and release packaging still build the full native product, including the desktop shell and its Linux GUI dependencies.

Launch the desktop with `target/release/maka desktop`, using `~/.maka/application/host` by default; `--root HOST_ROOT` selects another business Host Root. The launcher initializes or reopens that Host and keeps its client alive while the shell runs; closing the window detaches, and the Host finishes the work it accepted. See [desktop-shell](products/maka/desktop-shell/README.md) for the packaged layout.

## Repository

| Directory | Purpose |
| --- | --- |
| [platform/](platform/README.md) | Application kernel, Host/UI owners, JavaScript execution adapters and native renderers |
| [plugins/](plugins/README.md) | Authored plugin declarations, business implementations and shared domain contracts |
| [products/maka/](products/maka/README.md) | Native factory selection, product composition, CLI and desktop entry points |
| `tools/schema/` | Contract/schema export without building the product |
| `packages/plugin-sdk/` | Generated Host, component and native presentation contracts for JavaScript plugins |
| `packages/cli/` | npm launcher for platform-specific Rust executables |
| `scripts/rust/` | Native packaging and source-bound npm distribution |
| `website/` | Independently built project website |

Use `just --list` for development commands. See [Contributing](CONTRIBUTING.md), [Architecture](ARCHITECTURE.md) and [Security](SECURITY.md).

## Distribution

The npm launcher selects a matching native package; it contains no agent runtime. Native preview artifacts are built and verified from one source archive. Packaging and publication are documented in [packages/cli](packages/cli/README.md).

Apache Maka is undergoing incubation at the Apache Software Foundation. See [DISCLAIMER](DISCLAIMER), [LICENSE](LICENSE) and [NOTICE](NOTICE).
