//! `nsh`, the command line tool. It links `nsh/base`; an app with Rust
//! components of its own (`nsh.json` `"rust"`) is known to it by the
//! description its describe program prints (`rust_app.rs`), and runs in the
//! hosts and runners built for it.

mod android;
mod apple;
mod bindgen;
mod build;
mod cdp;
mod check;
mod component;
mod dev;
mod dev_port;
mod entry;
mod init;
mod logger;
mod package;
mod platforms;
mod play;
mod publish_ios;
mod run;
mod runtime;
mod rust_app;
mod self_update;
mod sign;
mod test;
mod test_android;
mod test_host;
mod test_ios;
mod test_web;
mod ui;
mod updater;
mod web;
mod windows;

use std::{
    path::PathBuf,
    process::ExitCode,
    sync::{Arc, OnceLock, RwLock},
};

use anyhow::Context as _;
use clap::{Args, Parser, Subcommand};
use nsh_core::element::{Registry, description::SetDescription};

/// The UI sets this command line links: `nsh/base`.
pub(crate) fn own_sets() -> &'static [Registry] {
    static OWN: OnceLock<Vec<Registry>> = OnceLock::new();
    OWN.get_or_init(|| vec![nsh_base::registry()])
}

/// The UI sets of the command's app, as data ([`set_app_sets`]).
static UI_SETS: RwLock<Option<Arc<[SetDescription]>>> = RwLock::new(None);

/// The UI sets the hosts serve, as data: what bundles import natively,
/// what bytecode links against, what `.nsh/types` declares. `nsh/base`,
/// then an app's own sets ([`set_app_sets`]).
pub(crate) fn ui_sets() -> Arc<[SetDescription]> {
    if let Some(sets) = &*UI_SETS.read().unwrap_or_else(|e| e.into_inner()) {
        return sets.clone();
    }
    let sets: Arc<[SetDescription]> = own_sets()
        .iter()
        .flat_map(nsh_core::element::Registry::sets)
        .map(SetDescription::from)
        .collect();
    *UI_SETS.write().unwrap_or_else(|e| e.into_inner()) = Some(sets.clone());
    sets
}

/// Makes [`ui_sets`] `nsh/base` and `app`, the sets of the app's crates
/// (described again after a change to its Rust code).
pub(crate) fn set_app_sets(app: Vec<SetDescription>) {
    let sets: Arc<[SetDescription]> = own_sets()
        .iter()
        .flat_map(nsh_core::element::Registry::sets)
        .map(SetDescription::from)
        .chain(app)
        .collect();
    *UI_SETS.write().unwrap_or_else(|e| e.into_inner()) = Some(sets);
}

#[derive(Parser)]
#[command(name = "nsh", version = env!("NSH_VERSION_TEXT"), about = "Build and run nsh apps")]
struct Cli {
    /// Show everything: log lines with their targets, cargo's output and
    /// the hosts' own.
    #[arg(
        short,
        long,
        global = true,
        env = "NSH_VERBOSE",
        value_parser = clap::builder::BoolishValueParser::new()
    )]
    verbose: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Clone)]
