//! The executable of a packaged nsh app (`nsh package`): runs the bundle
//! shipped inside the app (`nsh/bundle.nshc`, assets in `nsh/assets`), or a
//! newer signed package of its code it downloaded (`nsh_engine::updates`).
//!
//! A library so that an app with Rust components of its own (`nsh.json`
//! `"rust"`) builds the release runner with them: its `main` calls
//! `nsh_platform_ios::set_ui_sets` and then [`main`]. A Rust app
//! (`nsh.json` `"root"`) calls [`run_rust`] with its root instead, built
//! without the feature `js`: the runner then links no QuickJS.

/// Runs the release runner (until the app quits).
#[cfg(all(target_os = "ios", feature = "js"))]
pub fn main() {
    use nsh_platform_ios::{AppSource, AssetBase, Bundle, run_app};

    let (dir, mut options) = setup();
    // SAFETY: the bytecode is a resource of this (signed) app.
    let bundle = match unsafe { Bundle::read_trusted(&dir.join("bundle.nshc")) } {
        Ok(bundle) => bundle,
        Err(err) => {
            log::error!("cannot read the app bundle in {}: {err}", dir.display());
            std::process::exit(1);
        }
    };
    // Where the engine keeps the app's data (`SurfaceOptions::data_dir`).
    let data_dir = options
        .data_dir
        .clone()
        .or_else(|| nsh_platform_ios::SurfaceOptions::default().data_dir);
    let launch = nsh_engine::updates::launch(bundle, &dir, data_dir.as_deref());
    options.asset_base = Some(AssetBase::Directory(launch.assets));
    run_app(AppSource::Bundle(launch.bundle), options);
}

/// Runs the Rust app whose root is `root` (until the app quits), with the
/// app's assets as [`main`] has them.
#[cfg(target_os = "ios")]
pub fn run_rust(root: nsh_platform_ios::Root) {
    let (_, options) = setup();
    nsh_platform_ios::run_app(nsh_platform_ios::AppSource::Rust(root), options);
}

/// Built without the feature `js`: runs Rust apps only ([`run_rust`]).
#[cfg(all(target_os = "ios", not(feature = "js")))]
pub fn main() {
    eprintln!("this runner was built without the feature `js`: it runs Rust apps (run_rust)");
    std::process::exit(1);
}

/// Installs the logger and finds the app's resources (`nsh` in the app
/// bundle). Warnings, errors and the app's `js` lines go to the unified log
/// (an app opened from the Home screen has no stderr anyone reads);
/// `NSH_DEVELOPMENT` (`nsh run` of a Rust app) logs the app's own lines too,
/// and on stderr, which `nsh run` shows.
#[cfg(target_os = "ios")]
fn setup() -> (std::path::PathBuf, nsh_platform_ios::AppOptions) {
    use nsh_platform_ios::{AppOptions, AssetBase};

    let mut logging = nsh_platform_apple::unified_log::Options::default();
    logging.development = std::env::var_os("NSH_DEVELOPMENT").is_some();
    nsh_platform_apple::unified_log::install(logging);

    // The app bundle directory holds the executable.
    let dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("nsh")))
        .unwrap_or_default();
    let options = AppOptions {
        trace: false,
        asset_base: Some(AssetBase::Directory(dir.join("assets"))),
        ..AppOptions::default()
    };
    (dir, options)
}

/// Not on UIKit targets: says so and exits.
#[cfg(not(target_os = "ios"))]
pub fn main() {
    eprintln!("nsh-ios-app is the executable of packaged iOS apps; build it for an iOS target");
    std::process::exit(1);
}
