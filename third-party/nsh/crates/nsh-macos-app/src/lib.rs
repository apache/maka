//! The executable of a packaged nsh app (`nsh package --target macos`):
//! runs the bundle in its app bundle's resources (`nsh/bundle.nshc`, assets
//! in `nsh/assets`, the app's name and appearance in `nsh/app.json`), or a
//! newer signed package of its code it downloaded (`nsh_engine::updates`).
//!
//! A library so that an app with Rust components of its own (`nsh.json`
//! `"rust"`) builds the release runner with them: its `main` calls
//! `nsh_platform_macos::set_ui_sets` and then [`main`]. A Rust app
//! (`nsh.json` `"root"`) calls [`run_rust`] with its root instead, built
//! without the feature `js`: the runner then links no QuickJS.

/// Runs the release runner (until its window closes).
#[cfg(all(target_os = "macos", feature = "js"))]
pub fn main() -> std::process::ExitCode {
    use nsh_platform_macos::{AppSource, AssetBase, Bundle, run_app};

    let (dir, mut options) = setup();
    // SAFETY: the bytecode is a resource of this app's own bundle (which
    // the code signature covers).
    let bundle = match unsafe { Bundle::read_trusted(&dir.join("bundle.nshc")) } {
        Ok(bundle) => bundle,
        Err(err) => {
            log::error!("cannot read the app bundle in {}: {err}", dir.display());
            return std::process::ExitCode::FAILURE;
        }
    };
    let data_dir = options.data_dir.clone().or_else(nsh_engine::data_dir);
    let launch = nsh_engine::updates::launch(bundle, &dir, data_dir.as_deref());
    options.asset_base = Some(AssetBase::Directory(launch.assets));
    run_app(AppSource::Bundle(launch.bundle), options)
}

/// Runs the Rust app whose root is `root` (until its window closes), with
/// the bundle's assets, name and appearance as [`main`] has them.
#[cfg(target_os = "macos")]
pub fn run_rust(root: nsh_platform_macos::Root) -> std::process::ExitCode {
    let (_, options) = setup();
    nsh_platform_macos::run_app(nsh_platform_macos::AppSource::Rust(root), options)
}

/// Built without the feature `js`: runs Rust apps only ([`run_rust`]).
#[cfg(all(target_os = "macos", not(feature = "js")))]
pub fn main() -> std::process::ExitCode {
    eprintln!("this runner was built without the feature `js`: it runs Rust apps (run_rust)");
    std::process::ExitCode::FAILURE
}

/// Installs the logger and reads the app's resources: its `nsh` directory
/// (in the app bundle, or `NSH_APP_DIR`: `nsh run` of a Rust app) and the
/// window's options.
#[cfg(target_os = "macos")]
fn setup() -> (std::path::PathBuf, nsh_platform_macos::AppOptions) {
    use nsh_platform_macos::{AppOptions, Appearance, AssetBase, Limits};

    /// Run by `nsh run`: the app's own logs go to its terminal too.
    static DEVELOPMENT: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    struct Logger;
    impl log::Log for Logger {
        fn enabled(&self, m: &log::Metadata<'_>) -> bool {
            m.level() <= log::Level::Warn || m.target() == "js" || DEVELOPMENT.get() == Some(&true)
        }
        fn log(&self, r: &log::Record<'_>) {
            if self.enabled(r.metadata()) {
                eprintln!("{} {}: {}", r.level(), r.target(), r.args());
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Logger = Logger;
    let development = std::env::var_os("NSH_APP_DIR");
    let _ = DEVELOPMENT.set(development.is_some());
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);

    // `<App>.app/Contents/MacOS/<exe>` -> `<App>.app/Contents/Resources/nsh`.
    let dir = match development {
        Some(dir) => std::path::PathBuf::from(dir),
        None => std::env::current_exe()
            .and_then(|exe| exe.canonicalize())
            .ok()
            .and_then(|exe| {
                let contents = exe.parent()?.parent()?;
                Some(contents.join("Resources/nsh"))
            })
            .unwrap_or_default(),
    };
    let mut options = AppOptions {
        asset_base: Some(AssetBase::Directory(dir.join("assets"))),
        // An app on its own, not a module embedded in another app.
        limits: Limits::standalone(),
        ..AppOptions::default()
    };
    let info = std::fs::read_to_string(dir.join("app.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let field = |key: &str| {
        info.as_ref()
            .and_then(|info| info.get(key)?.as_str().map(str::to_owned))
    };
    if let Some(id) = field("id") {
        options.app_id = id;
    }
    if let Some(name) = field("name") {
        options.title = name;
    }
    // The window opens in the app's appearance (no flash of the system's).
    match field("appearance").as_deref() {
        Some("light") => options.appearance = Appearance::Light,
        Some("dark") => options.appearance = Appearance::Dark,
        _ => {}
    }
    // `open -a <App> --args --fps` shows the performance monitor, and so
    // does `NSHPerformanceMonitor` (a boolean) in the bundle's Info.plist:
    // a build that opens with it however it is launched (the Dock, Finder,
    // Spotlight pass no arguments).
    options.fps = std::env::args().any(|arg| arg == "--fps") || monitor_in_info_plist();
    // NSH_CHUNK_DIR: the directory `import()` loads chunks from — the
    // app's own runtime-delivered modules (the bundle's resources are
    // read-only).
    options.chunks = std::env::var_os("NSH_CHUNK_DIR").map(std::path::PathBuf::from);
    (dir, options)
}

/// Whether the bundle's Info.plist has `NSHPerformanceMonitor` true.
#[cfg(target_os = "macos")]
fn monitor_in_info_plist() -> bool {
    use nsh_platform_macos::objc2_foundation::{NSBundle, NSNumber, NSString};
    NSBundle::mainBundle()
        .objectForInfoDictionaryKey(&NSString::from_str("NSHPerformanceMonitor"))
        .and_then(|value| value.downcast::<NSNumber>().ok())
        .is_some_and(|value| value.boolValue())
}

/// Not on macOS: says so and exits.
#[cfg(not(target_os = "macos"))]
pub fn main() -> std::process::ExitCode {
    eprintln!("nsh-macos-app is the executable of packaged macOS apps; build it on macOS");
    std::process::ExitCode::FAILURE
}