enum Command {
    /// Create an app: in TSX, in Rust, or in TSX with a Rust crate of its
    /// own (`--template`). Generates the app's entry points, configuration
    /// and editor declarations.
    Init {
        /// Directory of the app (created if missing).
        #[arg(default_value = ".")]
        dir: PathBuf,
        /// Display name (default: the directory's name).
        #[arg(long)]
        name: Option<String>,
        /// What the app is written in (asked on a terminal; else `ts`).
        #[arg(long, value_enum)]
        template: Option<init::Template>,
        /// With `--template rust` or `mixed`: depend on the nsh crates of
        /// this checkout by path, instead of crates.io's at this CLI's
        /// version (the app's hosts build from the same place).
        #[arg(long, value_name = "DIR")]
        nsh_source: Option<PathBuf>,
    },
    /// Bundle an app and compile it to QuickJS bytecode; a Rust app
    /// (`nsh.json` `"root"`): build its crates and gather the files they ship.
    Build {
        /// The entry module, or the app's directory (default: the current one),
        /// whose `App.tsx` is the entry.
        #[arg(default_value = ".")]
        entry: PathBuf,
        /// Output directory.
        #[arg(short, long, default_value = ".nsh/out")]
        out: PathBuf,
        /// Minify and strip debug info.
        #[arg(long)]
        release: bool,
        /// Split what `import()` loads into chunk files next to the bundle
        /// (`Screen.js`, ...), loaded on demand: how web apps are published.
        #[arg(long)]
        split: bool,
    },
    /// Run an app's tests headless: its test files (`*.test.tsx`,
    /// `*.test.ts`, importing `nsh/test`), each test opening the app on an
    /// engine of its own, after the `cargo test` of its Rust crates
    /// (`nsh.json` `"rust"`) in the directory; or, given the app's entry,
    /// open it and take the steps standard input gives
    /// (`await app.press("Add")`).
    Test {
        /// A test file, a directory whose test files to run (default: the
        /// current one), or an app's entry.
        #[arg(default_value = ".")]
        path: PathBuf,
        /// The entry of the app `path` is part of (set from it).
        #[arg(skip)]
        entry: PathBuf,
        /// Run only the tests whose name contains this (`cargo test`'s
        /// too).
        #[arg(long)]
        filter: Option<String>,
        /// Print every mount batch of the apps the tests open, under the
        /// step it came in, and the time of every commit.
        #[arg(long)]
        trace: bool,
        /// Log the performance monitor's readings of the apps the tests
        /// open, once a second: frame rate, frame and commit costs, CPU,
        /// memory (`--target linux`, `macos`, `windows` or `ios`; shown with
        /// `-v`).
        #[arg(long)]
        fps: bool,
        /// Also write the results to this file as a JUnit XML report, the
        /// format CI services read.
        #[arg(long, value_name = "FILE")]
        junit: Option<PathBuf>,
        /// Run the apps the tests open on this platform's development host
        /// instead of headless: the steps act with the platform's own input
        /// (macos, linux, windows, gpui, tui, web, ios and android; tui uses
        /// an in-memory terminal; web runs them
        /// in a headless Chrome, Edge or Chromium, ios in a simulator,
        /// android on the first device adb lists).
        #[arg(long, value_enum)]
        target: Option<run::Target>,
        /// The Chrome, Edge or Chromium executable `--target web` runs the
        /// apps in (default: the one installed on this machine).
        #[arg(long, value_name = "PATH")]
        browser: Option<PathBuf>,
        /// The web page's host module (default: `nsh.json` `web.host`), which
        /// exports `createHost(player)`: in headless runs it answers the
        /// `nsh/host` calls of each app the tests open and sends its events.
        #[arg(long, value_name = "JS")]
        web_host: Option<PathBuf>,
        /// With `--target ios`: the simulator the apps run in (name or
        /// UDID); default: a booted one, else the newest iPhone.
        #[arg(long, value_name = "DEVICE")]
        device: Option<String>,
        /// With `--target macos`: the display the apps' windows open on,
        /// centered: 1 is the primary display (the one with the menu bar),
        /// 2 the next, and so on; the main one when there is no such
        /// display. Default: the first display besides the primary one
        /// (not a mirror of it), so that a run keeps off the screen in use;
        /// the primary one when there is no other.
        #[arg(long, value_name = "N", value_parser = clap::value_parser!(u32).range(1..))]
        display: Option<u32>,
        /// With `--target macos`: lets the apps become the active app, as
        /// they would run for a user. By default they run in the
        /// background: their windows show but never take the keyboard from
        /// the app in use, and the tests' input goes to them directly.
        #[arg(long)]
        foreground: bool,
    },
    /// Type check an app with TypeScript's native compiler (TypeScript 7,
    /// downloaded once from the npm registry; no Node needed); an app with
    /// Rust crates (`nsh.json` `"rust"`): `cargo check` them first, and a
    /// Rust app (`"root"`) without a `tsconfig.json` only that.
    Check {
        /// The entry module, or the app's directory (default: the current one),
        /// whose `App.tsx` is the entry.
        #[arg(default_value = ".")]
        entry: PathBuf,
        /// The `tsc` to run instead of the pinned TypeScript 7.
        #[arg(long, env = "NSH_TSC")]
        tsc: Option<PathBuf>,
        /// Further arguments for `tsc` (after `--`).
        #[arg(last = true)]
        args: Vec<String>,
    },
    /// Run an app in this system’s native host with hot reload.
    Dev {
        /// The entry module, or the app's directory (default: the current one),
        /// whose `App.tsx` is the entry.
        #[arg(default_value = ".")]
        entry: PathBuf,
        /// Dev server port (replaces the previous NSH development session on
        /// it). Default: the port this app had last, else the first free one
        /// from 8790; with --server-only, 8790.
        #[arg(long)]
        port: Option<u16>,
        /// Minify and strip debug info.
        #[arg(long)]
        release: bool,
        /// Run the app as an app embedded in another one would, with the
        /// VM limits such an app sets: `memory` and `stack` (`KB`, `MB`,
        /// `GB`), `load` and `call` (`ms`, `s`) and `nodes`, as in
        /// `--limits memory=128MB,call=500ms`; the rest keep the embedding
        /// defaults (256 MB, 4 MB, 10 s, 2 s, 200000), which `--limits`
        /// alone runs with. Without it the app runs on its own, with none.
        #[arg(long, value_name = "LIMITS", num_args = 0..=1, default_missing_value = "", value_parser = parse_limits)]
        limits: Option<nsh_core::js::HostLimits>,
        /// Where to run; defaults to this system's native desktop host.
        #[arg(long, value_enum, default_value_t = run::Target::native())]
        target: run::Target,
        /// iOS simulator to use (name or UDID).
        #[arg(long)]
        device: Option<String>,
        /// Serve hot reload to hosts you start yourself.
        #[arg(long, conflicts_with_all = ["target", "device"])]
        server_only: bool,
    },
    /// Package an installable app from the prebuilt runtime (no Rust
    /// needed). Metadata comes from `nsh.json` next to the entry, overridden
    /// by the flags below.
    Package(Box<PackageArgs>),
    /// Run an app in a development host with hot reload. Defaults to
    /// AppKit on macOS, GTK on Linux and Win32 on Windows; select mobile
    /// hosts, Mac Catalyst, GPUI, a terminal or a browser with --target.
    Run {
        /// The entry module, or the app's directory (default: the current one),
        /// whose `App.tsx` is the entry.
        #[arg(default_value = ".")]
        entry: PathBuf,
        /// Dev server port (replaces the previous NSH development session on
        /// it). Default: the port this app had last, else the first free one
        /// from 8790; with --server-only, 8790.
        #[arg(long)]
        port: Option<u16>,
        /// Minify and strip debug info.
        #[arg(long)]
        release: bool,
        /// Run the app as an app embedded in another one would, with the
        /// VM limits such an app sets: `memory` and `stack` (`KB`, `MB`,
        /// `GB`), `load` and `call` (`ms`, `s`) and `nodes`, as in
        /// `--limits memory=128MB,call=500ms`; the rest keep the embedding
        /// defaults (256 MB, 4 MB, 10 s, 2 s, 200000), which `--limits`
        /// alone runs with. Without it the app runs on its own, with none.
        #[arg(long, value_name = "LIMITS", num_args = 0..=1, default_missing_value = "", value_parser = parse_limits)]
        limits: Option<nsh_core::js::HostLimits>,
        /// Log per-commit timings.
        #[arg(long)]
        trace: bool,
        /// Show the performance monitor over the app: frame rate, frame and
        /// commit costs, CPU, GPU, memory (`--target macos` and `linux`; on
        /// `macos`, `linux`, `windows` and `ios` the host also logs its
        /// readings once a second, shown with `-v`). On `tui`, show FPS/idle,
        /// frame p95, apply/draw/flush times, bytes and changed Cells; C-h p
        /// toggles the line.
        #[arg(long)]
        fps: bool,
        /// Where to run.
        #[arg(long, value_enum, default_value_t = run::Target::native())]
        target: run::Target,
        /// iOS simulator to use (name or UDID); default: a booted one, else
        /// the newest iPhone.
        #[arg(long)]
        device: Option<String>,
        /// Points per terminal Cell, overriding nsh.json tui.pointsPerCell (default: 8x16).
        #[arg(long, value_name = "WIDTHxHEIGHT", value_parser = run::parse_points_per_cell)]
        points_per_cell: Option<String>,
        /// The app's name in the host (the menu bar, the window title;
        /// `nsh.json`'s name by default; `--target macos` only).
        #[arg(long)]
        name: Option<String>,
        /// The window's initial size, `WxH` in points (the host's default
        /// by default; the desktop hosts: `--target macos`, `linux`,
        /// `windows`, `gpui`).
        #[arg(long = "window-size", value_name = "WIDTHxHEIGHT")]
        size: Option<String>,
        /// The display the window opens on, centered: 1 is the primary
        /// display (the one with the menu bar), 2 the next, and so on; the
        /// main one when there is no such display (`--target macos` only).
        #[arg(long, value_name = "N", value_parser = clap::value_parser!(u32).range(1..))]
        display: Option<u32>,
    },
    /// Create a signing key: `<name>.secret` (keep it offline for a root)
    /// and `<name>.pub` (what apps trust, for a root).
    Keygen {
        /// Path and name of the key files, e.g. `keys/root`.
        name: PathBuf,
    },
    /// Update this nsh to the latest release, or to the latest nightly
    /// build of `main` (`nsh update nightly`, as `rustup update nightly`);
    /// it stays on the channel it was installed from unless one is named.
    Update {
        /// `stable` (the releases) or `nightly` (every night `main` changes);
        /// default: the channel this nsh is on.
        #[arg(value_enum)]
        channel: Option<self_update::Channel>,
    },
    /// Add, remove or list the runtimes installed beside this nsh: those
    /// of other platforms than this machine's (`android`, `ios`, `web`,
    /// `gpui`, `tui`), which a command that needs one also adds itself.
    Component {
        #[command(subcommand)]
        action: ComponentAction,
    },
    /// Write an app's update manifest (`latest.json`, signed with `--key`)
    /// from the archives `nsh package` made for each platform; publish them
    /// together.
    UpdateManifest {
        /// The archives named `<name>-<version>-<os>-<arch>.<ext>`.
        #[arg(required_unless_present_any = ["package", "links"])]
        archives: Vec<PathBuf>,
        /// A signed package of the app's code (`nsh publish`'s `.nshpkg`),
        /// which apps trusting its root (`updater.packages.roots`) run
        /// without a new app.
        #[arg(long)]
        package: Option<PathBuf>,
        /// The app's directory or entry, whose `nsh.json` has the id and version.
        #[arg(long, default_value = ".")]
        entry: PathBuf,
        /// The secret key (`nsh keygen`'s `.secret`) of the app's `updater.publicKey`.
        #[arg(long)]
        key: Option<PathBuf>,
        /// A text file with what changed.
        #[arg(long)]
        notes: Option<PathBuf>,
        /// Where iOS or Android users get it: `ios=<url>`, `android=<url>` (repeatable).
        #[arg(long = "link")]
        links: Vec<String>,
        /// Prefix of the archives' URLs (default: next to the manifest).
        #[arg(long)]
        base_url: Option<String>,
        /// The directory the manifest is written to.
        #[arg(short, long, default_value = ".")]
        out: PathBuf,
    },
    /// Certify a release key with a root key, for some app ids and a time
    /// window; packages carry the certificate.
    Certify {
        /// The root's secret key (`.secret`).
        #[arg(long)]
        root: PathBuf,
        /// The release key's public key (`.pub`).
        #[arg(long)]
        key: PathBuf,
        /// App ids it may sign for: `*`, `com.example.*` or an id (repeatable).
        #[arg(long = "apps", required = true)]
        apps: Vec<String>,
        /// How long it may sign, from now.
        #[arg(long, default_value_t = 365)]
        days: u64,
        /// The certificate to write.
        #[arg(short, long)]
        out: PathBuf,
    },
    /// Upload to a store, or build and sign a package (`.nshpkg`)
    /// for apps that embed nsh to verify and run. Metadata comes from
    /// `nsh.json` next to the entry, overridden by the flags below. Given a
    /// package instead of an app, signs it again with this key: only its
    /// certificate, signing time and signature change. `nsh publish ios` / `nsh publish android`
    /// uploads to a store instead.
    #[command(args_conflicts_with_subcommands = true, subcommand_negates_reqs = true)]
    Publish {
        #[command(subcommand)]
        store: Option<PublishStore>,
        /// The entry module, the app's directory (default: the current one),
        /// whose `App.tsx` is the entry, or a package (`.nshpkg`) to sign again.
        #[arg(default_value = ".")]
        entry: PathBuf,
        /// The release key's secret key (`.secret`).
        #[arg(long, required = true)]
        key: Option<PathBuf>,
        /// Its certificate (`nsh certify`).
        #[arg(long, required = true)]
        cert: Option<PathBuf>,
        /// The package to write (default: `.nsh/out/<id>-<build>.nshpkg`); a
        /// package signed again may name the one read.
        #[arg(short, long)]
        out: Option<PathBuf>,
        /// App id, e.g. `com.example.app`.
        #[arg(long)]
        id: Option<String>,
        /// Version, e.g. `1.2.0`.
        #[arg(long = "app-version")]
        version: Option<String>,
        /// Build number: must grow with every release.
        #[arg(long)]
        build: Option<u32>,
        /// Where the source map goes: into the package (devices report
        /// errors at app source positions), into a file next to it
        /// (`<package>.map`, for `nsh symbolicate`), or nowhere (default:
        /// into the package).
        #[arg(long, value_enum)]
        source_map: Option<sign::SourceMapOut>,
        /// Leave the line and column tables out of the bytecode: a smaller
        /// package whose error stacks have no positions.
        #[arg(long)]
        strip_debug: bool,
        /// The lowest runtime that runs the package, e.g. `0.2.0` (default:
        /// this CLI's version); older runtimes refuse it.
        #[arg(long, value_name = "VERSION")]
        min_runtime: Option<String>,
    },
    /// Map the positions in a reported error stack (`bundle.js:LINE:COL`)
    /// to the app's sources, with a package's source map.
    Symbolicate {
        /// The source map (`<package>.map`, `bundle.js.map`) or a package
        /// (`.nshpkg`) that holds one.
        map: PathBuf,
        /// The error text (default: standard input).
        input: Option<PathBuf>,
    },
    /// Verify a package as an app trusting the given roots would (without
    /// roots: only its signature).
    Verify {
        /// The package (`.nshpkg`).
        package: PathBuf,
        /// A trusted root's public key (`.pub`; repeatable).
        #[arg(long)]
        root: Vec<PathBuf>,
        /// A revocation list to apply.
        #[arg(long)]
        revocations: Option<PathBuf>,
    },
    /// Sign a revocation list: release keys and packages that must not load
    /// any more.
    Revoke {
        /// The root's secret key (`.secret`).
        #[arg(long)]
        root: PathBuf,
        /// Keep the entries of this list (the last one published).
        #[arg(long)]
        extend: Option<PathBuf>,
        /// The list's number: higher than any published before (default
        /// with `--extend`: that list's plus one).
        #[arg(long)]
        sequence: Option<u64>,
        /// A release key id to revoke (repeatable).
        #[arg(long = "key")]
        keys: Vec<String>,
        /// A package SHA-256 to revoke (repeatable; `nsh verify` prints it).
        #[arg(long = "package")]
        packages: Vec<String>,
        /// The list to write.
        #[arg(short, long)]
        out: PathBuf,
    },
}

