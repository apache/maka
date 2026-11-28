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

## Windows clipboard history

With Clipboard History and the quick launcher enabled, type `cb` to search recent text, images, PDFs and file lists. Select a result to copy it again. History stays in memory and skips items marked private by their source. Use the tool settings to change the entry limit or clear the list.

## Proactive discovery

Open **Discovery** in the sidebar or **Proactive discovery** in the Bot header, then select **Plans**. Leave the direction blank for broad exploration, or enter a topic for focused checks. New interval plans wait 30 minutes after each run finishes. The editor also offers a fixed interval, manual checks, and pause or resume controls.

Choose **Read-only tools** or **Standard Session tools** and review the exact names under **Show selected tools**. Both profiles read the original workspace. Short drafts and replies appear in the dossier summary. A worker can attach one standalone file when it will remain useful. Open the dossier thread to act on a finding or prepare a code change.

After onboarding, a broad timer looks for file changes, updated conversations and mapped sources due for review. With `SessionRead` approved, an idle root chat or Room qualifies after five quiet minutes. For the Bot, only human input counts. **Check now** can pick up an idle conversation immediately. An idle timer advances without a model call. A targeted watch can also start a follow-up. Automatic checks, including subscribed briefings, run at least two hours apart at 50% of the plan’s daily weighted token budget and at least four hours apart at 80%. At 100% they resume at UTC midnight. Manual checks and onboarding can run at any level and still count toward usage. Tell the Bot or a dossier thread which topics to skip or revisit. Discovery saves these instructions locally in `discovery/preferences.md`.

Open **Discovery → Runs** to inspect an active or recent probe and its recorded work. Select and quote text from a Bot reply to attach feedback to its investigation. [Dossier view](../../docs/images/discovery/dossiers.png) · [Plan controls](../../docs/images/discovery/plans.png) · [Run history](../../docs/images/discovery/runs.png)

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

## Computer Stage

The conversation shows live cards for the admitted Computer targets. Drag the front card to a corner, select a rear card to promote it, or Pin/Follow the target. The front card presents the original bound native window or browser window for OS interaction. Clicking exposed Maka content brings Maka forward while the card stays in its corner. Hide/Show controls the viewer without stopping the producer.

Preview remains read-only, bounded and temporary. Presentation is a separate client mutation; the UI does not forward screenshot coordinates, synthesize keyboard input or choose a PID/window/tab.
