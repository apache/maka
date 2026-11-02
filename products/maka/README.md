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

Run `just run` from the repository root. Development build and check recipes depend on `just setup`, which reuses the installed JavaScript dependencies while their lockfile, workspace manifests and patches remain unchanged. Cargo compiles the selected plugins and shared workbench and embeds them in the CLI, in both debug and release builds. Rebuild after editing those sources; a separate product build is unnecessary.

Build the CLI, desktop shell and Python worker with `just build` (`--release` and `--target` are supported). `--release` builds for the local system; explicit Linux release targets use Zig and the distribution’s glibc floor. Add `--timings` to record Cargo build timings. Both build and run honor Cargo’s configured artifact directory, including `CARGO_TARGET_DIR`; on macOS the shell is staged in `Maka.app`. Run `target/debug/maka desktop` to initialize or reopen the business Host at `~/.maka/application/host` and launch the desktop from any working directory; `--root HOST_ROOT` selects another Root. The launcher verifies its endpoint and epoch and retains its own client until the child exits; then it detaches, and the Host finishes the work it accepted.

In the terminal interface, choose the shared language under **Settings → Appearance → Language**. It saves automatically in the business Root, separately from each terminal interface’s theme and custom colors. Other open terminal interfaces refresh their language when revisiting settings or using an explicit refresh; saving does not broadcast continuous updates. Previous per-interface language choices must be selected once again; appearance data is retained.

This preference also selects builtin Agent instructions for new work in existing conversations and WorkHub. Already accepted work retains its language; user content and custom instructions remain unchanged.

Bundled packages are installation inputs. Reopening an existing installation uses its committed source and package bytes; rebuilding the checkout does not overwrite a user's composition.