/// The stores `nsh publish` uploads to.
#[derive(Subcommand, Clone)]
enum PublishStore {
    /// Upload an App Store-signed IPA to App Store Connect for TestFlight.
    Ios(publish_ios::Args),
    /// Upload an Android App Bundle (`.aab`) to Google Play's internal
    /// testing track, with a service account's JSON key.
    Android {
        /// The bundle (`.aab`) to upload.
        bundle: PathBuf,
        /// The app's directory or entry, whose `nsh.json` `id` is the
        /// package name.
        #[arg(long, default_value = ".")]
        entry: PathBuf,
        /// The package name on Google Play (default: `nsh.json` `id`).
        #[arg(long)]
        package: Option<String>,
        /// The service account's JSON key; keep it out of the repository.
        #[arg(long, env = "NSH_PLAY_CREDENTIALS", hide_env_values = true)]
        credentials: Option<PathBuf>,
        /// Release as a draft, which Play requires until the app's first
        /// release is made in Play Console.
        #[arg(long)]
        draft: bool,
    },
}

/// Arguments of `nsh package`.
#[derive(Args, Clone)]
struct PackageArgs {
    /// The entry module, or the app's directory (default: the current one),
    /// whose `App.tsx` is the entry.
    #[arg(default_value = ".")]
    entry: PathBuf,
    /// What to build for.
    #[arg(long, value_enum)]
    target: package::PackageTarget,
    /// Output directory.
    #[arg(short, long, default_value = ".nsh/out")]
    out: PathBuf,
    /// Display name.
    #[arg(long)]
    name: Option<String>,
    /// Bundle identifier, e.g. `com.example.app`.
    #[arg(long)]
    id: Option<String>,
    /// Version, e.g. `1.2.0`.
    #[arg(long = "app-version")]
    version: Option<String>,
    /// Build number.
    #[arg(long)]
    build: Option<u32>,
    /// App icon: a square PNG, ideally 1024×1024.
    #[arg(long)]
    icon: Option<PathBuf>,
    /// Code signing identity for devices, e.g. "Apple Development: …".
    #[arg(long)]
    sign: Option<String>,
    /// Provisioning profile for devices (`.mobileprovision`).
    #[arg(long)]
    profile: Option<PathBuf>,
    /// Android release keystore (default: the debug key).
    #[arg(long, requires = "key_alias")]
    keystore: Option<PathBuf>,
    /// Key alias in the keystore.
    #[arg(long)]
    key_alias: Option<String>,
    /// Keystore password (also `NSH_KEYSTORE_PASSWORD`).
    #[arg(long, env = "NSH_KEYSTORE_PASSWORD", hide_env_values = true)]
    keystore_password: Option<String>,
    /// Android ABIs of the APK, repeated or separated by commas (default:
    /// arm64-v8a and armeabi-v7a; with --run also the device's).
    #[arg(long, value_delimiter = ',', value_parser = crate::android::ABIS)]
    abi: Vec<String>,
    /// Android: what to write, an APK (installed directly) or an Android
    /// App Bundle (`aab`, uploaded to Google Play).
    #[arg(long, value_enum, default_value_t)]
    format: crate::android::Format,
    /// macOS: the processors the app runs on, `arm64` (Apple silicon),
    /// `x86_64` (Intel) or `universal` (both, in one executable). Default:
    /// this Mac's.
    #[arg(long, value_enum)]
    arch: Option<package::Arch>,
    /// Install and launch the app in the simulator or on the Android device
    /// afterwards (Linux, macOS, Windows: launch it; web: serve it on this
    /// machine at the address it prints).
    #[arg(long)]
    run: bool,
    /// Web: the http(s) URL the site's files are served from, a CDN
    /// (`https://cdn.example.com/app/`), as the page names them; `index.html`
    /// stays at the page's address. Default: next to the page, named
    /// relatively, so the site runs from any directory.
    #[arg(long, value_name = "URL", conflicts_with = "run")]
    asset_url: Option<String>,
}

