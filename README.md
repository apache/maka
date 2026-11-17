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

Apache Maka (Incubating) is a local-first agent workspace for the terminal and desktop. A background Rust Runtime Host owns model execution, sandboxing, permissions, and SQLite state, keeping an auditable record of every run, approval, and tool receipt.

## Quick start

Prerequisites: Rust stable, Node.js 24+ (CI uses 26), npm, and [just](https://github.com/casey/just). Native Computer Use also requires Xcode Command Line Tools on macOS or X11 development libraries on Linux.

```sh
git clone https://github.com/apache/maka.git
cd maka
just setup
just run
```

`just run` launches the terminal workbench and connects to (or starts) the local Host at `~/.maka/application/host`. Pass `--root <path>` to use a different State Root, `--session <id>` to open an existing conversation, or `--help` to inspect CLI subcommands.

To build release binaries for both the CLI and the native desktop window:

```sh
just build --release
target/release/maka desktop
```

On macOS, `just build` stages `Maka.app` alongside `maka`; on Windows, binaries carry `.exe`. Both the terminal and desktop shells run the same NSH workbench UI against the same Host process—closing the window detaches the UI while in-flight work finishes in the background.

In WSL, `just run` skips the Linux `native-desktop` feature and bridges Computer Use to the Windows desktop by default. Point `MAKA_CUA_WINDOWS_EXECUTABLE` to a matching Windows `maka.exe` when running from source; see [Computer Use](platform/computer-use/README.md).

## Repository layout

| Directory | Role |
| --- | --- |
| [platform/](platform/README.md) | Plugin kernel, SQLite event log, Host runtime, V8/Python sandboxes, OS isolation, and Computer Use |
| [plugins/](plugins/README.md) | Agent runtime, workspace tools, skills, settings, interactions, and shared domain contracts |
| [products/maka/](products/maka/README.md) | Product composition, NSH workbench, CLI, ACP server, and terminal/desktop shells |
| [products/eval/](products/eval/README.md) | Containerized Harbor evaluation runner against the native Host |
| [packages/plugin-sdk/](packages/plugin-sdk/README.md) | Generated TypeScript contracts and helpers for Host and NSH UI plugins |
| [packages/cli/](packages/cli/README.md) | `@maka-agent/cli` npm launcher for platform-native binaries |
| [scripts/rust/](scripts/rust/README.md) | Native packaging, V8 prebuilt management, license checks, and CI suite runner |
| `website/` | Project website (independent package manifest and lockfile) |

Run `just --list` to see common development recipes. Further reading: [Architecture](ARCHITECTURE.md), [UI Design](DESIGN.md), [Contributing](CONTRIBUTING.md), and [Security](SECURITY.md).

## Distribution

`@maka-agent/cli` is a thin npm wrapper that dispatches to a platform-specific native binary package built from a single verified source archive; see [packages/cli](packages/cli/README.md).

Apache Maka is an effort undergoing incubation at The Apache Software Foundation (ASF). See [DISCLAIMER](DISCLAIMER), [LICENSE](LICENSE), and [NOTICE](NOTICE).
