# The web runtime (WebAssembly)

`crates/nsh-platform-web` runs NSH apps in a browser page, rendering to the DOM: apps published with `NSH package
--target web`, the web development host (`NSH run --target web`) and the website's live demos (`website/demos/*.tsx`).
`platform.os` is `"web"` (`Os::Web`).
User-facing page: `website/docs/web.md`.

## Two runtimes

The crate builds two runtimes that differ in QuickJS only:

| | Built with | Runs | Ships in |
|---|---|---|---|
| `nsh.wasm` | feature `bytecode-only` | bytecode only: no QuickJS parser and compiler (0.17 MB less) | published apps (`nsh package --target web`), the website's player and gallery |
| `nsh-dev.wasm` | default features | JS source and bytecode, hot updates | the development host (`nsh dev`, `nsh run --target web`) |

The playground's `nsh-playground.wasm` (feature `compiler`) also has the parser: it compiles in the page.
`nsh-js`'s feature `bytecode-only` makes the VM's context without the `eval` intrinsic (`host::new_context`: the
intrinsics of `JS_NewContext` but that one); nothing then reaches `__JS_EvalInternal` and the linker leaves the
parser out. Source evaluation fails there (`eval is not supported`), so everything such a runtime runs comes compiled
by the CLI, whose QuickJS writes the bytecode (`BYTECODE_VERSION`; 64-bit hosts' bytecode loads in the 32-bit
wasm): the app (`nsh_start_bytecode`), its chunks (`nsh_chunk` with `ok` 2) and the sandbox's hardening, which is
JS (`sandbox.rs`): `nsh_js::compile_harden` compiles it as the app is packaged, the page hands it over
(`run(code, { harden })`, `nsh_bundle_harden`), and `HostOptions::harden_bytecode` runs it instead of compiling it.
Bytecode also starts sooner: the gallery's shell starts in 58–85 ms instead of 67–122 ms from source (first start in
desktop Chromium; before the gallery was split, 60–100 instead of 97–138 ms, a warm start 13 instead of 37 ms); it is
larger (the whole gallery 130 KB with brotli instead of 75 KB as minified JS), about what the parser-free runtime
saves.

## Building

`cargo xtask web` writes
`web/index.html` (the player, loading the gallery's runtime files: see "What a published app downloads"), `nsh-playground.wasm` (feature `compiler`, built in `target/web-playground` so the two
builds keep their caches), and compiles each demo with `nsh build --release` into `website/public/play/demos/<name>.nshc` (generated,
ignored by git), and publishes `examples/gallery` with `nsh package --target web` into `play/gallery/` (the website's
Gallery page frames it; packaging builds `nsh.wasm`: `--target wasm32-unknown-unknown --profile web`, the release
profile optimized for size, QuickJS still at `-O3`). Check the crate with `cargo clippy -p nsh-platform-web --target wasm32-unknown-unknown`: off
WebAssembly it is empty. `.cargo/config.toml` gives wasm32 an 8 MiB stack (QuickJS recursion) and selects getrandom's custom entropy backend. The CLI passes that backend flag to generated Rust-app builds as well, retaining existing compiler flags.

QuickJS is C, so the build needs a clang that targets wasm32 and an `llvm-ar` (CI: Ubuntu's `clang` and `llvm`, with
`AR_wasm32_unknown_unknown=llvm-ar`). Apple's clang has no WebAssembly target: on macOS point
`CC_wasm32_unknown_unknown` and `AR_wasm32_unknown_unknown` at an LLVM toolchain's `clang` and `llvm-ar` (Homebrew's
`llvm`, or the Android NDK's `toolchains/llvm/prebuilt/*/bin`).

## The CLI's web target

`crates/nsh-cli/src/web.rs`. The CLI finds the runtimes as it finds the others (`runtime::web`, `WebKind::Release` /
`Dev`): `runtime/web/nsh.wasm`, `nsh-dev.wasm` and `nsh.js` in the distribution (`cargo xtask dist` puts them there);
in a checkout it builds `nsh-platform-web` with `--profile web --target wasm32-unknown-unknown` whatever its own
profile (a debug build is several times larger and slower; `AR_wasm32_unknown_unknown` defaults to `llvm-ar`), with
`--features bytecode-only` for the release one and `--features dev` for the development host's, copies the result to `nsh.wasm` / `nsh-dev.wasm` next to it (both
build to the same file) and takes `nsh.js` from the crate.

- **`nsh package --target web`** writes a static site. Every file but `index.html` and `manifest.webmanifest` is
  content-addressed (`<stem>.<10 hex digits of SHA-256>.<ext>`, `web::hashed_name`), so hosts cache them for good
  (`immutable`) and only the page is revalidated. The page (template `crates/nsh-cli/src/web/index.html`) imports the
  hashed `nsh.js`; a script in its head requests the wasm, the app's bytecode, the hardening's and its fonts while the page
  is parsed (`fetches`, once each; not `<link rel=preload>`, see `pitfalls.md` "Web, browsers"), and the page passes
  `createPlayer` the wasm's response, `assets`
  (each `asset:/<path>` to its hashed URL: images and videos load from there on demand) and `readAsset` (the fonts'
  bytes: the engine reads fonts synchronously, `Assets::read`, to measure text with them). Fonts the entry or the UI
  sets register are fetched before the app starts; one only chunks register (`font("asset:/…")` in their code) comes
  with the first of them, through `createPlayer`'s `prepareChunk(id)`, which `nsh.js` awaits with the chunk's download
  (`web::font_loads`). With `nsh.json` `web.host` the page also imports `host.<digest>.js` and passes `createPlayer` a
  `host` (Platform services). It runs the bundle with `run(code, { release: true, harden, capabilities, appId, chunks })`
  (`appId`: the `nsh.json` id, the page's `app.id`; a Rust app's root carries its own), without `limits`: a published
  app runs on its own, with none (`sandbox.md`); an app whose capabilities restrict `network`
  gets a CSP `connect-src` meta with `'self'` and explicit HTTP / WebSocket scheme, host and port sources
  (`web::connect_src`; GET rules also admit their mapped `ws` / `wss` transport, and a host without a port uses
  `host:*`), as the browser follows redirects before NSH could check them. Relative URLs resolve against the page
  (`document.baseURI`, `nsh_set_base_url`). The app's code ships as bytecode
  (`web::CODE`, `app.<digest>.nshc`), with the hardening's (`harden.<digest>.nshc`). The app is built split
  (`build::compile_split`): each chunk is written as `chunks/<name>.<digest>.nshc` (its bytecode) and the page's `chunks` maps its id to
  that URL; nothing preloads them, the runtime fetches one the first time `import()` needs it. An app with a Rust crate of
  its own gets a runtime of its own ("Apps with Rust components"). `--run` serves the directory with `nsh_dev::SiteServer` (the cache headers a CDN should send) and
  prints its address.
- **The development host** is a page the dev server serves (`DevServer::serve_web`: the page at `/`, `nsh.js` and
  `nsh.wasm` next to it, with a wasm-bindgen glue and its snippets when the runtime has one, all `no-cache`), from
  `crates/nsh-cli/src/web/dev.html`. `nsh dev` serves it whenever a web
  runtime exists (`runtime::web(false)`), `nsh run --target web` builds one first and prints the page's address (the user opens it). The page
  speaks the dev protocol over the same port's WebSocket: its hello has platform `web` and an empty
  `bytecode_version` (the server then sends JS source, without the warning a mismatched version gets), it runs
  each bundle with its message's `app_id` (the app's storage), applies patches with `player.hotUpdate` (`nsh_hot_update`; when it reports a failure, `nsh_hot_failed`, the bundle that
  follows loads from scratch), shows build errors and `CannotRun` over the app, sends the app's log lines back, and
  reads fonts with a synchronous `XMLHttpRequest` from `/assets/`. With `nsh.json` `web.host` it imports the module
  (`web::with_page_host` serves it as `nsh-host.js`, read when the session starts, checked as `nsh package` checks it)
  and runs its `createHost(player)` before the first bundle, as a published page does; `nsh test --target web` serves
  each app's the same way (headless `nsh test` runs the module itself: `docs/dev/tooling.md` "Headless runs").
