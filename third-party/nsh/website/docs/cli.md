---
title: CLI
description: Every NSH subcommand and flag - init, build, test, check, dev, run, package, and the signing commands keygen, certify, publish, verify, symbolicate and revoke.
order: 6
group: start
---

# CLI

`nsh` is the tool an NSH app is built with, in TSX or Rust. Every subcommand that builds an app takes `[ENTRY]`: the app's directory (default: the current one, so `cd my-app && nsh run` works), which runs a Rust app's root component (`nsh.json` `"root"`) or a TSX app's `App.tsx`, or a TSX entry module. It reads `nsh.json` in the app's root and refreshes the type declarations in `.nsh/types`.

```text
nsh <COMMAND>

  init         Create an app in Rust or TSX
  build        Build an app: describe a Rust app's crates, or bundle a TSX app and compile it to QuickJS bytecode
  test         Run an app's tests headless, and its Rust crates' with cargo test
  check        Type check an app with TypeScript's native compiler, and its Rust crates with cargo check
  dev          Serve an app to dev hosts (simulators, devices) and push rebuilds
  run          Like dev, and also run the app in a development host
  package      Package an installable app from the prebuilt runtime
  keygen       Create a signing key
  certify      Certify a release key with a root key
  publish      Build an app in release mode and sign it into a package (.nshpkg)
  verify       Verify a package
  symbolicate  Map the positions in a reported error stack to the app's sources
  revoke       Sign a revocation list
```

`nsh <command> --help` prints the flags of a command; `nsh -V` (`--version`) prints the version and the Git revision it was built from.

## Output

Every command prints one line per step, and the details only when something fails:

```text
✓ built the Rust crate gallery-native (5.0s)
✓ built App.tsx (500 B js, 809 B bytecode, 21ms)
✓ built the development host for the iOS simulator (12.7s)
• iOS Simulator (iPhone 16 Plus) connected, build 1
warn iOS Simulator: image failed: An SSL error has occurred and a secure connection to the server cannot be made.
✓ rebuilt App.tsx (18ms), 1 device
```

