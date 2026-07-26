# Maka

[![CI](https://github.com/Maka-Agent/maka-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Maka-Agent/maka-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-blue?logo=googletranslate&logoColor=white)](./README.zh-CN.md)

![Maka — Your work. Your agent.](./.github/assets/maka-hero.en.png)

**A local-first Agent workspace built for real work.**

Maka does more than answer questions. With controlled permissions, it can inspect projects, execute tools, produce artifacts, and preserve model messages, tool calls, and durable-task progress as recoverable execution facts. The same Runtime is available through the desktop app, terminal TUI, non-interactive CLI, and Headless runner.

> [!IMPORTANT]
> Maka is under active development. The macOS Apple Silicon desktop build is an early public release; data formats, CLI commands, and experimental capabilities may still change.

## Why Maka

- **Local-first instead of hosted-first**: sessions, settings, and run records stay on your machine by default. You choose the model connection: cloud API, local model, or compatible gateway.
- **Log is the Runtime**: model messages, Tool Calls, Tool Results, and termination facts enter Runtime Event Log. Sessions, UI, model context, and recovery are projections over that log.
- **Context is not history**: Tool Result pruning and LLM Compaction change what the next inference sees without treating recorded evidence as disposable context.
- **A task may outlive a Turn**: Headless uses TaskRun, Task Event Log, budgets, and continuation to advance interruptible and inspectable durable work.
- **Feedback is not fact authority**: Self-check may produce evidence and one bounded repair opportunity, but “I checked it” does not become a system fact.

Read [Maka Backend Architecture](./ARCHITECTURE.md) for the complete design.

## Surfaces

| Entry point | Best for | Current capability |
|---|---|---|
| **Desktop** | Daily interaction, file and Artifact workflows, model and permission setup | Electron + React with streaming sessions, tool timelines, branching, search, and recovery |
| **TUI / CLI** | Using Maka in the current project directory or running one non-interactive Turn | `maka`, `maka run`; shares workspace and model connections with Desktop |
| **Headless** | Durable tasks, recoverable TaskRuns, experiments, and evaluation | `maka eval` with task logs, export, resume, and comparison |

## Current capabilities

### Agent Runtime

- Multiple model connections, streaming output, thinking, usage accounting, and provider-error normalization;
- Local tools including `Read`, `Write`, `Edit`, `Bash`, `Glob`, and `Grep`;
- Tool schema validation, dynamic availability, permission policy, watchdogs, abort, and error classification;
- Runtime Event Log, AgentRun ledger, startup recovery, Turn Evidence, active Tool Result pruning, and history compaction.

### Desktop workspace

- Create, archive, search, rename, retry, regenerate, and branch sessions from a Turn;
- Artifact lists and previews, workspace instructions, model settings, and permission settings;
- Local memory, web search, an open HTTP/SSE gateway, bot entry points, and Office workflows;
- Integrations are configured independently, and not every experimental entry is available by default.

### Durable tasks and evolution

- Append-only Task Event Log and TaskRun projection;
- Budgets, permission pauses, continuation, result export, and failed-task retry;
- Plan-first, source-guarded, and attempt-bounded Heavy-task Self-check;
- AHE target protocol and evidence export; complete automatic self-iteration remains an external or experimental workflow.

## Quick start

### Download Desktop for macOS

The signed and notarized Desktop app is available from [GitHub Releases](https://github.com/Maka-Agent/maka-agent/releases/latest) for Apple Silicon Macs only (`arm64`).

1. Download `Maka-<version>-mac-arm64.dmg`;
2. Open the DMG and drag Maka to Applications;
3. Install `ripgrep` with `brew install ripgrep` to enable Runtime's `Grep` tool;
4. Launch Maka and configure your own model connection under `Settings → Models`.

Computer Use is not included in this first public build. Intel Macs, Windows, and Linux packages are not supported yet.

### Requirements

- Node.js 22.19 or newer (CI uses Node.js 24);
- npm (the lockfile and scripts use npm; the current `packageManager` is npm 11);
- Git;
- `ripgrep`, used by Runtime's `Grep` tool.

### Start Desktop

```sh
git clone https://github.com/Maka-Agent/maka-agent.git
cd maka-agent
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

Build the workspaces first:

```sh
npm run build
```

Then start the TUI or run one Turn:

```sh
npm --workspace maka-agent exec -- maka
npm --workspace maka-agent exec -- maka run "Summarize this repository and identify its most important risk"
npm --workspace maka-agent exec -- maka --help
```

The CLI reads the same model connections and workspace configuration written by Desktop. See [`packages/headless/README.md`](./packages/headless/README.md) for Headless commands and its trust posture.

## Architecture

The backend spine is:

```text
Desktop / TUI / Headless
          ↓
SessionManager → AgentRun → Model + Tool Runtime
          ↓
Runtime Event Log → Context / Session / UI projections
          ↓
Task Event Log → TaskRun → Self-check / AHE evidence
```

Start with [ARCHITECTURE.md](./ARCHITECTURE.md). It provides the system map, code boundaries, problem-oriented reading paths, and six bilingual deep dives.

## Repository layout

```text
apps/desktop/       Electron main / preload / React renderer

packages/core/      Pure contracts for Sessions, Events, Permissions, and Connections
packages/storage/   File-backed stores and run ledgers
packages/runtime/   AgentRun, model adapters, tools, context, and recovery
packages/headless/  TaskRun, Autonomous Loop, Self-check, eval, and AHE
packages/cli/       TUI and non-interactive CLI
packages/ui/        Shared conversation, Markdown, Artifact, and UI primitives

docs/               Architecture, product, security, privacy, and test contracts
scripts/            Build hygiene, visual checks, smoke tests, and release helpers
```

## Local data and security boundary

Maka stores workspace data under Electron `userData` by default:

```text
<Electron userData>/workspaces/default/
  llm-connections.json
  credentials.json
  settings.json
  sessions/
```

Current boundaries that matter:

- Sessions and connection metadata live in the local filesystem;
- Runtime credentials such as API keys, bot tokens, and proxy passwords currently live in local plaintext `credentials.json`, behind the OS account boundary, with POSIX directory mode `0700` and file mode `0600` enforced;
- Subscription OAuth tokens (Claude, Codex, GitHub Copilot, and the Cursor/Antigravity previews) live in the same `credentials.json` — the single authority for desktop, TUI, and headless; Electron `safeStorage` only decrypts pre-existing legacy token files once at desktop startup (#1125);
- Renderer does not receive plaintext credentials. File writes, Shell, and dangerous tool calls pass through the permission engine;
- Headless real-model evaluation fails closed by default and requires an explicit external isolation boundary.

Read [SECURITY.md](./SECURITY.md) for security reporting and policy, and [docs/README.md](./docs/README.md) for current privacy and sandbox contracts.

## Experimental runtime recovery flags

Runtime recovery remains opt-in. Both flags below are disabled by default:

- `MAKA_RUNTIME_SQLITE_CANONICAL=1` migrates the current workspace's canonical
  RuntimeEvent store to `runtime.sqlite`. This is a **one-way, sticky migration
  trigger**, not a reversible backend selector: after `runtime.sqlite` exists,
  disabling the variable does not switch the workspace back to JSONL. Automatic
  pre-migration backup and populated v2-to-v4 upgrade coverage are not complete,
  so back up the workspace before enabling this flag.
- `MAKA_RUNTIME_SAFE_BOUNDARY_RESUME=1` enables the Desktop interrupted-turn
  **Safe resume** action, CLI/TUI `/resume`, and Desktop startup auto-resume.
  These paths may call the configured model provider and consume tokens. Enable
  the flag only when that behavior is explicitly desired.

Phase 2 provides the durable write-side boundary and fail-closed safe-boundary
continuation. Phase 3 reconciliation for indeterminate tool side effects is not
implemented yet; ambiguous tool outcomes remain parked rather than retried.

## Development and verification

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
npm --workspace @maka/headless test
npm --workspace @maka/desktop test
```

Use the following commands to update `packages/core/src/model-metadata.generated.ts` from models.dev and run the focused tests. Keep access-path-specific overrides in `model-metadata.ts`; do not edit the generated file by hand.

```sh
npm run sync:model-metadata
npm run test:scripts
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
- [Security policy](./SECURITY.md)

## License

Maka is licensed under the [Apache License 2.0](./LICENSE). See
[NOTICE](./NOTICE) for attribution information. Third-party components remain
subject to their respective licenses and notices.
