# Contributing to Maka

[![docs](https://img.shields.io/badge/docs-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-blue?logo=googletranslate&logoColor=white)](./CONTRIBUTING.zh-CN.md)

- [Where to start](#where-to-start)
- [Quick start](#quick-start)
- [Developing Maka](#developing-maka)
- [Branch naming](#branch-naming)
- [Pull requests](#pull-requests)
- [License](#license)

## Where to start

These changes merge most readily:

- Bug fixes
- Model provider support — a new provider, or a fix to an existing one
- Tests and stability work
- Performance improvements
- Documentation
- Fixes for environment-specific problems

Product and UI changes are different: open an issue and agree the direction
before implementing. Maintainers land features directly because they set that
direction; an outside contributor is better off confirming it first.

Looking for something to pick up:

- [`help wanted`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)
- [`good first issue`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
- [`bug`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3Abug)
- [`enhancement`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement)

To claim one, say so in a comment and a maintainer may assign it to you.

Prefer the **Bug report** or **Feature request** template when opening an issue —
they ask for the context that makes one actionable. Report security problems through
the private flow in [SECURITY.md](./SECURITY.md), never as a public issue.

## Quick start

| Requirement | Value |
| --- | --- |
| Node | `>=22.19.0` (`engines`, root `package.json`) |
| npm | `11.12.1` (`packageManager`) |
| Platform | macOS Apple Silicon for desktop work. Releases also ship an unsigned Windows x64 build and CI runs a non-blocking `windows_baseline` job, but Windows and Linux are not supported targets yet |

```sh
git clone https://github.com/maka-agent/maka-agent.git
cd maka-agent
npm install                 # root only — never inside a workspace
npm run build               # builds every workspace in dependency order
npm --workspace @maka/core test
```

Architecture is documented in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Developing Maka

### Running

```sh
npm run dev          # desktop app with HMR
npm run dev:full     # full build, then launch the desktop app

npm --workspace maka-agent exec -- maka          # TUI
npm --workspace maka-agent exec -- maka run "…"  # one non-interactive turn
```

Evaluation commands and contracts live in [`packages/eval`](./packages/eval).

### Building

`npm run build` builds workspaces in dependency order:

```
code-mode → core → storage → mcp → runtime → runtime-host
          → computer-use → eval → maka-agent → ui → desktop
```

Building one workspace only succeeds when its dependencies are already built —
`@maka/runtime` compiled against a stale `@maka/core` produces type errors that
look like problems in the code you just wrote. When unsure, build from the root.

The desktop app has four outputs; `build:test` covers the first three:

```sh
npm --workspace @maka/desktop run build:main      # main process
npm --workspace @maka/desktop run build:preload   # preload bridge
npm --workspace @maka/desktop run build:overlay   # overlay windows
npm --workspace @maka/desktop run build:renderer  # renderer
```

### Testing

Tests run against compiled output in `dist/`. Every workspace's `test` script
cleans, builds, then runs `node --test`. **Always go through it** — calling
`node --test` after a bare `build:*` executes orphaned artifacts from older
trees, which fail on imports that no longer resolve.

```sh
npm test                                 # all workspaces
npm --workspace @maka/core test          # one workspace
npm --workspace @maka/desktop run e2e    # Playwright
```

### Before pushing

CI runs these; matching them locally avoids a slow round trip.

```sh
npm run lint            # biome lint
npm run format:check    # biome format — separate from lint; passing one proves nothing about the other
npm run build
npm run typecheck       # 4 tsconfig projects for desktop, including renderer and storybook
npx knip --workspace apps/desktop
npx knip --workspace packages/ui
```

The CI job named `typecheck` runs all of them under `bash -e`, so the first
failure aborts the rest — read which step failed, not the job name.

## Branch naming

```
<type>/<description>
```

`<description>` is lowercase and hyphen-separated. `<type>` must be one of:

| Prefix | Meaning |
| --- | --- |
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Behavior-preserving restructuring |
| `test` | Test-only change |
| `chore` | Build, dependency, and housekeeping work |
| `perf` | Performance improvement |
| `docs` | Documentation-only change |
| `ci` | CI configuration and pipelines |
| `build` | Build system and artifacts |

## Pull requests

Opening a pull request pre-fills
[`pull_request_template.md`](./.github/pull_request_template.md), which carries
the required sections and the checklist. Fill it in rather than replacing it.

**Title.** The repository squash-merges, so the title becomes the commit on
`main`. Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>
```

`<type>` is the set in [branch naming](#branch-naming). `<scope>` is the
workspace or area — `desktop`, `ui`, `runtime`, `eval`, `settings`,
`runtime-host`, `storage`, `core`, `cli`, `deps`, `computer-use`, `scripts`,
`release`, `windows`, `e2e`, `security`, and so on — `git log` shows the set
in use.

```
fix(desktop): classify provider action errors from the unwrapped IPC message
feat(runtime): decouple Swarm with asynchronous wakeups
test(core): pin the shared validation corpus to every envelope value domain
```

**UI changes.** Include before/after screenshots or a recording. A visual change
cannot be judged from a diff.

**Keep the description short and your own.** Long generated write-ups slow
review down. Say what changed and why in your own words; if that needs many
paragraphs, the pull request is probably too large.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE).
