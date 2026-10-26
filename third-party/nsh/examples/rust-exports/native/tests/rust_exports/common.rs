//! What the tests share: `App.tsx` built against the crate's set and run
//! headless (`nsh_testing`).

use std::sync::OnceLock;

use nsh_core::element::Registry;
use nsh_engine::{Bundle, EngineConfig};
use nsh_testing::Headless;

/// The sets the app's hosts serve: the mobile UI, then the crate's
/// (`nsh.json` `"rust"`), as `nsh` passes them.
fn ui_sets() -> Vec<Registry> {
    vec![nsh_base::registry(), rust_exports_native::registry()]
}

/// `App.tsx` as bytecode, built once for every test.
fn app() -> Bundle {
    static APP: OnceLock<Bundle> = OnceLock::new();
    APP.get_or_init(|| {
        let entry = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../App.tsx");
        nsh_testing::compile_tsx(entry, &ui_sets()).expect("App.tsx builds")
    })
    .clone()
}

/// The app on a phone-sized headless engine, once it shows `ready`.
pub(crate) fn start(ready: &str) -> Headless {
    let mut app = Headless::start(EngineConfig {
        ui_sets: ui_sets(),
        ..EngineConfig::new(app())
    })
    .expect("the engine starts");
    app.wait_for(ready).unwrap();
    app
}

/// Presses what the text `label` is in (a button, the gauge), as a tap
/// does, and waits until `then` shows.
pub(crate) fn press(app: &mut Headless, label: &str, then: &str) {
    app.press(label).unwrap();
    app.wait_for(then).unwrap();
}