- **Tests** (`nsh test --target web`, `docs/dev/tooling.md` "On a real platform"): the CLI opens the development host
  in a headless Chromium browser it drives over the DevTools protocol (`nsh-cli/src/cdp.rs`, `test_web.rs`). When the
  server's hello says `test`, the page calls `player.testStart()` (`nsh_test_start`): from the next bundle on, every
  batch and error of the app also goes to an `nsh_testing::agent::Model` in the module (feature `dev`, `Sink`). Its
  hello says `tests` (`player.takesTests`), so the server sends it steps; each `step` is answered at once with
  `player.testStep`: `nsh_test_answer` answers what the model knows (selectors, texts, dialogs, activity) and whether
  an animation runs, `testPage` what only the DOM knows (`getBoundingClientRect` in CSS pixels, the viewport, an
  input's value, where a dialog's button is). The input itself is the browser's trusted input, sent by the CLI.

`nsh_bundle_options` sets how the next `nsh_start` / `nsh_start_bytecode` runs: development settings by default (the
player, the playground, the dev host), hardened (`Policy::default()`) for published apps, the declared capabilities,
a source map and the app's id (for its storage); `nsh_bundle_harden` the hardening's bytecode.

### What a published app downloads

`examples/gallery` as `nsh package --target web` publishes it (2026-10; `gzip -9`, `brotli -q 11`). Each demo is a
module the index loads with `import()` (the gallery's `lazy`), so it is a chunk of its own: the first load is the page,
the runtime, the app's shell and the demo shown first (Stocks, in the desktop layout; none in the phone layout's
index). The other demos, 18 chunks of 265 KB (72 KB gzipped) in all, and the fonts they register (Pacifico, with
the Text demo: `web::font_loads`, the page's `prepareChunk`) come when opened; images when shown, icons when the
browser wants them.

| File | Raw | gzip | brotli |
|---|---:|---:|---:|
| `index.html` (with the chunk map) | 6.0 KB | 2.6 KB | 2.1 KB |
| `nsh.<digest>.js` (minified) | 79.2 KB | 25.2 KB | 22.5 KB |
| `nsh.<digest>.wasm` (without the parser; with it, before the size work: 3779 / 1311 / 1001 KB) | 3504 KB | 1217 KB | 928 KB |
| `app.<digest>.nshc`: the shell's bytecode (as minified JS: 34.9 / 9.7 / 8.5 KB) | 45.2 KB | 16.5 KB | 14.0 KB |
| `harden.<digest>.nshc` | 1.4 KB | 0.9 KB | 0.7 KB |
| `chunks/Stocks.<digest>.nshc` (as minified JS: 55.9 / 17.3 / 15.4 KB) | 78.0 KB | 33.2 KB | 28.1 KB |
| **first load** (with the 32 px favicon) | **3715 KB** | **1296 KB** | **997 KB** |
| before the demos were split: `app.<digest>.js` 347 / 92.5 / 74.9 KB and the preloaded font 329 / 145 / 121 KB | 4518 KB | 1571 KB | 1217 KB |
| `manifest.webmanifest` | 0.4 KB | 0.3 KB | 0.2 KB |
| images (`bounce.gif`, `logo@2x.png`, `spinner.webp`) | 16.1 KB | 6.0 KB | 5.6 KB |
| icons 180 / 192 / 512 px | 114 KB | 89.4 KB | 86.9 KB |

The app's own share of the first load went from 676 KB (195 KB with brotli) to 91 KB (24 KB). The wasm is now nearly all of the first load. `nsh.js` is minified at package time
(`nsh_bundler::minify_module`: oxc's minifier, local names mangled, property names kept, since the mounter looks its
`op_<name>` methods up by name); the dev host serves it as it is. Published sites carry no source maps.

The website's player (`cargo xtask web`) loads the published gallery's `nsh.<digest>.js` and `nsh.<digest>.wasm`
(`play/gallery/`) rather than copies of its own, so the site deploys one runtime, the parser-free one: its demos are
bytecode (`demos/<name>.nshc`, fetched as bytes; `astro dev` compiles one on request, `website/src/lib/play-dev.js`).
Only the playground has a second wasm (`nsh-playground.wasm`, with the compiler).

## Size

`nsh.wasm` is downloaded before anything shows, so the `web` profile builds Rust for size (`opt-level = "z"`, fat LTO,
`panic = "abort"`, stripped) while QuickJS keeps `-O3`: at `-Os` it is 0.18 MB smaller (50 KB with brotli) but its
interpreter is about 10% slower, and QuickJS is the slowest link. `nsh-platform-web` turns on rquickjs'
`disable-assertions` (QuickJS' internal `assert`s, which check its own invariants: 37 KB, and a little faster); the
native platforms keep them.

Published apps' runtime has no QuickJS parser ("Two runtimes"): 0.17 MB, 40 KB with brotli. The runtime carries no
declaration text (the documentation and TypeScript of the specs, which only make
`.nsh/types`: `docs/dev/tooling.md`): 69 KB, 20 KB with brotli.

Where the rest goes (raw, before compression): QuickJS about 0.6 MB of code without its parser, the web APIs of `nsh-js` 0.36 MB (streams alone 0.14 MB), the core and Taffy about 0.65 MB, `url`'s IDNA with
ICU4X's normalization data 0.16 MB, generic code of `core` / `alloc` / `hashbrown` 0.6 MB, data 0.43 MB. Tried and
left out:

- `wasm-opt -Oz` (binaryen): 15% smaller raw, but no smaller (slightly larger) with brotli or gzip.
- An ASCII-only IDNA (`idna_adapter` 1.0): 33 KB less with brotli, but non-ASCII host names would fail to parse;
  `idna_adapter` 1.1 (the unicode-rs crates) is larger than ICU4X.
- Rust at `opt-level = "s"`: larger.

Measure with names kept (`CARGO_PROFILE_WEB_STRIP=false`) and `twiggy top` / `twiggy dominators`, or a linker map
(`RUSTFLAGS="-C link-arg=--Map=map.txt"`, which also sizes the data segment by symbol). Compare raw, `gzip -9` and
`brotli -q 11` sizes: pages are served compressed, and a change can shrink the raw module and not the compressed one.

### Apps with Rust components

The prebuilt runtime serves the runtime's modules and `nsh/base`; an app with a Rust crate of its own (`nsh.json` `"rust"`,
`docs/dev/tooling.md`) gets one built with its set, as it gets its own native hosts. `runtime::web` asks the app
(`rust_app::RustApp::web`), whose generated workspace (`.nsh/rust`) has a member `web`: a `cdylib` of
`nsh-platform-web` and the app's crate whose code is `nsh_platform_web::ui_sets!(vec![nsh_base::registry(), app_set()])`. The macro exports `nsh_app_init`, which `nsh.js` calls right after instantiating the module (there is
no `main` to call `set_ui_sets` in a wasm module, nor a `dlsym` as Android's `ui_sets!` uses); a module without it
(the prebuilt runtime) serves `nsh/base`. The `nsh_*` exports come from `nsh-platform-web`'s rlib: a `cdylib`
exports its dependencies' `#[no_mangle]` functions. The workspace has the same `web` profile as nsh's `Cargo.toml`, and
the crate's `build.rs` passes the 8 MiB stack as a link argument of its own (nsh's `.cargo/config.toml` may not apply
where the app builds, and target-wide `rustflags` would rebuild every dependency instead of sharing nsh's builds).
Both kinds build to `target/wasm32-unknown-unknown/web/nsh_app_<package>_web.wasm` and are copied to
`.nsh/rust/web-runtime/nsh.wasm` / `nsh-dev.wasm`; `nsh.js` is nsh's. Everything else (bundling, bytecode, the
crate's assets, the dev server) already knows the set, from its description (`docs/dev/tooling.md`).

`web::ui_sets` (the sets the runtime serves, which `package` checks the app's imports against and the dev page sends
in its hello) are the command line's own (`crate::ui_sets`). The dev host's files include `nsh.version` (a digest of
`nsh.js` and the wasm), which `dev.html` also has inlined: a change of the app's Rust code ends the session, the app's
command line runs again with a new runtime (`rust_app::reexec`), and a page that reconnects and finds another version
reloads (one that finds none, a session still starting, connects again). Neither `nsh run --target web` nor
`nsh package --target web --run` opens a browser: they print the address.

A Rust app (`nsh.json` `"root"`: `rust_app::RootConfig`, its entry the `nsh.json`, `rust_app::is_root`) has no JS
at all: its member `rust-web` is `nsh-platform-web` **without the feature `js`** (no `nsh-js`, no `rquickjs`, the
engine without `js`) and `nsh_platform_web::rust_app!(sets, app_root())`, whose `nsh_app_init` also registers the
root (`set_root`); `app_root()` is generated from `"root"`, `"theme"` (compiled in with `include_str!`) and
`"appearance"` (`Root::appearance`). The page calls `player.runRust()` (`nsh_start_rust`) instead of `run`: the
packaged page when `app.rust` is set (no `app.nshc`, no `harden.nshc`), the dev page (`{{rust}}`) once the dev
server greets it; the dev session publishes no bundles (`DevSession::rust_root`). The JS exports (`nsh_start`,
`nsh_start_bytecode`, `nsh_bundle_*`, `nsh_hot_*`, `nsh_chunk`) are `cfg(feature = "js")`. The runtime builds to
`nsh_app_<package>_rust_web.wasm`, copied to `.nsh/rust/web-runtime/nsh-rust.wasm`.

Rust code meant for the web too uses the engine's services rather than threads and the standard clock: `fetch`
(`nsh_core::ui::ambient::fetch`, below), the executor's timers, `nsh_core::time`. `examples/gallery-rs` does. As a
Rust app (2026-10) its `nsh.wasm` is 3.31 MB (1.06 MB gzipped, 0.75 MB with brotli): no QuickJS, so smaller than the
prebuilt runtime, which a TSX entry (QuickJS) needs: the gallery under one was 5.26 MB (1.75 / 1.27 MB).

### Crates that call JS through wasm-bindgen

The runtime is a raw module (`nsh_*` exports, `nsh` / `env` imports), not a wasm-bindgen one, so an app crate's
`web-sys` / `js-sys` imports have nothing to call by themselves. `RustApp::web` hands the built module to
`bindgen::install`, whose reader (`bindgen::needs`: the import section and wasm-bindgen's custom section, the others
skipped by size) decides by its imports: it needs wasm-bindgen's glue when it imports a JS function through it, a
`__wbindgen_placeholder__` import named `__wbg_<name>_<hash>` or `__wbindgen_…`: web-sys, js-sys,
a crate's own extern blocks, and wasm-bindgen intrinsics (`JsValue::as_string`, generic casts such as
`JsValue::from_str`) all need glue. The descriptor (`__wbindgen_describe`), throw helper
(`__wbg___wbindgen_throw_…` or `__wbindgen_throw`) and `__wbindgen_externref_xform__` imports alone do not
trigger processing: linking wasm-bindgen can retain these even without calling JS (chrono's default
`wasmbind` without `Utc::now`). Such a module is copied and served as before, without the CLI.
Otherwise `bindgen::process` runs the `wasm-bindgen` CLI
(`NSH_WASM_BINDGEN`, else `PATH`) of the version the module records (the first record of its
`__wasm_bindgen_unstable` section, `{"schema_version":…,"version":"0.2.129"}`; `bindgen::check_cli` stops the build
with both versions and the install command when the CLI's differs) with `--target web --no-typescript
--omit-default-module-path` (the page hands the module over: the glue names no `<module>_bg.wasm`). It writes into
`<module>-bindgen.tmp/`, which replaces `<module>-bindgen/` once the glue is adapted, and then renames
wasm-bindgen's module over the built one (`nsh.wasm` / `nsh-dev.wasm` / `nsh-rust.wasm`) and the adapted glue to
`<module>-bindgen.js`: a failed run leaves the previous build's module, glue and snippets together. A runtime rebuilt
without the glue removes the earlier build's glue and directory.

`bindgen::adapt` makes the glue `nsh.js`'s: the glue imports the module's other imports as ES modules (`import * as
import1 from "nsh"`, a bare specifier no page resolves), which become empty objects `nsh.js` fills, and its
`__wbg_get_imports` / `__wbg_finalize_init` are exported as `__nsh_imports` / `__nsh_finalize`. That is the glue of
wasm-bindgen 0.2.129, the version it was tested with (`crates/nsh-cli/src/bindgen/wasm-bindgen-0.2.129.js`, that
CLI's output, is the test's input); glue without those functions, or with a static import of a bare specifier left
after adapting (another shape, or a crate's `raw_module = "pkg"`), is refused with the CLI's version rather than
shipped broken. The JS snippets the glue imports (`#[wasm_bindgen(inline_js = …)]` and `module = …`:
`snippets/<crate>-<hash>/…`, `bindgen::snippets`) stay in `<module>-bindgen/`; a snippet may import another one by
its relative path, since both are served and published under the paths wasm-bindgen gave them.