/// `nsh component`'s actions.
#[derive(Subcommand, Clone)]
enum ComponentAction {
    /// The components of this machine's release, installed or not.
    List,
    /// Download and install components of this nsh's release.
    Add {
        /// Their names (`nsh component list`).
        #[arg(required = true)]
        names: Vec<String>,
    },
    /// Remove installed components.
    Remove {
        /// Their names.
        #[arg(required = true)]
        names: Vec<String>,
    },
    /// Move each component out of this distribution into its release
    /// archive (the release workflow's).
    #[command(hide = true)]
    Pack {
        /// The directory the archives are written to.
        #[arg(long)]
        out: PathBuf,
    },
}

impl Command {
    /// The entry argument of the commands that build an app.
    fn entry_mut(&mut self) -> Option<&mut PathBuf> {
        match self {
            Command::Build { entry, .. }
            | Command::Test { entry, .. }
            | Command::Check { entry, .. }
            | Command::Dev { entry, .. }
            | Command::Run { entry, .. }
            | Command::Publish { entry, .. } => Some(entry),
            Command::Package(args) => Some(&mut args.entry),
            Command::Init { .. }
            | Command::Keygen { .. }
            | Command::Update { .. }
            | Command::Component { .. }
            | Command::UpdateManifest { .. }
            | Command::Certify { .. }
            | Command::Verify { .. }
            | Command::Symbolicate { .. }
            | Command::Revoke { .. } => None,
        }
    }
}

