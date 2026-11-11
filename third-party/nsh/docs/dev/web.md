# The web runtime (WebAssembly)

`crates/nsh-platform-web` runs NSH apps in a browser page, rendering to the DOM: apps published with `NSH package
--target web`, the web development host (`NSH run --target web`) and the website's live demos (`website/demos/*.tsx`).
`platform.os` is `"web"` (`Os::Web`).
User-facing page: `website/docs/web.md`.

## The browser's JavaScript engine

Every web runtime runs the app's TSX on the browser's own JavaScript engine: the module has no JS interpreter of
its own (no `nsh-js`, no QuickJS). The browser loads the app's ES modules; Wasm contains the Rust engine, reactive
graph, core, base components, layout and DOM backend. Native targets keep QuickJS.

`Player.runModule(entry, { appId, capabilities, chunks, imports, params })` returns a promise after the entry module
loads; `Player.runSource(code, { appId, capabilities, sourceMap, name })` does the same for a module given as
source text (a blob URL: development bundles, the playground). Either replaces the previous app. Each run has a
fresh same-origin iframe realm, preserving native module identity, cycles, top-level await and browser globals.
`params` (a JSON object) is the app's `host.params` (`nsh_set_host_params`, kept for the next start and given to its
engine's `HostChannel`); the packaged page passes the JSON of a `<script type="application/json" id="nsh-params">`
when the page has one, so a server that already has the first screen's data can hand it to the app with the page. `stop()` disposes Rust owners, outstanding bridge calls, callbacks, blob module URLs and the iframe. The iframe is
**not a security sandbox**: standalone code has the page origin's authority. Do not use it for untrusted plugins;
signed packages, hardening and VM limits are the native hosts' (`sandbox.md`).

| Artifact | Feature | Purpose |
|---|---|---|
| `nsh-browser.wasm` | `browser,linkable` | What `nsh package` links each published TSX app's runtime from; never served as it is |
| `play/nsh.wasm` | `browser` (the default) | The website's demos: every part |
| `nsh-dev.wasm` | `dev` | The development host: hot updates, `nsh test --target web` |
| `nsh-playground.wasm` | `compiler` | The playground: also compiles TSX in the page |

Without `browser-core` the module runs a Rust app only (`nsh_start_rust`, `rust_app!`).

Browser bindings live in `src/browser/` and `web/browser/`. Rust registry descriptions generate component,
class and module faces; the same core reactive graph and virtualized list machinery drive both hosts.
JS values cross through generation-checked arena handles. Weak tracing connects Rust-owned callbacks and
payloads to their JS peers; externally held Rust values remain strong. DOM child edges are traced separately,
so detached trees with callback cycles can be collected. Explicit owner disposal remains deterministic.
The tracing runs off the calls: an outermost entry promotes weakened values back only when some were demoted, and
the trace and the demotion run once the outermost call returned, at least 100ms apart and twenty times as long
after a run as it took (`Values.schedule`, `Values.collectDelay`), so a call costs the same however many values the
app holds and the accounting keeps to about a twentieth of the page's time. A string crosses in one call, encoded
straight into Rust's buffer; a row of a table crosses in one (`JsHost::primitives` / `primitive_entries`, op 49,
packed by `values.js` and read by `values.rs` `unpack`), and an object's keys in one (op 48).
Callbacks escaping a stopped run become inert; pending module and host calls reject on disposal.

Browser fetch, streams, WebCrypto, URL, timers and promises use browser implementations, including their
CORS, secure-context and permission rules; the browser knows no `asset:` scheme, so `fetch` of the app's files
(`asset:/`) goes through the engine's network in every session, which reads them as on the other platforms
(`web/browser/fetch.js`, `src/browser/fetch.rs`). Synchronous hash/compression APIs retain Rust implementations;
Buffer and POSIX path use pinned vendored implementations with licenses in `third_party/`. Mobile-only APIs
retain their off-platform behavior. In a test session on a manual clock (`nsh test --target web`), timers,
`Date`, `performance.now()`, animation frames and `fetch` go through the engine instead, so the test's clock and
routes control them (`web/browser/testing.js`, `web/browser/fetch.js`).

### Hot module replacement

A development bundle (`nsh-bundler` `HotBundle`) is an ES module that imports `nsh:hot` and defines each of the app's
modules as a CommonJS factory registered with `__nsh_hot`. `web/browser/hot.js` is the browser's `__nsh_hot`, with
the semantics of the native one (`nsh-js` `hot.rs`): an update script (`HotPatch::Update`) redefines the modules that
changed and runs them again with the importers that cannot take the change, in place; components keep stable
proxies, contexts and marked top-level signals keep their identity, and `mount` calls made again with the same
component keep what they mounted. `Player.hotUpdate(code)` imports the script in the app's realm and resolves to
false when it could not be applied (the page then runs the bundle that follows from scratch).

### Browser-host regression checks

Build `cargo build -p nsh-platform-web --target wasm32-unknown-unknown --no-default-features
--features browser-tests --profile web`, then run:

```sh
NSH_BROWSER_WASM=target/wasm32-unknown-unknown/web/nsh_platform_web.wasm node --expose-gc --test crates/nsh-platform-web/web/browser/*.test.mjs
python3 crates/nsh-platform-web/web/browser/browser-check.py --wasm target/wasm32-unknown-unknown/web/nsh_platform_web.wasm
```

The second command requires Python Playwright and its browser binaries. The website CI pins Playwright to
1.62.0; install that version in a virtual environment and run `python -m playwright install chromium firefox
webkit` (`--with-deps` also installs the engines' system dependencies on Linux).

The default is Chromium's complete suite; `--chrome PATH` overrides only its executable. To run the lifecycle
checks on each of the other engines with the same Wasm artifact:

```sh
python3 crates/nsh-platform-web/web/browser/browser-check.py --browser firefox --suite lifecycle --wasm target/wasm32-unknown-unknown/web/nsh_platform_web.wasm
python3 crates/nsh-platform-web/web/browser/browser-check.py --browser webkit --suite lifecycle --wasm target/wasm32-unknown-unknown/web/nsh_platform_web.wasm
```

`--suite lifecycle` checks `runModule`, `runSource`, namespace imports, `nativeExports` and development
factories using `nsh:hot`: startup must render text and respond to a host event. It verifies that a single
complete import map precedes the realm's first module script. It also checks queued host events and realm
identities, repeated start/stop, startup failures, cancellation/replacement during a held request or top-level
await, facade-loading failures, and cleanup errors with a reentrant reset. A fetched bootstrap with a syntax
error, a thrown exception or no initialization callback must reject startup, release its realm and allow a
replacement to start. A second HTTP origin serves the runtime with CORS headers to check CDN bootstrap
loading, execution errors and recovery. Each case has a fresh browser context and page; repeated
runs within a case reuse its Player. Request gates and explicit fixture events coordinate cancellation rather
than fixed delays. Assertions cover public promise outcomes, cleanup and a usable replacement, independently
of garbage-collection timing or whether a detached realm resumes its JavaScript continuation.

Chromium's `--suite interaction` checks every state style (`hoverStyle` / `activeStyle` under real mouse input,
`focusStyle` / `focusWithinStyle` under Tab), a list's `contentClass`, a scroll view's `contentStyle` /
`contentClass` (children inserted before and after its content container is made), platform props and tooltips.
`--suite all` combines the two suites. Firefox and WebKit select `lifecycle` explicitly. The website CI builds
Wasm once and runs Chromium `all`, Firefox `lifecycle` and WebKit `lifecycle` serially, reporting all engines
before failing the step.

Reports go to `.nsh/browser-tests/<browser>/` (`--artifacts DIR` changes the root): an engine summary records its
version and suite, and per-case JSON records the failing stage, fixture events, promise outcomes, console
messages, page errors and failed requests. Failed cases also save a screenshot and Playwright trace; CI uploads
the reports on failure. Unexpected errors fail the case; deliberate failures are matched to their own error
report and request URL. Engine launch failures remain failures in the summary. Playwright WebKit exercises its
bundled engine; device Safari testing and published-package testing have their own coverage.
`browser-tests` contains ownership fixtures: never measure or publish that artifact. Rebuild with `browser`
and use the supported `nsh package --target web` flow for shipping and size measurements.

