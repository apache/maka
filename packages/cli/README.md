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
terminal UI, the non-interactive CLI, Runtime Host tooling, and the Eval command. That package is
published under the `nightly` dist-tag; `latest` holds an early alpha stub (see [Install](#install)).

## Apache Incubation Disclaimer

Apache Maka is undergoing incubation at The Apache Software Foundation. The published npm README
includes the canonical work-in-progress disclaimer below directly from the release commit's
[DISCLAIMER-WIP](https://github.com/apache/maka/blob/main/DISCLAIMER-WIP); the
[Maka podling status page](https://incubator.apache.org/projects/maka.html) records current status.

<!-- ASF-WIP-DISCLAIMER -->

> **Beta:** The CLI is under active development. Commands and local data formats may change before
> the stable release.

## Requirements

- Node.js 22.19.0 or newer on the 22 line, or 24.0.0 or newer (Node 23 is not supported);
- a terminal with interactive input for the TUI;
- a configured model connection for agent turns; first-run setup currently supports API-key
  providers.

The release gate validates the following installed-package matrix:

| Platform | Architecture | Node.js | TUI, CLI, Runtime Host | Real Harbor/Pier Eval |
| --- | --- | --- | --- | --- |
| Linux | x64 | 22.19 | Validated | Preflight only |
| Linux | x64 | 24 | Validated | Validated |
| Linux | arm64 | 24 | Validated | Preflight only |
| macOS | arm64 | 24 | Validated | Preflight only |
| Windows | x64 | 24 | Validated | Preflight only |

Other combinations that satisfy the Node.js minimum may work, but are not part of the current
release gate. Real Eval executor validation currently runs on Linux x64 with Node.js 24.

## Install

Two dist-tags are live on npm, and they are not interchangeable:

- `nightly` carries the complete CLI. The line moves daily — resolve the tag (or query its
  current version) instead of copying a version number from any document:

  ```sh
  npm install --global maka-agent@nightly
  maka --version
  maka --help
  ```

- `latest` points at an early alpha (`0.0.0-alpha.0`) whose command surface is limited to
  `doctor`, help, and version. Because of that split, do not use a bare
  `npm update --global maka-agent`: it follows `latest` and may switch the installation to the
  other release line.

The public command is `maka`. For a one-off invocation, use
`npx --yes --package maka-agent@nightly maka`; the unrelated `maka` package on npm is not this project.
`runtime-host service install` uses the persistent global installation above; `runtime-host setup`
creates its own managed copy from the exact package invoked by `npx`.

## Container

To build and run a local glibc-based CLI image from an exact published npm version
with persistent configuration, see the
[container guide](https://github.com/apache/maka/blob/main/packages/cli/container/README.md).

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


For another agent to drive a Session, request structured output or explicitly submit without waiting:

```sh
maka run "Inspect this project" --json
maka run "Inspect this project" --no-wait
```

Both forms return a `sessionId` in their JSON result. Ordinary runs still wait and print the final
answer by default. Built-in AskUser is an exception: it returns question JSON and exits 0
while the Turn waits. Scripts that need a final answer should use `--json` and inspect `status`,
not treat exit code 0 alone as task completion. `--no-wait` returns after admission; use the
Session ID to observe the eventual result. Given a returned Session ID in `$session`:

```sh
maka run --session "$session" --status
maka run --session "$session" --wait --json
maka run --session "$session" --answer '["Yes",null]' --wait --json
maka run --session "$session" "Inspect the tests next" --queue --wait --json
maka run --session "$session" "Focus on the parser" --steer --no-wait
maka run --session "$session" --result --json
maka run --session "$session" --resume --wait --json
```

Session controls (`--session`) inherit the Host's saved permissions, just as they inherit the
model and working directory. Continuing, queueing, steering, or answering does not require another
`--yolo` and does not change the boundary. Add `--yolo` only to explicitly grant full access.
`--status` reports `executionBoundary`: managed `read_only`/`writable`, bypass, or external.
A read-only task instruction does not turn a bypass Session into an enforced read-only Session.
The legacy blocking `--resume <id>` selector retains its explicit `--yolo` requirement for bypass.

An ordinary built-in AskUser returns `needs_input`, the questions and options, with exit code 0.
The Host retains the waiting Turn. `--answer` accepts one string or `null` per question in a JSON
array and continues the original tool call and Turn. It does not need `--resume`. A failed or
uncertain answer submission is not automatically retried; read the current questions before
choosing what to do next. Multiple pending batches are reported, and an answer is refused when
the current batch cannot be selected uniquely.

For Host-owned Session execution, `--wait` and `--status` return `needs_approval` with
`approvalRequests` when a sandbox expansion is pending. Each entry contains its `kind`, requested
`expansion`, and `justification`; internal request IDs stay inside the CLI. Review the scope, then:

```sh
maka run --session "$session" --approve --wait --json
maka run --session "$session" --deny --wait --json
```

These are alternative decisions, not a sequence to execute. Both continue the original Turn and
require exactly one pending sandbox request in the Session; none or multiple are rejected without
submitting a decision. They do not need `--yolo` and cannot be combined with it. Approval applies
the requested expansion through the Host's managed boundary; it does not change the Session to
bypass. The expanded boundary is saved for subsequent execution in the Session. The flags
target the request pending when that CLI invocation attaches. Do not automatically
retry a decision after an uncertain result: read the current requests before deciding again.
Ordinary blocking runs retain their existing sandbox-boundary denial behavior.

For coordination, submit follow-ups without blocking, then service the Session's interactions:

```sh
maka run --session "$session" "Inspect the tests next" --queue --no-wait --json
maka run --session "$session" --wait --json
```

Worker admission receipts have `submission: "started"`, `"queued"`, or `"steering"`. Their `status`
describes the currently observed Session, not completion of the submitted message. A queued receipt
can include `needs_input` and the current Turn's questions, or `needs_approval` and its sandbox
request. Answer that interaction before expecting the follow-up to execute. `queued` is the
observed total of follow-up and steering messages; it is not an exact position. An admission
receipt omits this count until its queue projection has caught up; use status for a fresh view. Status also reports
`providerRetry` when the Host has published a retry, without guessing activity from silence.

Assistant Inbox conversations instead return `submission: "inbox"`, without a worker result or queue count, even with `--wait`. This confirms Inbox admission only; inspect delegated work through its own worker Session.

Queue is the default: each explicit queued message opens its own subsequent Turn. Steer uses the
Host's existing current-Turn delivery and may carry over if it misses that Turn's last boundary.
Submitting a queued prompt with `--wait` follows that message's execution. It does not return
questions from an earlier Turn blocking the queue; service those through a separate Session
wait/answer call, or use the coordination workflow above. Steer with `--wait`
observes the Turn selected on attachment; it does not guarantee consumption before that Turn ends. A standalone `--wait` fixes its
target on attachment; when idle, it reads the latest result. `--result` never waits for an active
Turn. Status and result queries do not prepare a model or start MCP. Interrupting Session
observation with Ctrl+C leaves Host execution running; legacy blocking run cancellation retains
its existing behavior. To stop Host execution explicitly, use `maka run --session "$session" --stop --json`.
Stop targets the current Turn observed on attachment and needs no `--yolo`; a successful request
exits 0. A successful explicit or implicit status query also exits 0 even if it reports a failed
or cancelled Turn; result/wait retain the task's failure exit code. Stop and status are not
assertions that the assigned task succeeded.

Permission requests, MCP forms, and other interactions that this Session CLI cannot answer
remain waiting in the Host. A wait reports the actual interaction kind and a recovery command: use an
interactive client on the same Host, or stop the Turn explicitly. Detached admission does not
promise that subsequent execution will need no interaction.

Session commands use the saved configuration. Keep using the legacy `--resume <session-id>`
selector for blocking runs that supply configuration, cwd, timeout or Graph options; that selector
continues accepting a new prompt. `--session <id> --resume` instead requests safe continuation of
stopped execution. An idle Session prompt can use `--max-steps`; a queued or steering message
cannot attach a step cap to an existing Turn.

Returning from client-owned MCP interaction and resuming it in another CLI process is not
supported. Blocking MCP runs retain their existing behavior; `--no-wait` refuses to detach the
MCP servers owned by that invocation. Graph interaction handoff is also deferred. Use a persistent
CLI installation for local Session control execution and detached runs; temporary npx invocations
may own the Host's lifetime and keep the legacy blocking path.

For agent-to-agent CLI workflows, install the repository's `maka-cli` skill after it is available
on your selected branch. It explains Session coordination; it does not install Maka itself:

```sh
npx skills add apache/maka --skill maka-cli
```

## Upgrade

Update within the nightly line by pinning the exact release (`--target` accepts `latest`,
`next`, or an exact Maka version — there is no `nightly` channel name). Resolve the current
nightly version first and pass that exact value: the updater refuses downgrades, so a copied
version number goes stale as soon as the nightly line moves on.

```sh
version="$(npm view maka-agent@nightly version --registry=https://registry.npmjs.org)"
maka update --target "$version"
maka --version
```

Do not use a bare `npm update --global maka-agent` to upgrade: it follows `latest`, which holds
the early alpha stub, and may switch the installation to the other release line.

The update stages and verifies the exact release before replacing the local Runtime Host or the
npm-global package. It refuses to interrupt active or durable work by default. Use
`--allow-interrupt-active-tasks` only after deciding that interruption is safe. A direct
`npm install --global maka-agent@nightly` remains available for installation repair.

## Remote Runtime Host setup

To set up a persistent remote Runtime Host from an exact released package on Linux or macOS:

```sh
npx --yes --package maka-agent@nightly maka runtime-host setup \
  --principal my-client \
  --preset terminal-client
```

Rerunning setup replaces that Client credential. The service no longer depends on the temporary
`npx` cache after setup succeeds.

Check a managed service against the nightly release it should track, without changing the
running Host — pass the exact version resolved above rather than `latest`, which holds the
early alpha:

```sh
maka runtime-host service check-update --target "$version" --json
```

The result pins the selected channel to an exact version and package integrity. It also reports
whether the package carries enough compatibility evidence for unattended use; this command never
installs or switches a package. Installation-management callers can pass the same selector to
`service update --target`. That path verifies the archive and extracted manifest before delegating
to the existing exact-package update transaction, and does not mutate a candidate that requires
manual review.

The installation owner can persist one update target and reconcile it with the same verified
transaction. Pin the exact nightly version resolved above: there is no `nightly` target name,
and `latest` holds the early alpha, which the reconciliation assesses as a downgrade for a
nightly installation. Following successive nightlies therefore means resolving the current
version again and re-running `update-policy` with the fresh value:

```sh
maka runtime-host service update-policy --target "$version" \
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
npx --yes --package maka-agent@nightly maka runtime-host service uninstall

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
