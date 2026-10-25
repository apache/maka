# Tooling: TypeScript, the dev server, runtimes

## TypeScript

- Every command that builds an app writes `.nsh/types` next to its entry (only changed files; files NSH no longer writes
  are removed). None of it is checked in, and nothing in it depends on the app's code: `nsh_js::type_definitions(ui_sets)`
  (the UI sets as data: `nsh_core::ui::description::SetDescription`, each with its generated declarations)
  makes the declarations of everything NSH serves (`nsh-js` `declarations.rs`), and `nsh_bundler::type_definitions()`
  the asset imports. The files: `nsh/index.d.ts` (`nsh`), one per module (`nsh/list.d.ts`, `nsh/base.d.ts`,
  an app's set's `app/native.d.ts`, ...), `nsh/types.d.ts` (the styles, the elements' props and events, `YNode`, the JSX namespace; `nsh` exports them),
  `nsh/jsx-runtime.d.ts` (where `jsxImportSource` finds `JSX`: no intrinsic elements, so every tag is checked as the
  component it names and generic ones are inferred: `native-pipeline.md`), `nsh/globals.d.ts` (console, timers,
  frames, the web APIs and the control flow components `If` / `Each`), and from the bundler `nsh/assets.d.ts` (what
  image and font imports give) and `nsh/tokens.d.ts` (`nsh_bundler::tokens_declaration`: `interface Tokens` of `nsh`,
  every design token of the app's theme, `nsh.json` `"theme"` over the default, by name with its type, which types
  `token()`; a theme that does not parse gives the default's names, and the build reports it). Each file declares its own names; the `import type` lines between them are worked out
  from the names each uses. Next to them nsh writes `.nsh/tsconfig.json` (`nsh_bundler::TSCONFIG_BASE`): the
  compiler options mapping `nsh` and `nsh/*` there (`jsxImportSource: "nsh"`, no DOM library, `ESNext.Disposable`)
  and the globals, assets and tokens files; the `tsconfig.json` `nsh init` writes (`nsh_bundler::TSCONFIG`) only extends it
  and includes the app's sources, so editors type-check apps without `node_modules` and a change of nsh's settings
  (a new `lib`, a path) reaches existing apps with the next build, without an edit of theirs. An app's
  `tsconfig.json` that an earlier `nsh init` wrote and the app never changed (`templates/tsconfig/*.json`, compared
  byte for byte) is replaced by the new one, with a note saying so; one the app changed is never rewritten, and
  `nsh check` warns that it does not extend `.nsh/tsconfig.json`, saying what to change. Only the type checker reads
  `tsconfig.json`: bundling never does (rolldown's `tsconfig` option is off, `bundle.rs`), so an app bundles before
  any command wrote `.nsh/tsconfig.json` (`nsh_testing::compile_tsx` in a fresh checkout), and its `paths`, which
  lead to declarations, never decide what a bundle imports. Aliases are `nsh.json`'s `"resolve"`.
- Where each declaration comes from:
  - a native module's export: the `Ts` next to it in its table (`modules::Item`; the module's own interfaces in its
    `types`);
  - a registry's components and modules: their specs (`nsh_core::ui::declarations`; a module object's type is
    `<Name>Module`, which a native module can build on: `BackHandlerModule & BackListeners`);
  - the styles, host props, events, easings and canvas methods: the core's tables (`nsh_core::js::{style, host, animation,
    canvas}::declarations`; an event's handler type is its row in `host::EVENTS`, an event no element declares is in
    `INTERNAL_EVENTS`);
  - a web class: its spec's `ClassTs` (members as in a class body; the constants come from the spec's table), the
    types its file declares in `TYPES`, a global function's `web::Function`, the other globals `host::GLOBALS`.
- The text of declarations (documentation, TypeScript) is only in builds that can write them: the WebAssembly runtime
  (`nsh_core::ui::DECLARATIONS` is false there) leaves it out, as pages download it. The tables keep their shape and
  wrap the text: `Ts::function` / `value` / `class`, `ClassTs { … }.declared()`, `decl!("…")` (a constant's text is
  then not in the binary at all), and generated code calls `ts_of::<T>()` instead of `T::ts_type`. New tables do
  the same; nothing the runtime needs (names, lengths, whether a method returns) goes through them.
- The tests keep them true: every module is loaded and its exports compared with its declarations
  (`declarations_match_the_modules`), every web class's members with its spec (`web_classes_declare_their_members`),
  the globals with a host's (`globals_match_the_host`: what is declared exists, and every global the host adds to
  QuickJS-NG's is declared), every event has a type or is internal, and every imported name has one home.
- To check the declarations themselves, run `nsh check -- --skipLibCheck false` in an app.

### `nsh check`

The bundler strips types without checking them (Oxc), and no Rust type checker for TypeScript exists: checking means
running TypeScript itself. The options were:

- **Bundle the JS compiler** (`typescript.js`, ~9 MB) and run it in QuickJS: QuickJS is 10–50× slower than V8 at this
  workload (tens of seconds for a small app) and the compiler needs a host for files and `lib.*.d.ts`; no.
- **Require Node** (`npx tsc`, `bunx tsc`): what apps did before; the only Node dependency of the toolchain.
- **Run TypeScript's native compiler**: TypeScript 7 (July 2026) is the Go port, shipped on npm as one executable per
  platform (`@typescript/typescript-<os>-<arch>`, `package/lib/tsc` with its `lib.*.d.ts` next to it) behind the
  `typescript` package's optional dependencies. It needs no Node and checks the same as TypeScript 6.

`nsh check` does the last (`crates/nsh-cli/src/check.rs`): it writes `.nsh/types` as every command does, then runs
`tsc -p <app dir> --noEmit` (arguments after `--` are passed on). The compiler is a pinned release (`TYPESCRIPT`),
downloaded from the npm registry's tarball URL the first time (ureq, no npm client), checked against the
`dist.integrity` (SHA-512) recorded in the source for each host it supports (macOS, Linux and Windows, arm64 and x64; on Windows the compiler is
`package/lib/tsc.exe`), unpacked into NSH's cache (`NSH_CACHE`, else `~/Library/Caches/nsh` / `$XDG_CACHE_HOME/nsh` /
`%LOCALAPPDATA%\nsh`) and kept there. `--tsc <path>` /
`NSH_TSC` run another `tsc` (a TypeScript 5 / 6 one, an offline copy). An app with Rust crates (`nsh.json` `"rust"`)
has each crate checked first (`check::cargo_check`, called from `main.rs` `run` before the crates are described, so
their errors are Cargo's own): `cargo check --all-targets --manifest-path <crate>/Cargo.toml` in the crate's directory,
in the workspace and target directory Cargo uses there (`AppCrate::cargo`). A Rust app (`"root"`) is type checked only
when it has a `tsconfig.json` (`check::has_typescript`: its test files'), which also decides whether `.nsh/types` is
written for it. Updating TypeScript is a change of the version
and the integrities (`npm view @typescript/typescript-<os>-<arch>@<version> dist.integrity`). The distribution
(`cargo xtask dist`) does not ship the compiler: it is 24 MB per platform and most runs of `nsh` never check types.

## Project files

NSH-generated declarations, runner workspaces, tests and default build/package outputs live under `.nsh/`.
Default bundles and packages are `.nsh/out/`; `--out` still overrides that location. Cargo keeps its normal
`target/` cache and existing `CARGO_TARGET_DIR` behavior. NSH does not add Cargo configuration to relocate it.
Existing directories are never deleted automatically. Follow the CoC project constraint in `AGENTS.md`.

## LayerFS trial

The opt-in [LayerFS trial](layerfs.md) exercises Git, Cargo, build-output snapshots and branch isolation on Linux.
`./scripts/layerfs prepare`, `smoke` and `status` prepare and inspect it; macOS preparation runs in a local Linux
Docker container. Its generated inputs and receipts live under `.nsh/layerfs/`; it reuses the normal Cargo cache
and has a manual GitHub Actions workflow. It is separate from the platform checks.

## Output


The CLI's terminal output is `crates/nsh-cli/src/ui.rs` (`website/docs/cli.md`, "Output", shows it): one line per
step, the details only when something fails. Every command prints through it:

- `✓` a step that finished (`ui::done`, or `ui::Step`, which shows a spinner while the step runs, on a terminal only,
  and adds its time), `→` where to find something, `•` what a device did, `warn` / `error` (wrapped under their first
  word on a terminal), plain lines for the app's own output. Paths are relative to the current directory when inside
  it. Colors on terminals unless `NO_COLOR` is set; redirected, only the result lines, no ANSI. All of it is stderr:
  stdout is the commands' results (`nsh test --trace`'s mount items, the signing commands' lines).
- Tools run captured: `ui::cargo` (every cargo build: the app's crate, the hosts, `cargo xtask android`) shows the
  crate being compiled in its spinner, counts cargo's warnings into the `✓` line and, when the build fails, returns a
  `ui::failure` whose details are cargo's whole output; `ui::report` prints `error <message>` and those details (the
  commands' errors all end there, `main.rs` `main`). `ui::quiet` keeps the desktop hosts' own output (AppKit's notes,
  GTK's) and shows it if the host fails. simctl, adb, codesign and the SDK's tools were captured already.
- Log lines (`logger.rs`): the library crates and the devices log through `log`; normally warnings and errors are shown
  without targets (a device's after its name: `warn iOS Simulator: …`), `js` lines and a device's lines from other
  crates (the app's Rust code) plainly (with the device's name when several are connected), `nsh::perf` as `perf …`;
  NSH's own info lines (a device's "loading build 3") are not shown: the CLI's steps say what happens. The dev server
  reports hosts connecting and leaving (`nsh_dev::ClientEvent`) rather than logging it, so the CLI prints
  `• Mac Catalyst connected, build 1`, and a host that cannot run the app as one `warn` line
  (`warn Android Emulator: its host has no gallery/native (it was built for another app): nsh run examples/gallery-rs
  --target android installs this app's host`; "Dev server" below).
