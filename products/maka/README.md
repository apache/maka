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

# Maka product

[简体中文](README.zh-CN.md)

This directory turns reusable plugins and platform owners into the Maka application.

| Directory | Role |
| --- | --- |
| [bundle](bundle/README.md) | Select packages and author Host/UI compositions |
| [native](native/README.md) | Select compiled Host factories |
| [cli](cli/README.md) | Start the terminal product and expose CLI commands |
| [desktop-shell](desktop-shell/README.md) | Run the workbench in a desktop window against public Host services |
| [acp](acp/README.md) | Serve editor clients over ACP |

Run `just run` from the repository root. It builds the TypeScript product first, then starts Cargo. Development binaries read the bundle from disk, so a TypeScript-only edit does not invalidate Rust compilation. Release binaries embed the same bundle.

Build the CLI and desktop shell with `just build` (`--release` and `--target` are supported); on macOS the shell is staged in `Maka.app`. Run `target/debug/maka desktop --root HOST_ROOT` to initialize or reopen a business Host and launch the desktop from any working directory. The launcher verifies its endpoint and epoch and retains its own client until the child exits; then it detaches, and the Host finishes the work it accepted.

In the terminal interface, choose the shared language under **Settings → Appearance → Language**. It saves automatically in the business Root, separately from each terminal interface’s theme and custom colors. Other open terminal interfaces refresh their language when revisiting settings or using an explicit refresh; saving does not broadcast continuous updates. Previous per-interface language choices must be selected once again; appearance data is retained.

This preference also selects builtin Agent instructions for new work in existing conversations and WorkHub. Already accepted work retains its language; user content and custom instructions remain unchanged.

Bundled packages are installation inputs. Reopening an existing installation uses its committed source and package bytes; rebuilding the checkout does not overwrite a user's composition.

On macOS or Linux, measure concurrent agents with `cargo test --release -p maka-agent-native --lib --no-run`, then pass the printed test executable to `python3 scripts/agent-scale.py --binary PATH`. The default runs five trials each at 10, 100 and 1000 agents through the actual Host, native owner and shared model SDK. A local HTTP fixture holds every request open before streaming; the benchmark verifies durable output, cancellation, socket cleanup and recovery. The JSON report retains all samples, foreground query latency, CPU and peak memory. Run without competing builds; these measurements exclude TUI rendering and external model latency.
