//! Maintainer tasks, run with `cargo xtask <task>`:
//!
//! - `run` (the default, and what `cargo run` runs): an example app in the
//!   machine's own development host (AppKit on macOS, GTK on Linux, Win32 on
//!   Windows), restarted when Rust code changes.
//! - `android`: the Android runtime (`libnsh.so` per ABI, `classes.dex`)
//!   into `target/android/<profile>`, where `nsh run` / `nsh package` find it.
//! - `dist`: the distribution in `dist/nsh`: the `nsh` CLI plus every
//!   prebuilt runtime, so app developers never need Rust.
//! - `ios-embed`: only the iOS embedding SDK (`NativeShell.xcframework`,
//!   `NativeShellDev.xcframework`) into `dist/nsh/embed/ios`.
//! - `web`: the WebAssembly runtime, its player and the website's demos
//!   (`website/public/play` by default).
//! - `compat`: holds this checkout to what NSH's releases froze, kept in
//!   the `nsh-compat` repository, and runs the apps of `tests/compat/`;
//!   `compat record <version>` records a release there
//!   (docs/dev/compatibility.md).

mod android;
mod compat;
mod dist;
mod ios;
mod run;
mod term;
mod web;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "xtask",
    about = "Maintainer tasks; without one, run the gallery (`cargo run`)",
    args_conflicts_with_subcommands = true
)]
struct Cli {
    /// Show the output of cargo and the other tools as it comes (`run`
    /// passes it on to `nsh`).
    #[arg(
        short,
        long,
        global = true,
        env = "NSH_VERBOSE",
        value_parser = clap::builder::BoolishValueParser::new()
    )]
    verbose: bool,
    #[command(subcommand)]
    task: Option<Task>,
    /// Without a task: `run` with these options.
    #[command(flatten)]
    run: run::RunArgs,
}

#[derive(Subcommand)]
enum Task {
    /// Run an example app (default: the gallery, in the AppKit host on
    /// macOS, the GTK host on Linux, the Win32 host on Windows) with hot
    /// reload, rebuilt and restarted when Rust code changes.
    Run(run::RunArgs),
    /// Build the Android runtime.
    Android {
        /// Optimized build.
        #[arg(long)]
        release: bool,
        /// Include development support (dev server, error overlay).
        #[arg(long)]
        dev: bool,
        /// ABIs to build (default: arm64-v8a, armeabi-v7a and x86_64).
        #[arg(long)]
        abi: Vec<String>,
    },
    /// Run clippy on the Android crate (with the NDK set up).
    ClippyAndroid,
    /// Build the distribution in `dist/nsh`.
    Dist,
    /// Build only the iOS embedding XCFrameworks.
    IosEmbed(ios::Options),
    /// Build the WebAssembly runtime and the website's demos.
    Web {
        /// Output directory.
        #[arg(long, default_value = "website/public/play")]
        out: std::path::PathBuf,
    },
    /// Hold this checkout to what NSH's releases froze (the `nsh-compat`
    /// repository), and run the apps of `tests/compat/`.
    Compat {
        #[command(subcommand)]
        record: Option<CompatTask>,
    },
}

#[derive(Subcommand)]
enum CompatTask {
    /// Record this checkout as release `version` in `nsh-compat`, to commit
    /// there.
    Record { version: String },
}

fn main() -> std::process::ExitCode {
    forget_cargo_run();
    let cli = Cli::parse();
    term::init(cli.verbose);
    match task(cli.task.unwrap_or(Task::Run(cli.run))) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            term::report(&e);
            std::process::ExitCode::FAILURE
        }
    }
}

/// Drops what `cargo run` tells xtask about its own package
/// (`CARGO_MANIFEST_DIR`, `CARGO_PKG_NAME`, ...): the cargo builds xtask
/// and `nsh` start would inherit them, and some crates' builds (ring's,
/// for one) depend on them, so each `cargo run` rebuilt what a plain
/// `cargo build` had built, and the other way round.
fn forget_cargo_run() {
    let names: Vec<_> = std::env::vars_os()
        .map(|(name, _)| name)
        .filter(|name| {
            let name = name.to_string_lossy();
            name.starts_with("CARGO_PKG_")
                || matches!(
                    &*name,
                    "CARGO_MANIFEST_DIR"
                        | "CARGO_MANIFEST_PATH"
                        | "CARGO_CRATE_NAME"
                        | "CARGO_BIN_NAME"
                        | "CARGO_PRIMARY_PACKAGE"
                )
        })
        .collect();
    for name in names {
        // SAFETY: first thing in `main`, before any other thread exists.
        unsafe { std::env::remove_var(name) };
    }
}

fn task(task: Task) -> anyhow::Result<()> {
    match task {
        Task::Run(args) => run::run(args),
        Task::Android { release, dev, abi } => {
            let abis = if abi.is_empty() {
                android::ABIS.iter().map(|a| a.to_string()).collect()
            } else {
                abi
            };
            android::build(release, dev, &abis).map(|_| ())
        }
        Task::ClippyAndroid => android::clippy(),
        Task::Dist => dist::dist(),
        Task::IosEmbed(options) => ios::build(options).map(|out| term::note(out.display())),
        Task::Web { out } => web::build(&out),
        Task::Compat { record } => compat::compat(match &record {
            Some(CompatTask::Record { version }) => Some(version),
            None => None,
        }),
    }
}
