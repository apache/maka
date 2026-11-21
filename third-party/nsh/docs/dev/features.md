# Cargo features of the runtimes

The large optional parts of a native runtime are Cargo features of the platform crates (`nsh-platform-linux`,
`-macos`, `-windows`, `-ios`, `-android`, `-gpui`) and the app runners (`nsh-*-app`). `websocket` and `updater` are also features of `nsh-core`, `nsh-engine` and `nsh-platform-tui`. All are on by default, and `dev` turns all on.

| Feature | What it links | Off |
| --- | --- | --- |
| `shader` | naga, wgpu | Shader views draw nothing, shader transitions end at once ([shaders.md](shaders.md)) |
| `editor` | `Editor`, `DiffView`, ropey, imara-diff | Importing them fails |
| `rich-editor` | `RichEditor` and its classes | Importing them fails |
| `plot` | `nsh/base/plot` | Importing it fails |
| `term` | `Terminal`, vte | Importing it fails |
| `highlight` | syntect and its syntaxes | Code shows plain |
| `math` | RaTeX, the KaTeX fonts | A formula shows as its TeX, or as the app's `renderMath` |
| `zlib` | the JS module `zlib` (implies `js`) | Importing it fails |
| `crypto` | the JS module `crypto`, Web Crypto's globals (implies `js`) | Importing it fails |
| `websocket` | the native WebSocket client: tokio-tungstenite, rustls, the platform verifier (webpki-roots on Android) | `connect` of `websocket` rejects with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` |
| `updater` | `nsh/updater`'s checks, downloads and installs (nsh-updater) | `checkForUpdate` and `checkForPackage` find none; downloads and installs reject |
| `net` | ureq and rustls: `fetch` and remote images (Linux, Windows, TUI, GPUI; macOS, iOS and Android use the system's HTTP) | `fetch` rejects; `<Image>` shows files, assets and inline data only |
| `sound` | GStreamer (Linux only: `nsh-platform-linux`, `nsh-linux-app`; the other platforms play sounds with the system's audio) | `Sound.load` rejects with `not-supported`, naming the feature; `AudioPlayer` and `Video` play as before, through GTK |
| `webview` | WebKitGTK (Linux), WebView2 (Windows) | A web view fails at once, as on a platform that shows none |
| `media` | Media Foundation and XAudio2 (Windows only: `nsh-platform-windows`, `nsh-windows-app`) | A `Video` shows nothing; `Sound.load` and `AudioPlayer` fail with `not-supported`, naming the feature |

SVG images (resvg, usvg, tiny-skia) are not optional: every native platform crate links them. Turning them off
compiled fine and silently dropped every SVG, so an app's images vanished after upgrading. The `svg` feature is kept
as a no-op so feature lists that name it still build.

An app turns them off with `default-features = false` on the platform crate and names what it keeps. A direct dependency
on `nsh-base` must also say `default-features = false`, or Cargo turns its defaults back on.

A project building its own executable with Cargo (an embedder, or its own `main` on `nsh_*_app`) chooses them itself.
The prebuilt runners have everything. `nsh package` (Linux, macOS, Windows, Android, iOS) builds
the release runner with only the features its bundle can reach (`crates/nsh-cli/src/native_features.rs`, on the gates
of `linked_gates`), and prints why each is kept or left out. A TSX app gets this too when it packages for this machine's
OS (iOS from macOS), or for Android, with `cargo` installed (Android's `libnsh.so` cross-compiles with the NDK): its runner builds in `.nsh/rust` from nsh's crates (the CLI's checkout, else crates.io at
the CLI's version), so the first package compiles nsh's crates once (`package.rs` `trimmed_runner`). It ships the
prebuilt runner instead, as before, when there is no `cargo`, `NSH_RUNTIME` is set, the package is for another OS (no
cross toolchain needed), or the runner does not build (missing system libraries or Rust target, crates.io out of
reach): the build is tried before packaging, and a failure only warns.

What is kept:

- `shader`, `editor`, `rich-editor`, `plot`, `term`, `emoji-picker`: kept when a reachable import links their part;
  `highlight` and `math` also by `TextView` (Markdown shows code and formulas);
- `zlib`, `crypto`, `websocket`, `updater`: kept when the bundle imports their module;
- `js`, `net` (and Linux's `sound` and `webview`, Windows' `webview` and `media`): always kept, since a URL or an image's format comes from data;
- everything is kept when the bundle computes an import (`import(name)`), or when it could not be analyzed.

What only the app's Rust code or a dynamic access needs, it keeps in `nsh.json`: `"features": ["plot"]`. Rust code that
depends on `nsh-base` with its default features keeps them through Cargo's feature unification anyway. Development
hosts and `nsh run` always have everything. The web links per app by what it imports (`docs/dev/browser-js-size.md`).

A part that is off leaves `nsh_base` altogether, so Rust using it does not compile. JS fails at load: `Could not find
export 'Editor' in module 'nsh/base'`. Nothing checks at build time that an app's imports match its runtime's features,
because `nsh` bundles against every part.

`nsh-cli`'s generated crates and `xtask dist` use `default-features = false`: a new feature goes in `RUST_APP_PLATFORM`
(`crates/nsh-cli/src/rust_app.rs`; one only some platforms have, as Linux's `sound` or Linux's and Windows' `net`, in
`rust_app_platform`: Cargo resolves the generated workspace for every target, so a feature named on a crate without it
fails every build) and in `dist.rs`, or those builds lose it.