`WebRuntime::glue` carries it: the dev host serves it as `/nsh-bindgen.js` and its snippets at the paths it imports
them by (`/snippets/…`; `dev.html`'s `GLUE`; all of them are part of `nsh.version`), and `nsh package --target web`
(`web::publish_glue`) puts the snippets under one directory named by all of them and their paths
(`snippets.<digest>/`, their paths under `snippets/` kept), points the glue at it (`bindgen::link_snippets`: the
`./snippets/` prefix only), minifies the glue, names it by its content (`nsh-bindgen.<digest>.js`), preloads it
(`<link rel="modulepreload">`) and passes it in `app.glue`. `createPlayer`'s option `glue` (a URL against the page)
makes `Player.load` import it while the module compiles, check that it exports `__nsh_imports` and `__nsh_finalize`
(wasm-bindgen's own output fails there, with its URL), merge `__nsh_imports()` into the import object (NSH's own
`nsh` and `env` keys win), and call `__nsh_finalize(instance, module)` (its memory views, wasm-bindgen's externref
table) right after instantiating, before `nsh_app_init`. The glue keeps its state at module level, so each player
after the first imports it as `<url>?player=<n>` (`importGlue`): a module instance of its own, while the first keeps
the URL the page preloads. `cargo test -p nsh-cli bindgen -- --ignored` runs the CLI on a real module
(`wasm_bindgen_runs_on_a_real_module`: a crate built for `wasm32-unknown-unknown` with the CLI's wasm-bindgen; it
needs the target, the CLI and the crates).

The browser calls the glue's closures outside any `nsh_*` call (a WebSocket message), so a task they wake must make
the page pump: `LocalEngine::set_wake` hooks the core's task notify and the posts' notify (each still sends
`Message::Wake`), and `nsh_platform_web` sets it to the `request_pump` import, which `Player.requestPump` coalesces
into one `nsh_pump` in a task of its own (`setTimeout` 0; `call` defers it while the engine runs). `pump` sets a flag
while it runs (`LocalEngine::pumping`): what it wakes itself (spawns, task timers, `Callback::post`, the fetch replies
it hands to tasks) its bounded loop runs without calling the wake, and only work that loop leaves calls it, once, at
the end, so tasks woken only there (timers, fetch replies) request no pump of their own. The deadline scheduling
(`schedule`) is unchanged.

## What WebAssembly changes in the shared crates

- **No threads.** `nsh_engine::LocalEngine` drives the engine from the host's event loop: `pump()` handles what was
  sent through its `EngineControl`, runs timers and tasks, commits, and returns its next deadline. The threaded
  `Engine` and `LocalEngine` share `Driver` (setup, `deadline`, `handle`, `turn`, idle collection); `Engine` and the
  shared tokio runtime are `cfg(not(target_arch = "wasm32"))`.
- **No clock.** `std::time::Instant::now` panics on `wasm32-unknown-unknown`. Shared code uses
  `nsh_core::time::Instant` (std's elsewhere; `performance.now()` through the `nsh.now_ms` import there) and
  `nsh_core::time::unix_ms`. Rust components' `cx.timer()` returns `nsh_core::time::Sleep` there, whose wakers the
  driver fires (`next_timer`, `fire_timers`); `background` / `blocking` do not exist. Rust components' HTTP goes
  through the engine (`nsh_core::ui::fetch`: `Action::Fetch`, `Core::take_fetches` / `fetch_event`, the engine's
  `Net` with `Requester::Task`), so it is the browser's `fetch` here (`net.rs`) and the platforms' stacks elsewhere,
  under the same capability checks as JS's.
- **QuickJS** uses rquickjs' pregenerated bindings (its bindgen run misses `JS_ToCStringLen2` for wasm32) and its
  vendored wasi-libc; the only libc import is `env.__rquickjs_host_now_us`. Its local time is the browser's: the
  shim answers `localtime_r` with UTC, so the crate's `build.rs` links with `--wrap=localtime_r` (as do apps' own
  runtimes, `rust_app.rs` `WEB_BUILD_RS`) and `local_time.rs`'s `__wrap_localtime_r` asks the page for the offset at
  that time (`nsh.local_offset`: `nsh.js` `localOffset`, seconds east from `getTimezoneOffset()`, so daylight saving
  time follows the browser's zone); `Intl`'s default zone is the page's too (`nsh.time_zone`: `timeZoneName`,
  `intl/mod.rs` `local_zone_name`). `web/local-time.test.mjs` tests both helpers in several zones under node; the
  link wrap itself shows only in a browser: check it by packaging a page that prints `getTimezoneOffset()`, `getHours()` and `resolvedOptions().timeZone` and loading it in
  headless Chrome under two `TZ`s (`Asia/Shanghai`; `America/New_York`, whose January and July offsets differ): it
  must print what a headless `nsh test` of the same app prints under the same `TZ`.
- **32-bit pointers.** The reactive graph packs node handles into QuickJS opaque pointers: 32 bits of id and 32 of
  generation on 64-bit targets, 20 and 11 (under a set top bit) on 32-bit ones (`reactive.rs`, `pack`). Anything that
  stores more than a pointer's worth of bits in an opaque must do the same.
- `nsh-package` cannot generate keys there (no `getrandom`); verifying works.

## Standard modules in the browser

All eleven standard modules load in the web runtime. `quickjs-jit-stdlib` compiles its portable Rust hashing, buffers and compression into WebAssembly, preserving synchronous APIs; cryptographic entropy comes from the player's `crypto.getRandomValues` bridge. The `path` module uses POSIX paths with virtual working directory `/`. NSH's URL classes retain their identity.

`filesystem.rs` implements `FileSystem` through the player's Origin Private File System bridge. Rust checks the app's file grants, normalizes paths relative to its configured data directory and enforces quotas before sending an operation. OPFS persists files in an app-specific namespace within the page's origin and requires a secure context. File modification time comes from browser metadata; unknown access/birth times and modes are zero. `rename` uses the browser handle's atomic `move` operation, reporting `ENOTSUP` when that operation is unavailable. OPFS entries are files and directories; `readlink` reports `EINVAL`.

`websocket.rs` implements the shared `WebSocketTransport` with browser WebSocket. Both the global constructor and `websocket.WebSocket.connect` use it, with HTTP capability checks, Rust queue/message/connection limits, deadlines and cancellation. Custom handshake headers report an explicit unsupported-option error. NSH checks the initial normalized URL; browser policy controls WebSocket redirects, mixed content and connection access. Native WebSocket handshakes reject redirects. Raw TCP and subprocess calls return typed platform errors; their modules and metadata exports still load.

A granted `process.exit(code?)` follows the engine's `ExitApp` command to the player. The player queues `Player.reset()` in a microtask after the current mount batch returns, stopping the app and clearing its surface while retaining the host page. Deferring disposal avoids reentering and freeing the VM during its batch callback; the queued action checks the app identity so it cannot reset a replacement app.

## The playground's compiler

Feature `compiler` adds `nsh_compile` (and `nsh_compiled_ptr` / `_len`): `nsh_bundler::compile_module`, the one-module
path of the bundler (`crates/nsh-bundler/src/compile.rs`: oxc parse, TypeScript removal, NSH's JSX compiler,
codegen). Rolldown does not build for wasm32, so `nsh-bundler` puts bundling behind its default feature `bundle`
(rolldown, tokio, assets, `.nsh/types`); the workspace depends on it without, and the CLI and the engine's tests
turn it on. The compiler grows the module by about 3 MB, so the docs pages load `nsh.wasm` and only the playground
`nsh-playground.wasm`.

oxc's transformer links `oxc-browserslist`, whose wasm32 build depends on `js-sys`: the module imports wasm-bindgen
glue (`__wbindgen_placeholder__`, `__wbindgen_externref_xform__`) that NSH never calls (it only reads dates for
browserslist queries). `nsh.js` gives every import it does not know a stub that throws if called.

## The environment

`nsh.js` reports what the page knows with `nsh_environment(json)` before `nsh_start` and whenever it changes (only
when the JSON differs): `idiom`, `locale` (`navigator.languages[0]`), `rtl` (`<html dir>`, else the locale's script),
`reduceMotion`, `fontScale` (the root font size / 16), `pixelRatio`, `safeArea` (`env(safe-area-inset-*)` read
through a hidden probe element, clipped to the container) and `keyboard` (the container's part below
`visualViewport`). The Rust side keeps it (`PAGE`) for the next start; the appearance and the window keep their own
calls (`nsh_set_dark`, `nsh_resize`). Changes come from media query listeners, `languagechange`, `visualViewport`,
`resize` and a mutation observer on `<html dir lang>`.

The idiom is fixed at start, as `Environment::idiom` is everywhere: `desktop` for a fine, hovering pointer and a
container at least 600 wide (headless Chromium reports no pointer and measures as a tablet or phone unless launched
with a fine, hovering one, as `nsh test --target web` does), `pad` for a screen whose short side is at least 600, else
`phone`; the player's `idiom` option overrides it. `Environment::desktop()`
(desktop OS, or the web in the desktop idiom) decides `desktop={{…}}` props, `platform.select`'s `desktop` key and
`platform.idiom`; `Os::is_desktop()` stays the desktop backends' OSes (`nsh/desktop`'s windows and menus). Like the
desktop backends, the web gives the core no header heights (`NO_NATIVE_HEADER`): a page's `header` slot is all
there is at its top. The browser's bars are the browser's: the web ignores `Command::StatusBar` (pages' and dialogs' `statusBar`).

## The protocol

Exports are `nsh_*` functions (`src/lib.rs`); imports are module `nsh` (`src/ffi.rs`). Every export that reaches
the engine pumps it and returns the next delay in milliseconds (-1: none), which `nsh.js` turns into a `setTimeout`.
The engine is not reentrant: `nsh.js` routes every call through `Player.call`, which defers calls made while a
batch is being applied (a batch arrives inside a wasm call).

A commit becomes one JSON array (`src/encode.rs`): `["c", id, kind]`, `["f", id, x, y, w, h]`, `["s", id, class,
borderClass, tint]`, `["t", id, ...content, runs, styles, selectable, selectionClass]` (`styles`: a class per run
style; `selectable` `null` when unset), `["vp", id, props]` (the view props as an object: `pointerEvents`, `hitSlop`,
the accessibility props, `testID`, `focusable` when false, `selectionArea` when true), `["in", id, config, class]`, `["css", class, text]`, and so on; `nsh.js` has one `op_<name>` method per
item. Views are absolutely positioned at the core's frames; borders are an overlay element (as UIKit draws layer
borders) so they never move the content the core placed. Native animation items stay in Rust (`src/animation.rs`, a port
of the Android animator); bound properties go out as `["a", id, prop, value]` after each batch and each
`requestAnimationFrame` tick.

