---
name: nsh
description: 'Build, run, test and package Native Shell (NSH) apps in Rust, TSX or both. Use for NSH development requests and projects with nsh.json, nsh-* crate dependencies or imports from nsh modules. Covers NSH reactivity, components, styling and tooling, with Coding Guides and working app recipes.'
---

# Native Shell

One app, written in Rust, in TSX, or in both, rendered through each platform's own
views on the same Rust engine. Follow the user’s chosen language and delivery model.
When neither is specified, prefer Rust for an app shipped in its binary.

## Establish the App's Design System First

Before building feature screens, read the Design and Coding Guides and establish
or reuse the app's design standards, semantic Theme Tokens and styled component
library. Keep them in the app repository. `nsh-base` (`nsh/base`) supplies unstyled
behavior, as [`gpui-base`](https://gpui-kit.com/base) does; the styled layer analogous to [`gpui-component`](https://gpui-kit.com/component)
belongs to the app or its chosen community library.

Define theme colors centrally and consume semantic tokens throughout pages,
components and states: `theme()` in Rust; token classes or `token()` in TSX.
Do not introduce raw hex, RGBA/HSLA or palette classes in presentation code. Add
missing roles to the theme first. User-selected or data colors remain data.
Build complete styled controls for the feature's needs, then compose pages from
them; extend shared variants instead of restyling base controls per screen.

Choose the app's Desktop, Mobile, Web and TUI targets explicitly. Adapt density,
navigation, input and overlays to those targets, preserving shared semantics.
TUI uses character Cells and terminal colors; Web follows the device's input.
Review token use, component reuse and platform states before finishing. For a
narrow change, extend the existing system within the requested scope.

## Choose the Mode, Then Read Its Page

| | 1. Rust (preferred) | 2. Rust with TSX | 3. TSX |
| --- | --- | --- | --- |
| Choose it when | The app ships in its binary; medium and large apps, demanding logic | A Rust core, plus screens that change often or arrive as signed packages | UI delivered at run time, with no Rust of your own |
| Runs on | The engine and your crate; no JavaScript VM | QuickJS (the browser's engine on the web) with your crate | QuickJS (the browser's engine on the web) |
| Start | `nsh init my-app --template rust` | `nsh init my-app --template mixed` | `nsh init my-app --template ts` |
| How to recognize one | `nsh.json` has `"rust"` and `"root"` | `nsh.json` has `"rust"`, no `"root"`, and a TSX entry | `nsh.json` has no `"rust"` |
| Edits | Rebuild and restart | TSX hot, Rust restarts | Hot |
| Read first | [rust.md](references/rust.md) | [mixed.md](references/mixed.md), and rust.md for the crate | [tsx.md](references/tsx.md) |
| Components | [rust-ui.md](references/rust-ui.md) | Both | tsx.md, `.nsh/types` |
| Tests | [rust-testing.md](references/rust-testing.md) | mixed.md "Tests on both sides" | tsx.md, [testing guide](https://nsh.dev/docs/testing-and-trace.md) |
| Whole app | [rust-recipe.md](references/rust-recipe.md) (`examples/tasks-rs`) | `examples/rust-exports` | [tsx-recipe.md](references/tsx-recipe.md) (`examples/tasks`) |

In an existing project, stay in its mode unless the user requests a change. For a new
app, honor the requested mode; otherwise use the table above; a Rust app can gain TSX later, because it already has a
`#[native_module]`. [tooling.md](references/tooling.md) covers the commands, debugging, platforms,
capabilities, packaging and updates in all three.

**The rule of every mode: a component runs once, and only the bindings that read a
changed signal run again.** A value read in a component body is a snapshot.

## First App or Existing Project

Resolve `references/` paths relative to this skill’s directory, not the app’s working
directory. Read only the mode and topic pages needed for the task.

- **Existing project:** inspect `nsh.json`, the entry and, for Rust, `Cargo.toml`.
  Keep its structure, dependency sources and mode. Use the project’s CLI version.
- **First app:** run `nsh --version`. For Rust or mixed, also check `cargo --version`.
  If a tool is missing, read [tooling.md](references/tooling.md#first-run-setup)
  for setup and the prerequisites of the requested target.
- Read the guides below and the selected mode page. Initialize with the table’s
  explicit `--template` in the user’s chosen location. Work from the generated
  project, preserving its manifest and entry wiring; the quick-start snippets below
  illustrate edits, rather than replacing all generated files.
- Get the generated app through `nsh check` and `nsh test` before expanding it.
  Then implement the requested flow and use the mode’s verification loop below.
  Check the visible result on the requested target when available; report any
  verification that the environment cannot perform.

## Read the Guides First

Two guides hold the rules this skill assumes. They are requirements, not
inspiration. Read the guide file itself; do not answer from this page, from a
similar file in the codebase, or from training data.

| Guide                                        | Read before                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Design Guides, skill `nsh-design-guides`     | Choosing components, layout, spacing, hierarchy, color, density, interaction states, overlays, motion, interface copy        |
| [Coding Guides](references/coding-guides.md) | App structure, what runs once, state ownership, keys, theme, events, focus, async, lists, public API, naming, testing        |

Read the Design Guides first when the change has a visible surface. If the design
skill is not installed, fetch `https://nsh.dev/docs/design-guides.md`. The coding
guide is a verbatim copy of `https://nsh.dev/docs/coding-guides.md`, so a link in
it such as `./reactivity.md` means `https://nsh.dev/docs/reactivity.md`, and
`../modules/nsh.md` means `https://nsh.dev/modules/nsh.md`.

### Coding Guides section map

Read the whole guide for a new app, module or feature. For a narrow change, read
"Understand what runs once and what runs again" and "Rules for coding agents"
first, then the section for the change (`grep -n '^## ' references/coding-guides.md`).

| Section                                       | Read when                                                     |
| --------------------------------------------- | ------------------------------------------------------------- |
| Build the app's UI foundations before pages | Always; design standards, tokens, styled controls, target platforms |
| Architecture at a glance                      | Always; layers, an app's files, the store                     |
| Bootstrap and root ownership                  | `mount`, the root, what one surface is                        |
| Understand what runs once and what runs again | Always; components, bindings, owners, context                 |
| Choose the right unit                         | Plain function, component or Rust `#[component]`              |
| State ownership                               | Where state lives, controlled values, feedback loops          |
| Stable identity                               | Keys, routes, test ids                                        |
| Rendering and composition                     | Component bodies, `<If>`, using `nsh/base` before custom views |
| Behavior and presentation boundary            | What `nsh/base` owns, parts and slots                         |
| Theme and styling                             | Tokens, the Tailwind scale, state styles, text size           |
| Events, commands, and focus                   | Presses, shortcuts, decisions as props, focus, overlays       |
| Async work and side effects                   | `resource`, effects, stale results                            |
| Layout, measurement, and scrolling            | Flex defaults, `onLayout`, scroll owners, insets              |
| Lists, tables, and large data                 | `List`, why cells keep no state                               |
| Public API design                             | Anything other code imports                                   |
| Platform and capability boundaries            | `ios={{}}`, `nsh/mobile`, `nsh/desktop`, `capabilities`       |
| File and naming conventions                   | Names of components, props, events, states                    |
| Testing strategy                              | `nsh test`, selectors, what to cover                          |
| Performance rules                             | Before adding a cache; `nsh test --trace`                     |
| Common failure modes                          | Before finishing                                              |
| Rules for coding agents                       | Always when an agent writes code                              |
| Implementation checklist                      | Before finishing; run every item against the work             |

### Non-negotiables

A floor, not a substitute for the guides.

- **Never invent an API.** Look the name up in the crate's source (Rust) or in
  `.nsh/types` (TSX), then its reference page. Do not write by analogy with another
  framework.
- **Components run once.** In Rust, pass a closure or a signal where a value must stay
  current: `text(move || format!("{}", count.get()))`. In TSX, read props and signals
  in JSX or a closure; do not destructure props.
- **One owner per state.** A page's draft is a signal of that page; shared state is a
  store with private signals. In Rust with TSX, one side owns each piece of state.
- **The look is the app's.** `nsh_base` / `nsh/base` has behavior and no look, and NSH
  has no styled component library. Draw with theme tokens: `theme().primary` in Rust,
  `bg-primary` in TSX. Wrap each base component once in the app's own UI module.
- **Parts draw nothing until styled.** A switch with no track and thumb style shows no
  switch, and a test still passes. Style every part, and look at the result.
- **Use the semantic component.** Button, Menu, Popover, Sheet, Dialog and Select bring
  focus, keyboard, dismissal and accessibility. Do not rebuild them from a view.
- **Use a virtualized list by default for collections that can grow,** including chat,
  feeds and history: `List` in TSX, `virtual_list` in Rust. Use `Scroll` and `Each`
  for small, bounded content. Keep per-item state in data keyed by id, never in a
  signal created in a row: cells are reused for other rows. Test recycling and
  off-screen jumps, and preserve the visible position as data changes.
- **A decision the system needs at once is a prop**, set beforehand (`pop_on_back`,
  `close_on_escape`, `disabled`), never a callback returning a boolean.
- **Do not change NSH to fit an app.** Solve it in the app first: its own components, a
  Rust crate, or a native component.
- **TSX has no DOM, no Node and no npm UI.** Standard modules are exactly `buffer`,
  `console`, `crypto`, `fs/promises`, `net`, `os`, `path`, `process`, `url`, `websocket`,
  `zlib`.

## The Loop

Run your mode's loop before calling work done. Prefer check and headless tests to full
builds while working.

```sh
# Rust
cargo check --all-targets   # or nsh check, which also checks TS tests
cargo test                  # the real UI, headless, with nsh_testing::Headless
nsh run                     # look at it; --target ios, android, web, macos, linux, windows

# Rust with TSX
nsh check                   # cargo check, then tsc against the types generated from Rust
nsh build                   # every warn is a finding: undocumented exports, unknown classes
nsh test                    # cargo test, then *.test.tsx in a runner linked with the crate
nsh run

# TSX
nsh check                   # the only type check
nsh build                   # the bundler's errors: nsh check does not see text in a View
nsh test                    # *.test.tsx, headless
nsh run
```

Headless tests prove behavior, not the look: take a screenshot or run the app for
anything visible. In TSX, passing one of `nsh check` and `nsh build` proves little without
the other; [the table in tsx.md](references/tsx.md#who-reports-what) shows who reports what.

## Quick Start in Rust

```rust
use nsh_base::{button, theme};
use nsh_core::prelude::*;

#[native_module("app/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
}

#[component]
pub fn App() -> impl IntoElement {
    let count = signal(0_u32);
    view()
        .flex_1()
        .items_center()
        .justify_center()
        .gap_4()
        .bg(move || theme().background)
        // A closure is a binding: it runs again when `count` changes.
        .child(text(move || format!("Count: {}", count.get())).text_color(move || theme().foreground))
        .child(
            button()
                .px(px(20.0))
                .py(px(12.0))
                .rounded(move || theme().radius)
                .bg(move || theme().primary)
                .active(|s| s.bg(move || theme().primary.opacity(0.9)))
                .on_press(move || count.update(|c| *c += 1))
                .child(text("Tap").text_color(move || theme().primary_foreground)),
        )
}
```

```json
{ "name": "My App", "rust": ".", "root": "App" }
```

```rust
// tests/app.rs (add matching dev-dependencies from references/rust-testing.md)
use nsh_engine::{EngineConfig, Root};
use nsh_testing::Headless;

#[test]
fn a_tap_counts() {
    let mut app = Headless::start(EngineConfig::new(Root::of::<nsh_app_my_app::App>())).unwrap();
    app.wait_for("Count: 0").unwrap();
    app.press("Tap").unwrap();
    app.wait_for("Count: 1").unwrap();
}
```

The same app in TSX, and the TSX forms, are in [tsx.md](references/tsx.md). `snake_case`
Rust names are `camelCase` in TSX (`on_open_change` is `onOpenChange`).

## Documentation

Start with the bundled mode pages and recipes; they work without an NSH checkout.
For exact APIs, use the project’s `.nsh/types` in TSX and its resolved dependency
source in Rust. `cargo metadata --format-version 1` reports dependency manifests
and their source locations; use those paths rather than assuming a Cargo cache path.
Run `nsh check` to generate missing TS declarations.

Paths starting with `examples/`, `crates/` or `website/` in the references identify
files in the NSH repository; they are optional source pointers, not files in the
installed skill or the user’s app. Use them when a checkout is available. Otherwise,
use the bundled recipes, the online docs below, or the corresponding file at
`https://github.com/longbridge/nsh` at the project’s matching tag or revision.
A `website/docs/foo.md` pointer corresponds to `https://nsh.dev/docs/foo.md`;
`website/elements/` and `website/modules/` similarly map to site paths.

The site follows the latest release and may describe a newer API than the project
uses. Preserve the project’s version and verify examples against its types or source.
Fetch individual pages as needed; use `llms-full.txt` only for broad exploration.

- **Find a page**: `https://nsh.dev/llms.txt`, then load its Markdown;
  `https://nsh.dev/llms-full.txt` for broad reference.
- **Rust**: `https://nsh.dev/docs/rust.md`, `native-components.md`, `networking.md`.
- **An element or component**: `https://nsh.dev/elements/{name}.md`.
- **A module**: `https://nsh.dev/modules/{name}.md`: `nsh.md`, `nsh-base.md`,
  `nsh-mobile.md`, `nsh-desktop.md`, `style-reference.md`, `tailwind-reference.md`,
  `standard-modules.md`.
- **A guide**: `https://nsh.dev/docs/{name}.md`: `reactivity.md`, `layout.md`,
  `navigation.md`, `lists.md`, `forms-and-keyboard.md`, `platform-specific.md`,
  `testing-and-trace.md`.

## Working on NSH itself

This skill is for building apps. In a checkout of `longbridge/nsh`, follow its
`AGENTS.md` and `docs/dev/` as well.
