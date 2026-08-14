# Maka

[![CI](https://github.com/Maka-Agent/maka-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Maka-Agent/maka-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-blue?logo=googletranslate&logoColor=white)](./README.zh-CN.md)

![Maka — Your work. Your agent.](./.github/assets/maka-hero.en.png)

**A local-first Agent workspace built for real work.**

Maka does more than answer questions. With controlled permissions, it can inspect projects, execute tools, produce artifacts, and preserve model messages and tool calls as recoverable execution facts. Desktop, the terminal TUI, the non-interactive CLI, and Maka evaluation subjects all execute through Runtime Host.

> [!IMPORTANT]
> Maka is under active development. The macOS Apple Silicon desktop build is an early public release; data formats, CLI commands, and experimental capabilities may still change.

## Why Maka

- **Local-first instead of hosted-first**: sessions, settings, and run records stay on your machine by default. You choose the model connection: cloud API, local model, or compatible gateway.
- **Log is the Runtime**: model messages, Tool Calls, Tool Results, and termination facts enter Runtime Event Log. Sessions, UI, model context, and recovery are projections over that log.
- **Context is not history**: Tool Result pruning and LLM Compaction change what the next inference sees without treating recorded evidence as disposable context.
- **One execution authority**: Runtime Host owns Session, Turn, agent lifecycle, continuation, tools, and events. Eval owns only experiment semantics and results.

Read [Maka Backend Architecture](./ARCHITECTURE.md) for the complete design.

## Surfaces

| Entry point | Best for | Current capability |
|---|---|---|
| **Desktop** | Daily interaction, file and Artifact workflows, model and permission setup | Electron + React with streaming sessions, tool timelines, branching, search, and recovery |
| **TUI / CLI** | Using Maka in the current project directory or running one non-interactive Turn | `maka`, `maka run`; shares workspace and model connections with Desktop |
| **Eval** | Reproducible benchmark experiments across Maka and external subjects | `maka eval run <spec> --out <directory>` |

## Current capabilities

### Agent Runtime

- Multiple model connections, streaming output, thinking, usage accounting, and provider-error normalization;
- Local tools including `Read`, `Write`, `Edit`, `Bash`, `Glob`, and `Grep`;
- Tool schema validation, dynamic availability, permission policy, watchdogs, abort, and error classification;
- Runtime Event Log, AgentRun ledger, startup recovery, Turn Evidence, active Tool Result pruning, and history compaction.

### Desktop workspace

- Create, archive, search, rename, retry, regenerate, and branch sessions from a Turn;
- Artifact lists and previews, workspace instructions, model settings, and permission settings;
- Local memory, web search, and bot entry points;
- Integrations are configured independently, and not every experimental entry is available by default.

### Evaluation

- Declarative multi-arm experiments expanded into task × repetition × subject cells;
- Immutable per-cell attempts with targeted infrastructure replacement and earliest-valid selection;
- A small result kernel for score, normalized usage, attributable cost, duration, status, failure reason, and artifacts;
- Maka subjects execute only through Runtime Host; external competitors use generic external subject adapters.

## Quick start

### Download Desktop for macOS

The signed and notarized Desktop app is available from [GitHub Releases](https://github.com/Maka-Agent/maka-agent/releases/latest) for Apple Silicon Macs only (`arm64`).

1. Download `Maka-<version>-mac-arm64.dmg`;
2. Open the DMG and drag Maka to Applications;
3. Install `ripgrep` with `brew install ripgrep` to enable Runtime's `Grep` tool;
4. Launch Maka and configure your own model connection under `Settings → Models`.

Computer Use is not included in this first public build. Intel Macs, Windows, and Linux packages are not supported yet.

### Windows x64 preview

Windows is still an unsigned preview, not a supported release tier. When a release includes Windows
assets, follow the [Windows preview installation and verification guide](docs/windows-support.md#install-the-windows-x64-preview)
before running `Maka-<version>-win-x64.exe`. SmartScreen will identify the installer as coming from
an unknown publisher; do not bypass that warning unless the downloaded SHA-256 matches the checksum
published with the same release.

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
apps/desktop/       Electron main / preload / React renderer

packages/core/      Pure contracts for Sessions, Events, Permissions, and Connections
packages/storage/   SQLite operational state, configuration, and payload stores
packages/runtime/   AgentRun, model adapters, tools, context, and recovery
packages/eval/      Experiment cells, attempts, results, and executor/subject adapters
packages/cli/       TUI and non-interactive CLI
packages/ui/        Shared conversation, Markdown, Artifact, and UI primitives

docs/               Architecture, product, security, privacy, and test contracts
scripts/            Build hygiene, visual checks, smoke tests, and release helpers
```

## Local data and security boundary

Maka stores workspace data under Electron `userData` by default:

```text
<Electron userData>/workspaces/default/
  runtime.sqlite
  llm-connections.json
  credentials.json
  settings.json
  artifacts/
```

Current boundaries that matter:

- Sessions, messages, execution ledgers, workflows, usage, Automations, and Daily Review live in `runtime.sqlite`;
- Runtime credentials such as API keys, bot tokens, and proxy passwords currently live in local plaintext `credentials.json`, behind the OS account boundary, with POSIX directory mode `0700` and file mode `0600` enforced;
- Subscription OAuth tokens (Claude, Codex, GitHub Copilot, xAI, and the Antigravity preview) live in the same `credentials.json` — the single authority for Runtime Host clients. Pre-existing Electron `safeStorage` credential/token files are not imported; affected users must re-authenticate;
- Renderer does not receive plaintext credentials. File writes, Shell, and dangerous tool calls pass through the permission engine;
- Eval does not construct Runtime or read Runtime storage. Maka subjects connect to an existing Runtime Host.

Read [SECURITY.md](./SECURITY.md) for security reporting and policy, and [docs/README.md](./docs/README.md) for current privacy and sandbox contracts.

## Runtime storage and recovery

`runtime.sqlite` is the sole operational authority. It owns RuntimeEvents,
session metadata and message history, Agent Graph control, core execution state,
workflow state, usage and pricing, Artifact metadata, Automations, Daily Review,
and Runtime continuation records. Artifact payload bytes remain regular files under
`artifacts/`; connections, credentials, settings, MCP configuration, skills,
and device identity remain configuration files.

This storage generation does not import earlier File/JSONL authorities. On
upgrade, legacy session titles may still be discoverable through current
metadata, but conversation history that exists only in legacy transcript files
is not copied into `session_messages` and opens as an empty thread. Likewise,
pre-version or `safeStorage`-encrypted credential/token files are not migrated;
users with only those copies must re-authenticate. This data-loss boundary is
intentional for this release and must be considered before upgrading an
existing workspace.

Full operational backup uses the database owner's online SQLite backup API and
copies canonical Artifact payloads under the Artifact writer lock. Its manifest
binds every file by size and SHA-256. Validation checks the standalone SQLite
snapshot's integrity, foreign keys, schema registry and required tables,
decodes canonical session-message and Artifact records, and verifies Artifact
payload sizes against SQLite metadata before restore. Backup and restore use
owner-only file modes, file and directory synchronization, staging, and atomic
publication.

Runtime continuation remains opt-in:

- `MAKA_RUNTIME_SAFE_BOUNDARY_RESUME=1` enables the Desktop interrupted-turn
  **Safe resume** action, CLI/TUI `/resume`, and Desktop startup auto-resume.
  These paths may call the configured model provider and consume tokens. Enable
  the flag only when that behavior is explicitly desired.

Phase 2 provides the durable write-side boundary and fail-closed safe-boundary
continuation. Phase 3 reconciliation for indeterminate tool side effects is not
implemented yet; ambiguous tool outcomes remain parked rather than retried.

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

Use the following commands to update `packages/core/src/model-metadata.generated.ts` from models.dev and run the focused tests. Keep access-path-specific overrides in `model-metadata.ts`; do not edit the generated file by hand.

```sh
npm run sync:model-metadata
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
