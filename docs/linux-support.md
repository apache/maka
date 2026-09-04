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

Maka's released CLI, TUI, and Runtime Host support Linux. Maka Desktop does not currently ship a
Linux installer or portable application, so Linux is not a supported Desktop release target. This
distinction matters: Linux CI exercises parts of the Electron application, but those checks do not
establish a packaged Desktop installation, update, or accessibility contract.

## Current support boundary

| Surface | Current Linux status |
| --- | --- |
| CLI, TUI, and Runtime Host | Published in the `maka-agent` npm package. The release gate validates Linux x64 with Node.js 22.19 and 24, and Linux arm64 with Node.js 24. |
| Eval | Packaged preflight runs on Linux x64 and arm64. Real Harbor/Pier executor validation runs on Linux x64 with Node.js 24. |
| Persistent Runtime Host service | Supported through a systemd user service when user lingering is enabled. |
| Command and filesystem sandbox | Uses `/usr/bin/bwrap` (bubblewrap). Required namespace creation and seccomp support are probed before the sandbox is advertised. |
| Desktop | Source builds and selected renderer tests run on Linux CI. There is no supported AppImage, deb, rpm, Flatpak, Snap, or Linux automatic-update channel. |
| Computer Use | No Linux backend. Work is tracked in [#3891](https://github.com/apache/maka/issues/3891); the cross-platform backend boundary is tracked in [#3896](https://github.com/apache/maka/issues/3896). |

The CLI is beta software. Other Linux distributions, architectures, Node.js versions, display
servers, and sandbox configurations may work, but are outside the release matrix above.

## Install the released CLI

Install Node.js 22.19.0 or newer first. Node.js 24 is the fully validated Linux baseline and is
required for the release gate's real Eval executor check. Then install the current beta from the
`next` npm dist-tag:

```sh
npm install --global maka-agent@next
maka --version
maka --help
```

The public command is `maka`. A model connection is required before running an agent turn. See the
[CLI README](../packages/cli/README.md) for first-run setup, non-interactive output, and data-root
locations.

There are no Desktop AppImage, deb, or rpm installation instructions because the project does not
publish those artifacts. Do not treat an unofficial package or a locally built Electron directory
as an Apache Maka release.

## Run a persistent Runtime Host

A global CLI installation can register a per-user systemd service that survives the SSH session:

```sh
maka runtime-host service install \
  --root /srv/maka \
  --project-root projects=/srv/projects
maka runtime-host service status --json
```

The installer requires a working `systemd --user` manager and user lingering. Check the latter with:

```sh
loginctl show-user "$(id -u)" --property=Linger --value
```

If it reports `no`, enable lingering using the administration policy for the distribution, then
retry the install. The service records the exact Node.js and Maka CLI paths used at installation;
remove it before uninstalling or replacing that global CLI installation:

```sh
maka runtime-host service uninstall
```

Uninstalling the service preserves the Runtime Host State Root and registered Projects. For TLS,
SSH tunnel, access-credential, and project-root setup, follow
[Remote Runtime Host setup](./runtime-host-remote-access.md).

## Linux sandbox requirements

Restricted command execution uses bubblewrap at `/usr/bin/bwrap`. Maka checks that the executable:

- is present and executable;
- advertises seccomp support;
- can create the required user, PID, IPC, UTS, cgroup, and network namespaces.

If any check fails, a profile that requires the sandbox fails closed instead of silently running
without confinement. Common causes are a missing `bubblewrap` package, disabled unprivileged user
namespaces, or container/security policy that blocks namespace creation. Install bubblewrap through
the distribution package manager and fix the host policy; do not work around a failed probe by
assuming the command is still sandboxed.

The Runtime `Grep` tool also requires `ripgrep` (`rg`) on `PATH`. Restart a long-running Runtime Host
after installing it or changing `PATH`.

## Develop from source

Use a Linux x64 or arm64 environment with Git, Node.js 24, and the npm version declared by the root
`packageManager` field. From a clean checkout:

```sh
npm ci
npm run build
npm test
```

Run the closest workspace suite while iterating, for example:

```sh
npm --workspace @maka/runtime test
npm --workspace maka-agent test
```

Desktop renderer development is possible from source, but remains a development path rather than a
Linux Desktop support claim. CI runs renderer E2E coverage under Xvfb and explicitly launches
Electron with `--no-sandbox`; this is not evidence for a packaged app, a production Electron sandbox,
native Wayland parity, or desktop accessibility integration. The fixture launcher selects native
Wayland only when `XDG_SESSION_TYPE=wayland`; otherwise Electron keeps its platform default.

## Test inventory

| Evidence | Linux coverage | Boundary |
| --- | --- | --- |
| Main CI (`.github/workflows/ci.yml`) | Ubuntu build/type/test surfaces selected by the affected-test planner; real Linux bubblewrap smoke; renderer E2E under Xvfb. | A green renderer test is not a packaged Desktop support result. |
| CLI package validation (`.github/workflows/cli-package-validation.yml`) | Installs and smokes the immutable npm tarball on Linux x64/Node 22.19, Linux x64/Node 24, and Linux arm64/Node 24. | Other distributions and Node/architecture combinations are not release-gated. |
| CLI Eval package validation | Real executor validation on Ubuntu x64/Node 24; preflight-only coverage on the remaining Linux package rows. | Preflight does not prove a real executor run. |
| Linux sandbox smoke | Executes the built Runtime test against the host bubblewrap implementation. | Depends on the CI runner's namespace and seccomp policy. |

Unlike Windows, Linux does not have a generated platform-skip inventory. Platform-specific skips
must therefore be reviewed in the affected test files and CI plan rather than inferred from a single
summary document.

## Known gaps

- No official Linux Desktop distribution, installer, update feed, signing path, or packaged smoke.
- No Linux Computer Use implementation; see [#3891](https://github.com/apache/maka/issues/3891).
- No committed X11-versus-Wayland product support contract. Xvfb coverage proves only the selected
  renderer test path.
- Sandbox availability depends on host bubblewrap, namespace, and seccomp policy. Maka detects an
  unavailable boundary and fails closed, but cannot reconfigure the operating system.
- The package validation matrix does not cover every Linux distribution or libc variant. Native
  direct-peer prebuilds are built against a glibc 2.28 baseline for Linux x64 and arm64.

Keep roadmap progress in the linked issues. Update this document only when shipped behavior or its
validation boundary changes.
