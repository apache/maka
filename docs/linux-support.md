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

# Linux support baseline

Linux is not a supported Maka Desktop release tier yet. The repository can be built and tested from
source on Linux, and Runtime has a bubblewrap-backed sandbox path for managed restricted execution.
The README still describes Linux Desktop as "not supported yet"; do not present Linux as released
until packaged Desktop artifacts, installer/update verification, Computer Use support, and platform
evidence are complete.

## Installation status

There are no verified Linux Desktop packages in this repository today. Do not publish or document
AppImage, `.deb`, or `.rpm` install steps as supported until the packaging scripts, release assets,
checksums, update path, and smoke tests exist.

Use source-based development setup for now:

```sh
git clone https://github.com/apache/maka.git
cd maka
npm ci
npm run build
npm run dev
```

Direct Peer and Peer Mesh development additionally requires Rust stable 1.98 or newer and the
platform linker:

```sh
npm run dev:peer       # HMR
npm run dev:full:peer  # full build
```

Runtime Host can run as a persistent Linux service from an installed CLI. See
[Connect to a remote Runtime Host](./runtime-host-remote-access.md) for the systemd user-service
setup, credential flow, and project-root policy.

## Runtime sandbox requirements

Restricted managed profiles on Linux use the bubblewrap backend. The backend fails closed when it
cannot prove that bubblewrap and the required namespace/seccomp support are available.

Linux machines used for managed restricted execution need:

- Node.js 22.19 or newer; CI currently standardizes on Node.js 24;
- npm 11 and the committed lockfile;
- Git;
- `ripgrep` on `PATH` for Runtime's `Grep` tool;
- `bubblewrap` available as `/usr/bin/bwrap` unless the caller supplies a specific backend path;
- kernel/user-namespace configuration that allows the bubblewrap probe to run;
- a graphical session and Electron-compatible system libraries for Desktop development.

## Reproducible checks

Install and build from a clean checkout:

```sh
npm ci
npm run build
```

Run the complete repository test plan:

```sh
npm test
```

Run focused Runtime sandbox coverage:

```sh
npm --workspace @maka/runtime run test:dist -- linux-sandbox
npm --workspace @maka/runtime run test:dist -- linux-sandbox-smoke
npm --workspace @maka/runtime run test:dist -- filesystem-worker-linux-smoke
```

There is no generated Linux skip inventory equivalent to
[Windows test skip inventory](./windows-test-inventory.md). Existing Linux-specific evidence is
spread across focused Runtime sandbox tests, storage data-root tests, CI Linux display fixture
helpers, and release/eval scripts that require Linux containers or hosts.

## Current capability boundary

- CLI `--help`, `--version`, TUI startup, and non-interactive commands are native Node.js paths.
- Desktop development startup uses the Linux Electron binary when dependencies are installed on a
  Linux host, but no Linux Desktop package is produced or verified by the current release scripts.
- Runtime Host Linux service installation uses systemd user services and requires user lingering for
  persistence after SSH logout.
- Restricted managed Bash and filesystem-worker operations use bubblewrap when a sandbox is
  required; unsupported profiles and missing sandbox capability fail closed instead of retrying on
  the host.
- PTY execution is refused when the active profile requires sandboxing. Unsandboxed PTY execution
  uses the host PTY.
- Computer Use currently has no Linux backend. Cross-platform Computer Use work is tracked in
  [issue #3896](https://github.com/apache/maka/issues/3896) and Linux backend work in
  [issue #3891](https://github.com/apache/maka/issues/3891).
- AppImage, `.deb`, `.rpm`, signed package metadata, package-manager repository integration, and
  automatic update behavior are not verified for Linux.

## Platform considerations

Desktop automation and accessibility evidence cannot be borrowed from macOS or Windows. Linux work
needs explicit coverage for:

- X11 and Wayland window identity, focus, display capture, and input routing;
- desktop-portal and compositor differences under Wayland;
- accessibility tree availability across common desktop environments;
- file permissions, executable bits, symlinks, and XDG config/cache/data roots;
- bubblewrap policy for mounts, working directory, environment, network denial, and seccomp;
- package ownership, permissions, sandbox interaction, and uninstall behavior for each future
  package format.

## Known gaps and workarounds

| Gap | Current status | Workaround |
|---|---|---|
| Desktop release package | No verified AppImage, `.deb`, or `.rpm` exists. | Build and run from source. |
| Automatic updates | No Linux package/update lane is defined. | Pull the repository and rebuild from source. |
| Runtime sandbox availability | Requires working bubblewrap, user namespaces, and seccomp support. | Install/enable bubblewrap support or use a less restricted boundary only when the product policy permits it. |
| Computer Use | Linux backend is not implemented; see [#3891](https://github.com/apache/maka/issues/3891). | Do not enable Computer Use on Linux. |
| Cross-platform Computer Use abstraction | Platform abstraction is tracked in [#3896](https://github.com/apache/maka/issues/3896). | Keep platform-specific Computer Use claims out of Linux docs until an adapter and evidence exist. |
| Test inventory | No Linux skip inventory generator exists. | Use the focused tests above and repository-wide `npm test`. |
| X11/Wayland/accessibility evidence | No Linux Desktop automation matrix is documented. | Treat Desktop Linux automation behavior as unverified. |

