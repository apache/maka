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

# Agent Guide for Apache Maka

## Project overview

Apache Maka (Incubating) is a local-first agent workspace. It ships four surfaces, and all of them
execute through one authority, **Runtime Host**:

- **Desktop** — Electron + React, the daily interaction surface.
- **TUI** — the terminal client, `maka`.
- **CLI** — one non-interactive turn, `maka run`, plus `maka eval`.
- **Eval** — reproducible benchmark experiments across Maka and external subjects.

Stack: TypeScript across npm workspaces, Node.js **>= 22.19** (CI uses 24), SQLite for durable
state, Vite and electron-builder for Desktop, Biome for lint and format, `node --test` for tests.
`ripgrep` must be on PATH — the runtime's `Grep` tool shells out to `rg`.

Two invariants govern the runtime. Read the code with them in mind, because they decide what a
correct fix looks like:

- **Runtime Host is the only execution authority.** Desktop, TUI, CLI and eval all go through it;
  none owns a second runtime. Something that seems to need its own runtime is a design discussion,
  not an implementation detail.
- **The Runtime Event Log is the source of truth.** Model messages, tool calls, tool results and
  termination facts are appended to it, and sessions, UI, model context and recovery are all
  projections over that log. Pruning and compaction change what the next inference sees; they never
  delete recorded evidence. If a fix tempts you to rewrite recorded events, the intended mechanism
  is a projection.

Full design in [ARCHITECTURE.md](./ARCHITECTURE.md), then the drafts under
[`docs/architecture/`](./docs/architecture/). Historical designs under
[`docs/archive/`](./docs/archive/README.md) may be stale; current issues and source win.

## Repository layout

| Path | Purpose |
|---|---|
| `packages/core` | Pure contracts: Session, Runtime Event, AgentRun, permission and protocol types |
| `packages/storage` | Interactive runtime stores and SQLite control planes |
| `packages/runtime` | SessionManager, AgentRun, model adapters, tools, context, recovery, graph |
| `packages/runtime-host` | The hosted execution authority and its public client/protocol |
| `packages/mcp` | MCP client/server integration |
| `packages/computer-use` | Computer-use capability |
| `packages/eval` | Experiment cells, attempts, result selection, subject and executor adapters |
| `packages/cli` | TUI, `maka run`, and the public `maka eval` route |
| `packages/ui` | Shared React components for the Desktop surface |
| `apps/desktop` | Electron composition, main process, renderer, product-entry adapters |
| `scripts/` | Build, release, ASF policy and CI-planning scripts |

Workspaces build in dependency order: `core → storage → mcp → runtime → runtime-host →
computer-use → eval → cli → ui → desktop`. `npm run build` walks exactly that order.

## Setup

```sh
npm ci          # respect the lockfile; not `npm install`
npm run build   # build every workspace, in dependency order
```

If dependencies were installed with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, install the Electron binary
before starting Desktop: `node node_modules/electron/install.js`.

Maka bundles no model account. A fresh workspace needs a connection configured in
`Settings → Models` before a turn can run; automated checks use the fake backend instead of a real
provider.

## Development workflow

```sh
npm run dev            # Desktop with HMR
npm run dev:full       # build every workspace, then start Electron
npm run rebuild        # clean + full build, when incremental output looks wrong
```

Per workspace, when you only touched one:

```sh
npm --workspace @maka/runtime run build
npm --workspace @maka/desktop run build:workspace-deps   # rebuild deps after switching branches
```

The TUI and CLI run from a source build — see [`packages/cli/README.md`](./packages/cli/README.md)
for the entry points. Desktop Storybook: `npm --workspace @maka/desktop run storybook`.

## Testing

**Tests run from `dist/`, not `src/`.** Every workspace compiles TypeScript to `dist/` and runs
`node --test` against the **compiled output**. Editing a `.ts` file and re-running a suite silently
re-tests the previous build, with no error to tell you. This is the single most common way to waste
an hour in this repository.

```sh
npm test                                  # build every workspace, then run all suites
npm --workspace @maka/runtime run test     # clean + build + test one workspace
npm run test:dist                          # run against the current dist, no rebuild
npm run test:dist:serial                   # same, one workspace at a time (CI ordering)
```

Not every workspace defines `test`. `@maka/eval` exposes only `test:dist`, and that script also
runs Python suites under `harbor/`. Check the workspace's `package.json` before assuming a script
exists.

Fast iteration loop — build, then target one file or one case:

```sh
npm --workspace @maka/runtime run build
npm exec -w @maka/runtime -- node --test "dist/__tests__/some-file.test.js"
node --test --test-name-pattern="steering" "dist/__tests__/ai-sdk-backend.test.js"
```

Desktop unit tests compile only the main process; end-to-end uses Playwright against a real Electron
build:

```sh
npm --workspace @maka/desktop run test                      # main-process unit tests
npm exec -w @maka/desktop -- playwright test --config e2e/playwright.config.ts
```

Conventions and consequences:

- Test sources live in `src/__tests__/*.test.ts`, beside the code they cover; Desktop's are under
  `src/main/__tests__/` and its e2e specs under `e2e/`.
- **Never edit anything under `dist/`** — it is build output and will be overwritten.
- After changing a package others depend on (`core`, `storage`, `runtime`), rebuild it before
  testing its dependents, or you will debug stale behaviour.

## Code style

Biome does **both** lint and format — there is no ESLint and no Prettier. Single quotes, semicolons,
2-space indent, 100-column width. Configuration in [`biome.jsonc`](./biome.jsonc).

