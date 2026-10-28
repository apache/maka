---
title: CLI
description: Every NSH subcommand and flag - init, build, test, check, dev, run, package, and the signing commands keygen, certify, publish, verify, symbolicate and revoke.
order: 6
group: start
---

# CLI

`nsh` is the tool an NSH app is built with, in Rust or TSX. Every subcommand that builds an app takes `[ENTRY]`: the app's directory (default: the current one, so `cd my-app && nsh run` works), which runs a Rust app's root component (`nsh.json` `"root"`) or a TSX app's `App.tsx`, or a TSX entry module. It reads `nsh.json` in the app's root and refreshes the type declarations in `.nsh/types`.

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
| `mixed` | A TSX app with a Rust crate of its own at its root: `App.tsx`, its test `App.test.tsx`, `tsconfig.json`, `nsh.json` with `"rust": "."`, `.gitignore`, `.nsh/types`, a README, and the crate beside `App.tsx` (`Cargo.toml`, `src/lib.rs`), whose `#[native_module("<name>/native")]` exports a component, a module and a class that `App.tsx` uses. With no `"root"`, `App.tsx` is the entry. |

| Flag | Description |
|---|---|
| `--name <NAME>` | Display name written to `nsh.json`. Default: the directory's name. The id becomes `com.example.<name>` (letters and digits only, lower case), and the crates' import specifier `<name>/native` (lower case, words joined by `-`). |
| `--template <TEMPLATE>` | `rust`, `ts` or `mixed` (above). `rust` and `mixed` need Rust; `cargo run` also needs the native desktop backend's development libraries. |
| `--nsh-source <DIR>` | With `rust` or `mixed`: the crates depend on the NSH crates of the checkout in `DIR`, by path, to build the app against NSH's sources. |

