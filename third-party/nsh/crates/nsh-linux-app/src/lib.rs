//! The executable of a packaged nsh app (`nsh package --target linux`):
//! runs the bundle shipped next to it (`nsh/bundle.nshc`, assets in
//! `nsh/assets`, the app's name, id and appearance in `nsh/app.json`), or a
//! newer signed package of its code it downloaded (`nsh_engine::updates`).
//!
//! A library so that an app with Rust components of its own (`nsh.json`
//! `"rust"`) builds the release runner with them: its `main` calls
//! `nsh_platform_linux::set_ui_sets` and then [`main`]. A Rust app
//! (`nsh.json` `"root"`) calls [`run_rust`] with its root instead, built
//! without the feature `js`: the runner then links no QuickJS.

/// Runs the release runner (until its window closes).
#[cfg(all(target_os = "linux", feature = "js"))]
pub fn main() -> std::process::ExitCode {
    use nsh_platform_linux::{AppSource, AssetBase, Bundle};

    let Some((dir, mut options)) = setup() else {
        return std::process::ExitCode::FAILURE;
    };
    // SAFETY: the bytecode is a resource of this app's own package.
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
    run(AppSource::Bundle(launch.bundle), options)
}

/// Runs the Rust app whose root is `root` (until its window closes), with
/// the package's assets, name, id and appearance as [`main`] has them.
#[cfg(target_os = "linux")]
pub fn run_rust(root: nsh_platform_linux::Root) -> std::process::ExitCode {
    let Some((_, options)) = setup() else {
        return std::process::ExitCode::FAILURE;
    };
    run(nsh_platform_linux::AppSource::Rust(root), options)
}

/// Installs the logger and reads the package: its `nsh` directory (next
/// to the executable, or `NSH_APP_DIR`: `nsh run` of a Rust app) and the
/// window's options.
#[cfg(target_os = "linux")]
fn setup() -> Option<(std::path::PathBuf, nsh_platform_linux::AppOptions)> {
    use nsh_platform_linux::{AppOptions, Appearance, AssetBase, Limits};

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
    /// Run by `nsh run`: the app's own logs go to its terminal too.
    static DEVELOPMENT: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let development = std::env::var_os("NSH_APP_DIR");
    let _ = DEVELOPMENT.set(development.is_some());
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);

    // The package directory holds the executable (a symlink to it, say in
    // ~/.local/bin, still finds it).
    let dir = match development {
        Some(dir) => std::path::PathBuf::from(dir),
        None => std::env::current_exe()
            .and_then(|exe| exe.canonicalize())
            .ok()
            .and_then(|exe| exe.parent().map(|d| d.join("nsh")))
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
    if let Some(schemes) = info
        .as_ref()
        .and_then(|info| info.get("schemes")?.as_array().cloned())
    {
        options.schemes = schemes
            .iter()
            .filter_map(|s| s.as_str().map(str::to_owned))
            .collect();
    }
    // nsh.json `fileTypes`: the files it opens.
    options.file_types = info
        .as_ref()
        .and_then(|info| info.get("fileTypes"))
        .map(nsh_platform_linux::file_type::file_types_from_json)
        .unwrap_or_default();
    // nsh.json `singleInstance`: a second launch goes to this one.
    options.single_instance = info
        .as_ref()
        .and_then(|info| info.get("singleInstance")?.as_bool())
        .unwrap_or(false);
    // The window opens in the app's appearance (no flash of the system's).
    match field("appearance").as_deref() {
        Some("light") => options.appearance = Appearance::Light,
        Some("dark") => options.appearance = Appearance::Dark,
        _ => {}
    }
    Some((dir, options))
}

#[cfg(target_os = "linux")]
fn run(
    source: nsh_platform_linux::AppSource,
    options: nsh_platform_linux::AppOptions,
) -> std::process::ExitCode {
    if nsh_platform_linux::run_app(source, options)
        == nsh_platform_linux::gtk4::glib::ExitCode::SUCCESS
    {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}

/// Built without the feature `js`: runs Rust apps only ([`run_rust`]).
#[cfg(all(target_os = "linux", not(feature = "js")))]
pub fn main() -> std::process::ExitCode {
    eprintln!("this runner was built without the feature `js`: it runs Rust apps (run_rust)");
    std::process::ExitCode::FAILURE
}

/// Not on Linux: says so and exits.
#[cfg(not(target_os = "linux"))]
pub fn main() -> std::process::ExitCode {
    eprintln!("nsh-linux-app is the executable of packaged Linux apps; build it on Linux");
    std::process::ExitCode::FAILURE
}
