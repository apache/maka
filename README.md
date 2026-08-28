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

<h1 align="center">
  <img src="apps/desktop/assets/app-icons/sky.png" alt="Maka" width="72" valign="middle" /> Apache Maka (Incubating)
</h1>

<p align="center"><sub>Incubating at The Apache Software Foundation</sub></p>

<p align="center">
  <a href="https://github.com/apache/maka/stargazers"><img src="https://img.shields.io/github/stars/apache/maka?style=flat&label=%E2%98%85&color=4C8DFF" alt="GitHub stars" /></a>
  <a href="https://github.com/apache/maka/releases"><img src="https://img.shields.io/github/downloads/apache/maka/total?style=flat&label=downloads&color=4C8DFF" alt="GitHub downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-4C8DFF?style=flat" alt="License: Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/macOS-arm64-4C8DFF?style=flat&logo=apple&logoColor=white" alt="macOS Apple Silicon" />
  <img src="https://img.shields.io/badge/Windows-preview-9BB8F0?style=flat&logo=windows&logoColor=white" alt="Windows unsigned preview" />
  <img src="https://img.shields.io/badge/Linux-soon-D0D4DA?style=flat&logo=linux&logoColor=6B7280" alt="Linux not yet supported" />
  <a href="https://deepwiki.com/apache/maka"><img src="https://img.shields.io/badge/DeepWiki-third--party%20AI%20docs-9BB8F0?style=flat" alt="DeepWiki: third-party AI-generated docs" /></a>
</p>

<p align="center">
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87%E6%96%87%E6%A1%A3-4C8DFF?style=flat" alt="中文文档" /></a>
</p>

<p align="center">
  <strong>A local-first Agent workspace built for real work.</strong><br/>
  Maka inspects projects, runs tools under a sandbox boundary, and records
  model messages and tool calls as recoverable execution facts — on your
  machine, through one Runtime Host.
</p>

![Maka — Your work. Your agent.](./.github/assets/maka-hero.en.png)

> [!NOTE]
> Apache Maka (Incubating) is an effort undergoing incubation at The Apache Software Foundation (ASF), sponsored by the Apache Incubator PMC. Incubation is required of all newly accepted projects until a further review indicates that the infrastructure, communications, and decision-making process have stabilized in a manner consistent with other successful ASF projects. While incubation status is not necessarily a reflection of the completeness or stability of the code, it does indicate that the project has yet to be fully endorsed by the ASF. [DISCLAIMER-WIP](./DISCLAIMER-WIP) records the issues the project is currently aware of.

> [!IMPORTANT]
> Maka is under active development. The macOS Apple Silicon desktop build is an early public release; data formats, CLI commands, and experimental capabilities may still change.

## Why Maka

- **Your machine, your data.** Sessions, settings, and run records stay local by default. You bring the model: a cloud API, a local model, or a compatible gateway.
- **The record is kept.** Model messages, tool calls, tool results, and how a turn ended are written down. The UI and the next model call are views of that record, not the only copy.
- **Shorter context is not deleted history.** Maka can omit old tool output from the next prompt without throwing away the saved evidence.
- **One place runs the agent.** Desktop, the terminal, and Maka evaluation all go through Runtime Host. Eval only owns the experiment and its scores.

Read [Maka Backend Architecture](./ARCHITECTURE.md) for the design.

## Surfaces

| Entry point | Best for | Current capability |
|---|---|---|
| **Desktop** | Daily interaction, file and Artifact workflows, model and permission setup | Electron + React with streaming sessions, tool timelines, branching, search, and recovery |
| **TUI / CLI** | Using Maka in the current project directory or running one non-interactive Turn | `maka`, `maka run`; shares workspace and model connections with Desktop |
| **Eval** | Reproducible benchmark experiments across Maka and external subjects | `maka eval run <spec> --out <directory>` |

## Current capabilities

### Agent Runtime