/// Runs the command line; errors are printed.
fn main() -> ExitCode {
    // `--target` naming a platform outside NSH: its executable runs the
    // command (`platforms.rs`).
    let args: Vec<_> = std::env::args_os().collect();
    if let Some(result) = platforms::dispatch(&args) {
        return result.unwrap_or_else(|e| {
            ui::init(false);
            ui::report(&e);
            ExitCode::FAILURE
        });
    }
    let cli = Cli::parse_from(args);
    ui::init(cli.verbose);
    logger::init();
    let result = run(cli.command);
    // A signal stopped the command (`ui::Stoppable`): it ends as the signal
    // would have, and what failed as it stopped (a tool it interrupted) is
    // no news.
    ui::exit_if_stopped();
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            ui::report(&e);
            ExitCode::FAILURE
        }
    }
}

/// `--limits`' value ([`nsh_core::js::HostLimits::parse`]).
fn parse_limits(spec: &str) -> Result<nsh_core::js::HostLimits, String> {
    nsh_core::js::HostLimits::parse(spec)
}

/// Refuses `--limits` for an app of Rust only: they are its JS VM's, and it
/// runs no JS.
fn no_limits_for_rust(
    entry: &std::path::Path,
    limits: Option<nsh_core::js::HostLimits>,
) -> anyhow::Result<()> {
    if limits.is_some() && rust_app::is_root(entry) {
        anyhow::bail!(
            "--limits sets the limits of an app's JS VM, and an app of Rust only runs no JS"
        );
    }
    Ok(())
}

