---
doc_id: linux-support
title: "Linux support baseline"
language: en
source_language: en
implementation_status: current
document_status: current
translation_status: source-only
last_verified: 2026-10-15
owners:
  - maka-backend
---
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

Linux has a Desktop preview for x64 and arm64, plus CLI/TUI and persistent Runtime Host paths.
The release workflows build unsigned AppImage and Debian packages; they do not build RPM packages.
Native Computer Use is unavailable on Linux. A running Electron window or a passing Xvfb smoke
does not establish Wayland, accessibility, or native input support.

The IPMC-approved source archive is the Apache release. Desktop installers and npm packages are
convenience builds; see the [product release checklist](../.github/RELEASE_CHECKLIST.md) and
[CLI installation guide](../packages/cli/README.md).

## Install the Desktop preview

Download the asset for your architecture from a [Maka GitHub Release](https://github.com/apache/maka/releases).
Keep the version and architecture consistent across the package and any accompanying checksum.
Replace `<version>` in the examples below with the downloaded asset's version.

| Architecture | AppImage | Debian package |
| --- | --- | --- |
| x64 | `Maka-<version>-linux-x86_64.AppImage` | `Maka-<version>-linux-amd64.deb` |
| arm64 | `Maka-<version>-linux-arm64.AppImage` | `Maka-<version>-linux-arm64.deb` |

Formal release verification writes a matching `.sha256` file for each package. When supplied,
verify it from the download directory before installing:

```sh
sha256sum --check Maka-<version>-linux-x86_64.AppImage.sha256
# Or, for the x64 Debian package:
sha256sum --check Maka-<version>-linux-amd64.deb.sha256
```

Require a successful checksum result. The packages are unsigned; a matching checksum checks the
published bytes, not the publisher's identity. Do not assume a nightly asset has the same sidecars
as a formal release.

For an AppImage, replace the example filename with the downloaded asset, make it executable,
and run it as your ordinary desktop user:

```sh
chmod +x Maka-<version>-linux-x86_64.AppImage
./Maka-<version>-linux-x86_64.AppImage
```

If the AppImage runtime cannot mount its image because FUSE is unavailable, extraction avoids
that mount requirement:

```sh
./Maka-<version>-linux-x86_64.AppImage --appimage-extract
./squashfs-root/AppRun
```

For Debian/Ubuntu, install the matching `.deb` through the package manager, then launch Maka from
the desktop application menu:

```sh
sudo apt install ./Maka-<version>-linux-amd64.deb
```

Do not substitute a `dpkg-deb -x` extraction for installation: it does not perform the package's
installation steps, including configuring Electron's sandbox helper. The verification harness
checks the deb payload but deliberately does not launch an extracted deb tree.

After launch, configure a real model connection under **Settings → Models**. Install `ripgrep` for
the Runtime `Grep` tool and `bubblewrap` for the managed Linux sandbox. On Debian/Ubuntu:

```sh
sudo apt install ripgrep bubblewrap
```

## CLI/TUI and Runtime Host

Use Node.js `^22.19.0 || >=24.0.0`; Node 23 is excluded. The npm package is `maka-agent`, and its
public command is `maka`. The complete CLI currently follows the `nightly` tag; inspect the
[CLI guide](../packages/cli/README.md#install) before selecting another release line.

```sh
npm install --global maka-agent@nightly
maka --version
maka --help
cd /path/to/project
maka
```

First-run setup configures model connections. `maka run "Summarize this project"` executes a
non-interactive turn. Linux profile data lives under `$XDG_CONFIG_HOME/Maka`, or `~/.config/Maka`
when `XDG_CONFIG_HOME` is unset. The workspace is `workspaces/default` beneath that profile.
Credentials are local plaintext files protected by the operating-system account and owner-only
permissions; see [SECURITY.md](../SECURITY.md).

On Linux, `maka runtime-host service install` uses **systemd user services** and requires user
lingering. From a persistent global CLI installation:

```sh
maka runtime-host service install \
  --root "$HOME/.maka/runtime-host" \
  --project-root "projects=$HOME/Projects"
maka runtime-host service status --json
```

Use the [remote Host guide](./runtime-host-remote-access.md) for user-service prerequisites,
client credentials, SSH profiles, and experimental direct-peer access. For its one-command
`npx` setup path, select the complete `maka-agent@nightly` package rather than the placeholder
`latest` line. Unlike `service install`, `runtime-host setup` falls back to OpenRC when the
systemd user-service preflight fails: `openrc_system` when run as root, or `openrc_user` otherwise.

Before uninstalling the global package, remove the service installed above with an explicit
expected target. Obtain the values from that installation:

- `<root-path>`: `service.config.rootPath` in `maka runtime-host service status --json`.
- `<root-id>`: `rootId` in `<root-path>/.maka-storage-root.json`.
- `<service-id>`: the ID in the Host unit name `maka-runtime-host-<service-id>.service`, listed by
  `systemctl --user list-unit-files 'maka-runtime-host-*.service'`; do not use the update unit.

Replace the placeholders with those values, then run:

```sh
maka runtime-host service uninstall \
  --expected-service-id '<service-id>' \
  --expected-root-path '<root-path>' \
  --expected-root-id '<root-id>'
```

Only uninstall the global package after service removal succeeds; service removal preserves
workspace data.

## Sandbox and display boundaries

- **Managed command sandbox:** `detectLinuxSandboxCapability()` checks executable
  `/usr/bin/bwrap`, advertised `--seccomp` support, and a real namespace probe. A package being
  installed is insufficient if the host forbids the required namespaces. See
  [the capability probe](../packages/runtime/src/sandbox/linux-capability.ts) and
  [Runtime sandbox ownership](../packages/runtime/src/sandbox/README.md). Do not solve a failed
  probe by disabling the sandbox; diagnose its reported capability failure and host policy.
- **Electron sandbox:** separate from Runtime's bubblewrap boundary. Some CI fixtures use
  `--no-sandbox` because hosted runners cannot configure Electron's SUID helper; those fixture
  flags are not Desktop installation guidance.
- **X11 and Wayland:** Desktop renderer evidence is collected under Xvfb, an X server.
  It does not prove a native Wayland session, compositor-specific behavior, or AT-SPI support.
- **Native Computer Use:** the current [backend selector](../packages/computer-use/src/select-backend.ts)
  enables the pinned `maka-cu` executor only on macOS. Linux returns no native Computer Use tools.
  [#3891](https://github.com/apache/maka/issues/3891) tracks the Linux AT-SPI/X11 backend and
  [#3896](https://github.com/apache/maka/issues/3896) tracks platform abstraction. Installing
  accessibility packages does not activate an unimplemented backend.
- **Eval:** real Harbor/Pier execution is gated on Linux x64 with Node 24. It additionally needs
  Docker, separate framework Python environments, and benchmark paths; an installed CLI alone
  does not supply those dependencies. See [CLI Eval](../packages/cli/README.md#eval).

## Verification inventory

These are the checked-in verification routes, not a claim that every Linux distribution or
desktop session has been tested:

| Route | Evidence and boundary |
| --- | --- |
| [CLI package validation](../.github/workflows/cli-package-validation.yml) | Installed package smoke on Linux x64 / Node 22.19 and 24, and Linux arm64 / Node 24; real Eval on Linux x64 / Node 24 |
| [Desktop nightly](../.github/workflows/desktop-nightly.yml) and [release](../.github/workflows/release.yml) | Native x64 and arm64 packaging and `xvfb-run -a npm run verify:linux` |
| [Linux release verifier](../scripts/verify-linux.mjs) | Opens both payloads, checks resource/dependency closure, peer ELF architecture, deb identity and updater marker, and feed digests; launches the extracted AppImage renderer, not an installed deb |
| [Verifier regression tests](../scripts/verify-linux-harness.test.mjs) | Cross-platform fixture tests for ELF mismatches, package verification, and feed integrity; not a Linux installation smoke |
| [Main CI](../.github/workflows/ci.yml) | Bubblewrap namespace preparation, Runtime Linux sandbox smoke, and selected Desktop E2E under Xvfb |
| [Linux sandbox tests](../packages/runtime/src/__tests__/linux-sandbox.test.ts), [command smoke](../packages/runtime/src/__tests__/linux-sandbox-smoke.test.ts), and [filesystem-worker smoke](../packages/runtime/src/__tests__/filesystem-worker-linux-smoke.test.ts) | Policy coverage plus actual Linux-only execution paths; Linux-only cases cannot establish sandbox behavior when skipped on another OS |

## Develop on Linux

Install a supported Node version, the root `packageManager` version of npm (currently 11.19.0),
Git, and `ripgrep`. Install the system libraries required by Electron on your distribution;
headless renderer tests also need Xvfb. Install dependencies at the repository root:

```sh
git clone https://github.com/apache/maka.git
cd maka
npm ci
npm run dev
```

`npm run dev` builds the workspace libraries and launches Desktop with renderer HMR.
For independent data per checkout, use `npm run dev:worktree`; see
[development profiles](../apps/desktop/README.md#worktree-development-profiles).
Direct Peer/Peer Mesh development additionally needs Rust stable 1.98 or newer and a platform
linker. Released packages already carry their native peer and do not require a Rust toolchain.

For a full build and focused checks:

```sh
npm run build
npm --workspace @maka/runtime run test:dist
node --test scripts/verify-linux-harness.test.mjs
```

Linux packaging must run on the architecture being packaged; the packaging script rejects
cross-platform or mismatched-architecture hosts. See [CONTRIBUTING.md](../CONTRIBUTING.md) for
the remaining checks before submitting a PR.