- Multiple model connections, streaming output, thinking, usage, and clearer provider errors;
- Built-in tools: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`. Computer Use and catalog skills are optional and not on by default;
- Tools that leave the sandbox must be approved; runs can be aborted; failures are classified;
- A durable execution record, crash recovery, and optional resume of an interrupted turn.

### Desktop workspace

- Create, archive, search, rename, retry, regenerate, and branch sessions from a Turn;
- Artifact lists and previews, workspace instructions, model settings, and sandbox settings;
- Local memory and web search when configured;
- Chat apps (IM bots) are experimental. See [IM onboarding](./docs/architecture/bot-onboarding-runtime.zh-CN.md).

### Evaluation

- Declarative multi-arm experiments expanded into task × repetition × subject cells;
- Immutable per-cell attempts with targeted infrastructure replacement and earliest-valid selection;
- A small result kernel for score, normalized usage, attributable cost, duration, status, failure reason, and artifacts;
- Maka subjects execute only through Runtime Host; external subjects use generic external subject adapters.

## Quick start

### Releases and downloads

Apache Maka has not made an Apache release yet. Everything currently published from this repository or from a package registry was produced before or during incubation, is not an Apache Software Foundation release, and has not been reviewed or voted on by the Incubator PMC.

Once Apache releases exist, the official release is the source release published by the ASF and approved by the podling PPMC and the Incubator PMC. A package built from that source and distributed elsewhere, for example through a package registry or as a Desktop installer, is a convenience artifact rather than the release itself, and it is valid only when it is built from an approved source release. [`.github/ASF_SOURCE_RELEASE.md`](./.github/ASF_SOURCE_RELEASE.md) holds the candidate contract, signing path, and verification steps.

Until an approved source release exists, this README recommends no prebuilt download. Build and run Maka from source as described below. Desktop currently targets Apple Silicon Macs (`arm64`). Intel Macs and Linux are not supported yet. [Windows](docs/windows-support.md) is an unsigned preview, not a supported release tier.

### Requirements

- Node.js 22.19 or newer (CI uses Node.js 24);
- npm (the lockfile and scripts use npm; the current `packageManager` is npm 11);
- Git;
- `ripgrep`, used by Runtime's `Grep` tool.

### Start Desktop

```sh
git clone https://github.com/apache/maka.git
cd maka
npm ci
npm run dev
```

`npm run dev` starts the Desktop development environment with HMR. To build every workspace before starting Electron, use:

```sh
npm run dev:full
```

If dependencies were installed with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, install the Electron platform binary before starting:

```sh
node node_modules/electron/install.js
```

### First run

Maka does not bundle a shared model account. On first launch:

1. Open `Settings → Models`;
2. Add an API, local-model, or supported account connection;
3. Test it and choose a default model;
4. Return to the workspace and start a task.

The app distinguishes configured, send-ready, and experimental connection states. An account flow that is not wired into Runtime is not presented as a usable model.

## Terminal entry points

For the public npm package, see the [CLI installation and usage guide](./packages/cli/README.md).
The commands below run the development CLI from a source checkout.

Build the workspaces first:

```sh
npm run build
```

Then start the TUI or run one Turn:

```sh
npm run cli:dev
npm run cli:dev -- run "Summarize this repository and identify its most important risk"
npm run cli:dev -- run --graph "Implement two independent slices, integrate them, then review the result"
npm run cli:dev -- --help
```

The TUI also accepts `/graph on`, `/graph off`, and `/graph <task>`. Non-interactive
`--graph` runs wait for the durable Graph to finish before printing the final
supervisor output. Graph implementation operators use isolated Git worktrees, so
the source project must be a clean Git worktree.

The repository CLI uses the same `Maka Dev` profile as a development Desktop build. The
released `maka` binary continues to use the `Maka` profile; the two profiles are not copied or
synchronized automatically. Evaluation specs and adapters live in [`packages/eval`](./packages/eval).

## Architecture

The backend spine is:

```text
Desktop / TUI / CLI → Runtime Host → SessionManager → AgentRun
                                             ↓
                         Model + Tool Runtime → Runtime Event Log
                                             ↓
                              Context / Session / UI projections

