# Several Rust crates in one app

Status: implemented (`crates/nsh-cli/src/rust_app.rs`; `docs/dev/tooling.md`, "Apps with Rust components of their
own").

An app used to have at most one Rust crate (`nsh.json` `"rust": "<crate dir>"`, a string), with one
`#[native_module("<specifier>")]` entry, so everything Rust it offered was under one import specifier. Splitting an
app's native code (charts, storage, a shared crate of company components) meant one crate that depended on the
others and registered them all under its specifier.

## Design

- `"rust"` takes a crate or a list of them: `"rust": ["native/charts", "native/storage"]`. Each is a library crate
  with its own `#[native_module("<specifier>")]` (one per crate, as before), so each is its own import:
  `import { Chart } from "app/charts"`, `import { Store } from "app/storage"`. A string is a list of one.
- `rust_app.rs` writes one generated workspace with all of them: the describe program, the headless runners and every
  host and runner (iOS, Android, Linux, macOS, Windows, the web, the GPUI workspace, a Rust app's runners) depend on
  each crate and pass all their registries (`Description::of`, `headless::runner`, `set_ui_sets`, `ui_sets!`) in the
  list's order, after `nsh_base::registry()`, served beside the runtime's modules (the describe program describes
  the app's sets only).
- The generated code links each crate under a name of its own, `app_<package>` (`-` as `_`), and makes its set in a
  function of its own, `set_app_<package>()`, whose body glob-imports that crate: the fixed-name entry
  `__nsh_native_module` of each crate is found in its own scope, and one crate without an entry fails the build with
  what to add on the line of that crate (the file's one import of nsh's stand-in is what the glob shadows).
- Checked when the workspace is written (`rust_app::crates`): a crate listed twice, two crates with the same package
  name (Cargo takes `-` and `_` as one), or two whose `#[native_module("…")]` has the same specifier (read from the
  crate's `[lib] path` or `src/lib.rs`) fail with the two paths and what to change. That reading is early and
  friendly; the authority is the description the crates' describe program prints, in which `nsh` refuses two sets
  with one specifier, or one with a specifier of nsh's own (`rust_app::check_specifiers`), however the entry was
  written. `Registry::merged` already refuses two sets registering
  components or modules of the same name when an engine starts.
- Each specifier gets its declarations (`.nsh/types/<specifier>.d.ts`) and its assets (`asset:/@<package>/...`,
  already per package), as both come from the description of its set.
- `nsh dev` / `nsh run` watch every listed crate and the local crates they depend on by path, transitively
  (`RustApp::watched`; nsh's own crates and dev-dependencies are left out): a change to any of them describes the app
  again and restarts the session, as with one crate.
- Crates may depend on each other, or on crates not listed (a shared crate of components that another crate's
  components use), through plain Cargo path dependencies; only the ones listed in `"rust"` export to TS.
- A Rust app's `"root"` is a component of the first crate listed.
- The generated binaries are named after the first crate's package and a digest of all the crates' packages
  (`nsh-app-charts-ef5aa537-describe`), so they do not clash with the crates' own binaries in the app's `target/`, and
  their names stay short however many crates an app lists (Windows' linker cannot open paths over 260 characters).

## Why a list of crates

The alternative, several `#[native_module]` entries in one crate, needs a collection of entries the generated code
can find (it finds one entry per crate by a fixed name), and keeps everything in one compilation unit. A crate per
specifier is Rust's own unit of reuse: a crate of shared components can be listed by several apps, versioned and
tested on its own.