fn run(mut command: Command) -> anyhow::Result<()> {
    if let Command::Publish {
        store: Some(store), ..
    } = command
    {
        return match store {
            PublishStore::Ios(args) => publish_ios::publish(&args),
            PublishStore::Android {
                bundle,
                entry,
                package,
                credentials,
                draft,
            } => play::publish(&bundle, &entry, package, credentials, draft),
        };
    }
    // A package given to `nsh publish` has no app to resolve or build.
    if let Command::Publish {
        store: _,
        entry,
        key: Some(key),
        cert: Some(cert),
        out,
        id,
        version,
        build,
        source_map,
        strip_debug,
        min_runtime,
    } = &command
        && sign::is_package(entry)
    {
        let build_flags = [
            ("--id", id.is_some()),
            ("--app-version", version.is_some()),
            ("--build", build.is_some()),
            ("--source-map", source_map.is_some()),
            ("--strip-debug", *strip_debug),
            ("--min-runtime", min_runtime.is_some()),
        ];
        if let Some((flag, _)) = build_flags.iter().find(|(_, given)| *given) {
            anyhow::bail!(
                "{flag} applies to a build: a package signed again keeps its contents as they are"
            );
        }
        return sign::resign(entry, key, cert, out.clone());
    }
    let mut types = true;
    // The app a test's path is part of.
    if let Command::Test { path, entry, .. } = &mut command {
        *path = dunce::canonicalize(&*path).with_context(|| format!("{}", path.display()))?;
        *entry = test::app_entry(path)?;
    }
    if let Some(entry) = command.entry_mut() {
        *entry = entry::resolve(entry)?;
        // A Rust app has no TypeScript to declare things for, unless it
        // keeps TypeScript tests (a `tsconfig.json` for them).
        types &= check::has_typescript(entry);
    }
    // Own the port across builds and restarts, until every host and forwarding
    // rule from this command has been cleaned up.
    let _port = match &mut command {
        Command::Dev {
            entry,
            port,
            server_only: true,
            ..
        } => {
            // Apps embedding the SDK keep a server's address in their code.
            let port = port.get_or_insert(nsh_dev::protocol::DEFAULT_PORT);
            dev_port::Session::acquire(*port, entry)?
        }
        Command::Run { entry, port, .. } | Command::Dev { entry, port, .. } => match port {
            Some(port) => dev_port::Session::acquire(*port, entry)?,
            None => {
                let (session, free) = dev_port::Session::acquire_free(entry)?;
                *port = Some(free);
                session
            }
        },
        _ => None,
    };
    // A Rust app (`nsh.json` "root") has no bundle: it is built, checked,
    // tested, run and packaged.
    let rust_command = matches!(
        command,
        Command::Build { .. }
            | Command::Check { .. }
            | Command::Test { .. }
            | Command::Package(_)
            | Command::Run { .. }
            | Command::Dev {
                server_only: false,
                ..
            }
    );
    if let Some(entry) = command.entry_mut()
        && rust_app::is_root(entry)
        && !rust_command
    {
        anyhow::bail!(
            "{} declares a Rust app (\"root\"): it is built with `nsh build`, checked with `nsh check`, \
             tested with `nsh test`, run with `nsh run` and packaged with `nsh package`; the other \
             commands take a TSX entry",
            ui::path(entry)
        );
    }
    let app = match command.entry_mut() {
        Some(entry) => rust_app::of(entry)?,
        None => None,
    };
    let Some(app) = app else {
        if let Some(entry) = command.entry_mut() {
            if rust_app::is_root(entry) {
                anyhow::bail!("nsh.json: \"root\" needs \"rust\", the path of the app's crate");
            }
            if types {
                init::write_types_for(entry);
            }
        }
        return dispatch(command);
    };
    // An app with Rust crates of its own: described by the program built
    // from them, its hosts built with them. A development session ends
    // when its Rust code changes, and starts again with it built anew.
    rust_app::set_current(app.clone());
    // Its crates are checked with cargo before anything is described from
    // them: their errors are cargo's own. A Rust app without TypeScript
    // has nothing else to check.
    if let Command::Check { entry, .. } = &command {
        check::cargo_check(&app)?;
        if !check::has_typescript(entry) {
            return Ok(());
        }
    }
    let mut restarted = false;
    loop {
        if ui::stop_requested() {
            return Ok(());
        }
        match app.describe() {
            Ok(sets) => set_app_sets(sets),
            // Its build failed and waited for the next change already.
            Err(e) if e.downcast_ref::<rust_app::Restart>().is_some() => continue,
            // The code just saved does not describe: wait for the fix.
            Err(e) if restarted => {
                app.wait_after(&e)?;
                continue;
            }
            Err(e) => return Err(e),
        }
        if types && let Some(entry) = command.entry_mut() {
            init::write_types_for(entry);
        }
        match dispatch(command.clone()) {
            Err(e) if e.downcast_ref::<rust_app::Restart>().is_some() && !ui::stop_requested() => {
                restarted = true;
                rust_app::set_restarted();
                ui::note("the app's Rust code changed: building it again");
            }
            result => return result,
        }
    }
}

