# Tooling

Commands for all three modes, Rust first. "Rust" is an app with `nsh.json` `"root"`. "Mixed" has `"rust"` and no
`"root"`, so `App.tsx` is the entry. "TSX" has neither. Mode pages: [rust.md](rust.md), [mixed.md](mixed.md), [tsx.md](tsx.md).

## First-run setup

Check `nsh --version` before initializing an app. If it is unavailable, read the
[installation guide](https://nsh.dev/docs/installation.md) for the current platform’s
supported distribution and install method. Installing this skill provides guidance;
the `nsh` CLI is installed separately. Use an existing project’s required CLI version
rather than updating it as a side effect of a feature change.

Rust and mixed apps also need Cargo and the target’s native build prerequisites;
TSX apps use the prebuilt runtime. Check only the target the user needs in
[Platforms and prerequisites](#platforms-and-prerequisites). Follow the environment’s
permissions when installing tools. If setup is unavailable, continue with code and
state which checks remain unverified.

For Cargo, recommend [huacnlee/cargo](https://github.com/huacnlee/cargo), the Cargo
NSH is developed with: dependencies built once for every project and Git worktree, and
a build directory that stays under a size limit. It replaces `~/.cargo/bin/cargo`, so
install it only when the user agrees; `cargo -V` names it.

```sh
curl -fsSL https://huacnlee.github.io/cargo/install.sh | sh     # Windows: irm https://huacnlee.github.io/cargo/install.ps1 | iex
```

For a new app, choose an unused destination and pass an explicit template:

```sh
nsh init my-app --template rust   # mixed or ts when selected
cd my-app
nsh check
nsh test
nsh run
```

Use the generated manifest’s versions and sources. Before adding Rust test
dependencies, follow [rust-testing.md](rust-testing.md#cargo-test-with-headless).
For TSX and mixed changes, also run `nsh build` to check bundler diagnostics.

## Commands by mode

Every command takes `[ENTRY]`: the app's directory (default `.`) or a TSX entry file. `-v` (or `NSH_VERBOSE=1`) prints everything. `nsh <command> --help` lists flags.

| Command | Rust | Mixed | TSX |
| --- | --- | --- | --- |
| `nsh init DIR --template` | `rust` | `mixed` | `ts` (the default off a terminal) |
| `nsh check` | `cargo check --all-targets`; `tsc` on test files if there is a `tsconfig.json` | `cargo check --all-targets`, then `tsc` | `tsc` |
| `nsh build` | Describes the crates; writes `app.json`, `assets/` | Describes the crates, bundles, compiles to bytecode | Bundles, compiles to bytecode |
| `nsh test` | `cargo test`, then `*.test.tsx` | Same | `*.test.tsx` |
| `nsh run` | Builds the app's runner, no QuickJS, restarts on change | Hosts built with the crate; TSX hot, Rust restarts | Prebuilt host; hot updates |
| `nsh dev` (`--server-only` for your own hosts) | Refused: use `nsh run` | Dev server and host | Dev server and host |
| `nsh package --target` | Runner from Cargo | Runner with the crate, from Cargo | Prebuilt runtime; no Rust toolchain |
| `nsh publish` | Refused | TSX only; crates ship in the host | Yes |
| `nsh update-manifest` | Yes | Yes | Yes |
| `nsh keygen`, `certify`, `verify`, `revoke`, `symbolicate` | Keys only | Yes | Yes |
| `cargo run` | Runs `src/main.rs` on the desktop backend | - | - |
| `cargo test`, `cargo check` | Direct | Direct, for the crate | - |

`nsh --help` says `nsh package` needs no Rust. That holds for TSX only.

### Facts that catch people

- **`nsh build` does not type check.** Only `nsh check` does. `nsh check` does not see what only the bundler knows: text in a `View`, a capabilities typo, a missing asset. Run both on TSX; see [tsx.md](tsx.md#who-reports-what).
- `nsh check` downloads TypeScript's native compiler once. Offline, pass `--tsc <path>` or set `NSH_TSC`.
- `nsh test PATH` with a directory runs `cargo test` for each crate. With a test file, it runs only that file.
- `.nsh/` is generated and git-ignored: `types/`, `rust/` (runner sources), `out/` (default output). Cargo keeps `target/` and respects `CARGO_TARGET_DIR`; huacnlee/cargo builds under `~/.cargo/targets/` and still puts the binaries in `target/`.
- Every command refreshes `.nsh/types` to the `nsh` you run.
- With `rust` or `mixed`, `nsh-*` crates come from crates.io at the CLI's version, or a checkout with `--nsh-source <dir>`. An app on another version is retargeted to this CLI, and only a real API change stops it. All NSH crates must come from one place.

## Dev server and logs

```sh
# Rust or mixed, from the app's directory; TSX the same, or name the entry
nsh run                          # this machine's backend
nsh run --target ios             # catalyst, ios, android, macos, linux, windows, gpui, tui, web
nsh dev --server-only            # TSX and mixed: serve hosts you start yourself
```

- **Port:** by default the app's last port, replacing its previous session (waiting up to ten seconds for cleanup), else the first free one from `8790`, so apps run side by side; `--server-only` defaults to `8790`. `--port` picks one and replaces the NSH session on it; another program on it is an error naming the port. `--port 0` asks the OS. `nsh run` listens on this machine only, with `--target ios`, `android` or `web` and in `nsh dev` on the network too.
- **Stopping:** Ctrl-C, `kill`, or closing the window stops the host too.
- **Rust edits:** rebuild and restart; state starts afresh. Build errors print in the terminal, and the next save that compiles runs.
- **TSX edits:** a patch of changed modules, about 120 ms. Edited components render again; the others keep their state. Top-level `signal(..)` and `createNavStack(..)` keep their values while the initializer is unchanged.
- **Full reload instead:** first import of a new NSH module, a `capabilities` change, a host on an older build, or a patch that cannot apply.
- **`--release`:** minified, no hot updates. Hardening stays off for anything loaded from a dev server.
- **Devices:** the server prints LAN URLs. A device needs the port reachable. Android uses `adb reverse`, which `nsh run` sets up.

**Reading the terminal:** `✓` done, `→` where to connect, `•` what a device did, `warn` and `error` problems, plain lines the app's own output.

| Mode | How to log | Where it goes |
| --- | --- | --- |
| Rust | `log::info!`, `log::warn!`, `log::error!` | `nsh run` terminal on the desktops and in the iOS simulator |
| TSX | `console.log` and friends | The terminal while connected; otherwise Xcode's console or `adb logcat` |

- An unhandled rejection is logged as an error with a mapped stack. A handler attached in the same turn counts as handling it.
- **Error overlay** in development: a build failure with a code frame, an error evaluating the bundle, an uncaught exception in a handler, timer or effect. Tap to dismiss.
- `nsh symbolicate <map> [input]` maps `bundle.js:LINE:COL` from a reported error back to sources.

## Trace and performance

```sh
nsh run --trace                                      # the host logs each commit's cost
nsh run --fps                                        # frame rate, phases, CPU, GPU and memory
nsh test App.test.tsx --trace                        # every mount batch, under the step that caused it
nsh test App.tsx --trace                             # first frame, then 1.2 s idle
echo 'await app.press("Add")' | nsh test App.tsx --trace        # and a press
echo 'await app.press("Add")' | nsh test App.tsx --trace --target ios   # the same on a simulator
```

`perf commit: 10 ops, 151µs (list js 2µs), 8 mount items, 27 nodes` is one commit. Use `--trace` to see which native views a change creates or updates: a press that recreates a list means a binding is wrong. In Rust, set `EngineConfig::trace = true` and call `app.observe(..)`. `--limits` (TSX) runs the app under an embedding host's limits: `--limits memory=128MB,call=500ms`.

## Platforms and prerequisites

Each desktop packages only on itself. Phones are reached from a computer.

| `--target` | Runs on | You need | Rust or mixed also needs |
| --- | --- | --- | --- |
| `macos` | macOS 14+ | Xcode's command line tools | Rust |
| `linux` | GTK 4.14+ | GTK 4 | Rust and GTK's dev packages |
| `windows` | Windows 10 1809+ | WebView2 for web views | Rust |
| `ios`, `ios-simulator` (package only) | iOS 15+; from macOS | Xcode and a simulator runtime | `rustup target add aarch64-apple-ios-sim aarch64-apple-ios` |
| `catalyst` (run only) | Mac, iPhone-sized window | Xcode | `rustup target add aarch64-apple-ios-macabi` |
| `android` | API 26+; from macOS, Linux or Windows | Android SDK (`ANDROID_HOME`), a JDK, a device or emulator | The NDK, and `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android` |
| `web` | Modern browsers | - | `rustup target add wasm32-unknown-unknown`, `clang`, `llvm-ar` |
| `gpui` (run only) | macOS, Windows, Linux with a GPU | Inside a GPUI app | TSX and mixed entries; a Rust root embeds instead |
| `tui` (run only) | A terminal | - | - |

Notes:

- `nsh run` on Linux opens a 390×844 window, and on macOS and Windows 1200×800. Set `--window-size` for TSX entries.
- `--target tui` logs to `.nsh/tui.log`; `C-h e` opens logs and errors.
- A Rust crate calling browser APIs needs the `wasm-bindgen` CLI at the version `nsh` names (`NSH_WASM_BINDGEN` overrides the path).
- On Linux, a crate that wants web views enables `webview` on `nsh-platform-linux`, which needs WebKitGTK 6.0.

## Platform-specific code

| Need | Rust | TSX |
| --- | --- | --- |
| A prop only one platform has | A builder method, ignored elsewhere: `.ripple(..)`, `.elevation(..)`, `.input_accessory(..)`, `.window_drag(..)` | `android={{ ripple, elevation }}`, `ios={{ textContentType }}`, `desktop={{ windowDrag }}`, `web={{…}}` |
| The OS | `os() == Os::Ios` (`nsh_core::element::Os`) | `platform.os === "ios"` |
| Desktop or mobile | `is_desktop()` | `platform.desktop` |
| A value per platform | `match os() { .. }` | `platform.select({ ios: .., android: .., default: .. })` |
| Style per platform | `.when(os() == Os::Ios, \|v\| ..)` | `ios:`, `android:`, `web:` classes |
| Conditional UI | `when(os() == Os::Ios, \|\| ..)` | `<If when={platform.os === "ios"}>` |
| Android back button | `on_back_press(listener)` | `BackHandler.on("press", listener)` from `nsh/mobile` |
| Bar over the iOS keyboard | `input_accessory_view(id)` | `InputAccessoryView` from `nsh/mobile` |
| Windows and menus | `nsh_core::element::desktop`: `window()`, `current_window()` (`WindowRef`: `set(WindowAttributes)`, `set_mode`, `close`, ...), `title_bar`, `set_application_menu`, `popup_menu` | `<Window>`, `Window.open`, `currentWindow()` (`WindowRef`: `set({ title, titleBar })`, `setMode`, `close`, ...), `Menu`, `titleBar` from `nsh/desktop` |
| Status bar | `.status_bar(StatusBarStyle::Light)` on `nav_page()` or `dialog()` | `statusBar={{ foreground: "light" }}` on `NavPage` or `Dialog` |
| Target-gated Rust | `#[cfg(target_os = "macos")]`, `#[cfg(target_arch = "wasm32")]` | - |
| A view of the OS | `native(name)`, registered with `#[native_components(macos)]` | `nativeComponent(name, spec)` |

- Desktop means macOS, Windows, Linux, and browsers in the desktop idiom. Mobile means iOS, Android, Mac Catalyst and browsers in the phone or tablet idiom.
- Gate layout and input on `platform.desktop`. Gate windows and `Menu` calls on `isAvailable` from `nsh/desktop`, which is false in browsers.
- Mac Catalyst reports `"ios"` and takes `ios={{…}}` props.
- Web has no registered native components. On the desktops, `#[native_components]` is one function per platform, each registering the same names, with `nsh-platform-*` per-target dependencies.

```tsx
import { platform, Text } from "nsh";

const hint = platform.select({ ios: "Swipe down to close", android: "Press back to close", default: "Close" });

export function Hint() {
  return <Text class="text-muted-foreground ios:text-sm">{platform.desktop ? "Esc to close" : hint}</Text>;
}
```

## Capabilities

Declared in `nsh.json`, enforced natively, in development too. They bound TSX, and Rust's calls into NSH's services (`fetch`, images, web views, the status bar). A Rust crate's own native code, such as `std::fs`, is not sandboxed; it has the app's trust.

```json
{
  "capabilities": {
    "network": {
      "hosts": ["api.example.com", "*.cdn.example.com"],
      "http": [{ "host": "quotes.example.com", "methods": ["GET"], "pathPrefix": "/v1/" }],
      "sockets": ["feed.example.com:7000"]
    },
    "webview": { "hosts": ["*.example.com"], "input": true },
    "statusBar": true,
    "clipboard": true,
    "picker": true,
    "speech": true,
    "notifications": true,
    "host": ["getUserInfo", "bridge.*"],
    "openUrl": { "schemes": ["https", "mailto"] }
  }
}
```

- No `"capabilities"` key: everything is allowed, except `network.sockets`, `host` and `webview.input`, which must always be named.
- With the key: only what it lists. A typo fails `nsh build`, and `nsh check` passes it.
- `*.example.com` does not match `example.com`.
- A refusal in TSX rejects with `ERR_ACCESS_DENIED`, plus `permission` and `resource`, and logs the key to add. In Rust: a refused `fetch` is an `Err`, `open_url` is `false`, and a clipboard read is empty.
- `nsh build` and `nsh package` write `capabilities.json`; `nsh publish` signs them into the header. A host may grant less.

## Packaging

```sh
nsh package --target macos            # ad hoc signed .app
nsh package --target linux            # <Name>/ and <Name>.tar.gz
nsh package --target windows          # <Name>\ and <Name>.zip
nsh package --target ios-simulator --run
nsh package --target ios --sign "Apple Distribution: Example Inc (ABCDE12345)" --profile AppStore.mobileprovision
nsh package --target android --keystore release.jks --key-alias upload
nsh package --target web              # static site
```

- Output goes to `.nsh/out/`, or `-o`.
- `nsh.json` gives `name`, `id` (required), `version`, `build`, `icon`. Flags override them: `--name`, `--id`, `--app-version`, `--build`, `--icon`. What NSH cannot read (unknown keys, values of an unknown form) is warned of and left out. A `com.example.` id warns.
- `--run` installs and launches; `web` serves the site. Not for `--target ios`.
- Android defaults to the debug key and to `arm64-v8a` and `armeabi-v7a`. `--abi` changes them. `NSH_KEYSTORE_PASSWORD` holds the password.
- A TSX entry adds its name: `nsh package App.tsx --target ...`. A mixed app is run from its directory the same way, with Cargo building its runner.

## Updater

`nsh/updater` replaces a packaged app. It is for the whole app; for screens under a host, use signed packages.

| Platform | Behaviour |
| --- | --- |
| macOS, Windows, Linux | Checks, downloads, replaces, restarts |
| iOS, Android | Checks and gives a link |
| Web | `checkForUpdate` resolves `null`; a deploy updates |

```json
{ "version": "1.2.0", "updater": { "github": "owner/repo" } }
```

With your own host, `"updater": { "url": "https://dl.example.com/app/latest.json", "publicKey": "<keys/update.pub>" }`; the key is required there.

```tsx
import { openUrl } from "nsh";
import { checkForUpdate, downloadUpdate, installAndRestart } from "nsh/updater";

export async function update() {
  const found = await checkForUpdate();
  if (found?.canInstall) {
    await downloadUpdate(({ received, total }) => console.log(received / (total ?? 1)));
    await installAndRestart();
  } else if (found) {
    await openUrl(found.url);
  }
}
```

Release: raise `version` (semver), run `nsh package` per platform to get its archive, then run `nsh update-manifest *.tar.gz *.zip --notes CHANGES.md --key keys/update.secret`, and upload the archives, `latest.json` and `latest.json.sig`. In a development run, `checkForUpdate` resolves `null`. Drafts and prereleases on GitHub are not offered.

## Signed packages

A `.nshpkg` delivers **TSX** to a host app that embeds NSH. It holds JS source, bytecode, a source map and assets. A Rust crate ships in the host. See [mixed.md](mixed.md#signed-packages).

```sh
nsh keygen keys/root                  # keep root.secret offline
nsh keygen keys/release
nsh certify --root keys/root.secret --key keys/release.pub --apps 'com.example.*' -o keys/release.cert
nsh publish App.tsx --key keys/release.secret --cert keys/release.cert
nsh verify .nsh/out/com.example.app-2.nshpkg --root keys/root.pub
```

- `build` must grow with every release. Hosts refuse older builds.
- `--source-map package|file|none`, `--strip-debug`, `--min-runtime <version>` (default: this CLI's version; older runtimes refuse it).
- `nsh revoke --root <secret> --extend <last list> --key <id> -o <list>` revokes a key; ship lists separately from the app.
- `nsh publish <file.nshpkg> --key .. --cert ..` signs a package again, for a platform that signs its apps' packages.
- NSH verifies and runs packages. Delivery is the host's job.
- QuickJS does not validate bytecode, so NSH loads it only from the app's own resources, a dev server, or a verified package.

## The verification loop

Run the whole loop for your mode before calling work done. Skip full builds when `check` and headless tests answer the question.

**Rust**

```sh
cargo check --all-targets      # or nsh check, which also checks TS tests
cargo test                     # headless, through the UI, with nsh_testing::Headless
nsh run                        # look at it
```

**Rust + TSX**

```sh
nsh check                      # cargo check --all-targets, then tsc against the generated types
nsh build                      # read every warn: undocumented exports, unknown classes, props taken apart
nsh test                       # cargo test, then *.test.tsx in a runner linked with the crate
nsh run                        # TSX hot; Rust restarts
```

**TSX**

```sh
nsh check                      # the only type check: fix every error
nsh build                      # treat every warn as a finding
nsh test                       # headless, hardened
nsh run                        # look at it
```

On a platform, `nsh test --target macos` (also `linux`, `windows`, `gpui`, `tui`, `web`, `ios`, `android`) uses real input. Headless is the default and needs no device, so use it first. A passing test does not prove the look: an unstyled `Switch` passes and draws nothing.

| Selector in tests | Finds |
| --- | --- |
| `text:Add`, `label:Save`, `id:new-todo` | A text, an accessibility label, a `testID` |
| `role:button[Save]` | A role and name |
| `id:cart >> role:button[Remove]` | Inside a match |
| `text:Delete >> nth=1` | One of several |
| `text:/^Buy/i` | A regex |
