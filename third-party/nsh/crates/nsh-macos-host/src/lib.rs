//! Development host on macOS: runs any nsh app in an AppKit window.
//!
//! - `nsh-macos-host --dev-server ws://127.0.0.1:8790/ws [--trace]` loads
//!   bundles pushed by `nsh dev` / `nsh run` and reloads on every rebuild.
//! - `nsh-macos-host --bundle <path> [--trace]` runs a built bundle (`.nshc`
//!   is QuickJS bytecode, anything else JS source).
//!
//! - `--fps` shows the performance monitor (frame rate, frame and commit
//!   costs, CPU, GPU, memory) at the top right.
//! - `--window-size 1200x800` sets the window size (1200×800 by default; 390x844
//!   shows an app's phone layout).
//! - `--display <n>` centers the window on display `n`: 1 is the primary
//!   display (the one with the menu bar), 2 the next in the system's list,
//!   and so on; the main one when there is no such display. `--display
//!   secondary` (what `nsh test` passes unless told a display) centers it on
//!   the first display besides the primary one that does not mirror it, the
//!   primary one when there is none.
//! - `--keep-window-size` keeps the window at its size when it does not fit
//!   on its display, where AppKit would shrink it (what `nsh test` passes:
//!   a test's window is the size the test asks for).
//! - `--name <name>` names the app (the menu bar, the window title; `nsh
//!   run` passes the app's name), "nsh" by default.
//! - `--app-id <id>` sets the application id (`com.example.app`); `nsh run`
//!   passes the app's (`nsh.json` `"id"`). The app's data (`Storage` of `nsh`)
//!   is kept under the id its bundle carries, in the system's data
//!   directory.
//!
//! Without arguments it connects to the dev server on this machine.
//!
//! A library so that an app with Rust components of its own (`nsh.json`
//! `"rust"`) builds the development host with them: its `main` calls
//! `nsh_platform_macos::set_ui_sets` and then [`main`].

/// Runs the development host (until its window closes).
#[cfg(target_os = "macos")]
pub fn main() -> std::process::ExitCode {
    use std::{env, path::PathBuf};

    use nsh_platform_macos::{
        AppOptions, AppSource, AssetBase, Bundle, Limits, WindowDisplay, dev, run_app,
    };

    dev::init_logging();
    let mut source = None;
    // Named "nsh" unless `--name` names the app.
    // As the release runner runs the app: on its own.
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
                // `nsh build --split` writes the chunks `import()` loads
                // next to the bundle.
                options.chunks = path.parent().map(std::path::Path::to_path_buf);
                source = Some(AppSource::Bundle(bundle));
            }
            "--trace" => options.trace = true,
            "--app-id" => {
                if let Some(id) = args.next().filter(|id| !id.is_empty()) {
                    options.app_id = id;
                }
            }
            "--name" => {
                if let Some(name) = args.next().filter(|n| !n.is_empty()) {
                    options.title = name;
                }
            }
            // The performance monitor over the app.
            "--fps" => options.fps = true,
            // Where apps keep their data (`nsh test --target` gives each app
            // a fresh one); the system's data directory otherwise.
            "--data-dir" => {
                options.data_dir = args.next().map(std::path::PathBuf::from);
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
            // A test's window keeps the size it asks for on a shorter display.
            "--keep-window-size" => options.keep_size = true,
            // One-based, as `nsh run` / `nsh test --display` count them.
            "--display" => match args.next().as_deref() {
                Some("secondary") => options.display = Some(WindowDisplay::Secondary),
                Some(n) => match n.parse::<usize>() {
                    Ok(n) if n > 0 => options.display = Some(WindowDisplay::Index(n - 1)),
                    _ => log::warn!("--display takes a display's number, from 1, or `secondary`"),
                },
                None => log::warn!("--display takes a display's number, from 1, or `secondary`"),
            },
            // AppKit's own (`-ApplePersistenceIgnoreState YES`).
            other if other.starts_with('-') && !other.starts_with("--") => {
                args.next();
            }
            other => log::warn!("unknown argument {other}"),
        }
    }
    let source = source.unwrap_or_else(|| {
        use nsh_dev::protocol::{DEFAULT_PORT, WS_PATH};
        AppSource::DevServer(format!("ws://127.0.0.1:{DEFAULT_PORT}{WS_PATH}"))
    });
    run_app(source, options)
}

/// Not on macOS: says so and exits.
#[cfg(not(target_os = "macos"))]
pub fn main() -> std::process::ExitCode {
    eprintln!("nsh-macos-host runs on macOS");
    std::process::ExitCode::FAILURE
}