fn dispatch(command: Command) -> anyhow::Result<()> {
    match command {
        Command::Init {
            dir,
            name,
            template,
            nsh_source,
        } => {
            let template = match template {
                Some(template) => template,
                None => init::Template::ask()?,
            };
            init::init(&dir, name, template, nsh_source.as_deref())
        }
        Command::Build {
            entry,
            out,
            release,
            split,
        } => build::build(&entry, &out, release, split),
        Command::Check { entry, tsc, args } => check::check(&entry, tsc.as_deref(), &args),
        Command::Test {
            path,
            entry,
            filter,
            trace,
            fps,
            junit,
            target,
            browser,
            web_host,
            device,
            display,
            foreground,
        } => test::test(
            &path,
            &entry,
            filter,
            trace,
            fps,
            junit.as_deref(),
            target,
            browser.as_deref(),
            web_host,
            device.as_deref(),
            display.map(|n| n as usize),
            foreground,
        ),
        Command::Dev {
            entry,
            port,
            release,
            limits,
            target,
            device,
            server_only,
        } => {
            no_limits_for_rust(&entry, limits)?;
            // `--server-only` serves hosts started elsewhere, on other
            // machines too; a host `nsh dev` starts is on the network only
            // as `nsh run` starts it.
            let listen = dev::Listen {
                port: port.unwrap_or_default(),
                network: server_only || target.uses_network(),
            };
            if server_only {
                let session = dev::DevSession::start(&entry, listen, release, limits)?;
                session.print_urls();
                session.watch(|| Ok(false))
            } else {
                run::run(
                    &entry,
                    listen,
                    release,
                    run::HostFlags {
                        limits,
                        trace: false,
                        fps: false,
                        points_per_cell: None,
                    },
                    target,
                    device.as_deref(),
                    run::HostWindow::default(),
                )
            }
        }
        Command::Package(args) => {
            let PackageArgs {
                entry,
                target,
                out,
                name,
                id,
                version,
                build,
                icon,
                sign,
                profile,
                keystore,
                key_alias,
                keystore_password,
                abi,
                format,
                arch,
                run,
                asset_url,
            } = *args;
            let mut config = package::read_config(&entry)?;
            config.name = name.or(config.name);
            config.id = id.or(config.id);
            config.version = version.or(config.version);
            config.build = build.or(config.build);
            config.icon = icon.map(package::AppIcon::All).or(config.icon);
            package::package(package::PackageOptions {
                entry: &entry,
                target,
                out: &out,
                config,
                sign: sign.as_deref(),
                profile: profile.as_deref(),
                keystore: keystore.as_deref().map(|k| {
                    (
                        k,
                        key_alias.as_deref().unwrap_or_default(),
                        keystore_password.as_deref().unwrap_or_default(),
                    )
                }),
                abis: &abi,
                format,
                arch,
                run,
                asset_url: asset_url.as_deref(),
            })
        }
        Command::Run {
            entry,
            port,
            release,
            limits,
            trace,
            fps,
            target,
            device,
            name,
            size,
            display,
            points_per_cell,
        } => {
            no_limits_for_rust(&entry, limits)?;
            run::run(
                &entry,
                dev::Listen {
                    port: port.unwrap_or_default(),
                    network: target.uses_network(),
                },
                release,
                run::HostFlags {
                    limits,
                    trace,
                    fps,
                    points_per_cell,
                },
                target,
                device.as_deref(),
                run::HostWindow {
                    name: name.as_deref(),
                    size: size.as_deref(),
                    display: display.map(|n| n as usize),
                },
            )
        }
        Command::Keygen { name } => sign::keygen(&name),
        Command::Update { channel } => self_update::update(channel),
        Command::Component { action } => match action {
            ComponentAction::List => component::list(),
            ComponentAction::Add { names } => component::add_named(&names),
            ComponentAction::Remove { names } => component::remove_named(&names),
            ComponentAction::Pack { out } => component::pack(&out),
        },
        Command::UpdateManifest {
            archives,
            package,
            entry,
            key,
            notes,
            links,
            base_url,
            out,
        } => updater::manifest(updater::ManifestOptions {
            archives: &archives,
            package: package.as_deref(),
            entry: &entry,
            key: key.as_deref(),
            notes: notes.as_deref(),
            links: &links,
            base_url: base_url.as_deref(),
            out: &out,
        }),
        Command::Certify {
            root,
            key,
            apps,
            days,
            out,
        } => sign::certify_key(&root, &key, &apps, days, &out),
        Command::Publish {
            store: _,
            entry,
            key,
            cert,
            out,
            id,
            version,
            build,
            source_map,
            strip_debug,
            min_runtime,
        } => {
            let mut config = package::read_config(&entry)?;
            config.id = id.or(config.id);
            config.version = version.or(config.version);
            config.build = build.or(config.build);
            config.min_runtime = min_runtime.or(config.min_runtime);
            let (Some(key), Some(cert)) = (key, cert) else {
                anyhow::bail!("nsh publish needs --key and --cert");
            };
            sign::publish(sign::PublishOptions {
                entry: &entry,
                key: &key,
                cert: &cert,
                out,
                config,
                source_map: source_map.unwrap_or(sign::SourceMapOut::Package),
                strip_debug,
            })
        }
        Command::Symbolicate { map, input } => sign::symbolicate(&map, input.as_deref()),
        Command::Verify {
            package,
            root,
            revocations,
        } => sign::verify(&package, &root, revocations.as_deref()),
        Command::Revoke {
            root,
            extend,
            sequence,
            keys,
            packages,
            out,
        } => sign::revoke_list(&root, extend.as_deref(), sequence, &keys, &packages, &out),
    }
}

#[cfg(test)]
mod command_tests {
    use clap::Parser as _;

    use super::{Cli, Command, run::Target};

    #[test]
    fn publish_ios_and_package_signing_have_separate_arguments() {
        let cli = Cli::try_parse_from([
            "nsh",
            "publish",
            "ios",
            "app.ipa",
            "--app-id",
            "123",
            "--issuer-id",
            "issuer",
            "--key-id",
            "KEY123",
            "--private-key",
            "key.p8",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Command::Publish {
                store: Some(super::PublishStore::Ios(_)),
                ..
            }
        ));
        assert!(Cli::try_parse_from(["nsh", "publish"]).is_err());
        for entry in [".", "./ios", "app.nshpkg"] {
            let cli = Cli::try_parse_from([
                "nsh",
                "publish",
                entry,
                "--key",
                "key.secret",
                "--cert",
                "key.cert",
            ])
            .unwrap();
            assert!(matches!(cli.command, Command::Publish { store: None, .. }));
        }
        assert!(
            Cli::try_parse_from([
                "nsh",
                "publish",
                "ios",
                "app.ipa",
                "--key",
                "key.secret",
                "--cert",
                "key.cert"
            ])
            .is_err()
        );
    }

