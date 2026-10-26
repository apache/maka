//! Development host: a prebuilt app that runs any nsh app.
//!
//! - `nsh-ios-host --dev-server ws://127.0.0.1:8790/ws [--trace]` loads bundles
//!   pushed by `nsh dev` / `nsh run` and reloads on every rebuild.
//! - `nsh-ios-host --bundle <path> [--trace]` runs a built bundle (`.nshc` is
//!   QuickJS bytecode, anything else JS source).
//! - `nsh-ios-host --package <app.nshpkg> --root <root.pub>... [--trace]` verifies
//!   a signed package (`nsh publish`) against the given roots and runs it, as
//!   an embedding app would (its trust state lives in the temporary
//!   directory).
//!
//! - `--data-dir <dir>` keeps the apps' data there instead of the app's
//!   data directory (`nsh test --target ios` gives each app a fresh one).
//! - `--fps` logs the performance monitor's readings once a second
//!   (`nsh run --fps`, `nsh test --fps`).
//!
//! Without arguments it connects to the dev server on this machine.
//!
//! A library so that an app with Rust components of its own (`nsh.json`
//! `"rust"`) builds the development host with them: its `main` calls
//! `nsh_platform_ios::set_ui_sets` and then [`main`].

/// Runs the development host (until the app quits).
#[cfg(target_os = "ios")]
pub fn main() {
    use std::{env, path::PathBuf};

    use nsh_platform_ios::{AppOptions, AppSource, AssetBase, Bundle, dev, run_app};

    dev::init_logging();
    let mut source = None;
    let mut trace = false;
    let mut fps = false;
    let mut asset_base = None;
    let mut package = None;
    let mut roots = Vec::new();
    let mut data_dir = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--dev-server" => source = args.next().map(AppSource::DevServer),
            "--bundle" => {
                let path = PathBuf::from(args.next().unwrap_or_default());
                // SAFETY: the developer names the file to run on the
                // command line of this development host.
                let bundle = match unsafe { Bundle::read_trusted(&path) } {
                    Ok(bundle) => bundle,
                    Err(err) => {
                        log::error!("cannot read bundle {}: {err}", path.display());
                        std::process::exit(1);
                    }
                };
                // `nsh build` copies imported assets next to the bundle.
                asset_base = path
                    .parent()
                    .map(|dir| AssetBase::Directory(dir.join("assets")));
                source = Some(AppSource::Bundle(bundle));
            }
            "--package" => package = args.next().map(PathBuf::from),
            "--root" => roots.extend(args.next().map(PathBuf::from)),
            "--trace" => trace = true,
            // The performance monitor's readings, logged once a second.
            "--fps" => fps = true,
            // Where apps keep their data (`nsh test --target ios` gives each
            // app a fresh one); the app's data directory otherwise.
            "--data-dir" => data_dir = args.next().map(PathBuf::from),
            // Foundation reads `-Key value` pairs as user defaults.
            other if other.starts_with('-') && !other.starts_with("--") => {
                args.next();
            }
            other => log::warn!("unknown argument {other}"),
        }
    }
    if let Some(path) = package {
        let (bundle, assets) = match load_package(&path, &roots) {
            Ok(loaded) => loaded,
            Err(err) => {
                log::error!("cannot run package {}: {err}", path.display());
                std::process::exit(1);
            }
        };
        asset_base = Some(AssetBase::Directory(assets));
        source = Some(AppSource::Bundle(bundle));
    }
    let source = source.unwrap_or_else(|| {
        use nsh_dev::protocol::{DEFAULT_PORT, WS_PATH};
        AppSource::DevServer(format!("ws://127.0.0.1:{DEFAULT_PORT}{WS_PATH}"))
    });
    run_app(
        source,
        AppOptions {
            trace,
            fps,
            asset_base,
            // Its caches too (downloaded images): a test's app starts with none.
            cache: data_dir.as_ref().map_or_else(Default::default, |dir| {
                nsh_engine::CacheOptions::at(nsh_engine::CacheLocation::Dir(dir.join("cache")))
            }),
            data_dir,
        },
    );
}

/// Verifies and unpacks the package at `path`, trusting `roots`.
#[cfg(target_os = "ios")]
fn load_package(
    path: &std::path::Path,
    roots: &[std::path::PathBuf],
) -> Result<(nsh_platform_ios::Bundle, std::path::PathBuf), String> {
    use nsh_engine::package::{PublicKey, TrustStore};

    let state = std::env::temp_dir().join("nsh-ios-host-trust");
    let mut trust = TrustStore::open(&state).map_err(|e| e.to_string())?;
    for root in roots {
        let key = std::fs::read_to_string(root).map_err(|e| format!("{}: {e}", root.display()))?;
        trust.add_root(PublicKey::from_base64(&key).map_err(|e| e.to_string())?);
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let loaded = nsh_engine::load_package(&mut trust, &bytes, &state.join("packages"))?;
    Ok((loaded.bundle, loaded.assets))
}

/// Not on UIKit targets: says so and exits.
#[cfg(not(target_os = "ios"))]
pub fn main() {
    eprintln!(
        "nsh-ios-host runs on UIKit targets; build it with --target aarch64-apple-ios-macabi"
    );
    std::process::exit(1);
}
