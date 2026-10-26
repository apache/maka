//! Development host on GPUI: runs a TSX app in a GPUI window, on macOS,
//! Windows and Linux, as GPUI apps that embed it show it.
//!
//! - `nsh-gpui-host --dev-server ws://127.0.0.1:8790/ws [--trace]` loads
//!   bundles pushed by `nsh dev` / `nsh run` and reloads on every rebuild.
//! - `nsh-gpui-host --bundle <path> [--trace]` runs a built bundle (`.nshc`
//!   is QuickJS bytecode, anything else JS source).
//! - `--window-size 1200x800` sets the window size.
//! - `--fps` logs frame statistics once a second (`nsh::perf fps …`).
//! - `--app-id <id>` sets the application id (`com.example.app`); `nsh run`
//!   passes the app's (`nsh.json` `"id"`). The app's data (`nsh/storage`)
//!   is kept under the id its bundle carries, in the system's data
//!   directory.
//!
//! Without arguments it connects to the dev server on this machine.
//!
//! A library so that an app with Rust components of its own (`nsh.json`
//! `"rust"`) builds the development host with them: its `main` calls
//! `nsh_platform_gpui::set_ui_sets` and then [`main`].

/// Runs the development host (until its window closes).
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub fn main() -> std::process::ExitCode {
    use std::{env, path::PathBuf};

    use nsh_platform_gpui::{AppOptions, AppSource, AssetBase, Bundle, Limits, dev, run_app};

    dev::init_logging();
    let mut source = None;
    // As an app on its own, like the desktop runners run it.
    let mut options = AppOptions {
        limits: Limits::standalone(),
        ..AppOptions::default()
    };
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
                        return std::process::ExitCode::FAILURE;
                    }
                };
                // `nsh build` copies imported assets next to the bundle.
                options.asset_base = path
                    .parent()
                    .map(|dir| AssetBase::Directory(dir.join("assets")));
                source = Some(AppSource::Bundle(bundle));
            }
            "--trace" => options.trace = true,
            "--app-id" => {
                if let Some(id) = args.next().filter(|id| !id.is_empty()) {
                    options.app_id = id;
                }
            }
            "--fps" => options.fps = true,
            // Where apps keep their data (`nsh test --target` gives each app
            // a fresh one); the system's data directory otherwise.
            "--data-dir" => {
                options.data_dir = args.next().map(PathBuf::from);
                // Its caches too (downloaded images): a test's app starts with none.
                if let Some(dir) = &options.data_dir {
                    options.cache = nsh_engine::CacheOptions::at(nsh_engine::CacheLocation::Dir(
                        dir.join("cache"),
                    ));
                }
            }
            "--window-size" => {
                if let Some((w, h)) = args.next().as_deref().and_then(|s| s.split_once('x')) {
                    options.size = (w.parse().unwrap_or(1200), h.parse().unwrap_or(800));
                }
            }
            other => log::warn!("unknown argument {other}"),
        }
    }
    let source = source.unwrap_or_else(|| {
        use nsh_dev::protocol::{DEFAULT_PORT, WS_PATH};
        AppSource::DevServer(format!("ws://127.0.0.1:{DEFAULT_PORT}{WS_PATH}"))
    });
    options.title = "nsh".to_owned();
    run_app(source, options)
}

/// Not on the desktop: says so and exits.
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn main() -> std::process::ExitCode {
    eprintln!("nsh-gpui-host runs on macOS, Windows and Linux");
    std::process::ExitCode::FAILURE
}
