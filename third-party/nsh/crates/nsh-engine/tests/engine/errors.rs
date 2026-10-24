//! Errors are reported with app source locations, via the source map.

use std::{
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};

use nsh_core::{ApproxTextEngine, MountBatch, Size, geometry::px};
use nsh_engine::{AppError, AppErrorKind, Bundle, Engine, EngineConfig, MountSink};

struct Sink {
    errors: Arc<Mutex<mpsc::Sender<String>>>,
}

impl MountSink for Sink {
    fn submit(&self, _batch: MountBatch) {}

    fn report_error(&self, message: &str) {
        let _ = self.errors.lock().unwrap().send(message.to_owned());
    }
}

/// Hears the errors with their parts.
struct ReportSink(Mutex<mpsc::Sender<AppError>>);

impl MountSink for ReportSink {
    fn submit(&self, _batch: MountBatch) {}

    fn report(&self, error: &AppError) {
        let _ = self.0.lock().unwrap().send(error.clone());
    }
}

fn config(bundle: Bundle, limits: nsh_engine::Limits) -> EngineConfig {
    EngineConfig {
        app: nsh_engine::App::Js(bundle),
        viewport: Size::new(px(100.0), px(100.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Default::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits,
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    }
}

/// The errors `code` (JS source) reports, until none came for a while.
fn reports(code: &str, limits: nsh_engine::Limits) -> Vec<AppError> {
    let (tx, rx) = mpsc::channel();
    let bundle = Bundle::source(code.to_owned());
    let _engine = Engine::start(
        config(bundle, limits),
        || ApproxTextEngine,
        ReportSink(Mutex::new(tx)),
    )
    .unwrap();
    let mut errors = Vec::new();
    while let Ok(error) = rx.recv_timeout(Duration::from_millis(1500)) {
        errors.push(error);
    }
    errors
}

/// Bundles an app whose timer throws on line 5 of `App.tsx` (in a
/// directory of its own, named `name`).
fn failing_app(name: &str, minify: bool) -> nsh_bundler::Bundle {
    // The throw is on line 5, column 9.
    bundle_app(
        name,
        minify,
        "import { mount, View } from \"nsh\";\n\
         const message: string = \"boom\";\n\
         function fail(): void {\n\
         \x20 // line 4\n\
         \x20 throw new Error(message);\n\
         }\n\
         setTimeout(fail, 0);\n\
         mount(() => <View />);\n",
    )
}

/// Bundles `source` as `App.tsx` in a directory of its own, named `name`.
fn bundle_app(name: &str, minify: bool, source: &str) -> nsh_bundler::Bundle {
    let dir = std::env::temp_dir().join(format!("nsh-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, source).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
    })
    .unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    bundle
}

/// Runs `bundle` until it reports its first error.
fn first_error(bundle: Bundle) -> String {
    let (tx, rx) = mpsc::channel();
    let sink = Sink {
        errors: Arc::new(Mutex::new(tx)),
    };
    let config = EngineConfig {
        app: nsh_engine::App::Js(bundle),
        viewport: Size::new(px(100.0), px(100.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Default::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    let _engine = Engine::start(config, || ApproxTextEngine, sink).unwrap();
    rx.recv_timeout(Duration::from_secs(5))
        .expect("error reported")
}

#[test]
fn uncaught_errors_point_at_app_sources() {
    let bundle = failing_app("errors", false);
    let bytecode = nsh_js::compile_bytecode(&bundle.code, false).unwrap();
    // SAFETY: compiled just now by this runtime.
    let bundle = unsafe { Bundle::bytecode(bytecode) }
        .with_source_map(bundle.source_map.expect("source map"));
    let error = first_error(bundle);
    assert!(error.contains("Error: boom"), "{error}");
    assert!(error.contains("App.tsx:5:"), "not symbolicated: {error}");
    assert!(!error.contains("bundle.js"), "{error}");
}

/// Release bytecode as `nsh publish` compiles it keeps its line tables:
/// with the map in the package the device reports app source positions;
/// without it, bundle positions that the map turns into the same later.
#[test]
fn published_bytecode_keeps_positions_for_the_source_map() {
    let bundle = failing_app("published-errors", true);
    let map = bundle.source_map.clone().expect("source map");
    let bytecode = nsh_js::compile_bytecode(&bundle.code, nsh_js::Strip::Source).unwrap();

    // SAFETY: compiled just now by this runtime.
    let with_map = unsafe { Bundle::bytecode(bytecode.clone()) }.with_source_map(map.clone());
    let error = first_error(with_map);
    assert!(error.contains("App.tsx:5:"), "not symbolicated: {error}");

    // SAFETY: as above.
    let error = first_error(unsafe { Bundle::bytecode(bytecode) });
    assert!(error.contains("bundle.js:1:"), "no position: {error}");
    let mapped = nsh_engine::symbolicate(&map, &error);
    assert!(mapped.contains("App.tsx:5:"), "not symbolicated: {mapped}");
    assert!(!mapped.contains("bundle.js"), "{mapped}");

    // Without the line tables there is nothing to map.
    let stripped = nsh_js::compile_bytecode(&bundle.code, nsh_js::Strip::All).unwrap();
    // SAFETY: as above.
    let error = first_error(unsafe { Bundle::bytecode(stripped) }.with_source_map(map));
    assert!(error.contains("Error: boom"), "{error}");
    assert!(!error.contains("App.tsx:5:"), "{error}");
}

/// An unhandled rejection is logged with its stack mapped to the app's
/// sources; the error overlay (the sink) gets exceptions only.
#[test]
fn unhandled_rejections_are_logged_at_app_sources() {
    crate::logs::capture();
    // The throw is on line 5; an exception follows it, a turn later.
    let bundle = bundle_app(
        "rejections",
        false,
        "import { mount, View } from \"nsh\";\n\
         const message: string = \"nobody handles this\";\n\
         async function load(): Promise<void> {\n\
         \x20 // line 4\n\
         \x20 throw new Error(message);\n\
         }\n\
         setTimeout(() => { load(); }, 0);\n\
         setTimeout(() => { throw new Error(\"after the rejection\"); }, 20);\n\
         mount(() => <View />);\n",
    );
    let bundle =
        Bundle::source(bundle.code).with_source_map(bundle.source_map.expect("source map"));
    let error = first_error(bundle);
    assert!(error.contains("after the rejection"), "{error}");
    let lines = crate::logs::wait_for("nobody handles this");
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(
        lines[0].starts_with("unhandled rejection: Error: nobody handles this"),
        "{}",
        lines[0]
    );
    assert!(
        lines[0].contains("App.tsx:5:"),
        "not symbolicated: {}",
        lines[0]
    );
}

#[test]
fn errors_say_what_went_wrong_with_message_and_stack_apart() {
    let errors = reports(
        "function fail() { throw new Error('later'); }\nsetTimeout(fail, 0);",
        nsh_engine::Limits::default(),
    );
    let [error] = errors.as_slice() else {
        panic!("{errors:?}")
    };
    assert_eq!(error.kind, AppErrorKind::Uncaught);
    assert!(!error.is_fatal() && !error.is_stopped());
    assert_eq!(error.message, "Error: later");
    let stack = error.stack.as_deref().expect("a stack");
    assert!(stack.trim_start().starts_with("at fail"), "{stack}");
    assert_eq!(error.package, None);

    let errors = reports("throw new Error('at load');", nsh_engine::Limits::default());
    let [error] = errors.as_slice() else {
        panic!("{errors:?}")
    };
    assert_eq!(error.kind, AppErrorKind::Load);
    assert!(error.is_fatal() && !error.is_stopped());
    assert_eq!(error.message, "Error: at load");
}

#[test]
fn a_stopped_vm_is_reported_as_fatal() {
    let limits = nsh_engine::Limits {
        memory_bytes: 16 << 20,
        ..nsh_engine::Limits::default()
    };
    let errors = reports(
        "const kept = []; setTimeout(() => { for (;;) kept.push(new Array(100000).fill(1)); }, 0);",
        limits,
    );
    let stopped: Vec<_> = errors.iter().filter(|e| e.is_stopped()).collect();
    assert_eq!(stopped.len(), 1, "{errors:?}");
    assert!(stopped[0].is_fatal());
}

/// `ref={c}` with a const that is neither a signal nor a function says so,
/// at the app's line, instead of assigning nothing.
#[test]
fn a_ref_naming_a_const_object_says_what_to_write() {
    let bundle = bundle_app(
        "const-ref",
        false,
        "import { mount, View } from \"nsh\";\n\
         const target = { node: null };\n\
         mount(() => <View ref={target} />);\n",
    );
    let bytecode = nsh_js::compile_bytecode(&bundle.code, false).unwrap();
    // SAFETY: compiled just now by this runtime.
    let bundle = unsafe { Bundle::bytecode(bytecode) }
        .with_source_map(bundle.source_map.expect("source map"));
    let error = first_error(bundle);
    assert!(
        error.contains("ref={target}: `target` cannot be assigned (a const or an import)"),
        "{error}"
    );
    assert!(error.contains("App.tsx:3:"), "{error}");
}
