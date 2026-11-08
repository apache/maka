//! The executable of a packaged nsh app (`nsh package --target windows`):
//! runs the bundle shipped next to it (`nsh\bundle.nshc`, assets in
//! `nsh\assets`, the app's name, id, appearance and URL schemes in `nsh\app.json`, its
//! icon in `nsh\icon.ico`), or a newer signed package of its code it
//! downloaded (`nsh_engine::updates`).
//!
//! A library so that an app with Rust components of its own (`nsh.json`
//! `"rust"`) builds the release runner with them: its `main` calls
//! `nsh_platform_windows::set_ui_sets` and then [`main`]. A Rust app
//! (`nsh.json` `"root"`) calls [`run_rust`] with its root instead, built
//! without the feature `js`: the runner then links no QuickJS.

/// Runs the release runner (until its window closes).
#[cfg(all(windows, feature = "js"))]
pub fn main() -> std::process::ExitCode {
    use nsh_platform_windows::{AppSource, AssetBase, Bundle, run_app};

    let (dir, mut options) = setup();
    // SAFETY: the bytecode is a resource of this app's own package.
    let bundle = match unsafe { Bundle::read_trusted(&dir.join("bundle.nshc")) } {
        Ok(bundle) => bundle,
        Err(err) => {
            nsh_platform_windows::fatal_error(&format!(
                "Cannot read the app bundle in {}: {err}",
                dir.display()
            ));
            return std::process::ExitCode::FAILURE;
        }
    };
    let data_dir = options.data_dir.clone().or_else(nsh_engine::data_dir);
    let launch = nsh_engine::updates::launch(bundle, &dir, data_dir.as_deref());
    options.asset_base = Some(AssetBase::Directory(launch.assets));
    run_app(AppSource::Bundle(launch.bundle), options)
}

/// Runs the Rust app whose root is `root` (until its window closes), with
/// the package's assets, name, id and appearance as [`main`] has them.
#[cfg(windows)]
pub fn run_rust(root: nsh_platform_windows::Root) -> std::process::ExitCode {
    let (_, options) = setup();
    nsh_platform_windows::run_app(nsh_platform_windows::AppSource::Rust(root), options)
}

/// Built without the feature `js`: runs Rust apps only ([`run_rust`]).
#[cfg(all(windows, not(feature = "js")))]
pub fn main() -> std::process::ExitCode {
    nsh_platform_windows::fatal_error(
        "This runner was built without the feature `js`: it runs Rust apps (run_rust).",
    );
    std::process::ExitCode::FAILURE
}

/// Installs the logger and reads the package: its `nsh` directory (next
/// to the executable, or `NSH_APP_DIR`: `nsh run` of a Rust app) and the
/// window's options.
#[cfg(windows)]
fn setup() -> (std::path::PathBuf, nsh_platform_windows::AppOptions) {
    use nsh_platform_windows::{AppOptions, Appearance, AssetBase, Limits};

    /// Run by `nsh run`: the app's own logs go to its terminal too.
    static DEVELOPMENT: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    // A GUI program has no console: warnings go to the debugger
    // (`OutputDebugString`), where DebugView and Visual Studio show them;
    // run by `nsh run`, everything also goes to the pipe it reads.
    struct Logger;
    impl log::Log for Logger {
        fn enabled(&self, m: &log::Metadata<'_>) -> bool {
            m.level() <= log::Level::Warn || m.target() == "js" || DEVELOPMENT.get() == Some(&true)
        }
        fn log(&self, r: &log::Record<'_>) {
            if self.enabled(r.metadata()) {
                let line = format!("{} {}: {}\n", r.level(), r.target(), r.args());
                nsh_platform_windows::debug_output(&line);
                if DEVELOPMENT.get() == Some(&true) {
                    eprint!("{line}");
                }
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Logger = Logger;
    let development = std::env::var_os("NSH_APP_DIR");
    let _ = DEVELOPMENT.set(development.is_some());
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);

    let dir = match development {
        Some(dir) => std::path::PathBuf::from(dir),
        None => std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|d| d.join("nsh")))
            .unwrap_or_default(),
    };
    let icon = dir.join("icon.ico");
    let mut options = AppOptions {
        asset_base: Some(AssetBase::Directory(dir.join("assets"))),
        icon: icon.is_file().then_some(icon),
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
    // The URL schemes it registers and opens (`EventKind::UrlScheme`).
    if let Some(schemes) = info
        .as_ref()
        .and_then(|info| info.get("schemes")?.as_array().cloned())
    {
        options.schemes = schemes
            .iter()
            .filter_map(|s| s.as_str().map(str::to_owned))
            .collect();
    }
    // The window opens in the app's appearance (no flash of the system's).
    match field("appearance").as_deref() {
        Some("light") => options.appearance = Appearance::Light,
        Some("dark") => options.appearance = Appearance::Dark,
        _ => {}
    }
    (dir, options)
}

/// Not on Windows: says so and exits.
#[cfg(not(windows))]
pub fn main() -> std::process::ExitCode {
    eprintln!("nsh-windows-app is the executable of packaged Windows apps; build it on Windows");
    std::process::ExitCode::FAILURE
}