`✓` is a finished step, `→` where to connect, `•` what a device did; `warn` and `error` lines are problems, and
plain lines are your app's own output (`console.log`). On a terminal a spinner shows the step that is running, and
lines are colored (unless `NO_COLOR` is set); redirected to a file, only the result lines are written, without colors.
The output of the tools NSH runs (cargo for an app's Rust crate, the development hosts) is printed below an `error`
line when one of them fails.

`-v, --verbose` (any command; also `NSH_VERBOSE=1`) prints everything as it comes: every log line with its level and
source, cargo's output and the hosts' own.

## nsh init

```sh
nsh init [DIR] [--name <NAME>] [--template <ts|rust|mixed>] [--nsh-source <DIR>]
```

Creates an app in `DIR` (default: the current directory, created if missing) from a template. Without `--template`, `nsh init` asks which one on a terminal (Enter picks `ts`) and takes `ts` elsewhere (a script, CI).

| Template | What it creates |
|---|---|
| `rust` | An app written in Rust: a Cargo project (`Cargo.toml`, `src/lib.rs` with the root component, `src/main.rs` for `cargo run`), `nsh.json` with `"rust": "."` and `"root": "App"`, the root's test `App.test.tsx` with `tsconfig.json` and `.nsh/types`, `.gitignore` and a README, which also says how to add a TSX entry later. `nsh run` and `nsh package` mount the root with no QuickJS on every target (`nsh test` opens it for TypeScript tests), the browser included ([Building with Rust](./rust.md)); `cargo run` starts it on macOS, Windows or Linux directly. |
| `ts` | A TSX app: `App.tsx`, its test `App.test.tsx` (`nsh test`), `nsh.json`, `tsconfig.json`, `.gitignore` and `.nsh/types`. Files that exist are kept; it fails only if all of them exist already. |
| `mixed` | A TSX app extended with Rust in `ext/`: `App.tsx`, its test `App.test.tsx`, `tsconfig.json`, `.gitignore`, `.nsh/types`, a README, and an nshm crate of the app's own in `ext/<name>-native/` (`Cargo.toml`, `src/lib.rs`), which `nsh.json` lists in `"dependencies"` by path and whose `#[native_module("<name>-native")]` exports a component, a module and a class that `App.tsx` uses ([An app's own Rust: ext/](./nshm.md#an-apps-own-rust-ext)). |

| Flag | Description |
|---|---|
| `--name <NAME>` | Display name written to `nsh.json`. Default: the directory's name. The id becomes `com.example.<name>` (letters and digits only, lower case), and the crates' import specifier `<name>/native` (lower case, words joined by `-`). |
| `--template <TEMPLATE>` | `rust`, `ts` or `mixed` (above). `rust` and `mixed` need Rust; `cargo run` also needs the native desktop backend's development libraries. |
| `--nsh-source <DIR>` | With `rust` or `mixed`: the crates depend on the NSH crates of the checkout in `DIR`, by path, to build the app against NSH's sources. |

The crates of `rust` and `mixed` depend on NSH's crates on crates.io at the CLI's version (with `--nsh-source`, on a checkout's), and the `nsh` commands build the app's runners and hosts from the same crates. Before each command on such an app, `nsh` builds a small program of the app's crates and NSH's core that describes their components, modules and classes, and runs it when the crates changed; with that description the CLI itself bundles, compiles, type-checks, serves and packages the app. A Rust app's builds compile its crates and NSH's core alone. Create them in a new app directory: any of their files existing is reported as a conflict before anything is written.

Apps whose Rust crates depend on NSH through Git use the checkout Cargo resolves in the app’s lockfile. Generated hosts share that checkout, including NSH dependencies redirected by the app’s Cargo patches.

## nsh run

```sh
nsh run [ENTRY] [--target macos|linux|windows|ios|android|gpui|tui|web|catalyst] [--device <DEVICE>] [--port <PORT>] [--release] [--limits [<LIMITS>]] [--trace] [--fps] [--name <NAME>] [--points-per-cell <WIDTHxHEIGHT>] [--window-size <WIDTHxHEIGHT>] [--display <N>] [--background]
```

```sh
nsh run my-app                     # a Rust app's root, or a TSX app's App.tsx, on this machine's backend
nsh run my-app --target ios        # in the iOS simulator
nsh run my-app/App.tsx --target web
```

For a TSX entry, `nsh run` starts the dev server (as `nsh dev`), launches a development host that loads the app from it, and rebuilds on every save. Hot module replacement patches the running app in place; logs and errors from the app are printed in the terminal. Stop it with Ctrl-C (or by closing the Catalyst, macOS, Linux, Windows or GPUI window). However it ends (Ctrl-C, `kill` / `pkill`, an error), it stops the host it started: the Catalyst app, the macOS, Linux, Windows or GPUI host, the development host in the simulator, or on the Android device.

On the native window and mobile targets, a Rust app (`nsh.json` `"root"`, [Building with Rust](./rust.md)) runs with no dev server and no QuickJS: `nsh run` builds the app's runner for the target with its root mounted, starts it (on the desktops a debug build, its logs in the terminal; in the simulator and on Android, the app installed), and on a change to the crate's Rust code builds it again and restarts it. With `--target web` it prints the page's address, and the open page loads the new runtime by itself. Name the TSX entry (`nsh run App.tsx`) to run that instead.

| Flag | Default | Description |
|---|---|---|
| `--target <TARGET>` | `macos` on macOS, `linux` on Linux, `windows` on Windows | `ios`: the host in an iOS simulator. `android`: the host on an Android device or emulator. `macos`: the AppKit host, a 1200×800 window ([macOS](./macos.md)). `linux`: the GTK host, a 390×844 window ([Linux](./linux.md)). `windows`: the Win32 host, a 1200×800 window ([Windows](./windows.md)). `gpui`: the GPUI host, a 1200×800 window, on macOS, Windows or Linux, showing a TSX app as GPUI apps that embed it show it ([GPUI](./gpui.md)). `tui`: the host in the current terminal ([TUI](./tui.md)). `web`: the dev server's page, at the address it prints ([Web](./web.md#develop-in-the-browser)). Development tool `catalyst`: the Mac Catalyst host, an iPhone-sized window (390×844), used only when needed: to check behavior specific to Catalyst, or an app that embeds NSH in a Mac Catalyst app. For the Mac app, use the default `macos`; to see an app as a phone shows it, use `--target ios`. Any other name runs the platform of that name built outside NSH ([External targets](#external-targets)). |
| `--device <DEVICE>` | | iOS simulator to use, by name (`"iPhone 16 Pro"`) or UDID. Default: a booted one, else the newest iPhone, which is booted. With `--target android`: the device or emulator, by its serial (`emulator-5554`, as `adb devices` lists it). Default: the one `ANDROID_SERIAL` names, else the first one. |
| `--port <PORT>` | The app's last port, else the first free one from `8790` | Dev server port. Replaces the previous NSH development session on this port after its cleanup completes. |
| `--release` | | Minify and strip debug info. Release bundles have no hot module replacement: every save reloads the app. An app with a Rust crate also gets an optimized (`--release`) development host, with its crates and NSH's built as in a package. |
| `--limits [<LIMITS>]` | | Runs the app as an app embedded in another one, within the limits its host app sets: `memory` and `stack` (in `KB`, `MB` or `GB`), `load` and `call` (in `ms` or `s`) and `nodes`, such as `--limits memory=128MB,call=500ms`. The ones left out keep the embedding defaults, which `--limits` alone runs with ([Sandbox and capabilities](./sandbox-and-capabilities.md#limits)). Without it the app runs on its own, as a packaged app does. TSX entries. |
| `--trace` | | The host logs the timing of every commit (JS, layout, mount items) to the terminal. |
| `--fps` | | The performance monitor: frame rate, what frames and commits cost, CPU, GPU and memory, shown over the app on macOS ([macOS](./macos.md#performance-monitor)) and logged once a second on macOS, Linux, Windows and iOS, shown with `-v`. On `tui`, a corner line shows FPS/idle, frame p95, apply/draw/flush times, bytes and changed Cells; `C-h p` toggles it. |
| `--name <NAME>` | `nsh.json` name | Application display name in the menu bar and initial window title (`--target macos`, TSX entries). |
| `--points-per-cell <WIDTHxHEIGHT>` | `nsh.json` `tui.pointsPerCell`, otherwise `8x16` | Terminal Cell width and height in points (`--target tui`). |
| `--window-size <WIDTHxHEIGHT>` | Host default | Initial window size in points, such as `800x600` (`--target macos`, `linux`, `windows` and `gpui`, TSX entries). |
| `--display <N>` | The main display | The display the window opens on, centered: `1` is the primary display (the one with the menu bar), `2` the next, and so on; a number with no display opens it on the main one (`--target macos`, TSX entries). |
| `--background` | | The app never becomes the active app, as `nsh test` runs its apps: its window shows, the keyboard stays with the app you type in, and input sent to its windows (an agent driving it, a UI test) still reaches it. On macOS it has no Dock icon or menu bar while it runs. For a run you do not watch, such as an agent checking a change while you work (`--target macos`, `linux`, `windows` and `gpui`, TSX entries). |

With `--target android`, the device `--device` or `ANDROID_SERIAL` names is used, else the first one `adb devices` lists (`nsh` names it when several are connected); the dev server's port is forwarded to it with `adb reverse`. See [Getting started](./getting-started.md#run-it) and [Dev server and debugging](./dev-server-and-debugging.md).

A replacement waits up to ten seconds for the previous session to finish cleanup. Several apps run side by side on ports of their own, and running an app again replaces its previous session. A `--port` occupied by another program, or an older NSH CLI, produces an error naming the port; `--port 0` asks the OS for a free port. `nsh run` serves this machine only, and with `--target ios`, `android` or `web` also the network.
With `--target tui`, the app runs in the current terminal with hot updates on save. CLI and host diagnostics go to the app's `.nsh/tui.log`. Press `C-h e` for logs and errors, Escape or `C-g` to close the panel, and `r` to reload. App errors open the panel automatically; an update restores the app display. Each Cell defaults to 8×16 points. `--points-per-cell 10x20` takes precedence over `"tui": { "pointsPerCell": "10x20" }` in `nsh.json`; both dimensions must be finite and positive, and apply when the run starts. Rust apps run their root in a generated terminal development host and rebuild/restart when Rust code changes.

On Unix, the terminal host exits on SIGHUP, SIGTERM, SIGINT or terminal disconnection and restores the terminal settings that remain accessible. Idle apps sleep between input checks; interactive runs use live terminal input, and `--headless` accepts redirected input for tests.

## nsh dev

```sh
nsh dev [ENTRY] [--target macos|linux|windows|ios|android|gpui|tui|web|catalyst] [--device <DEVICE>] [--server-only] [--port <PORT>] [--host <HOST>] [--release] [--limits [<LIMITS>]]
```

Starts the dev server and opens this system’s native host: AppKit on macOS, GTK on Linux, Win32 on Windows. Choose `--target ios` or `--target android` explicitly for mobile development. `--server-only` serves hosts you start yourself. The server builds the app, watches the entry’s directory and the app’s `nsh.json`, theme and translations, and pushes every rebuild to connected hosts. With `--server-only`, it prints the URL for hosts on this machine and, unless bound to loopback, one per LAN address for devices, and, when the web runtime is there, the page browsers open to run the app ([Web](./web.md#develop-in-the-browser)):

```text
✓ built App.tsx (3.2 KB js, 9.8 KB bytecode, 21ms)
→ dev server ws://127.0.0.1:8790/ws
  browsers: http://127.0.0.1:8790/
  devices on this network: ws://192.168.1.20:8790/ws
  browsers on this network: http://192.168.1.20:8790/
```

Use `nsh dev --server-only` with an app that embeds the development SDK (`NativeShellDev.xcframework`, `nsh-dev.aar`). `--target`, `--device`, `--port`, `--release` and `--limits` work as for `nsh run`; `--server-only` selects a server without a launched host. `--host <HOST>` binds the dev server to a specific IPv4 address instead of the default (`0.0.0.0` for `--server-only` and `--target ios`, `android`, or `web`; `127.0.0.1` for local targets), for example `nsh dev App.tsx --server-only --host 127.0.0.1` to listen on loopback only. With `--target android`, `--host` must be `127.0.0.1` or `0.0.0.0` because `adb reverse` forwards the device's `127.0.0.1` to this machine's `127.0.0.1`.

## nsh test

```sh
nsh test [PATH] [--filter <NAME>] [--release] [--trace] [--fps] [--junit <FILE>] [--jobs <N>] [--target <TARGET>] [--browser <PATH>] [--web-host <JS>] [--device <DEVICE>] [--display <N>] [--foreground]
```

Runs the app's tests headless ([Testing](./testing-and-trace.md)): the test files (`*.test.tsx`, `*.test.ts`, importing `nsh/test`) in `PATH`, a directory (default: the current one; hidden directories, `node_modules` and `target` are skipped), or the test file `PATH`. Given a directory of an app with Rust crates of its own (`nsh.json` `"rust"`: a Rust app or a TSX app with a crate), it first runs `cargo test` for each crate in the directory, in the crate's own directory, and shows and counts each Rust test with the TypeScript tests, under the file of its test target (`src/lib.rs › tests::adds`); a Rust app with only Rust tests is tested this way too. Each test file runs on an engine of its own and each app its tests open on another, fresh one. It prints a line per test, and for a failure what was thrown, where in the test file and the texts on screen; any failure makes it exit with a non-zero code. Given the app's entry (`nsh test App.tsx`; a Rust app's: `nsh test nsh.json`), it opens the app on the network, lets it run for 1.2 s and takes the steps standard input gives (`await app.press("Add")`, with `app` the app). A TSX app runs in the CLI's own process; an app with Rust crates of its own runs in a headless runner built with them, which the CLI builds the entries for. Headless runs behave as iOS unless a test opens the app as Android (`open`'s `platform`): `platform.os` is `"ios"`, and `ios:` classes and `ios={{…}}` props apply.

```text
✓ App.test.tsx › counts taps (321ms)
✓ 1 test: 1 passed, 0 failed (343ms)
```

| Flag | Description |
|---|---|
| `--filter <NAME>` | Runs only the tests whose name (after the names of the `describe` blocks it is in) contains `NAME`; for the crates, `cargo test <NAME>`. |
| `--release` | Minifies and strips debug info from the app bundles under test. For an app with Rust crates (`nsh.json` `"rust"` or a Rust nshm), also runs `cargo test --release` on its crates and builds its headless runner and development hosts optimized (`--release`), as in a package. |
| `--trace` | Prints every mount batch of the apps the tests open, under the step it came in (`── press(Add): 7 items`), and the time of every commit: what the first frame, a step or a frame of scrolling costs. With `--target`, the host's batches and timings. |
| `--fps` | With `--target linux`, `macos`, `windows` or `ios`: the host logs its performance monitor's readings once a second (frame rate, frame phases, commits, CPU, memory), shown with `-v`. |
| `--junit <FILE>` | Also writes the results to `FILE` as a JUnit XML report, the format CI services show test results from: a `testsuite` per test file, a `testcase` per test. |
| `-j, --jobs <N>` | How many test files run at once, each on its own engine (default: the number of cores). Results still show file by file, in order. Headless runs only: with `--target` or `--trace` files run one at a time. |
| `--target <TARGET>` | Runs the apps the tests open on this platform's development host instead of headless (`macos`, `linux`, `windows`, `gpui`, `tui`, `web`, `ios` and `android`; `tui` runs them in an in-memory terminal, `web` in a headless Chrome, Edge or Chromium): the steps act with the platform's own input ([Testing](./testing-and-trace.md#on-a-real-platform)), and `open` checks its options against the platform, rejecting one it cannot honor (`ERR_NSH_TEST_UNSUPPORTED`: `width` and `height` on iOS and Android, a `platform` of another kind of device). The crates' Rust tests run on this machine, in runs without `--target`. |
| `--browser <PATH>` | The Chrome, Edge or Chromium executable `--target web` runs the apps in (default: the one installed on this machine). |
| `--device <DEVICE>` | With `--target ios`: the simulator the apps run in, by name (`"iPhone 16 Pro"`) or UDID. Default: a booted one, else the newest iPhone, which is booted. With `--target android`: the device or emulator, by its serial (as `adb devices` lists it). Default: the one `ANDROID_SERIAL` names, else the first one. |
| `--display <N>` | With `--target macos` or `gpui`: the display the apps' windows open on, centered: `1` is the primary display (on macOS the one with the menu bar), `2` the next, and so on; a number with no display opens them on the main one. By default they open on a secondary display (the first besides the primary one, not a mirror of it), so a test run keeps to a screen of its own, and on the primary one when it is the only one. The tests run the same on every display. |
| `--foreground` | With `--target macos`, `windows`, `gpui` or `linux`: the apps become the active app, as they do for a user. By default they run in the background: their windows show, the keyboard stays with the app you type in, and the tests' clicks, keys and shortcuts go to the windows directly. On a Linux desktop the background keys are typed into the widgets, as on Wayland; a test of Tab, the arrow keys or an input method runs with `--foreground` there. On a display nobody types on (Xvfb), Linux apps run as in the foreground either way. A test that depends on the app being active (`lifecycle()` follows whether the app is active) or a measurement such as `examples/gallery/tools/perf.py` (which passes it) should run with it. |
| `--web-host <JS>` | The web page's host module the apps opened headless get (default: `nsh.json` `web.host`; it exports `createHost(player)`): it answers their [`host`](../modules/nsh.md#host) calls and its `player.hostEvent` reaches `host.on` ([Testing](./testing-and-trace.md#the-pages-host)). Headless runs only; `--target web` runs `nsh.json`'s `web.host`. |

## nsh check

```sh
nsh check [ENTRY] [--tsc <TSC>] [-- <TSC ARGS>...]
```

Type checks the app. An app with Rust crates of its own (`nsh.json` `"rust"`) has each crate checked first with `cargo check --all-targets` in the crate's directory, its tests included; Cargo's errors make it exit with a non-zero code. A Rust app (`"root"`) is then checked as far as it has TypeScript: with a `tsconfig.json` (the one `nsh init --template rust` writes for `App.test.tsx`) its test files are type checked too. The TypeScript check refreshes `.nsh/types` and `.nsh/tsconfig.json`, then runs `tsc -p <app directory> --noEmit` with the app's `tsconfig.json`. It uses TypeScript 7, the native compiler, which needs no Node: the first run downloads it from the npm registry (about 9 MB), checks it against the checksum NSH records, and keeps it in NSH's cache (`~/Library/Caches/nsh` on macOS, `~/.cache/nsh` on Linux, `%LOCALAPPDATA%\nsh` on Windows, or `NSH_CACHE`). Type errors make it exit with a non-zero code. It warns when `tsconfig.json` does not extend `./.nsh/tsconfig.json`, where NSH keeps its TypeScript settings ([Project structure](./project-structure.md#tsconfigjson-and-nshtypes)).

| Flag | Description |
|---|---|
| `--tsc <TSC>` | Run this `tsc` instead (also `NSH_TSC`), for example one from `node_modules` or a copy for machines without network. |
| `-- <TSC ARGS>` | Passed on to `tsc`, e.g. `nsh check -- --pretty false`. |

NSH-generated files stay under `.nsh/`: declarations, runner sources, and default build/package outputs in
`.nsh/out/`. Cargo keeps its normal `target/` cache and existing `CARGO_TARGET_DIR` behavior; NSH does not
add Cargo configuration to relocate it. `--out` still overrides the output location. With [huacnlee/cargo](https://github.com/huacnlee/cargo), which we
recommend, the builds live under `~/.cargo/targets/` and the binaries still land in `target/`.

## nsh build

```sh
nsh build [ENTRY] [-o <OUT>] [--release] [--split]
```

Builds the app. For a Rust app (`nsh.json` `"root"`), it builds and describes the app's crates and writes `app.json` and the files they ship (`assets/`): its runners mount the root. For a TSX app, it bundles the app and compiles it to QuickJS bytecode, for apps that embed NSH and ship the bundle themselves.

| Flag | Default | Description |
|---|---|---|
| `-o, --out <OUT>` | `.nsh/out` | Output directory. |
| `--release` | | Minify and strip debug info. |
| `--split` | | Put what `import()` loads into chunk files of its own, downloaded when first imported (web apps, see [Split bundles](./web.md#split-bundles)). Without it, the bundle holds the whole app. |

It writes:

| File | Content |
|---|---|
| `bundle.js` | The bundle as JavaScript |
| `bundle.js.map` | Its source map (stack traces are mapped back to your sources) |
| `bundle.nshc` | The bundle as compiled bytecode: what apps load |
| `<Chunk>.js`, `<Chunk>.js.map`, `<Chunk>.nshc` | With `--split`: each chunk, its source map and its bytecode (`Screen.js` for `import("./Screen")`) |
| `capabilities.json` | The `capabilities` of `nsh.json`, if declared (removed otherwise) |
| `assets/` | Every imported image and font, at its path relative to the app root |

## nsh package

```sh
nsh package [ENTRY] --target ios|ios-simulator|android|macos|linux|windows|web [-o <OUT>] [flags]
```

Builds an installable app in release mode. A Rust app (`nsh.json` `"root"`) is packaged with its own runner, built with Cargo from your crates and NSH's, its root mounted with no QuickJS ([Building with Rust](./rust.md)); a TSX app with the prebuilt runtime. No Xcode project or Gradle build is involved: NSH assembles the app bundle itself and uses Xcode's `actool` and `codesign` (iOS) or the SDK's `aapt2`, `zipalign` and `apksigner` (Android); for macOS it assembles a `.app` signed ad hoc or with `--sign` via `codesign` (and `sips` for the icon); for Linux it copies the runner and writes a `.tar.gz` with `tar`; for Windows it copies the runner, embeds the icon and writes a `.zip`, with no tools; for the web it writes a static site, with no tools. Metadata comes from `nsh.json`, overridden by the flags.

| Flag | Description |
|---|---|
| `--target <TARGET>` | Required. `ios`: iOS devices, a signed `.ipa` (or an unsigned `.app` without `--sign`). `ios-simulator`: an ad hoc signed `.app`. `android`: a signed `.apk`. `macos`: a signed `.app` (ad hoc without `--sign`) ([macOS](./macos.md#packaging)). `linux`: a directory `<Name>/` (the executable, `nsh/`, a `.desktop` file) and `<Name>.tar.gz` ([Linux](./linux.md#packaging)). `windows`: a directory `<Name>\` (`<Name>.exe`, `nsh\`), `<Name>.zip`, an Inno Setup script `<Name>.iss` and, with Inno Setup installed, the installer `<Name>-setup.exe` ([Windows](./windows.md#packaging)). `web`: a directory `<Name>/`, a static site (`index.html` and files named by their content) ([Web](./web.md#publish-an-app)). Any other name packages for the platform of that name built outside NSH ([External targets](#external-targets)). |
| `-o, --out <OUT>` | Output directory (default `.nsh/out`). |
| `--name <NAME>` | Display name. |
| `--id <ID>` | Bundle identifier, e.g. `com.example.app`. |
| `--app-version <VERSION>` | Version, e.g. `1.2.0`. |
| `--build <BUILD>` | Build number. |
| `--icon <ICON>` | App icon: a square PNG, ideally 1024×1024. |
| `--sign <IDENTITY>` | iOS devices and macOS: code signing identity, e.g. `"Apple Development: …"` or `"Developer ID Application: …"`. On macOS, enables Hardened Runtime and secure timestamping. |
| `--profile <FILE>` | iOS devices: provisioning profile (`.mobileprovision`). Entitlements come from it. Repeat it to give each app extension (`nsh.json` `ios.extensions`) its own. |
| `--keystore <FILE>` | Android: release keystore. Default: the debug key in `~/.android/debug.keystore` (created if missing). |
| `--key-alias <ALIAS>` | Android: key alias in the keystore. |
| `--keystore-password <PASSWORD>` | Android: keystore password. Also read from `NSH_KEYSTORE_PASSWORD`. |
| `--format <FORMAT>` | Android: `apk` (default) or `aab`, an Android App Bundle for Google Play, signed with `jarsigner`. Linux: `appimage` or `flatpak`, besides the directory and archive ([Packaging](./packaging.md#appimage-and-flatpak)). Not with `--run`. |
| `--abi <ABI>` | Android: the ABIs of the APK (`arm64-v8a`, `armeabi-v7a`, `x86_64`), repeated or separated by commas. Default: `arm64-v8a` and `armeabi-v7a`, plus the device's with `--run`. |
| `--arch <ARCH>` | macOS: the processors the app runs on, `arm64` (Apple silicon), `x86_64` (Intel) or `universal` (both, in one executable). Default: this Mac's. A runner for another processor needs its Rust target (`rustup target add x86_64-apple-darwin`). |
| `--run` | Install and launch the app afterwards: in the simulator (`ios-simulator`) or on the connected Android device; `macos`, `linux` and `windows` launch it; `web` serves the site on this machine at the address it prints. |
| `--device <DEVICE>` | With `--run`: the simulator to run the app in (`ios-simulator`), by name or UDID, as `nsh run`'s; or the Android device or emulator to install it on, by its serial (as `adb devices` lists it). Default for Android: the one `ANDROID_SERIAL` names, else the first one. |
| `--asset-url <URL>` | Web: the http(s) URL the site's files are served from, a CDN, as the page names them; `index.html` and `manifest.webmanifest` stay at the page's address (named relatively, as without the flag), and the CDN answers with `Access-Control-Allow-Origin`. Default: next to the page, named relatively. `--run` serves the site from this machine as it is, so it goes without it. |

```sh
nsh package my-app --target ios-simulator --run
nsh package my-app --target ios --sign "Apple Development: Jane Doe (ABCDE12345)" --profile dev.mobileprovision
nsh package my-app --target android --keystore release.jks --key-alias upload
nsh package my-app --target macos
nsh package my-app --target linux
nsh package my-app --target windows
nsh package my-app --target web
```

See [Packaging](./packaging.md).

## External targets

`nsh dev`, `nsh run`, `nsh test` and `nsh package` with a `--target` that is none of NSH's own run the platform of that name, built outside NSH: the one a [platform nshm](./nshm.md#platform-nshm) of the app provides, else the program `nsh-platform-<name>` on your `PATH`, as Cargo runs `cargo-<name>`. It gets the command and every argument but `--target` and its value, and the environment variables `NSH` (this `nsh` executable), `NSH_VERSION` and `NSH_TARGET` (the name); its exit code is the command's.

```sh
nsh package my-app --target miniprogram --out dist
# runs: nsh-platform-miniprogram package my-app --out dist
```

A name is lower-case letters, digits and dashes, starting with a letter. With no such program on the `PATH`, `nsh` says so and lists its own targets. [Building a platform](./platform-extensions.md) covers what such a platform implements.

## nsh update

Updates an installed `nsh` to the latest build of its channel; naming one, as `rustup update nightly`
does, switches channels ([Installation](./installation.md#updating)).

```sh
nsh update [stable|nightly]
```

## nsh add

Adds an [nshm](./nshm.md) (NSH module) to the app in the current directory, or the nearest one above it with `nsh.json`: a Rust crate from crates.io, Git or a local directory, or TSX from a Git repository, whose components, modules and classes the app imports (`import { Gauge } from "acme-gauge"`, and `acme_gauge::gauge()` in Rust).

```sh
nsh add acme-gauge                                   # crates.io: the newest version
nsh add acme-gauge@1.2                               # crates.io: the newest matching ^1.2
nsh add github:acme/ui                               # GitHub: the newest version tag, else the default branch
nsh add github:acme/ui@^1.4                          # GitHub: the newest tag matching ^1.4
nsh add https://git.example.com/ui.git --tag v1.4.0  # any Git URL, at a tag; or --rev <commit or branch>
nsh add --path ../gauge                              # a local directory, as it is
nsh add nsh-extra --features camera                  # with the crate's Cargo features on (comma-separated or repeated)
```

It lists the nshm in `nsh.json` `"dependencies"` under its package name (the crate's, or the `"name"` in a Git or local nshm's `nsh.json`), as `Cargo.toml` does: `"acme-gauge": "^1.2.0"`, `{ "github": "acme/ui", "version": "^1.4" }`, `{ "git": "…", "tag": "v1.4.0" }`, `{ "git": "…", "rev": "…" }` or `{ "path": "../gauge" }`, each object with optional `"version"`, `"features"` and `"targets"` (the targets a Rust nshm is linked for, which `nsh add` keeps when it adds the nshm again: [nshm](./nshm.md#using-an-nshm)). Added without a version, it gets `^` and the version it resolved to. Then it resolves every nshm the app reaches again, installs what is missing in `~/.nsh/nshms`, pins them in `nsh.lock` (commit it with the app), and adds a Rust nshm to the `[dependencies]` of the app's crate when it has one (`"rust"`). It prints the specifiers to import, and says so when the nshm brings Rust into a pure TSX app, whose development machine and CI then need the Rust toolchain ([Building with Rust](./rust.md)). If the nshm cannot be resolved, clashes with the app's crates or another nshm (the same package, specifier or module), or does not work with this NSH, the app's files are left unchanged.

`--features` turns on Cargo features of a Rust nshm, the modules of it the app uses, besides those already listed (`nsh add nsh-extra --features push` after `camera` keeps `camera`); a name the crate does not define stops `nsh add`. To turn one off, remove it from `nsh.json` and from the dependency in the app crate's `Cargo.toml`. What the crates declare under `[package.metadata.nsh]` for the features on goes into the packages, and all but the entitlements into the development hosts ([What the packaged app needs](./nshm.md#what-the-packaged-app-needs)).

Versions are semver requirements with Cargo's meaning: `1.2` and `^1.2` take any 1.x from 1.2.0, and `~1.2`, `=1.2.3`, `>=1.2, <2` and `*` work as in `Cargo.toml` (quote them in the shell: `nsh add "acme-gauge@>=1.2, <2"`). A Git nshm's versions are its tags (`v1.4.0` or `1.4.0`). `nsh.json` says what is acceptable, `nsh.lock` what was resolved: every command builds with the locked versions while they still meet the requirements, without the network; a changed requirement resolves anew. One version of each package is resolved for the whole app, the newest every requirement on it accepts; when none fits, the error names who requires what. The NSH versions an nshm works with are its `nsh.json` `"nsh"` requirement and, for a Rust nshm, its `nsh-core` requirement, checked against the running `nsh`.

Build scripts and procedural macros of an nshm run when the app builds, and its code runs with the app's permissions: review its source and `nsh.lock` changes like the app's own code.

## nsh upgrade

Upgrades the app's nshm to the newest versions their requirements accept, all of them or those named, and pins them in `nsh.lock`; a Rust nshm's dependency in the app's crate follows. To move past a requirement, change it in `nsh.json` or run `nsh add` with the new one.

```sh
nsh upgrade [NAME]...
```

## nsh remove

Removes nshm from the app: from `nsh.json` `"dependencies"`, `nsh.lock` and the `[dependencies]` of the app's crate. Their installed copies stay in `~/.nsh/nshms`, where other apps may use them.

```sh
nsh remove <NAME>...
```

## nsh component

Adds, removes or lists the runtimes installed next to an installed `nsh`: those of the platforms other than the one it runs on (`android`, `android-symbols`, `ios`, `web`, `gpui`, `tui`). A command that needs one adds it itself the first time ([Installation](./installation.md#components)).

```sh
nsh component list
nsh component add <NAME>...
nsh component remove <NAME>...
```

## Signing commands

These commands make and check signed packages (`.nshpkg`): app bundles that apps embedding NSH download and verify before running them. [Signed packages](./signed-packages.md) explains the model (an offline root key certifies release keys for some app ids).

### nsh keygen

```sh
nsh keygen <NAME>
```

Creates an Ed25519 key pair: `<NAME>.secret` and `<NAME>.pub` (e.g. `nsh keygen keys/root`). Keep a root's `.secret` offline; apps trust its `.pub`.

### nsh update-manifest

```sh
nsh update-manifest [<ARCHIVE>...] [--package <FILE.nshpkg>] [--entry <DIR>] [--key <FILE>] [--notes <FILE>] [--notes <TAG>=<FILE>]... [--link ios=<URL>] [--link android=<URL>] [--previous <ARCHIVE>]... [--base-url <URL>] [-o <DIR>]
```

Writes `latest.json` (and `latest.json.sig` with `--key`) for the archives `nsh package` made on each platform and,
with `--package`, a signed package of the app's code (`nsh publish`'s), which it checks against the app's id and
`updater.packages.roots` first: see [OTA Updates](/docs/ota-updates). A release may have only a package.
`--notes <TAG>=<FILE>` adds the notes in another language (a BCP 47 tag), written beside the manifest as
`notes.<TAG>.md`; it needs an untagged `--notes` too.
`--previous <ARCHIVE>` takes the previous release's archive of a platform and writes a patch from it beside the
manifest (`<archive>.from-<version>.patch`): apps running that version download it instead of the whole archive.

### nsh certify

```sh
nsh certify --root <ROOT.secret> --key <KEY.pub> --apps <PATTERN>... [--days <DAYS>] -o <OUT>
```

Certifies a release key with a root key for some app ids and a time window; packages carry the certificate.

| Flag | Description |
|---|---|
| `--root <ROOT>` | The root's secret key. |
| `--key <KEY>` | The release key's public key. |
| `--apps <APPS>` | App ids it may sign for: `*`, `com.example.*` or an id. Repeatable. |
| `--days <DAYS>` | How long it may sign, from now (default 365). |
| `-o, --out <OUT>` | The certificate to write. |

### nsh publish

```sh
nsh publish [ENTRY] --key <KEY.secret> --cert <CERT> [-o <OUT>] [--id <ID>] [--app-version <V>] [--build <N>]
            [--source-map package|file|none] [--strip-debug] [--min-runtime <VERSION>]
```

Builds the app in release mode and signs it into a package. Metadata comes from `nsh.json`, overridden by the flags.

Given a package (`ENTRY` is a `.nshpkg` file), it signs that package again with this key, as a platform does that signs
the packages of its apps with one key of its own. The package's files and header stay as they are; its certificate,
signing time and signature become the new key's ([Signed packages](./signed-packages.md#sign-a-package-again)). `-o`
may name the package read, and only `--key`, `--cert` and `-o` apply.

| Flag | Description |
|---|---|
| `--key <KEY>` | The release key's secret key. |
| `--cert <CERT>` | Its certificate (`nsh certify`). |
| `-o, --out <OUT>` | The package to write. Default: `.nsh/out/<id>-<build>.nshpkg`. |
| `--id <ID>` | App id. |
| `--app-version <VERSION>` | Version. |
| `--build <BUILD>` | Build number: must grow with every release. |
| `--source-map <WHERE>` | Where the source map goes: `package` (default), `file` (`<package>.map` next to the package) or `none` ([Signed packages](./signed-packages.md#errors-from-published-packages)). |
| `--strip-debug` | Leave the line and column tables out of the bytecode: smaller, but error stacks have no positions. |
| `--min-runtime <VERSION>` | The lowest runtime that runs the package, e.g. `0.2.0`; older runtimes refuse it. Default: this CLI's version ([Signed packages](./signed-packages.md#which-runtimes-run-a-package)). |

### nsh publish android

```sh
nsh publish android <BUNDLE.aab> [--track <TRACK>] [--rollout <FRACTION>] [--status <STATUS>] [--listing] [--draft]
nsh publish android --from <TRACK> --track <TRACK> [--rollout <FRACTION>]
```

Uploads an Android App Bundle to Google Play and releases it to a track, in one edit (insert, upload, track update,
commit; a failed edit is deleted). Without `--track` the release goes to **internal testing** only; reaching testers
beyond it, or the public, always takes an explicit `--track`. With `--from` instead of a bundle, it promotes the newest
release of one track to another. Signs in as a Google Cloud service account that has release permission for the app in
Play Console ([Publish to Google Play](./publish.md#publish-to-google-play)).

| Flag | Description |
|---|---|
| `--entry <DIR>` | The app's directory or entry, whose `nsh.json` `id` is the package name. Default: `.`. |
| `--package <NAME>` | The package name on Google Play. Default: `nsh.json` `id`. |
| `--credentials <KEY.json>` | The service account's JSON key. Default: `NSH_PLAY_CREDENTIALS`. Keep it out of the repository. |
| `--track <TRACK>` | `internal` (default), `alpha`, `beta`, `production` or a custom track's name. |
| `--from <TRACK>` | Promote: release the version codes of this track's newest release to `--track`, uploading nothing. |
| `--rollout <FRACTION>` | A staged rollout to this fraction of the track's users, above 0 and below 1, e.g. `0.1`. |
| `--status <STATUS>` | `completed` (default), `in-progress` (default with `--rollout`), `halted` (stop a staged rollout, with its `--rollout`) or `draft`. |
| `--draft` | Release as a draft: Play takes only drafts until the app's first release is made in Play Console. |
| `--store <DIR>` | The [store directory](./publish.md#store-listing). Default: `store` in the app's directory. |
| `--listing` | Also update the store listing (name, descriptions, images) from the store directory, replacing what Play has for those locales. |

To raise a staged rollout, release the same version again with a larger `--rollout`; to finish it, release it with no
`--rollout`.

### nsh publish status android

```sh
nsh publish status android [--entry <DIR>] [--package <NAME>] [--credentials <KEY.json>] [--json]
```

Prints every track's releases: status, version codes and rollout fraction. It reads them in an edit it deletes, so it
changes nothing. `--json` prints `{"package", "releases": [{"track", "name", "status", "version_codes",
"user_fraction"}]}` for scripts.

### nsh publish doctor android

```sh
nsh publish doctor android [--entry <DIR>] [--package <NAME>] [--credentials <KEY.json>] [--store <DIR>]
```

Checks, without changing anything on Play, what `nsh publish android` needs: the service account key, the package
name, the store directory, signing in, and access to the app (it opens an edit and deletes it). Exits with an error if
a check fails.

### nsh publish linux

```sh
nsh publish linux <ARCHIVE.tar.gz> [--url <URL>] [--entry <DIR>] [--out <DIR>]
nsh publish status linux [--entry <DIR>] [--json]
nsh publish doctor linux [--entry <DIR>]
```

Writes or updates the app's Flathub manifest (`<id>.yml`) for a release archive: its download URL and SHA-256. It opens
no pull request; commit the manifest to `flathub/<id>` yourself ([Publishing](./publish.md#publish-to-flathub)). `status`
prints the app's version on Flathub and exits 1 until it is `nsh.json`'s; `doctor` checks the metadata Flathub asks for
(`id`, the store listing, `store.linux`, the icon), and validates the metainfo and desktop entry.

| Flag | Description |
|---|---|
| `--url <URL>` | Where the archive is downloaded from (HTTPS): the release asset's URL. Default: `nsh.json` `store.linux.archiveUrl`, with `{version}` replaced. |
| `--entry <DIR>` | The app's directory or entry. Default: `.`. |
| `--out <DIR>` | The checkout of the app's Flathub repository to write `<id>.yml` into. Default: `.nsh/out/flathub/<id>`. |

### nsh publish windows

```sh
nsh publish windows <APP.msix> [--entry <DIR>] [--product-id <ID>] [--notes <FILE>|<LANG>=<FILE>]... [--wait]
nsh publish status windows [--entry <DIR>] [--product-id <ID>] [--submission <ID>] [--json]
nsh publish doctor windows [--entry <DIR>] [--product-id <ID>]
```

Submits an MSIX package (`nsh package --target windows --format msix`) to the Microsoft Store with the Store
submission API: creates a submission from the last published one, replaces its package, sets the release notes of
its listings (each locale's `releaseNotes` of the [store listing](./publish.md#store-listing), or `--notes`), uploads the package and commits it to certification. A failed submission is deleted before
it is committed; an app with a pending submission (a draft in Partner Center) is refused, so nothing a person
started is overwritten. `--wait` polls until certification ends and fails when the Store rejects it. `status` prints
the latest submission's status and exits 0 when published, 2 while in progress, 1 when failed. `doctor` checks
`nsh.json`, the credentials and the Store ID without changing anything.

Credentials are an Azure AD app associated with Partner Center (Account settings → User management → Azure AD
applications, role Manager), read only from `NSH_MS_TENANT_ID`, `NSH_MS_CLIENT_ID` and `NSH_MS_CLIENT_SECRET`. The
Store ID is `nsh.json` `store.windows.productId` (or `--product-id`). The app's first submission (pricing, age ratings, store
listing) is made in Partner Center; later ones go through this command.

### nsh verify

```sh
nsh verify <PACKAGE> [--root <ROOT.pub>]... [--revocations <LIST>]
```

Verifies a package as an app trusting the given roots would. Without `--root`, only the package's own signature is checked. It prints the package's SHA-256, which `nsh revoke --package` takes.

### nsh symbolicate

```sh
nsh symbolicate <MAP> [INPUT]
```

Rewrites the bundle positions (`bundle.js:LINE:COL`) of an error a package reported to your sources and prints the
result. `MAP` is a source map (`<package>.map` from `nsh publish --source-map file`, `bundle.js.map`) or a package that
holds one; `INPUT` is the error text (default: standard input).

### nsh revoke

```sh
nsh revoke --root <ROOT.secret> [--extend <LIST>] [--sequence <N>] [--key <ID>]... [--package <SHA256>]... -o <OUT>
```

Signs a revocation list: release keys and packages that must not load any more.

| Flag | Description |
|---|---|
| `--root <ROOT>` | The root's secret key. |
| `--extend <EXTEND>` | Keep the entries of this list (the last one published). |
| `--sequence <N>` | The list's number, higher than any published before. Default with `--extend`: that list's plus one. |
| `--key <ID>` | A release key id to revoke. Repeatable. |
| `--package <SHA256>` | A package SHA-256 to revoke. Repeatable. |
| `-o, --out <OUT>` | The list to write. |

## Environment variables

| Variable | Used by | Description |
|---|---|---|
| `ANDROID_HOME`, `ANDROID_SDK_ROOT` | Android targets | The Android SDK. Fallback: `~/Library/Android/sdk`. |
| `ANDROID_SERIAL` | Android targets | The device or emulator to use, by its serial, as adb reads it, when `--device` names none. |
| `CARGO_TARGET_DIR` | apps with Rust crates | Where the app's runners build. Default: the app's `target/`. |
| `NSH_KEYSTORE_PASSWORD` | `package --target android` | The keystore password. |
| `NSH_RUNTIME` | `run`, `package` | A runtime directory to use instead of the one next to the CLI. |
| `NSH_VERBOSE` | every command | `1`: as `--verbose`. |
| `NSH_WASM_BINDGEN` | `run`, `package` (`--target web`) | The `wasm-bindgen` CLI for an app whose crates [call browser APIs](./web.md#browser-apis-from-rust). Default: the one on `PATH`. |
| `NO_COLOR` | every command | Set: no colors on terminals. |

## nsh publish ios

```sh
nsh publish ios <IPA> [--app-id <ID>] [--issuer-id <ID>] [--key-id <ID>] [--private-key <PATH>]
```

Uploads an App Store-signed IPA on macOS to App Store Connect, waits for processing, gives it to
TestFlight groups, prepares the App Store version and listing, and submits it for review with
`--submit`. `nsh publish status ios` and `nsh publish doctor ios` report the release state and check
the setup. Flags also accept
`NSH_APP_STORE_APP_ID`, `NSH_APP_STORE_ISSUER_ID`, `NSH_APP_STORE_KEY_ID` and
`NSH_APP_STORE_PRIVATE_KEY`. The app ID defaults to `nsh.json` `store.ios.appId` and the key to
`~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8`, so a configured app runs `nsh publish ios <IPA>`. See [Publish to the App Store](./publish.md#upload-to-testflight) for signing, credentials and processing.