- Verbose (`-v` / `--verbose` on any command, or `NSH_VERBOSE=1`; an app's headless runner forwards its debug lines then): no spinner,
  and everything as it comes: every log line with its level and target, cargo's and the hosts' output.

`xtask` has the same style in `crates/xtask/src/term.rs` (it cannot depend on `nsh-cli`, which would build the bundler
before every `cargo run`): `✓` lines for its builds, cargo's and the tools' output only when they fail, `-v` /
`NSH_VERBOSE` to see it all (`cargo xtask clippy-android` streams clippy's output: it is what the task is for).

## Dev server (nsh dev / nsh run)

- The CLI watches sources with notify and pushes every rebuild over WebSocket (`/ws`, default port 8790, the next free port if taken) to all
  connected hosts; new clients subscribe before receiving the current state, so no event is missed. Protocol: `crates/nsh-dev/src/protocol.rs`
  (JSON text frames + binary frames).
- Bytecode version negotiation: the client reports `BYTECODE_VERSION` in its handshake; on a mismatch the server sends JS source instead
  (an empty version, the web host's, asks for source without a warning).
- Limits: hosts run the app on its own, without limits, unless `--limits` asks for an embedding app's
  (`DevServer::set_limits`, the bundle message's `limits`, `HostLimits`' syntax; the hosts read it with
  `Limits::development` and start the app with it, and an invalid one is shown over the app). `sandbox.md`.
- The web host is a page the dev server serves itself (`DevServer::serve_web`, the fallback route: `/`, `/nsh.js`,
  `/nsh.wasm`, `/nsh.version`, and for a runtime whose crates call JS through wasm-bindgen its glue, `/nsh-bindgen.js`,
  with the snippets it imports, `/snippets/…`) when a web runtime exists; browsers connect to `/ws` on the same port.
  `nsh run --target web` builds the runtime in a checkout and prints the page's address (`docs/dev/web.md`, "The CLI's
  web target" and "Crates that call JS through wasm-bindgen").
- Watching ignores `Access` events: inotify (Linux) reports reads, FSEvents does not, so the build's own reads of the
  sources would start the next build, forever.
- `nsh dev` and `nsh run` default to the host that runs on this machine: `--target macos` on macOS, `--target linux` (the GTK
  host, `crates/nsh-linux-host`, run in place: it needs no app bundle) on Linux, `--target windows` (the Win32 host,
  `crates/nsh-windows-host`, run in place too) on Windows. `--target macos` runs the AppKit host
  (`crates/nsh-macos-host`) in place too: it makes itself a regular app without a bundle. `--target gpui` runs the
  GPUI host (`crates/gpui/nsh-gpui-host`) in place on any of the three: it shows a TSX app as GPUI apps that embed it
  show it (GPUI is the backend for embedding; a Rust app of Rust only runs on the OS's own backend). GPUI hosts report
  `HostPlatform::Gpui`, so the dev server shows them `nsh run --target gpui`. The hosts are stopped with the run
  (Ctrl-C, SIGTERM, the session ending); a host that exits with an error ends it with its kept output. On Windows the host starts in a
  process group of its own (`CREATE_NEW_PROCESS_GROUP`), out of the console's Ctrl-C, so a stop is not taken for the
  host failing, and in a job object that kills it when the job closes (`run::KillOnClose`): Windows ends a child with
  its parent only in a job, so the host goes with `nsh` however it ends (a closed console, a killed process).
- `nsh run --target tui` runs `nsh-tui-host` in the current terminal on Linux, macOS and Windows, reporting
  `HostPlatform::Tui`. It inherits terminal streams, applies hot updates, reloads with Ctrl+R and exits with Ctrl+Q.
  The CLI buffers its output until the host restores the terminal; stopping or restarting the host requests graceful
  shutdown before forcing termination. `nsh package --target tui` creates a console executable beside `nsh/` resources,
  archived as `.tar.gz` on Unix and `.zip` on Windows; `--run` uses the current terminal and waits for exit.
  See [Terminal backend](tui.md) for resource layout and headless `--script` snapshots.
- `nsh run --target android` forwards the dev server's port to the device (`adb reverse tcp:<port> tcp:<port>`,
  `android::Reverse`) and removes that rule, and only that one (`adb reverse --remove tcp:<port>`), however the run
  ends: normally, by an error, by Ctrl-C or SIGTERM, or for a restart of an app with a Rust crate (`rust_app::Restart`;
  the next run sets it again). Otherwise a host left on the device keeps reaching whatever dev server listens on that port
  next, of any app. Ctrl-C reaches the run through `ui::Stoppable`: while one is held, the signal handler records
  SIGINT / SIGTERM instead of ending the process, the dev session's watch loop returns, the command undoes what it set
  up, and `main` then ends the process by the same signal; a second signal ends it at once. `nsh dev --server-only` serves hosts started separately. Mobile targets
  use an explicit `--target ios` or `--target android`.
- Hosts that cannot run the app: several hosts on one session is intended (a phone joining), but a host serves only the
  UI sets it was built with, and dev hosts keep reconnecting, so a host built for another app (an Android host left on
  the emulator, whose `adb reverse` still reaches this port) can connect. The hello reports the host's platform and
  the specifiers of the UI sets it serves (`HostPlatform`, `ui_sets`: iOS `set_ui_sets`, Android `ui_sets!`; `nsh/base`
  for the prebuilt hosts); each bundle is published with the UI sets it imports (`Built::ui_sets`: the bundle's
  native imports that are UI sets, `Bundle::natives` / `HotBundle::natives`). The server checks every host against
  the latest bundle, on connect and on each new one: a host missing any gets neither the bundle nor its patch (nor
  build errors, which would hide why) but `ServerMessage::CannotRun`, which it shows over the app ("This host cannot run
  the app", what is missing and the command that installs the app's host, from `DevServer::install_commands`: one per
  platform `nsh run` has a target for), and the CLI prints one `warn` line (`ClientEvent::CannotRun`), once per change
  of what is missing. A later bundle that needs only what the host has reaches it again. Hosts that do not report
  their UI sets (older ones) get every bundle.
- The host's `log` output (including JS `console.*`, target `js`) is forwarded to the CLI terminal with the device name while connected, and goes
  to stderr when disconnected (see "Output" for what the CLI shows of it). Unhandled promise rejections are part of
  it: `unhandled rejection: <reason>` at level error, target `js`, the stack mapped to the sources as an uncaught
  exception's (`Script`'s rejection handler in `nsh-engine`; on the web the browser console gets it).
  Terminal hosts buffer diagnostics for the connected dev server and optionally append them to `NSH_LOG`; forwarded
  messages strip terminal controls while preserving newlines and tabs.
- Build failures, bundle evaluation failures and uncaught exceptions show an overlay on the host (dark, the title in red; tap to dismiss; its Copy button copies the error, to paste into an AI chat or a report); it disappears on the next
  successful reload. They also reach the host app's error handler; unhandled rejections are logged only, as a
  browser logs them.
- **Hot module replacement** (`nsh dev` / `nsh run` without `--release`): development bundles keep one CommonJS chunk per
  module (rolldown `preserveModules`, tree shaking off), each registered with the native hot runtime
  (`crates/nsh-js/src/hot.rs`, the `__nsh_hot` global that importing `nsh:hot` makes; only development bundles import
  it). The script is an ES module importing `nsh:hot` and the namespaces of the native modules the app imports statically, for the
  factories' `require`. Native `import()` expressions load on demand, so a platform branch can select its host's APIs;
  the full import catalog still checks that the host serves every required UI set. An edit importing a native module the running script did not makes the host reload. After a
  rebuild the CLI compares the chunks with the last good build and publishes a patch (`ServerMessage::Patch`, protocol
  v2) before the full bundle; hosts running the patch's base apply it in place (`EngineControl::hot_update`,
  ~0.2–0.5ms) and otherwise load the bundle. The runtime runs the changed modules again, plus the importers of modules
  that do not accept their own updates, up to the entry. The bundler's hot transform (`crates/nsh-bundler/src/hot.rs`,
  before the JSX is compiled) wraps top-level components (capitalized functions whose body has JSX) in stable proxies
  keyed by module and name, with a signature of their code plus the module's other code: a proxy is a memo over a
  version signal, so instances render again only when their signature changed (or a dependency module changed) and the
  rest of the app keeps its state. Top-level `context()` results keep their identity (taking the new default), and
  top-level `const`s made by `signal()` or `createNavStack()` (matched by the callee's name, as `context`) keep their
  value while their initializer's code is the same (`__nsh_hot.keep`, keyed by module and name; a changed initializer
  starts afresh). A function passed to a top-level `mount()` is a component too (`mount#<n>`). When a module runs
  again, a `mount` call with the same component as its previous run's next one (the same proxy: `mount(App)`, or the
  inline function's) and no props keeps that mount; from the first one that differs, the rest of the previous run's
  mounts are undone and mounted anew (`hot.rs` `reuse`). So what an update keeps:
  - an edit of a component (in any module, the entry too) renders its instances again: their own signals start
    afresh, and so does the state of the components they render (rendering a component again makes its children
    anew); everything outside them keeps its state;
  - an edit of a module's other code (a top-level constant, a helper) renders every component of that module again,
    and of the modules importing it up to the ones made only of components;
  - a navigator made at the top of a module keeps its routes, so a stack rendered again shows the same screens (the
    screens' contents render anew); a top-level signal keeps its value;
  - a changed `mount` call (another component, props) mounts the app again.
  `crates/nsh-engine/tests/engine/hot.rs` covers each case. A component that throws reports the error and renders
  nothing until the fix. A patch that throws shows the error and the next save recovers; a patch that cannot be applied (`false`)
  makes the host reload. Verified on the iOS simulator, the Android emulator and Mac Catalyst.
- Stacks are symbolicated with source maps: bundling produces a hidden source map (the TSX→JSX→JS maps are composed with
  `rolldown_sourcemap::collapse_sourcemaps`), sent along with the bundle; the engine rewrites `bundle.js:L:C` to `App.tsx:L:C` before reporting.

## `nsh build --split`

Writes a split bundle (`native-pipeline.md`, "Split bundles"): `bundle.js` / `.map` / `.nshc` and, per chunk,
`<id>`, `<id>.map` and `<stem>.nshc` (`build::compile_split`, `Built::chunks`). Without `--split` (and for `nsh
package`, `publish`, the dev server) the bundle holds the whole app.

Hosts serve a chunk the bundle does not hold through `MountSink::load_chunk` (`AppOptions::chunks` on macOS):
`nsh-macos-host --bundle <path>` reads it from the bundle's directory, the packaged macOS runner from
`NSH_CHUNK_DIR` (a writable directory an app fills with its own delivered modules — the bundle's resources are
read-only). File reads run on a global dispatch queue and reply through the requesting engine's
`EngineControl`, keeping AppKit responsive and replies tied to that engine across app reloads. Chunks always load
as source: files can be replaced, so bytecode only comes from an app's signed resources (`Bundle::read`).

## Headless runs

`nsh-testing`'s `headless` module runs apps without a platform, on its driver `Headless` (the crate's default
features, without QuickJS):
the app on an engine (`ApproxTextEngine`, a channel as the mount sink, 60 Hz frames from a timer thread), its batches
applied to a model of the native views (`headless::Screen`, `headless/screen.rs`), and steps taken on what they show.
An observer sees every batch with the step it came in; `print_batch` prints it as `nsh test --trace` does
(`── press(id:save): 8 items`).

