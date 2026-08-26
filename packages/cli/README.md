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

# Apache Maka (Incubating) CLI

[简体中文](https://github.com/apache/maka/blob/main/packages/cli/README.zh-CN.md)

Maka is a local-first agent workspace. The `maka-agent` npm package installs the interactive
terminal UI, the non-interactive CLI, Runtime Host tooling, and the Eval command.

## Apache Incubation Disclaimer

Apache Maka is undergoing incubation at The Apache Software Foundation. The published npm README
includes the canonical work-in-progress disclaimer below directly from the release commit's
[DISCLAIMER-WIP](https://github.com/apache/maka/blob/main/DISCLAIMER-WIP); the
[Maka podling status page](https://incubator.apache.org/projects/maka.html) records current status.

<!-- ASF-WIP-DISCLAIMER -->

> **Beta:** The CLI is under active development. Commands and local data formats may change before
> the stable release.

## Requirements

- Node.js 22.19.0 or newer;
- a terminal with interactive input for the TUI;
- a configured model connection for agent turns; first-run setup currently supports API-key
  providers.

The release gate validates the following installed-package matrix:

| Platform | Architecture | Node.js | TUI, CLI, Runtime Host | Real Harbor/Pier Eval |
| --- | --- | --- | --- | --- |
| Linux | x64 | 22.19 | Validated | Preflight only |
| Linux | x64 | 24 | Validated | Validated |
| macOS | arm64 | 24 | Validated | Preflight only |
| Windows | x64 | 24 | Validated | Preflight only |

Other combinations that satisfy the Node.js minimum may work, but are not part of the current
release gate. Real Eval executor validation currently runs on Linux x64 with Node.js 24.

## Install

Install the current beta explicitly from the `next` dist-tag:

```sh
npm install --global maka-agent@next
maka --version
maka --help
```

The public command is `maka`. For a one-off invocation, use
`npx --yes --package maka-agent@next maka`; the unrelated `maka` package on npm is not this project.
`runtime-host service install` uses the persistent global installation above; `runtime-host setup`
creates its own managed copy from the exact package invoked by `npx`.

## First run

Start Maka from the project directory the agent should work in:

```sh
cd path/to/project
maka
```

If no model connection exists, Maka opens the provider setup flow. Select a provider, enter its API
key, choose the enabled models, and save. Run `/setup` later to add or update a provider and `/model`
to switch models.

API keys and workspace state stay in the local `Maka` profile. The current credential vault is a
local plaintext file protected by the operating-system account boundary; on POSIX systems Maka
enforces owner-only directory and file modes. It is not an OS keychain. See the repository
[security policy](https://github.com/apache/maka/blob/main/SECURITY.md) for the current
boundary.

Run one non-interactive turn with:

```sh
maka run "Summarize this project and identify its highest-risk area"
maka run --help
```

Maka asks before privileged tool operations by default. `maka run --yolo` grants the task full file
and network access and should only be used in an environment you are prepared to let the task
modify.

## Upgrade

While using prereleases, keep the `next` tag explicit:

```sh
npm install --global maka-agent@next
maka --version
```

Do not use a bare `npm update --global maka-agent` for beta upgrades: global npm updates follow the
`latest` tag and may select a different release line. After a stable release is available, install it
with `npm install --global maka-agent@latest`.

## Remote Runtime Host setup

To set up a persistent remote Runtime Host from an exact released package on Linux or macOS:

```sh
npx --yes --package maka-agent@next maka runtime-host setup \
  --principal my-client \
  --preset terminal-client
```

Rerunning setup replaces that Client credential. The service no longer depends on the temporary
`npx` cache after setup succeeds.

Check a managed service against a release channel without changing the running Host:

```sh
maka runtime-host service check-update --target next --json
```

The result pins the selected channel to an exact version and package integrity. It also reports
whether the package carries enough compatibility evidence for unattended use; this command never
installs or switches a package. Installation-management callers can pass the same selector to
`service update --target`. That path verifies the archive and extracted manifest before delegating
to the existing exact-package update transaction, and does not mutate a candidate that requires
manual review.

The installation owner can persist one update target and reconcile it with the same verified
transaction:

```sh
maka runtime-host service update-policy --target latest \
  --expected-service-id <service-id> \
  --expected-root-path <state-root> \
  --expected-root-id <root-id>
maka runtime-host service reconcile-update --json
```

Use `update-policy --target manual` to disable automatic reconciliation. Reconciliation is a
bounded one-shot command: it never interrupts active work and does not install a scheduler.

## Uninstall

```sh
# When a managed Runtime Host service was installed on Linux or macOS
npx --yes --package maka-agent@next maka runtime-host service uninstall

# If Maka was installed globally
npm uninstall --global maka-agent
```

Remove the managed service before removing a global package so the OS service manager does not
retain a service pointing to the deleted CLI. Neither command deletes model connections,
credentials, sessions, or artifacts.
Those remain in the profile shared by the released CLI and Desktop app:

| Platform | Profile directory |
| --- | --- |
| macOS | `~/Library/Application Support/Maka` |
| Linux | `$XDG_CONFIG_HOME/Maka`, or `~/.config/Maka` when unset |
| Windows | `%APPDATA%\Maka` |

Back up and remove that directory separately only when you intend to delete all local Maka data.
Close the CLI and Desktop app first.

## Eval

Run a declarative experiment with:

```sh
maka eval run experiment.json --out .maka-eval/run-001
```

The npm package includes Maka's Eval runtime, relay, wrapper, and container policy assets. It does
not install the executor's external software or machine-local benchmark data. Before starting any
trial, Eval checks the exact prerequisites declared by the spec and fails without running a cell if
one is missing.

For Docker-based Harbor or Pier specs, provide:

- a reachable Docker CLI and daemon;
- a dedicated Python environment containing the exact framework version declared by
  `executor.config.frameworkVersion`;
- an executable interpreter through the environment variable named by `pythonPathEnv`;
- writable trial storage through `trialsRootEnv`;
- for Pier, the task directory named by `tasksRootEnv`;
- every machine path and subject credential environment variable declared by the spec.

Harbor and Pier must use separate Python environments. The currently validated versions are:

```sh
python3.12 -m venv ~/.venvs/maka-harbor-0.20.0
~/.venvs/maka-harbor-0.20.0/bin/python -m pip install 'harbor==0.20.0'

python3.12 -m venv ~/.venvs/maka-pier-0.3.0
~/.venvs/maka-pier-0.3.0/bin/python -m pip install 'datacurve-pier==0.3.0'
```

Set the spec's `pythonPathEnv` to the corresponding `bin/python` path. Do not reuse one environment
for both frameworks: their dependency and trial contracts differ. Advanced experiment and
toolchain details live in the
[Eval documentation](https://github.com/apache/maka/tree/main/packages/eval).

## Troubleshooting

Start by recording the installed versions:

```sh
node --version
npm --version
maka --version
```

- If `maka` is not found after a global install, ensure npm's global executable directory is on
  `PATH`.
- If no model is available, start the TUI and run `/setup`.
- If Eval refuses to start, follow the reported environment-variable name and expected framework
  version; it does not install or silently substitute missing prerequisites.
- When reporting a problem, include the three versions above, the operating system and
  architecture, the command, and the complete error with credentials removed.

Report issues at <https://github.com/apache/maka/issues>.

## Links

- [Repository](https://github.com/apache/maka)
- [Release operations](https://github.com/apache/maka/blob/main/docs/cli-npm-release.md)
- [License](https://github.com/apache/maka/blob/main/LICENSE)
