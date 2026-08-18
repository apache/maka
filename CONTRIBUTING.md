# Contributing to Maka

[![docs](https://img.shields.io/badge/docs-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-blue?logo=googletranslate&logoColor=white)](./CONTRIBUTING.zh-CN.md)

- [Where to start](#where-to-start)
- [Public decisions](#public-decisions)
- [Human ownership and AI attribution](#human-ownership-and-ai-attribution)
- [Review and fast path](#review-and-fast-path)
- [Provenance and licensing](#provenance-and-licensing)
- [Quick start](#quick-start)
- [Developing Maka](#developing-maka)
- [Branch naming](#branch-naming)
- [Pull requests](#pull-requests)

## Where to start

These changes merge most readily:

- Bug fixes
- Model provider support — a new provider, or a fix to an existing one
- Tests and stability work
- Performance improvements
- Documentation
- Fixes for environment-specific problems

For project direction, governance, or material product decisions, follow the public decision process below before implementing a change.

Looking for something to pick up:

- [`help wanted`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)
- [`good first issue`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
- [`bug`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3Abug)
- [`enhancement`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement)

To claim one, say so in a comment and a maintainer may assign it to you.

Prefer the **Bug report** or **Feature request** template when opening an issue —
they ask for the context that makes one actionable. Report security problems through
the private flow in [SECURITY.md](./SECURITY.md), never as a public issue.

## Public decisions

Discuss project direction, governance, and material product decisions publicly before implementation, and record the reasoning. Once an ASF development list is available, project-level decisions should move there. Implementation-level technical decisions may be discussed in the pull request when the reasoning remains public and reviewable.

## Human ownership and AI attribution

Every contribution must have a human contributor of record. That person reviews the work, decides to submit it, and accepts responsibility for its accuracy, provenance, licensing, and any applicable ICLA representations. Agents may prepare changes, but they may not use ASF credentials or push commits to ASF repositories.

Disclose generative tooling when it makes a substantive contribution to code, documentation, analysis, or a project position. Disclosure is not required when a human determines the facts and position and the tool only translates, edits wording, autocompletes, or corrects spelling. Automated messages must identify themselves.

Every pull request must state whether generative tooling made a substantive contribution. If it did, name the tool and briefly describe its scope. If it did not, explicitly state that no generative tool made a substantive contribution.

When AI authors a material part of a contribution, Maka project policy requires the final commit on the target branch to name the tool:

```text
Generated-by: <tool>
```

Add the trailer to each pull request commit that contains material AI-authored content, and ensure it survives squash or amend in the final commit.

## Review and fast path

Material changes to user-visible behavior, public contracts, security, licensing, releases, or governance require independent review by another human. AI review does not count as independent human review. This requirement is separate from the human contributor of record, who is required for every contribution.

A contribution may use the fast path and be merged without independent human review only when it is low impact, easy to reverse, does not affect a protected area above, and passes the required checks.

When using the fast path, the person merging the pull request must comment on how the final revision meets these criteria. Any later commit requires a fresh determination and comment. A maintainer makes the final determination. Tests, CI, documentation, and mechanical changes may qualify, but their file type does not exempt them from review.

## Provenance and licensing

Submit only work that you have the right to contribute. Record third-party sources, licenses, and required attribution. Correctness review does not establish where content came from. For material AI-generated content, check the tool's output terms and scan non-trivial or suspicious output for third-party matches. Follow the current [ASF Generative Tooling Guidance](https://www.apache.org/legal/generative-tooling.html).

By contributing you agree that your contributions are licensed under the [Apache License 2.0](./LICENSE).

## Quick start

| Requirement | Value |
| --- | --- |
| Node | `>=22.19.0` (`engines`, root `package.json`) |
| npm | `11.19.0` (`packageManager`) |
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

npm run cli:dev                                  # TUI with the Maka Dev profile
npm run cli:dev -- run "…"                       # one non-interactive turn
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