The realm's `browser/bootstrap.js` is a generated classic script. Its factories execute inside the app's
iframe, preserving that realm's `Error`, `Promise` and typed-array identities without loading modules before
the import map. The source entry is `crates/nsh-bundler/examples/browser-bootstrap.js`, importing `scope.js`
and its dependencies. After changing those sources, regenerate with
`cargo run -p nsh-bundler --example browser_bootstrap`; CI runs the same command with `-- --check` to detect
stale output. Keep the generated file with the runtime sources so the CLI, documentation server and distributed
hosts share the same asset. Publishing minifies it and restores its strict directive after module-mode
compression, before hashing the directory. The classic bootstrap loads with anonymous CORS, as module
scripts do, so a CDN's execution errors retain their filename and thrown value. The CDN must allow the page's
origin, as for the app's other module and Wasm requests. Application modules remain ES modules.

`browser-check.py` also mounts a view with all four platform props and checks that only the web's and, in the
desktop idiom (Playwright's Chromium has a fine, hovering pointer, and the check's page is 1280 wide), the desktop's
apply.

Measure the supported CLI package with `node crates/nsh-platform-web/web/browser/package-size.mjs SITE
--require-browser`. It reports raw bytes, gzip level 9 and Brotli quality 11 independently for every Wasm,
JavaScript and bytecode file, including all optional chunks. `--requests=FILE` accepts a JSON array of URLs
observed during a cold navigation and separates initial code from optional code. Fonts, media and HTTP headers
are excluded and must be accounted for separately when discussing total page transfer. The website CI guards
Gallery's total compressed code at 4,000,000 Brotli bytes; this is a regression ceiling, not the original
1,000,000-byte product goal.

`browser-check.py` also gives a view a `tooltip` by a function, as a development bundle gives an app's component, and
checks under real hover that the element the function gives shows and follows it.

Run `python3 crates/nsh-platform-web/web/browser/packaged-check.py URL` against a served, freshly packaged
Gallery to exercise standard utilities/files/environment, lists, dialogs, form input, table virtualization,
animation, press events and editor input. Its report does not claim exhaustive API or device coverage.

## Building

`cargo xtask web` writes
`web/index.html` (the player), `nsh.wasm` (feature `browser`) with `nsh.js` and its `browser/` modules,
`nsh-playground.wasm` (feature `compiler`, built in `target/web-playground` so the two builds keep their caches;
huacnlee/cargo ignores the directory, keeps both builds apart itself and writes the file to `target/`),
compiles each demo with `nsh build --release` into the ES module `website/public/play/demos/<name>.js` (generated,
ignored by git), and publishes `examples/gallery` with `nsh package --target web` into `play/gallery/` (the website's
Gallery page frames it; packaging builds `nsh-browser.wasm`: `--target wasm32-unknown-unknown --profile web`, the release
profile optimized for size). Check the crate with `cargo clippy -p nsh-platform-web --target wasm32-unknown-unknown`: off
WebAssembly it is empty. `.cargo/config.toml` gives wasm32 an 8 MiB stack (deep component trees) and selects getrandom's custom entropy backend. The CLI passes that backend flag to generated Rust-app builds as well, retaining existing compiler flags.

The standard module `zlib` links zstd's C library, so the build needs a clang that targets wasm32 and an `llvm-ar` (CI: Ubuntu's `clang` and `llvm`, with
`AR_wasm32_unknown_unknown=llvm-ar`). Apple's clang has no WebAssembly target: on macOS point
`CC_wasm32_unknown_unknown` and `AR_wasm32_unknown_unknown` at an LLVM toolchain's `clang` and `llvm-ar` (Homebrew's
`llvm`, or the Android NDK's `toolchains/llvm/prebuilt/*/bin`).

## The CLI's web target

`crates/nsh-cli/src/web.rs`. The CLI finds the runtimes as it finds the others (`runtime::web`, `WebKind::Browser` /
`Dev`): `runtime/web/nsh-browser.wasm`, `nsh-dev.wasm`, `browser/` and `nsh.js` in the distribution (`cargo xtask dist` puts them there);
in a checkout it builds `nsh-platform-web` with `--profile web --target wasm32-unknown-unknown` whatever its own
profile (a debug build is several times larger and slower; `AR_wasm32_unknown_unknown` defaults to `llvm-ar`), with
`--no-default-features --features browser` for the published one and `--no-default-features --features dev` for the development host's, copies the result to `nsh-browser.wasm` / `nsh-dev.wasm` next to it (both
build to the same file) and takes `nsh.js` from the crate.

- **`nsh package --target web`** writes a static site. Every file but `index.html` and `manifest.webmanifest` is
  content-addressed (`<stem>.<10 hex digits of SHA-256>.<ext>`, `web::hashed_name`), so hosts cache them for good
  (`immutable`) and only the page is revalidated. The page (template `crates/nsh-cli/src/web/index.html`) imports the
  hashed `nsh.js`; a script in its head requests the wasm and entry fonts while the page
  is parsed (`fetches`, once each; not `<link rel=preload>`, see `pitfalls.md` "Web, browsers"), and the page passes
  `createPlayer` the wasm's response, `assets`
  (each `asset:/<path>` to its hashed URL: images and videos load from there on demand) and `readAsset` (the fonts'
  bytes: the engine reads fonts synchronously, `Assets::read`, to measure text with them). Fonts the entry or the UI
  sets register are fetched before the app starts; one only chunks register (`font("asset:/…")` in their code) comes
  with the first of them, through `createPlayer`'s `prepareChunk(id)`, which `nsh.js` awaits with the chunk's download
  (`web::font_loads`). With `nsh.json` `web.host` the page also imports `host.<digest>.js` and passes `createPlayer` a
  `host` (Platform services). It imports the bundle with `runModule(code, { capabilities, appId, chunks })`
  (`appId`: the `nsh.json` id, the page's `app.id`; a Rust app's root carries its own), without `limits`: a published
  app runs on its own, with none (`sandbox.md`); an app whose capabilities restrict `network`
  gets a CSP `connect-src` meta with `'self'` and explicit HTTP / WebSocket scheme, host and port sources
  (`web::connect_src`; GET rules also admit their mapped `ws` / `wss` transport, and a host without a port uses
  `host:*`), as the browser follows redirects before NSH could check them. Relative URLs resolve against the page
  (`document.baseURI`, `nsh_set_base_url`) as it starts: the page's script resolves its `app` URLs (and the head's
  requests are keyed the same way), the `Player` its `assets`, `data` and `assetBase` and the app's relative
  `asset()` URLs against `player.baseURL`, and `browser/runtime.js` the entry, the chunks and the app realm's
  `<base>`, so nothing loads from the directory a `history.pushState` moved the address to. `nsh.json` `web.base`
  (`web::page_base`: a path from the root
  in the form browsers send it, unreserved characters and percent-escapes without dot or empty segments, a `/`
  added at its end, which `start_at` matches requests against as it is) puts a `<base href>` first in the head, so the page loads its files at any of the app's paths
  (`/sports/football`), which `SiteServer::start_at` (`--run`) serves under it; the dev page has `<base href="/">`
  (the dev server serves its files at the root). `nsh.json` `web.history` reaches `createPlayer`'s `history` on
  both pages (the packaged page's `app.history`, the dev page's `HISTORY`, which `with_page_host` fills in); without
  it the player's default (`window.top === window`) holds. The app ships as minified ES modules
  (`app.<digest>.js` and `<chunk>.<digest>.js`). An import map resolves original chunk URLs to hashed files;
  transitive entry fonts load before startup and dynamic imports prepare the requested chunk's font dependencies.
  The browser loads static dependencies, module cycles and dynamic chunks itself. No bytecode or hardening
  bytecode ships in a browser package. An app with a Rust crate of
  its own gets a runtime of its own ("Apps with Rust components"). `--run` serves the directory with `nsh_dev::SiteServer` (the cache headers a CDN should send) and
  prints its address.
- **The development host** is a page the dev server serves (`DevServer::serve_web`: the page at `/`, `nsh.js`, its
  `browser/` modules and `nsh.wasm` next to it, with a wasm-bindgen glue and its snippets when the runtime has one,
  all `no-cache`), from
  `crates/nsh-cli/src/web/dev.html`. `nsh dev` serves it whenever a web
  runtime exists (`runtime::web(false)`), `nsh run --target web` builds one first and prints the page's address (the user opens it). The page
  speaks the dev protocol over the same port's WebSocket: its hello has platform `web` and an empty
  `bytecode_version` (the server then sends JS source, without the warning a mismatched version gets), it runs
  each development bundle with `player.runSource` and its message's `app_id` (the app's storage), applies patches with
  `player.hotUpdate` ("Hot module replacement"; when it resolves false, the bundle that follows loads from scratch),
  shows build errors and `CannotRun` over the app, sends the app's log lines back, and
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
  input's value, where a dialog's button is, where a text's characters are: each run knows its first character's
  offset). The input itself is the browser's trusted input, sent by the CLI.

