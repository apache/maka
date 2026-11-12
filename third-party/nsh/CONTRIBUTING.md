# Contributing Guide

Contributions are welcome. If you find a bug or have an idea, please open an issue or submit a pull request.

Please write clean code that follows the style and organization of the existing code, and make sure all tests pass.

Please submit **one PR that does one thing**. It makes your change easier to review and faster to merge.

Before writing code, read [AGENTS.md](AGENTS.md) (the project rules, commands and conventions) and the page of
[docs/dev](docs/dev/README.md) for the area you change.

## Scope: what NSH accepts

NSH is a lightweight, cross-platform GUI framework: native views, layout, text, input, animation, the reactive
runtime, unstyled base components, and the toolchain that builds, tests, packages and delivers the apps made with
them. It is not an all-in-one application platform in the manner of Electron. Small binaries, fast builds and fast
start-up are part of its design, and every feature added to NSH costs all of them for every app, including the
apps that never use it.

Apps extend NSH in Rust. An app's own crate can export Rust components, modules and classes to its TSX, register
native components, and call any platform API directly ([Building with Rust](website/docs/rust.md),
[Native components](website/docs/native-components.md), [Platform extensions](website/docs/platform-extensions.md)).
What one app or a few apps need belongs there, or in a community crate, not in NSH. The tools NSH already ships for
delivering apps (packaging, signing, updates) exist because every app needs to be delivered; they are not precedent
for adding other features.

NSH's directions are set, and each has its pages in the [documentation](website/docs/): layout, styling and text;
lists and scrolling; touch, gestures, forms and the keyboard; animation; navigation; accessibility; i18n; images,
media and web views; native components and platform integration; the sandbox, capabilities and signed packages; app
and OTA updates; and the toolchain that develops, tests and packages apps. Contributions work within these
directions. A feature that would need a new section or page of its own in that documentation opens a new direction:
it is the change to question hardest, it needs a maintainer's agreement on an issue first, and it is rarely accepted.

Most contributions we take improve what NSH already has. In order of preference:

- **Bug fixes**, on any platform.
- **Performance**: faster rendering, layout, scrolling and start-up, less memory, fewer mount items.
- **Refinements of existing behavior**: smoother animations and gestures, better input, focus and accessibility,
  details that make a platform feel right.
- **Completing existing components** within their domain. The components of `nsh/base` are not finished, and an
  option or part they lack is welcome when it is common in that domain. `Editor`, `DiffView`, `DataTable` and
  `RichEditor` especially are still far from what their domains offer, and contributions that fill those gaps are
  the ones we most want. Common in the domain means the design and API that comparable components (GPUI Kit's
  first, then well-known code editors, diff viewers, data grids and rich text editors) share. A `DiffView` option that diff viewers generally offer fits; one shaped by a single app's workflow does not,
  and belongs in the app, built on the component's parts and slots.
- **Bringing an existing feature to every platform** where a backend lacks it.

These need no prior issue.

A new feature, one NSH does not have in any form, is accepted only when all of these hold:

- **Apps cannot build it themselves**, with NSH's existing APIs or through the Rust extension points above. A
  WebView's page and the app already talk through `postMessage` / `onMessage` and `evaluate`, for example, so a flow
  that can go through that bridge needs no new API.
- **Many apps need it**, not one app's scenario.
- **It works the same on every platform NSH supports**, with a complete design. An API whose operations fail or do
  nothing on some platforms, or that covers a few cases of a larger problem, is not accepted, even with documented
  "unsupported" errors.
- **Its cost is measured and justified**: dependencies, binary size, build time and start-up time.

Not accepted, unless a complete design meets every point above: wrappers of individual platform APIs for specific
scenarios (WebView cookies, downloads, page capture, developer tools and similar controls), features only some
platforms can support, and options that serve one app.

Before writing a new feature, open an issue that answers these points and wait for a maintainer to agree. A pull
request that adds a feature without that agreement may be closed without a review of its code, however well it is
written.

