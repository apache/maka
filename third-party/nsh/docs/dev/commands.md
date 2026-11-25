# Development commands

Reference for contributors; read the relevant section before changing its area.
Paths and shell commands below are relative to the repository root.
This page is loaded on demand, not imported as an agent instruction file.

## Commands

Build with [huacnlee/cargo](https://github.com/huacnlee/cargo), a drop-in Cargo fork for machines full of Git worktrees
and agents: they share one build directory that stays under a size limit on its own, so nothing needs cleaning or
configuring. `curl -fsSL https://huacnlee.github.io/cargo/install.sh | sh` installs it (Windows:
`irm https://huacnlee.github.io/cargo/install.ps1 | iex`); `cargo -V` names it. `cargo +nightly` and
`rust-toolchain.toml` keep working.

```sh
cargo run [-- <app>] [-- --target macos|linux|windows|ios|android|gpui|catalyst]  # the gallery; default: this machine's backend (macos / linux / windows), hot reload; rebuilt and restarted on Rust changes
cargo run -- accordion [--section settings]                                        # the gallery opened at one demo (by name), only its section with that title: no taps or scrolling
NSH_GALLERY_DEMO=accordion NSH_GALLERY_SECTION=settings ./target/debug/nsh test examples/gallery/App.tsx --target linux   # the same under nsh test (steps on stdin)
cargo xtask [<app>] [--target macos|linux|windows|ios|android|gpui|catalyst] [-v] # the same without cargo's own two lines; -v (any nsh / xtask command): all output
cargo build -p nsh-cli                                                             # build the nsh CLI
./target/debug/nsh init my-app --template ts|rust|mixed                            # new app: TSX, Rust (a Cargo project, "root"), or TSX that is also a crate ("rust": "."); asks on a terminal without --template
cargo build -p nsh-ios-host --target aarch64-apple-ios-macabi                          # the Catalyst development host (nsh run builds it in a checkout)
cargo build -p nsh-ios-host --target aarch64-apple-ios-sim                             # the iOS simulator host (`nsh run --target ios`)
cargo build -p nsh-ios-app --target aarch64-apple-ios-sim                              # the release runner (`nsh package --target ios-simulator`)
cargo build -p nsh-linux-host                                                          # the Linux (GTK) development host (`nsh run` on Linux builds it in a checkout)
cargo build -p nsh-macos-host                                                          # the macOS (AppKit) development host (`nsh run --target macos` builds it in a checkout)
cargo build -p nsh-windows-host                                                        # the Windows development host (`nsh run` on Windows builds it in a checkout)
cargo build --manifest-path crates/gpui/Cargo.toml --target-dir target -p nsh-gpui-host                    # the GPUI development host (`nsh run --target gpui` builds it in a checkout)
cargo build --manifest-path crates/gpui/Cargo.toml --target-dir target -p nsh-gpui-host --features nsh-gpui-host/runtime-shaders   # the same on a Mac without Xcode's Metal Toolchain (GPUI compiles its shaders at run time)
cargo run -p example-embed-gpui                                                        # the GPUI Kit embedding example (a std-only runner that only runs `cargo run` in its own workspace)
./target/debug/nsh test examples/counter/App.tsx --trace                    # headless run: prints mount items and the time of every commit
echo 'await app.scroll("id:photos", 3000)' | ./target/release/nsh test examples/gallery/Bench.tsx --trace   # headless scrolling (10pt per frame): per-frame list cost
echo 'await app.press("label:Plan"); await app.wait(500)' | ./target/debug/nsh test examples/hopper/App.tsx --trace   # steps from stdin (`app`: nsh/test's App)
./target/debug/nsh test examples/gallery                                   # the app's tests (`*.test.tsx`, `nsh/test`), headless; --trace prints batches
./target/debug/nsh test examples/gallery --target macos                    # the same tests in macOS windows: native input at the views (`nsh_testing::agent`)
./target/debug/nsh test examples/gallery --target web                      # in a headless Chrome / Edge / Chromium (found, or --browser <PATH>): trusted input over CDP
xvfb-run -a ./target/debug/nsh test examples/gallery --target linux        # in GTK windows (a virtual display here); also windows, gpui
./target/debug/nsh test examples/gallery --target ios                      # in an iOS simulator: a finger's touches and the keyboard's typing, as UIKit gets them
./target/debug/nsh test examples/gallery --target android                  # on the device --device / ANDROID_SERIAL names, else the first adb lists: MotionEvents and KeyEvents at the window's views
echo 'await app.screenshot("a.png"); await app.press("label:Navigation"); await app.screenshot("b.png")' | ./target/debug/nsh test examples/gallery/App.tsx --target macos   # check a platform change: steps from stdin in its window
./target/debug/nsh check examples/hopper                                   # type check (TypeScript 7's native tsc, downloaded once; no Node), warning of what nsh.json is ignored or refused
./target/debug/nsh run examples/counter --trace                            # dev server + this desktop's native host, hot reload on save
./target/debug/nsh run examples/gallery --target ios                       # in an iOS simulator (boots one; needs the nsh-ios-host sim build)
./target/debug/nsh run examples/gallery --target android                   # on an emulator / device (needs `cargo xtask android --dev`)
./target/debug/nsh run examples/gallery --target linux                     # in a GTK window (the default on Linux)
./target/debug/nsh run examples/gallery --target windows                   # in a Win32 window, 1200×800 (the default on Windows)
./target/debug/nsh run examples/gallery --target gpui                      # in a GPUI window (macOS, Windows, Linux), as GPUI apps embed it
./target/debug/nsh run examples/gallery --target web                       # in the browser (the dev server serves the page)
./target/debug/nsh package examples/gallery --target web --run             # a static site (files named by content), served on this machine
./target/debug/nsh package examples/gallery --target ios-simulator --run   # installable app (.app / .ipa / .apk)
cargo xtask android [--release] [--dev]                                            # Android runtime into target/android/<profile>[-dev]
cargo xtask android-embed [--no-dev] [--abi <abi>]                                 # nsh.aar and nsh-dev.aar into dist/nsh/embed/android
cargo xtask dist                                                                   # the distribution in dist/nsh
./target/debug/nsh dev examples/counter --server-only                      # dev server only (for simulators / devices); prints local and LAN URLs
./target/debug/nsh build examples/counter --release                        # writes bundle.js / bundle.nshc
./target/debug/nsh keygen keys/root && ./target/debug/nsh keygen keys/release      # signing keys (.secret / .pub)
./target/debug/nsh certify --root keys/root.secret --key keys/release.pub --apps 'com.example.*' -o keys/release.cert
./target/debug/nsh publish examples/counter --key keys/release.secret --cert keys/release.cert --build 2
./target/debug/nsh publish ci.nshpkg --key keys/platform.secret --cert keys/platform.cert -o out.nshpkg   # a package signed again by another release key, contents kept
./target/debug/nsh verify out/com.example.counter-2.nshpkg --root keys/root.pub     # as a device would check it
./target/debug/nsh revoke --root keys/root.secret --sequence 1 --package <sha256> -o revocations.json

cargo test --workspace
cargo test --release -p nsh-engine --test engine bench_gallery_scroll -- --ignored --nocapture   # gallery scroll benchmark (JS + core)
cargo test --release -p nsh-core bench_ -- --ignored --nocapture                # row / cell relayout benchmarks
cargo +nightly fmt --all                                                        # .rustfmt.toml uses nightly options
cargo clippy --workspace --all-targets
cargo clippy -p nsh-platform-ios -p nsh-ios-host -p nsh-ios-app -p nsh-extra --target aarch64-apple-ios-macabi --features nsh-platform-ios/embed,nsh-platform-ios/dev,nsh-extra/camera,nsh-extra/photos,nsh-extra/push,nsh-extra/speech
cargo xtask ios-embed [--dynamic] [--x86-64-simulator] [--no-catalyst] [--no-dev]   # NativeShell(Dev).xcframework into dist/nsh/embed/ios
cargo xtask web                                                                 # nsh.wasm + player + website demos into website/public/play
cargo xtask compat                                                              # tests/compat's apps, and the API every recorded release froze (nsh-compat)
cargo xtask compat record <version>                                             # record this checkout as a release in nsh-compat (at release time)
cargo clippy -p nsh-platform-web --target wasm32-unknown-unknown --features compiler   # the web backend (empty off WebAssembly)
cargo clippy -p nsh-extra --target wasm32-unknown-unknown --features nsh-extra/speech   # nsh-extra's web code (empty off WebAssembly)
cargo clippy -p nsh-platform-linux -p nsh-linux-host -p nsh-linux-app --all-targets      # the Linux backend (on Linux; empty elsewhere)
cargo clippy -p nsh-platform-macos -p nsh-macos-host -p nsh-macos-app -p nsh-extra --all-targets --features nsh-platform-macos/dev,nsh-extra/speech   # the macOS backend (on macOS)
cargo clippy -p nsh-platform-windows -p nsh-windows-host -p nsh-windows-app -p nsh-extra --all-targets --features nsh-extra/speech   # the Windows backend (on Windows; empty elsewhere)
cargo test -p nsh-platform-windows -p nsh-windows-host -p nsh-windows-app               # its tests (on Windows; they open no window)
(cd crates/gpui && cargo clippy --all-targets --features nsh-platform-gpui/dev)        # the GPUI backend, its own workspace (empty off the desktops)
(cd crates/gpui && cargo test && cargo +nightly fmt --all)                              # its tests (they open no window) and formatting
cd website && bun run dev                                                       # the documentation site (builds the player too)
```

`nsh-platform-ios` only compiles for `target_os = "ios"` (iOS devices, the iOS simulator and Catalyst); on a macOS
host it is an empty crate, so always run clippy on platform code with the Catalyst target. That target is for
compiling; to run an app on macOS use the default AppKit host, and `--target catalyst` only for Catalyst-specific work. Likewise
`nsh-platform-android` is empty off Android: check it with `cargo xtask android` (which sets up the NDK linker, `CC`,
`AR` and bindgen's sysroot) and `cargo xtask clippy-android`. `nsh-platform-linux` and its hosts are empty off Linux:
check them on Linux, with the GTK 4 (≥ 4.14) and GStreamer (core and base plug-ins, for sounds) development packages
installed. `nsh-platform-macos` and its hosts are
empty off macOS (`target_os = "macos"`, not Catalyst). `nsh-platform-windows` and its hosts are empty off Windows:
check them on Windows, with the MSVC Build Tools, the Windows SDK and LLVM (libclang for QuickJS' bindings);
`RUST_MIN_STACK=268435456` if rustc overflows its stack on the `windows` crate. The GPUI backend (`crates/gpui`) is
a workspace of its own: the main workspace's `cargo test --workspace` and clippy never build it, and its CI runs only when
it changes (and on main's scheduled runs). Its crates build on all three desktops and are empty elsewhere; on Linux they need GPUI's X11 /
Wayland / xkbcommon / fontconfig packages plus GTK 3, WebKitGTK 4.1 (feature `webview`, on by default) and GStreamer
1.20+ with its base plug-ins (feature `video`, the host's); on macOS Xcode's Metal Toolchain, or the
feature `runtime-shaders` (`docs/dev/gpui.md`), which the CLI turns on when `xcrun metal` fails. It builds into the
repository's `target/`; dependencies only it uses are declared in `crates/gpui/Cargo.toml`, not the root. `.cargo/config.toml` sets
`IPHONEOS_DEPLOYMENT_TARGET = 15.0` for Rust and C alike.

## Verification after changes

1. `cargo test --workspace`, plus fmt and clippy as listed above (including the Catalyst target, the macOS crates, `cargo xtask clippy-android`, on Linux the Linux crates, on Windows the Windows crates; for changes in `crates/gpui` or to what it uses, its own tests and clippy there).
2. Changes to the runtime (`nsh-js`), engine or core: run `nsh test --trace` and check item counts and timings. Changes to
   anything apps use: `cargo xtask compat` passes, and `tests/compat/` checks the change (`docs/dev/compatibility.md`).
3. Changes to the platform layer: launch with `nsh run`, check screenshots and simulate input where needed (the terminal needs the Screen
   Recording and Accessibility permissions; while the screen is locked the frontmost app is `loginwindow` and the
   system's clicks fail, but window screenshots still work, and `nsh test --target macos` runs as unlocked: it is the way
   to check a macOS change while the screen is locked). iOS simulator: `xcrun simctl io booted screenshot`, `xcrun simctl ui booted appearance dark`.
   Android: `adb exec-out screencap -p`, `adb shell input tap|swipe|text|keyevent` (all work with the screen locked).
   The desktops: `nsh test <entry> --target macos|linux|windows|gpui` with steps on standard input
   (`await app.screenshot("a.png"); await app.press("label:Plan")`) opens the app in the platform's window, acts with
   its input at the views the selectors name and takes screenshots, without touching the screen; the app's tests run
   there the same way (`docs/dev/tooling.md` "On a real platform"). Linux: under Xvfb (`xvfb-run -a`) on a machine
   without a display (`docs/dev/linux.md`). GPUI on Linux: on a rootful Xwayland display of its own started with
   `-shm` (`DISPLAY=:N`, `WEBKIT_DISABLE_DMABUF_RENDERER=1` for web views); screenshots are read from the X server
   (`docs/dev/gpui.md`).