### Runtimes linked for each app

A published app's runtime holds only what the app uses, and what only later screens use is downloaded apart
from it. `nsh package --target web` makes these modules from `nsh-browser.wasm` (feature `linkable`) without a
Rust toolchain or a linker; how is in the module docs of `crates/nsh-cli/src/web/`. A runtime wasm-bindgen ran on
(`crates/nsh-cli/src/bindgen.rs`) is published whole (`web::link`): wasm-bindgen rewrites the module and keeps the
`linking` and `reloc.*` sections of the one it read, which no longer describe it. A runtime with every
component (the website's, the development host's) serves every app.

What an app uses is `Bundle::native_use` (`natives.rs`, `native-pipeline.md`). A namespace import read only by
names the code spells (`import * as base from "nsh/base"; base.EmojiPicker`, the way an app reads an export
older shells lack without failing to link) counts those names: the runtime links their parts, and the page's
`nativeExports` declares them, so the host's facade for the module exports them and the namespace has them.
A namespace used any other way, including as a method call's receiver (`base.method()`), keeps every gate
and the full catalog (`web::whole_because` says why).

Each part of `nsh/base` (`nsh_base::parts::ALL`) reaches the runtime through its gate, `nsh_part_<name>`, which
`base_parts!` in `crates/nsh-platform-web/src/lib.rs` exports and `nsh.js` calls at instantiation; a part without
one is never registered, so an app importing its exports fails to link in the browser ("does not provide an export
named …"). The macro checks at compile time that it lists every part, so a new part of `nsh/base` adds its line
there.

### Historical QuickJS package sizes

The web ran QuickJS in WebAssembly until 2026-10; those measurements do not apply to the current runtimes.

The syntaxes code is highlighted with are a file of their own, `nsh-syntaxes.<digest>.bin`, fetched the first time a
`TextView` code block, an `Editor` or a `DiffView` highlights a language (`nsh_core::runtime_data`, the page's
`data`). `EmojiPicker`'s emoji are another, `nsh-emoji.<digest>.bin` (`emoji_picker/emoji.tsv`, 104 KB, 35 KB
gzipped), published only for an app whose runtime links the picker (the gate `nsh_part_emoji_picker`) and fetched by
its first picker; the dev host serves both. `nsh.js` is minified at package time (`nsh_bundler::minify_module`: local names mangled, property names
kept, since the mounter looks its `op_<name>` methods up by name); the dev host serves it as it is. Published sites
carry no source maps.

The website's demos are browser ES modules (`demos/<name>.js`, run with `runModule`; `astro dev` compiles one on
request, `website/src/lib/play-dev.js`) on `play/nsh.wasm`, the `browser` runtime. Only the playground has a second
wasm (`nsh-playground.wasm`, with the compiler).

## Size

`nsh.wasm` is downloaded before anything shows, so the `web` profile builds it for size (`opt-level = "z"`, fat LTO,
`panic = "abort"`, stripped). The app's JS runs on the browser's engine, so the module carries no interpreter. The
syntaxes are a
file the page fetches when code is first highlighted ("What a published app downloads"): 0.83 MB gzipped. The runtime carries no
declaration text (the documentation and TypeScript of the specs, which only make
`.nsh/types`: `docs/dev/tooling.md`): 69 KB, 20 KB with brotli.

### Current release size and attribution

Measure the packaged module, not a development build: `nsh-dev.wasm` also supports development and testing and
`nsh-playground.wasm` also compiles TSX. For attribution, build with names and a linker map (below) and demangle the
symbols; attribution under fat LTO is approximate, not additive savings from disabling a feature. The syntax data,
Unicode / HTML tables and compression / crypto code implement existing behavior (the `zlib` APIs reach the encoders),
so removing them changes the supported API.

### Reproducing and checking a budget

Build the CLI, then use the supported packaging path with identical profiles for both workloads:

```sh
cargo build -p nsh-cli
./target/debug/nsh package examples/counter --target web -o target/size/counter
./target/debug/nsh package examples/gallery --target web -o target/size/gallery
python3 scripts/wasm-size.py target/size/counter/Counter/nsh.*.wasm \
  --max-raw 14950000 --max-gzip 5150000 --max-brotli 3950000
python3 scripts/wasm-size.py target/size/gallery/Gallery/nsh.*.wasm \
  --max-raw 14950000 --max-gzip 5150000 --max-brotli 3950000
```

The script requires `brotli`, prints the module's SHA-256 and each size, and fails if any supplied budget is
exceeded. Without limits it reports only. These limits guard this full runtime on the measured toolchain; they
are regression ceilings, not the original 1 MB product goal. Reassess them explicitly when features or toolchains
change. Use fresh output directories so each glob selects exactly one module.

For attribution, keep names and request a linker map without changing dependency flags from the CLI build:

```sh
cargo rustc -p nsh-platform-web --profile web --no-default-features --features browser \
  --target wasm32-unknown-unknown \
  --config 'target.wasm32-unknown-unknown.rustflags=["--cfg", "getrandom_backend=\"custom\""]' \
  -- -C strip=none -C link-arg=--Map=target/web-size.map
wasm-objdump -h target/wasm32-unknown-unknown/web/nsh_platform_web.wasm
```

Use `llvm-cxxfilt` to demangle the map's symbols; deduplicate aliases by code offset. The named module includes
analysis-only sections and must not be used for transfer measurements. Measure the packaged file instead.
Compressed sizes are potential transfer sizes: the host must actually negotiate `Content-Encoding: gzip` or `br`.
The local `nsh package --run` static server sends raw bytes; a raw download does not become smaller just because a
Brotli size was reported. Verify response headers and transferred bytes on the intended host.

### Apps with Rust components

