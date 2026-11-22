# Rust gallery

The gallery is an app written in Rust: everything it shows is the app's own crate `native/` (`nsh.json`
`"rust": "native"`, `"root": "Gallery"`), with no TSX and no QuickJS. It shows what Rust components can do, next to
the TSX gallery (`examples/gallery`). The crate's set is the `#[native_module("gallery/native")]` function in
`native/src/lib.rs`, which registers the crate's `assets/`. A TSX app using a crate's components, modules and classes
is `examples/rust-exports`.

It has the TSX gallery's design (`ui.tsx`, `icons.tsx`, `theme.json`), following the system's appearance:
`native/src/ui/` is its Rust form (the palette for light and dark, finishes, icons, `Press`, `Appear`, `Toggle`,
`Segmented`, `Card`, `Section`, `Button`, ...), which the index and the demos are built with. As in the TSX gallery, a
wide window (700 pt on desktops, 900 pt elsewhere) shows a sidebar of the demos and the selected one beside it
(`native/src/shell.rs`), its cards in as many columns as fit (`DemoPage`, `native/src/ui/page.rs`).

```sh
cargo build -p nsh-cli
./target/debug/nsh run examples/gallery-rs --target web   # or ios, android, catalyst, macos, linux, windows, gpui
./target/debug/nsh package examples/gallery-rs --target web --run   # a static site, served on this machine
./target/debug/nsh trace examples/gallery-rs              # headless: the root's mount items and timings
```

`nsh.json` names the root (`"root": "Gallery"`), so `nsh run` and `nsh package` of the directory mount `Gallery`
with no QuickJS on every target: the app is Rust and native code from start to end (`website/docs/rust.md`).

`nsh` describes the crate with a small program of it and builds the app's runners with it linked in (`docs/dev/tooling.md`, "Apps with Rust
components of their own"); editing the Rust code builds them again and restarts the app. On the web the crate is
compiled into the app's `nsh.wasm` (`docs/dev/web.md`, "Apps with Rust components"): the demos use the engine's
services (`fetch`, timers, `nsh_core::time`) rather than threads and the standard clock, so the same code runs in the
browser.

Run the gallery directly on the machine's native desktop backend (GTK 4 on Linux, AppKit on macOS, Win32 on Windows):

```sh
cargo run -p gallery-native
```

The executable mounts `Gallery` through `AppSource::Rust`, registers the gallery's assets and theme, and executes
UI state and event handlers in Rust. Its native dependencies disable default features, so this entry links the
Rust engine directly.

Install the backend's development libraries before building (`docs/dev/linux.md`, `macos.md` and `windows.md`).
Rust changes take effect on the next `cargo run`; `nsh run` rebuilds and restarts its host on Rust changes.

```sh
cargo run -p gallery-native
./target/debug/nsh test examples/gallery-rs   # the app's tests, headless
cargo test -p gallery-native                  # the crate's unit tests
```

The app's tests are TypeScript, as a user takes the steps: the `*.test.tsx` files next to `nsh.json`, about a demo
each, open the root (`open(".")`), press, type, scroll and go back, and check what shows, what storage keeps and
what the app asks of the platform (`website/docs/testing-and-trace.md`). `nsh test` runs them in a headless runner
it builds with the crate. What NSH itself does with the gallery's components (mount items, canvas operations, the
responder, the animation graph) is tested in NSH's crates, with components of their own. The native entry is
checked on Linux, macOS and Windows, including a dependency check for the Rust-only engine path. Create an
independent Rust app with `nsh init my-app --template rust`, then `cd my-app` and `cargo run`.