## Animation

What moves on the web follows the Linux backend (`nsh-platform-linux` `transition.rs`, `navigation.rs`), which was
measured against it frame by frame (`requestAnimationFrame` samplers of computed styles in headless Chromium):

- **Animated values** (`src/animation.rs`): the graph's clock is in seconds (`Graph::tick`), so `nsh_frame` divides the
  `requestAnimationFrame` time (ms) by 1000; passing milliseconds ended every `timing` / `spring` / `decay` on its
  first frame.
- **Style transitions** are CSS transitions of the properties `TransitionProps` names (outline included); the
  border overlay gets its own for border colors, widths and radii, since it draws the border.
- **Keyframes** (`animate-spin|ping|pulse|bounce`) are CSS animations with `animation-composition: add`: their
  transforms follow the view's own (and the animated values bound to it), as the native backends apply them after
  the style's. Opacity is multiplied, not replaced: a view with keyframes writes `opacity: calc(<opacity> *
  var(--nsh-ko))`, and the keyframes add to the registered `--nsh-ko` (initial 1).
- **Layout animations** (`op_la`, for the rest of the batch) run with Web Animations, which play over the views' own
  inline and class styles without replacing them: frames animate `left` / `top` / `width` / `height` from where the
  view shows (a running animation's frame, so an interruption continues from there), never a view's first frame;
  views created in the batch appear (opacity from 0 to their own, or a scale added to their transform), removed and
  deleted ones disappear and are detached at the end (a view inside one that disappears goes with it; one inserted
  again comes back at once). Springs are CSS `linear()` easings sampled from the Linux backend's curve
  (`spring_easing`). Navigation's views (stacks, pages, dialogs, header items) are left out.
- **Pages** push and pop as on Linux: a slide of 300 ms with the page under it moving by 30 % of the width, a
  200 ms fade for `animation: "fade"` (and for every page with reduced motion), nothing for `"none"`, easing out
  cubically (`cubic-bezier(.333,1,.667,1)` is exactly 1 − (1 − t)³). Pages a batch removes stay until the stack is
  reconciled after it (`reconcileStacks`): the top one slides out when the app popped it. NSH draws no header: a
  page's `header` (the app's view, which the core places at its top, full width, with the content below it) is
  appended to the page above its content (`placeHeader`, class `nsh-page-header`), and the page's content insets
  drop the safe area's top while it has one (`screenInsets`).
- **Removed content stays while its container leaves**: views a batch removes leave the page at its end
  (`finishRemovals`), unless they are inside a dialog being dismissed, a page sliding out or a view disappearing,
  which takes them along (dropped when it is gone): an app removes a dialog's or page's content in the batch that
  removes the dialog or page, and the content must still show while it slides out (Linux keeps an image of it).
- **Press feedback** is the app's (`activeStyle`, `active:` classes): the core restyles a pressed view as it does
  on every backend, and the page adds no fade of its own.
- **Release velocities** of drags (`nsh_pan`) are measured over the last 100 ms of pointer samples (zero after a
  pause), as on Linux, not from the last two events.
- **Images** with `fadeDuration` fade in linearly, and only when they had to load (not from the cache).
- **Reduced motion** (`prefers-reduced-motion`): no layout animations, style transitions or keyframes (root class
  `nsh-reduce`), pages fade.

A split bundle's chunks (`native-pipeline.md`) are fetched by the page: the engine asks through the `load_chunk`
import (`Sink::load_chunk`), `nsh.js` fetches `chunks[id]` or `id` relative to `chunkBase` (`player.run(code,
{ chunks, chunkBase })`) and hands it to `nsh_chunk(id, code, ok)` (`ok` 1: source, 2: bytecode, which a bundle run
as bytecode has; 0: `code` is the error), which pumps. A chunk that arrives after `run` started another app is
dropped.

Text (`src/text.rs`) is broken into lines here, with widths and font metrics from the `measure_text`,
`font_ascent` and `font_descent` imports (canvas `measureText`, cached per font and string); runs are drawn at the
positions computed here with a line height equal to the font's ascent + descent, so the baseline lands where layout
put it. Canvas text has no numeric variants (its `font` takes only `small-caps`; there is no `fontVariantNumeric`),
so text with one (`tabular-nums`, ...) is measured by `measure_numeric_text` instead: a hidden span with the run's
`font` and `font-variant-numeric`, as the run is drawn. Measuring there lays the page out, so a figure (digits and the
signs numbers are written with: `css::measured_by_char`) is the sum of its characters' widths, each measured once and
cached, and a live value that changes every frame lays nothing out; text with letters is measured whole, kerning
included (`web/text-browser.test.mjs` checks both against what Chrome draws). The CSS of runs (`src/text/css.rs`: the `font` shorthand,
generic families such as `monospace` left unquoted,
names the app quoted kept only when their quotes close them) and line breaking (`src/text/wrap.rs`: break opportunities, the
line start and end rules of CJK punctuation, the filling of lines) depend on nothing of the browser and are tested on
the host (`tests/text`).

## Styles as classes

No element has an inline style but its geometry (frames, a field's content box, sticky offsets, a zoomed layer, snap
markers) and animated values (`["a", …]`, layout and page transitions): the same text in every
element and every batch would be parsed again each time. Every visual style is a class. `src/encode.rs` turns a view's
style, its border overlay's, each text run style (with its line height), a text's selection color and a field's text
into CSS, and names each distinct text `nsh-` and 8 hex digits of its 32-bit FNV-1a hash (`class_key`; the mounter's
fixed classes are words, `nsh-root`, `nsh-hidden`, so the two never meet). The first item that uses a class the page
does not have comes after `["css", name, text]`; `nsh.js` inserts `.name.name{text}` into `<style id="nsh-classes">`,
shared by the document's players (the doubled class wins over the runtime's rules of a class and a pseudo-class,
`.nsh-v:focus`, as inline styles did). What the mounter styles itself is fixed classes in its stylesheet (scroll axes,
snapping, fits, hidden states, the press cursor `nsh-pointer`, `nsh-inert` for `pointerEvents`), or classes it names
the same way from the CSS it makes (`cssClass`: a blur, an image's tint and mask, the latter over the
view's own background with a tripled class). A second hash of each text in Rust tells two texts with the same name
apart: the later one then gets a view's own rule.

A view whose styles keep changing (a style animated from JS: a new text each frame) would grow the sheet by a rule a
frame. After 16 classes defined for one view (`OWN_RULES_AFTER`) its new styles go to rules of its own (`i<id>`,
`i<id>b`, `i<id>t<style>`, …, `nsh-p<player>-` in front), in `<style id="nsh-own">`, which `op_css` replaces in
place (a sheet of its own: the browser goes over a changed sheet again); deleting the view resets its count.

Measured in headless Chromium against inline styles (2026-10):

| | inline | classes |
|---|---:|---:|
| packaged gallery, phone layout, first batch | 62.5 KB | 39.9 KB |
| packaged gallery, desktop: the shell's first batch / the Stocks chunk's | 33.3 / 226.2 KB | 28.6 / 180.8 KB |
| packaged gallery, desktop, Stocks (ticking every 50 ms) then Styles, Tailwind, Text, Form, Lists, dark | 3.79 MB | 3.01 MB |
| Lists grid scrolled to the end (40 wheel steps): batches, main thread | 65.9 KB, 90 ms | 25.5 KB, 76–78 ms |
| the website's 31 demos, first render in all | 428 KB | 286 KB (−33%) |
| a box whose background, border and text color change every frame from JS, over 6 s: style recalculation, main thread | 25 ms, 272 ms | 41 ms, 291 ms |

Screenshots are pixel-identical but for animations caught at other moments (the 31 demos, the gallery's demos, dark
mode switched at run time, hover, focus). A field restyled after its content box was placed (dark mode) no longer
loses its position: the old full `cssText` replaced it.

## Networking

`fetch` runs on the browser's `fetch` (`src/net.rs`, the `fetch_*` imports and `fetchStart` in `nsh.js`), behind the
engine's `Net` like every platform's stack, so the app's capabilities are checked in Rust before a request reaches
the browser. JS reports each request's head, body chunks (read from the response's `ReadableStream`), end or failure
through the `nsh_fetch_*` exports, which hand them to the request's `FetchEvents` and pump; `pause` stops reading the
reader (back pressure), dropping or cancelling the task aborts its `AbortController`. Streamed request bodies are
collected and sent as one `Blob`: Chromium streams uploads only over HTTP/2 (`duplex: "half"`), other browsers not at
all.

The browser stays in charge of what it enforces: CORS (cross-origin servers must allow the page's origin, and only
CORS-exposed response headers are visible), cookies (`credentials: "same-origin"`: sent to the page's own origin
only), forbidden request headers (`Cookie`, `User-Agent`, ... are dropped). Browsers do not expose a redirect they
do not follow (`redirect: "manual"` gives an opaque response without status or `Location`), so a hop with
`follow_redirects` off fails when it is redirected: JS `redirect: "manual"` / `"error"`, and the hops the engine
follows itself to check each one against restricted capabilities (`access.rs`).

Relative request URLs (`fetch("/api")`, `new Request("x")`) resolve against the page's `document.baseURI`, which
`nsh.js` hands over once with `nsh_set_base_url` and `nsh_start` puts in `Bundle::base_url` (→ `HostOptions::base_url`,
used by nsh-js `fetch.rs`); native hosts have no base and keep rejecting them. `new URL("/x")` without a base throws,
as in browsers. Relative `<Image>` URLs are the `<img>` element's, resolved by the browser.

`Image.getSize` / `prefetch` (`Command::ImageInfo`) load an `Image` in the page and answer with `onImageInfo` on
the root; `<Image>` elements are `<img>` elements, loaded by the browser.

## Input

`nsh.js` turns browser input into what the desktop backends report (`docs/dev/linux.md` is the reference), and phone
browsers' touches into what phones report:

- **Touches** pan only scroll views: the root is `touch-action: none` (`pan-x pan-y` in an iframe, `nsh-embedded`,
  so that swipes the app does not take scroll the embedding page), scroll views `pan-x pan-y`, views with native
  pans or pinches `none` (a `panActivation` gate along one axis leaves the other axis to the scroll views around), so
  the page neither scrolls, zooms nor refreshes under the app and presses and pans get no `pointercancel`. Touch
  scrolling is the browser's: a `pointercancel` in a scroll view starts its drag, `touchend` ends it, a scroll within
  150 ms after it begins the glide, `scrollend` ends it (`touchScroll`, `scrolled`, `scrollEnded`).
- **Wheels and touchpads** (`wheel`) go to the innermost scroll view along their axis that can move that way (a
  vertical wheel scrolls a horizontal view when no vertical one can) and stay on it while events come within 200 ms;
  notches glide, touchpads follow the fingers; snapping views move one snap point per scroll. Nothing to scroll: the
  event goes on to the page around (an embedding page scrolls). Ctrl + wheel (a touchpad's pinch) pinches the view
  under the pointer and never zooms the page. Scroll events follow the desktop backends: touch drags send
  `onScrollDragStart` / `EndDrag`, glides and snaps `onMomentumStart` / `End`, every scroll ends with one
  `onScrollEnd` (the browser's `scrollend` after a scroll driven here, `drive` / `ownEnd`, is not another).
- **Mouse drags never scroll**, in every idiom, as on the desktop backends: dragging the content is a touchscreen's
  way to scroll, the mouse has the wheel, the keyboard and the scroll bar. Its drags go to pans, the responder system
  and selectable text (`pointerDown` only takes touches and pens in zoomable views, which pan themselves; a press
  elsewhere has its `mousedown` prevented, so it selects no page text).
- **Scroll bars** in the desktop idiom are nsh's own, as on the desktop backends (`showBar`): the browser's are hidden
  (they would take 6 px from content the core laid out for the whole view), and a 4 px thumb in a sticky, zero-size
  `.nsh-bar` at the view's top left (it stays put as the content scrolls, in step with the compositor) shows while
  the view scrolls or the mouse reaches its draggable thumb and fades 700 ms after.
  Hovering content leaves its visibility and fade timer unchanged. Views along one axis with `scrollbar`, and
  horizontal ones always, have one. A mouse press within 12 px of the edge on the thumb, faded or not, drags it
  (`grabBar`: `onScrollDragStart` / `EndDrag`, snapping off while it is held, a snapping view then settles on the
  nearest snap point). Phones and tablets keep the browser's own overlay scroll bars.
- **Keys** (`keyDown`), in this order: the app's shortcuts (`nsh/keymap`: the mounted `MountItem::Keymap` stays in
  Rust, `nsh_key` matches a key on the spot with `Keymap::find` and `nsh_key_command` reports the binding.
  Its `f64` result preserves the full `u32` ID range, including Rust shortcuts and overlay Escape, apart from
  the `-1` (unmatched) and `-2` (held repeat) sentinels. Keys are passed as the character they type without
  modifiers, else the US layout's character of their `code`; `mod` was resolved by the browser's platform,
  `appleKeyboard` in the environment JSON); an open dialog (Escape presses its
  cancel button); a focused field (Escape leaves it); selectable text with a selection (select all, in a selection area the whole area; Escape); a focused
  pressable (Return presses it, Space when released); going back (Escape, Alt+Left, Cmd+[, BrowserBack); scrolling the
  scroll view around the focus or under the mouse (arrows by 40 points, Page Up / Down and Space by 0.875 of a page,
  Home / End).
- **Focus**: pressables are focusable (`tabindex=0`, role `button` unless they have one) unless disabled, hidden or
  `focusable={false}` (a focused one that stops being a stop is blurred), so Tab and Shift+Tab reach them in DOM order; `focus:` states follow the keyboard focus (`:focus-visible`), which
  draws a ring inside the view; a popped page gives the focus back to what had it when the page was pushed
  (`screenGone`). A click never moves the focus (`mousedown` is prevented outside fields, selectable
  text, selection areas and hosted pages), as in native apps; it focuses the app's window in an iframe. The views under the newest
  `Dialog` or alert are `inert`; the focus one took comes back when it closes.
- **Accessibility**: `op_vp` sets ARIA from the accessibility props (roles mapped by `ARIA_ROLES`, `aria-disabled`,
  `-selected`, `-checked`, `-busy`, `-expanded`, `-value*`, `-live`, `-hidden`, the hint as `aria-description`);
  `Command::Announce` writes into a polite live region, `Command::AccessibilityFocus` focuses the view.
- **Going back** (`back`) is decided from what is mounted, as on Android and the desktops: a stack inside the newest
  dialog pops, else the dialog gets the close attempt (`onCancel`, reason `"cancel"`) and closes natively when
  `closeOnEscape` (the default), reporting `onOpenChange(false, "cancel")` and `onClose`; without a dialog the root's
  `onBackPress` hears it when the app listens, else the innermost stack's top page gets `onBackPress` when it listens
  and pops unless its `popOnBack` is false (`goBack`). `Command::Back` goes back as without the app's listeners.
- **Dialogs** (`Dialog`) are children of the root above the app's views (`present` / `dismiss`), transparent layers
  covering the root with its safe area, whatever their `presentation` (`placeModal`; the core's frames are ignored,
  it lays the dialog out at the size `nsh_root_size` reports): only the app's popup and backdrop show, which the
  runtime renders in it. `slide` moves the dialog up from below the root's bottom edge (a fade with reduced motion),
  `fade` fades it; `onOpen` follows the transition. A dialog the app removes leaves the same way, then reports
  `onClose`.
- **History**: when the app is the page (`window.top === window`, or `createPlayer`'s `history` option) every page
  above a stack's first and every dialog is a history entry (`pushState`, state `{ nsh: depth }`), so the browser's
  back button and the mouse's go back in the app; entries the app takes away itself are gone back over with
  `history.go`, whose `popstate` is ignored, and a back the app refuses gets its entry again; a new `run` goes back
  to the first entry. Entries carry the page load's id (`nshSession`): a reload keeps the earlier load's entries,
  which going back passes over (`history.back()` again) as if the app had been left from its first page. In an
  iframe (the website's demos) the app pushes nothing: each entry would be one of the embedding page's history.
- **Text selection**: text is selectable when `selectable` is true (`nsh-selectable`), and with the desktop idiom also
  when it is unset (`null` in the `t` item: `nsh-autoselect`, selectable under `.nsh-desktop`) unless a view around it,
  or the text itself, takes presses, touches, pans or pinches (`nsh-press`, set in `updateTouchAction`), as on a web
  page; phones and tablets select only what asks for it. `editable` (a field) / `textAt` tell `pointerDown` (a drag there
  selects instead of panning a zoomable view) and `mousedown` (not prevented there); a mouse press elsewhere clears the selection,
  which the browser would not, since presses outside select nothing. Copying (`copyText`) writes the selected runs in
  DOM order, each followed by its line's break when its end is selected (`Run::after`, the run tuple's fifth element:
  a newline, or the spaces a wrap dropped) and a newline between texts: the browser would run the absolutely placed
  runs together.
- **Selection areas** (`SelectionArea`, `ViewProps::selection_area`): `op_vp` marks a view whose props have
  `selectionArea` `nsh-area`, and the browser's own selection spans its texts (handles and long presses on phones
  included). The area and everything in it is `user-select: text` in every idiom, inside views that take presses too,
  except texts set off (`selectable={false}`: `nsh-noselect`, set by `op_t`), images and videos; an area inside
  another is part of the outer one (`areaOf`). `textAt` takes the area's texts and `areaGap` its other places outside
  views that take presses, so `mousedown` is not prevented there and a drag may start between texts, as between a
  web page's paragraphs; pressables in the area keep their presses. Select all selects the whole area. Copying joins
  the area's texts on one row (their boxes overlap vertically: a table's cells) with a tab instead of a newline and
  leaves out attachments (U+FFFC), as `SelectionModel::text` does.
- **Elsewhere**: no page context menu or iOS callout outside fields and selectable text; a mouse drag selects only in
  selectable text and fields; overflow is `clip`, never `hidden`, so that the browser cannot scroll a box the core
  laid out to show a focused field.

## Fonts

`register_font` adds a `FontFace`, which loads asynchronously even from bytes: until it has, `measureText` measures
with a fallback font. When the faces settle, `nsh.js` calls `nsh_fonts_loaded`, which clears `WebTextEngine`'s caches
(the core's text engine is an `Rc` the app keeps) and `EngineControl::fonts_changed` (`Core::fonts_changed`: every
text is measured and laid out again, as after `register_font`). Faces registered while the app starts (its imports'
fonts, in `nsh_start`) keep the root hidden until they load (at most 3 s), so the first frame shows the right fonts.

## Scroll views: pull to refresh and zooming

A zoomable (`maximumZoomScale` above `minimumZoomScale`) or refreshable scroll view moves its children into a layer
(`ensureLayer`) that is translated (the pull, `centerContent`) and scaled (the zoom), so the core's frames stay the
unzoomed ones; the spacer that gives the browser its scroll range is the zoomed content size plus the pull. Offsets
reported to the core are the zoomed ones (as UIKit's), minus the pull (negative while pulled, as on the native
backends); zoom changes go to `nsh_zoom` (`EngineControl::zoom`) before the offset.

- **Pull to refresh** (vertical views with `onRefresh` or `refreshing`): past the top, a drag moves the content down
  at half speed over an 8-spoke spinner; released past 64 points it fires `onRefresh` and keeps 56 points for the
  turning spinner until `refreshing` turns false (the Linux and macOS backends' numbers). Only touches pull (mouse
  drags never scroll), through non-passive touch events on the view, since the browser scrolls touches itself: a move past the top is prevented while it can be, and a gesture the browser
  already scrolls stays the browser's.
- **Zooming**: a zoomable view is `touch-action: none` and pans touches (both axes, with a glide; the mouse does not
  drag it) and pinches itself, keeping
  the content point between the fingers between them (rubber band past the limits with `bouncesZoom`, a spring back
  after). Ctrl+wheel over it zooms around the pointer instead of pinching (Chromium and Firefox send touchpad pinches
  as that; a mouse notch is 1.25×), Safari's touchpad pinches come as `gesture*` events. `zoomTo` and `zoomScale` animate or jump with the
  content point to the middle. Canvases inside are drawn again at the zoomed resolution when a zoom ends (up to 4×).

Sticky list cells (`MountItem::StickyCells`) stick with the browser's `position: sticky`, in step with the compositor
as the scroll bar is; a shift set from `scroll` events would trail it by a frame. Each sits in a `.nsh-track`
(`op_sticky`, `placeTrack`) beside the other cells, in the list or its layer: a box from the cell's frame along its
range of travel, with no breadth across it, so it takes no pointer events, at `z-index: 5` above the other cells. The
list isolates that z-index (`nsh-sticky`): as natively, a sticky cell never covers the views after the list, such as a
bar the content scrolls under. The next sticky cell's track starts where it pushes the cell out, the last one's ends
with the content, and a cell no longer sticky goes back to its frame. Entering a track cancels any frame
animation already running on the cell, so its content coordinates cannot override the sticky insets. The cells of a
list in the scroll view's viewport (`viewport="parent"`) are in that list: their tracks go there, the list isolates
their z-index, and their insets add where the list is in the scroll view's content (`trackOrigin`, the frames
between them); the core bounds their travel by the list's end. A cell's animated offset (an animated
`stickyHeaderOffset` or sticky `top`) comes as the animator's `sticky-offset` output for the cell each frame
(`op_a`): it is kept on the cell (`_stickyOffset`) and added to the track's inset. Views clip with `overflow: clip`, which, unlike
`hidden`, makes no scroll container, so `position: sticky` reaches the scroll view through the list.

A smooth scroll of the core's (`scrollTo` with `animated`) in flight moves with a `ScrollBy` (`op_sb` retargets it),
as the native backends move theirs: setting `scrollTop` would stop the browser's smooth scroll. The user's wheel,
pointer, touch or key takes it over. The glides of the wheel and the keys are nsh's (`scrollSmoothly`, on animation
frames), and each frame writes the glide's offset: a `ScrollBy` moves the glide with the content, and `scrollTo` /
`scrollToEnd` stop it where it is (`stopGlide`) before they scroll, as the native backends interrupt theirs. The
scroll they stop ends with theirs (the browser's `scrollend`), or at once when they leave the view where it is.
The stationary check uses exact clamped offsets: fractional movement can reach another physical pixel. If a
fractional target instead rounds back to the current offset, a 200 ms quiet-period fallback ends the scroll;
scroll events postpone it, and the browser's `scrollend` cancels it.

## Platform services

- **Storage** (`nsh/storage`, `src/storage.rs`): `localStorage`, each entry under `nsh:<app id>:<key>`
  (`nsh_engine::local_storage_prefix`; the id `nsh.json` gives, which published sites, the dev host and Rust apps
  carry), so an app keeps its data wherever its page is and apps of one origin keep theirs apart. An app without an id
  (the demo player's, the playground's) keeps its entries under `nsh:<page directory>:<key>` (the directory of
  `document.baseURI`): apps run one after another on one such page share theirs. `nsh.js` wraps every call in try / catch (blocked
  storage, private mode, quota) and hands failures back as messages.
- **Alerts** (`AlertDialog`, both presentations) are drawn in the root: with the `desktop` idiom as the Linux and
  macOS backends' alerts (up to three buttons in a row, the last regular one the default), otherwise as iOS's alert
  and action sheet; their keys and focus are under Input. Only clicks pressed inside the dialog count: a tap's
  compatibility click, which lands after the press that opened it, must not dismiss it.
- **Toasts** (`Toast.show` from `nsh/android`, which the desktop backends also show) are a pill at the bottom of the
  root for 2 or 3.5 s, also read out through the live region `Command::Announce` writes into.
- **The clipboard**: `navigator.clipboard`, with a copy command as the fallback for writes. Reading (also for
  `hasText`, since browsers cannot tell without reading) needs a secure context and may ask the user.
- **Images**: `<img>` with `object-fit` (`center` is `scale-down`; SVG files too: the browser draws them, so the
  runtime links no SVG renderer and `tintColor`'s mask works on them as on bitmaps), `placeholder` as a second
  image until the load (faded over `fadeDuration`), `blurRadius` as a CSS blur, a failed image hidden
  (`Image.getSize` / `prefetch`: under Networking). `onProgress` is not reported.
- **Web views** are `<iframe>`s. HTML loads as `srcdoc` in a sandbox without `allow-same-origin` (an origin of its
  own: it cannot reach the player's page), after a bridge script (`webBridge`): the first message from the player
  carrying a random token hands it a `MessageChannel` port, over which `window.nsh.postMessage` reaches
  `onMessage` and `injectJavaScript` and `goBack` / `goForward` run; the page's own `message` listeners never see that
  message. The injected scripts are `<script>`s at the start and end (after a doctype). A URL loads as it is, keeping
  its origin unless it is the player's own (which must not reach it either); the browser hides what such a page
  does, so it only gets `postMessage` (`window.onmessage`) and load events with the URL it was given. `reload` loads
  the frame again. Navigations inside a frame are not checked against the `webview` capability (the core checks the
  source it is given).
- **Videos** are `<video>`s: `onLoadStart`, `onLoad` (`loadedmetadata`), `onProgress` on a timer at
  `progressUpdateInterval` while playing, `onBuffer` (`waiting` / `playing` / `canplay`), `onEnd`, `onError`; a
  deleted video is stopped (a detached media element plays on). Browsers only start a video with sound after a user
  gesture (a warning says so).
- **Registered native components** are the native apps' own: their view stays empty, with a warning once per name.
- **The host** (`nsh/host`): the page answers the app's calls with `createPlayer`'s `host` option, an object whose
  `call(name, args)` returns the result or a promise of it. `Command::HostCall` is the command `hostCall` (`encode.rs`;
  the id written whole, not rounded as `num` would), and `nsh.js` `hostCall` answers every one with `onHost`
  `{ type: "reply", id, ok, value?, error? }` (`EventPayload::Json`, `nsh_event`): `ok: false` with the error's message when the page has no host, `call` throws or
  its promise rejects, or the result is not JSON, since the app's call waits until it is answered. The page sends
  events with `player.hostEvent(event, payload)` (`onHost` `{ type: "event", event, payload }`; one `EventKind` for
  both keeps the kinds within `EventMask`'s 64 bits): the payload is serialized at once (a payload that is
  not JSON throws to the page, not inside a deferred engine call where it would drop the calls queued after it), and
  events sent before the app runs are queued and delivered in order right after `begin` starts it, so its top-level
  `host.on` listeners get them (no replay to listeners registered later); every `begin` queues again until the new app
  has started, and a start that throws (a trap) drops the queue and the events sent after it. `web/nsh.test.mjs`
  tests `hostCall` and this queue on a fake engine (`node --test crates/nsh-platform-web/web/nsh.test.mjs`).
  `Environment::host` is set when the player has a `host` (`nsh_environment`'s `host`, read at start only).
  `nsh package --target web` copies `nsh.json` `web.host` (a JS module relative to `nsh.json`, `package::WebConfig`; `package::web_host_module` requires it inside the app's
  directory once symbolic links are resolved, as `nsh test` does) as `host.<digest>.js`; the page imports it alongside the
  runtime and runs its `createHost(player)` once the player exists, before `run`, and its `host` option forwards to
  what that returns (no callable `call`: the page's "could not be loaded" error). The host module shares the page's
  CSP: an app restricting `network` gets a `connect-src` of `'self'`, its `capabilities.network` and `web.connect`
  (`package::WebConfig::connect`, host patterns checked as `HostPattern`s, which keeps any CSP syntax out:
  `web::page_connect`). `web.connect` is the page's alone: the core checks the app's requests against its
  capabilities before `fetch` sees them, so only the redirect hops CSP guards widen with it. The module is copied as it
  is: its own imports are absolute URLs.
  Headless `nsh test` runs the same module for each app a test opens (`nsh_testing` `page_host.rs`,
  `docs/dev/tooling.md` "Headless runs").

## Not implemented

Platform services other than the theme color, toasts, dialogs, the clipboard and the host; image download progress; a web
view's events and commands for pages of other sites (beyond `postMessage` and loads), user agents. A published app
ships no source map.
