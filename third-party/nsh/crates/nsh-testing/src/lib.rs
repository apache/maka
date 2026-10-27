//! Headless tests of nsh apps.
//!
//! The driver ([`Headless`], the module `headless`) runs an app on an
//! engine without a window, with display frames at 60 Hz, applies its mount
//! batches to a model of the native views ([`Screen`]) and takes the steps a
//! user would on what they show: press, type, submit, scroll, wait. It needs
//! no QuickJS: a Rust app's tests run its root with this crate's default
//! features.
//!
//! ```ignore
//! let mut app = nsh_testing::Headless::start(EngineConfig::new(Root::of::<my_app::App>())).unwrap();
//! app.wait_for("Count: 0")?;
//! app.press("Tap")?;
//! app.wait_for("Count: 1")?;
//! ```
//!
//! Feature `js` is `nsh test`'s side: the `nsh/test` module ([`registry`])
//! test files import, each test file on an engine of its own
//! ([`run_file`]), and the headless runner of an app with Rust crates
//! ([`runner`]). Feature `bundle` builds entries in this process: a TSX
//! entry against the UI sets its hosts serve, as `nsh run` builds it
//! ([`compile_tsx`], [`tsx`]), and `nsh test`'s [`compiler`].
//!
//! ```ignore
//! let sets = vec![nsh_base::registry(), my_app_native::registry()];
//! let mut app = nsh_testing::tsx("../App.tsx", sets).unwrap();
//! app.wait_for("Ready")?;
//! ```

#[cfg(feature = "agent")]
pub mod agent;
#[cfg(feature = "js")]
mod driver;
// An engine on a thread of its own: not in WebAssembly, where only the
// agent's model runs (the web's page).
#[cfg(not(target_arch = "wasm32"))]
mod headless;
pub mod menu;
#[cfg(feature = "js")]
mod module;
#[cfg(feature = "js")]
mod page_host;
#[cfg(feature = "js")]
mod run;
#[cfg(feature = "js")]
mod runner;
mod screen;
mod selector;
mod storage;
mod trace;

#[cfg(feature = "bundle")]
use std::{path::Path, sync::Arc};

#[cfg(feature = "js")]
use nsh_core::element::Registry;
#[cfg(feature = "bundle")]
use nsh_core::element::description::SetDescription;
#[cfg(feature = "bundle")]
use nsh_engine::{Bundle, EngineConfig};

#[cfg(all(feature = "live", not(target_arch = "wasm32")))]
pub use self::headless::UreqNetwork;
#[cfg(not(target_arch = "wasm32"))]
pub use self::headless::{
    DialogAnswer, DirectoryAssets, Headless, RecordingNetwork, StubHandler, StubNetwork, StubReply,
    StubResponse, StubRoute, WAIT, default_answer, print_batch, start,
};
#[cfg(feature = "js")]
#[allow(deprecated)]
pub use self::module::MobilePlatform;
#[cfg(feature = "js")]
pub use self::{
    driver::Host,
    module::{
        App, ClockOptions, ColorScheme, Entries, Expectation, NetworkOption, OpenOptions, Platform,
        RouteOption, SPECIFIER, SafeArea, SpanStyle, StubRequest, Testing, registry,
    },
    run::{
        Built, Compile, Entry, Failure, HostOptions, Output, StartHost, TestResult, TestRun,
        TestStatus, run_file,
    },
    runner::{PROTOCOL, Reply, RunnerMessage, TestRequest, runner},
};
pub use self::{
    screen::{Pick, Screen},
    storage::MemoryStorage,
};

/// The sets the entry `nsh test` makes for a test file is built against
/// besides the app's: `nsh/test` ([`registry`]) and the module that runs
/// the file's tests.
#[cfg(feature = "js")]
pub fn test_sets() -> Vec<Registry> {
    vec![registry(), module::runner_registry()]
}

/// The TSX (or TS, JS) entry `entry` bundled with nsh's bundler and
/// compiled to QuickJS bytecode against `ui_sets`, as `nsh run` builds it:
/// the app to run (`EngineConfig::new(bundle)`), or what failed. Build it
/// once for several tests and clone it.
#[cfg(feature = "bundle")]
pub fn compile_tsx(entry: impl AsRef<Path>, ui_sets: &[Registry]) -> Result<Bundle, String> {
    let (app, map) = build(entry.as_ref(), ui_sets)?;
    Ok(match map {
        Some(map) => app.with_source_map(map),
        None => app,
    })
}

/// `entry` built against `ui_sets`: its bytecode and source map.
#[cfg(feature = "bundle")]
fn build(entry: &Path, ui_sets: &[Registry]) -> Result<(Bundle, Option<String>), String> {
    let sets: Vec<SetDescription> = ui_sets
        .iter()
        .flat_map(Registry::sets)
        .map(SetDescription::from)
        .collect();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: entry.to_path_buf(),
        minify: false,
        split: false,
        ui_sets: sets.clone(),
    })
    .map_err(|e| format!("{}: {e}", entry.display()))?;
    let bytecode = nsh_js::compile_bytecode_with(&bundle.code, false, &sets)
        .map_err(|e| format!("{}: {e}", entry.display()))?;
    // Under what its nsh.json declares, as on a device.
    let capabilities = bundle.capabilities.map(|c| c.to_json().to_string());
    // SAFETY: compiled by this runtime just now, from the app's sources.
    let app = unsafe { Bundle::bytecode(bytecode) }
        .with_capabilities_json(capabilities.as_deref())
        .map_err(|e| format!("{}: {e}", entry.display()))?;
    Ok((app, bundle.source_map))
}

/// Builds the entries of `nsh test` ([`TestRun::compile`]) in this
/// process, against `ui_sets` (and [`test_sets`] for test files).
#[cfg(feature = "bundle")]
pub fn compiler(ui_sets: Vec<Registry>) -> Compile {
    Arc::new(move |entry: &Path, kind: Entry| {
        // An app's directory: its `App.tsx`.
        let entry = &if entry.is_dir() {
            entry.join("App.tsx")
        } else {
            entry.to_owned()
        };
        let (bundle, map) = match kind {
            Entry::App => build(entry, &ui_sets)?,
            Entry::TestFile => {
                let mut sets = ui_sets.clone();
                sets.extend(test_sets());
                build(entry, &sets)?
            }
        };
        Ok(Built::Js(Box::new(bundle), map))
    })
}

/// Starts the TSX entry `entry` built against `ui_sets` ([`compile_tsx`])
/// on a phone-sized headless engine ([`EngineConfig::new`]) serving them.
#[cfg(feature = "bundle")]
pub fn tsx(entry: impl AsRef<Path>, ui_sets: Vec<Registry>) -> Result<Headless, String> {
    let app = compile_tsx(entry, &ui_sets)?;
    Headless::start(EngineConfig {
        ui_sets,
        ..EngineConfig::new(app)
    })
    .map_err(|e| format!("the engine did not start: {e}"))
}
