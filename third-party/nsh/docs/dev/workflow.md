# Contributor workflow

Reference for contributors; read the relevant section before changing its area.
Paths and shell commands below are relative to the repository root.
This page is loaded on demand, not imported as an agent instruction file.

## Commits and pull requests

Details and examples: "Commits and pull requests" in `CONTRIBUTING.md`.

- **All changes go through a pull request. Never push commits directly to `main`.** This includes code,
  documentation, release / version updates and CI / workflow fixes. Create a topic branch, push it and open a PR
  targeting `main`; merge through the PR after required checks pass. Do not use administrator bypass to skip this
  workflow. A request to release or push changes does not authorize a direct push to `main`.

- Subjects and PR titles are `<area>: <What the change does>`: the area in lower case (a crate without `nsh-`:
  `core`, `js`, `engine`, `bundler`, `cli`, ...; never `base`: a change to `nsh-base` names its component in snake
  case, `rich_editor`, `editor`, `input`, `data_table`, ...; one platform: `ios`, `android`, `macos`, `windows`,
  `linux`; `desktop` for macOS, Windows and Linux together, `mobile` for iOS and Android together; `runtime`, a module;
  `tailwind`, `text`, `docs`, `examples`, `gallery`). One area only, never several separated by commas: for a change
  that spans parts, judge it as a whole and name the part it is mostly about (a feature the core adds and the platforms
  carry out is `core`); then an imperative sentence starting with a capital letter, no trailing period, about 72 characters in all. Say what it does for NSH's users, not which
  files changed. Never conventional prefixes (`fix:`, `feat:`); check `git log` and match it.
- The body explains why (wrapped at 72 columns); hot path changes include their before / after `nsh test --trace` numbers.
- One commit / PR does one thing; no unrelated refactors, cleanup or formatting.
- A PR that adds, changes or removes public API (Rust items, JS exports, elements, props, style keys, Tailwind
  utilities, `nsh.json` keys, CLI flags, SDK APIs) lists every item under `## Public API` with its signature and one
  line on its purpose; changes to existing items also go under `## Breaking Changes` with `diff` blocks
  (`.github/pull_request_template.md`).
- A PR review presents, in order: the PR's purpose (the problem and the scope of the changes), whether the requirement
  and approach are reasonable, then concrete findings, the validation performed and its limits.
- **Scope comes first.** NSH stays a lightweight GUI framework, not an all-in-one platform. Fixes, performance,
  refinements of existing behavior and options of an existing component that are common in its domain are welcome;
  a new feature an app can build in Rust (its own crate, native components, platform APIs) or with existing APIs,
  that one app needs, or that does not work the same on every platform is not accepted, and one that would need a new
  section or page of the website's documentation opens a new direction, the hardest to accept (`CONTRIBUTING.md`
  "Scope: what NSH accepts"). A PR adding a new feature without a maintainer's agreement on an issue is flagged before its
  code is reviewed, and its review recommends closing it rather than polishing it.

## CI

The checks run on pull requests and on `main` every three hours when it moved (and on manual runs), not on every push to `main`: the
pull request already ran them, and the scheduled run saves the dependencies' caches pull requests restore. Each workflow runs only when what it builds changes: the Rust workflows list their crates one by one in `paths`,
derived from the dependency graph. A new crate, a new path dependency or a new workflow updates those lists
(`python3 .github/ci/paths.py --print`); the `CI paths` workflow fails when a list misses a crate its workflow builds.
It runs on every pull request: its `check` job is the status check main requires, so a pull request no other workflow
reports `check` for (one touching only `crates/gpui`) can still merge. The Compat workflow's `compat` job is required
too, so it also runs on every pull request, and its `dorny/paths-filter` step (held to the graph by `paths.py` the same
way) decides whether it builds and checks or passes at once.
Every pull-request workflow also handles `merge_group: checks_requested`, so GitHub's merge queue tests the
combined commit. Queue runs execute the full workflow without PR path filters; Compat always builds on a queue
run. Website deployment runs only on pushes and manual dispatches. `.github/ci/paths.py` checks the queue
trigger alongside the dependency paths.
Runners are the bottleneck, so a run takes one only when its result can still matter. Every pull-request
workflow takes `pull_request` `types: [opened, synchronize, reopened, ready_for_review, closed]` (`paths.py` checks
it), and its jobs skip drafts and the `closed` event: a draft runs nothing until it is marked ready, and closing or
merging a pull request starts a run that runs nothing but takes its concurrency group, cancelling the runs it still
has queued or running. The jobs that build (all but `CI paths`) are debounced: they name the environment
`ci-debounce` with `deployment: false`, whose wait timer holds them a few minutes without a runner, so a push
followed by another within that time cancels the first run before it starts. Each workflow's concurrency group is
the pull request's number, or the ref for pushes and queue runs (`github.event.pull_request.number || github.ref`):
a merged pull request's `closed` event carries the base branch as its ref, so a group of the ref alone would cancel
`main`'s run of the merge commit. Groups cancel in progress (Website's pushes to `main` queue instead: each one
deploys).
CI builds with huacnlee/cargo, as developers do: `.github/actions/cargo` installs a pinned release after the toolchain
and caches the dependencies' builds (`~/.cargo/targets/shared-deps`) with the registry, one cache per job, saved by
`main` and restored by pull requests. It builds without incremental state or debug info and ignores the toolchain
file's mobile targets (`RUSTUP_TOOLCHAIN=stable`) except in the release. Files a crate reads from outside its
directory (`include_bytes!`, test fixtures) go into its workflows' `files` in `paths.py`. Some checks run on
self-hosted runners (a job's `runs-on` says where); the jobs that hold write tokens or build what users download run
only on GitHub's runners (`docs/dev/tooling.md` "Runners").

## Parallel agents

Subagents and teammates never run `cargo build`, `cargo test`, `cargo clippy`, `cargo xtask` or `nsh test` (several
at once overload the machine); at most an occasional `cargo check -p <crate>` for compile errors. They write the
code and its tests and report which tests to run; the main session runs builds and tests itself, one at a time.

## Review and parallel workspaces

For PR reviews and work involving multiple agents, give each agent a Git worktree beside the repository
(`git worktree add ../nsh.worktrees/<name>`); with huacnlee/cargo ("Commands") they share one build directory, so a new
worktree rebuilds little. Read-only reviews that need no isolated workspace can inspect the checkout or Git objects
directly. Preserve the existing parallel-agent build and test limits. Keep source changes in Git and submit them through
pull requests.
