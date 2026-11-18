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

# Maka Product

[简体中文](README.zh-CN.md)

`products/maka/` wires [platform](../../platform/README.md) runtimes and [plugins](../../plugins/README.md) into the shipped `maka` CLI, ACP server, and terminal/desktop workbench executables.

| Directory | Crate / Package | Role |
| --- | --- | --- |
| [`bundle/`](bundle/README.md) | `@maka-agent/product` | Selects built-in plugin packages and authors the default Host + UI composition |
| [`native/`](native/src/lib.rs) | `maka-product-native` | Registers compiled Rust `HostService` factories available to deployments |
| [`client/`](client/src/lib.rs) | `maka-app-client` | Typed Rust client helpers over public Host services |
| [`workbench/`](workbench/package.ts) | `maka-workbench` | Shared TSX/NSH UI package (`app/App.tsx`) and native NSH host bindings (`src/bindings.rs`) |
| [`terminal-shell/`](terminal-shell/src/lib.rs) | `maka-terminal-shell` | Runs the NSH workbench inside the terminal (Unicode cell grid or terminal graphics) |
| [`desktop-shell/`](desktop-shell/src/main.rs) | `maka-desktop-shell` | Runs the same NSH workbench in a native OS window (AppKit on macOS, Direct2D on Windows, GTK on Linux) |
| [`acp/`](acp/src/lib.rs) | `maka-acp` | Exposes Maka sessions to external editors and clients over the Agent Client Protocol |
| [`cli/`](cli/src/main.rs) | `maka-cli` | Builds the `maka` binary: terminal entry, Host daemon (`host serve`), `desktop` launcher, `acp`, `sandbox`, `browser`, and `application` commands |

## Proactive discovery

Open **Proactive discovery** in the Bot header. Leave the direction blank for broad exploration, or enter a topic for focused checks. New interval plans wait 30 minutes after each run finishes. The editor also offers a fixed interval, manual checks, and pause or resume controls.

Choose **Read-only tools** or **Standard Session tools** as a preset. Adjust file reads, history, writes, terminal commands, and web access as needed, then approve them together. **View tool details** lists the concrete tools. The worker stays within the approved workspace and network permissions.

**Files to exclude** starts empty. Add a folder, file, or suffix to protect it from future investigations and automatic follow-ups. The Host applies these rules to file access. On Linux and Windows, a suffix rule makes terminal commands unavailable during investigations. Access to copies in conversation history follows the history permission.

Use **View investigation** to open the original worker conversation. Select and quote text from a Bot reply to attach feedback to its investigation.

## Running and testing

From the repository root:

```sh
just setup
just run                      # Launch terminal workbench (~/.maka/application/host)
just build --release          # Build maka + maka-desktop-shell (stages Maka.app on macOS)
target/release/maka desktop   # Open native desktop window
```

Both debug and release `maka-cli` builds compile and embed the current plugin bundle and NSH workbench automatically. Vendored NSH crates live in [`third-party/nsh`](../../third-party/nsh/SOURCE.md) and build inline with Cargo.

Targeted verification commands:

```sh
# Workbench UI and Rust binding tests
node --test products/maka/workbench/tests/*.test.mjs
cargo nextest run -p maka-workbench

# Terminal CLI entrypoint checks
cargo nextest run -p maka-cli --no-default-features --test integration -E 'test(terminal_shell::)'

# Offscreen native desktop integration tests (macOS / Windows, or `just test-desktop`)
cargo nextest run --locked -p maka-cli --no-default-features --features desktop-tests --test native-desktop -E 'test(terminal::desktop_new_session::)'
```
