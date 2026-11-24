# __APP_NAME__

A TSX app extended with Rust. `App.tsx` is the app (split it into modules under `src/` as it grows), and its Rust lives
in `ext/`: `__EXT__` is an [nshm](https://nsh.dev/docs/nshm) of the app's own, listed in `nsh.json` `"dependencies"` by
path, whose `#[native_module("__SPECIFIER__")]` exports a component (`Badge`), a module (`Format`) and a class
(`Counter`) that `App.tsx` imports from `__SPECIFIER__`.

```text
App.tsx              the entry
src/                 the app's TSX modules
ext/                 the app's Rust: one nshm crate per directory
└── __SPECIFIER__/
    ├── Cargo.toml
    └── src/lib.rs
nsh.json             "dependencies": { "__SPECIFIER__": { "path": "__EXT__" } }
```

Add another crate with `cargo new --lib ext/<name>` and `nsh add --path ext/<name>`.

```sh
nsh run                      # this machine's backend; --target ios, android, web, macos, linux, windows or gpui
nsh check                    # type checks App.tsx against the declarations generated from it
nsh test                     # App.test.tsx, headless (cargo test in ext/<crate> for the Rust); --target to run it on a platform
nsh package --target web     # or ios, android, macos, linux, windows
```

`nsh` describes the crate's exports with a small program of the crate and builds the app's hosts with it linked in.
TSX edits are hot updates; Rust edits rebuild and restart the app. The first build writes the crate's TypeScript declarations into
`.nsh/types/__SPECIFIER__.d.ts`, doc comments included.

A function or a member runs the way its Rust signature says: one that is not `async` runs inside the TSX call and
returns its value (`Format.times(2)`, `counter.count`); an `async fn` returns a Promise and runs as a task with NSH's
services; a module function taking `cx: &mut ModuleCx` reaches the platform in order with the UI and returns a Promise.
Register more in `__EXT__/src/lib.rs` with `registry.register::<…>()` (components), `registry.module::<…>()` and
`registry.class::<…>()`.

The `nsh` commands build the app's hosts with the nshm linked in, from the NSH crates its `Cargo.toml` depends on: crates.io's at the version of the
`nsh` you run (keep the `nsh-*` dependencies at that version when you upgrade `nsh`), or an NSH checkout's by path.

## A title bar of your own

The window keeps the system's title bar. To draw your own in its place (the window's background up to its top edge,
your controls beside the window's), hide the system's and lay out a `TitleBar` row at the top: it moves the window
and keeps its content clear of the window controls where it meets them, so a bar over each pane of a split view only
steps aside on the pane at the window's edge.

```tsx
import { mount, Text, View } from "nsh";
import { TitleBar } from "nsh/base";
import { Window } from "nsh/desktop";

mount(() => (
  <Window id="main" titleBar={{ style: "hidden" }}>
    <View class="flex-1">
      <TitleBar class="h-11 border-b border-border">
        <Text class="px-3 font-semibold">__APP_NAME__</Text>
      </TitleBar>
    </View>
  </Window>
));
```

Its own padding goes on a view inside it; see [TitleBar](https://nsh.dev/elements/title-bar).

NSH-generated files stay in `.nsh/`: runner sources in `.nsh/rust/` and default packages in `.nsh/out/`.
Cargo keeps its normal `target/` directory and respects your existing `CARGO_TARGET_DIR`.

We recommend building with [huacnlee/cargo](https://github.com/huacnlee/cargo), the Cargo NSH is developed with: a
drop-in fork that builds each dependency once for all your projects and Git worktrees and keeps its build directory
under a size limit on its own, with nothing to configure. It builds under `~/.cargo/targets/` and still puts the
binaries in `target/`; it replaces `~/.cargo/bin/cargo`, and its README says how to put rustup's back.

```sh
curl -fsSL https://huacnlee.github.io/cargo/install.sh | sh     # Windows: irm https://huacnlee.github.io/cargo/install.ps1 | iex
```