```sh
npm run lint
npm run format          # writes; `npm run format:check` only checks
npm run typecheck
npm run check:asf-headers
```

Four rules that are not obvious from the config alone:

- **`apps/desktop/**` and `packages/ui/**` are formatter-excluded, but still fully linted.** Desktop
  ships source-contract tests that read `.ts`/`.tsx` source — its own and `packages/ui`'s — and
  regex-match exact single-line shapes, so a reformat breaks them. The reasoning is recorded in the
  `formatter.includes` comment in `biome.jsonc`. Do not reformat those paths by hand either.
- Byte-sensitive artifacts (`apps/desktop/resources/licenses/**`, `apps/desktop/bundled-tools.json`)
  are hashed for provenance verification. Never reformat them.
- **Several classes of file are generated; regenerate rather than hand-edit.** `*.generated.ts` is
  one naming convention, but not the only one: the Astryx theme
  (`npm run astryx:theme`), the surface inventory (`npm run astryx:surface-inventory:write`), the
  Windows test inventory (`npm run windows:inventory`) and `apps/desktop/bundled-tools.json` are
  also build outputs. Each has a check that fails when the committed copy drifts.
- Source files need the ASF license header, with a reviewed exclusion list —
  `npm run check:asf-headers` currently audits about 2,750 covered files and skips about 130,
  including generated and third-party files. Trust the checker rather than adding headers by hand:
  `node scripts/asf-license-headers.mjs write` adds what is missing. The check audits the whole
  checkout, so stray untracked files can fail it.

Match the surrounding code. This codebase comments the *why*, and frequently records the bug a
design choice was made to prevent. When you change such code, update that reasoning rather than
deleting it.

## Build, packaging and release

```sh
npm run build                       # all workspaces
npm run release:cli:pack            # build the CLI npm release candidate
npm run release:cli:smoke           # install and smoke-test that candidate
npm --workspace @maka/desktop run package:macos-arm64
npm --workspace @maka/desktop run package:windows-x64
```

Apache releases are source releases approved by the podling PPMC and the Incubator PMC; anything
built elsewhere is a convenience artifact. `npm run release:asf:source`, `release:asf:verify` and
`release:asf:sign` drive that flow, and `npm run check:release` gates the contracts. See
[`.github/ASF_SOURCE_RELEASE.md`](./.github/ASF_SOURCE_RELEASE.md).

## What CI enforces

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) is the authoritative list. Beyond lint,
format, build, typecheck and the test suites, it also runs `check:release`, `check:asf-headers`,
`check:asf-npm`, `check:asf-source`, `astryx:surface-inventory`, `astryx:theme -- --check`,
`windows:inventory`, `scripts/protocol-epoch-check.mjs`, Knip on `apps/desktop` and `packages/ui`,
Storybook and CLI release smokes, and the Desktop Playwright suite. If you touch the Runtime Host
wire protocol, expect the epoch guard to have an opinion.

## Pull requests

Branches are `<type>/<description>` and titles `<type>(<scope>): <summary>`, following
[Conventional Commits](https://www.conventionalcommits.org/); `git log` shows the types and scopes
in use. The repository squash-merges, so the PR title becomes the commit on `main`.

Opening a PR pre-fills [`.github/pull_request_template.md`](./.github/pull_request_template.md) —
fill it in rather than replacing it, and keep the description short and your own. Include
before/after evidence for UI changes. Every PR to `main` needs an approving review from a committer
other than the author and a passing `test` check; **AI review does not count** as that review.

**AI attribution is mandatory.** State whether generative tooling contributed substantively and name
the tool. When AI authors a material part of a contribution, add a `Generated-by: <tool>` trailer to
each affected commit and keep it through squash or amend. Translation, wording edits, autocomplete
and spelling correction do not count. Full policy in [CONTRIBUTING.md](./CONTRIBUTING.md) and the
[ASF Generative Tooling Guidance](https://www.apache.org/legal/generative-tooling.html). Contribute
only work you have the right to contribute, and record third-party sources and licenses.

## Working method

1. **Read the architecture doc for the area first.** Runtime behaviour is rarely local; a change in
   `packages/runtime` usually has a projection, a recovery path and a Host protocol consequence.
2. **Reproduce before fixing.** Write a failing test that demonstrates the defect, then fix it.
3. **Prove the test bites.** Re-run it against a build without your fix and confirm it goes red. For
   a test guarding *new* behaviour, check it against a plausible weaker version of the fix — a test
   that passes either way is not a guard.
4. **Watch for vacuous tests.** Several suites run against a fake backend rather than a real
   provider, and a fake can be more cooperative than production code. A green suite is not by itself
   evidence that the real path works; if a fake compensates for something, say so.
5. **Characterise pre-existing failures.** Before reporting a failing suite as pre-existing, run it
   against a clean checkout of the base branch, and say which suites you did not run.

## Platform notes

Desktop currently targets Apple Silicon; [Windows](./docs/windows-support.md) is an unsigned preview
and Linux is not yet a release target. A failure that looks platform-specific often is — check
before assuming a regression. `npm run windows:inventory` guards the Windows test inventory, and
Linux sandbox behaviour has its own smoke test in `packages/runtime`.

## About this file

Maka reads it. `buildWorkspaceInstructionsPromptFragment` injects workspace instructions into the
system prompt, so this file is live product input when Maka runs against this repository — worth
remembering when editing it.

Its loading scope is narrower than it looks: exactly the session `cwd` and `~/.maka`, with no walk
up through ancestors. A session started in a subdirectory therefore does **not** pick up this
repository-root file. `CLAUDE.md` here is a symlink to it, so the agents that read that name get the
same content.