The crates of `rust` and `mixed` depend on NSH's crates on crates.io at the CLI's version (with `--nsh-source`, on a checkout's), and the `nsh` commands build the app's runners and hosts from the same crates. Before each command on such an app, `nsh` builds a small program of the app's crates and NSH's core that describes their components, modules and classes, and runs it when the crates changed; with that description the CLI itself bundles, compiles, type-checks, serves and packages the app. A Rust app's builds compile its crates and NSH's core alone. Create them in a new app directory: any of their files existing is reported as a conflict before anything is written.

Apps whose Rust crates depend on NSH through Git use the checkout Cargo resolves in the app’s lockfile. Generated hosts share that checkout, including NSH dependencies redirected by the app’s Cargo patches.

## nsh run

```sh
nsh run [ENTRY] [--target catalyst|ios|android|macos|linux|windows|gpui|tui|web] [--device <DEVICE>] [--port <PORT>] [--release] [--limits [<LIMITS>]] [--trace] [--fps] [--name <NAME>] [--window-size <WIDTHxHEIGHT>] [--display <N>]
```

```sh
nsh run my-app                     # a Rust app's root, or a TSX app's App.tsx, on this machine's backend
nsh run my-app --target ios        # in the iOS simulator
nsh run my-app/App.tsx --target web
```

For a TSX entry, `nsh run` starts the dev server (as `nsh dev`), launches a development host that loads the app from it, and rebuilds on every save. Hot module replacement patches the running app in place; logs and errors from the app are printed in the terminal. In a terminal host, use Ctrl+Q to stop. Other hosts stop with Ctrl-C (or by closing the Catalyst, macOS, Linux, Windows or GPUI window). However it ends (Ctrl-C, `kill` / `pkill`, an error), it stops the host it started: the Catalyst app, the macOS, Linux, Windows or GPUI host, the development host in the simulator, or on the Android device.

A Rust app (`nsh.json` `"root"`, [Building with Rust](./rust.md)) runs with no dev server and no QuickJS: `nsh run` builds the app's runner for the target with its root mounted, starts it (on the desktops a debug build, its logs in the terminal; in the simulator and on Android, the app installed), and on a change to the crate's Rust code builds it again and restarts it. With `--target web` it prints the page's address, and the open page loads the new runtime by itself. Name the TSX entry (`nsh run App.tsx`) to run that instead.

| Flag | Default | Description |
|---|---|---|
| `--target <TARGET>` | `macos` on macOS, `linux` on Linux, `windows` on Windows | `catalyst`: the Mac Catalyst host, an iPhone-sized window (390×844). `ios`: the host in an iOS simulator. `android`: the host on an Android device or emulator. `macos`: the AppKit host, a 1200×800 window ([macOS](./macos.md)). `linux`: the GTK host, a 390×844 window ([Linux](./linux.md)). `windows`: the Win32 host, a 1200×800 window ([Windows](./windows.md)). `gpui`: the GPUI host, a 1200×800 window, on macOS, Windows or Linux, showing a TSX app as GPUI apps that embed it show it ([GPUI](./gpui.md)). `tui`: the current terminal, with keyboard focus, mouse input and Unicode editing ([Terminal](./tui.md)). `web`: the dev server's page, at the address it prints ([Web](./web.md#develop-in-the-browser)). |
| `--device <DEVICE>` | | iOS simulator to use, by name (`"iPhone 16 Pro"`) or UDID. Default: a booted one, else the newest iPhone, which is booted. |
| `--port <PORT>` | `8790` | Dev server port. Replaces the previous NSH development session on this port after its cleanup completes. |
| `--release` | | Minify and strip debug info. Release bundles have no hot module replacement: every save reloads the app. |
| `--limits [<LIMITS>]` | | Runs the app as an app embedded in another one, within the limits its host app sets: `memory` and `stack` (in `KB`, `MB` or `GB`), `load` and `call` (in `ms` or `s`) and `nodes`, such as `--limits memory=128MB,call=500ms`. The ones left out keep the embedding defaults, which `--limits` alone runs with ([Sandbox and capabilities](./sandbox-and-capabilities.md#limits)). Without it the app runs on its own, as a packaged app does. TSX entries. |
| `--trace` | | The host logs the timing of every commit (JS, layout, mount items) to the terminal. |
| `--fps` | | The performance monitor: frame rate, what frames and commits cost, CPU, GPU and memory, shown over the app on macOS ([macOS](./macos.md#performance-monitor)) and logged once a second on macOS, Linux, Windows and iOS. |
| `--name <NAME>` | `nsh.json` name | Application display name in the menu bar and initial window title (`--target macos`, TSX entries). |
| `--window-size <WIDTHxHEIGHT>` | Host default | Initial window size in points, such as `800x600` (`--target macos`, `linux`, `windows` and `gpui`, TSX entries). |
| `--display <N>` | The main display | The display the window opens on, centered: `1` is the primary display (the one with the menu bar), `2` the next, and so on; a number with no display opens it on the main one (`--target macos`, TSX entries). |

With `--target android`, the first device `adb devices` lists is used; the dev server's port is forwarded to it with `adb reverse`. See [Getting started](./getting-started.md#run-it) and [Dev server and debugging](./dev-server-and-debugging.md).

A replacement waits up to ten seconds for the previous session to finish cleanup. A port occupied by another program, or an older NSH CLI, produces an error naming the port. Use distinct `--port` values to run several apps together; `--port 0` asks the OS for a free port.

## nsh dev

```sh
nsh dev [ENTRY] [--target catalyst|ios|android|macos|linux|windows|gpui|web] [--device <DEVICE>] [--server-only] [--port <PORT>] [--release] [--limits [<LIMITS>]]
```

Starts the dev server and opens this system’s native host: AppKit on macOS, GTK on Linux, Win32 on Windows. Choose `--target ios` or `--target android` explicitly for mobile development. `--server-only` serves hosts you start yourself. The server builds the app, watches the entry’s directory, and pushes every rebuild to connected hosts. With `--server-only`, it prints the URL for hosts on this machine and one per LAN address for devices, and, when the web runtime is there, the page browsers open to run the app ([Web](./web.md#develop-in-the-browser)):

```text
✓ built App.tsx (3.2 KB js, 9.8 KB bytecode, 21ms)
→ dev server ws://127.0.0.1:8790/ws
  browsers: http://127.0.0.1:8790/
  devices on this network: ws://192.168.1.20:8790/ws
  browsers on this network: http://192.168.1.20:8790/
```

Use `nsh dev --server-only` with an app that embeds the development SDK (`NativeShellDev.xcframework`, `nsh-dev.aar`). `--target`, `--device`, `--port`, `--release` and `--limits` work as for `nsh run`; `--server-only` selects a server without a launched host.

## nsh test

```sh
nsh test [PATH] [--filter <NAME>] [--trace] [--fps] [--junit <FILE>] [--target <TARGET>] [--browser <PATH>] [--web-host <JS>] [--display <N>]
```

Runs the app's tests headless ([Testing](./testing-and-trace.md)): the test files (`*.test.tsx`, `*.test.ts`, importing `nsh/test`) in `PATH`, a directory (default: the current one; hidden directories, `node_modules` and `target` are skipped), or the test file `PATH`. Given a directory of an app with Rust crates of its own (`nsh.json` `"rust"`: a Rust app or a TSX app with a crate), it first runs `cargo test` for each crate in the directory, in the crate's own directory, and shows and counts each Rust test with the TypeScript tests, under the file of its test target (`src/lib.rs › tests::adds`); a Rust app with only Rust tests is tested this way too. Each test file runs on an engine of its own and each app its tests open on another, fresh one. It prints a line per test, and for a failure what was thrown, where in the test file and the texts on screen; any failure makes it exit with a non-zero code. Given the app's entry (`nsh test App.tsx`; a Rust app's: `nsh test nsh.json`), it opens the app on the network, lets it run for 1.2 s and takes the steps standard input gives (`await app.press("Add")`, with `app` the app). A TSX app runs in the CLI's own process; an app with Rust crates of its own runs in a headless runner built with them, which the CLI builds the entries for. Headless runs behave as iOS unless a test opens the app as Android (`open`'s `platform`): `platform.os` is `"ios"`, and `ios:` classes and `ios={{…}}` props apply.

```text
✓ App.test.tsx › counts taps (321ms)
✓ 1 test: 1 passed, 0 failed (343ms)
```

| Flag | Description |
|---|---|
| `--filter <NAME>` | Runs only the tests whose name (after the names of the `describe` blocks it is in) contains `NAME`; for the crates, `cargo test <NAME>`. |
| `--trace` | Prints every mount batch of the apps the tests open, under the step it came in (`── press(Add): 7 items`), and the time of every commit: what the first frame, a step or a frame of scrolling costs. With `--target`, the host's batches and timings. |
| `--fps` | With `--target linux`, `macos`, `windows` or `ios`: the host logs its performance monitor's readings once a second (frame rate, frame phases, commits, CPU, memory), shown with `-v`. |
| `--junit <FILE>` | Also writes the results to `FILE` as a JUnit XML report, the format CI services show test results from: a `testsuite` per test file, a `testcase` per test. |
| `--target <TARGET>` | Runs the apps the tests open on this platform's development host instead of headless (`macos`, `linux`, `windows`, `gpui`, `web`, `ios` and `android`; `web` runs them in a headless Chrome, Edge or Chromium): the steps act with the platform's own input ([Testing](./testing-and-trace.md#on-a-real-platform)). The crates' Rust tests run on this machine, in runs without `--target`. |
| `--browser <PATH>` | The Chrome, Edge or Chromium executable `--target web` runs the apps in (default: the one installed on this machine). |
| `--display <N>` | With `--target macos`: the display the apps' windows open on, centered: `1` is the primary display (the one with the menu bar), `2` the next, and so on; a number with no display opens them on the main one. By default they open on a secondary display (the first besides the primary one, not a mirror of it), so a test run keeps to a screen of its own, and on the primary one when it is the only one. The tests run the same on every display. |
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
add Cargo configuration to relocate it. `--out` still overrides the output location.

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
nsh package [ENTRY] --target ios|ios-simulator|android|macos|linux|windows|tui|web [-o <OUT>] [flags]
```

Builds an installable app in release mode. A Rust app (`nsh.json` `"root"`) is packaged with its own runner, built with Cargo from your crates and NSH's, its root mounted with no QuickJS ([Building with Rust](./rust.md)); a TSX app with the prebuilt runtime. No Xcode project or Gradle build is involved: NSH assembles the app bundle itself and uses Xcode's `actool` and `codesign` (iOS) or the SDK's `aapt2`, `zipalign` and `apksigner` (Android); for macOS it assembles an ad hoc signed `.app` with `codesign` (and `sips` for the icon); for Linux it copies the runner and writes a `.tar.gz` with `tar`; for Windows it copies the runner, embeds the icon and writes a `.zip`, with no tools; for a terminal it writes a console executable and resources with an OS-specific archive; for the web it writes a static site, with no tools. Metadata comes from `nsh.json`, overridden by the flags.

| Flag | Description |
|---|---|
| `--target <TARGET>` | Required. `ios`: iOS devices, a signed `.ipa` (or an unsigned `.app` without `--sign`). `ios-simulator`: an ad hoc signed `.app`. `android`: a signed `.apk`. `macos`: an ad hoc signed `.app` ([macOS](./macos.md#packaging)). `linux`: a directory `<Name>/` (the executable, `nsh/`, a `.desktop` file) and `<Name>.tar.gz` ([Linux](./linux.md#packaging)). `windows`: a directory `<Name>\` (`<Name>.exe`, `nsh\`) and `<Name>.zip` ([Windows](./windows.md#packaging)). `tui`: a console executable with `nsh/` resources, archived as `.tar.gz` on macOS/Linux or `.zip` on Windows ([Terminal](./tui.md#packaging)). `web`: a directory `<Name>/`, a static site (`index.html` and files named by their content) ([Web](./web.md#publish-an-app)). |
| `-o, --out <OUT>` | Output directory (default `.nsh/out`). |
| `--name <NAME>` | Display name. |
| `--id <ID>` | Bundle identifier, e.g. `com.example.app`. |
| `--app-version <VERSION>` | Version, e.g. `1.2.0`. |
| `--build <BUILD>` | Build number. |
| `--icon <ICON>` | App icon: a square PNG, ideally 1024×1024. |
| `--sign <IDENTITY>` | iOS devices: code signing identity, e.g. `"Apple Development: …"`. |
| `--profile <FILE>` | iOS devices: provisioning profile (`.mobileprovision`). Entitlements come from it. |
| `--keystore <FILE>` | Android: release keystore. Default: the debug key in `~/.android/debug.keystore` (created if missing). |
| `--key-alias <ALIAS>` | Android: key alias in the keystore. |
| `--keystore-password <PASSWORD>` | Android: keystore password. Also read from `NSH_KEYSTORE_PASSWORD`. |
| `--abi <ABI>` | Android: the ABIs of the APK (`arm64-v8a`, `armeabi-v7a`, `x86_64`), repeated or separated by commas. Default: `arm64-v8a` and `armeabi-v7a`, plus the device's with `--run`. |
| `--run` | Install and launch the app afterwards: in the simulator (`ios-simulator`) or on the connected Android device; `macos`, `linux`, `windows` launch it; `tui` runs in the current terminal until it exits; `web` serves the site on this machine at the address it prints. |

```sh
nsh package my-app --target ios-simulator --run
nsh package my-app --target ios --sign "Apple Development: Jane Doe (ABCDE12345)" --profile dev.mobileprovision
nsh package my-app --target android --keystore release.jks --key-alias upload
nsh package my-app --target macos
nsh package my-app --target linux
nsh package my-app --target windows
nsh package my-app --target tui
nsh package my-app --target web
```

See [Packaging](./packaging.md).

## Signing commands

These commands make and check signed packages (`.nshpkg`): app bundles that apps embedding NSH download and verify before running them. [Signed packages](./signed-packages.md) explains the model (an offline root key certifies release keys for some app ids).

### nsh keygen

```sh
nsh keygen <NAME>
```

Creates an Ed25519 key pair: `<NAME>.secret` and `<NAME>.pub` (e.g. `nsh keygen keys/root`). Keep a root's `.secret` offline; apps trust its `.pub`.

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
| `CARGO_TARGET_DIR` | apps with Rust crates | Where the app's runners build. Default: the app's `target/`. |
| `NSH_KEYSTORE_PASSWORD` | `package --target android` | The keystore password. |
| `NSH_RUNTIME` | `run`, `package` | A runtime directory to use instead of the one next to the CLI. |
| `NSH_VERBOSE` | every command | `1`: as `--verbose`. |
| `NSH_WASM_BINDGEN` | `run`, `package` (`--target web`) | The `wasm-bindgen` CLI for an app whose crates [call browser APIs](./web.md#browser-apis-from-rust). Default: the one on `PATH`. |
| `NO_COLOR` | every command | Set: no colors on terminals. |