The steps name views with selectors (`headless/selector.rs`, Playwright's manner): `id:<testID>`,
`label:<accessibilityLabel>`, `text:<text>` (an input's text or, while it is empty, its placeholder too), `role:<role>`
with an optional `[<name>]` (the label, else the texts inside), `view:<id>` or a bare string (testID, then label, then
text); `label:`, `text:` and names take `/regex/flags`, ` >> ` looks inside the previous part's matches, `nth=<n>`
keeps one. `Screen::resolve` lists the matches where a user would look first: the top modal, then the rest in tree
order below the root, of a stack only its top screen, and only the views that show (`Screen::shown`, as Playwright's
visibility): with an area (a `display: none` view has none), outside `visibility: hidden` (`ViewStyle::hidden`), not
clipped away by `overflow: hidden`, a scroll view the user cannot scroll (`ScrollBehavior::enabled`) or the window
(`Screen::set_viewport`: the headless viewport; on a host the platform's, which `Agent::sync_viewport` tells the model
before each step). A scroll view the user can scroll shows all of its content (scrolling brings it in), a modal shows
over the window wherever it is in the tree, header items and input accessories wherever the platform puts them;
`opacity` and transforms aside. The spans of a text that take presses (`AttributedText::links`: a nested
`<Text onPress>`, a `TextView`'s links) are views of the model too (`Screen::set_spans`), inside their text view (or
the span around them), found by their characters (`text:`, a bare string) and pressed as the platform presses them:
the events go to the span's node; they are not texts of their own (`texts()` lists the text view's).
`Screen::span_style` reads the resolved style of characters a selector names (`id:<testID>` a nested text's test id,
`text:<text>` where the text reads it), the first character's, including a nested text's background. `app.spanStyle`
returns that style. A span's test id is listed on its block's text (`AttributedText::test_ids`). Setting the id
later updates the block's metadata and remounts its existing final layout, including fitted font sizes, without
preparing or laying out the text again or reporting `onTextLayout`. Empty spans have no first character:
queries report an error, including bare selectors whose test id matches an empty span. Steps acting on a view are strict, as Playwright's: the matches
are mapped to what the step acts on (`Screen::pick`: the pressable ancestor, the input inside, the scroll view around)
and more than one fails the step; a press whose match, or a view between it and its pressable ancestor, is disabled
(the accessibility state) fails too. When the app moves the focus (`focus()`, `blur()`), the input it left gets
`Blur` and the one it went to `Focus`, as on a platform. Each step sends what a platform would, to the views that
report it:

- `press`: the match or its nearest pressable ancestor gets `PressIn`, `PressOut`, `Press`, at the match's center
  (a press of a text inside a pressable view lands on the text, as a finger does); presses of one view within
  500 ms count up (`clicks` 2 is a double press), as the platforms count them;
- `long_press`: the match or its nearest ancestor hearing long presses or presses gets `PressIn`, then after its
  `delayLongPress` (500 ms) `LongPress` and `PressOut`;
- `clear`: the input takes the focus, gets a `KeyPress` of `Backspace` and an edit to nothing;
- `type_text`: the input (the match or the first input in it) takes the focus (`Blur` to the one that had it,
  `Focus`), then each character is a `KeyPress` and a `ChangeText` with the edit count, within `maxLength`; a line
  break in a single line is the return key;
- `submit`: the return key as the input's `submitBehavior` resolves (`InputConfig::submit`): `KeyPress` `Enter` and
  `SubmitEditing` (then `Blur` for blur-and-submit), or a line break;
- `scroll`: the scroll view (the match, the nearest one around it, else the first in it) moves along its axis 10
  points per frame within its content (`ScrollDragStart`, offsets with the applied count as platforms report them,
  `ScrollDragEnd`, `ScrollEnd`), and fails on one the user cannot scroll (`scrollable={false}`); the model applies `ScrollBy` and `ScrollTo` / `ScrollToEnd` and reports where a
  command moved the view;
- `drag` (`headless/pointer.rs`): a finger lands on the match's middle (`Screen::bounds_in_root`), rests 100 ms,
  moves 10 points a frame and lifts, and what takes it is decided as the desktop backends decide it, with
  `nsh_core::input` over the views from the match out (`Screen::link`: events, tracked states, gesture values, the
  scroll axis, `panActivation`): the views listening to touches hear `Touch` (start, moves, end; the JS responder's
  `SetJsResponder` block keeps native drags from starting), past the slop a pan (`PanStart`, its `pan` values moved
  through nsh-core's `animation::Animator`, which the headless animator wraps, `PanEnd` with the velocity) or a
  scroll view (dragged within its content; past its top only when it listens to `Refresh`, rubber-banded, refreshing
  when released past `scroll::refreshes`) takes it, and the press under it is cancelled once it moves away;
- `hover` (`headless/pointer.rs`): on a desktop environment the mouse comes over the match's middle: the views from it
  out that hovering matters to (`input::hoverable`: `hover:` styles or hover events) replace those hovered before
  (`Screen::set_hovered`), `input::hover_changes` says which hear `HoverOut` and `HoverIn` (with their `HOVERED` state
  reported, `EngineControl::set_states`), and the hovered views hear `HoverMove`;
- `right_click`, `choose_menu_item`, `close_menu` (`headless/menus.rs`): on a desktop environment the match, or the
  nearest view around it listening, hears `ContextMenu`; the menu the app then shows (`Menu.popup`,
  `DesktopCommand::PopupMenu`) is the model's (`Screen::menu`, read through `menu.rs`: its actions by label, a
  submenu's as `"Share > Mail"`) until it is chosen from (the root hears `Menu` with the action's id, then
  `Menu { closed }`) or closed;
- `press_key` (`headless/keyboard.rs`, `app.keyboard.press`): the keystroke as `nsh/keymap` parses it for the
  environment's OS; on every environment (a hardware keyboard: phones and tablets have one too) the root's keymap
  (`MountItem::Keymap`, `Screen::keymap`) finds the binding that fires where the focus is (`Keymap::find`) and the
  root hears `KeyCommand`; else, on macOS and the web, Tab / Shift+Tab move the keyboard focus between the stops
  (`Screen::tab_stops`: editable inputs and pressables not `focusable={false}`, in tree order, around), telling the
  views `Blur` / `Focus` and the pressable its `FOCUSED` state, and Return or Space presses the pressable it is on (a
  press of the pointer takes it off); else the focused input takes a character, Backspace or the return key, else
  Escape goes back when there is something to go back from;
- `wait`, `wait_for` / `wait_for_gone` / `wait_until` (until a selector matches, matches no more, a condition on the
  screen holds), `next_change` (one batch or animation frame: what `nsh/test`'s `waitUntil` waits for between calls
  of its JS condition), `idle` (until quiet for a while).

A step first applies the batches that came since the last one (they belong to it), then waits until the app is quiet
for 100 ms and no native animation runs (2 s at most). It fails, with the texts on screen, when it cannot be taken, and when the app threw meanwhile
(`MountSink::report`: an exception that escaped a callback, a bundle that did not load, a stopped VM; an asset's
failure is the log's only). The model keeps inputs' text and edit count as platforms do: a value JS sets for fewer
edits than were typed is dropped. `headless::StubNetwork` (routes by `"<METHOD> <URL>"`, `*` matching any text, others
fail: a `StubResponse`, which may fail the request with `error` or come after `delay`, or a `StubHandler` that answers
through a `StubReply` whenever it likes) and `headless::MemoryStorage` (entries given up front) stand in for the
device's services; `RecordingNetwork` keeps the requests a network gets. On a manual clock (`EngineConfig::clock`,
`architecture.md` "Time") the driver moves the app's time: the engine's frame requests set a flag instead of waking a
sleeping thread, and while it is set or a native animation runs, every wait (`pump`) takes a frame at once
(`Headless::frame`: `advance_clock` by a frame's time, the frame, the animator's tick on the clock's time); `wait`,
a long press's hold and scroll frames move the clock by their time; `run_for` / `fast_forward` / `set_system_time` are
the test's (`app.clock`); the settle limit is also 2 s of the clock's time; `StubNetwork::with_clock` holds delayed
responses back as the clock's alarms. Quiet detection and `waitFor` timeouts stay real time. `Headless::set_viewport` and
`set_environment` change the window and the environment while the app runs, as a rotation or a system setting does.

Headless runs play the platform's part NSH's protocol defines, and refuse what only a real platform does
(`headless/mod.rs` `Headless::react`, `go_back`, `answer`; `headless/animation.rs`):

- the native animation graph (nsh-core's `animation`, platform-free) runs frame by frame at 60 Hz while anything animates,
  fed the mount items' animation ops and scroll values, its finished animations reported (`animations_finished`); a
  step is quiet only when nothing animates;
- a back (`Headless::back`, and the app's `Command::Back`) does what `nsh-platform-macos`'s `default_back` does: in the
  newest modal, else the screen, the innermost stack that can go back pops its top screen (hidden in the model until
  the app removes it, `onDismiss`) or asks it (`preventBack`: `onBackRequest`); else the newest modal gets
  `onRequestClose`, and `onDismiss` when it is `dismissible`;
- dialogs (`Command::Dialog`) are answered with `onDialog` (`id`, `index`, -1 dismissed): by the test's handler, else
  `default_answer` (the cancel button, else dismissed when cancelable, else the step fails); `nsh/test`'s `App` answers
  them after each step itself (`answer_dialogs_myself`), so its JS handler runs on the test file's VM;
- picks (`Command::PickImages`) are answered with `onPick` (`EventPayload::Picked`): by the test's files
  (`Headless::on_pick`, `app.onPick`; given as they are, nothing scaled), else cancelled (no files); `nsh/test`'s `App`
  answers them after each step and its dialogs (`answer_picks_myself`), and `app.picks()` lists what was asked; a real
  platform shows its own picker, which the driver does not answer;
- the clipboard holds text (`SetClipboard`, `ReadClipboard` answered with `onClipboard`), modals get `onShow` when
  inserted;
- with `TestRun::page_host` (`nsh test`'s `--web-host`, else `nsh.json` `web.host`; `TestRequest::page_host` for an
  app's runner) the web page's host answers `nsh/host` (`page_host.rs`, feature `js`): each app `open` starts
  headless gets a host of its own, started before the engine (`createHost(player)` in a QuickJS context of its own on
  its own thread: timers on the app's clock, woken by its alarms (`Clock::at`), `console` to the `js` log, no imports), `Environment::host` set, and the
  driver hands the root's `Command::HostCall`s to it as their batches are applied (`Headless::on_host_call`); it
  answers each with a `Host` `{ type: "reply" }` event as `nsh.js` `hostCall` does (`ok: false` with the message on a throw, a rejection or
  a value that is not JSON), and `player.hostEvent` sends `Host` `{ type: "event" }`; what it sends before the engine runs waits in
  `page_host::Target` until `attach`, so the app's top-level `host.on` hears it, and the host goes with the app
  (its thread ends when the driver drops its calls). A module that does not load, exports no `createHost` or whose
  `createHost` returns no `call` fails the `open`. A call's timeout (`runtime/host.rs`) is the core's timer, on the
  engine's clock: virtual on a manual clock, real otherwise, as the host module's own timers are. `--target web`'s
  page runs `nsh.json`'s `web.host` (`web::with_page_host`); the other real hosts (`--target`) have none;
- the app runs under what its `nsh.json` declares (`Bundle::with_capabilities_json`: `nsh test`'s compiler and an
  app's runner, `Reply::Js::capabilities`, as `nsh build` writes `capabilities.json`), so headless refusals are a
  device's;
- URLs the app opens (`Command::OpenUrl`) are recorded (`Screen::opened_urls`), never opened, and answered with
  `onOpenUrl` `{ opened: true }`, as a device with an app for every scheme would (`app.openedUrls()`);
- the embedding app is the test's (`EngineConfig::host`, `Headless::host`): `open`'s `host.params` are the launch
  parameters, `host.handlers` the channel's handlers (`module.rs` `host_setup`: a value answers at once, a function's
  calls go over a channel to `RouteServer`, which `serve` answers on the test file's VM while a step runs, as a route's
  function; each call and post the handlers get is recorded for `app.host.calls()` / `posts()`), and
  `app.host.send` is `Headless::send_host_event`, a step;
- images are not loaded: an image's size (`ImageInfo`) is answered with an error, as a failed load (a `TextView` asks
  for the sizes of its images); an image or files on the clipboard fail the step that asked (`Screen::take_unsupported`).

Rust tests use the driver directly: `nsh_testing::start` (the engine with its frames, the batches to the caller),
`Screen` (texts in tree order, the commands sent, `press_target`, `matches`, `input_text`) and `Headless`.
`EngineConfig::new(app)` is the phone-sized config the tests start from. The features add the rest in layers, so a
Rust app's tests link neither the bundler nor QuickJS: `js` is `nsh test`'s side (below), `bundle` builds a TSX entry
against given sets in process (`compile_tsx`, `tsx`, `compiler`).

## `nsh test`

Tests are TypeScript (`*.test.tsx`, `*.test.ts`) importing `nsh/test`, a UI set written in Rust in `nsh-testing`
(`module.rs`: `test`, `open`, `expect` and the classes `App` and `Expectation`, `#[module]` / `#[class]`, so its JS face
and `.nsh/types/nsh/test.d.ts` are generated like any set's; the CLI declares it for every app, `init::write_types`).
Only the engine of a test file serves it: an app's bundle cannot import it (the bundler knows no such module there).

`nsh_testing::run_file` runs one test file (`run.rs`):

- It writes an entry for the file in `<app>/.nsh/test/` that imports it and then calls `run` of the internal set
  `nsh/test/runner`, and builds it through `TestRun::compile` (`Entry::TestFile`: the app's sets plus
  `nsh_testing::test_sets()`). The file's source map gets its sources relative to the current directory, so failures
  name `App.test.tsx:12:5`.
- The test file runs on an engine of its own (the VM). As it loads, `test`, `describe`, the hooks and the variants
  (`test.skip` / `only` / `todo`, `describe.skip` / `only`: modules named `test` and `describe`, whose functions are
  the functions' properties, `docs/dev/components.md`) declare a tree of `Suite`s in a thread-local of the VM's
  thread (`describe` calls its body at once, inside the declaration); `run`, a task, takes it (from then on a
  declaration throws) and walks it as Jest does: a block's `beforeAll` hooks once before its first test that runs,
  each test with the `beforeEach` hooks of its blocks outermost first and their `afterEach` hooks innermost first, then
  the block's `afterAll` hooks. Each body and hook is `Callback::call_async_traced` (what was thrown with its stack)
  bounded by its timeout (30 s unless given). A failing `beforeAll` fails its block's tests, an `afterAll` is reported
  as `<block> › afterAll`; `.only` anywhere in the file skips the tests outside the `.only`s. The apps are closed by
  marks (`Session::close_apps_since`): a test's after its `afterEach` hooks, a block's (opened in `beforeAll`) after
  its `afterAll`. Each result (`TestStatus`: passed, failed, skipped, todo; named after its blocks, `a › b`) goes over a
  channel to the caller, who symbolicates the stack with the test file's map.
- The VM's calls reach the run through the process's current `Session` (one test file at a time in a process, under a
  lock): the test file's directory, the app's sets, the compiler and the apps the running test opened.
- `open(entry, options)` builds the entry (`Entry::App`, once per run) and starts it on a `headless::Headless` of its
  own (`StubNetwork` from `options.network`, or `UreqNetwork` for `"live"`, behind a `RecordingNetwork` for
  `app.requests()`; `MemoryStorage` seeded with `options.storage`; the viewport, safe area, color scheme, locale,
  reduced motion and OS), on a blocking thread; `App`'s async methods are the driver's steps, run there too, and its
  synchronous ones (`texts`, `shows`, `value`) read the screen after `catch_up`. A route's JS function stays on the
  VM: its `StubHandler` sends the request and its `StubReply` over a channel (`RouteServer`), and `serve` answers them
  while the step that is waiting on the blocking thread runs (`open`, each step, `waitUntil`), so a request made in a
  step is answered within it; a function that throws fails the request and the step. With
  `TestRun::trace` every app observes its batches and prints them under their step (`print_batch`).

`crates/nsh-cli/src/test.rs` finds the test files (a directory's, outside hidden directories, `node_modules` and
`target`), prints a line per test (a failure with its message, its frames in the test file and the texts on screen),
writes a JUnit XML report with `--junit` (`Tally::junit`) and fails when any test failed. Given a directory of an
app with Rust crates, it first runs `cargo test --no-fail-fast` for each crate in that directory, in the crate's own
directory (`test::cargo_test`), and parses libtest's output (`cargo_test_results`: the test targets by their
`Running` / `Doc-tests` lines, each `test <name> ... ok | FAILED | ignored`, a failure's `---- <name> stdout ----`
block as its message) into `TestResult`s shown and counted with the test files' (without a time: libtest prints none);
a failed run with no failed test (the tests do not build) counts as a failure of the crate, with Cargo's output. With
`--target` the crates' tests do not run (they run on this machine), and a directory with crates and no test files is
tested by `cargo test` alone. Given an app's entry, it writes a test file in `.nsh/test` that opens the entry on the
network, waits 1.2 s (the engine's idle collection runs first, so retention bugs show up) and runs what standard input
holds; with `--trace` that is the headless trace of the app: every batch under its step and each commit's timings
(the engine's `trace`, `nsh::perf` lines).

An app this command line serves runs in its process (`TestRun::compile` builds with the CLI's sets). An app with Rust
crates of its own runs in its headless runner (`.nsh/rust/test`, `nsh_testing::runner`, `runner.rs`), which links the
app's crates and `nsh-testing` without its feature `bundle`: no bundler. `nsh` starts it with a `TestRequest` (JSON) as
its argument, the protocol version and `BYTECODE_VERSION` checked; the runner's `TestRun::compile` asks `nsh` to build
each entry (`RunnerMessage::Build` on its stderr, one JSON line), `nsh` writes the bytecode and source map into
`.nsh/test/build` and answers with a `Reply` on the runner's stdin, or `Reply::Root` for a Rust app's `nsh.json` (or its
directory): the runner then makes the app's root (`app_root()`), so `open(".")` starts a Rust app. Results, file
failures and log records come back as `RunnerMessage`s; batches of `--trace` go to the runner's stdout, which is
`nsh`'s. On a real platform (`--target`) such an app's tests run in `nsh`'s process like any other's, and its apps in
the development hosts built with its crates (`runtime::test_host`, `test_web`, `test_android`: a Rust app's too, whose
runners have no dev server client). A Rust app's hosts know its root (the platforms' `set_root`, Android's `root!`, the
web runtime's `rust_app!`); for its `nsh.json` the test session's server publishes no bundle but
`DevServer::publish_root` (`ServerMessage::Root`, after the test's setup), and the host runs the root.

`--trace` on a real platform is the host's: the test's setup says so (`DevServer::set_test_trace`,
`ServerMessage::TestSetup`'s `trace`), the host's engine runs with `EngineConfig::trace` (`Model::set_up_engine`), so
its commit and event timings come as its log lines, and the agent's `Model::apply` sends each batch's items, formatted
as headless runs print them (`trace.rs`), as a `ClientMessage::Trace`, before the outcome of the step it came in. The
test's side prints them under the step `Remote` took last (named as `Headless` names its steps).

### On a real platform (`--target`)

`nsh test --target <platform>` runs the apps tests open on the platform's development host (`macos`, `linux`,
`windows`, `gpui`, `web`, `ios`, `android`); `--fps` (macOS, Linux, Windows and iOS) has the host log its performance
monitor's readings once a second, shown with `-v` (`docs/dev/linux.md` "Performance", `docs/dev/windows.md`
"Performance"). `App` drives either kind
of app through one trait (`driver.rs` `Driver`): `Headless`, or `Remote`, which turns each step and query into a
`nsh_dev::protocol::TestStep` for the host (`TestRun::host`, a `StartHost` the CLI makes: `nsh-cli/src/test_host.rs`).
For each `open`, the CLI builds the entry, starts a dev server of its own in a test session
(`DevServer::test_session`: its hello says `test`), publishes the build and starts the host with `--dev-server`,
`--window-size` and a fresh `--data-dir`, removed after it. A host whose hello says `tests` takes steps:
`DevServer::step` sends a `ServerMessage::Step` with an id to the test host that connected last and blocks for the
`ClientMessage::StepDone` with that id; a host that leaves fails its waiting steps.

The host's side is `nsh_testing::agent` (feature `agent`: no QuickJS, no network; the dev hosts link it). Its
`Model` keeps the headless driver's `Screen`, fed every batch the surface applied and every error the app reported,
so selectors resolve the same everywhere; the `Agent` takes each step on a thread of its own: it resolves the
selector on the model, scrolls the view into view when it is not (the innermost scroll view around it that hides it,
a gesture at a time; between gestures it waits only for the view to stop moving, `Agent::stopped`, and once it is in
view for the app to settle, so a page that is never quiet, a ticking timer, costs one settling per step rather than
one per gesture), asks the platform where it is (`Native::bounds`; a span of a text (`Scene::span`) is pressed on its
characters' first line, `Native::text_bounds`, the rectangles each platform highlights a selection with, and the
platform's own hit testing gives the press to the span; a press of a view inside the one that takes it, a cell's
text in a row, lands on the match's middle, `Scene::match_inside`, as headless) and acts there with synthesized input
(`Native`: press, long press (on a manual clock, once the finger has landed, the agent moves the clock by the rest
of the hold, as the headless driver's hold does: a hold the app times itself, a touch screen's `ContextMenu`, comes
due), scroll, drag along `agent::drag_path` after resting `agent::LANDING`, typed keys,
the mouse's secondary button (`right_click`), the open context menu's items chosen or the menu closed
(`choose_menu_item`, `close_menu`: macOS's tracking `NSMenu`, run from the run loop rather than the main queue so the
agent's calls and the app's batches go on while it tracks; Windows' `TrackPopupMenuEx` ended with `EndMenu` and the
chosen item carried out after; GTK's popover with the item's action's work done and the popover popped down; GPUI's
menus of its own; the web, whose `Menu.popup` is the app's own UI, has none), the mouse's hover (`hover`, when
`Native::mouse`: macOS hands the move to the surface's input, as AppKit gives posted
moves to the first responder only), keystrokes (`press_keys`: macOS's posted key events, Windows' and GPUI's key entry points with
`keymap::Key::virtual_key`, the web's CDP key events, Linux's bindings fired as its shortcut controller would, as GTK
takes no made-up keys; iOS's IOHID keyboard events (`synth::key`, modifiers down first) that UIKit takes as a
real keyboard's, Android's `KeyEvent`s handed to the window's root view as its input stage hands them over),
`back`, dialogs, screenshots, the window's size and appearance),
then waits until neither a batch came nor a native animation ran for 100 ms (2 s at most; the web's page counts its own
finite animations too: a screen sliding in; Android counts a scroll view drawing, as its overscroll stretch relaxes
without moving a view, and a touch then only catches the stretch). `Native`'s calls do their work
on the platform's main thread and return when the input is posted. Screenshots come back as PNG bytes (base64): the
test's side saves them, as the host may run on another machine. `open`'s manual clock reaches the host in the
test's setup (`TestEnvironment::clock`, its start in Unix milliseconds): `Model::set_up_engine` starts the engine on
`Clock::manual(start).with_frames()`, and the host hands the started engine back (`Model::engine_started`). The
test's `clock` steps are `TestStep::Clock` (`ClockChange::RunFor`, `FastForward`, `SetSystemTime`; the web's
`SceneQuery::Clock`, after which the page pumps its engine), which `Model::move_clock` takes as the headless driver
does, through `EngineControl::advance_clock`; `wait` moves the clock by its time too (`driver.rs`'s `Remote`). A
clock that moves with frames (`Clock::moves_with_frames`) is the display's pace on a real platform: each frame the
platform shows moves it to a frame after the last (`nsh_core::time::FRAME`, 1/60 s) before it runs, and while the
engine moves it (`Driver::advance` with `frames`) the frames the app waits for run on the way, a frame apart, as a
headless display's do; the platform's own animations run in real time, as do stubbed responses' delays (the test's
side holds them, outside the app's clock). `open`'s locale, reduced motion and safe area reach the
host in the test's setup (`TestEnvironment`, `DevServer::set_test_environment`) and its engine pins them
(`EngineConfig::pinned`, `EnvironmentPins`: applied to every environment the platform reports); its clipboard is the
test's (`EngineConfig::clipboard`: the core serves the app's clipboard commands from a `ClipboardBackend`, here a
`MemoryClipboard` the agent's model keeps, which `app.clipboard()` reads), so the machine's is never touched. The
test plays the embedding app there too, through the view's own channel (`Model::set_up_engine` on `config.host`):
`open`'s `host.params` arrive in the setup (`TestEnvironment::host_params`), `app.host.send` is
`TestStep::HostSend` (the model's `send_host_event`, then the agent settles; the web's page answers
`SceneQuery::HostSend`), and the channel's URL handler records each URL the app opens and takes it, so nothing
opens (`TestStep::OpenedUrls`, `SceneQuery::OpenedUrls`). `host.handlers` runs headless only (`open` rejects them):
the calls would need the test's functions over the dev server.

Routes and storage reach the host through the dev server (`HostOptions`, `DevServer::set_test_storage` and
`set_test_network`). Before the first bundle, the server sends the test host a `ServerMessage::TestSetup` with the
seeded storage; the host's `Tester` hands it to `Model::set_up`, and `Model::set_up_engine` starts the engine on a
`MemoryStorage` holding those entries and on `agent/forward.rs`'s `ForwardNetwork`. Each
request the app makes goes back as a `ClientMessage::Fetch` with an id (`FetchCancel` when the app drops it); the
test's side answers it from its routes (`protocol::TestNetwork`, `run.rs`'s `HostRoutes` over the same
`StubNetwork` headless runs use, recording every request for `app.requests()`) with `ServerMessage::Fetch` replies:
`Head`, `Data` (base64) and `End`, or `Failed`, or `Pass` for `network: "live"`, when the host's own network makes
the request. `app.storage()` asks the host (`SceneQuery::Storage`). The web's page takes both through `dev.html`
(`player.testSetup`, `testFetchReply`, and `onTestSend` for its requests).

macOS (`nsh-platform-macos`, feature `dev`): `agent.rs` implements `Native` with `synth.rs`'s posted mouse, trackpad
and key events, `NSView` frames converted to the content's top-left points, `NSAlert`
buttons pressed by title (`system::answer_dialog`), and the content view cached into a PNG; `dev.rs`'s `Tester`
attaches the model to the surface on the server's test session (before the first bundle) and starts the agent's
thread. GPUI (`nsh-platform-gpui`, feature `dev`): `agent.rs` on GPUI's main thread, input through the handlers real
input goes through (`synth.rs`), back the mouse's back button, dialogs pressed at their buttons' laid-out middles
(`docs/dev/gpui.md`). Linux (`nsh-platform-linux`, feature `dev`): input through `input::simulate` and the focused
GTK field's own signals (GTK 4 takes no made-up events), dialogs' `GtkButton`s clicked, screenshots rendered
offscreen (`docs/dev/linux.md`). Windows (`nsh-platform-windows`, feature `dev`): input at the input module's entry
points as on GPUI, screenshots captured with `PrintWindow` (`docs/dev/windows.md`). iOS (`nsh-platform-ios`,
feature `dev`; `nsh-cli/src/test_ios.rs`): the CLI installs the host in a simulator (a booted one, else the newest
iPhone) and launches it per `open` with `--dev-server` and a fresh `--data-dir` (the simulator shares the Mac's network
and files). Touches are IOHID digitizer events handed to UIKit (`-[UIApplication _enqueueHIDEvent:]`, with IOKit's
and BackBoardServices' functions looked up at run time, `synth.rs`), so UIKit makes the `UITouch`es and runs hit
testing, gesture recognizers and scroll views as for a finger: a press is a finger down and up, a scroll a drag kept
inside the scroll view that rests (still reporting where it is) before it lifts, so it ends without a fling; a tap
that lands in a text input also gives it the focus (made touches leave the first responder where it was, as UI test
tools know). Typing goes through the software keyboard's input manager (`UIKeyboardImpl.addInputString:`, a key at
a quick typist's pace), which asks the input's delegate first (`maxLength`, a controlled value), as the keyboard does.
Back swipes a presented sheet down; else, while the app listens to going back (an overlay's `onCancel`: a menu's
sheet, whose backdrop covers the header, a popover), it is VoiceOver's escape gesture (`accessibilityPerformEscape`
on the surface's root view, which hands the core the back press, as the headless driver's back does); else it taps
the header's back button (the bar button carrying the back chevron's mask); dialogs are answered with a tap on the
`UIAlertController`'s button; screenshots are `drawViewHierarchyInRect:` as a PNG; a step waits for finite Core Animation animations and gliding scroll views too.
The system's appearance is the simulator's: the CLI switches it (`simctl ui appearance`) and restores it after the
app; the screen keeps its device's size. Android (`nsh-platform-android`, feature `dev`; `TestAgent.java`;
`nsh-cli/src/test_android.rs`): the CLI installs the host on the first device `adb devices` lists and starts it per
`open` with the dev server's port forwarded (`adb reverse`) and a data directory of its own in the host's cache
(`dataDir`, emptied as it starts). The agent's calls go to `TestAgent` (a class looked up in `JNI_OnLoad`), which does
each on the UI thread: `MotionEvent`s dispatched to the window's views (or the dialog's) as a finger's, with drags
that rest before they lift as on iOS; typing as a keyboard's `KeyEvent`s (`KeyCharacterMap`; what no key types is
committed through the field's input connection), Ctrl+A first as a shortcut, as the window's input stage offers it;
back is the activity's back press; dialogs are answered with a tap on the `AlertDialog`'s button (back to close it);
screenshots draw the window and the dialog into a bitmap. A step waits for the native animation graph and for anything
that moves: a signature of every shown view's place, offset, scroll position and opacity, compared between looks. The
system's appearance is the device's night mode, which the CLI switches (`cmd uimode night`) and restores. All of them
use `nsh_testing::agent::Tester`, which turns the dev client's
test events into an agent's steps on a `Worker` thread.
These hosts are also how a change to a platform is checked by hand: `nsh test <entry> --target <platform>` with steps
on standard input (`app.screenshot("a.png")`, `app.press(…)`) opens the app in the platform's window, takes them and
closes it.

The web (`--target web`, `nsh-cli/src/test_web.rs`): the agent runs in the CLI, the app in a page of a headless
Chromium browser (Chrome, Edge or Chromium; `--browser <PATH>`, else the one installed where `cdp.rs` looks; nsh never
fetches one and fails saying so when there is none). One browser serves the run; each `open` gets a page in a browser
context of its own (storage apart) on a dev server of its own that also serves the web host's page
(`DevServer::serve_web`). The development runtime (`nsh-dev.wasm`, feature `dev` of `nsh-platform-web`) keeps the
`Model` once the server's hello says `test`, and answers the steps' questions about it (`TestStep::Scene` with a
`SceneQuery`: `nsh_testing::agent::answer`; where views are, the viewport, inputs' text and dialogs' buttons from the
DOM, in `nsh.js`'s `testPage`). The CLI's agent sees the app through `RemoteScene`, which asks those questions
through `DevServer::step`, and acts with the browser's trusted input over the DevTools protocol (`Input.dispatch*`:
mouse presses, wheel events of 20 px a frame apart, key events with macOS's editing commands, as Playwright sends
them), `history.back()` for back, `Emulation.*` for the viewport and the color scheme and `Page.captureScreenshot`.
Headless Chromium finds no input device and reports `pointer: none` / `hover: none`, which `nsh.js`'s `measureIdiom`
reads as a touch screen; `cdp.rs` launches it with `--blink-settings` giving it a fine, hovering pointer (as
Playwright does), so the page measures as a browser with a mouse: the desktop idiom at least 600 wide, a phone below
(`open`'s `width`).

## New apps (`nsh init --template`)

`nsh init <dir> --template ts|rust|mixed` (`init.rs`) writes one of three apps; without `--template` it asks with a
menu (`ui::choose`) when stdin and stdout are a terminal (`ui::interactive`; Enter picks `ts`) and takes `ts`
otherwise, so scripts and CI never wait for an answer.

- **`ts`**: `App.tsx`, `nsh.json`, `tsconfig.json` (`nsh_bundler::TSCONFIG`), `.gitignore` and `.nsh/types`. Files
  that exist are kept; only a directory that has them all is refused.
- **`rust`**: an independent Cargo workspace: `Cargo.toml`, `src/main.rs` (a native desktop entry using
  `AppSource::Rust(Root::of::<App>())`; the platform dependencies are target-specific and disable default features,
  so `cargo run` mounts the Rust root directly), `src/lib.rs` (the root
  component and its `#[native_module("<slug>/native")]` registry, which exports `App` for a TSX entry added later),
  `nsh.json` with `"rust": "."` and `"root": "App"`, `.gitignore` and a README (`templates/rust/`) saying how to add
  that entry. No TSX, so no `tsconfig.json` and no `.nsh/types`. `examples/gallery-rs` is a Rust app with a native
  entry (`cargo run`) and headless tests of its Rust root.
- **`mixed`**: the `ts` files with an `App.tsx` that imports from `<slug>/native`, `nsh.json` with `"rust": "."`
  (no `"root"`: `App.tsx` stays the entry), a README and the crate at the app's root, as `rust`'s (`Cargo.toml`,
  `src/lib.rs`: a component, a module function and a class; no `src/main.rs`; `templates/mixed/`), a small form of
  `examples/rust-exports`. The bundler follows `App.tsx`'s imports, `nsh test` skips `target/` and the Rust watcher
  takes the `.rs` files and `Cargo.toml` beside the TSX, so the two share the directory.

The slug is the display name in lower case, words joined by `-` (`My App`: `my-app`); the crate's package is
`nsh-app-<slug>` (`rust` and `mixed`), and `src/main.rs` uses its crate identifier. A `rust` or `mixed` app's files are checked before any is written: one existing is a conflict.
`--nsh-source <dir>` (with `rust` or `mixed`; with `ts` it is an error) writes path dependencies on that checkout's
crates instead of crates.io's at the CLI's version; the generated host workspaces take nsh's crates from the same
place, so the app and its hosts share the same core and registry types.
The app's Rust watcher excludes `target`, `.nsh` and `.git`, including generated sources under the
app root, and the build directory itself (`CARGO_TARGET_DIR` inside a crate's directory under another name). Custom TypeScript declarations are generated once the app's crates are first described.

## Apps with Rust components of their own (`nsh.json` `"rust"`)

`"rust": "<crate dir>"` names a library crate of the app with a `#[native_module("<specifier>")]` function at its
root, which registers the crate's Rust components, modules and assets into its UI set, imported by the app's TSX by
that specifier (`examples/rust-exports`: `import { Account, Gauge, Ledger } from "rust-exports/native"`). `"rust": ["native/charts",
"native/storage"]` lists several, each a UI set of its own with its own `#[native_module]` and specifier
(`import { Chart } from "app/charts"`, `import { Store } from "app/storage"`; `docs/dev/rust-modules.md`):

```rust
use nsh_core::ui::prelude::*;

#[native_module("rust-exports/native")]
fn native(registry: &mut Registry) {
    registry
        .register::<Gauge>()
        .module::<Ledger>()
        .class::<Account>();
}
```

The attribute (`nsh-macros` `native_module.rs`) checks the specifier at compile time (a bare import specifier, not
`nsh` or `nsh/...`) and makes a hidden entry of a fixed name, `__nsh_native_module() -> Registry`
(`Registry::ui_set(specifier)`, then the function), which the generated code below calls, and a public, documented
`pub fn registry() -> Registry` making the same set, for the crate's tests and other Rust code
(`rust_exports_native::registry()` next to `nsh_base::registry()`; the hidden entry calls it). A second one in the crate
fails as that name defined twice; one outside the crate's root fails at the attribute (a glob of `crate::*` in a
block finds the entry or a stand-in whose bound reports where it goes: `#[diagnostic::on_unimplemented]`). The
generated code links each listed crate under a name of its own (`app_<package>`, `-` as `_`: `app_gallery_native`)
and makes its set in a function of its own (`set_app_gallery_native()`), whose body glob-imports that crate, which
shadows the file's one import of NSH's stand-in (`nsh_core::ui::__private`): a crate without an entry fails the
generated workspace's build with what to add, on the line of that crate (it names the package). The prebuilt `nsh`
does not link the sets, and does not need to: the toolchain reads a UI set as data. It writes a workspace with a
program that describes them, builds the hosts and runners with them, and does everything else itself
(`crates/nsh-cli/src/rust_app.rs`):

- `rust_app::crates` reads `"rust"` (a string or a non-empty list of strings) and checks the list when the
  workspace is written: a crate listed twice (by any path), two packages of one name (Cargo takes `-` and `_` as
  one) or two crates whose `#[native_module("…")]` has the same specifier (read from the crate's `[lib] path` or
  `src/lib.rs`) fail with the two paths and what to change. `Registry::merged` refuses two sets registering
  components or modules of the same name when an engine starts. Crates may depend on each other, or on crates not
  listed (a shared crate of components), through plain Cargo path dependencies; only listed ones export to TS.
- A Cargo workspace in `<app>/.nsh/rust`, written on every command (files only when they change; the `cli` crate and
  `app.json` earlier versions wrote are removed), each member depending on every listed crate:
  - `describe` (nsh-core and the app's crates, nothing else): calls each crate's entry and prints one JSON document,
    `nsh_core::ui::description::Description` (format `FORMAT`, the nsh-core version that wrote it, then per crate in
    `"rust"`'s order its specifier, exports with their kinds, TypeScript declarations, re-exported runtime values and
    types, the values nsh-js makes for it, the files it ships and the exports TS sees without a doc comment, which
    `nsh` warns of as it writes `.nsh/types`);
  - `test` (`nsh-testing` without `bundle`, `nsh/base` and the app's sets, and a Rust app's root): the headless
    runner of `nsh test` (`nsh_testing::runner`);
  - the hosts and runners, passing the sets after `nsh/base`'s (`vec![nsh_base::registry(), set_app_charts(),
    set_app_storage()]`): `ios-host` / `ios-app` (the development host and the release runner:
    `nsh_platform_ios::set_ui_sets`, then `nsh_ios_host::main` / `nsh_ios_app::main`), `linux-host` / `linux-app`,
    `macos-host` / `macos-app` and `windows-host` / `windows-app` (the same on Linux, macOS and Windows,
    `nsh_platform_linux` / `nsh_platform_macos` / `nsh_platform_windows::set_ui_sets`; `windows-app` is a windowed
    program, with no console), `tui-host` / `tui-app` (`nsh_platform_tui::set_ui_sets`, then `nsh_tui_host::main` /
    `nsh_tui_app::main`; console applications on all three desktops), `android` (the app's `libnsh.so`:
    `nsh::ui_sets!`, which the Android runtime looks up
    when an engine starts) and `web` (the app's web runtime, a `cdylib` for `wasm32-unknown-unknown` built with the
    `web` profile: `nsh_platform_web::ui_sets!`, whose `nsh_app_init` export `nsh.js` calls; `docs/dev/web.md`, "Apps
    with Rust components"). `gpui-host` (`nsh_platform_gpui::set_ui_sets`, under `cfg(any(target_os = "linux",
    target_os = "macos", windows))`) is a workspace of its own in `.nsh/rust/gpui` (excluded from the main one), written
    only when the GPUI host is built (`RustApp::gpui_workspace`), so builds for the other targets never resolve GPUI's crates.

  They take nsh's crates where the app's crates do (`rust_app::Nsh::of`, from each crate's dependencies through `cargo
  metadata`): from crates.io at the version of the running `nsh` (`=0.1.1` for nsh 0.1.1: the code it
  generates calls their API, and the description and the trace protocol must be the ones it reads), which the app's
  requirements must accept, or by path from the checkout the app's crates depend on (nsh's own examples, as
  `examples/gallery-rs`, through the workspace's path dependencies), which must be of that version, with the app's
  crates.io dependencies on nsh patched to it. Git dependencies use the checkout Cargo resolves from the app’s
  lockfile, including registry dependencies redirected by its patches. The generated workspaces patch both crates.io
  and the Git repository to that checkout, so the app and its hosts share the same core and native module types.
  Requirements of another version, or crates taking nsh from two places, stop the command with what to change, rather
  than a build failing later on two `nsh-core`s. They build in the app's own `target/`, as a Cargo project in the app's
  directory does (`nsh init` ignores it), or in `CARGO_TARGET_DIR` when it is set (one directory several checkouts or
  CI jobs share), and Cargo resolves and keeps the workspace's own `Cargo.lock`. Every crate those workspaces depend on
  is published by `release-crate.yml`, the hosts and runners included; the binaries are named after the app
  (`nsh-app-<package>-describe`; with several crates all their packages, `nsh-app-charts-storage-test`), and so are
  the libraries (the web runtime's, the Android `cdylib`s: `libnsh_app_charts_android.so`, installed as `libnsh.so`),
  so apps sharing a target directory never take each other's. Generated workspaces optimize `quickjs-jit-sys`,
  `taffy`, `objc2` and `objc2-encode` at level 3 in debug builds, matching NSH's own workspace, so hot reload hosts
  keep interpreter, layout and Objective-C bridge performance while application Rust code retains debug settings.
  Objective-C signature checks stay enabled: their encoding parser needs optimization too, since every native
  message checks its signature in debug builds.
- Before a command on the app (`build`, `test`, `dev`, `run`, `package`, `publish`, `check`) `nsh` builds `describe`
  ("building the Rust crate …": Cargo decides whether the app's Rust code changed) and runs it when the program is
  new, keeping its output in `.nsh/rust/description.json` with the program's size and time (`RustApp::describe`). The
  description must be in this `nsh`'s format and of its version, with one set per crate and a specifier each that is
  neither one of nsh's modules (`nsh`, `nsh/...`, the runtime's registries, `nsh/base`) nor another crate's; a
  program that panics (a component registered twice) fails the command with its output. From then on the command
  runs in the prebuilt `nsh` with `nsh/base` and those sets (`main.rs` `set_app_sets`): the bundler keeps their
  imports and hints at their components, bytecode links against their exports' names (`ModuleTable::compiling`,
  `native-pipeline.md`), `.nsh/types` declares each set (`.nsh/types/<specifier>.d.ts` from its declarations, found
  through tsconfig's `"*"` path, which falls back to `node_modules`), the dev server serves their files and tells hosts
  which sets a bundle needs. The hosts `run` and `package` need are built for the app instead of taken from the runtime
  (iOS `--target` triples; Linux's, macOS's, Windows' and the terminal's `*-host` / `*-app` and GPUI's `gpui-host` for this machine; Android: the
  prebuilt `classes.dex` with the app's `libnsh.so` for each ABI of the prebuilt runtime, cross-compiled with the NDK;
  the web: the app's `nsh.wasm` / `nsh-dev.wasm`, with nsh's `nsh.js`).
- `nsh test` builds the app's headless runner (`RustApp::test_runner`) and runs the test files in it, building the
  entries it asks for (`nsh test`, above); the runner's log lines come back as `RunnerMessage`s, which `nsh` shows as
  its own (`logger::forward`); other lines (a panic's) pass through.
- `nsh dev` / `nsh run` watch the crates too, and the local crates they depend on by path (`path = "…"` in
  `[dependencies]` / `[build-dependencies]`, per target too, transitively; not NSH's own crates nor
  dev-dependencies: `RustApp::watched`): a change to their `.rs` files, `Cargo.toml` or `assets/` ends the session
  with `rust_app::Restart` (the hosts it started are stopped with it), and the command starts again in the same
  process (`main.rs` `run`): the app is described again, the hosts are built again and start anew; JS and TSX edits
  stay hot. After a restart a failing build reports the error and waits for the next change (`RustApp::wait_after`).
- **Rust apps.** With `"root": "<path in the crate>"` in `nsh.json` (in the first crate `"rust"` lists), the app's
  directory resolves to its `nsh.json` (`entry::resolve`; a named `App.tsx` stays the TSX entry), and the app runs with
  no JS: `rust_app::RootConfig` (with `"theme"`, `"appearance"`, `"statusBar"` and `"id"`) adds the members `rust-linux`,
  `rust-macos`, `rust-windows`, `rust-ios`, `rust-tui` (each the platform's release runner library without its feature `js`, whose
  `run_rust` mounts the generated `app_root()`), `rust-android` (`nsh::ui_sets!` and `nsh::main!`,
  `nsh-platform-android` without `js`; the APK's manifest gets the `com.longbridge.nsh.RUST` meta-data `AppActivity`
  reads) and `rust-web` (`docs/dev/web.md`), and the root to `test` (`app_root()`: `open(".")` of a test
  starts it). None of them, nor `describe`, links nsh-js, QuickJS, rolldown or the bundler: a Rust app compiles none of
  them to build, run or package it; `nsh test` runs the crates' `cargo test` and TypeScript tests, so its runner links QuickJS (not the bundler). `RustApp::runtime`, `android` and `web` build those
  instead; `nsh package` ships no bundle (`build::rust_root`: the crates' assets only); `nsh run` runs the desktops'
  runner in debug in place (`NSH_APP_DIR`: its `nsh` directory, and the app's logs on stderr), Catalyst's in an app
  bundle (`NSH_DEVELOPMENT`), and installs a package on the simulator and Android; on the web a dev session without
  builds serves the page. A crate change ends the command with `Restart` (`RustApp::watch`). `nsh build` writes what
  it ships besides its runners (`app.json` and the crates' assets); `.nsh/types` is written for it only when it has a
  `tsconfig.json` (for its test files). `nsh check` runs `cargo check` on its crates, and `tsc` with that
  `tsconfig.json`. The other commands refuse a Rust app's entry, before building anything.
  `examples/gallery-rs` is one (`"root": "Gallery"`).
  The terminal's `rust-tui` wrapper calls `nsh_tui_app::run_rust(app_root())`, uses `NSH_APP_DIR` for resources during
  development and keeps the same console entry point on Windows.
- The files the sets' crates ship (`Registry::assets(assets!())`: a crate's `assets/` directory, published as
  `asset:/@<package>/<path>`, so each crate's are apart) go with the app's imported assets: the dev server serves them
  (`DevServer::serve_files`), `nsh build` / `package` / `publish` copy them (`build::Built::assets`: each file's path
  and where it is, from the description), `nsh test` reads them; the engine registers their fonts before the first
  render.

### What an app's Rust crates cost

Builds from an empty target directory (`CARGO_TARGET_DIR`) on an M-series MacBook Pro (10 cores), debug, the app's
crates by path from this checkout; "crates" counts cargo's `Compiling` lines. Before: the app's own command line
(`cli`, `nsh_cli::main_with`), which every command built first; after: the `describe` program.

| App, command | Before | After |
|---|---|---|
| `nsh init --template rust`, first `nsh build` | 46.9 s, 386 crates | 13.1 s, 59 crates |
| `--template mixed` (TSX and a crate), first `nsh build` | 44.7 s, 369 crates | 9.4 s, 25 crates |
| `examples/gallery-rs` (Rust root), first `nsh build` | 48.5 s, 386 crates | 15.6 s, 59 crates |
| `examples/rust-exports` (TSX and a crate), first `nsh build` | 41.6 s, 369 crates | 7.2 s, 25 crates |
| `examples/rust-exports`, then the first `nsh trace` (now `nsh test`) | 3.3 s, 0 crates | 15.6 s, 118 crates (the runner, with QuickJS) |
| `--template rust`, then the first `nsh trace` (then without QuickJS) | 3.2 s, 0 crates | 13.0 s, 31 crates (`rust-trace`) |
| One-line edit of the rust template, `nsh build` | 3.3 s, 2 crates | 1.0 s, 2 crates |

A Rust app's runners were and are what they were: `nsh package --target macos` after the build compiled 60 crates
for the release runner in both. The test runner links QuickJS, so the first `nsh test` of such an app builds what its
`nsh build` no longer does.

## Finding the runtimes

The CLI finds prebuilt runtimes next to itself (`bin/../runtime`, the distribution layout) or, in a checkout, in
`target/<triple>/<profile>` (Linux's, macOS's, Windows' and GPUI's, built for this machine, in `target/<profile>`,
Windows' `nsh-windows-host.exe` / `nsh-windows-app.exe`; the distribution has GPUI's in `runtime/gpui/` on each OS) and `target/android/<profile>[-dev]` with the CLI's own profile (`NSH_RUNTIME` overrides). In a checkout (`<root>/target/<profile>/nsh` next to
`crates/nsh-ios-host`), the CLI builds what it needs with cargo first (`cargo build -p nsh-ios-host --target ...`,
`cargo xtask android --dev`), so `nsh run` never uses a missing or stale host; on a Mac without Xcode's Metal
Toolchain it builds GPUI's hosts with `nsh-platform-gpui/runtime-shaders` (`gpui.md`). The web runtimes (`runtime/web/nsh.wasm`
for published apps, `nsh-dev.wasm` for the development host, and `nsh.js`: `docs/dev/web.md`) are always built with
the `web` profile, into `target/wasm32-unknown-unknown/web/`. Every CLI wasm build, including an app's generated Rust runtime outside the checkout, selects `getrandom_backend="custom"` for the browser entropy bridge. `runtime::web_build_flags` appends it to explicit Rust flags or merges a Cargo target-config array, preserving the existing stack and user flags; generated web packages also retain their 8 MiB stack link argument.

Terminal hosts and runners are built in `target/<profile>` (`cargo build -p nsh-tui-host` / `-p nsh-tui-app`) and
shipped in `runtime/tui/{nsh-tui-host,nsh-tui-app}` (`.exe` on Windows). App-specific variants use the generated
`.nsh/rust/tui-host`, `tui-app` or `rust-tui` member and the app's own target directory.

## Releases

`.github/workflows/release.yml` runs `cargo xtask dist` on macOS (Apple silicon: the iOS, Mac Catalyst and macOS
runtimes and the iOS SDK), Linux and Windows (x86_64), each with the GPUI development host and terminal runtimes of its OS and the Android runtime, checks that the packaged CLI
makes and bundles a new app, and archives `dist/nsh` as one directory `nsh/` in `nsh-<platform>.tar.gz` (`.zip` on
Windows), plus the embedding SDKs alone (`nsh-embed-ios.zip`, `nsh-embed-android.zip`), each with a `.sha256`. Asset
names carry no version, so `releases/latest/download/<asset>` always resolves; the installers and package managers
rely on that. To release, set `version` in the root `Cargo.toml`, push the tag `v<version>` (a tag that does not
match fails the run) and publish the draft release the run creates once every platform has built. Running the
workflow by hand without a tag builds the archives only (the run's artifacts): a dry run before tagging, and how to
check a change to the workflow or to how xtask builds the distribution (`dist.rs`, `android.rs`, `ios.rs`). Pull
requests and the merge queue never run it: its three builds are CI's longest and held the runners the queue waited for. The binaries are not signed: macOS quarantines downloads from a browser (`xattr -dr
com.apple.quarantine nsh`), and the Linux runtime needs glibc 2.39 and GTK 4.14 or newer (Ubuntu 24.04 and later).

The same tag runs `.github/workflows/release-crate.yml`, which publishes the library crates to crates.io (secret
`CARGO_REGISTRY_TOKEN`): the main workspace's crates that do not inherit `publish = false` (they set `homepage`,
`readme` and `repository` instead), then `nsh-platform-gpui` from `crates/gpui`. The hosts, the runners,
`nsh-platform-web` and xtask are never published. A new version also sets the `version` of the `nsh-*` entries of
both workspaces' `[workspace.dependencies]` (the run fails otherwise). Crates already on crates.io at that version are
skipped, so a run stopped by crates.io's rate limit on new crates can simply be run again; running it by hand with
*dry run* packages and verifies without uploading.

The CLI build script stamps `-V` / `--version` with seven characters of Git HEAD
(or Cargo's packaged VCS metadata); crate dependency versions stay unchanged.

How users get it (`website/docs/installation.md`):

- `website/public/install.sh` and `install.ps1` (served at `nsh.dev/install.sh`, `/install.ps1`, and
  attached to each release) download the latest archive or `NSH_VERSION`, check its `.sha256` and replace
  `~/.nsh` (`%LOCALAPPDATA%\nsh` on Windows) with it; `~/.local/bin/nsh` links to it, Windows adds `bin` to the
  user's `PATH`. The CLI resolves its own symlink (`runtime::cli_exe`) to find `bin/../runtime`: macOS reports
  `current_exe` as it was run.
- `install.sh --source` clones the latest `main` into `~/.nsh/source`, builds the release CLI with
  Cargo's existing configuration and links to that executable. Re-running fetches `main`; dirty checkouts
  are preserved and rejected. The checkout stays available for on-demand native runtime builds.
- Homebrew: publishing a stable release runs `.github/workflows/packages.yml`, which fills in
  `.github/packages/nsh.rb` with the archives' checksums and pushes it to `longbridge/homebrew-tap` as
  `Formula/nsh.rb`. It validates the tag and checksum sidecars, downloads and verifies both archives, then installs
  and tests the formula on Apple silicon before updating the tap. The formula supports Apple-silicon macOS and
  x86_64 Linux, keeps the whole distribution in `libexec`, and tests web packaging through the installed symlink.
  Pull requests and pushes to `main` that change the package files run these checks without writing to the tap.
- Scoop: the release job fills in `.github/packages/nsh.json` and attaches it as `nsh.json`; Scoop installs from
  `releases/latest/download/nsh.json` and updates from the same URL, so nothing is committed anywhere.
- mise: its `github:` backend picks the archive by OS and architecture, strips `nsh/` and finds `bin/`.

### Homebrew publishing setup and recovery

A maintainer must configure the existing `HOMEBREW_TAP_TOKEN` Actions secret in `longbridge/nsh` (or an organization
secret made available to this repository). It needs **Contents: read and write** on `longbridge/homebrew-tap` only,
and permission to push the tap's default branch under its branch rules. The NSH workflow's own `GITHUB_TOKEN` stays
read-only: it cannot write another repository. Do not grant broader repository access or bypass branch protection.
The job reports a specific error when the tap secret is missing; invalid or expired credentials still fail at checkout
or push. Setting credentials is a maintainer step, separate from merging the workflow change.

After configuring the secret, run **Packages** from the Actions page on `main`, with the published stable tag to sync
(or leave it empty for the latest release). This only updates the tap; it does not build or publish a release. Drafts
and prereleases are refused. Repeating a successful run makes no commit when the formula is unchanged, and an older
version cannot replace a newer formula. Writers queue serially; if another tap contributor advances the branch during
the update, a rejected push can be retried with a fresh run. Use a new dispatch on `main` to apply workflow fixes to an
old release: rerunning an old failed run keeps that run's original workflow revision.

For local generator regression checks, run `python3 -m unittest discover -s .github/packages -v`. The `Packages` PR
check additionally runs Homebrew style, strict audit, installation and the formula's CLI/web-runtime smoke test.

## Entries and `cargo run`

Commands that build an app take its entry module or its directory (the current one by default), whose `App.tsx` is
the entry (matched in any case: `crates/nsh-cli/src/entry.rs`). `cargo run` is `xtask run` (the workspace's default
member): the gallery on the machine's own backend (the AppKit host on macOS, the GTK host on Linux, the Win32 host on Windows; `--target` picks another) through `nsh run`, in a process group of its own that is stopped and
started again when a source under `crates/` changes (`crates/xtask/src/run.rs`; it watches the canonical
`crates/`: inotify reports paths under the one watched as given, and the `..` of `CARGO_MANIFEST_DIR/../..` would make
every path look like a dot entry, which is skipped). On Windows the group is a `CREATE_NEW_PROCESS_GROUP` one, stopped
with Ctrl-Break (`nsh` takes it as Ctrl-C and stops its host) and then by closing the kill-on-close job `nsh run` was
put in. The first two lines (`Finished`,
`Running`) are the outer `cargo run`'s own, which only a global `term.quiet` would hide (it would hide `cargo build`'s
too); `cargo xtask [run] [<app>]` is the same task through the alias in `.cargo/config.toml` (`run -q`), without them. xtask
drops the variables `cargo run` sets for it (`CARGO_MANIFEST_DIR`, `CARGO_PKG_*`, ...) first: the builds it and `nsh`
start would inherit them, and since some crates' builds depend on them, every `cargo run` rebuilt ring, taffy and the
rest of what a plain `cargo build` had built.
For `--target tui` on Unix, xtask keeps the run in the foreground process group so the host can read the controlling
terminal, and requests graceful shutdown before a source-change restart.
`.cargo/config.toml` sets `IPHONEOS_DEPLOYMENT_TARGET = 15.0` for Rust and C alike.