Experiment → Cells → Attempts → Results
                    ↓
       Runtime Host executes Maka subjects
```

Start with [ARCHITECTURE.md](./ARCHITECTURE.md). It provides the system map, code boundaries, problem-oriented reading paths, and six bilingual deep dives.

## Repository layout

```text
apps/desktop/          Electron main / preload / React renderer

packages/core/         Pure contracts for Sessions, Events, Permissions, and Connections
packages/storage/      SQLite operational state, configuration, and payload stores
packages/mcp/          Provider-neutral Model Context Protocol client integration
packages/runtime/      AgentRun, model adapters, tools, context, and recovery
packages/runtime-host/ Single-owner Runtime Host lifecycle, protocol, and client bootstrap
packages/eval/         Experiment cells, attempts, results, and executor/subject adapters
packages/computer-use/ Computer-use backend selection, host lifecycle, and protocol adapters
packages/cli/          TUI and non-interactive CLI
packages/ui/           Shared conversation, Markdown, Artifact, and UI primitives

docs/                  Architecture, product, security, privacy, and test contracts
scripts/               Build hygiene, visual checks, smoke tests, and release helpers
```

## Local data and recovery

Workspace data lives under Electron `userData` by default:

```text
<Electron userData>/workspaces/default/
  runtime.sqlite
  connection-catalog.json
  credential-vault.json
  settings.json
  artifacts/
```

- API keys and similar secrets are a local plaintext file (`credential-vault.json`), readable only by your OS account. The renderer never sees them.
- Tools that write files or run a shell must pass the sandbox boundary first.
- `runtime.sqlite` is the live record. Older JSONL transcripts and Electron `safeStorage` credential files are not imported; an upgraded workspace can show empty threads, and those credentials must be entered again.
- Resuming an interrupted turn is off by default. Set `MAKA_RUNTIME_SAFE_BOUNDARY_RESUME=1` only if you want Desktop **Safe resume**, CLI `/resume`, and startup auto-resume — those calls hit the model and use tokens.

Details: [SECURITY.md](./SECURITY.md), [privacy](./docs/workspace-privacy-context.md), [resume](./docs/architecture/runtime-resume-architecture.md).

## Development and verification

Before sending a change, read [CONTRIBUTING.md](./CONTRIBUTING.md).

Common repository-level commands:

```sh
npm run build
npm run typecheck
npm test
npm run check:release
```

Run one workspace in isolation:

```sh
npm --workspace @maka/runtime test
npm --workspace @maka/eval test
npm --workspace @maka/desktop test
```

Use `refresh:model-metadata` to fetch the current catalog from models.dev, update the committed snapshot, and regenerate the derived TypeScript files. A refresh fails closed when any committed model, capability, provider override, or pricing field disappears; after reviewing an intentional upstream removal, acknowledge it with `npm run refresh:model-metadata -- --accept-upstream-removals`. `sync:model-metadata` is intentionally offline: it only regenerates those files from the committed snapshot. Keep access-path-specific overrides in `model-metadata.ts`; do not edit the generated files by hand.

```sh
npm run refresh:model-metadata
npm --workspace @maka/core test
```

Desktop real-window and visual verification:

```sh
npm --workspace @maka/desktop run e2e
npm --workspace @maka/desktop run smoke:real-window
```

Before submitting code, run typecheck, build, and focused tests proportionate to the change, followed by `git diff --check`.

## Documentation

- [Documentation index and authority map](./docs/README.md)
- [Backend architecture](./ARCHITECTURE.md)
- [Product design](./DESIGN.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)

## License

Maka is licensed under the [Apache License 2.0](./LICENSE). See
[NOTICE](./NOTICE) for attribution information. Third-party components remain
subject to their respective licenses and notices.

Apache Maka, Maka, Apache, the Apache feather, and the Apache Maka project logo are either registered trademarks or trademarks of The Apache Software Foundation.