    /// Signing a package again changes no contents, so a flag that shapes a
    /// build is refused rather than ignored, before any file is read.
    #[test]
    fn publishing_a_package_refuses_the_flags_of_a_build() {
        for (flag, args) in [
            ("--id", &["--id", "a.b"][..]),
            ("--app-version", &["--app-version", "2.0.0"]),
            ("--build", &["--build", "2"]),
            ("--source-map", &["--source-map", "package"]),
            ("--strip-debug", &["--strip-debug"]),
            ("--min-runtime", &["--min-runtime", "0.2.0"]),
        ] {
            let mut line = vec!["nsh", "publish", "a.nshpkg", "--key", "k", "--cert", "c"];
            line.extend_from_slice(args);
            let error = super::run(Cli::try_parse_from(line).unwrap().command).unwrap_err();
            assert!(error.to_string().starts_with(flag), "{flag}: {error}");
        }
    }

    /// `nsh publish android` is a store upload and needs no signing key;
    /// `nsh publish` of an app still does.
    #[test]
    fn publish_android_is_a_store_upload() {
        let cli = Cli::try_parse_from(["nsh", "publish", "android", "app.aab", "--draft"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Publish { store: Some(super::PublishStore::Android { bundle, draft: true, .. }), .. }
                if bundle == std::path::Path::new("app.aab")
        ));
        assert!(Cli::try_parse_from(["nsh", "publish", "."]).is_err());
        assert!(Cli::try_parse_from(["nsh", "publish", "android", "a.aab", "--key", "k"]).is_err());
    }

    #[test]
    fn version_includes_the_source_revision() {
        for flag in ["-V", "--version"] {
            let error = Cli::try_parse_from(["nsh", flag])
                .err()
                .expect("version exits");
            assert_eq!(error.kind(), clap::error::ErrorKind::DisplayVersion);
            let text = error.to_string();
            let prefix = format!("nsh {} ({}", env!("CARGO_PKG_VERSION"), env!("NSH_GIT_SHA"));
            let rest = text.strip_prefix(&prefix).expect("version and revision");
            if env!("NSH_CHANNEL") == "nightly" {
                // ` nightly YYYY-MM-DD)`: the date it was built.
                let date = rest
                    .strip_prefix(" nightly ")
                    .and_then(|r| r.strip_suffix(")\n"))
                    .expect("nightly build date");
                assert!(
                    date.len() == 10 && date.as_bytes()[4] == b'-' && date.as_bytes()[7] == b'-'
                );
            } else {
                assert_eq!(rest, ")\n");
            }
        }
    }

    #[test]
    fn generated_outputs_default_to_the_project_cache() {
        let cli = Cli::try_parse_from(["nsh", "build"]).unwrap();
        assert!(
            matches!(cli.command, Command::Build { out, .. } if out == std::path::Path::new(".nsh/out"))
        );
        let cli = Cli::try_parse_from(["nsh", "package", "--target", "web"]).unwrap();
        assert!(
            matches!(cli.command, Command::Package(args) if args.out == std::path::Path::new(".nsh/out"))
        );
        let cli = Cli::try_parse_from(["nsh", "build", "--out", "custom"]).unwrap();
        assert!(
            matches!(cli.command, Command::Build { out, .. } if out == std::path::Path::new("custom"))
        );
    }

    #[test]
    fn macos_packages_name_their_processors() {
        use super::package::Arch;
        let arch = |args: &[&str]| {
            let mut line = vec!["nsh", "package", "--target", "macos"];
            line.extend_from_slice(args);
            match Cli::try_parse_from(line).map(|cli| cli.command) {
                Ok(Command::Package(args)) => Ok(args.arch),
                Ok(_) => panic!("expected nsh package"),
                Err(e) => Err(e),
            }
        };
        assert_eq!(arch(&[]).unwrap(), None);
        for (value, expected) in [
            ("arm64", Arch::Arm64),
            ("aarch64", Arch::Arm64),
            ("x86_64", Arch::X86_64),
            ("universal", Arch::Universal),
        ] {
            assert_eq!(arch(&["--arch", value]).unwrap(), Some(expected), "{value}");
        }
        for value in ["x86-64", "i386", "x86_64-apple-darwin"] {
            assert!(arch(&["--arch", value]).is_err(), "{value}");
        }
    }

    #[test]
    fn dev_and_run_default_to_this_systems_desktop_host() {
        let expected = if cfg!(target_os = "macos") {
            Target::Macos
        } else if cfg!(target_os = "linux") {
            Target::Linux
        } else if cfg!(windows) {
            Target::Windows
        } else {
            Target::Web
        };
        for command in ["dev", "run"] {
            let cli = Cli::try_parse_from(["nsh", command]).unwrap();
            let target = match cli.command {
                Command::Dev {
                    target,
                    server_only: false,
                    ..
                }
                | Command::Run { target, .. } => target,
                _ => panic!("expected a host command"),
            };
            assert_eq!(target, expected);
        }
    }

    #[test]
    fn mobile_hosts_are_selected_explicitly() {
        for command in ["dev", "run"] {
            for (value, expected) in [("ios", Target::Ios), ("android", Target::Android)] {
                let cli = Cli::try_parse_from(["nsh", command, "--target", value]).unwrap();
                let target = match cli.command {
                    Command::Dev { target, .. } | Command::Run { target, .. } => target,
                    _ => panic!("expected a host command"),
                };
                assert_eq!(target, expected);
            }
        }
    }

    #[test]
    fn dev_can_serve_hosts_started_separately() {
        let cli = Cli::try_parse_from(["nsh", "dev", "--server-only"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Dev {
                server_only: true,
                ..
            }
        ));
        assert!(Cli::try_parse_from(["nsh", "dev", "--server-only", "--target", "ios"]).is_err());
    }
}
