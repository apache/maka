# __APP_NAME__

A TSX app with a Rust crate of its own: `App.tsx` is the app, and the directory is also a crate (`Cargo.toml`,
`src/lib.rs`; `nsh.json` `"rust": "."`) whose `#[native_module("__SPECIFIER__")]` exports a component (`Badge`), a
module (`Format`) and a class (`Counter`) that `App.tsx` imports from `__SPECIFIER__`.

```sh
nsh run                      # this machine's backend; --target ios, android, web, macos, linux, windows or gpui
nsh check                    # cargo check of the crate, then type checks App.tsx against the declarations generated from it
nsh test                     # cargo test, then App.test.tsx, headless; --target to run it on a platform
nsh package --target web     # or ios, android, macos, linux, windows
```

`nsh` describes the crate's exports with a small program of the crate and builds the app's hosts with it linked in.
TSX edits are hot updates; Rust edits rebuild and restart the app. The first build writes the crate's TypeScript declarations into
`.nsh/types/__SPECIFIER__.d.ts`, doc comments included.

A function or a member runs the way its Rust signature says: one that is not `async` runs inside the TSX call and
returns its value (`Format.times(2)`, `counter.count`); an `async fn` returns a Promise and runs as a task with NSH's
services; a module function taking `cx: &mut ModuleCx` reaches the platform in order with the UI and returns a Promise.
Register more in `src/lib.rs` with `registry.register::<…>()` (components), `registry.module::<…>()` and
`registry.class::<…>()`.

The `nsh` commands build the app's hosts from the NSH crates `Cargo.toml` depends on: crates.io's at the version of the
`nsh` you run (keep the `nsh-*` dependencies at that version when you upgrade `nsh`), or an NSH checkout's by path.

NSH-generated files stay in `.nsh/`: runner sources in `.nsh/rust/` and default packages in `.nsh/out/`.
Cargo keeps its normal `target/` directory and respects your existing `CARGO_TARGET_DIR`.