The prebuilt runtime serves the runtime's modules and `nsh/base`; an app with a Rust crate of its own (`nsh.json` `"rust"`,
`docs/dev/tooling.md`) gets one built with its set, as it gets its own native hosts. `runtime::web` asks the app
(`rust_app::RustApp::web`), whose generated workspace (`.nsh/rust`) has a member `web`: a `cdylib` of
`nsh-platform-web` and the app's crate whose code is `nsh_platform_web::ui_sets!(vec![nsh_base::registry(), app_set()])`. The macro exports `nsh_app_init`, which `nsh.js` calls right after instantiating the module (there is
no `main` to call `set_ui_sets` in a wasm module, nor a `dlsym` as Android's `ui_sets!` uses); a module without it
(the prebuilt runtime) serves `nsh/base`. The `nsh_*` exports come from `nsh-platform-web`'s rlib: a `cdylib`
exports its dependencies' `#[no_mangle]` functions. The release runtime builds with the same `web` profile as nsh's
`Cargo.toml`; the development one (`nsh run --target web`, built again on every change to the app's Rust code) with a
generated `web-dev` profile (`RustApp::web_dev_profile`): `dev`'s incremental builds without LTO, the app's crates at
`opt-level = 1`, the other crates at `"s"`, `panic = "abort"` and no debug assertions, so the page
behaves as a published one. A change to the app's crate then rebuilds that crate and links incrementally, where
`web`'s fat LTO over one codegen unit re-optimizes the whole module. The crate's `build.rs` passes the 8 MiB stack as
a link argument of its own (nsh's `.cargo/config.toml` may not apply where the app builds, and target-wide `rustflags`
would rebuild every dependency instead of sharing nsh's builds). The kinds build to
`target/wasm32-unknown-unknown/{web,web-dev}/nsh_app_<package>_web.wasm` and are copied to
`.nsh/rust/web-runtime/nsh.wasm` / `nsh-dev.wasm`, beside the syntaxes (`nsh-syntaxes.bin`, written again only
after the workspace's `Cargo.lock` changes, so a rebuild does not wait for `cargo metadata`); `nsh.js` is nsh's. Everything else (bundling, the
crate's assets, the dev server) already knows the set, from its description (`docs/dev/tooling.md`).

`web::ui_sets` (the sets the runtime serves, which `package` checks the app's imports against and the dev page sends
in its hello) are the command line's own (`crate::ui_sets`). The dev host's files include `nsh.version` (a digest of
`nsh.js` and the wasm), which `dev.html` also has inlined: a change of the app's Rust code ends the session, the app's
command line runs again with a new runtime (`rust_app::reexec`), and a page that reconnects and finds another version
reloads (one that finds none, a session still starting, connects again). Neither `nsh run --target web` nor
`nsh package --target web --run` opens a browser: they print the address.

A Rust app (`nsh.json` `"root"`: `rust_app::RootConfig`, its entry the `nsh.json`, `rust_app::is_root`) has no JS
at all: its member `rust-web` is `nsh-platform-web` **without the feature `browser-core`** (no browser host, the
engine without `js`) and `nsh_platform_web::rust_app!(sets, app_root())`, whose `nsh_app_init` also registers the
root (`set_root`); `app_root()` is generated from `"root"`, `"theme"` (compiled in with `include_str!`) and
`"appearance"` (`Root::appearance`). Its `sets` take `nsh/base`'s core part only
(`nsh_base::registry_of([parts::core])`, `RustApp::rust_web_sets`), not `nsh_base::registry()`: with no JS, nothing
makes a component by its registered name, the root makes each component by type (`nsh_base::select()`), which links
that component where it is used, and the set gives the theme's tokens and the built-in scroll bars. Registering every
part would link every component of `nsh/base` into the module. The page calls `player.runRust()` (`nsh_start_rust`)
instead of `runModule`:
the packaged page when `app.rust` is set (no `app.js`), the dev page (`{{rust}}`) once the dev server greets it; the
dev session publishes no bundles (`DevSession::rust_root`). The browser host's exports (`nsh_browser_*`) are
`cfg(feature = "browser-core")`. The runtime builds to
`nsh_app_<package>_rust_web.wasm`, copied to `.nsh/rust/web-runtime/nsh-rust.wasm`.

Rust code meant for the web too uses the engine's services rather than threads and the standard clock: `fetch`
(`nsh_core::element::fetch`, below), the executor's timers, `nsh_core::time`. `examples/gallery-rs` does. As a
Rust app (2026-11) its `nsh.wasm` is 9.15 MB (3.11 MB with `gzip -9`, 2.18 MB with brotli; 12.78 / 4.40 / 3.00 MB
while it registered every part of `nsh/base`; `examples/tasks-rs` 5.23 MB, 11.04 MB before): no browser host, which
a TSX entry needs.

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
`./snippets/` prefix in ES module specifiers only), minifies the glue, names it by its content
(`nsh-bindgen.<digest>.js`), preloads it (`<link rel="modulepreload">`) and passes it in `app.glue`.
`createPlayer`'s option `glue` (a URL against the page)
makes `Player.load` import it while the module compiles, check that it exports `__nsh_imports` and `__nsh_finalize`
(wasm-bindgen's own output fails there, with its URL), merge `__nsh_imports()` into the import object (NSH's own
`nsh` and `env` keys win), and call `__nsh_finalize(instance, module)` (its memory views, wasm-bindgen's externref
table) right after instantiating, before `nsh_app_init`. The glue keeps its state at module level, so each player
after the first imports it as `<url>?player=<n>` (`importGlue`): a module instance of its own, while the first keeps
the URL the page preloads. wasm-bindgen can import a snippet directly when its function needs no JS glue
(numeric arguments and results, for example). Its `__wbg_get_imports` table then uses the snippet's original path
as a module key, matching the Wasm binary. Publication keeps those keys unchanged while relocating the ES imports;
separate `inline_js` blocks keep their own modules.
`cargo test -p nsh-cli bindgen -- --ignored` runs the CLI on a real module
(`wasm_bindgen_runs_on_a_real_module`: a crate built for `wasm32-unknown-unknown` with the CLI's wasm-bindgen; it
needs the target, the CLI, the crates and Node.js). It instantiates the development and minified, relocated glue
with the processed Wasm and calls both direct numeric imports and string-converting imports.

The browser calls the glue's closures outside any `nsh_*` call (a WebSocket message), so a task they wake must make
the page pump: `LocalEngine::set_wake` hooks the engine's notifications to the `request_pump` import, which
`Player.requestPump` coalesces into one `nsh_pump`.

## What WebAssembly changes in the shared crates

- **No threads.** `nsh_engine::LocalEngine` drives the engine from the host's event loop: `pump()` handles what was
  sent through its `EngineControl`, runs timers and tasks, commits, and returns its next deadline. The threaded
  `Engine` and `LocalEngine` share `Driver` (setup, `deadline`, `handle`, `turn`, idle collection); `Engine` and the
  shared tokio runtime are `cfg(not(target_arch = "wasm32"))`.
- **No clock.** `std::time::Instant::now` panics on `wasm32-unknown-unknown`. Shared code uses
  `nsh_core::time::Instant` (std's elsewhere; `performance.now()` through the `nsh.now_ms` import there) and
  `nsh_core::time::unix_ms`. Rust components' `cx.timer()` returns `nsh_core::time::Sleep` there, whose wakers the
  driver fires (`next_timer`, `fire_timers`); `background` / `blocking` do not exist. Rust components' HTTP goes
  through the engine (`nsh_core::element::fetch`: `Action::Fetch`, `Core::take_fetches` / `fetch_event`, the engine's
  `Net` with `Requester::Task`), so it is the browser's `fetch` here (`net.rs`) and the platforms' stacks elsewhere,
  under the same capability checks as JS's.
- **Local time** is the browser's own: app code runs on its engine. Rust's default zone is the page's
  (`nsh.time_zone`: `timeZoneName`, `format/mod.rs` `local_zone_name`).
- `nsh-package` cannot generate keys there (no `getrandom`); verifying works.

## Standard modules in the browser

All eleven standard modules load in the web runtime (`zlib` and `crypto` with its features `std-zlib` and
`std-crypto`, on by default: 0.56 and 0.35 MB of the gzipped module, `js-modules.md`). Their synchronous hashing and
compression run in Rust in the module (`src/browser/standard.rs`); `buffer` and `path` are JS (`web/browser/`), and
cryptographic entropy comes from the browser's `crypto.getRandomValues`. The `path` module uses POSIX paths with virtual working directory `/`. NSH's URL classes retain their identity.

`filesystem.rs` implements `FileSystem` through the player's Origin Private File System bridge. Rust checks the app's file grants, normalizes paths relative to its configured data directory and enforces quotas before sending an operation. OPFS persists files in an app-specific namespace within the page's origin and requires a secure context. File modification time comes from browser metadata; unknown access/birth times and modes are zero. `rename` uses the browser handle's atomic `move` operation, reporting `ENOTSUP` when that operation is unavailable. OPFS entries are files and directories; `readlink` reports `EINVAL`.

`websocket.rs` implements the shared `WebSocketTransport` with browser WebSocket. Both the global constructor and the `websocket` module's `connect` use it, with HTTP capability checks, Rust queue/message/connection limits, deadlines and cancellation. The browser's WebSocket API has no flow control, so while the module's unread queue is full the task is paused (`WebSocketTask::pause`, `websocket_pause`) and `web/nsh.js` holds the socket's events in the page, in order, delivering them again as the app reads; the browser's `error` event carries no reason and rejects with `ERR_SOCKET_CLOSED`. Custom handshake headers report an explicit unsupported-option error. NSH checks the initial normalized URL; browser policy controls WebSocket redirects, mixed content and connection access. Native WebSocket handshakes reject redirects. Raw TCP and subprocess calls return typed platform errors; their modules and metadata exports still load.

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

`nsh.js` reports what the page knows with `nsh_environment(json)` before the app starts and whenever it changes (only
when the JSON differs): `idiom`, `locale` (`navigator.languages[0]`), `languages` (`navigator.languages`, the locale
first), `regional` (the locale's hour cycle and first day of the week from `Intl`, the rest the region's), `timeZone`
(`Intl.DateTimeFormat().resolvedOptions().timeZone`), `lifecycle` (`background` while `document.visibilityState` is
`hidden`, else `active` with the focus and `inactive` without), `rtl` (`<html dir>`, else the locale's script),
`reduceMotion`, `fontScale` (the root font size / 16), `pixelRatio`, `safeArea` (`env(safe-area-inset-*)` read through a
hidden probe element, clipped to the container) and `keyboard` (the container's part below `visualViewport`). The Rust
side keeps it (`PAGE`) for the next start; the appearance and the window keep their own calls (`nsh_set_dark`,
`nsh_resize`). Changes come from media query listeners, `languagechange`, `visibilitychange`, `focus` and `blur` (the
time zone is read again then: browsers report no change of it), `visualViewport`, `resize` and a mutation observer on
`<html dir lang>`.

The app's side, `browser/environment.js`, gets the engine's environment (`Host::set_environment`,
`src/browser/engine.rs`) and keeps one signal per part, written only when the part changed, as nsh-js's `env.rs`
does. Its accessors are grouped as `env.rs` declares them: the exports of `nsh/device` and `nsh/accessibility`, which
`nsh` serves and `runtime.js` also serves as namespaces of those names (`modules`), the same values in both.
`environment.test.mjs` checks them against `env.rs`: `nsh` has every one, each namespace exactly those its module
declares, so a part added to `env.rs` fails there rather than in apps.

The idiom is fixed at start, as `Environment::idiom` is everywhere: `desktop` for a fine, hovering pointer at
any width, as a narrow window on a native desktop (headless Chromium reports no pointer and measures as a tablet or phone unless launched
with a fine, hovering one, as `nsh test --target web` does), `pad` for a screen whose short side is at least 600, else
`phone`; the player's `idiom` option overrides it, and so does a test's setup (`TestEnvironment::idiom`: `open`'s
desktop `platform` starts the app in the desktop idiom at any width). `Environment::desktop()`
(desktop OS, the web in the desktop idiom, or the terminal idiom) decides `desktop={{…}}` props, `platform.select`'s `desktop` key,
`platform.desktop` and `platform.idiom` (`Environment::reported_idiom()`; the page's `browser/environment.js`
gets both from the engine's environment); `Os::is_desktop()` stays the desktop backends' OSes (`nsh/desktop`'s windows and menus). Like the
desktop backends, the web gives the core no header heights (`NO_NATIVE_HEADER`): a page's `header` slot is all
there is at its top. The browser's bars are the browser's: the web ignores `Command::StatusBar` (pages' and dialogs' `statusBar`).

## The protocol

Exports are `nsh_*` functions (`src/lib.rs`); imports are module `nsh` (`src/ffi.rs`). Every export that reaches
the engine pumps it and returns the next delay in milliseconds (-1: none), which `nsh.js` turns into a `setTimeout`.
The engine is not reentrant: `nsh.js` routes every call through `Player.call`, which defers calls made while a
batch is being applied (a batch arrives inside a wasm call). A trap (a panic, `panic = "abort"`) ends the call it
happened in with the engine's state still borrowed, so after one `Player.call` drops every call, the deferred ones
too: each would only panic again (`RefCell already borrowed`). The panic hook reports through its own import
(`report_panic`, not `report_error`), so the page knows before the trap: the overlay keeps that first report, and
what follows from any entry into the engine (the browser runtime's app code calls it outside `Player.call`) goes to
the console only (`web/nsh.test.mjs`). The page needs a reload to run again.

A commit becomes one batch (`src/encode.rs`) that `nsh.js` applies item by item, one `op_<name>` method per kind of
mount item. Views are absolutely positioned at the core's frames; borders are an overlay element so they never move
the content the core placed. A view of no size (`display: none` lays it out at none) is `nsh-empty`: it draws no border,
outline or shadow of its own, as on the native backends, which draw inside a view's bounds (a CSS border-box is never
smaller than its borders); its children still show. Native animation items stay in Rust (`src/animation.rs`); bound properties are applied
after each batch and each `requestAnimationFrame` tick (or a frame a deadline runs without one: "Animation" below).

Shader views (`["sh", id, layer]`) draw with one WebGL 2 context (`docs/dev/shaders.md`, "The web"); effects and
transitions (`["sht"]`, `["shi"]`, `["shn"]`) take pictures of the DOM with a 2D canvas (`paintTree`), and pages and
dialogs come and go through their shaders on an overlay (`shaderNav`): `docs/dev/shaders.md`, "On the web".

## Animation

What moves on the web follows the Linux backend (`nsh-platform-linux` `transition.rs`, `navigation.rs`), which was
measured against it frame by frame (`requestAnimationFrame` samplers of computed styles in headless Chromium):

- **Animated values** (`src/animation.rs`): the graph's clock is in seconds (`Graph::tick`), so `nsh_frame` divides the
  `requestAnimationFrame` time (ms) by 1000; passing milliseconds ended every `timing` / `spring` / `decay` on its
  first frame. Bound values are inline styles: a property bound no more (its view taken over by an element without
  the binding) is cleared from them with the next output (`["a", view, prop, ""]`), so the view shows its own style.
- **Without frames** (a hidden tab, and often an iframe out of view: browsers run no `requestAnimationFrame` there),
  what an animation ends still happens on time, as on macOS (`Surface::keep_deadline`). After each call into the
  engine that asked for a frame, `Player.keepDeadline` asks `nsh_deadline` when the graph next has an animation that
  ends by itself to end (`Animator::deadline`'s, in ms on `nsh_frame`'s clock) and keeps one timer at that time plus
  `LATE_MS` (50 ms); if no animation frame ran since it came due, the timer runs `nsh_frame` at the current time,
  which ends what ended (its `finished` reaches the app) and gives the next deadline. While frames come it does
  nothing; nothing waits for what only draws (an endless loop, a JS frame request). The page's own motions that end
  in an event have a timer beside their frames too: a page's slide or fade (`moveScreens`, whose Web Animation
  finishes only as the page renders: the spec's "update animations and send events" is a step of updating the
  rendering) and a page's or a dialog's shader (`shaderNav`) end at their duration plus `LATE_MS`, a dialog comes in
  without its two frames after `ENTER_LATE_MS` (`present`; its `onShow` and `onDismiss` are timers already), and a
  wheel's glide whose frames stopped ends where it was going (`scrollSmoothly`, then `onScrollEnd`). Browsers
  throttle a hidden page's timers (to about once a second, and less after minutes), which these ends can come as
  late as. Touch momentum, zoom and pull animations, which only input starts, go on when frames come back.
- **Style transitions** are CSS transitions of the properties `TransitionProps` names (outline included); the
  border overlay gets its own for border colors, widths and radii, since it draws the border. A text drawn in one
  color (`AttributedText::uniform_color`) has it on its element (`setTextColor`) and its runs' classes leave it out,
  so the runs `op_t` makes again inherit it and a change is a CSS transition of the element's `color`
  (`transition-colors`), from the color on screen; a text of several colors keeps them in its runs and changes at
  once, as does one that becomes one color (`web/text-browser.test.mjs`).
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

A split bundle's chunks (`native-pipeline.md`) are ES modules the browser imports itself: the app realm's import
map names each chunk's URL (`runModule(entry, { chunks })`), and `__nsh_import` (`web/browser/loader.js`) prepares a
chunk's fonts before importing it.

Text (`src/text.rs`) is broken into lines here, with widths and font metrics from the browser (canvas `measureText`
through imports, cached), and runs are drawn at the positions computed here so the baseline lands where layout put
it. Text with numeric variants (`tabular-nums`, ...) and color emoji are measured against what the DOM draws, since
canvas measures them differently. The CSS of runs (`src/text/css.rs`) and line breaking (`src/text/wrap.rs`, with
CJK punctuation's line start and end rules) depend on nothing of the browser and are tested on the host
(`tests/text`); `web/text-browser.test.mjs` checks measurements against what Chrome draws.

Each run is a span placed at its position. The characters a line broke at (the space a soft break ate, a hard
break's newline: a run's `after`) stand between the spans as text nodes (`Player.lineBreaks`), so a text's
`textContent` and its `aria-label` read as the text was written ("it now brings", never "it nowbrings"), which is
what search engines and screen readers get; beside absolutely placed spans that whitespace collapses and shows nothing.

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

`borderCurve: "continuous"` is a tripled class of `border-radius` and `corner-shape` that `nsh.js` makes from the
frame (`placeCorners`). A view that clips with such corners is marked `nsh-curve-clip`, a view whose style has a
backdrop filter `nsh-backdrop` (`op_s`, from its class's rule), and `.nsh-curve-clip:has(.nsh-backdrop)` takes
circular corners of the radius (`--nsh-round`): Chromium shows no backdrop filter inside a clip with `corner-shape`
corners (`pitfalls.md`, "Web, browsers").

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

Relative request URLs (`fetch("/api")`, `new Request("x")`) resolve against the page's `document.baseURI` as the
player started (`player.baseURL`), which `nsh.js` hands over once with `nsh_set_base_url`. The app's `fetch`, the
browser's own run in the app realm, resolves them against that realm's `<base>`, which is `player.baseURL` too; a
`fetch` in the page's own realm (the host module's) resolves against the page's address when it runs.
Native hosts have no base and keep rejecting relative URLs. `new URL("/x")` without a base throws,
as in browsers. Relative `<Image>` URLs resolve against `player.baseURL` too (`asset()`), so they load after the
address moved to another directory.

`Image.getSize` / `prefetch` (`Command::ImageInfo`) load an `Image` in the page and answer with `onImageInfo` on
the root; `<Image>` elements are `<img>` elements, loaded by the browser.

## Input

`autoComplete` reaches both `<input>` and `<textarea>` as HTML's `autocomplete` attribute.
`src/encode/input.rs` maps every `AutoFill` variant to its HTML token (`Password` to
`current-password`, `Birthdate` to `bday`, `Off` to `off`). `Default` leaves the attribute unset;
returning to it removes an earlier hint. The browser decides which autofill suggestions to offer.

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
  event goes on to the page around (an embedding page scrolls), unless it is over a dialog or an alert covering the
  window (`dialogs: "viewport"`). Ctrl + wheel (a touchpad's pinch) pinches the view
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
- **Keys** (`keyDown`), in this order: the app's shortcuts (`nsh`'s `keymap`: the mounted `MountItem::Keymap` stays in
  Rust, `nsh_key` matches a key on the spot with `Keymap::find` and `nsh_key_command` reports the binding.
  Its `f64` result preserves the full `u32` ID range, including Rust shortcuts and overlay Escape, apart from
  the `-1` (unmatched) and `-2` (held repeat) sentinels. Keys are passed as the character they type without
  modifiers, else the US layout's character of their `code`; `mod` was resolved by the browser's platform,
  `appleKeyboard` in the environment JSON); an open dialog (Escape presses its
  cancel button); a focused field (Escape leaves it); a custom context menu (Shift+F10 or the Menu key);
  selectable text with a selection (select all, in a selectable view the whole area; Escape); a focused
  pressable (Return presses it, Space when released); going back (Escape, Alt+Left, Cmd+[, BrowserBack); scrolling the
  scroll view around the focus or under the mouse (arrows by 40 points, Page Up / Down and Space by 0.875 of a page,
  Home / End).
  Context-menu keys are handled explicitly because Chromium on macOS does not emit `contextmenu` for them.
  A handled key prevents the browser default to avoid duplicate openings; native fields and selectable text
  retain their own menus, and keyboard requests carry no pointer and use the trigger's bottom-start corner.
- **Focus**: the stops `ViewProps::focus_stop` decides are focusable (`tabindex=0`; `updateFocusable`): pressables
  (role `button` unless they have one) unless `focusable={false}`, and `focusable={true}` views whether or not they take
  presses (Return and Space press only pressables), never disabled or hidden ones (a focused one that stops being a
  stop is blurred), so Tab and Shift+Tab reach them in DOM order, but for a scroll view's content and a list's cells in its parent's viewport (`ViewProps::screen_order`,
  `screenOrder`): where the browser takes
  `reading-flow` (Chromium), it is read in the order it is on screen (`orderReading`: `reading-order` on its children,
  the DOM, which is also their paint order, left alone), as a list's recycled cells are not in their rows' order in it; `focus:` states follow the keyboard focus (`focus-visible:` while it shows, as the browser's `:focus-visible`), and
  they are all that shows it: as the desktop backends, the runtime draws no ring of its own; a popped page gives the focus back to what had it when the page was pushed
  (`screenGone`). A click never moves the focus (`mousedown` is prevented outside fields, selectable
  text, selectable views and hosted pages), as in native apps; it focuses the app's window in an iframe. A touch moves
  the focus as the browser does (a tap outside a field closes the keyboard), unless its press made the app focus a field
  (an editor's text): the mouse events the browser makes of the touch then leave the focus in the field (`mouseDown`,
  `pressFocus`), so the keyboard stays open. The views under the newest
  `Dialog` or alert are `inert`; the focus one took comes back when it closes.
- **Accessibility**: `op_vp` sets ARIA from the accessibility props (roles mapped by `ARIA_ROLES`, `aria-disabled`,
  `-selected`, `-checked`, `-busy`, `-expanded`, `-value*`, `-live`, `-hidden`, the hint as `aria-description`);
  `Command::Announce` writes into a polite live region, `Command::AccessibilityFocus` focuses the view.
- **Going back** (`back`) is decided from what is mounted, as on Android and the desktops: a stack inside the newest
  dialog pops, else the dialog gets the close attempt (`onCancel`, reason `"cancel"`) and closes natively when
  `closeOnEscape` (the default), reporting `onOpenChange({ open: false, reason: "cancel" })` and `onClose`; without a dialog the root's
  `onBackPress` hears it when the app listens, else the innermost stack's top page gets `onBackPress` when it listens
  and pops unless its `popOnBack` is false (`goBack`). `Command::Back` goes back as without the app's listeners.
- **Dialogs** (`Dialog`) are children of the root above the app's views (`present` / `dismiss`), transparent layers
  covering the root with its safe area, whatever their `presentation` (`placeModal`; the core's frames are ignored,
  it lays the dialog out at the size `nsh_root_size` reports): only the app's popup and backdrop show, which the
  runtime renders in it. `slide` moves the dialog up from below the root's bottom edge (a fade with reduced motion),
  `fade` fades it; `onOpen` follows the transition. A dialog the app removes leaves the same way, then reports
  `onClose`.
- **Dialogs over the window** (`createPlayer`'s `dialogs: "viewport"`, `viewportDialogs`): dialogs, sheets and alerts cover
  the whole window, as iOS and Android present them from an app that embeds NSH in part of its screen. Each stays
  where it is in the root, so its events, focus, `inert` and history are as above, and is a manual popover in the
  browser's top layer (`raise`): above the page whatever the stacking contexts, transforms and clipping around the
  container, newer ones above older ones (alerts are raised again over a dialog presented after them).
  `.nsh-viewport` undoes the popover's own box and fills the window without its scroll bars: that size is the one
  reported, with the window's safe area, and a `ResizeObserver` follows it (a page's scroll bar coming or going
  changes it without a `resize`); `slide` starts below the window's bottom edge. Its views are a root view in the
  window's coordinates, where the core places their overlays, so pointer positions on them (`pagePosition`, the
  responder system's `pageX`) are the window's (`windowLayer`, `origin`; a pointer keeps the coordinates of the root
  view it went down on). A wheel over it that nothing in it scrolls is prevented: the page does not scroll under it.
  The layer has a blocking `wheel` listener of its own for that (`raise`): Chrome waits for the root's only over the
  root's box and scrolls the page under the rest of the layer at once, its `wheel` event no longer cancelable.
  Without popovers (before Chrome 114, Safari 17 and Firefox 125) they stay over the container, with a warning. The
  page around is inert and its scrolling is locked until the last viewport layer closes. The app's window
  (`windowSize()`) and `env(keyboard-inset-height)` stay the container's.
  In an iframe the player elevates the iframe itself to a manual popover in its host document, preserving
  its DOM and running engine. It pins the app at its original size and scaled position while the modal root
  fills the enlarged iframe. When the host shows the iframe scaled (the website's phone and desktop frames), each
  layer keeps the app's scale (`scaleLayer`): it is laid out at the window's size divided by that scale and drawn
  with CSS `scale`, so a dialog is as large as in the app; its safe area and pointer positions are divided by the
  scale too (`layerScale`, `corner`). The lifted iframe takes its document's color scheme (`usedColorScheme`,
  sent with the request): a browser paints an iframe whose scheme differs from its document's opaque. Same-origin ancestor frames are elevated together; a cross-origin immediate
  host registers `hostPlayerFrame(iframe)` and accepts requests only from that frame's window through a
  transferred MessagePort. Install this host before loading the player. The last layer's removal, stop,
  navigation or frame removal releases the host's size, focus, inert state and scroll lock. A host that
  itself crosses another origin needs that outer embedder's cooperation; it cannot bypass that boundary.
  `Sheet` uses a web modal root around its existing overlays, with its own animation and close lifecycle.
  The documentation player enables viewport dialogs, so the website's iframe demos use this path.
- **History**: when the app is the page (`window.top === window`, or `createPlayer`'s `history` option) every page
  above a stack's first and every dialog is a history entry (`pushState`, state `{ nsh: depth }`), so the browser's
  back button and the mouse's go back in the app; entries the app takes away itself are gone back over with
  `history.go`, whose `popstate` is ignored, and a back the app refuses gets its entry again; a new `run` goes back
  to the first entry. Entries carry the page load's id (`nshSession`): a reload keeps the earlier load's entries,
  which going back passes over (`history.back()` again) as if the app had been left from its first page. In an
  iframe (the website's demos) the app pushes nothing: each entry would be one of the embedding page's history.
  Only shown stacks count, for the entries and for what going back acts on (`stackShown`: in the tree, visible, and
  laid out with a size, since `display: none`, a tab not selected, is laid out by the core at zero size, which
  `checkVisibility` does not see: the rule of `nsh_core::navigation::shown_in_layout`, which every backend asks); a
  stack's frame becoming empty or not (`op_f`) syncs the entries again (a view around a stack of its own size
  becoming empty does not: the entries follow at the next push, pop or back).
- **Addresses**: the core keeps the app's one address in an `AppUrlCell` (`url_scheme.rs`), which the engine shares
  with every VM's `System` (`Core::app_url_cell`, `SystemConfig::app_url`): `UrlScheme.url()` reads it as it is, and
  `setUrl` writes it at once, and again when the core takes the call (`SetAppUrl`), in order with the page's address the
  core took since; the core then sends the web's history entry. Rust's `app_url()` / `set_app_url()` are the same
  address; where the app is the page `set_app_url` resolves a URL against the page's base (the root `onUrlScheme`
  event's `base`, kept in the cell) and refuses another origin (`resolve_on_page`, and the core again), as `browser/address.js` does for TS (which checks
  the raw string as `check_address` does before resolving, in the app's realm). `setUrl` / `set_app_url` reach the
  root as `Command::SetAppUrl` on the web, and `setPageUrl` keeps the URL in `pageUrl` when the app is the page.
  `syncHistory` applies it last, with `history.replaceState(history.state, "", url)`, after pushing the entries of
  the turn's pages, so the address lands on the new top entry; while a `history.go` of its own is in flight
  (`ignoredPops`) it waits, and when the last ignored `popstate` lands the waiting address goes to the entry, or the
  core takes the entry's (`tellAddress`). A `replaceState` that throws shows the error. A new `run` clears `pageUrl`.
  The player keeps the address of the app's first entry (`firstUrl`), where every run starts, and hands it to the
  runtime before the app starts (`nsh_set_page_url`), which gives it to the core as the root's `onUrlScheme` event
  `{ url, page: true, quiet: true, base }` from `LocalEngine::start_with`'s `setup`, before the app's code runs; the engine applies root `UrlScheme` events
  queued before its thread starts (`Engine::start_with`) before the bundle evaluates, which is how the native
  backends hand the link that launched the app. `open` is a link the app is handed from outside: a back the app
  followed sends the entry's address quietly (the stack went back already; an `open` would push a page opened at a
  deep link again), unless the app's `onChange` set the address during the pops (a pop with no motion, a modal). A
  forward to a screen the stack no longer has, and an entry of an earlier load (another `nshSession`, which becomes
  the app's first, in a new session, so this load's later entries count as earlier ones), come as `open` with the
  entry's address; an app that shows nothing for a forward goes back where it
  was (`syncHistory`). A back the app refused (`popOnBack={false}`, `onBackPress`) sends nothing: the entries come
  again, and when no page went the top one gets the address it showed (`shownUrl`). `page` events are checked as
  `http(s)` URLs (`check_page_url`) instead of against the app's schemes, and every address the app sets by
  `check_address` (length, no whitespace), where it calls.
- **Address moves the app did not make** (`UrlScheme.on("change")`): each entry's state also has its place among this
  load's entries (`nshIndex`), and the player mirrors each entry's depth (`historyIndex`, `historyDepths`), so a back
  of the app's own goes to the newest earlier entry at most as deep (`entryAtDepth`) and a `popstate` knows which way
  the user went. The root's `onUrlScheme` event with `change: "back" | "forward" | "address"` (`url_scheme::CHANGE`,
  `AppUrlChangeReason`; another reason is the address alone, quietly) sets the address and queues an `AppUrlChange` for
  `next_app_url_change()`, at most 16, and only once something listened (`hears_changes`: before it the address has
  them); the TS module posts each to the listeners there are and keeps none. The player sends it for a traversal
  between entries of one depth (`tellAddress(reason)`), for a `#fragment` the user typed (a state-less entry of the
  page whose address is not the one shown: it gets this session's state at the depth shown and the next index, and the
  app's pages stay; before, it sent the app back to its start. Where the browser has the Navigation API, a state-less
  entry before the app's first (`historyBase`, `beforeFirstEntry`) is the page's own, from before the player, and a
  back onto it is a back past the first entry), and for a back that popped pages when the entry's
  address is not the one the app showed and the app set none as it answered: the player waits until the pages it
  popped are dismissed (`dismissing`, `goBack`) and the app had a turn after their `onDismiss`, at most
  `POP_ANSWER_MS` (1.5 s; a page's `onDismiss` follows its slide, `settlePop`). A forward to a depth the stack lost
  stays `open`.
- **Pushed addresses** (`setUrl(url, { history: "push" })`, `set_app_url_with(url, HistoryBehavior::Push)`): the core
  sends the web root `Command::PushAppUrl` (`pushAppUrl`) instead of `SetAppUrl`, and `setPageUrl` marks the waiting
  address a push (`pageUrlPush`; in one turn the last address wins and a push wins over a replace). `syncHistory`
  pushes it as an entry of its own (`pushEntry(depth, url)`, which drops the mirror's forward entries as the browser
  drops its own) when the turn pushed no page's entry (else the address goes on the new top entry, as a replace) and
  it is not the landed entry's address; a turn that popped pages pushes it once its `history.go` lands. A new run
  drops a push waiting (`resetHistory`). `browser/address.js` hands the options to the core as they are; the core
  reads them (`SetUrlOptions`), and a `history` of another value is a `TypeError`. The other platforms keep the URL.
- **Text selection**: text is selectable when `selectable` is true (`userSelect: "text"`; `nsh-selectable`), and with the desktop idiom also
  when it is unset (`null` in the `t` item: `nsh-autoselect`, selectable under `.nsh-desktop`) unless a view around it,
  or the text itself, takes presses, touches, pans or pinches (`nsh-press`, set in `updateTouchAction`), as on a web
  page; phones and tablets select only what asks for it. `editable` (a field) / `textAt` tell `pointerDown` (a drag there
  selects instead of panning a zoomable view) and `mousedown` (not prevented there); a mouse press elsewhere clears the selection,
  which the browser would not, since presses outside select nothing. Copying (`copyText`) writes the selected runs in
  DOM order, each followed by its line's break when its end is selected (`Run::after`, the run tuple's fifth element:
  a newline, or the spaces a wrap dropped) and a newline between texts: the browser would run the absolutely placed
  runs together.
- **Selectable views** (`<View selectable>`, `ViewProps::selectable_view`): `op_vp` marks a view whose props have
  `selectableView` `nsh-area`, and the browser's own selection spans its texts (handles and long presses on phones
  included). The area and everything in it is `user-select: text` in every idiom, inside views that take presses too,
  except texts set off (`userSelect: "none"`: `nsh-noselect`, set by `op_t`), images and videos; an area inside
  another is part of the outer one (`areaOf`). `textAt` takes the area's texts and `areaGap` its other places outside
  views that take presses, so `mousedown` is not prevented there and a drag may start between texts, as between a
  web page's paragraphs; pressables in the area keep their presses. Select all selects the whole area. Copying joins
  the area's texts on one row (their boxes overlap vertically: a table's cells) with a tab instead of a newline, joins
  a text whose props have `continuesText` (`ViewProps::continues_text`: a wrapped line's later part) to the one
  before it with nothing, and leaves out attachments (U+FFFC), as `SelectionModel::text` does.
- **Elsewhere**: no page context menu or iOS callout outside fields and selectable text; a mouse drag selects only in
  selectable text and fields; overflow is `clip`, never `hidden`, so that the browser cannot scroll a box the core
  laid out to show a focused field.

## Fonts

`register_font` adds a `FontFace`, which loads asynchronously even from bytes: until it has, `measureText` measures
with a fallback font. When the faces settle, `nsh.js` calls `nsh_fonts_loaded`, which clears `WebTextEngine`'s caches
(the core's text engine is an `Rc` the app keeps) and `EngineControl::fonts_changed` (`Core::fonts_changed`: every
text is measured and laid out again, as after `register_font`). Faces registered while the app starts (its imports'
fonts, while its entry loads) keep the root hidden until they load (at most 3 s), so the first frame shows the right fonts.

## Scroll views: pull to refresh and zooming

A zoomable (`maximumZoomScale` above `minimumZoomScale`) or refreshable scroll view moves its children into a layer
(`ensureLayer`) that is translated (the pull, `centerContent`) and scaled (the zoom), so the core's frames stay the
unzoomed ones; the spacer that gives the browser its scroll range is the zoomed content size plus the pull. Offsets
reported to the core are the zoomed ones (as UIKit's), minus the pull (negative while pulled, as on the native
backends); zoom changes go to `nsh_zoom` (`EngineControl::zoom`) before the offset.

- **Pull to refresh** (vertical views with `onRefresh` or `refreshing`): past the top, a drag moves the content down
  at half speed over an 8-spoke spinner; released past 64 points it fires `onRefresh` and keeps 56 points for the
  turning spinner until `refreshing` turns false (the Linux and macOS backends' numbers). With the app's own indicator
  (`refreshIndicator`) there is no spinner, and its height is where a pull refreshes and the room kept. Each change of
  the pull goes to `nsh_pull` (`pullValue`). Only touches pull (mouse
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

Pixel-mode wheel events follow the device's deltas directly, including its inertia. Line- and page-mode wheels
and keyboard commands glide on animation frames. Changing from a glide to direct input continues from the sampled
position, so an unfinished target cannot cause a catch-up jump.

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

- **Storage** (`nsh`'s `Storage`, `src/storage.rs`): `localStorage`, each entry under `nsh:<app id>:<key>`
  (`nsh_engine::local_storage_prefix`; the id `nsh.json` gives, which published sites, the dev host and Rust apps
  carry), so an app keeps its data wherever its page is and apps of one origin keep theirs apart. An app without an id
  (the demo player's, the playground's) keeps its entries under `nsh:<page directory>:<key>` (the directory of
  `document.baseURI`): apps run one after another on one such page share theirs. `nsh.js` wraps every call in try / catch (blocked
  storage, private mode, quota) and hands failures back as messages.
- **Alerts** (`AlertDialog`, both presentations) are drawn in the root (over the whole window with `dialogs:
  "viewport"`, as dialogs are: under Input): with the `desktop` idiom as the Linux and
  macOS backends' alerts (up to three buttons in a row, the last regular one the default), otherwise as iOS's alert
  and action sheet; their keys and focus are under Input. Only clicks pressed inside the dialog count: a tap's
  compatibility click, which lands after the press that opened it, must not dismiss it.
- **The clipboard**: `navigator.clipboard`, with a copy command as the fallback for writes. Reading (also for
  `hasText`, since browsers cannot tell without reading) needs a secure context and may ask the user. An image read
  is the first image item as a `data:` URI the player encodes itself; the core measures it against
  `MAX_IMAGE_BYTES` (`readImage` rejects with `ERR_NSH_QUOTA_EXCEEDED` past it). An image written goes on the
  clipboard as a PNG, the image format browsers write: another format is decoded and encoded again (pitfalls.md
  "Web, browsers"), and also goes on as it is, as browsers' own Copy Image does: an `<img>` of it as `text/html`
  (what a paste's `html` carries, `onPaste`) and, in Chromium, the web custom format `web <type>`, which an image read
  takes before the PNG, so a GIF read back keeps its frames. A write that fails is a console warning; `writeImage` has resolved already.
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
- **The host** (`nsh`'s `host`): the page answers the app's calls with `createPlayer`'s `host` option, an object whose
  `call(name, args)` returns the result or a promise of it. `Command::HostCall` is the command `hostCall` (`encode.rs`;
  the id written whole, not rounded as `num` would), and `nsh.js` `hostCall` answers every one with `onHost`
  `{ type: "reply", id, ok, value?, error? }` (`EventPayload::Json`, `nsh_event`): `ok: false` with the error's message when the page has no host, `call` throws or
  its promise rejects, or the result is not JSON, since the app's call waits until it is answered; the app's call
  rejects with that message and `code` `ERR_NSH_HOST_ERROR` (`nsh_core::host_channel::host_error`). A page without a
  host sets the environment's `host` to `false`, so the core rejects the calls first, with
  `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. A `host.post` without the native SDK channel (`browser/host.js`) goes to the
  platform module's `post` (`nsh-core` `runtime/host.rs`), which checks the name and grant in Rust and throws
  synchronously, then the core sends `Command::HostPost` (command `hostPost`) where the environment has a host;
  `nsh.js` `hostPost` hands it to the host's `post`, or its `call` without one, and drops the result and any failure.
  The page sends
  events with `player.hostEvent(event, payload)` (`onHost` `{ type: "event", event, payload }`; one `EventKind` for
  both keeps the kinds within `EventMask`'s 64 bits): the payload is serialized at once (a payload that is
  not JSON throws to the page, not inside a deferred engine call where it would drop the calls queued after it), and
  events sent before the app runs are queued and delivered in order right after `begin` starts it, so its top-level
  `host.on` listeners get them (no replay to listeners registered later); every `begin` queues again until the new app
  has started, and a start that throws (a trap) drops the queue and the events sent after it. `web/nsh.test.mjs`
  tests `hostCall`, `hostPost` and this queue on a fake engine (`node --test crates/nsh-platform-web/web/nsh.test.mjs`).
  `Environment::host` is set when the player has a `host` (`nsh_environment`'s `host`, read at start only).
  `nsh package --target web` copies `nsh.json` `web.host` (a JS module relative to `nsh.json`, `package::WebConfig`; `package::web_host_module` requires it inside the app's
  directory once symbolic links are resolved, as `nsh test` does) as `host.<digest>.js`; the page imports it alongside the
  runtime and runs its `createHost(player)` once the player exists, before `run`, and its `host` option forwards to
  what that returns (no callable `call`: the page's "could not be loaded" error). The host module shares the page's
  CSP: an app restricting `network` gets a `connect-src` of `'self'`, the origin of `--asset-url`, its `capabilities.network` and `web.connect`
  (`package::WebConfig::connect`, host patterns checked as `HostPattern`s, which keeps any CSP syntax out:
  `web::page_connect`). `web.connect` is the page's alone: the core checks the app's requests against its
  capabilities before `fetch` sees them, so only the redirect hops CSP guards widen with it. The module is copied as it
  is: its own imports are absolute URLs.
  Headless `nsh test` runs the same module for each app a test opens (`nsh_testing` `page_host.rs`,
  `docs/dev/tooling.md` "Headless runs").

## Search engines

A site published with `nsh package --target web` can be read by search engines and link previews as server-rendered
HTML is: its views carry the document's structure, its pages are URLs, and its head says what each page is.
Prerendering (writing each URL's first screen as static HTML ahead of time, or on demand as incremental static
regeneration does) is a tool of the site's own beside NSH; `examples/seo-site` is one (`server.mjs`, `render.mjs`).

**Document elements.** `nsh.js` `elementTag` picks the HTML element a view or text is drawn as from its props
(`encode.rs` `props_json`): `role="header"` is `h1` to `h6` by `accessibilityLevel` (`h2` without one, ARIA's
default), `role="link"` with an `href` (`ViewProps::href`, which `nsh-base`'s `Link` sets) is `a`, and
`web={{ element }}` (`Prop::WebElement`, `ViewProps::web_element`, the `WebElement` enum) names what `role` cannot
say (`p`, `nav`, `article`, `time`, ...) and wins over the role. `retag` replaces the view's element by one of that
tag, carrying its attributes, children and fields and taking its place in `views`; views whose element is a control
of its own (images, scroll views, canvases, inputs) keep theirs. A fixed rule of the runtime's stylesheet takes the
browser's margins, fonts, colors, underlines and list markers off those tags, so the view looks as a `div` does. A
link gets `href` and is not draggable; a plain click on it stays the app's (`Link`'s press; the root's `click`
listener prevents the browser's navigation), a click with a modifier key or the middle button opens `href` as the
browser does, and a context menu on it is the browser's (open in a new tab, copy the link) unless the link or a view
in it listens for `onContextMenu` (`contextMenu`, where the runtime otherwise prevents the browser's menu). The other
backends store `web_element` and draw nothing differently.

**The page's head.** `nsh/web` is a native module like the platform modules (`nsh_core::js::NATIVE_MODULES`): the
QuickJS hosts serve `nsh-js`'s `web_page.rs` (`Head` renders nothing), the browser runtime its
own (`web/browser/page.js`, made per app by `runtime.js` and set as the `nsh/web` namespace). `page.js` runs in the
page's realm (the app runs in its iframe's) and writes the page's real `<head>`: each mounted `Head` is an entry in
mount order, an effect keeps its props current, and one microtask after any change the entries are merged (the later
one wins key by key, `meta` by `name` / `property`), the elements the heads made (`data-nsh-head`) are written again,
and `document.title` / `<html lang>` fall back to what the page had before. A `canonical` path starts at the site's
base (the directory `document.baseURI` names), as a linked stack's paths do. `page.test.mjs` tests the merging.

## Not implemented

Platform services other than the theme color, dialogs, the clipboard and the host; image download progress; a web
view's events and commands for pages of other sites (beyond `postMessage` and loads), user agents. A published app
ships no source map.
