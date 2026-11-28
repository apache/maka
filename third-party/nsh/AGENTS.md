# Working on Native Shell

NSH embeds dynamically delivered native UI in apps and also supports standalone apps.
Rust owns the runtime, reactive graph, layout and renderer; QuickJS runs app code
(the browser's JavaScript engine on web). The toolchain is Rust, without Node.js.

## Architecture and scope

- `nsh-core`: primitives, typed geometry, styles, layout and reactivity; no platform or JS dependency.
- `nsh-base`: unstyled functional components, state, input, focus and accessibility;
  depends on core only. Primitives import from `nsh`, components from `nsh/base`.
  Shared controls have one cross-platform API. Styled libraries belong to apps and
  the community; platform modules are for distinct platform capabilities.
- `nsh-js` → core; `nsh-engine` → JS/core/package; platforms → engine; hosts/runners → platforms.
  Components are Rust; JS faces and TypeScript declarations are generated from specs.
  An app's Rust UI set is linked into generated hosts, never into the CLI.
- `crates/gpui/` is a separate workspace with its own dependencies and lockfile.
  Root workspace checks do not build it. Desktop standalone backends are AppKit,
  Win32 and GTK; GPUI serves embedding. iOS uses UIKit, Android native views, web HTML.
- Check [CONTRIBUTING.md](CONTRIBUTING.md), especially scope and API design, before
  reviewing implementation. New directions require maintainer agreement first;
  app-specific functionality belongs in the app's Rust/native extension points.

## Find the relevant guidance

Read the owning area's page in [docs/dev/README.md](docs/dev/README.md) and its module
comments before editing. Read only the relevant sections of these reference pages:

| Work | Reference |
|---|---|
| Code locations, components, documentation ownership | [Repository map](docs/dev/repository-map.md) |
| Code, APIs, units, styles, events, errors, generated protocols | [Engineering constraints](docs/dev/engineering.md) |
| Build, platform prerequisites, packaging, signing, native testing | [Commands](docs/dev/commands.md) |
| PRs, reviews, CI scheduling, caches, parallel work | [Workflow](docs/dev/workflow.md) |
| Public names and compatibility | [API naming](docs/dev/api-naming.md), [compatibility](docs/dev/compatibility.md) |
| User docs and website copy | [Writing user docs](docs/dev/writing-docs.md) |
| Platform code | [Pitfalls](docs/dev/pitfalls.md) and the platform's dev page |
| Hot paths | [Performance baselines](docs/dev/performance.md) |

These pages are references, not recursive instruction imports. `CLAUDE.md` imports
only this file. Keep automatically loaded instructions small; do not import the
reference collection wholesale. Paths in the references are repository-relative.

## Constraints to keep in mind

- Follow conventions before adding configuration, scripts or environment overrides.
  NSH-generated files go in `.nsh/`; preserve normal Cargo target/cache behavior.
- One surface is one engine; no global singletons. The main thread never waits for
  JS: immediate system decisions come from previously mounted props, events follow.
  Enforce capabilities, quotas and validation in Rust. QuickJS bytecode is trusted
  input and loads only from app resources, the dev server or verified packages.
- Generate declarations, props, events and encoded operations from their Rust specs,
  never hand-copy `.d.ts` or protocol constants. Keep event payloads, Android JNI maps,
  Java opcodes, bytecode versions and image scales in sync (engineering reference).
- API names follow NSH's existing vocabulary, then GPUI Kit/GPUI and established APIs;
  document deviations in `docs/dev/api-naming.md`. Use typed units and colors (`Hsla`),
  extensible options and event objects, per-element refs and stable error codes.
  New public structs are non-exhaustive with sensible defaults. New Rust elements use
  no-content constructors plus builder methods, not element/prop macros.
- Preserve every released compatible API's signatures, semantics and defaults,
  including `nsh:rt`, styles, formats and Tailwind. Rename by adding a deprecated alias to the
  same implementation, never by removing the old path. Check the actual recorded
  releases and documented security closures; unrecorded APIs are not frozen. New APIs get cases in `tests/compat/`.
- Rust styles, TSX style keys and Tailwind describe the same properties; Tailwind v4
  means its generated CSS. Unsupported input is rejected, never silently reinterpreted.
  Pointer-driven motion tracks the pointer in the same frame; discrete changes animate.
- Use `cx`, English comments/docs/logs, documented public API, `pub(crate)` in private
  modules and `// SAFETY:` on unsafe blocks. Library logs use `log`; CLI uses `ui.rs`.
  Dependencies live in workspace dependencies; new crates inherit workspace lints.
  Keep integration tests in the crate's existing single test binary.
- Reproduce defects and trace the faulty state to its origin. A refactor needed to fix
  that cause belongs in scope; migrate callers and remove obsolete internal paths.
  Preserve released public compatibility. Avoid unrelated cleanup; do not hide faults
  behind retries, swallowed errors or guards without establishing why they are valid.
  Comments explain real constraints and why code exists; retain API and safety docs.

## Verification

Run checks appropriate to the changed code; report unavailable targets and concrete
validation gaps. Documentation-only edits validate links, commands and instruction
coverage rather than rebuilding unaffected code.

```sh
cargo test --workspace
cargo +nightly fmt --all
cargo clippy --workspace --all-targets
```

Platform crates can compile as **empty crates on the wrong target**. Check changed
platform code on its real target, using [commands](docs/dev/commands.md):

```sh
cargo clippy -p nsh-platform-ios -p nsh-ios-host -p nsh-ios-app -p nsh-extra --target aarch64-apple-ios-macabi --features nsh-platform-ios/embed,nsh-platform-ios/dev,nsh-extra/camera,nsh-extra/photos,nsh-extra/location,nsh-extra/push,nsh-extra/share,nsh-extra/speech
cargo xtask clippy-android
cargo clippy -p nsh-platform-linux -p nsh-linux-host -p nsh-linux-app --all-targets
cargo clippy -p nsh-platform-macos -p nsh-macos-host -p nsh-macos-app -p nsh-extra --all-targets --features nsh-platform-macos/dev,nsh-extra/location,nsh-extra/share,nsh-extra/speech
cargo clippy -p nsh-platform-windows -p nsh-windows-host -p nsh-windows-app -p nsh-extra --all-targets --features nsh-extra/speech
cargo clippy -p nsh-platform-web --target wasm32-unknown-unknown --features compiler
cargo clippy -p nsh-extra --target wasm32-unknown-unknown --features nsh-extra/location,nsh-extra/share,nsh-extra/speech
cargo clippy --manifest-path crates/gpui/Cargo.toml --all-targets --features nsh-platform-gpui/dev
cargo test --manifest-path crates/gpui/Cargo.toml
cargo +nightly fmt --manifest-path crates/gpui/Cargo.toml --all
```

- Runtime/engine/core changes: build `cargo build -p nsh-cli`, then run
  `./target/debug/nsh test examples/counter/App.tsx --trace`; inspect mount counts and
  timings. Anything apps use also needs `cargo xtask compat` and matching compat cases.
- Platform changes: launch the affected demo, exercise input and capture screenshots
  on the affected platforms. Tests and screenshots must demonstrate the claimed fix;
  headless success does not prove native rendering. See commands for native test drivers.
- Gallery and website demos share `examples/nsh-gallery-ui/`; keep shared styling there.
  Gallery demos must look refined, use theme tokens and existing photos, avoid clipping
  and uneven alignment, and be checked in light and dark screenshots.
- Update relevant dev/module docs and English/zh-CN user docs with behavior changes.
  Keep skill copies synchronized with their source guides/recipes. User-facing copy
  describes capabilities positively; formal product name is Native Shell.
- New crates, dependencies or externally included fixtures must update CI path lists:
  `python3 .github/ci/paths.py --print`. Preserve merge-queue triggers and CI checks.
- Subagents do not build/test/clippy/xtask; only occasional targeted `cargo check`.
  The main session runs builds and tests one at a time. Isolate parallel edits as the
  user's workspace instructions permit; read-only reviews can inspect Git objects.

## Performance rules (the project's first priority)

1. **QuickJS is the slowest link: JS does as little as possible.** Only the app's code is JS: the reactive graph, the renderer and
   the modules are native, and compiled JSX calls them directly. Parsing, diffing and string processing all happen in Rust. No JSON
   serialization on the JS side.
2. **Cross threads in batches.** One JS turn → its ops queued natively (`Shared.ops`) → one `Core::commit` → one `MountBatch` → one
   main-thread hop. Never cross FFI or threads per item.
3. **No needless allocation on hot paths.** Node ids are dense: index `Vec`s (`slots`), not hash maps. Internal links use slab keys. Reuse
   buffers (`take_ops`, `queue`).
4. **Do not send mount items that are not needed.** New views get no default style and no empty event mask; unchanged styles and frames are not
   sent. Check item counts with `nsh test --trace`.
5. **Text**: measurements are cached per constraint (`TextContext.cache`); platforms cache font objects (`FontCache`).
6. **Changes to hot paths come with before / after `nsh test --trace` timings and item counts**, compared with the baselines
   in `docs/dev/performance.md` (update them when they move).
7. **Changes to window showing, frame scheduling or scrolling come with `examples/bench/jank/jank.py` results** from before and
   after the change, on each desktop the change touches. The jank benchmark does not run in CI, so the PR is where a startup
   wait or a long frame gets caught.

## Delivery

All changes go through a topic branch and PR, including releases and CI fixes.
Never push directly to main or bypass required checks. Titles are
`<area>: <Imperative sentence>` (one lowercase area; component name rather than `base`;
no conventional `fix:`/`feat:` prefix). Follow CONTRIBUTING for examples and review order.
List every public change with signature and purpose under `## Public API`; changed
existing items also need `## Breaking Changes` and old/new usage diff blocks.
One PR solves one problem, including necessary root-cause refactoring.