Reviewers, people and AI agents alike, judge scope first: a pull request that adds public API or a dependency is
checked against this section before its implementation is reviewed.

## Component design standards

Native Shell provides native views, rendering, animation and interaction. Its goal is not to reproduce the default
appearance of iOS, Android, macOS or Windows controls. Apps need their own colors, typography, spacing, shapes and
state feedback; even a faithful system-styled button or switch cannot cover those design requirements. NSH supplies
customizable views and unstyled behavior so apps can build a coherent design across platforms.

Native integration is substantive: platform text fields provide text editing, selection menus, input methods and
supported autofill services; components expose focus and accessibility semantics; animation and input run through
the native runtime and platform backends. Preserve and improve these capabilities while leaving visual choices to
the app. Check the affected platform's documented support rather than assuming every backend has identical system
integration. See [Input](website/elements/input.md) and [Goals and design principles](website/docs/goals.md).

NSH provides the primitives and unstyled foundation, corresponding to [GPUI Kit](https://gpui-kit.com)'s `gpui` and `gpui-base` layers.
The styled-library role of `gpui-component` belongs to applications and third-party libraries. `nsh/base` should
solve complex behavior, reactive state, input, focus, accessibility and adaptive presentation, with tests at the
owning layer and customization through states, slots and parts. This includes complex workspace components such
as `Dock`; complexity is a reason to share behavior, not to prescribe appearance.

Website demos and Gallery are example applications. Their gradients, shadows, radii and motion exercise the
framework's customization capabilities; they are not default styling for the base components. Keep visual
experiments in examples and styled application/community components. Component implementations and PRs must
preserve this separation, including the existing documented exceptions for system-managed presentation and
`TextView` reading defaults.

Apply these boundaries when proposing components:

- **Common controls have one shared API.** Extend `nsh/base`'s `Switch`, `Button`, `Checkbox` and similar components.
  Expose the parts and states applications need to style them. Do not add a second system-styled control to a
  platform module: it would make apps select and maintain separate controls for the same behavior on each target.
- **Platform modules require a platform-specific interaction or capability.** `nsh/mobile` accepts mobile-specific
  capabilities whose role has no equivalent shared control. `TabBar` is the mobile system navigation bar, with its
  platform-managed interaction and presentation; it is not precedent for a catalog of native-looking form controls.
  A different appearance, size, tint or animation alone does not qualify a common control for this module.
- **Prefer a shared abstraction when the role is shared.** A notification or toast proposal should first establish
  a single cross-platform contract and adapt presentation internally where appropriate, rather than introduce
  parallel controls that applications must choose between. This is a design criterion, not a new API declaration.
- **Validate the integration.** Check input, keyboard and focus behavior, accessibility, intrinsic measurement,
  controlled state and customization on the affected targets, alongside the public API and compatibility checks.

[GPUI Kit](https://gpui-kit.com)'s separation of unstyled behavior and app-owned appearance informs NSH's component layers. NSH's platform
backends additionally integrate with platform view and text-input infrastructure. Custom-rendered frameworks must
supply their own integration with those services; rendering architecture alone does not establish whether a
particular framework supports accessibility or autofill.

## API design

NSH's public API follows [GPUI Kit](https://gpui-kit.com)'s coding guides: an API is shaped by what it means, not
by how a feature works today. [docs/dev/api-naming.md](docs/dev/api-naming.md) records each name and why it was
chosen; these rules apply when adding one.

- **Short, accurate, neutral names.** Name an API by what it does in one plain word where one exists, never by a
  phrase describing the feature or its mechanism: such a name ties the API to today's implementation and is longer
  to read and write. Reuse the project's word for the same concept before borrowing the web's: a ref's method that
  brings its view into view is `reveal`, as `Tree.revealItem` and `Editor.revealPosition` are, not the DOM's
  `scrollIntoView`.
- **Names match the semantics.** A borrowed name brings its meaning with it. When the behavior differs, choose a
  name that says what NSH does: physical alignments are `vertical` / `horizontal`, not the DOM's `block` / `inline`,
  which follow the writing direction.
- **Differences from GPUI Kit are written down.** A name, shape or option that differs from its GPUI, `gpui-base` or
  `gpui-component` counterpart gets a row in `docs/dev/api-naming.md` saying what it maps to and why.
- **Options are one named object.** Parameters that may grow are one options object named `<Method>Options`
  (`RevealOptions`), declared as a named TypeScript type that apps can import, not an inline object type.
- **Rust options read as one expression.** An options struct is `#[non_exhaustive]` with `Default` and public fields,
  plus a setter per field that takes and returns `Self`, so a caller in another crate writes the value in place:

  ```rust
  row.reveal(RevealOptions::default().vertical(ScrollAlignment::Center));
  ```

- **Generated from one definition.** A string union is a Rust enum with `#[derive(PropEnum)]` (and
  `#[non_exhaustive]`), never a hand-written `from_name`, a union typed out in a declaration or a list of names in an
  error message. A value JS passes is decoded by one `HostValue` implementation in `nsh-core`, which QuickJS and the
  browser runtime share and which declares its TypeScript type, never by a decoder written once per runtime.

## NSH and React Native

NSH has a design of its own, and React Native is a reference for which capabilities a mobile UI framework
needs, not an API to be compatible with: names follow React Native where the behavior is the same, and differ where
NSH's design differs (SolidJS instead of React, Tailwind classes resolved natively, primitives instead of
platform-styled widgets). A change that only adds React Native compatibility, such as a wrapper or an alias, is not
accepted.

The runtime (`nsh`, `nsh/<module>`) provides primitives and capabilities, and `nsh/base` the unstyled foundation of
an app's UI (navigation, safe areas, system dialogs, the keyboard, the status bar); the look of an app is the app's
own, drawn from those primitives or with Rust components in the app's crate. See "Where new things go" in [docs/dev/js-modules.md](docs/dev/js-modules.md).

## AI-Assisted Contributions

NSH fully embraces AI-assisted development. We welcome contributions written with AI, including pull requests where
100% of the code was generated by AI.

What matters is not who wrote the code, but whether the change is thoughtful, focused, and well validated. The
contributor is always responsible for the final result.

Before opening a pull request, please make sure that:

- The problem is real and the change is necessary, and a new feature is within [NSH's scope](#scope-what-nsh-accepts).
- The API and implementation follow the existing patterns of NSH, and the rules in [AGENTS.md](AGENTS.md).
- The code has been reviewed by you and properly tested: tests at the layer that owns the behavior, `nsh test --trace` for
  the JS runtime, engine and core, and a run on a simulator, emulator or device for platform code (screenshots or
  recordings are encouraged for UI changes).
- A pull request focuses on one thing and keeps the diff as small as practical. When using AI, ask it to avoid
  unrelated refactors, cleanup, or formatting. **Less is better.**

### Describe public API changes

A pull request that adds, changes or removes anything public — a Rust type or function, a JS export, a host element,
a prop, a style key, a Tailwind utility or variant, an `nsh.json` key, a CLI command or flag, a Swift or Java API of
the SDKs — lists it in the description under a `## Public API` section, grouped by crate or module, with the
signature as a reviewer would read it in the docs. Say what each item is for in one line; a name alone is not enough.
The reviewer should be able to judge the API from the description without reading the diff.

Changes to existing public items go under `## Breaking Changes` with a `diff` block showing the old and the new
usage, even when the old form still works. Additive changes are not breaking, but they are still listed.

What apps use — JS exports, `nsh:rt`, globals, elements, props, events, style keys, Tailwind utilities, their
declarations and behavior — is never broken once a release shipped it: apps built for an earlier compatible release
keep running unchanged ([docs/dev/compatibility.md](docs/dev/compatibility.md)). Such a change adds and deprecates
instead of removing. Releases are recorded in [nsh-compat](https://github.com/longbridge/nsh-compat), and
`cargo xtask compat` holds a checkout to them; a new API comes with a case in `tests/compat/` whose script checks it.

Well-prepared pull requests are easier for us to review and may be merged very quickly. If a contribution is already
in good shape, maintainers may directly help polish small details and move it forward.

Issues are always welcome, but when practical, we encourage you to try a fix and open a pull request. Concrete code
often communicates a problem more efficiently than a long discussion. A pull request is still subject to review and
is not a guarantee that the proposed change will be accepted.

## Commits and pull requests

Commit subjects and pull request titles name the area first, then say what changed as an imperative sentence:

```
<area>: <What the change does>
```

- The area is the part of NSH the change is about, in lower case: a crate without its `nsh-` prefix (`core`,
  `animation`, `js`, `engine`, `package`, `bundler`, `dev`, `cli`, `xtask`), a component of `nsh-base` by its name in snake case, never `base` (`rich_editor`,
  `editor`, `input`, `data_table`), a platform (`ios`, `android`, `macos`,
  `windows`, `linux`), a JS layer or module (`runtime`, `list`, `animated`, `navigation`), or `tailwind`, `text`, `docs`, `examples`, `gallery`, `ci`. A change to all the desktop
  backends (macOS, Windows and Linux) is `desktop`, one to both mobile platforms (iOS and Android) is `mobile`. Name
  one area only, never several separated by commas: when a change spans several, look at it as a whole and name the
  part it is mostly about. A feature the core adds and the platforms carry out is `core`, not `core, desktop`; a
  change everywhere names its subject (`signed packages: …`).
- The sentence starts with a capital letter, uses the imperative mood, has no trailing period and fits in about 72
  characters with its area. It says what the change does for a user of NSH, not which files moved: `list: Keep the
  visible rows in place when items are inserted above them`, not `list: Update list.rs`.
- Do not use conventional prefixes (`fix:`, `feat:`, `chore:`). Pull requests are squash merged and GitHub appends
  their number: `tailwind: Make flex a row as in CSS (#12)`.
- The body (optional for small changes) explains why, wrapped at 72 columns: the problem, the approach and what it
  costs. A change to a hot path includes its before / after `nsh test --trace` numbers.

Examples:

```
tailwind: Make flex a row and block use block layout, as in CSS
list: Keep the visible rows in place when items are inserted above them
mobile: Answer the back gesture from popOnBack without asking JS
desktop: Keep the keyboard focus inside the newest dialog
cli: Add `nsh package --target ios` for signed .ipa files
docs: Describe the capability checks of fetch redirects
```

## Development and Testing

### Merge queue

Pull requests targeting `main` use GitHub's merge queue. Once the required checks pass, select **Merge when
ready** to join the queue. The queue checks the combined commit against the current `main` and preceding
entries, then squash merges it. A failing check removes the entry; fix the failure and enqueue it again.

### System dependencies

- Rust through rustup: `rust-toolchain.toml` selects stable and installs the iOS and Android targets. A nightly
  toolchain for `cargo +nightly fmt`.
- [huacnlee/cargo](https://github.com/huacnlee/cargo), recommended: a drop-in Cargo fork whose Git worktrees share one
  build directory that stays under a size limit on its own, with nothing to configure. Install it with
  `curl -fsSL https://huacnlee.github.io/cargo/install.sh | sh` (Windows:
  `irm https://huacnlee.github.io/cargo/install.ps1 | iex`). It replaces `~/.cargo/bin/cargo`, updates itself, and its
  README says how to put rustup's back.
- Xcode, for the iOS, simulator and Mac Catalyst targets.
- For Linux: the GTK 4 (4.14 or later) development packages (`libgtk-4-dev`, `gtk4`,
  `gtk4-devel`), WebKitGTK 6.0's for web views (`libwebkitgtk-6.0-dev`, `webkitgtk-6.0`,
  `webkitgtk6.0-devel`; the Linux hosts build with them by default) and clang.
- For Windows (10 1809 or later): Visual Studio Build Tools with the C++ workload and the Windows SDK, and LLVM
  (libclang, for QuickJS' bindings; found in `C:\Program Files\LLVM`, else set `LIBCLANG_PATH`). If rustc overflows
  its stack on the `windows` crate, set `RUST_MIN_STACK=268435456`.
- For Android: the Android SDK (`ANDROID_HOME`, or `~/Library/Android/sdk`; `%LOCALAPPDATA%\Android\Sdk` on Windows) with platform 35 and build tools, an NDK
  (set `ANDROID_NDK_HOME` if the newest one installed is incomplete) and a JDK.

### Checks

Run these before opening a pull request (the full list is in [AGENTS.md](AGENTS.md)):

```sh
cargo test --workspace
cargo +nightly fmt --all
cargo clippy --workspace --all-targets
cargo clippy -p nsh-platform-ios -p nsh-ios-host -p nsh-ios-app --target aarch64-apple-ios-macabi --features nsh-platform-ios/embed,nsh-platform-ios/dev
cargo xtask clippy-android
cargo clippy -p nsh-platform-linux -p nsh-linux-host -p nsh-linux-app --all-targets   # on Linux
cargo clippy -p nsh-platform-windows -p nsh-windows-host -p nsh-windows-app --all-targets   # on Windows
```

`nsh-platform-ios` and `nsh-platform-android` are empty crates on a macOS host, and the Linux and Windows crates are
empty off their systems, so platform code is only checked by the platform-specific clippy runs above.

### Run the examples

`examples/gallery` has a demo for every area of NSH. If you change an existing feature, run the related demo on the
platforms it touches. `cargo run` runs the gallery on the machine's own desktop backend (an AppKit window on macOS, a GTK window on Linux, a Win32 window on Windows): it builds
the CLI and the development host, reloads JS and TSX in place, and rebuilds and restarts the app whenever Rust code
under `crates/` changes (components and modules are Rust and live in the host). Ctrl-C stops it.

```sh
cargo run                                      # the gallery in an AppKit (macOS), GTK (Linux) or Win32 (Windows) window
cargo run -- examples/counter                  # another app: its directory (App.tsx is the entry) or entry module
cargo run -- --target catalyst                 # in the Mac Catalyst window (UIKit, phone-style)
cargo run -- --target ios                      # in an iOS simulator
cargo run -- --target android                  # on an Android device or emulator
```

`nsh run` itself works too; in a checkout it builds the host it needs first:

```sh
cargo build -p nsh-cli
./target/debug/nsh run examples/gallery                    # Mac Catalyst window
./target/debug/nsh run examples/gallery --target ios       # iOS simulator
./target/debug/nsh run examples/gallery --target android   # emulator or device
./target/debug/nsh run examples/gallery --target linux     # GTK window (the default on Linux)
./target/debug/nsh run examples/gallery --target windows   # Win32 window (the default on Windows)
```

### Reviewing UI and platform changes

When reviewing a UI or platform change, check whether the tests and the description cover the behavior the pull
request claims, including its states and edge cases, on both iOS and Android. If coverage is missing, describe the
specific gap. Ask for a manual check only for what automated tests cannot exercise, and name the scenario and the
platform: input methods, the software keyboard, VoiceOver / TalkBack, gestures, system dialogs and platform-specific
rendering are typical examples.

## Performance

Performance is NSH's first priority (the rules are in [AGENTS.md](AGENTS.md)). A change to a hot path (the JS
runtime, the op buffer, the core, layout, text, lists, mounting) comes with before / after `nsh test --trace` timings and
mount item counts, compared with the baselines in [docs/dev/performance.md](docs/dev/performance.md); update the
baselines when they move.

```sh
./target/debug/nsh test examples/counter/App.tsx --trace
cargo build --release -p nsh-cli
echo 'await app.scroll("id:photos", 3000)' | ./target/release/nsh test examples/gallery/Bench.tsx --trace
cargo test --release -p nsh-engine --test list_bench -- --ignored --nocapture
```

Single-frame timings depend on the CPU's clock state; judge optimizations by the back-to-back and flushed-cache
numbers of `list_bench` (see the performance page). On devices, profile with Instruments (iOS) or the Android Studio
profiler.
