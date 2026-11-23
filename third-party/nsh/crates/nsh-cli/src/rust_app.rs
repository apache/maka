//! Apps with Rust components of their own: `"rust": "<crate dir>"` in
//! `nsh.json` (or a list of them, [`crates`]) names library crates, each
//! with a `#[native_module("<specifier>")]` function at its root, which
//! registers its components and modules into a UI set the app imports by
//! that specifier. The attribute makes the entry the generated code calls
//! ([`ENTRY`]); each crate is linked under a name of its own
//! ([`AppCrate::name`]), so their entries do not clash. The nshm the app
//! installs (`"dependencies"`) and those its crates depend on through Cargo
//! ([`cargo_nshm`]) are linked the same way, after them.
//!
//! The prebuilt `nsh` does not link such components, and never needs to:
//! the toolchain reads a UI set as data (nsh-core `ui::description`). `nsh`
//! writes a Cargo workspace in `.nsh/rust` ([`RustApp::write_workspace`])
//! with:
//!
//! - `describe`, a program of nsh-core and the app's crates only, which
//!   calls each crate's entry and prints the sets' description: their
//!   exports and kinds, TypeScript declarations, re-exports and files.
//!   `nsh` builds and runs it before every command on the app
//!   ([`RustApp::describe`]; Cargo says whether the crates changed, the
//!   output is kept in `.nsh/rust/description.json` until they do), then
//!   bundles, compiles bytecode, writes `.nsh/types`, serves and packages
//!   the app itself;
//! - the iOS, macOS, Linux, Windows and GPUI development hosts and release
//!   runners, the Android library and the web runtime (a WebAssembly
//!   module, [`RustApp::web`]), each linking the app's crates: `nsh` builds
//!   the ones a command needs ([`RustApp::runtime`], [`RustApp::android`])
//!   instead of taking the prebuilt ones;
//! - `test`, the headless runner of `nsh test` (`nsh_testing::runner`):
//!   engines with the app's crates, which run the test files and the apps
//!   they open (for a Rust app, its root) with the bytecode `nsh` compiles
//!   for it ([`RustApp::test_runner`]);
//! - for a Rust app (`nsh.json` `"root"`), its runners without a JS
//!   runtime: `rust-<platform>`, with no QuickJS, so such an app never
//!   builds the JS engine, the bundler or the CLI to run.
//!
//! During `nsh dev` / `nsh run` a change to the app's Rust code ends the
//! session ([`Restart`]); the command describes the app again, builds what
//! it runs anew and starts again in the same process (a build that fails
//! then waits for the next change: [`RustApp::wait_after`]).
//!
//! The workspace takes nsh's crates where the app's crates do
//! ([`Nsh::of`]): from crates.io at this `nsh`'s version ([`VERSION`]: the
//! generated code calls their API), or from the checkout they depend on by
//! path or Git, with the app's crates.io and Git dependencies on nsh patched
//! to that checkout. A direct Git pin Cargo resolves to a checkout must name
//! this `nsh`'s own revision (or, when either revision is unknown, its
//! version): a mismatch stops the command before it writes a workspace,
//! instead of silently rewriting the app's manifests. A crates.io
//! requirement another version does not satisfy is rewritten to this one
//! ([`write_retargeted`]). It builds in the app's own `target`, as a Cargo
//! project in the app's directory would, or in `CARGO_TARGET_DIR`.

use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context as _, bail};
use nsh_core::element::description::{Description, SetDescription};
use sha2::{Digest as _, Sha256};

use crate::{apple::AppleMinimums, runtime::Platform, ui};

/// The function `#[native_module]` makes at the root of the app's crate
/// (`nsh-macros` `native_module.rs`): the crate's UI set.
const ENTRY: &str = "__nsh_native_module";

/// The prefix of the function `#[native_components(<platform>)]` makes at
/// the root of the app's crate (`nsh-macros` `native_components.rs`): the
/// native components it registers on that platform.
const COMPONENTS_ENTRY: &str = "__nsh_native_components_";

/// The app of this command, if it has Rust crates ([`set_current`]).
static CURRENT: std::sync::Mutex<Option<RustApp>> = std::sync::Mutex::new(None);

/// Set once a development session started again after a change to the
/// app's Rust code: a failed build then waits for the next change instead
/// of ending the session ([`RustApp::build_with`]).
static RESTARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Set by `nsh run --release`: the development host is an optimized
/// (`--release`) build too, so what the session shows runs at the speed
/// the app ships at ([`RustApp::host`]).
static RELEASE_HOSTS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Builds this command's development hosts optimized ([`RELEASE_HOSTS`]).
pub(crate) fn set_release_hosts() {
    RELEASE_HOSTS.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// What `nsh package` names and versions the app (`--id`, `--name`,
/// `--version`, `--build`), so a Rust app's root reports the package's
/// identity (`nsh_core::element::app_info`), as a TSX app's `appInfo()`
/// does; `None`: not packaging, `nsh.json`'s.
static PACKAGE: std::sync::Mutex<Option<PackageIdentity>> = std::sync::Mutex::new(None);

/// `nsh package`'s identity flags ([`PACKAGE`]).
#[derive(Debug, Clone, Default)]
pub(crate) struct PackageIdentity {
    pub(crate) id: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) build: Option<u32>,
}

/// Makes this command a package of `identity` ([`PACKAGE`]), before the
/// workspace is written.
pub(crate) fn set_package_identity(identity: PackageIdentity) {
    *PACKAGE.lock().unwrap_or_else(|e| e.into_inner()) = Some(identity);
}

/// The platform crate features `nsh package` builds the release runner
/// with (`crate::native_features`); `None`: all of them.
static RUNNER_FEATURES: std::sync::Mutex<Option<Vec<String>>> = std::sync::Mutex::new(None);

/// Builds this command's release runners with only `features` of their
/// platform crate ([`RUNNER_FEATURES`]).
pub(crate) fn set_runner_features(features: Vec<String>) {
    *RUNNER_FEATURES.lock().unwrap_or_else(|e| e.into_inner()) = Some(features);
}

/// The features a release runner's crate forwards to its runner library
/// (`nsh-windows-app`, ...) for the platform crate `platform`: the
/// library's defaults, so a build that names none of them is the whole
/// runner it always was.
fn runner_features(platform: &str) -> &'static [&'static str] {
    const ALL: &[&str] = &[
        "js",
        "shader",
        "editor",
        "emoji-picker",
        "highlight",
        "math",
        "plot",
        "rich-editor",
        "term",
        "zlib",
        "crypto",
        "websocket",
        "updater",
        "svg",
    ];
    const LINUX: &[&str] = &[
        "js",
        "shader",
        "editor",
        "emoji-picker",
        "highlight",
        "math",
        "plot",
        "rich-editor",
        "term",
        "zlib",
        "crypto",
        "webview",
        "websocket",
        "updater",
        "svg",
        "net",
        "sound",
    ];
    const WINDOWS: &[&str] = &[
        "js",
        "shader",
        "editor",
        "emoji-picker",
        "highlight",
        "math",
        "plot",
        "rich-editor",
        "term",
        "zlib",
        "crypto",
        "webview",
        "websocket",
        "updater",
        "svg",
        "net",
        "media",
    ];
    match platform {
        "nsh-platform-linux" => LINUX,
        "nsh-platform-windows" => WINDOWS,
        _ => ALL,
    }
}

/// The cargo arguments of a release runner of `platform`: its features
/// when [`set_runner_features`] chose some, each the runner's crate has
/// (`net` is not macOS's), plus those no import tells about (Linux's
/// `sound`, Windows' `media`).
fn runner_feature_args(platform: &str) -> Vec<String> {
    let Some(chosen) = RUNNER_FEATURES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    else {
        return Vec::new();
    };
    let has = runner_features(platform);
    let kept: Vec<&str> = has
        .iter()
        .copied()
        .filter(|f| matches!(*f, "sound" | "media") || chosen.iter().any(|c| c == f))
        .collect();
    vec![
        "--no-default-features".into(),
        "--features".into(),
        kept.join(","),
    ]
}

/// Makes `app` the app of this command ([`current`]).
pub(crate) fn set_current(app: RustApp) {
    *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
}

/// Forgets the app of this command: a TSX app whose own runner could not
/// be built ([`runner_only`]) ships the prebuilt one instead.
pub(crate) fn clear_current() {
    *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// The app of this command, if it has Rust crates of its own.
/// The app's own Rust code may make a web view: a source file under one
/// of its crates' directories spells `WebView` or `web_view`. Its runner
/// keeps `webview` then, as no bundle import tells about it (#2377).
pub(crate) fn may_make_web_view(app: &RustApp) -> bool {
    fn spells(dir: &Path) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        entries.flatten().any(|e| {
            let path = e.path();
            let name = e.file_name();
            if path.is_dir() {
                name != "target" && !name.to_string_lossy().starts_with('.') && spells(&path)
            } else {
                path.extension().is_some_and(|x| x == "rs")
                    && std::fs::read_to_string(&path)
                        .is_ok_and(|s| s.contains("WebView") || s.contains("web_view"))
            }
        })
    }
    app.watched.iter().any(|dir| spells(dir))
}

/// The cargo arguments that turn web views on in a Rust app's runner
/// (`rust-<platform>`) on Linux and Windows, the platform crates whose
/// `webview` is a feature (#2706). A package keeps it when
/// [`set_runner_features`] chose it; `nsh run`, which chooses nothing, when
/// the app's code may make a web view ([`may_make_web_view`]), as a package
/// would, so the development runner does not show a placeholder where the
/// released one shows the page.
fn rust_runner_web_view(platform: Platform, may: impl FnOnce() -> bool) -> Vec<&'static str> {
    let feature = match platform {
        Platform::Linux => "nsh-platform-linux/webview",
        Platform::Windows => "nsh-platform-windows/webview",
        _ => return Vec::new(),
    };
    let chosen = RUNNER_FEATURES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|chosen| chosen.iter().any(|f| f == "webview"));
    if chosen.unwrap_or_else(may) {
        vec!["--features", feature]
    } else {
        Vec::new()
    }
}

impl RustApp {
    /// The generated workspace (`<app>/.nsh/rust`).
    pub(crate) fn workspace(&self) -> &Path {
        &self.workspace
    }
}

pub(crate) fn current() -> Option<RustApp> {
    CURRENT.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Records that the development session starts again after a change
/// ([`RESTARTED`]).
pub(crate) fn set_restarted() {
    RESTARTED.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// The error a development session ends with when the app's Rust code
/// changed: the command starts again (`lib.rs` `run`).
#[derive(Debug)]
pub(crate) struct Restart;

impl std::fmt::Display for Restart {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the app's Rust code changed")
    }
}

impl std::error::Error for Restart {}

/// An app with Rust crates of its own.
#[derive(Debug, Clone)]
pub(crate) struct RustApp {
    /// The generated workspace (`<app>/.nsh/rust`).
    workspace: PathBuf,
    /// Where nsh's crates come from.
    nsh: Nsh,
    /// The crates `nsh.json` `"rust"` lists, in its order, then its nshm
    /// (`"dependencies"`), then those the crates depend on through Cargo
    /// ([`cargo_nshm`]): each is a UI set of its own, after nsh's.
    crates: Vec<AppCrate>,
    /// The directories of the app's Rust code: the crates' and those of the
    /// local crates they depend on by path ([`path_dependencies`]), watched
    /// in development.
    watched: Vec<PathBuf>,
    /// A Rust app (`nsh.json` `"root"`, the entry is `nsh.json`): what its
    /// runners mount, with no JS.
    root: Option<RootConfig>,
    /// Its crates ask for another version of nsh: they build from manifests
    /// in the workspace ([`write_retargeted`]), its own left as they are.
    retargeted: bool,
    /// The command builds programs for this machine besides the describing
    /// one (the headless runner, a host or runner of its desktop): they
    /// share one build of what they have in common
    /// ([`RustApp::unify_features`]).
    unify: bool,
    /// The app's Rust nshm (`nsh add`): how each is patched (its Git URL,
    /// crate name or directory: `nshm::patch_table`), its package and its
    /// installed copy in `~/.nsh/nshms`. Whatever names them (the app's
    /// crates, other nshm) the workspace patches to those copies, so all
    /// link one.
    modules: Vec<(String, String, PathBuf)>,
    /// The oldest Apple systems its packages declare, which its builds for
    /// them compile for ([`set_deployment_target`]).
    minimums: AppleMinimums,
    /// Its Rust is nshm installed in `~/.nsh/nshms` only, which never
    /// change: its workspace is one every app with the same nshm shares
    /// ([`shared_workspace`]), built once, optimized throughout.
    shared: bool,
}

/// A crate of the app (`nsh.json` `"rust"`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppCrate {
    /// Its package name (`gallery-native`).
    package: String,
    /// Its directory.
    dir: PathBuf,
    /// The Cargo features the app turns on (an nshm's `"features"` in
    /// `nsh.json`): the modules of it the app uses.
    features: Vec<String>,
    /// How the app links it.
    link: Link,
}

/// How the app links one of its crates.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Link {
    /// `nsh.json` lists it, in `"rust"` or `"dependencies"`.
    Listed,
    /// An nshm one of the app's crates depends on through Cargo
    /// ([`cargo_nshm`]). Its features are the ones those crates turn on,
    /// so the generated crates ask for none, its defaults included. It is
    /// in a directory (`None`), or where `source`, the keys of its
    /// dependency line (`version = "0.6.1"`, `git = "…", branch = "main"`),
    /// says: the copy Cargo gives the app's crates, which the generated
    /// crates then share.
    Cargo(Option<String>),
}

impl AppCrate {
    /// The crate `package` in `dir`.
    pub(crate) fn new(package: String, dir: PathBuf) -> AppCrate {
        AppCrate {
            package,
            dir,
            features: Vec::new(),
            link: Link::Listed,
        }
    }

    /// The same crate with `features` on.
    pub(crate) fn with_features(mut self, features: Vec<String>) -> AppCrate {
        self.features = features;
        self
    }

    /// Whether `nsh.json` lists it, rather than one of the app's crates
    /// depending on it through Cargo ([`cargo_nshm`]).
    pub(crate) fn is_listed(&self) -> bool {
        self.link == Link::Listed
    }

    /// Whether Cargo takes it from a registry or Git rather than a
    /// directory: none of the app's code to watch or debug.
    fn is_fetched(&self) -> bool {
        matches!(self.link, Link::Cargo(Some(_)))
    }

    /// What links it, for the comments of the generated code.
    fn origin(&self) -> &'static str {
        match self.link {
            Link::Listed => "nsh.json \"rust\"",
            Link::Cargo(_) => "a Cargo dependency of the app's crates",
        }
    }

    /// Its package name.
    pub(crate) fn package(&self) -> &str {
        &self.package
    }

    /// Its directory.
    pub(crate) fn dir(&self) -> &Path {
        &self.dir
    }

    /// `cargo <subcommand>` for this crate, run in its directory: its own
    /// workspace and target directory, as `cargo` there would use.
    pub(crate) fn cargo(&self, subcommand: &str) -> Command {
        let mut cmd = Command::new(cargo());
        cmd.arg(subcommand)
            .arg("--manifest-path")
            .arg(self.dir.join("Cargo.toml"))
            .current_dir(&self.dir);
        cmd
    }

    /// The name the generated code links it by (`app_gallery_native`):
    /// one per crate, so each crate's entry is found in its own.
    fn name(&self) -> String {
        format!("app_{}", self.package.replace('-', "_"))
    }

    /// Its line in the `[dependencies]` of a generated crate.
    fn dependency(&self) -> String {
        self.dependency_at(&self.dir)
    }

    /// Its line in the `[dependencies]` of a generated crate, built from
    /// the manifest in `dir`.
    fn dependency_at(&self, dir: &Path) -> String {
        match &self.link {
            Link::Listed => format!(
                "{} = {{ package = {:?}, path = {:?}{} }}",
                self.name(),
                self.package,
                dir.to_string_lossy(),
                features_value(&self.features)
            ),
            Link::Cargo(source) => {
                let source = source
                    .clone()
                    .unwrap_or_else(|| format!("path = {:?}", dir.to_string_lossy()));
                format!(
                    "{} = {{ package = {:?}, {source}, default-features = false }}",
                    self.name(),
                    self.package,
                )
            }
        }
    }
}

/// `, features = [...]` for a dependency's line, or nothing.
pub(crate) fn features_value(features: &[String]) -> String {
    if features.is_empty() {
        return String::new();
    }
    let list: Vec<String> = features.iter().map(|f| format!("{f:?}")).collect();
    format!(", features = [{}]", list.join(", "))
}

/// Where the generated workspace takes nsh's crates from: where the app's
/// crates take them from ([`Nsh::of`]), so the app and its hosts share one
/// core (or their component and registry types differ).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Nsh {
    /// crates.io, at this `nsh`'s version ([`VERSION`]): the app's crates
    /// ask for it (`nsh-core = "0.1.1"`, what `nsh init --template rust` writes).
    Registry,
    /// The installed nightly builds a TSX runner at its own commit.
    Nightly(&'static str),
    /// The checkout the app's crates depend on by path (`nsh init
    /// --template rust --nsh-source <dir>`): nsh's own examples, or an app
    /// trying changes to nsh.
    Source(PathBuf),
    /// The Git checkout Cargo resolved for the app, its repository URL and
    /// the locked revision.
    Git {
        checkout: PathBuf,
        url: String,
        rev: Option<String>,
    },
}

/// The version of nsh's crates an app builds with: this command line's, as
/// the code it generates calls their API.
const VERSION: &str = env!("CARGO_PKG_VERSION");

impl Nsh {
    /// The source of a runner generated for an app with no Rust crates.
    fn for_runner(
        checkout: Option<PathBuf>,
        channel: &str,
        revision: &'static str,
    ) -> anyhow::Result<Self> {
        match (checkout, channel, revision) {
            (Some(dir), _, _) => Ok(Self::Source(dir)),
            (None, "nightly", "unknown") => bail!("this nightly has no source revision"),
            (None, "nightly", rev) => Ok(Self::Nightly(rev)),
            _ => Ok(Self::Registry),
        }
    }

    /// Where the app's `crates` take nsh's crates from, as their
    /// dependencies say (`cargo metadata --no-deps`): from crates.io, or by
    /// path from one checkout, whatever its version. A direct Git dependency
    /// Cargo resolves to a checkout uses that checkout, and its locked
    /// revision must be this `nsh`'s: a different one stops the command,
    /// naming both, instead of being retargeted ([`Nsh::resolve`] is the
    /// resolution alone, for tests that use fixture checkouts). Mixed
    /// sources stop the command before a build fails on two `nsh-core`s.
    fn of(crates: &[AppCrate]) -> anyhow::Result<Nsh> {
        Self::of_with(crates, env!("NSH_GIT_SHA_FULL"))
    }

    /// [`Nsh::of`] with the revision this `nsh` was built from, for tests.
    fn of_with(crates: &[AppCrate], built: &str) -> anyhow::Result<Nsh> {
        let nsh = Self::resolve(crates)?;
        if let Nsh::Git { checkout, rev, .. } = &nsh {
            check_checkout(checkout, rev.as_deref(), built)?;
        }
        Ok(nsh)
    }

    /// The source the app's crates take nsh from, without checking that this
    /// binary is that source: tests resolve fixture Git checkouts.
    fn resolve(crates: &[AppCrate]) -> anyhow::Result<Nsh> {
        // The first dependency on nsh seen, and what it is (for errors).
        let mut first: Option<(Nsh, String)> = None;
        for c in crates {
            for dep in nsh_dependencies(c)? {
                let name = dep["name"].as_str().unwrap_or_default();
                let req = dep["req"].as_str().unwrap_or("*");
                let (nsh, what) = match dep["path"].as_str() {
                    Some(path) => {
                        let checkout = checkout_of(Path::new(path)).with_context(|| {
                            format!(
                                "{} depends on {name} at {path}, which is in no nsh checkout",
                                c.package
                            )
                        })?;
                        let what =
                            format!("{} takes {name} from {}", c.package, checkout.display());
                        let nsh = match dep["git"].as_str() {
                            Some(url) => Nsh::Git {
                                checkout,
                                url: url.into(),
                                rev: dep["rev"].as_str().map(str::to_owned),
                            },
                            None => Nsh::Source(checkout),
                        };
                        (nsh, what)
                    }
                    None => (
                        Nsh::Registry,
                        format!("{} takes {name} {req} from crates.io", c.package),
                    ),
                };
                match &first {
                    None => first = Some((nsh, what)),
                    Some((seen, seen_what)) if *seen != nsh => bail!(
                        "{what}, but {seen_what}: the app's crates take nsh's crates from one place"
                    ),
                    Some(_) => {}
                }
            }
        }
        Ok(first.map_or(Nsh::Registry, |(nsh, _)| nsh))
    }

    /// The checkout, if it is one.
    fn source(&self) -> Option<&Path> {
        match self {
            Nsh::Registry | Nsh::Nightly(_) => None,
            Nsh::Source(dir) | Nsh::Git { checkout: dir, .. } => Some(dir),
        }
    }

    /// The dependency on nsh's crate `name` for a generated manifest, with
    /// `extra` keys (`, default-features = false`): `{ version = "=0.1.1" }`
    /// or `{ path = "…" }`.
    fn dep(&self, name: &str, extra: &str) -> String {
        match self {
            Nsh::Registry => format!("{{ version = \"={VERSION}\"{extra} }}"),
            Nsh::Nightly(rev) => {
                format!("{{ git = \"https://github.com/longbridge/nsh\", rev = {rev:?}{extra} }}")
            }
            Nsh::Source(dir) | Nsh::Git { checkout: dir, .. } => format!(
                "{{ path = {:?}{extra} }}",
                nsh_crate(dir, name).to_string_lossy()
            ),
        }
    }
}

/// Uses the hack, for Cargo's `unused_dependencies`.
const HACK_USE: &str =
    "\n// The features the app's programs share (`.nsh/rust/hack`).\nuse workspace_hack as _;\n";
const HACK_LIB_RS: &str = "//! Only dependencies: the features the app's programs share (nsh's\n//! `RustApp::unify_features`).\n";

/// This machine's target triple (`rustc -vV`).
fn host_triple() -> Option<String> {
    let rustc = env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let output = Command::new(rustc).arg("-vV").output().ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    text.lines()
        .find_map(|line| line.strip_prefix("host: "))
        .map(str::to_owned)
}

/// The packages the describing program builds on its own, as
/// `(name, version)`: `cargo tree -p <describe>` resolves its features
/// alone, as `cargo build -p` does, with the hack empty.
fn describe_packages(ws: &Path, describe: &str, triple: &str) -> Option<HashSet<(String, String)>> {
    let output = Command::new(cargo())
        .args([
            "tree",
            "-p",
            describe,
            "-e",
            "normal,build",
            "--prefix",
            "none",
        ])
        .args(["-f", "{p}", "--target", triple, "--manifest-path"])
        .arg(ws.join("Cargo.toml"))
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let packages = parse_tree_packages(&text);
    (!packages.is_empty()).then_some(packages)
}

/// The `(name, version)` of each line of `cargo tree -f "{p}"`.
fn parse_tree_packages(text: &str) -> HashSet<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            let name = words.next()?;
            let version = words.next()?.strip_prefix('v')?;
            Some((name.to_owned(), version.to_owned()))
        })
        .collect()
}

/// The `[target.'<triple>'.dependencies]` and `build-dependencies` of the
/// hack, from `cargo metadata`: every package the workspace member
/// `describe` depends on, normally or to build (`hack` itself left out),
/// with the features Cargo resolved for it; only what builds build scripts
/// as build dependencies.
///
/// Empty unless every one of those packages is one of `own`, what the
/// describing program builds on its own ([`describe_packages`]), and is
/// told apart from every other package by its name and version: features
/// the other programs turn on (`nsh-engine`'s `js`, which the test runner
/// and the hosts take) can add packages to the workspace's graph, and the
/// hack would make the describing program build them (a JS engine it never
/// links). Telling which features are safe would mean redoing Cargo's
/// feature resolution, so such a workspace goes without the hack and each
/// program builds its own copy, as before.
fn hack_dependencies(
    metadata: &serde_json::Value,
    describe: &str,
    hack: &str,
    triple: &str,
    own: &HashSet<(String, String)>,
) -> String {
    use std::collections::{BTreeMap, HashMap};
    let packages: HashMap<&str, &serde_json::Value> = metadata["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p["id"].as_str()?, p)))
        .collect();
    let nodes: HashMap<&str, &serde_json::Value> = metadata["resolve"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|n| Some((n["id"].as_str()?, n)))
        .collect();
    let members: HashSet<&str> = metadata["workspace_members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m.as_str())
        .collect();
    let name = |id: &str| packages.get(id).and_then(|p| p["name"].as_str());
    let Some(root) = members
        .iter()
        .copied()
        .find(|id| name(id) == Some(describe))
    else {
        return String::new();
    };
    // (package, whether it builds for a build script)
    let mut seen: HashSet<(&str, bool)> = HashSet::new();
    let mut stack = vec![(root, false)];
    while let Some((id, build)) = stack.pop() {
        if !seen.insert((id, build)) {
            continue;
        }
        let Some(node) = nodes.get(id) else { continue };
        // The dependencies only a host's feature turns on are the host's.
        let hosts = packages
            .get(id)
            .map(|p| host_only_dependencies(p, node))
            .unwrap_or_default();
        for dep in node["deps"].as_array().into_iter().flatten() {
            let Some(pkg) = dep["pkg"].as_str() else {
                continue;
            };
            if name(pkg) == Some(hack) || name(pkg).is_some_and(|n| hosts.contains(n)) {
                continue;
            }
            for kind in dep["dep_kinds"].as_array().into_iter().flatten() {
                match kind["kind"].as_str() {
                    None => stack.push((pkg, build)),
                    Some("build") => stack.push((pkg, true)),
                    _ => {}
                }
            }
        }
    }
    // `cargo tree` names a package by name and version only.
    fn identity(p: &serde_json::Value) -> Option<(&str, &str)> {
        Some((p["name"].as_str()?, p["version"].as_str()?))
    }
    let mut sources: HashMap<(&str, &str), usize> = HashMap::new();
    for p in packages.values() {
        if let Some(id) = identity(p) {
            *sources.entry(id).or_default() += 1;
        }
    }
    for &(id, _) in &seen {
        if id == root {
            continue;
        }
        let Some((name, version)) = packages.get(id).and_then(|p| identity(p)) else {
            return String::new();
        };
        if sources.get(&(name, version)) != Some(&1)
            || !own.contains(&(name.to_owned(), version.to_owned()))
        {
            return String::new();
        }
    }
    let mut normal = BTreeMap::new();
    let mut builds = BTreeMap::new();
    let mut keys: HashMap<String, usize> = HashMap::new();
    let mut key_of: HashMap<&str, String> = HashMap::new();
    let mut seen: Vec<(&str, bool)> = seen.into_iter().collect();
    seen.sort();
    for &(id, build) in &seen {
        if id == root {
            continue;
        }
        let Some(package) = packages.get(id) else {
            continue;
        };
        let Some(spec) = hack_spec(package, nodes.get(id).copied()) else {
            continue;
        };
        let key = key_of
            .entry(id)
            .or_insert_with(|| {
                let base = format!(
                    "{}-{}",
                    package["name"].as_str().unwrap_or_default(),
                    package["version"].as_str().unwrap_or_default()
                )
                .replace(['.', '+'], "-");
                let n = keys.entry(base.clone()).or_default();
                *n += 1;
                if *n == 1 { base } else { format!("{base}-{n}") }
            })
            .clone();
        if build {
            builds.insert(key, spec);
        } else {
            normal.insert(key, spec);
        }
    }
    let table = |deps: &BTreeMap<String, String>| {
        deps.iter()
            .map(|(key, spec)| format!("{key} = {spec}\n"))
            .collect::<String>()
    };
    format!(
        "\n[target.{triple:?}.dependencies]\n{}\n[target.{triple:?}.build-dependencies]\n{}",
        table(&normal),
        table(&builds)
    )
}

/// Features of the hosts and runners that need system libraries the
/// describing program and the headless runner never use: Linux's web
/// views (WebKitGTK). The hack leaves them out, with the optional
/// dependencies only they turn on, so `nsh test` builds without those
/// libraries; a Linux host builds the platform's crate (and an app crate
/// on it) once more with them.
const HOST_ONLY_FEATURES: &[(&str, &str)] = &[("nsh-platform-linux", "webview")];

/// The [`HOST_ONLY_FEATURES`] of `package` (`cargo metadata`).
fn host_only_features(package: &serde_json::Value) -> impl Iterator<Item = &'static str> + '_ {
    HOST_ONLY_FEATURES
        .iter()
        .filter(move |(name, _)| package["name"].as_str() == Some(name))
        .map(|&(_, feature)| feature)
}

/// The names of the packages `package`'s resolved `node` depends on only
/// through its [`HOST_ONLY_FEATURES`]: optional dependencies no other
/// feature it has turns on.
fn host_only_dependencies<'a>(
    package: &'a serde_json::Value,
    node: &'a serde_json::Value,
) -> std::collections::HashSet<&'a str> {
    use std::collections::HashSet;
    let hosts: HashSet<&str> = host_only_features(package).collect();
    if hosts.is_empty() {
        return HashSet::new();
    }
    // The dependency each entry of a feature names: `dep:x`, `x`, `x/f`
    // or `x?/f`.
    let named = |feature: &str| -> Vec<&'a str> {
        package["features"][feature]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .map(|v| {
                let v = v.strip_prefix("dep:").unwrap_or(v);
                let v = v.split('/').next().unwrap_or(v);
                v.strip_suffix('?').unwrap_or(v)
            })
            .collect()
    };
    let (mut only, mut kept) = (HashSet::new(), HashSet::new());
    for feature in node["features"].as_array().into_iter().flatten() {
        let Some(feature) = feature.as_str() else {
            continue;
        };
        match hosts.contains(feature) {
            true => only.extend(named(feature)),
            false => kept.extend(named(feature)),
        }
    }
    package["dependencies"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|d| d["optional"].as_bool() == Some(true))
        .filter_map(|d| {
            let name = d["name"].as_str()?;
            let key = d["rename"].as_str().unwrap_or(name);
            (only.contains(key) && !kept.contains(key)).then_some(name)
        })
        .collect()
}

/// How the hack names `package` (`cargo metadata`), with the features its
/// node resolved but its [`HOST_ONLY_FEATURES`]: a crates.io version, a
/// path, or a Git source with the reference Cargo.lock has; `None` for
/// other registries.
fn hack_spec(package: &serde_json::Value, node: Option<&serde_json::Value>) -> Option<String> {
    let name = package["name"].as_str()?;
    let features: Vec<String> = node
        .and_then(|n| n["features"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|f| f.as_str())
        .filter(|f| !host_only_features(package).any(|h| h == *f))
        .map(|f| format!("{f:?}"))
        .collect();
    let source = match package["source"].as_str() {
        None => {
            let dir = Path::new(package["manifest_path"].as_str()?).parent()?;
            format!("path = {:?}", dir.to_string_lossy())
        }
        Some(
            "registry+https://github.com/rust-lang/crates.io-index"
            | "sparse+https://index.crates.io/",
        ) => format!("version = \"{}\"", package["version"].as_str()?),
        Some(git) => {
            let url = git.strip_prefix("git+")?;
            let url = url.split('#').next()?;
            let (url, query) = url.split_once('?').unwrap_or((url, ""));
            let mut spec = format!("git = {url:?}");
            for pair in query.split('&').filter(|p| !p.is_empty()) {
                let (key, value) = pair.split_once('=')?;
                if !matches!(key, "branch" | "tag" | "rev") {
                    return None;
                }
                spec.push_str(&format!(", {key} = {value:?}"));
            }
            spec
        }
    };
    Some(format!(
        "{{ package = {name:?}, {source}, default-features = false, features = [{}] }}",
        features.join(", ")
    ))
}

/// What a generated crate names of a platform crate's features: all but `js`
/// and the standard JS modules, which a Rust app does not run, and those
/// only some platform crates have ([`rust_app_platform`]).
pub(crate) const RUST_APP_PLATFORM: &str = ", default-features = false, features = [\"shader\", \"editor\", \"emoji-picker\", \"highlight\", \"math\", \"plot\", \"rich-editor\", \"term\", \"websocket\", \"updater\", \"svg\"]";

/// [`RUST_APP_PLATFORM`] for the platform crate `platform` (Linux, macOS,
/// Windows, iOS, Android), with the features only it has: `net` (HTTP on
/// ureq) on Linux and Windows, whose `fetch` and remote images are not the
/// system's, and Linux's `sound` (GStreamer). Cargo resolves a workspace's
/// dependencies for every target, so a feature named on a crate that lacks
/// it fails every build of the generated workspace, a web one included.
pub(crate) fn rust_app_platform(platform: &str) -> String {
    let own = match platform {
        "nsh-platform-linux" => ", \"net\", \"sound\"]",
        "nsh-platform-windows" => ", \"net\"]",
        _ => return RUST_APP_PLATFORM.to_owned(),
    };
    RUST_APP_PLATFORM.replacen(']', own, 1)
}
/// `nsh-base`'s features the hosts and runners name: they show TextView's
/// code blocks highlighted, whatever `nsh-base`'s defaults are.
const HIGHLIGHT: &str = ", features = [\"highlight\"]";

/// The checkout of nsh the crate directory `path` is in: the nearest
/// directory above it with `crates/nsh-core` (GPUI's crates are in
/// `crates/gpui`, a level deeper).
fn checkout_of(path: &Path) -> Option<PathBuf> {
    let path = dunce::canonicalize(path).ok()?;
    path.ancestors()
        .find(|dir| dir.join("crates/nsh-core/Cargo.toml").is_file())
        .map(Path::to_path_buf)
}

/// Stops a Git pin this `nsh` cannot honor: the checkout's locked revision
/// must be `built`'s when both are known, and its workspace version must be
/// [`VERSION`] when they are not.
fn check_checkout(checkout: &Path, rev: Option<&str>, built: &str) -> anyhow::Result<()> {
    let rev = rev.map(str::to_owned).or_else(|| checkout_rev(checkout));
    match (rev.as_deref(), built) {
        (Some(rev), built) if built != "unknown" => {
            if rev != built {
                bail!(
                    "this app pins nsh at {rev}, but this nsh is built from {built}; \
                     update the pin to this nsh's revision, or build the pinned revision"
                );
            }
        }
        _ => {
            let version = checkout_version(checkout)?;
            if version != VERSION {
                bail!(
                    "this app pins nsh at a checkout of {version}, but this nsh is {VERSION}; \
                     update the pin to this nsh's revision, or build the pinned revision"
                );
            }
        }
    }
    Ok(())
}

/// The revision of the Git checkout `dir` (`git rev-parse HEAD`), when it is
/// one (`dir` holds the repository, as Cargo's checkouts do) and Git can
/// read it.
fn checkout_rev(dir: &Path) -> Option<String> {
    if !dir.join(".git").exists() {
        return None;
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "HEAD"])
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let rev = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (rev.len() == 40 && rev.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(rev)
}

/// The version of the nsh checkout `dir` (`[workspace.package]` of its
/// `Cargo.toml`), for a checkout Git cannot read.
fn checkout_version(dir: &Path) -> anyhow::Result<String> {
    let manifest = dir.join("Cargo.toml");
    let text =
        fs::read_to_string(&manifest).with_context(|| format!("read {}", manifest.display()))?;
    let mut in_package = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_package = line == "[workspace.package]";
        } else if in_package
            && let Some(value) = line.strip_prefix("version")
            && let Some(value) = value.trim_start().strip_prefix('=')
        {
            return Ok(value.trim().trim_matches('"').to_owned());
        }
    }
    bail!("{}: no [workspace.package] version", manifest.display())
}

/// The root component of a Rust app (`nsh.json` `"root"`), as the
/// generated runners make it ([`root_fn`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RootConfig {
    /// Its path in the app's crate (`App`, `shell::Gallery`).
    component: String,
    /// The theme's JSON file (`nsh.json` `"theme"`: a file, or its content
    /// written to the workspace), compiled into the runners.
    theme: Option<PathBuf>,
    /// `"light"` / `"dark"`; `None`: the system's.
    appearance: Option<String>,
    /// The app's id (`nsh.json` `"id"`), which names where it keeps its
    /// data.
    app_id: Option<String>,
    /// `"statusBar"` (JSON, checked): the status bar's default.
    status_bar: Option<String>,
    /// `"schemes"`' schemes (checked, lower case): the URL schemes the
    /// app claims.
    url_schemes: Vec<String>,
    /// `"links"` as `{"links": [...]}` (JSON, checked: those it cannot read
    /// whole left out): the web links that open the app.
    links: Option<String>,
    /// `"window"` (JSON, checked): the main window's launch options.
    window: Option<String>,
    /// `"application"` (JSON, checked): the app's lifecycle options.
    application: Option<String>,
    /// `"capabilities"` (JSON, as this NSH reads it: what it does not know
    /// left out): what the app may reach.
    capabilities: Option<String>,
    /// The app's translations (`locales/`) as JSON, written to the
    /// workspace and compiled into the runners.
    translations: Option<PathBuf>,
    /// What the root reports as the app (`appInfo()`'s JSON): `nsh.json`'s
    /// in development, the package's when this command packages
    /// ([`PACKAGE`]).
    app_info: String,
}

/// Whether `entry` is a Rust app's (`entry::resolve` gives its `nsh.json`
/// when it declares a `"root"`): it runs with no JS.
pub(crate) fn is_root(entry: &Path) -> bool {
    entry
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("nsh.json"))
}

/// A workspace with no crates of the app's, for `nsh package` of a TSX
/// app: its release runner built here with only the native features its
/// bundle reaches, instead of the prebuilt one that has all of them. nsh's
/// crates come from the local checkout, the nightly commit, or the published release.
pub(crate) fn runner_only(entry: &Path) -> anyhow::Result<RustApp> {
    let entry = dunce::canonicalize(entry)
        .with_context(|| format!("entry not found: {}", entry.display()))?;
    // The app's directory: its `nsh.json`'s (`entry` may be below it).
    let dir = &nsh_bundler::app_dir::app_dir_of(&entry);
    let nsh = Nsh::for_runner(
        crate::runtime::cli_checkout(),
        env!("NSH_CHANNEL"),
        env!("NSH_GIT_SHA_FULL"),
    )?;
    let watched = watched(&[], nsh.source());
    // A TSX app packaged from flags alone has no `nsh.json`: the runtime's.
    let minimums = match fs::read_to_string(dir.join("nsh.json")) {
        Ok(text) => {
            AppleMinimums::of(&serde_json::from_str(&text).context("nsh.json is not JSON")?)?
        }
        Err(_) => AppleMinimums::default(),
    };
    let app = RustApp {
        workspace: dir.join(".nsh/rust"),
        nsh,
        crates: Vec::new(),
        watched,
        root: None,
        retargeted: false,
        unify: true,
        modules: Vec::new(),
        minimums,
        shared: false,
    };
    app.write_workspace()?;
    Ok(app)
}

/// The `"rust"` crates of the app whose entry is `entry`, if it has any.
/// `unify`: the command builds programs for this machine besides the
/// describing one ([`RustApp::unify_features`]).
pub(crate) fn of(entry: &Path, unify: bool) -> anyhow::Result<Option<RustApp>> {
    let entry = dunce::canonicalize(entry)
        .with_context(|| format!("entry not found: {}", entry.display()))?;
    // The app's directory: its `nsh.json`'s (`entry` may be below it).
    let dir = &nsh_bundler::app_dir::app_dir_of(&entry);
    let Ok(text) = fs::read_to_string(dir.join("nsh.json")) else {
        return Ok(None);
    };
    let config: serde_json::Value = serde_json::from_str(&text).context("nsh.json is not JSON")?;
    let modules = crate::nshm::crates(dir, &config)?;
    let rust = config.get("rust");
    if rust.is_none() && modules.is_empty() {
        return Ok(None);
    }
    // The app's own crates, then the nshm it installed (`nsh add`):
    // one list of UI sets, checked together.
    let mut crates = match rust {
        Some(rust) => crates(dir, rust)?,
        None => Vec::new(),
    };
    // nsh's crates come from where the app's own crates take them; an
    // nshm's requirement on them is patched to that place. An app
    // with nshm only builds with this CLI's, as a TSX app's runner
    // does ([`runner_only`]).
    let nsh = if crates.is_empty() {
        crate::runtime::cli_checkout().map_or(Nsh::Registry, Nsh::Source)
    } else {
        Nsh::of(&crates)?
    };
    let module_patches = modules
        .iter()
        .map(|(url, c)| (url.clone(), c.package.clone(), c.dir.clone()))
        .collect();
    // The nshm the app's own crates depend on through Cargo: linked after
    // those `nsh.json` lists, so their entries run as an installed nshm's
    // do.
    let found = cargo_nshm(&crates)?;
    if !modules.is_empty() || !found.is_empty() {
        let mut named: Vec<(String, AppCrate)> = crates
            .iter()
            .map(|c| (c.dir.display().to_string(), c.clone()))
            .collect();
        let installed: Vec<String> = modules.iter().map(|(_, c)| c.name()).collect();
        named.extend(modules);
        crates = with_found(named, &installed, found)?;
    }
    let own: Vec<AppCrate> = crates.iter().filter(|c| !c.is_fetched()).cloned().collect();
    let watched = watched(&own, nsh.source());
    let minimums = AppleMinimums::of(&config)?;
    // Only installed nshm, with a released nsh: nothing of the build is the
    // app's, so every app with these nshm shares it.
    let installed = nsh_bundler::nshm::installed_dir().and_then(|d| dunce::canonicalize(d).ok());
    let shared = rust.is_none()
        && !is_root(&entry)
        && matches!(nsh, Nsh::Registry)
        && !crates.is_empty()
        && crates
            .iter()
            .all(|c| installed.as_ref().is_some_and(|d| c.dir.starts_with(d)));
    let workspace = if shared {
        // The app's own generated workspace, from before it shared one, is
        // a build nothing uses any more.
        let own = dir.join(".nsh/rust");
        if own.is_dir() {
            let _ = fs::remove_dir_all(&own);
        }
        shared_workspace(&crates, unify, &minimums)?
    } else {
        dir.join(".nsh/rust")
    };
    let retargeted = retargeted(&crates, &nsh)?;
    let root = if is_root(&entry) {
        Some(root_config(dir, &config, &workspace)?)
    } else {
        None
    };
    let app = RustApp {
        workspace,
        nsh,
        crates,
        watched,
        root,
        retargeted,
        unify,
        modules: module_patches,
        minimums,
        shared,
    };
    app.write_workspace()?;
    Ok(Some(app))
}

/// How long a shared build nobody used stays on this machine.
const SHARED_KEPT: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 60 * 60);

/// The workspace of the apps whose Rust is the installed nshm `crates`
/// only: `~/.nsh/builds/<fingerprint>`, after what decides the build (this
/// nsh, the nshm in order with their features, `unify`, the Apple
/// minimums). Its binaries are built once and kept; builds no app used for
/// [`SHARED_KEPT`] are removed as a new one starts.
fn shared_workspace(
    crates: &[AppCrate],
    unify: bool,
    minimums: &AppleMinimums,
) -> anyhow::Result<PathBuf> {
    use sha2::Digest as _;
    let builds = nsh_bundler::nshm::home()
        .context("no home directory to build nshm in: set NSH_HOME")?
        .join("builds");
    let mut hash = sha2::Sha256::new();
    hash.update(env!("CARGO_PKG_VERSION"));
    hash.update(env!("NSH_GIT_SHA_FULL"));
    for c in crates {
        hash.update(format!(
            "\0{}\0{}\0{:?}",
            c.package,
            c.dir.display(),
            c.features
        ));
    }
    hash.update(format!("\0{unify}\0{minimums:?}"));
    let id: String = hash.finalize()[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let dir = builds.join(id);
    let used = dir.join(".used");
    if !dir.is_dir() {
        prune_shared(&builds);
    }
    fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    // Its last use, for [`prune_shared`].
    fs::write(&used, "").with_context(|| format!("writing {}", used.display()))?;
    Ok(dir)
}

/// Removes the shared builds in `builds` no app used for [`SHARED_KEPT`].
fn prune_shared(builds: &Path) {
    let Ok(entries) = fs::read_dir(builds) else {
        return;
    };
    for entry in entries.flatten() {
        let unused = fs::metadata(entry.path().join(".used"))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > SHARED_KEPT);
        if unused {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// The crates `rust` (`nsh.json` `"rust"` of the app in `dir`) lists: a
/// crate's directory or a list of them. Each is checked as the workspace
/// is written: two of the same package or the same specifier
/// (`#[native_module("…")]`, [`specifier_of`]) would make two sets one
/// import cannot tell apart.
fn crates(dir: &Path, rust: &serde_json::Value) -> anyhow::Result<Vec<AppCrate>> {
    const WHAT: &str = "nsh.json: \"rust\" is the path of the app's crate (\".\", \"native\") or a list of them (\"native/charts\", \"native/storage\")";
    let paths: Vec<&str> = match rust {
        serde_json::Value::String(path) => vec![path],
        serde_json::Value::Array(paths) if !paths.is_empty() => paths
            .iter()
            .map(|p| p.as_str().context(WHAT))
            .collect::<anyhow::Result<_>>()?,
        _ => bail!(WHAT),
    };
    let mut crates: Vec<(String, AppCrate)> = Vec::new();
    for path in paths {
        let dir = dunce::canonicalize(dir.join(path))
            .with_context(|| format!("nsh.json: \"rust\": no crate at {path}"))?;
        let package = package_name(&dir.join("Cargo.toml"))?;
        crates.push((path.to_owned(), AppCrate::new(package, dir)));
    }
    check_crates(&crates)?;
    Ok(crates.into_iter().map(|(_, c)| c).collect())
}

/// Checks the crates the app links (`"rust"`'s and the nshm's, each
/// with how `nsh.json` names it): two of the same directory, package or
/// specifier (`#[native_module("…")]`, [`specifier_of`]) would make two
/// sets one import cannot tell apart.
pub(crate) fn check_crates(crates: &[(String, AppCrate)]) -> anyhow::Result<()> {
    for (i, (path, krate)) in crates.iter().enumerate() {
        let before = &crates[..i];
        if let Some((other, _)) = before.iter().find(|(_, c)| c.dir == krate.dir) {
            bail!("nsh.json: \"rust\" lists the crate {other} twice ({path})");
        }
        // Cargo takes `-` and `_` in names as one: so do the names the
        // generated code links the crates by.
        if let Some((other, first)) = before.iter().find(|(_, c)| c.name() == krate.name()) {
            let same = if first.package == krate.package {
                format!("are both the package `{}`", krate.package)
            } else {
                format!(
                    "are the packages `{}` and `{}`, one name to Cargo",
                    first.package, krate.package
                )
            };
            bail!(
                "nsh.json: {other} and {path} {same}: give each crate a [package] name of its own"
            );
        }
    }
    let mut specifiers: Vec<(&str, String)> = Vec::new();
    for (path, krate) in crates {
        let Some(specifier) = specifier_of(&krate.dir) else {
            continue;
        };
        if let Some((other, _)) = specifiers.iter().find(|(_, s)| *s == specifier) {
            bail!(
                "nsh.json: {other} and {path} both have `#[native_module({specifier:?})]`: give each crate a specifier of its own, the one its TSX imports it by"
            );
        }
        specifiers.push((path, specifier));
    }
    Ok(())
}

/// The specifier of the `#[native_module("…")]` at the root of the crate
/// in `dir` (its `[lib] path`, or `src/lib.rs`), if it has one; the build
/// fails on a crate without one ([`RustApp::app_sets`]).
pub(crate) fn specifier_of(dir: &Path) -> Option<String> {
    let manifest = fs::read_to_string(dir.join("Cargo.toml")).ok()?;
    let lib = toml_tables(&manifest)
        .find_map(|(table, line)| {
            (table == "lib")
                .then(|| toml_string(line, "path"))
                .flatten()
        })
        .unwrap_or_else(|| "src/lib.rs".to_owned());
    let code = fs::read_to_string(dir.join(lib)).ok()?;
    code.lines().find_map(|line| {
        const ATTR: &str = "native_module";
        let attr = line.trim().strip_prefix("#[")?;
        let rest = attr[attr.find(ATTR)? + ATTR.len()..].trim_start();
        let rest = rest.strip_prefix('(')?.trim_start().strip_prefix('"')?;
        Some(rest[..rest.find('"')?].to_owned())
    })
}

/// The nshm the app's `crates` depend on through Cargo, transitively,
/// each with how errors name it: the packages of their dependency graph
/// (normal dependencies, on any target; not nsh's own crates) that depend
/// on nsh-core and have a `#[native_module("…")]` at their root, which is
/// how `nsh add` tells an nshm ([`specifier_of`]). Each package once, in
/// the order of their names (then of Cargo's ids: versions and sources),
/// linked from where Cargo takes it for the app's crates ([`Link::Cargo`]).
fn cargo_nshm(crates: &[AppCrate]) -> anyhow::Result<Vec<(String, AppCrate)>> {
    let mut found: Vec<(String, String, AppCrate)> = Vec::new();
    for c in crates {
        let manifest = c.dir.join("Cargo.toml");
        let output = Command::new(cargo())
            .args(["metadata", "--format-version", "1", "--manifest-path"])
            .arg(&manifest)
            .output()
            .context("run cargo metadata (is Rust installed?)")?;
        if !output.status.success() {
            bail!(
                "cargo cannot resolve the dependencies of {}:\n{}",
                manifest.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let metadata: serde_json::Value =
            serde_json::from_slice(&output.stdout).context("cargo metadata's output")?;
        for (id, label, krate) in nshm_in(&metadata, &manifest)? {
            if !found.iter().any(|(seen, ..)| *seen == id) {
                found.push((id, label, krate));
            }
        }
    }
    found.sort_by(|(a, _, x), (b, _, y)| (&x.package, a).cmp(&(&y.package, b)));
    Ok(found
        .into_iter()
        .map(|(_, label, krate)| (label, krate))
        .collect())
}

/// The nshm in the dependency graph of the package at `manifest`, as
/// `cargo metadata` (with its dependencies) gives it in `metadata`: each
/// with its Cargo id and how errors name it ([`cargo_nshm`]).
fn nshm_in(
    metadata: &serde_json::Value,
    manifest: &Path,
) -> anyhow::Result<Vec<(String, String, AppCrate)>> {
    let packages = metadata["packages"]
        .as_array()
        .context("cargo metadata packages")?;
    let package = |id: &str| packages.iter().find(|p| p["id"] == id);
    let manifest = dunce::canonicalize(manifest)?;
    let root = packages
        .iter()
        .find(|p| {
            p["manifest_path"]
                .as_str()
                .and_then(|m| dunce::canonicalize(m).ok())
                .is_some_and(|m| m == manifest)
        })
        .with_context(|| format!("cargo metadata has no package at {}", manifest.display()))?;
    let root_id = root["id"].as_str().context("cargo metadata package id")?;
    let nodes = metadata["resolve"]["nodes"]
        .as_array()
        .context("cargo metadata dependency graph")?;
    // What the root links: normal dependencies, not dev or build ones.
    let mut reached = vec![root_id];
    let mut next = 0;
    while let Some(id) = reached.get(next).copied() {
        next += 1;
        let deps = nodes
            .iter()
            .find(|n| n["id"] == id)
            .and_then(|n| n["deps"].as_array())
            .into_iter()
            .flatten();
        for dep in deps {
            let normal = dep["dep_kinds"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|k| k["kind"].is_null());
            if let Some(pkg) = dep["pkg"].as_str()
                && normal
                && !reached.contains(&pkg)
            {
                reached.push(pkg);
            }
        }
    }
    let root_name = root["name"].as_str().unwrap_or_default();
    let mut found = Vec::new();
    for id in &reached[1..] {
        let p = package(id).with_context(|| format!("cargo metadata has no package {id}"))?;
        let name = p["name"].as_str().context("cargo metadata package name")?;
        // `#[native_module]` expands to `::nsh_core::…`: an nshm depends on
        // nsh-core itself.
        let on_core = p["dependencies"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|d| d["name"] == "nsh-core" && d["kind"].is_null());
        if NSH_CRATES.contains(&name) || !on_core {
            continue;
        }
        let dir = Path::new(
            p["manifest_path"]
                .as_str()
                .context("cargo metadata manifest")?,
        )
        .parent()
        .context("cargo metadata manifest directory")?;
        let dir = dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_owned());
        if specifier_of(&dir).is_none() {
            continue;
        }
        let version = p["version"].as_str().unwrap_or_default();
        let link = Link::Cargo(cargo_source(p)?);
        let mut krate = AppCrate::new(name.to_owned(), dir);
        krate.link = link;
        found.push((
            (*id).to_owned(),
            format!("{name} {version} (a Cargo dependency of {root_name})"),
            krate,
        ));
    }
    Ok(found)
}

/// The keys of a dependency line on the package `p` of `cargo metadata`
/// that take it from where Cargo did: `None` for a directory, its version
/// for a registry (with the registry's index unless it is crates.io), its
/// repository and reference for Git ([`git_keys`]).
fn cargo_source(p: &serde_json::Value) -> anyhow::Result<Option<String>> {
    const CRATES_IO: &[&str] = &[
        "registry+https://github.com/rust-lang/crates.io-index",
        "sparse+https://index.crates.io/",
    ];
    let Some(source) = p["source"].as_str() else {
        return Ok(None);
    };
    let version = p["version"].as_str().context("cargo metadata version")?;
    if let Some(git) = source.strip_prefix("git+") {
        return Ok(Some(git_keys(git)));
    }
    if CRATES_IO.contains(&source) {
        return Ok(Some(format!("version = {version:?}")));
    }
    let index = source
        .strip_prefix("registry+")
        .or(source.starts_with("sparse+").then_some(source))
        .with_context(|| {
            format!(
                "{} comes from {source}, a source nsh cannot link",
                p["name"].as_str().unwrap_or_default()
            )
        })?;
    Ok(Some(format!(
        "version = {version:?}, registry-index = {index:?}"
    )))
}

/// `git = "<url>"` and the reference (`, branch = "main"`) of the Git
/// source `<url>?<query>#<commit>` of `cargo metadata` (after `git+`): the
/// one source Cargo takes the app's dependency from, so a generated
/// dependency with these keys shares its package.
fn git_keys(source: &str) -> String {
    let source = source.split('#').next().unwrap_or(source);
    let (url, query) = source.split_once('?').unwrap_or((source, ""));
    let reference = query
        .split_once('=')
        .map(|(key, value)| format!(", {key} = {value:?}"))
        .unwrap_or_default();
    format!("git = {url:?}{reference}")
}

/// The crates `listed` (those `nsh.json` lists, each with how it names
/// it: `"rust"`'s, then `"dependencies"`'s, whose names are `installed`),
/// with the nshm `found` in their Cargo dependencies after them
/// ([`cargo_nshm`]), checked together ([`check_crates`]). One `nsh.json`
/// lists as well is linked once, as `nsh.json` lists it: the same
/// directory, or an nshm of `"dependencies"` by its package, to whose
/// installed copy the generated workspace sends the app's Cargo dependency
/// ([`RustApp::write_workspace_manifest`]).
fn with_found(
    mut listed: Vec<(String, AppCrate)>,
    installed: &[String],
    found: Vec<(String, AppCrate)>,
) -> anyhow::Result<Vec<AppCrate>> {
    let found: Vec<_> = found
        .into_iter()
        .filter(|(_, c)| {
            !listed.iter().any(|(_, l)| l.dir == c.dir) && !installed.contains(&c.name())
        })
        .collect();
    listed.extend(found);
    check_crates(&listed)?;
    Ok(listed.into_iter().map(|(_, c)| c).collect())
}

/// The directories of the app's Rust code: those of `crates` and of the
/// local crates they depend on by path, transitively, except nsh's own (in
/// the checkout `source`).
fn watched(crates: &[AppCrate], source: Option<&Path>) -> Vec<PathBuf> {
    let source = source.map(|s| dunce::canonicalize(s).unwrap_or_else(|_| s.to_owned()));
    let mut dirs: Vec<PathBuf> = crates.iter().map(|c| c.dir.clone()).collect();
    let mut next = 0;
    while let Some(dir) = dirs.get(next) {
        next += 1;
        for dep in path_dependencies(dir) {
            if let Ok(dep) = dunce::canonicalize(dep)
                && !source.as_ref().is_some_and(|s| dep.starts_with(s))
                && !dirs.contains(&dep)
            {
                dirs.push(dep);
            }
        }
    }
    dirs
}

/// The directories of the path dependencies (`path = "../shared"`) of the
/// crate in `dir`, those it builds with (`[dependencies]`,
/// `[build-dependencies]`, per target too).
fn path_dependencies(dir: &Path) -> Vec<PathBuf> {
    let Ok(manifest) = fs::read_to_string(dir.join("Cargo.toml")) else {
        return Vec::new();
    };
    toml_tables(&manifest)
        .filter(|(table, _)| {
            table
                .split('.')
                .any(|part| part == "dependencies" || part == "build-dependencies")
        })
        .filter_map(|(_, line)| toml_string(line, "path"))
        .map(|path| dir.join(path))
        .collect()
}

/// The lines of the TOML document `text` outside table headers, with the
/// name of the table each is in (`dependencies`, `dependencies.shared`,
/// `target.'cfg(unix)'.dependencies`), trimmed.
pub(crate) fn toml_tables(text: &str) -> impl Iterator<Item = (&str, &str)> {
    let mut table = "";
    text.lines().filter_map(move |line| {
        let line = line.trim();
        if line.starts_with('[') {
            table = line.trim_start_matches('[');
            table = table.split(']').next().unwrap_or_default().trim();
            return None;
        }
        Some((table, line))
    })
}

/// The string value of `key` in the TOML `line` (`key = "…"`, also within
/// an inline table: `shared = { path = "../shared" }`).
pub(crate) fn toml_string(line: &str, key: &str) -> Option<String> {
    let mut rest = line;
    while let Some(at) = rest.find(key) {
        let before = rest[..at].trim_end();
        let after = rest[at + key.len()..].trim_start();
        rest = &rest[at + key.len()..];
        if !(before.is_empty() || before.ends_with('{') || before.ends_with(',')) {
            continue;
        }
        let Some(value) = after.strip_prefix('=') else {
            continue;
        };
        let value = value.trim_start();
        let quote = value.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        let value = &value[1..];
        return Some(value[..value.find(quote)?].to_owned());
    }
    None
}

/// The `"root"` of the app's `config` (its `nsh.json`, in `dir`) with its
/// `"theme"`, `"appearance"` and `"statusBar"`.
fn root_config(
    dir: &Path,
    config: &serde_json::Value,
    workspace: &Path,
) -> anyhow::Result<RootConfig> {
    let component = config
        .get("root")
        .and_then(|r| r.as_str())
        .context("nsh.json: \"root\" is the path of the app's root component in its crate")?
        .trim()
        .to_owned();
    let ident = |s: &str| {
        s.chars()
            .next()
            .is_some_and(|c| c.is_alphabetic() || c == '_')
            && s.chars().all(|c| c.is_alphanumeric() || c == '_')
    };
    if !component.split("::").all(ident) {
        bail!("nsh.json: \"root\": {component:?} is not a Rust path (`App`, `shell::Gallery`)");
    }
    let theme = match config.get("theme") {
        None => None,
        Some(serde_json::Value::String(file)) => Some(
            dunce::canonicalize(dir.join(file))
                .with_context(|| format!("nsh.json: theme: no {file}"))?,
        ),
        Some(inline) => {
            let path = workspace.join("theme.json");
            write(&path, &inline.to_string())?;
            Some(path)
        }
    };
    if let Some(theme) = &theme {
        let json = fs::read_to_string(theme)?;
        let (_, ignored) = nsh_base::Theme::from_json_lenient(&json)
            .map_err(|e| anyhow::anyhow!("nsh.json: theme: {e}"))?;
        for what in ignored {
            crate::ui::warn(format_args!(
                "nsh.json: theme: {what}, ignored (one of a newer NSH, or a typo)"
            ));
        }
    }
    let appearance = match config.get("appearance").and_then(|a| a.as_str()) {
        None | Some("system") => None,
        Some(a @ ("light" | "dark")) => Some(a.to_owned()),
        Some(other) => {
            crate::ui::warn(format_args!(
                "nsh.json: appearance: {other:?} is not \"light\", \"dark\" or \"system\", ignored (one of a newer NSH, or a typo)"
            ));
            None
        }
    };
    let status_bar = match config.get("statusBar") {
        None => None,
        Some(v) => {
            let (_, ignored) = nsh_core::StatusBarSetting::from_json_lenient(v);
            for what in ignored {
                crate::ui::warn(format_args!(
                    "nsh.json: statusBar: {what}, ignored (one of a newer NSH, or a typo)"
                ));
            }
            Some(v.to_string())
        }
    };
    let mut url_schemes = match config.get("schemes") {
        None => Vec::new(),
        Some(v) => {
            let (schemes, ignored) = nsh_core::url_scheme::schemes_from_json_lenient(v);
            for what in ignored {
                crate::ui::warn(format_args!(
                    "nsh.json: {what}, ignored (one of a newer NSH, or a typo)"
                ));
            }
            schemes
        }
    };
    // The files it opens come as `file:` URLs (`nsh_core::file_type`).
    if nsh_core::file_type::declares_file_types(config) {
        url_schemes.push(nsh_core::file_type::FILE_SCHEME.to_owned());
    }
    let links = match config.get("links") {
        None => None,
        Some(v) => {
            let (links, ignored) = nsh_core::url_scheme::AppLinks::from_json_lenient(
                &serde_json::json!({ "links": v }),
            );
            for what in ignored {
                crate::ui::warn(format_args!(
                    "nsh.json: {what}, ignored (one of a newer NSH, or a typo)"
                ));
            }
            (!links.web().is_empty()).then(|| links.to_json().to_string())
        }
    };
    let window = match config.get("window") {
        None => None,
        Some(v) => {
            nsh_core::desktop::MainWindowOptions::from_json(v)
                .map_err(|e| anyhow::anyhow!("nsh.json: window: {e}"))?;
            Some(v.to_string())
        }
    };
    let application = match config.get("application") {
        None => None,
        Some(v) => {
            nsh_core::desktop::ApplicationOptions::from_json(v)
                .map_err(|e| anyhow::anyhow!("nsh.json: application: {e}"))?;
            Some(v.to_string())
        }
    };
    // Read as a TSX app's are (`nsh_bundler::capabilities`): what this NSH
    // does not know is not granted.
    let capabilities = match config.get("capabilities") {
        None => None,
        Some(v) => {
            let (capabilities, dropped) = nsh_core::access::Capabilities::from_json_lenient(v)
                .map_err(|e| anyhow::anyhow!("nsh.json: {e}"))?;
            for what in dropped {
                crate::ui::warn(format_args!(
                    "nsh.json: {what}, not granted (one of a newer NSH, or a typo)"
                ));
            }
            Some(capabilities.to_json().to_string())
        }
    };
    let translations = nsh_i18n::read_translations(dir).map_err(|e| anyhow::anyhow!(e))?;
    let translations = if translations.is_empty() {
        None
    } else {
        let path = workspace.join("translations.json");
        write(&path, &nsh_i18n::translations_json(&translations))?;
        Some(path)
    };
    let package = PACKAGE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let app_info = app_info_json(dir, config, package)?;
    Ok(RootConfig {
        component,
        theme,
        appearance,
        app_id: crate::package::app_id(&dir.join("nsh.json")).ok(),
        status_bar,
        url_schemes,
        links,
        window,
        application,
        capabilities,
        translations,
        app_info,
    })
}

/// What a Rust app's root reports as the app (`appInfo()`'s JSON): in
/// development (`nsh run`, `nsh dev`, `nsh test`) `nsh.json`'s `"id"`,
/// `"name"`, `"version"` and `"build"` (`null` where it gives none), as a
/// TSX app's development build reports them; when this command packages
/// ([`PACKAGE`]: `package`), the package's identity with the defaults the
/// package writers use, and not a development build. The workspace is
/// written again by every command, so a runner never keeps another
/// command's.
fn app_info_json(
    dir: &Path,
    config: &serde_json::Value,
    package: Option<PackageIdentity>,
) -> anyhow::Result<String> {
    let info = match package {
        Some(identity) => {
            let entry = dir.join("nsh.json");
            let mut app = crate::package::read_config(&entry)?;
            app.id = identity.id.or(app.id);
            app.name = identity.name.or(app.name);
            app.version = identity.version.or(app.version);
            app.build = identity.build.or(app.build);
            let info = crate::build::app_info(&entry, &app);
            serde_json::json!({
                "id": info.id,
                "name": info.name,
                "version": info.version,
                "build": info.build,
                "development": false,
            })
        }
        None => {
            let text = |key: &str| config.get(key).and_then(|v| v.as_str());
            serde_json::json!({
                "id": text("id"),
                "name": text("name"),
                "version": text("version"),
                "build": config.get("build").and_then(|v| v.as_u64()),
                "development": true,
            })
        }
    };
    Ok(info.to_string())
}

/// nsh's crates an app's crate may depend on ([`Nsh::of`]; built against a
/// checkout, `[patch.crates-io]` sends them to it).
const NSH_CRATES: &[&str] = &[
    "nsh-macros",
    "nsh-core",
    "nsh-base",
    "nsh-package",
    "nsh-js",
    "nsh-engine",
    "nsh-testing",
    "nsh-bundler",
    "nsh-dev",
    "nsh-platform-apple",
    "nsh-platform-ios",
    "nsh-platform-android",
    "nsh-platform-linux",
    "nsh-platform-macos",
    "nsh-platform-windows",
    "nsh-platform-web",
    "nsh-platform-gpui",
];

/// The dependencies of the app's crate `c` on nsh's crates, as `cargo
/// metadata --no-deps` gives them (`name`, `req`, `path` for one by path).
fn nsh_dependencies(c: &AppCrate) -> anyhow::Result<Vec<serde_json::Value>> {
    let manifest = c.dir.join("Cargo.toml");
    let output = Command::new(cargo())
        .args([
            "metadata",
            "--no-deps",
            "--format-version",
            "1",
            "--manifest-path",
        ])
        .arg(&manifest)
        .output()
        .context("run cargo metadata (is Rust installed?)")?;
    if !output.status.success() {
        bail!(
            "nsh.json: \"rust\": cargo cannot read {}:\n{}",
            manifest.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("cargo metadata's output")?;
    let package = metadata["packages"]
        .as_array()
        .and_then(|packages| {
            packages
                .iter()
                .find(|p| p["name"].as_str() == Some(&c.package))
        })
        .with_context(|| format!("cargo metadata has no package {}", c.package))?;
    let mut dependencies: Vec<_> = package["dependencies"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|dep| {
            dep["name"]
                .as_str()
                .is_some_and(|n| NSH_CRATES.contains(&n))
                // The generated workspace never compiles the app crate's
                // dev-dependencies (write_retargeted skips them too).
                && dep["kind"].as_str() != Some("dev")
        })
        .cloned()
        .collect();
    if dependencies.iter().any(|dep| {
        dep["source"]
            .as_str()
            .is_some_and(|s| s.starts_with("git+"))
    }) {
        // --no-deps reports declarations, not the locked Git checkout or
        // registry dependencies redirected by the app's [patch] tables.
        let output = Command::new(cargo())
            .args(["metadata", "--format-version", "1", "--manifest-path"])
            .arg(&manifest)
            .output()
            .context("resolve the app's nsh Git dependencies")?;
        if !output.status.success() {
            bail!(
                "cargo cannot resolve {}:\n{}",
                manifest.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let resolved: serde_json::Value =
            serde_json::from_slice(&output.stdout).context("cargo metadata's resolved output")?;
        resolve_git_dependencies(&mut dependencies, &resolved, &c.package)?;
    }
    Ok(dependencies)
}

/// Replace Git declarations and patched registry declarations with Cargo's
/// resolved checkout, keeping the repository URL for generated patches and
/// the locked revision for [`check_checkout`].
fn resolve_git_dependencies(
    dependencies: &mut [serde_json::Value],
    metadata: &serde_json::Value,
    package: &str,
) -> anyhow::Result<()> {
    let packages = metadata["packages"]
        .as_array()
        .context("cargo metadata packages")?;
    let app = packages
        .iter()
        .find(|p| p["name"] == package)
        .context("cargo metadata app package")?;
    let node = metadata["resolve"]["nodes"]
        .as_array()
        .and_then(|nodes| nodes.iter().find(|node| node["id"] == app["id"]))
        .context("cargo metadata app dependencies")?;
    for dep in dependencies {
        // An edge's `name` is how the app's code names the dependency: its
        // rename, else the package's library name, which need not be the
        // package's (`nsh-platform-android`'s is `nsh`). The package the
        // edge resolves to says which dependency it is; a rename tells
        // apart two dependencies on one package.
        let package = dep["name"].as_str().unwrap_or_default();
        let rename = dep["rename"].as_str().map(|r| r.replace('-', "_"));
        let Some(resolved) = node["deps"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|edge| {
                rename
                    .as_deref()
                    .is_none_or(|rename| edge["name"] == rename)
            })
            .find_map(|edge| {
                packages
                    .iter()
                    .find(|p| p["id"] == edge["pkg"] && p["name"] == package)
            })
        else {
            continue;
        };
        if let Some(source) = resolved["source"]
            .as_str()
            .and_then(|s| s.strip_prefix("git+"))
        {
            // `git+<url>?<query>#<commit>`: the commit Cargo locked.
            let (source, revision) = match source.rsplit_once('#') {
                Some((source, revision))
                    if revision.len() == 40
                        && revision.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
                {
                    (source, Some(revision))
                }
                _ => (source, None),
            };
            let url = source.split('?').next().context("Git repository URL")?;
            let path = Path::new(
                resolved["manifest_path"]
                    .as_str()
                    .context("Git manifest path")?,
            )
            .parent()
            .context("Git crate directory")?;
            dep["path"] = path.to_string_lossy().as_ref().into();
            dep["git"] = url.into();
            if let Some(revision) = revision {
                dep["rev"] = revision.into();
            }
        }
    }
    Ok(())
}

/// The package in the directory `dir`, as `cargo metadata --no-deps` gives
/// it, with its inherited values resolved.
fn package_metadata(dir: &Path) -> anyhow::Result<serde_json::Value> {
    let manifest = dir.join("Cargo.toml");
    let output = Command::new(cargo())
        .args([
            "metadata",
            "--no-deps",
            "--format-version",
            "1",
            "--manifest-path",
        ])
        .arg(&manifest)
        .output()
        .context("run cargo metadata")?;
    if !output.status.success() {
        bail!(
            "cargo cannot read {}:\n{}",
            manifest.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("cargo metadata's output")?;
    let path = dunce::canonicalize(&manifest)?;
    metadata["packages"]
        .as_array()
        .and_then(|packages| {
            packages.iter().find(|p| {
                p["manifest_path"]
                    .as_str()
                    .and_then(|m| dunce::canonicalize(m).ok())
                    .is_some_and(|m| m == path)
            })
        })
        .cloned()
        .with_context(|| format!("cargo metadata has no package at {}", manifest.display()))
}

/// Whether the declared dependency `dep` is on nsh's crates.
fn is_nsh(dep: &serde_json::Value) -> bool {
    dep["name"]
        .as_str()
        .is_some_and(|name| NSH_CRATES.contains(&name))
}

/// Whether the app's crates, taking nsh from crates.io, declare a
/// requirement [`VERSION`] does not satisfy. A direct Git dependency Cargo
/// resolved to a checkout is decided earlier in [`Nsh::of`]; one Cargo did
/// not resolve (an optional dependency no feature enables) is not built.
fn retargeted(crates: &[AppCrate], nsh: &Nsh) -> anyhow::Result<bool> {
    if *nsh != Nsh::Registry {
        return Ok(false);
    }
    let this = semver::Version::parse(VERSION).context("nsh's own version")?;
    for c in crates {
        let package = package_metadata(&c.dir)?;
        let other = package["dependencies"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|dep| is_nsh(dep) && dep["kind"].as_str() != Some("dev"))
            .any(|dep| {
                !dep["req"]
                    .as_str()
                    .and_then(|r| semver::VersionReq::parse(r).ok())
                    .is_some_and(|r| r.matches(&this))
            });
        if other {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The value of a dependency of a retargeted manifest: `{ … }`, with what
/// the app's manifest says of it, on nsh's crates at this version, and the
/// local crates that use nsh at their retargeted manifests.
fn retargeted_dependency(dep: &serde_json::Value, nsh: &Nsh, local: Option<&Path>) -> String {
    let name = dep["name"].as_str().unwrap_or_default();
    let mut extra = format!(", package = {name:?}");
    if dep["uses_default_features"].as_bool() == Some(false) {
        extra.push_str(", default-features = false");
    }
    if dep["optional"].as_bool() == Some(true) {
        extra.push_str(", optional = true");
    }
    if dep["features"].as_array().is_some_and(|f| !f.is_empty()) {
        extra.push_str(&format!(", features = {}", dep["features"]));
    }
    if is_nsh(dep) {
        return nsh.dep(name, &extra);
    }
    if let Some(dir) = local {
        return format!("{{ path = {:?}{extra} }}", dir.to_string_lossy());
    }
    if let Some(path) = dep["path"].as_str() {
        return format!("{{ path = {path:?}{extra} }}");
    }
    if let Some(source) = dep["source"].as_str().and_then(|s| s.strip_prefix("git+")) {
        return format!("{{ {}{extra} }}", git_keys(source));
    }
    let registry = dep["registry"]
        .as_str()
        .map(|r| format!(", registry-index = {r:?}"))
        .unwrap_or_default();
    format!("{{ version = {}{registry}{extra} }}", dep["req"])
}

/// Writes the manifest of the app's crate in `dir` at `<ws>/app-crates/<its
/// package>` and gives that directory: the same package, sources and
/// features, with its nsh dependencies at this version, so an app that asks
/// for another version shares one core with the generated code without its
/// own `Cargo.toml` changing. A local crate it depends on that uses nsh gets
/// one too. Written from `cargo metadata`, so inherited values are resolved.
fn write_retargeted(ws: &Path, dir: &Path, nsh: &Nsh) -> anyhow::Result<PathBuf> {
    let package = package_metadata(dir)?;
    let name = package["name"].as_str().context("package name")?;
    let out = ws.join("app-crates").join(name);
    let targets = package["targets"].as_array().context("package targets")?;
    let kinds = |t: &serde_json::Value, kind: &str| {
        t["kind"]
            .as_array()
            .is_some_and(|k| k.iter().any(|v| v == kind))
    };
    let lib = targets
        .iter()
        .find(|t| {
            ["lib", "rlib", "dylib", "cdylib", "staticlib", "proc-macro"]
                .iter()
                .any(|kind| kinds(t, kind))
        })
        .with_context(|| format!("{name} has no library"))?;
    let mut text = format!(
        "# Generated by nsh from {}: do not edit.\n[package]\nname = {name:?}\nversion = {}\nedition = {}\n",
        dir.join("Cargo.toml").display(),
        package["version"],
        package["edition"],
    );
    if package["links"].is_string() {
        text.push_str(&format!("links = {}\n", package["links"]));
    }
    match targets.iter().find(|t| kinds(t, "custom-build")) {
        Some(build) => text.push_str(&format!("build = {}\n", build["src_path"])),
        None => text.push_str("build = false\n"),
    }
    text.push_str(&format!(
        "\n[lib]\nname = {}\npath = {}\ncrate-type = {}\n\n[features]\n",
        lib["name"], lib["src_path"], lib["crate_types"],
    ));
    if let Some(features) = package["features"].as_object() {
        for (feature, enables) in features {
            text.push_str(&format!("{feature:?} = {enables}\n"));
        }
    }
    let mut tables = std::collections::BTreeMap::<String, String>::new();
    for dep in package["dependencies"].as_array().into_iter().flatten() {
        let kind = dep["kind"].as_str();
        if kind == Some("dev") {
            continue;
        }
        let local = match dep["path"].as_str() {
            Some(path) if !is_nsh(dep) => {
                let path = Path::new(path);
                let uses_nsh = package_metadata(path)?["dependencies"]
                    .as_array()
                    .is_some_and(|deps| deps.iter().any(is_nsh));
                if uses_nsh {
                    Some(write_retargeted(ws, path, nsh)?)
                } else {
                    None
                }
            }
            _ => None,
        };
        let table = if kind == Some("build") {
            "build-dependencies"
        } else {
            "dependencies"
        };
        let table = match dep["target"].as_str() {
            Some(target) => format!("target.{target:?}.{table}"),
            None => table.to_owned(),
        };
        let key = dep["rename"]
            .as_str()
            .or(dep["name"].as_str())
            .unwrap_or_default();
        tables.entry(table).or_default().push_str(&format!(
            "{key:?} = {}\n",
            retargeted_dependency(dep, nsh, local.as_deref())
        ));
    }
    for (table, lines) in tables {
        text.push_str(&format!("\n[{table}]\n{lines}"));
    }
    write(&out.join("Cargo.toml"), &text)?;
    // Where `assets!` finds the crate's files (`nsh-macros` `assets.rs`).
    write(&out.join("nsh-source-dir"), &dir.to_string_lossy())?;
    Ok(out)
}

/// The `name` of the `[package]` of `manifest`.
pub(crate) fn package_name(manifest: &Path) -> anyhow::Result<String> {
    let text = fs::read_to_string(manifest)
        .with_context(|| format!("nsh.json: \"rust\": no {}", manifest.display()))?;
    let mut in_package = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_package = line == "[package]";
        } else if in_package
            && let Some(value) = line.strip_prefix("name")
            && let Some(value) = value.trim_start().strip_prefix('=')
        {
            return Ok(value.trim().trim_matches('"').to_owned());
        }
    }
    bail!("{}: no [package] name", manifest.display())
}

/// The name of a generated crate and its binary: `nsh-app-<package>-<what>`
/// for one crate (`nsh-app-gallery-native-describe`), and for several the
/// first crate's package and the first 8 hex digits of the SHA-256 of all
/// of them, sorted (`nsh-app-charts-ef5aa537-describe` for `charts` and
/// `storage`). The name stays as short with twelve crates as with two:
/// MSVC's `link.exe` cannot open paths over 260 characters, even with
/// Windows' long paths on, and `target\debug\deps\<name>.exe` is one.
fn bin_name(packages: &[&str], what: &str) -> String {
    match packages {
        [] | [_] => format!("nsh-app-{}-{what}", packages.join("-")),
        [first, ..] => {
            let mut sorted = packages.to_vec();
            sorted.sort_unstable();
            let digest = Sha256::digest(sorted.join("\n"));
            let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
            format!("nsh-app-{first}-{hex}-{what}")
        }
    }
}

/// Writes `path` when its contents differ (Cargo rebuilds on changes).
fn write(path: &Path, contents: &str) -> anyhow::Result<()> {
    if fs::read_to_string(path).is_ok_and(|old| old == contents) {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, contents).with_context(|| format!("write {}", path.display()))
}

impl RustApp {
    /// Its binaries' names, after the app ([`bin_name`]), so they do not
    /// clash with the app's own binaries in its `target`.
    fn bin(&self, what: &str) -> String {
        let packages: Vec<&str> = self.crates.iter().map(|c| c.package.as_str()).collect();
        bin_name(&packages, what)
    }

    /// Its crates' packages, for what the steps say they build
    /// (`charts, storage`).
    fn packages(&self) -> String {
        let packages: Vec<&str> = self.crates.iter().map(|c| c.package.as_str()).collect();
        packages.join(", ")
    }

    /// Whether `path` is part of the app's Rust code (the sources and
    /// manifest of a crate it builds with, and the files of its `assets/`
    /// directory: the crate reads them when it builds), never what its
    /// builds write (a `target/`, or `CARGO_TARGET_DIR` in a crate's
    /// directory).
    pub(crate) fn is_rust(&self, path: &Path) -> bool {
        self.is_rust_in(path, self.target_dir().ok().as_deref())
    }

    /// [`Self::is_rust`] with the builds in `target`.
    fn is_rust_in(&self, path: &Path, target: Option<&Path>) -> bool {
        if let Some(target) = target
            && (path.starts_with(target)
                || fs::canonicalize(target).is_ok_and(|t| path.starts_with(t)))
        {
            return false;
        }
        self.watched.iter().any(|dir| {
            let Ok(rest) = path.strip_prefix(dir) else {
                return false;
            };
            !rest.starts_with("target")
                && !rest.starts_with(".nsh")
                && !rest.starts_with(".git")
                && !crate::dev::in_nested_checkout(dir, path)
                && (rest.starts_with("assets")
                    || path.extension().is_some_and(|e| e == "rs")
                    || path.file_name().is_some_and(|n| n == "Cargo.toml"))
        })
    }

    /// Its crates: `nsh.json` `"rust"`'s, its nshm, then those they depend
    /// on through Cargo.
    pub(crate) fn crates(&self) -> &[AppCrate] {
        &self.crates
    }

    /// The directories of the app's Rust code (watched in development): its
    /// crates' and those of the local crates they depend on.
    pub(crate) fn watched(&self) -> &[PathBuf] {
        &self.watched
    }

    /// Watches the app's Rust code with `watcher`.
    fn watch_with(&self, watcher: &mut impl notify::Watcher) -> anyhow::Result<()> {
        for dir in &self.watched {
            watcher
                .watch(dir, notify::RecursiveMode::Recursive)
                .with_context(|| format!("watch {}", dir.display()))?;
        }
        Ok(())
    }

    /// Reports `error` (a build of the code just saved failed) and waits for
    /// the app's Rust code to change again.
    pub(crate) fn wait_after(&self, error: &anyhow::Error) -> anyhow::Result<()> {
        ui::report(error);
        ui::detail(ui::dim("fix the code and save: nsh builds it again"));
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    let _ = tx.send(event);
                }
            })?;
        self.watch_with(&mut watcher)?;
        loop {
            if ui::stop_requested() {
                return Ok(());
            }
            let event = match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(event) => event,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    bail!("stopped watching the app's Rust code");
                }
            };
            // Reads (inotify reports them) change nothing.
            if !matches!(event.kind, notify::EventKind::Access(_))
                && event.paths.iter().any(|p| self.is_rust(p))
            {
                // Editors save in several writes: let them settle.
                std::thread::sleep(std::time::Duration::from_millis(100));
                while rx.try_recv().is_ok() {}
                return Ok(());
            }
        }
    }

    /// What the steps say they build: `the Rust crate charts`, `the Rust
    /// crates charts, storage`.
    fn crates_what(&self) -> String {
        match self.crates.as_slice() {
            [one] => format!("the Rust crate {}", one.package),
            _ => format!("the Rust crates {}", self.packages()),
        }
    }

    /// The UI sets of the app's crates, in `nsh.json`'s order, as their
    /// describe program says (built first: Cargo builds it again when the
    /// app's Rust code changed). Its output is kept in
    /// `.nsh/rust/description.json`, with the program's size and time, until
    /// the program changes.
    pub(crate) fn describe(&self) -> anyhow::Result<Vec<SetDescription>> {
        let what = self.crates_what();
        let program = self.build(
            &self.workspace,
            &self.bin("describe"),
            None,
            false,
            &[],
            &what,
        )?;
        let cache = self.workspace.join("description.json");
        let stamp = stamp(&program)?;
        let cached = fs::read_to_string(&cache).ok().and_then(|text| {
            let cached: serde_json::Value = serde_json::from_str(&text).ok()?;
            (cached["stamp"].as_str()? == stamp)
                .then(|| cached["description"].as_str().map(str::to_owned))?
        });
        let text = match cached {
            Some(text) => text,
            None => {
                let output = Command::new(&program)
                    .output()
                    .with_context(|| format!("run {}", program.display()))?;
                if !output.status.success() {
                    return Err(ui::failure(
                        format!("describing {what} failed ({})", output.status),
                        String::from_utf8_lossy(&output.stderr),
                    ));
                }
                let text = String::from_utf8(output.stdout)
                    .with_context(|| format!("the description of {what} is not UTF-8"))?;
                write(
                    &cache,
                    &serde_json::json!({ "stamp": stamp, "description": text }).to_string(),
                )?;
                text
            }
        };
        read_description(&text, &self.crates, &what)
    }

    /// The app's headless runner (`nsh test`), built for this machine.
    pub(crate) fn test_runner(&self) -> anyhow::Result<PathBuf> {
        self.build(
            &self.workspace,
            &self.bin("test"),
            None,
            false,
            &[],
            &format!("the headless runner of {}", self.packages()),
        )
    }

    /// The generated workspace.
    fn write_workspace(&self) -> anyhow::Result<()> {
        let src = |c: &str| self.nsh.dep(c, "");
        let app = self.dependencies();
        let package = |name: &str| {
            format!(
                "[package]\nname = {:?}\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n",
                self.bin(name)
            )
        };
        let sets = self.sets();
        let ws = &self.workspace;
        let web_dev = self.web_dev_profile();
        // A Rust app's runners too (`nsh.json` "root"), only then: they
        // name its root component.
        let rust = if self.root.is_some() {
            ", \"rust-linux\", \"rust-macos\", \"rust-windows\", \"rust-ios\", \"rust-android\", \"rust-web\", \"rust-app\""
        } else {
            ""
        };
        self.write_workspace_manifest(
            ws,
            &format!("# Generated by nsh for the app's Rust crate (nsh.json \"rust\"): do not edit.\n\
             [workspace]
resolver = \"3\"
members = [\"hack\", \"describe\", \"test\", \"ios-host\", \"ios-app\", \"macos-host\", \"macos-app\", \"linux-host\", \"linux-app\", \"windows-host\", \"windows-app\", \"android\", \"web\"{rust}]
# GPUI's and the terminal's hosts are workspaces of their own, written when
# they are built (`RustApp::gpui_workspace`, `RustApp::tui_workspace`): other
# builds never resolve their crates.
exclude = [\"gpui\", \"tui\"]

# The web runtime, as nsh builds its own (nsh's `Cargo.toml`): for size.
[profile.web]
inherits = \"release\"
opt-level = \"z\"
lto = \"fat\"
codegen-units = 1
strip = true
panic = \"abort\"
{web_dev}"),
            false,
        )?;
        // What earlier versions of nsh wrote: the app's own command line,
        // the runners of the former `nsh trace`.
        for old in ["cli", "trace", "rust-trace", "tui-host"] {
            let _ = fs::remove_dir_all(ws.join(old));
        }
        let _ = fs::remove_file(ws.join("app.json"));
        if self.retargeted {
            // One from a registry or Git keeps its source, as the app's
            // crates' retargeted manifests do (`retargeted_dependency`).
            for c in self.crates.iter().filter(|c| !c.is_fetched()) {
                write_retargeted(ws, &c.dir, &self.nsh)?;
            }
        }
        self.write_hack_placeholder(ws)?;
        self.write_describe(ws)?;
        self.write_test(ws)?;
        for (dir, lib, what) in [
            ("ios-host", "nsh-ios-host", "development host"),
            ("ios-app", "nsh-ios-app", "release runner"),
            ("linux-host", "nsh-linux-host", "development host"),
            ("linux-app", "nsh-linux-app", "release runner"),
            ("macos-host", "nsh-macos-host", "development host"),
            ("macos-app", "nsh-macos-app", "release runner"),
            ("windows-host", "nsh-windows-host", "development host"),
            ("windows-app", "nsh-windows-app", "release runner"),
        ] {
            self.write_host(ws, dir, lib, what)?;
        }
        self.write_web(ws)?;
        if let Some(root) = &self.root {
            self.write_rust_runners(ws, root)?;
        }
        // Its features forward to the platform crate's, with no crate's
        // defaults, so `nsh package` can build the release library with
        // only those the app uses ([`runner_feature_args`]); by default,
        // and for development (`dev`), all of them.
        let all = runner_features("nsh-platform-android");
        let forward: String = all
            .iter()
            .map(|f| format!("{f} = [\"nsh-platform-android/{f}\"]\n"))
            .collect();
        let default = all
            .iter()
            .map(|f| format!("{f:?}"))
            .collect::<Vec<_>>()
            .join(", ");
        let off = ", default-features = false";
        write(
            &ws.join("android/Cargo.toml"),
            &format!(
                "{}\n[lib]\nname = {:?}\npath = \"lib.rs\"\ncrate-type = [\"cdylib\"]\n\n\
                 [features]\ndefault = [{default}]\ndev = [\"nsh-platform-android/dev\"]\n{forward}\n\
                 [dependencies]\nnsh-core = {}\nnsh-platform-android = {}\nnsh-base = {}\n{app}\n",
                package("android"),
                self.android_lib(false),
                src("nsh-core"),
                self.nsh.dep("nsh-platform-android", off),
                self.nsh.dep("nsh-base", off),
            ),
        )?;
        write(&ws.join("android/build.rs"), ANDROID_BUILD_RS)?;
        let android = "#[cfg(target_os = \"android\")]\n";
        // A Rust app's root, which the development library runs when a
        // test session says so (`nsh test --target android`).
        let root = match &self.root {
            Some(root) => format!(
                "{android}nsh::root!(app_root());\n{}",
                self.root_fn(android, root)
            ),
            None => String::new(),
        };
        write(
            &ws.join("android/lib.rs"),
            &format!(
                "//! The app's `libnsh.so`: the Android runtime with `nsh/base` and the\n//! app's Rust components.\n\n\
                 {android}nsh::ui_sets!({sets});\n{android}nsh::components!(app_components);\n{root}{}{}",
                self.app_sets(android),
                self.app_components(android, "nsh", "android"),
            ),
        )?;
        self.unify_features(ws);
        Ok(())
    }

    /// The dependency on `<ws>/hack` ([`Self::unify_features`]).
    fn hack_dependency(&self) -> String {
        format!(
            "workspace-hack = {{ package = {:?}, path = \"../hack\" }}",
            self.bin("hack")
        )
    }

    /// Writes `<ws>/hack` with no dependencies, unless it is there.
    fn write_hack_placeholder(&self, ws: &Path) -> anyhow::Result<()> {
        if ws.join("hack/Cargo.toml").is_file() {
            return Ok(());
        }
        self.write_hack(ws, "", "")
    }

    fn write_hack(&self, ws: &Path, key: &str, dependencies: &str) -> anyhow::Result<()> {
        write(&ws.join("hack/lib.rs"), HACK_LIB_RS)?;
        write(
            &ws.join("hack/Cargo.toml"),
            &format!(
                "# Generated by nsh (`RustApp::unify_features`): do not edit.\n# key: {key}\n\
                 [package]\nname = {:?}\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n\
                 [lib]\npath = \"lib.rs\"\n{dependencies}",
                self.bin("hack"),
            ),
        )
    }

    /// Makes the describing program, the headless runner and this
    /// machine's development host build one copy of what they share.
    ///
    /// The CLI builds each with its own `cargo build -p`, and Cargo
    /// unifies features only within one invocation: each program resolved
    /// `nsh-core`, `nsh-base`, their dependencies and the app's crates with
    /// its own features, and built them once per program (#1684). `<ws>/hack`,
    /// which the three depend on, names every package of the describing
    /// program's dependency tree with the features Cargo unifies over the
    /// workspace (`cargo metadata`), as cargo-hakari does, for this
    /// machine's target only. Cargo's `resolver.feature-unification =
    /// "workspace"` will replace it once it is stable.
    ///
    /// Best effort: when Cargo cannot say, or when the workspace's features
    /// would make the describing program build a package it does not build
    /// on its own ([`hack_dependencies`]), the hack stays empty and each
    /// program builds as before. It stays empty too when only the
    /// describing program is built for this machine (`nsh build`, `nsh
    /// check`, a package or a host for another target): it has nothing to
    /// share, and the hack would give it the features of this machine's
    /// hosts and runners. Those that need system libraries only the hosts
    /// use (WebKitGTK for Linux's web views) the hack never names
    /// ([`HOST_ONLY_FEATURES`]): `nsh test` builds without them.
    fn unify_features(&self, ws: &Path) {
        if !self.unify {
            let current = fs::read_to_string(ws.join("hack/Cargo.toml")).unwrap_or_default();
            if current.lines().nth(1) != Some("# key: ") {
                let _ = self.write_hack(ws, "", "");
            }
            return;
        }
        let Some(triple) = host_triple() else {
            return;
        };
        let key = self.hack_key(ws, &triple);
        let current = fs::read_to_string(ws.join("hack/Cargo.toml")).unwrap_or_default();
        if current.lines().nth(1) == Some(&format!("# key: {key}")) {
            return;
        }
        // From an empty hack, so a feature only the former hack asked for
        // goes.
        if self.write_hack(ws, "", "").is_err() {
            return;
        }
        // What the describing program builds alone, with the hack empty.
        let Some(own) = describe_packages(ws, &self.bin("describe"), &triple) else {
            return;
        };
        let metadata = Command::new(cargo())
            .args(["metadata", "--format-version", "1", "--filter-platform"])
            .arg(&triple)
            .arg("--manifest-path")
            .arg(ws.join("Cargo.toml"))
            .stderr(std::process::Stdio::null())
            .output();
        let Ok(output) = metadata else { return };
        if !output.status.success() {
            return;
        }
        let Ok(metadata) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
            return;
        };
        let dependencies = hack_dependencies(
            &metadata,
            &self.bin("describe"),
            &self.bin("hack"),
            &triple,
            &own,
        );
        // Keyed after the hack is in Cargo.lock's terms: the key leaves out
        // the hack's own entry.
        let _ = self.write_hack(ws, &key, &dependencies);
    }

    /// What the hack depends on: the target, the workspace's manifests,
    /// the app's crates' manifests and Cargo.lock without the hack's entry.
    fn hack_key(&self, ws: &Path, triple: &str) -> String {
        let mut hash = Sha256::new();
        hash.update(triple);
        hash.update(env!("CARGO_PKG_VERSION"));
        // How the hack is made: one made before it was checked against the
        // describing program's own packages is made again.
        hash.update("own packages");
        // What the hack leaves out: a hack written before a change to it
        // is written again.
        hash.update(format!("{HOST_ONLY_FEATURES:?}"));
        let mut manifests = vec![ws.join("Cargo.toml")];
        if let Ok(entries) = fs::read_dir(ws) {
            let mut members: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.file_name().is_some_and(|n| n != "hack"))
                .map(|p| p.join("Cargo.toml"))
                .collect();
            members.sort();
            manifests.extend(members);
        }
        manifests.extend(self.crates.iter().map(|c| c.dir.join("Cargo.toml")));
        for manifest in manifests {
            if let Ok(text) = fs::read(&manifest) {
                hash.update(manifest.to_string_lossy().as_bytes());
                hash.update(&text);
            }
        }
        let lock = fs::read_to_string(ws.join("Cargo.lock")).unwrap_or_default();
        let hack = format!("name = {:?}\n", self.bin("hack"));
        for entry in lock.split("[[package]]\n") {
            if !entry.starts_with(&hack) {
                hash.update(entry);
            }
        }
        format!("{:x}", hash.finalize())
    }

    /// Writes the crate `<ws>/describe`: the program that describes the
    /// app's UI sets (nsh-core `ui::description`), linking only its crates
    /// and what their registries need, so `nsh` learns of them without
    /// building them into itself.
    fn write_describe(&self, ws: &Path) -> anyhow::Result<()> {
        write(
            &ws.join("describe/Cargo.toml"),
            &format!(
                "[package]\nname = {:?}\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n\
                 [[bin]]\nname = {:?}\npath = \"main.rs\"\n\n[dependencies]\nnsh-core = {}\n{}\n{}\n",
                self.bin("describe"),
                self.bin("describe"),
                // The sets' declarations make `.nsh/types`.
                self.nsh.dep("nsh-core", ", features = [\"declarations\"]"),
                self.dependencies(),
                self.hack_dependency(),
            ),
        )?;
        let calls: Vec<String> = self
            .crates
            .iter()
            .map(|c| format!("{}()", set_fn(c)))
            .collect();
        write(
            &ws.join("describe/main.rs"),
            &format!(
                "//! Describes the app's UI sets for `nsh`: one JSON document on standard\n\
                 //! output (nsh-core `ui::description`).\n\n\
                 fn main() {{\n    let sets = vec![{}];\n    \
                 println!(\"{{}}\", nsh_core::element::description::Description::of(&sets).to_json());\n}}\n{}{HACK_USE}",
                calls.join(", "),
                self.app_sets("")
            ),
        )
    }

    /// Writes the crate `<ws>/test`: the app's headless runner (`nsh test`,
    /// `nsh_testing::runner`) with `nsh/base` and the app's sets, and a
    /// Rust app's root. It bundles nothing (`nsh-testing` with `js`, without
    /// `bundle`): `nsh` builds the entries it asks for.
    fn write_test(&self, ws: &Path) -> anyhow::Result<()> {
        write(
            &ws.join("test/Cargo.toml"),
            &format!(
                "[package]\nname = {:?}\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n\
                 [[bin]]\nname = {:?}\npath = \"main.rs\"\n\n[dependencies]\n\
                 nsh-core = {}\nnsh-testing = {}\nnsh-base = {}\n{}\n{}\n",
                self.bin("test"),
                self.bin("test"),
                self.nsh.dep("nsh-core", ""),
                self.nsh.dep("nsh-testing", ", features = [\"js\"]"),
                self.nsh.dep("nsh-base", ""),
                self.dependencies(),
                self.hack_dependency(),
            ),
        )?;
        let (make_root, root_fn) = match &self.root {
            Some(root) => ("Some(app_root)", self.root_fn("", root)),
            None => ("None", String::new()),
        };
        write(
            &ws.join("test/main.rs"),
            &format!(
                "//! The app's headless runner (`nsh test`): its test files and the apps\n\
                 //! they open, with `nsh/base` and the app's Rust components.\n\n\
                 fn main() -> std::process::ExitCode {{\n    \
                 nsh_testing::runner({}, {make_root})\n}}\n{}{root_fn}{HACK_USE}",
                self.sets(),
                self.app_sets(""),
            ),
        )
    }

    /// Writes a Rust app's runners (`<ws>/rust-<platform>`): the release
    /// runners of the desktops and iOS ([`Self::write_rust_runner`]), the
    /// Android library and the web runtime, each mounting the app's root
    /// with no JS runtime linked (their nsh crates without the feature
    /// `js`).
    fn write_rust_runners(&self, ws: &Path, root: &RootConfig) -> anyhow::Result<()> {
        for dir in ["rust-linux", "rust-macos", "rust-windows", "rust-ios"] {
            self.write_rust_runner(ws, dir, root)?;
        }
        let app = self.dependencies();
        let sets = self.sets();
        let android = "#[cfg(target_os = \"android\")]\n";
        write(
            &ws.join("rust-android/Cargo.toml"),
            &format!(
                "[package]\nname = {:?}\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n\
                 [lib]\nname = {:?}\npath = \"lib.rs\"\ncrate-type = [\"cdylib\"]\n\n\
                 [dependencies]\nnsh-core = {}\nnsh-base = {}\n{app}\n\n\
                 [target.'cfg(target_os = \"android\")'.dependencies]\n\
                 nsh-platform-android = {}\n",
                self.bin("rust-android"),
                self.android_lib(true),
                self.nsh.dep("nsh-core", ""),
                self.nsh.dep("nsh-base", HIGHLIGHT),
                self.nsh.dep(
                    "nsh-platform-android",
                    &rust_app_platform("nsh-platform-android")
                ),
            ),
        )?;
        write(
            &ws.join("rust-android/lib.rs"),
            &format!(
                "//! The Rust app's `libnsh.so`: its root, which `AppActivity` runs, with\n\
                 //! `nsh/base` and the app's components; no JS runtime.\n\n\
                 {android}nsh::ui_sets!({sets});\n{android}nsh::components!(app_components);\n{android}nsh::main!(app_root());\n\n\
                 // Off Android it is empty, as nsh-platform-android is.\n\
                 #[cfg(not(target_os = \"android\"))]\nuse nsh_core as _;\n\
                 #[cfg(not(target_os = \"android\"))]\nuse nsh_base as _;\n{}{}{}",
                self.app_sets(android),
                self.app_components(android, "nsh", "android"),
                self.root_fn(android, root),
            ),
        )?;
        write(&ws.join("rust-android/build.rs"), ANDROID_BUILD_RS)?;
        let wasm = "#[cfg(target_arch = \"wasm32\")]\n";
        write(
            &ws.join("rust-web/Cargo.toml"),
            &format!(
                "[package]\nname = {:?}\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n\
                 [lib]\nname = {:?}\npath = \"lib.rs\"\ncrate-type = [\"cdylib\"]\n\n\
                 [features]\n# What `nsh package` links the app's runtime from (its relocations kept).\n\
                 linkable = [\"nsh-platform-web/linkable\"]\n\n\
                 [dependencies]\nnsh-core = {}\nnsh-base = {}\n{app}\n\n\
                 [target.'cfg(target_arch = \"wasm32\")'.dependencies]\n\
                 nsh-platform-web = {}\n",
                self.bin("rust-web"),
                self.rust_web_lib(),
                self.nsh.dep("nsh-core", ""),
                self.nsh.dep("nsh-base", HIGHLIGHT),
                self.nsh
                    .dep("nsh-platform-web", ", default-features = false"),
            ),
        )?;
        self.write_rust_app(ws, root)?;
        write(&ws.join("rust-web/build.rs"), WEB_BUILD_RS)?;
        let sets = self.rust_sets();
        write(
            &ws.join("rust-web/lib.rs"),
            &format!(
                "//! The Rust app's web runtime: its root, which `nsh.js` runs, with the\n\
                 //! `nsh/base` and the app's components; no QuickJS. `nsh/base` is its\n\
                 //! core part: the app makes its components by type, which links\n\
                 //! only those it uses.\n\n\
                 {wasm}nsh_platform_web::rust_app!({sets}, app_root());\n\n\
                 // Off WebAssembly it is empty, as nsh-platform-web is.\n\
                 #[cfg(not(target_arch = \"wasm32\"))]\nuse nsh_core as _;\n\
                 #[cfg(not(target_arch = \"wasm32\"))]\nuse nsh_base as _;\n{}{}",
                self.app_sets(wasm),
                self.root_fn(wasm, root),
            ),
        )
    }

    /// Writes `<ws>/rust-app`: the Rust app's UI sets and root as a library
    /// of no platform, `nsh_rust_app`, for the runners of platforms
    /// implemented outside NSH (`docs/dev/platforms.md`), which depend on it
    /// by path instead of generating this code themselves.
    fn write_rust_app(&self, ws: &Path, root: &RootConfig) -> anyhow::Result<()> {
        write(
            &ws.join("rust-app/Cargo.toml"),
            &format!(
                "[package]\nname = {:?}\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n\
                 [lib]\nname = \"nsh_rust_app\"\npath = \"lib.rs\"\n\n\
                 [dependencies]\nnsh-core = {}\nnsh-base = {}\n{}\n",
                self.bin("rust-app"),
                self.nsh.dep("nsh-core", ""),
                self.nsh.dep("nsh-base", HIGHLIGHT),
                self.dependencies(),
            ),
        )?;
        write(
            &ws.join("rust-app/lib.rs"),
            &format!(
                "//! The Rust app's UI sets and root, on no platform: what the runner of a\n\
                 //! platform implemented outside NSH starts (`docs/dev/platforms.md`).\n\n\
                 /// The UI sets the app serves: `nsh/base`, then the app's crates'.\n\
                 pub fn ui_sets() -> Vec<nsh_core::element::Registry> {{\n    {}\n}}\n\n\
                 /// The app's crates' UI sets without `nsh/base`'s: what a platform that runs\n\
                 /// no TSX serves (their files, such as fonts), so that its module links only\n\
                 /// the base components the app's code uses.\n\
                 pub fn app_ui_sets() -> Vec<nsh_core::element::Registry> {{\n    {}\n}}\n\n\
                 /// The app's root (`nsh.json` `\"root\"`), with its theme, appearance and status bar.\n\
                 pub fn root() -> nsh_core::element::Root {{\n    app_root()\n}}\n{}{}",
                self.sets(),
                self.app_only_sets(),
                self.app_sets(""),
                self.root_fn("", root),
            ),
        )
    }

    /// Writes the crate `<ws>/<dir>` (`rust-linux`, `rust-macos`,
    /// `rust-windows`, `rust-ios`): the platform's release
    /// runner (`nsh-linux-app`, ...) without the feature `js`, whose
    /// `run_rust` mounts the app's root.
    fn write_rust_runner(&self, ws: &Path, dir: &str, root: &RootConfig) -> anyhow::Result<()> {
        let app = self.dependencies();
        let sets = self.rust_sets();
        let (os, lib, platform, exit) = match dir {
            "rust-linux" => (
                "target_os = \"linux\"",
                "nsh-linux-app",
                "nsh-platform-linux",
                true,
            ),
            "rust-macos" => (
                "target_os = \"macos\"",
                "nsh-macos-app",
                "nsh-platform-macos",
                true,
            ),
            "rust-windows" => ("windows", "nsh-windows-app", "nsh-platform-windows", true),
            _ => (
                "target_os = \"ios\"",
                "nsh-ios-app",
                "nsh-platform-ios",
                false,
            ),
        };
        write(
            &ws.join(dir).join("Cargo.toml"),
            &format!(
                "[package]\nname = {:?}\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n\
                 [[bin]]\nname = {:?}\npath = \"main.rs\"\n\n\
                 [dependencies]\n{lib} = {}\n\
                 nsh-core = {}\nnsh-base = {}\n{app}\n\n\
                 [target.'cfg({os})'.dependencies]\n{platform} = {}\n",
                self.bin(dir),
                self.bin(dir),
                self.nsh.dep(lib, ", default-features = false"),
                self.nsh.dep("nsh-core", ""),
                self.nsh.dep("nsh-base", HIGHLIGHT),
                self.nsh.dep(platform, &rust_app_platform(platform)),
            ),
        )?;
        let lib = lib.replace('-', "_");
        let platform = platform.replace('-', "_");
        let cfg = format!("#[cfg({os})]\n");
        // A windowed program: no console opens with the app.
        let subsystem = if dir == "rust-windows" {
            "\n#![cfg_attr(windows, windows_subsystem = \"windows\")]\n"
        } else {
            ""
        };
        let (ret, tail) = if exit {
            (" -> std::process::ExitCode", "")
        } else {
            ("", ";")
        };
        let (set_components, components_fn) = match components_platform(dir) {
            Some(key) => (
                format!("\n        {platform}::set_components(app_components);"),
                self.app_components(&cfg, &platform, key),
            ),
            None => (String::new(), String::new()),
        };
        write(
            &ws.join(dir).join("main.rs"),
            &format!(
                "//! The Rust app's executable: its root with `nsh/base` and the app's\n\
                 //! components, on {lib}'s runner; no JS runtime.\n{subsystem}\n\
                 fn main(){ret} {{\n    \
                 #[cfg({os})]\n    {{\n        \
                 {platform}::set_ui_sets({sets});{set_components}\n        \
                 {lib}::run_rust(app_root()){tail}\n    }}\n    \
                 #[cfg(not({os}))]\n    {lib}::main(){tail}\n}}\n{}{components_fn}{}",
                self.app_sets(&cfg),
                self.root_fn(&cfg, root),
            ),
        )
    }

    /// The Rust app's web runtime's library name ([`Self::web_lib`]).
    fn rust_web_lib(&self) -> String {
        self.bin("rust-web").replace('-', "_")
    }

    /// The library name of the app's Android library (`rust`: a Rust app's
    /// runner), named after the app as its binaries are, so apps sharing a
    /// target directory (`CARGO_TARGET_DIR`) never take each other's; it is
    /// installed as `libnsh.so`.
    fn android_lib(&self, rust: bool) -> String {
        self.bin(if rust { "rust-android" } else { "android" })
            .replace('-', "_")
    }

    /// Writes the crate `<ws>/web`: the web runtime (`nsh-platform-web`, a
    /// WebAssembly module) with `nsh/base` and the app's set, which
    /// `nsh.js` registers through the module's `nsh_app_init`.
    fn write_web(&self, ws: &Path) -> anyhow::Result<()> {
        let src = |c: &str| self.nsh.dep(c, "");
        let app = self.dependencies();
        let sets = self.sets();
        let wasm = "#[cfg(target_arch = \"wasm32\")]\n";
        write(
            &ws.join("web/Cargo.toml"),
            &format!(
                "[package]\nname = {:?}\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n\
                 [lib]\nname = {:?}\npath = \"lib.rs\"\ncrate-type = [\"cdylib\"]\n\n\
                 [features]\n# The runtime of published apps: TSX on the browser's JavaScript engine.\n\
                 browser = [\"nsh-platform-web/browser\"]\n\
                 # The development host's: hot updates, and what `nsh test --target web` asks about.\n\
                 dev = [\"nsh-platform-web/dev\"]\n                 # What `nsh package` links the app's runtime from (its relocations kept).\n\
                 linkable = [\"nsh-platform-web/linkable\"]\n\n\
                 [dependencies]\nnsh-core = {}\nnsh-base = {}\n{app}\n\n\
                 [target.'cfg(target_arch = \"wasm32\")'.dependencies]\nnsh-platform-web = {}\n",
                self.bin("web"),
                self.web_lib(),
                src("nsh-core"),
                self.nsh.dep("nsh-base", HIGHLIGHT),
                self.nsh
                    .dep("nsh-platform-web", ", default-features = false"),
            ),
        )?;
        // nsh's `.cargo/config.toml` gives its own web runtime this stack
        // (deep component trees); the app's build does
        // not run under it, so this package passes the link argument.
        write(&ws.join("web/build.rs"), WEB_BUILD_RS)?;
        // A Rust app's root too, which the development host's page runs
        // when a test session says so (`nsh test --target web`).
        let (register, root) = match &self.root {
            Some(root) => (
                format!("{wasm}nsh_platform_web::rust_app!({sets}, app_root());\n"),
                self.root_fn(wasm, root),
            ),
            // One gate per set (`nsh_ui_set_*`), as `nsh/base`'s parts have:
            // `nsh package` keeps those of the sets the app imports.
            None => (self.set_gates(wasm), String::new()),
        };
        write(
            &ws.join("web/lib.rs"),
            &format!(
                "//! The app's web runtime: `nsh.wasm` with `nsh/base` and the app's\n//! Rust components.\n\n\
                 {register}{}{root}\n\
                 // Off WebAssembly it is empty, as nsh-platform-web is.\n\
                 #[cfg(not(target_arch = \"wasm32\"))]\nuse nsh_core as _;\n\
                 #[cfg(not(target_arch = \"wasm32\"))]\nuse nsh_base as _;\n",
                self.app_sets(wasm)
            ),
        )
    }

    /// The profile of the development web runtime (`web-dev`, for
    /// [`WebKind::Dev`](crate::runtime::WebKind::Dev)), which is built again
    /// on every change to the app's Rust code: incremental and without LTO,
    /// so an edit to an app crate rebuilds in well under a second where
    /// `web`'s fat LTO over one codegen unit re-optimizes the whole module.
    /// The app's crates are at `-O1` (what changes), the other crates for
    /// size. It panics
    /// as `web` does (`abort`) and has no debug assertions, so the page
    /// behaves as the published one.
    fn web_dev_profile(&self) -> String {
        let mut profile = String::from(
            "
# The development web runtime (`nsh run --target web`): built again on
# every change to the app's Rust code, so incremental and without LTO; the
# app's crates at -O1, the others for size.
[profile.web-dev]
inherits = \"dev\"
opt-level = 1
debug = false
debug-assertions = false
overflow-checks = false
panic = \"abort\"
[profile.web-dev.package.\"*\"]
opt-level = \"s\"
",
        );
        for c in self.crates.iter().filter(|c| !c.is_fetched()) {
            profile.push_str(&format!(
                "[profile.web-dev.package.{:?}]\nopt-level = 1\n",
                c.package
            ));
        }
        profile
    }

    /// The web runtime's library name (its module is `<name>.wasm`),
    /// after the app as its binaries are ([`Self::bin`]).
    fn web_lib(&self) -> String {
        self.bin("web").replace('-', "_")
    }

    /// The app's web runtime of `kind` (its `nsh.wasm` / `nsh-dev.wasm`, and
    /// nsh's `nsh.js`), built for `wasm32-unknown-unknown`: a release one
    /// with the `web` profile as nsh builds its own (`runtime::web`), a
    /// development one with `web-dev` ([`Self::web_dev_profile`]). Without
    /// `build`, the one built before, if any.
    pub(crate) fn web(
        &self,
        kind: crate::runtime::WebKind,
        build: bool,
    ) -> anyhow::Result<Option<crate::runtime::WebRuntime>> {
        self.web_runtime(kind, build, self.root.is_some())
    }

    /// The web runtime `nsh test --target web` runs the app in: the
    /// development host's, a Rust app's too (with its root, which the page
    /// runs when the test session says so).
    pub(crate) fn test_web(&self) -> anyhow::Result<crate::runtime::WebRuntime> {
        self.web_runtime(crate::runtime::WebKind::Dev, true, false)?
            .context("no web runtime")
    }

    /// [`Self::web`]; `rust`: a Rust app's runtime, with no QuickJS.
    fn web_runtime(
        &self,
        kind: crate::runtime::WebKind,
        build: bool,
        rust: bool,
    ) -> anyhow::Result<Option<crate::runtime::WebRuntime>> {
        const WASM: &str = "wasm32-unknown-unknown";
        let out = self.workspace.join("web-runtime");
        let wasm = if rust {
            out.join("nsh-rust.wasm")
        } else {
            out.join(kind.file())
        };
        // The module's wasm-bindgen glue, when the app's crates call JS
        // through wasm-bindgen (`crate::bindgen`).
        let stem = wasm
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("nsh")
            .to_owned();
        let glue = out.join(format!("{stem}-bindgen.js"));
        let mut runtime = crate::runtime::WebRuntime {
            glue: glue.exists().then_some(glue),
            wasm,
            // Use a checkout's JS directly so edits apply. For Cargo dependencies,
            // copy the resolved crate's JS next to the built module below.
            js: match &self.nsh {
                Nsh::Source(source)
                | Nsh::Git {
                    checkout: source, ..
                } => source.join("crates/nsh-platform-web/web/nsh.js"),
                Nsh::Registry | Nsh::Nightly(_) => out.join("nsh.js"),
            },
            syntaxes: crate::runtime::syntaxes_in(&out),
        };
        if !build {
            return Ok((runtime.wasm.exists() && runtime.js.exists()).then_some(runtime));
        }
        let mut cmd = Command::new(cargo());
        // The C code of the dependencies (zstd) needs an `ar` that knows
        // WebAssembly objects.
        let ar = format!("AR_{}", WASM.replace('-', "_"));
        if env::var_os(&ar).is_none() && env::var_os("AR").is_none() {
            cmd.env(&ar, "llvm-ar");
        }
        // A Rust app's runtime is one: it has no JS, so no hot updates.
        // The published one is linkable, as nsh's own (`runtime::WebKind`):
        // `nsh package` drops the parts and sets the app does not use.
        let features: &[&str] = match kind {
            crate::runtime::WebKind::Browser if rust => &["--features", "linkable"],
            _ if rust => &[],
            crate::runtime::WebKind::Browser => &["--features", "browser,linkable"],
            crate::runtime::WebKind::Dev => &["--features", "dev"],
        };
        let (package, artifact) = if rust {
            (
                self.bin("rust-web"),
                format!("{}.wasm", self.rust_web_lib()),
            )
        } else {
            (self.bin("web"), format!("{}.wasm", self.web_lib()))
        };
        let build = Build {
            workspace: &self.workspace,
            package: &package,
            triple: Some(WASM),
            release: false,
            profile: Some(web_profile(kind)),
            extra: features,
            artifact: &artifact,
            what: &format!("the web runtime of {}", self.packages()),
        };
        let built = self.build_with(cmd, &build)?;
        fs::create_dir_all(&out)?;
        // Both kinds build to the same file: each keeps a copy of its own,
        // through wasm-bindgen when the app's crates call JS through it.
        runtime.glue = crate::bindgen::install(&built, &out, &stem)?;
        if self.nsh.source().is_none() {
            let js = self.resolved_crate("nsh-platform-web")?.join("web/nsh.js");
            crate::runtime::copy_browser_host(
                js.parent().context("web runtime has no parent")?,
                &out,
            )?;
            fs::copy(&js, &runtime.js)
                .with_context(|| format!("copy {} to {}", js.display(), runtime.js.display()))?;
        }
        // The syntaxes the module leaves out, as this workspace resolves them.
        runtime.syntaxes = Some(crate::runtime::write_syntaxes(
            &self.workspace.join("Cargo.toml"),
            &out,
        )?);
        Ok(Some(runtime))
    }

    /// Where Cargo resolved nsh's crate `name` at [`VERSION`] for this workspace.
    fn resolved_crate(&self, name: &str) -> anyhow::Result<PathBuf> {
        crate::runtime::package_dir(&self.workspace.join("Cargo.toml"), name, Some(VERSION))
    }

    /// The workspace of the app's GPUI development host
    /// (`<workspace>/gpui`), written when it is built: GPUI pulls in crates
    /// (wry, GStreamer, ...) the other targets never need, and a member of
    /// the main workspace would make every build resolve them. It builds in
    /// the same target directory. GPUI has no release runner: it is the
    /// backend for embedding in GPUI apps.
    fn gpui_workspace(&self) -> anyhow::Result<PathBuf> {
        let ws = self.workspace.join("gpui");
        self.write_workspace_manifest(
            &ws,
            "# Generated by nsh for the app's Rust crate (nsh.json \"rust\"): do not edit.\n\
             [workspace]\nresolver = \"3\"\nmembers = [\"gpui-host\"]\n",
            true,
        )?;
        self.write_host(&ws, "gpui-host", "nsh-gpui-host", "development host")?;
        Ok(ws)
    }

    /// The workspace of the app's terminal development host
    /// (`<workspace>/tui`), written when it is built: nsh's crates.io
    /// releases before the terminal backend lack its crates, and a member of
    /// the main workspace would make every build (`nsh check`'s `describe`,
    /// `nsh test`) resolve them. It builds in the same target directory.
    fn tui_workspace(&self) -> anyhow::Result<PathBuf> {
        let ws = self.workspace.join("tui");
        self.write_workspace_manifest(
            &ws,
            "# Generated by nsh for the app's Rust crate (nsh.json \"rust\"): do not edit.\n\
             [workspace]\nresolver = \"3\"\nmembers = [\"tui-host\"]\n",
            false,
        )?;
        self.write_tui_host(&ws)?;
        Ok(ws)
    }

    /// Built against a checkout, the app's crates.io dependencies on nsh are
    /// patched to it: they must resolve to the same core as the generated
    /// hosts, or their component and registry types differ.
    fn write_workspace_manifest(&self, ws: &Path, base: &str, gpui: bool) -> anyhow::Result<()> {
        let path = ws.join("Cargo.toml");
        let mut manifest = base.to_owned();
        // Code the app does not write is built as for release, once: nsh's
        // crates, its nshm and their dependencies start and run at speed,
        // and keep only line tables (a far smaller binary to link and
        // load). These run on every interaction: Objective-C signature
        // checks stay enabled, their parser optimized as well as the bridge.
        manifest.push_str(
            "\n[profile.dev.package.\"*\"]\nopt-level = 3\ndebug = \"line-tables-only\"\n",
        );
        // A shared build is nobody's code to debug: it is a release build
        // (its development host serves `--release` as well), keeping only
        // line tables, and nothing is kept to build it again faster.
        if self.shared {
            manifest.push_str(
                "\n[profile.dev]\nopt-level = 3\ndebug = \"line-tables-only\"\ndebug-assertions = false\noverflow-checks = false\nincremental = false\n",
            );
        }
        for package in ["quickjs-jit-sys", "taffy", "objc2", "objc2-encode"] {
            manifest.push_str(&format!(
                "\n[profile.dev.package.{package}]\nopt-level = 3\n"
            ));
        }
        // The app's own Rust code stays easy to debug and quick to build
        // again; so do nsh's crates built from a checkout, which change.
        let installed =
            nsh_bundler::nshm::installed_dir().and_then(|d| dunce::canonicalize(d).ok());
        let mut changing: Vec<&str> = self
            .crates
            .iter()
            .filter(|c| !c.is_fetched())
            .filter(|c| !installed.as_ref().is_some_and(|d| c.dir.starts_with(d)))
            .map(|c| c.package.as_str())
            .collect();
        if self.nsh.source().is_some() {
            changing.extend(NSH_CRATES);
        }
        for package in changing {
            manifest.push_str(&format!(
                "\n[profile.dev.package.{package:?}]\nopt-level = 0\ndebug = true\n"
            ));
        }
        // The app's crates take its nshm from Git or crates.io (`nsh
        // add`): the installed copies the lock pins, the ones the sets
        // link. One from a directory is that directory already.
        let mut crates_io = String::new();
        let mut git_patches = String::new();
        for (id, package, dir) in &self.modules {
            let line = format!("{package} = {{ path = {:?} }}\n", dir.to_string_lossy());
            match crate::nshm::patch_table(id) {
                Some(None) => crates_io.push_str(&line),
                Some(Some(url)) => git_patches.push_str(&format!("\n[patch.{url:?}]\n{line}")),
                None => {}
            }
        }
        if let Some(source) = self.nsh.source() {
            manifest.push_str("\n[patch.crates-io]\n");
            manifest.push_str(&crates_io);
            crates_io.clear();
            let mut patches = String::new();
            for name in NSH_CRATES
                .iter()
                .filter(|name| gpui || **name != "nsh-platform-gpui")
                .filter(|name| nsh_crate(source, name).join("Cargo.toml").is_file())
            {
                patches.push_str(&format!(
                    "{name} = {{ path = {:?} }}\n",
                    nsh_crate(source, name).to_string_lossy()
                ));
            }
            manifest.push_str(&patches);
            if let Nsh::Git { url, .. } = &self.nsh {
                // The app still declares Git dependencies. Redirect those
                // too so its types and the generated hosts share one core.
                manifest.push_str(&format!("\n[patch.{url:?}]\n{patches}"));
            }
        }
        if !crates_io.is_empty() {
            manifest.push_str(&format!("\n[patch.crates-io]\n{crates_io}"));
        }
        manifest.push_str(&git_patches);
        write(&path, &manifest)
    }

    /// Writes the crate `<ws>/tui-host`: the terminal development host with
    /// `nsh/base` and the app's sets.
    fn write_tui_host(&self, ws: &Path) -> anyhow::Result<()> {
        let dir = ws.join("tui-host");
        let name = self.bin("tui-host");
        write(
            &dir.join("Cargo.toml"),
            &format!(
                "[package]\nname = {name:?}\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n[[bin]]\nname = {name:?}\npath = \"main.rs\"\n\n[dependencies]\nnsh-tui-host = {}\nnsh-platform-tui = {}\nnsh-core = {}\nnsh-base = {}\n{}",
                self.nsh.dep("nsh-tui-host", ""),
                self.nsh.dep("nsh-platform-tui", ""),
                self.nsh.dep("nsh-core", ""),
                self.nsh.dep("nsh-base", HIGHLIGHT),
                self.dependencies(),
            ),
        )?;
        let (root, root_fn) = match &self.root {
            Some(root) => (
                "    options.root = Some(app_root());\n",
                self.root_fn("", root),
            ),
            None => ("", String::new()),
        };
        write(
            &dir.join("main.rs"),
            &format!(
                "//! The terminal development host with the app's UI sets.\nfn main() -> std::io::Result<()> {{\n    let mut options = nsh_platform_tui::AppOptions::default();\n    options.ui_sets = {};\n{root}    nsh_tui_host::main_with_options(options)\n}}\n{}{root_fn}",
                self.sets(),
                self.app_sets(""),
            ),
        )
    }

    /// Writes the crate `<ws>/<dir>`: the development host or release runner
    /// `lib` (`nsh-linux-host`, ...) with `nsh/base` and the app's set.
    fn write_host(&self, ws: &Path, dir: &str, lib: &str, what: &str) -> anyhow::Result<()> {
        let src = |c: &str| self.nsh.dep(c, "");
        let app = self.dependencies();
        let sets = self.sets();
        let exit = " -> std::process::ExitCode";
        let (os, name, platform, exit) = if dir.starts_with("ios") {
            ("target_os = \"ios\"", "iOS", "nsh-platform-ios", "")
        } else if dir.starts_with("macos") {
            ("target_os = \"macos\"", "macOS", "nsh-platform-macos", exit)
        } else if dir.starts_with("windows") {
            (
                "target_os = \"windows\"",
                "Windows",
                "nsh-platform-windows",
                exit,
            )
        } else if dir.starts_with("gpui") {
            (
                "any(target_os = \"linux\", target_os = \"macos\", windows)",
                "GPUI",
                "nsh-platform-gpui",
                exit,
            )
        } else {
            ("target_os = \"linux\"", "Linux", "nsh-platform-linux", exit)
        };
        // The development hosts share the features of the describing
        // program and the headless runner ([`Self::unify_features`]).
        let (hack, hack_use) = if dir.ends_with("-host") && !dir.starts_with("gpui") {
            (self.hack_dependency(), HACK_USE)
        } else {
            (String::new(), "")
        };
        // A release runner names its features itself, on its runner library
        // and with no crate's defaults, so `nsh package` can build it with
        // only those the app uses ([`runner_feature_args`]); by default,
        // all of them.
        let release = dir.ends_with("-app");
        let (lib_dep, base_dep, platform_dep, features) = if release {
            let all = runner_features(platform);
            let forward: String = all
                .iter()
                .map(|f| format!("{f} = [\"{lib}/{f}\"]\n"))
                .collect();
            let default = all
                .iter()
                .map(|f| format!("{f:?}"))
                .collect::<Vec<_>>()
                .join(", ");
            let off = ", default-features = false";
            (
                self.nsh.dep(lib, off),
                self.nsh.dep("nsh-base", off),
                self.nsh.dep(platform, off),
                format!("\n[features]\ndefault = [{default}]\n{forward}"),
            )
        } else {
            // Linux's host makes web views when this machine can build
            // them ([`crate::runtime::linux_web_views`]).
            let lib_dep = if dir == "linux-host"
                && cfg!(target_os = "linux")
                && !crate::runtime::linux_web_views()
            {
                self.nsh.dep(lib, ", default-features = false")
            } else {
                src(lib)
            };
            (
                lib_dep,
                self.nsh.dep("nsh-base", HIGHLIGHT),
                src(platform),
                String::new(),
            )
        };
        write(
            &ws.join(dir).join("Cargo.toml"),
            &format!(
                "[package]\nname = {:?}\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n\
                 [[bin]]\nname = {:?}\npath = \"main.rs\"\n\n[dependencies]\n{lib} = {lib_dep}\nnsh-core = {}\nnsh-base = {base_dep}\n{app}\n{hack}\n\
                 [target.'cfg({os})'.dependencies]\n{platform} = {platform_dep}\n{features}",
                self.bin(dir),
                self.bin(dir),
                src("nsh-core"),
            ),
        )?;
        let lib = lib.replace('-', "_");
        let platform = platform.replace('-', "_");
        // A windowed program: no console opens with the app.
        let subsystem = if dir == "windows-app" {
            "\n#![cfg_attr(windows, windows_subsystem = \"windows\")]\n"
        } else {
            ""
        };
        let cfg = format!("#[cfg({os})]\n");
        // A Rust app's development host runs its root when a test session
        // says so (`nsh test --target`): its runners have no dev server.
        let (set_root, root_fn) = match &self.root {
            Some(root) if dir.ends_with("-host") => (
                format!("\n    #[cfg({os})]\n    {platform}::set_root(app_root);"),
                self.root_fn(&cfg, root),
            ),
            _ => (String::new(), String::new()),
        };
        // The desktops' standalone backends and iOS register the app's
        // native components on every view they make.
        let (set_components, components_fn) = match components_platform(dir) {
            Some(key) => (
                format!("\n    #[cfg({os})]\n    {platform}::set_components(app_components);"),
                self.app_components(&cfg, &platform, key),
            ),
            None => (String::new(), String::new()),
        };
        write(
            &ws.join(dir).join("main.rs"),
            &format!(
                "//! The {name} {what} with `nsh/base` and the app's Rust components.\n{subsystem}\n\
                 fn main(){exit} {{\n    #[cfg({os})]\n    {platform}::set_ui_sets({sets});{set_components}{set_root}\n    {lib}::main()\n}}\n{}{components_fn}{root_fn}{hack_use}",
                self.app_sets(&cfg)
            ),
        )
    }

    /// The target directory: `CARGO_TARGET_DIR` when it is set, as for any
    /// Cargo build (a directory several checkouts or CI jobs share), else
    /// the app's own `target` (the workspace is `<app>/.nsh/rust`), where its
    /// crates build with `cargo` too.
    fn target_dir(&self) -> anyhow::Result<PathBuf> {
        target_dir(&self.workspace, env::var_os("CARGO_TARGET_DIR"))
    }

    /// `cargo build`s package `package` of the workspace `workspace` (for
    /// `triple`, else the host), the step "building <what>", and returns its
    /// binary (named as the package, with the executable suffix of this
    /// machine when built for it).
    fn build(
        &self,
        workspace: &Path,
        package: &str,
        triple: Option<&str>,
        release: bool,
        extra: &[&str],
        what: &str,
    ) -> anyhow::Result<PathBuf> {
        let artifact = format!("{package}{}", crate::runtime::exe_suffix(triple));
        let build = Build {
            workspace,
            package,
            triple,
            release,
            profile: None,
            extra,
            artifact: &artifact,
            what,
        };
        self.build_with(Command::new(cargo()), &build)
    }

    fn build_with(&self, mut cmd: Command, build: &Build<'_>) -> anyhow::Result<PathBuf> {
        let Build {
            workspace,
            package,
            triple,
            release,
            profile,
            extra,
            artifact,
            what,
        } = *build;
        crate::runtime::cross_build(&mut cmd, triple)?;
        set_deployment_target(&mut cmd, triple, &self.minimums, |name| {
            env::var_os(name).is_some()
        });
        cmd.arg("build")
            .arg("--manifest-path")
            .arg(workspace.join("Cargo.toml"))
            .args(["-p", package])
            .args(extra)
            .env("CARGO_TARGET_DIR", self.target_dir()?);
        if let Some(triple) = triple {
            cmd.args(["--target", triple]);
            if triple == "wasm32-unknown-unknown" {
                crate::runtime::web_build_flags(&mut cmd);
            }
        }
        if let Some(profile) = profile {
            cmd.args(["--profile", profile]);
        } else if release {
            cmd.arg("--release");
        }
        // Built once with what cannot change since: nothing to ask Cargo.
        let once = BuiltOnce::of(workspace, package, &cmd);
        if let Some(path) = once.as_ref().and_then(BuiltOnce::built) {
            ui::debug(format!("{what}: built already ({})", ui::path(&path)));
            return Ok(path);
        }
        if let Err(error) = ui::cargo(&mut cmd, what) {
            // A development session that ran: a mistake in the code just
            // saved waits for the fix (the command line runs again).
            if RESTARTED.load(std::sync::atomic::Ordering::Relaxed) {
                self.wait_after(&error)?;
                return Err(Restart.into());
            }
            return Err(error);
        }
        let place = |mut path: PathBuf| {
            if let Some(triple) = triple {
                path.push(triple);
            }
            path.push(match profile {
                Some(profile) => profile,
                None if release => "release",
                None => "debug",
            });
            path.push(artifact);
            path
        };
        let path = place(self.target_dir()?);
        // A cargo that keeps its own target directory (a wrapper ignoring
        // CARGO_TARGET_DIR) built it elsewhere: Cargo says where, or it is
        // the generated workspace's own `target` (a cargo that always uses
        // `./target`, whatever its metadata reports).
        let path = if path.exists() {
            path
        } else {
            cargo_target_directory(workspace)
                .into_iter()
                .chain([workspace.join("target")])
                .map(place)
                .find(|candidate| candidate.exists())
                .unwrap_or(path)
        };
        if let Some(once) = once {
            once.record(&path);
        }
        Ok(path)
    }

    /// The development host (`runner` false) or release runner of the app,
    /// built for `platform`, for `triple` (`None`: this machine), which is
    /// the platform's own ([`Platform::triple`]) but for a macOS package
    /// for another processor.
    pub(crate) fn runtime(
        &self,
        platform: Platform,
        runner: bool,
        triple: Option<&str>,
    ) -> anyhow::Result<PathBuf> {
        if let Some(triple) = triple
            && Some(triple) != platform.triple()
        {
            // Cargo runs in this directory, so rustup picks its toolchain here.
            crate::runtime::require_target(None, triple)?;
        }
        if self.root.is_some() {
            return self.rust_runner(platform, runner, triple);
        }
        self.host(platform, runner, triple)
    }

    /// The development host `nsh test --target` runs the app in: a Rust
    /// app's too, built with its root (its runners have no dev server
    /// client), which it runs when the test session says so.
    pub(crate) fn test_host(&self, platform: Platform) -> anyhow::Result<PathBuf> {
        self.host(platform, false, platform.triple())
    }

    /// The development host (`runner` false) or release runner for
    /// `platform` with the app's crates, built for `triple`.
    fn host(
        &self,
        platform: Platform,
        runner: bool,
        triple: Option<&str>,
    ) -> anyhow::Result<PathBuf> {
        let name = match (platform, runner) {
            (Platform::Linux, false) => "linux-host",
            (Platform::Linux, true) => "linux-app",
            (Platform::MacOs, false) => "macos-host",
            (Platform::MacOs, true) => "macos-app",
            (Platform::Windows, false) => "windows-host",
            (Platform::Windows, true) => "windows-app",
            (Platform::Tui, false) => "tui-host",
            (Platform::Tui, true) => {
                anyhow::bail!("terminal packaging needs the terminal release runner")
            }
            (Platform::Gpui, false) => "gpui-host",
            (Platform::Gpui, true) => unreachable!("GPUI apps are embedded, never packaged"),
            (_, false) => "ios-host",
            (_, true) => "ios-app",
        };
        let what = platform.host(runner);
        let platform_crate = match platform {
            Platform::Linux => "nsh-platform-linux",
            Platform::Windows => "nsh-platform-windows",
            Platform::MacOs => "nsh-platform-macos",
            _ => "nsh-platform-ios",
        };
        let trimmed = if runner && !matches!(platform, Platform::Gpui | Platform::Tui) {
            runner_feature_args(platform_crate)
        } else {
            Vec::new()
        };
        let trimmed: Vec<&str> = trimmed.iter().map(String::as_str).collect();
        let (workspace, features) = match platform {
            Platform::Gpui => (self.gpui_workspace()?, crate::runtime::gpui_features()),
            Platform::Tui => (self.tui_workspace()?, &[][..]),
            _ => (self.workspace.clone(), &trimmed[..]),
        };
        let package = self.bin(name);
        let asked = RELEASE_HOSTS.load(std::sync::atomic::Ordering::Relaxed);
        // A shared workspace's development host is optimized as a release
        // one already (`write_workspace_manifest`): one build serves both.
        let release = runner || asked && !self.shared;
        let what = if asked && !runner {
            format!("{what} (release build)")
        } else {
            what
        };
        let what = format!("{what}{}", crate::runtime::other_triple(platform, triple));
        self.build(&workspace, &package, triple, release, features, &what)
    }

    /// A Rust app's runner for `platform` (`rust-<platform>`): a release
    /// build for packages (`release`), a debug one for `nsh run`. Both run
    /// the app's root with no JS runtime.
    fn rust_runner(
        &self,
        platform: Platform,
        release: bool,
        triple: Option<&str>,
    ) -> anyhow::Result<PathBuf> {
        let dir = match platform {
            Platform::Linux => "rust-linux",
            Platform::MacOs => "rust-macos",
            Platform::Windows => "rust-windows",
            Platform::Tui => return self.host(platform, false, triple),
            Platform::Gpui => unreachable!("a Rust app does not run on GPUI's host"),
            Platform::IphoneOs | Platform::IphoneSimulator | Platform::MacCatalyst => "rust-ios",
        };
        let what = format!(
            "the {} runner of {}{}{}",
            match platform {
                Platform::Linux => "Linux",
                Platform::MacOs => "macOS",
                Platform::Windows => "Windows",
                Platform::Tui | Platform::Gpui => unreachable!(),
                Platform::IphoneOs => "iOS",
                Platform::IphoneSimulator => "iOS simulator",
                Platform::MacCatalyst => "Mac Catalyst",
            },
            self.packages(),
            if release { "" } else { " (debug)" },
            crate::runtime::other_triple(platform, triple)
        );
        let web_view = rust_runner_web_view(platform, || may_make_web_view(self));
        self.build(
            &self.workspace,
            &self.bin(dir),
            triple,
            release,
            &web_view,
            &what,
        )
    }

    /// Waits until `stop` returns true (or the user stops the command);
    /// a change to the app's Rust code ends it with [`Restart`] (a Rust
    /// app's `nsh run`: `nsh` builds the app again and runs it anew).
    pub(crate) fn watch(
        &self,
        mut stop: impl FnMut() -> anyhow::Result<bool>,
    ) -> anyhow::Result<()> {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    let _ = tx.send(event);
                }
            })?;
        self.watch_with(&mut watcher)?;
        loop {
            if ui::stop_requested() || stop()? {
                return Ok(());
            }
            let Ok(event) = rx.recv_timeout(std::time::Duration::from_millis(200)) else {
                continue;
            };
            // Reads (inotify reports them) change nothing.
            if !matches!(event.kind, notify::EventKind::Access(_))
                && event.paths.iter().any(|p| self.is_rust(p))
            {
                return Err(Restart.into());
            }
        }
    }

    /// The Android runtime of the app: the prebuilt runtime's `classes.dex`
    /// with the app's `libnsh.so` for each of `abis` (empty: each ABI of the
    /// prebuilt runtime).
    pub(crate) fn android(
        &self,
        prebuilt: &Path,
        dev: bool,
        abis: &[String],
    ) -> anyhow::Result<PathBuf> {
        self.android_runtime(prebuilt, dev, self.root.is_some(), abis)
    }

    /// The Android runtime `nsh test --target android` runs the app in: the
    /// development library, a Rust app's too (with its root, which it runs
    /// when the test session says so), for each of `abis` (empty: each ABI
    /// of the prebuilt runtime).
    pub(crate) fn test_android(&self, prebuilt: &Path, abis: &[String]) -> anyhow::Result<PathBuf> {
        self.android_runtime(prebuilt, true, false, abis)
    }

    /// [`Self::android`]; `rust`: a Rust app's runner library, with no
    /// development support.
    fn android_runtime(
        &self,
        prebuilt: &Path,
        dev: bool,
        rust: bool,
        abis: &[String],
    ) -> anyhow::Result<PathBuf> {
        let sdk = crate::android::Sdk::find()?;
        let out = self.workspace.join(match (rust, dev) {
            (true, true) => "android-rust-dev",
            (true, false) => "android-rust-release",
            (false, true) => "android-dev",
            (false, false) => "android-release",
        });
        fs::create_dir_all(&out)?;
        install(&prebuilt.join("classes.dex"), &out.join("classes.dex"))?;
        for entry in fs::read_dir(prebuilt.join("lib"))? {
            let abi = entry?.file_name().to_string_lossy().into_owned();
            // Only what the APK takes: each ABI is a build of its own.
            if !abis.is_empty() && !abis.contains(&abi) {
                continue;
            }
            let triple = match abi.as_str() {
                "arm64-v8a" => "aarch64-linux-android",
                "armeabi-v7a" => "armv7-linux-androideabi",
                "x86_64" => "x86_64-linux-android",
                "x86" => "i686-linux-android",
                other => bail!("unknown Android ABI {other}"),
            };
            // A Rust app's library has no development support (it has no
            // JS to reload): `nsh run` builds it in debug.
            // A TSX app's release library has only the features `nsh package`
            // chose ([`set_runner_features`]).
            let trimmed = if !dev && !rust {
                runner_feature_args("nsh-platform-android")
            } else {
                Vec::new()
            };
            let trimmed: Vec<&str> = trimmed.iter().map(String::as_str).collect();
            let features: &[&str] = if dev && !rust {
                &["--features", "dev"]
            } else {
                &trimmed
            };
            let package = self.bin(if rust { "rust-android" } else { "android" });
            let artifact = format!("lib{}.so", self.android_lib(rust));
            let build = Build {
                workspace: &self.workspace,
                package: &package,
                triple: Some(triple),
                release: !dev,
                profile: None,
                extra: features,
                artifact: &artifact,
                what: &match self.packages() {
                    // A TSX app's own library (`runner_only`) has no crates.
                    p if p.is_empty() => format!("libnsh.so for {abi}"),
                    p => format!("libnsh.so of {p} for {abi}"),
                },
            };
            let lib = self.build_with(sdk.ndk_cargo(triple)?, &build)?;
            let dir = out.join("lib").join(&abi);
            fs::create_dir_all(&dir)?;
            let dest = dir.join("libnsh.so");
            // `symbols/<abi>` keeps the library whole, for `ndk-stack`,
            // debuggers and Play Console.
            let symbols = out.join("symbols").join(&abi).join("libnsh.so");
            if dev {
                // Without its debug info: most of a debug build, it made an
                // app's development APK too large to update on an emulator.
                // The symbol table stays, for the names in crash reports.
                install_stripped(&lib, &dest, &symbols, |from, to| sdk.strip_debug(from, to))?;
            } else {
                // Without its symbol tables and debug info, which APKs
                // store uncompressed.
                install_stripped(&lib, &dest, &symbols, |from, to| sdk.strip(from, to))?;
            }
        }
        Ok(out)
    }
}

/// A `cargo build` of a package of the workspace ([`RustApp::build_with`]).
#[derive(Clone, Copy)]
struct Build<'a> {
    /// The workspace it is a package of.
    workspace: &'a Path,
    package: &'a str,
    /// The target (`None`: the host).
    triple: Option<&'a str>,
    release: bool,
    /// A profile of its own (`web`), instead of `release`'s.
    profile: Option<&'a str>,
    /// More arguments (features).
    extra: &'a [&'a str],
    /// The file it makes, in the target directory.
    artifact: &'a str,
    /// What the step says it builds.
    what: &'a str,
}

/// Link arguments belong to the final cdylib, so apps' Android runtimes
/// need the same 16 KB alignment as `nsh-platform-android`'s `build.rs`.
const ANDROID_BUILD_RS: &str = r#"//! Android's shared runtime supports both 4 KB and 16 KB page sizes.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,common-page-size=16384");
    }
}
"#;

/// The `build.rs` of the web runtimes: the 8 MiB stack nsh's own has.
const WEB_BUILD_RS: &str = "//! The web runtime's stack: 8 MiB, as nsh's own (`.cargo/config.toml`).\n\n\
    fn main() {\n    if std::env::var(\"CARGO_CFG_TARGET_ARCH\").as_deref() == Ok(\"wasm32\") {\n        \
    println!(\"cargo:rustc-link-arg=-zstack-size=8388608\");\n    }\n}\n";

impl RustApp {
    /// The `[dependencies]` lines of its crates, for a generated crate.
    fn dependencies(&self) -> String {
        let lines: Vec<String> = self
            .crates
            .iter()
            .map(|c| {
                if self.retargeted {
                    c.dependency_at(&self.workspace.join("app-crates").join(&c.package))
                } else {
                    c.dependency()
                }
            })
            .collect();
        lines.join("\n")
    }

    /// The UI sets of the generated code: `nsh/base`, then the app's, one per
    /// crate ([`Self::app_sets`]).
    fn sets(&self) -> String {
        let mut sets = vec!["nsh_base::registry()".to_owned()];
        sets.extend(self.crates.iter().map(|c| format!("{}()", set_fn(c))));
        format!("vec![{}]", sets.join(", "))
    }

    /// The UI sets of a Rust app's runners and web runtime: `nsh/base`'s core part
    /// only, then the app's ([`Self::sets`]). A Rust app runs no JS, so
    /// nothing makes a component by its registered name: its code makes
    /// each of `nsh/base`'s components by type (`nsh_base::button()`),
    /// which links that component's code where it is used. What the app
    /// needs of the set itself is the theme's tokens, which every set of
    /// `nsh/base` has, and the built-in scroll bars, the core part's.
    /// Registering every part would link every component into the module,
    /// the ones the app never makes included (`nsh_base::registry_of`).
    fn rust_sets(&self) -> String {
        let mut sets = vec![
            "nsh_base::registry_of([nsh_base::parts::core as nsh_base::parts::Part])".to_owned(),
        ];
        sets.extend(self.crates.iter().map(|c| format!("{}()", set_fn(c))));
        format!("vec![{}]", sets.join(", "))
    }

    /// The app's own UI sets for the generated code, without `nsh/base`'s
    /// ([`Self::sets`]).
    fn app_only_sets(&self) -> String {
        let sets: Vec<String> = self
            .crates
            .iter()
            .map(|c| format!("{}()", set_fn(c)))
            .collect();
        format!("vec![{}]", sets.join(", "))
    }

    /// The web runtime's gates of the app's sets: one
    /// `nsh_platform_web::ui_set!` per crate, exporting
    /// [`crate::web::ui_set_gate`] of its specifier, which registers the
    /// crate's set ([`Self::app_sets`]). `nsh/base` is the runtime's own
    /// (its parts' `nsh_part_*`).
    fn set_gates(&self, cfg: &str) -> String {
        self.crates
            .iter()
            .map(|krate| {
                let specifier = specifier_of(&krate.dir).unwrap_or_else(|| krate.name());
                format!(
                    "{cfg}nsh_platform_web::ui_set!({}, {}());\n",
                    crate::web::ui_set_gate(&specifier),
                    set_fn(krate)
                )
            })
            .collect()
    }

    /// A function per crate (`set_app_charts()`), for the generated code
    /// (each item under `cfg`): the crate's UI set, the [`ENTRY`]
    /// `#[native_module]` makes in it. Each glob-imports its crate in a
    /// block, which shadows the module's import of nsh's stand-in, so a
    /// crate without the entry fails to build with a message saying what to
    /// add rather than "cannot find function", on the line of that crate.
    fn app_sets(&self, cfg: &str) -> String {
        let mut code = String::new();
        for krate in &self.crates {
            code.push_str(&format!(
                "\n/// The UI set of the crate {}: the entry `#[native_module(\"…\")]` makes in it.\n\
                 {cfg}fn {}() -> nsh_core::element::Registry {{\n    \
                 #[allow(unused_imports)]\n    use {}::*;\n    \
                 {ENTRY}() // the crate {} ({})\n}}\n",
                krate.package,
                set_fn(krate),
                krate.name(),
                krate.package,
                krate.origin(),
            ));
        }
        code.push_str(&format!(
            "\n// Without the entry: nsh's stand-in, which fails the build saying what to add.\n\
             {cfg}#[allow(unused_imports)]\nuse nsh_core::element::__private::no_native_module as {ENTRY};\n"
        ));
        code
    }

    /// `app_components()`, for the generated code of the platform `key`
    /// (`windows`; its crate `platform`, `nsh_platform_windows`), under
    /// `cfg`: the native components each crate registers there, with the
    /// entry `#[native_components(<key>)]` makes in it ([`COMPONENTS_ENTRY`]).
    /// Each crate's call glob-imports it in a block, as [`Self::app_sets`]
    /// does, over nsh's stand-in, which registers nothing: most crates have
    /// no native components. The parameter's name is nsh's (`__nsh_`), as
    /// the entry's: the glob would shadow it with any value of the same name
    /// the crate exports (`pub fn components`).
    fn app_components(&self, cfg: &str, platform: &str, key: &str) -> String {
        let entry = format!("{COMPONENTS_ENTRY}{key}");
        let mut calls = String::new();
        for krate in &self.crates {
            calls.push_str(&format!(
                "    {{\n        #[allow(unused_imports)]\n        use {}::*;\n        \
                 {entry}(__nsh_components); // the crate {} ({})\n    }}\n",
                krate.name(),
                krate.package,
                krate.origin(),
            ));
        }
        format!(
            "\n/// The app's native components on this platform: what `#[native_components({key})]` registers in its crates.\n\
             {cfg}fn app_components(__nsh_components: &{platform}::Components) {{\n{calls}}}\n\
             \n// Without the entry: nsh's stand-in, which registers nothing.\n\
             {cfg}#[allow(unused_imports)]\nuse nsh_core::element::__private::no_native_components as {entry};\n"
        )
    }

    /// `app_root()`, a Rust app's root (`nsh.json` `"root"`, `"theme"`,
    /// `"appearance"`, `"statusBar"`: a component of the first crate `"rust"` lists), for
    /// the generated code, under `cfg`.
    fn root_fn(&self, cfg: &str, root: &RootConfig) -> String {
        let krate = self.crates.first().map(AppCrate::name).unwrap_or_default();
        root_fn(cfg, &krate, root)
    }
}

/// The platform (`#[native_components(<platform>)]`) whose native
/// components the generated crate `dir` registers: the desktops' standalone
/// backends and iOS (`windows-host`, `windows-app`, `rust-windows`,
/// `ios-host`, ...).
fn components_platform(dir: &str) -> Option<&'static str> {
    let platform = dir.strip_prefix("rust-").unwrap_or(dir);
    ["windows", "macos", "linux", "ios"]
        .into_iter()
        .find(|key| {
            platform
                .strip_prefix(key)
                .is_some_and(|rest| rest.is_empty() || rest == "-host" || rest == "-app")
        })
}

/// The function of the generated code that makes the UI set of `krate`
/// ([`RustApp::app_sets`]).
fn set_fn(krate: &AppCrate) -> String {
    format!("set_{}", krate.name())
}

/// `app_root()`, a Rust app's root (`nsh.json` `"root"`, `"theme"`,
/// `"appearance"`, `"statusBar"`, `"id"`, `"schemes"`, `"window"`,
/// `"capabilities"`) in the crate the generated code links as `krate`, under
/// `cfg`.
fn root_fn(cfg: &str, krate: &str, root: &RootConfig) -> String {
    let mut make = format!(
        "nsh_core::element::Root::of::<{krate}::{}>()",
        root.component
    );
    if let Some(theme) = &root.theme {
        make.push_str(&format!(
            "\n        .tokens(\n            nsh_base::Theme::from_json(include_str!({:?}))\n                \
             .expect(\"nsh.json: theme\")\n                .into_tokens(),\n        )",
            theme.to_string_lossy()
        ));
    }
    if let Some(id) = &root.app_id {
        make.push_str(&format!("\n        .app_id({id:?})"));
    }
    make.push_str(&format!("\n        .app_info_json({:?})", root.app_info));
    if let Some(translations) = &root.translations {
        make.push_str(&format!(
            "\n        .translations_json(include_str!({:?}))",
            translations.to_string_lossy()
        ));
    }
    // The web links first: `links_json` sets the app's links whole, and
    // `url_schemes` then its schemes (with the core's own `file:`).
    if let Some(links) = &root.links {
        make.push_str(&format!("\n        .links_json({links:?})"));
    }
    if !root.url_schemes.is_empty() {
        make.push_str(&format!("\n        .url_schemes({:?})", root.url_schemes));
    }
    if let Some(capabilities) = &root.capabilities {
        make.push_str(&format!("\n        .capabilities_json({capabilities:?})"));
    }
    if let Some(appearance) = &root.appearance {
        let variant = if appearance == "dark" {
            "Dark"
        } else {
            "Light"
        };
        make.push_str(&format!(
            "\n        .appearance(nsh_core::element::Appearance::{variant})"
        ));
    }
    if let Some(setting) = root
        .status_bar
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok())
        .map(|v| nsh_core::StatusBarSetting::from_json(&v))
    {
        let mut make_setting = "nsh_core::StatusBarSetting::default()".to_owned();
        if let Some(style) = setting.style {
            let variant = match style {
                nsh_core::StatusBarStyle::Default => "Default",
                nsh_core::StatusBarStyle::Light => "Light",
                nsh_core::StatusBarStyle::Dark => "Dark",
            };
            make_setting.push_str(&format!(".foreground(nsh_core::StatusBarStyle::{variant})"));
        }
        if let Some(hidden) = setting.hidden {
            make_setting.push_str(&format!(".hidden({hidden})"));
        }
        make.push_str(&format!("\n        .status_bar({make_setting})"));
    }
    if let Some(window) = &root.window {
        make.push_str(&format!("\n        .main_window_json({window:?})"));
    }
    if let Some(application) = &root.application {
        make.push_str(&format!("\n        .application_json({application:?})"));
    }
    format!(
        "\n/// The app's root (`nsh.json` `\"root\"`), with its theme, appearance and\n\
         /// status bar.\n\
         {cfg}fn app_root() -> nsh_core::element::Root {{\n    {make}\n}}\n"
    )
}

/// What tells one build of `program` from another: its size and time.
fn stamp(program: &Path) -> anyhow::Result<String> {
    let metadata = fs::metadata(program).with_context(|| format!("no {}", program.display()))?;
    let modified = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    Ok(format!("{}:{}", metadata.len(), modified.as_nanos()))
}

/// The sets of `crates` (`what` the steps call them) in `text`, the output
/// of their describe program: a description of this nsh's format and
/// version, one set per crate, each imported by a specifier of its own.
fn read_description(
    text: &str,
    crates: &[AppCrate],
    what: &str,
) -> anyhow::Result<Vec<SetDescription>> {
    let description = Description::from_json(text)
        .map_err(|e| anyhow::anyhow!("the description of {what}: {e}"))?;
    if description.nsh != VERSION {
        bail!(
            "{what} were described by nsh {} and this nsh is {VERSION}",
            description.nsh
        );
    }
    if description.sets.len() != crates.len() {
        bail!(
            "the description of {what} has {} UI sets for {} crates",
            description.sets.len(),
            crates.len()
        );
    }
    check_specifiers(crates, &description.sets)?;
    Ok(description.sets)
}

/// Checks the specifiers of `sets` (those of `crates`, in their order):
/// each is imported by its specifier, so none may be one of nsh's modules
/// or another crate's.
fn check_specifiers(crates: &[AppCrate], sets: &[SetDescription]) -> anyhow::Result<()> {
    let nsh: Vec<&str> = nsh_core::js::NATIVE_MODULES
        .iter()
        .copied()
        .chain(
            nsh_core::runtime::registries()
                .iter()
                .filter_map(|r| r.specifier()),
        )
        .chain(crate::own_sets().iter().filter_map(|r| r.specifier()))
        .collect();
    for (i, (krate, set)) in crates.iter().zip(sets).enumerate() {
        let specifier = set.specifier.as_str();
        if nsh.contains(&specifier) {
            bail!(
                "the crate {} is imported as {specifier:?}, one of nsh's own modules: give its `#[native_module(\"…\")]` a specifier of its own",
                krate.package
            );
        }
        if let Some((other, _)) = crates
            .iter()
            .zip(sets)
            .take(i)
            .find(|(_, s)| s.specifier == specifier)
        {
            bail!(
                "the crates {} and {} are both imported as {specifier:?}: give each crate of the app a `#[native_module(\"…\")]` specifier of its own",
                other.package,
                krate.package
            );
        }
    }
    Ok(())
}

/// Copies `from` to `to` when it is newer.
fn install(from: &Path, to: &Path) -> anyhow::Result<()> {
    if up_to_date(to, from) {
        return Ok(());
    }
    fs::copy(from, to).with_context(|| format!("copy {} to {}", from.display(), to.display()))?;
    Ok(())
}

/// Whether `file` exists and is no older than `source`.
fn up_to_date(file: &Path, source: &Path) -> bool {
    let modified = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
    modified(file).is_some() && modified(file) >= modified(source)
}

/// Installs both release artifacts. Older CLIs copied an unstripped library
/// to `to`; its timestamp alone cannot establish that stripping has run.
fn install_stripped(
    from: &Path,
    to: &Path,
    symbols: &Path,
    strip: impl FnOnce(&Path, &Path) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    if up_to_date(to, from) && up_to_date(symbols, from) {
        return Ok(());
    }
    fs::create_dir_all(symbols.parent().context("symbols directory")?)?;
    strip(from, to)?;
    fs::copy(from, symbols)?;
    Ok(())
}

/// The target directory Cargo reports for the workspace at `workspace`.
pub(crate) fn cargo_target_directory(workspace: &Path) -> Option<PathBuf> {
    let out = Command::new(cargo())
        .args([
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--manifest-path",
        ])
        .arg(workspace.join("Cargo.toml"))
        .current_dir(workspace)
        .output()
        .ok()
        .filter(|out| out.status.success())?;
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    json.get("target_directory")?.as_str().map(PathBuf::from)
}

/// The `cargo` to run: Cargo's own when it runs `nsh`, else the one on
/// `PATH`.
pub(crate) fn cargo() -> std::ffi::OsString {
    env::var_os("CARGO").unwrap_or_else(|| "cargo".into())
}

/// Has `cmd`, a build for `triple` (`None`: this machine), compile for the
/// oldest Apple system the app's packages declare
/// ([`AppleMinimums::deployment_target`]), unless `set` says the user set
/// the variable, whose value is kept.
fn set_deployment_target(
    cmd: &mut Command,
    triple: Option<&str>,
    minimums: &AppleMinimums,
    set: impl Fn(&str) -> bool,
) {
    if let Some((name, version)) = minimums.deployment_target(triple)
        && !set(name)
    {
        cmd.env(name, version);
    }
}

/// A build of the generated workspace that is done once: one that links
/// only code that cannot change (the generated workspace and the nshm
/// installed in `~/.nsh/nshms`, each version there written once), so its
/// binary stays right until what produced it changes or the binary goes.
/// Cargo is then not run at all: even a build with nothing to do takes it
/// a moment, and a Cargo that copies its binaries anew each time makes
/// macOS check a new executable's signature on every launch.
///
/// The record (`<workspace>/.built/<package>…`) keeps a fingerprint of
/// this CLI, the workspace's manifests and lock file, the package's
/// generated files, the command line and the environment Cargo reads, and
/// the binary's size and time. An app's own crates and nshm from a
/// directory can change at any time: their builds are always Cargo's.
struct BuiltOnce {
    record: PathBuf,
    fingerprint: String,
}

impl BuiltOnce {
    /// The build of `package` in `workspace` that `cmd` runs, when it
    /// links nothing that can change.
    fn of(workspace: &Path, package: &str, cmd: &Command) -> Option<Self> {
        use sha2::Digest as _;
        let installed =
            nsh_bundler::nshm::installed_dir().and_then(|d| dunce::canonicalize(d).ok());
        let workspace = dunce::canonicalize(workspace).ok()?;
        let mut hash = sha2::Sha256::new();
        hash.update(concat!(env!("CARGO_PKG_VERSION"), "\n").as_bytes());
        // This nsh: another build of it may generate other code.
        let exe = env::current_exe().ok()?;
        hash.update(binary_stamp(&exe)?.as_bytes());
        for name in ["Cargo.toml", "Cargo.lock"] {
            hash.update(fs::read(workspace.join(name)).ok()?);
        }
        let mut member = None;
        for entry in fs::read_dir(&workspace).ok()?.flatten() {
            let manifest = entry.path().join("Cargo.toml");
            let Ok(text) = fs::read_to_string(&manifest) else {
                continue;
            };
            // Every path a manifest names is generated or installed.
            if !toml_paths(&text)
                .iter()
                .all(|p| fixed_path(&entry.path(), p, &workspace, installed.as_deref()))
            {
                return None;
            }
            let name = text.lines().find_map(|l| toml_string(l.trim(), "name"));
            if name.as_deref() == Some(package) {
                member = Some(entry.path());
            }
        }
        if !toml_paths(&fs::read_to_string(workspace.join("Cargo.toml")).ok()?)
            .iter()
            .all(|p| fixed_path(&workspace, p, &workspace, installed.as_deref()))
        {
            return None;
        }
        hash_dir(&mut hash, &member?).ok()?;
        hash.update(cmd.get_program().as_encoded_bytes());
        for arg in cmd.get_args() {
            hash.update(b"\0");
            hash.update(arg.as_encoded_bytes());
        }
        let mut envs: Vec<_> = cmd.get_envs().collect();
        envs.sort();
        for (key, value) in envs {
            hash.update(b"\0");
            hash.update(key.as_encoded_bytes());
            hash.update(b"=");
            hash.update(value.map(|v| v.as_encoded_bytes()).unwrap_or_default());
        }
        for (key, value) in env::vars_os() {
            let key_text = key.to_string_lossy();
            let read = key_text.starts_with("CARGO_")
                || key_text.starts_with("RUST")
                || key_text.ends_with("_DEPLOYMENT_TARGET")
                || matches!(&*key_text, "CC" | "CXX" | "CFLAGS" | "CXXFLAGS" | "SDKROOT");
            if read && !cmd.get_envs().any(|(k, _)| k == key) {
                hash.update(b"\0");
                hash.update(key.as_encoded_bytes());
                hash.update(b"=");
                hash.update(value.as_encoded_bytes());
            }
        }
        let fingerprint = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        let name: String = cmd
            .get_args()
            .filter_map(|a| a.to_str())
            .filter(|a| !a.contains('/') && !a.contains('\\'))
            .collect::<Vec<_>>()
            .join("-")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            .collect();
        Some(BuiltOnce {
            record: workspace.join(".built").join(format!("{name}.json")),
            fingerprint,
        })
    }

    /// The binary this build made, when it still holds.
    fn built(&self) -> Option<PathBuf> {
        let record: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&self.record).ok()?).ok()?;
        if record["fingerprint"].as_str()? != self.fingerprint {
            return None;
        }
        let path = PathBuf::from(record["binary"].as_str()?);
        (binary_stamp(&path)? == record["stamp"].as_str()?).then_some(path)
    }

    /// Records that this build made `binary`.
    fn record(&self, binary: &Path) {
        let Some(stamp) = binary_stamp(binary) else {
            return;
        };
        let record = serde_json::json!({
            "fingerprint": self.fingerprint,
            "binary": binary.to_string_lossy(),
            "stamp": stamp,
        });
        // A record not written only means Cargo runs next time.
        if let Some(dir) = self.record.parent()
            && fs::create_dir_all(dir).is_ok()
        {
            let _ = fs::write(&self.record, record.to_string());
        }
    }
}

/// A binary's size and modification time: another binary, or none, is
/// another stamp.
fn binary_stamp(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    let time = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(format!("{}:{time}", meta.len()))
}

/// Whether `path`, as the manifest in `dir` names it, is in `workspace` or
/// in the nshm installation `installed`: code that does not change. Read
/// as written: a generated file may not be there yet.
fn fixed_path(dir: &Path, path: &str, workspace: &Path, installed: Option<&Path>) -> bool {
    let mut full = PathBuf::new();
    for part in dir.join(path).components() {
        match part {
            std::path::Component::ParentDir => {
                full.pop();
            }
            std::path::Component::CurDir => {}
            other => full.push(other),
        }
    }
    full.starts_with(workspace) || installed.is_some_and(|d| full.starts_with(d))
}

/// The `path = "…"` values of a manifest.
fn toml_paths(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find("path") {
        let key_start = text.len() - rest.len() + i;
        rest = &rest[i + 4..];
        let whole_key = text[..key_start]
            .chars()
            .next_back()
            .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'));
        if whole_key
            && let Some(value) = rest.trim_start().strip_prefix('=')
            && let Some(value) = value.trim_start().strip_prefix('"')
            && let Some(end) = value.find('"')
        {
            out.push(value[..end].to_owned());
        }
    }
    out
}

/// Feeds the files of a generated directory to `hash`, in order.
fn hash_dir(hash: &mut sha2::Sha256, dir: &Path) -> std::io::Result<()> {
    use sha2::Digest as _;
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)?
        .map(|e| e.map(|e| e.path()))
        .collect::<Result<_, _>>()?;
    entries.sort();
    for path in entries {
        if path.file_name().is_some_and(|n| n == "target") {
            continue;
        }
        hash.update(path.file_name().unwrap_or_default().as_encoded_bytes());
        if path.is_dir() {
            hash_dir(hash, &path)?;
        } else {
            hash.update(fs::read(&path)?);
        }
    }
    Ok(())
}

/// The target directory of the generated `workspace` ([`RustApp::target_dir`]):
/// `cargo_target_dir` (a relative one against the current directory, as Cargo
/// takes it), else the app's `target`.
fn target_dir(
    workspace: &Path,
    cargo_target_dir: Option<std::ffi::OsString>,
) -> anyhow::Result<PathBuf> {
    if let Some(dir) = cargo_target_dir.filter(|d| !d.is_empty()) {
        let dir = PathBuf::from(dir);
        return Ok(if dir.is_absolute() {
            dir
        } else {
            env::current_dir()?.join(dir)
        });
    }
    let app = workspace
        .parent()
        .and_then(Path::parent)
        .context("the generated workspace is not in an app's .nsh")?;
    Ok(app.join("target"))
}

/// The directory of nsh's crate `name` in the checkout at `source`: the GPUI
/// backend's crates are a workspace of their own, in `crates/gpui`.
fn nsh_crate(source: &Path, name: &str) -> PathBuf {
    match name {
        "nsh-platform-gpui" | "nsh-gpui-host" => source.join("crates/gpui").join(name),
        _ => source.join("crates").join(name),
    }
}

/// The profile the app's web runtime of `kind` builds with: `web` for
/// published apps, `web-dev` for development ([`RustApp::web_dev_profile`]).
fn web_profile(kind: crate::runtime::WebKind) -> &'static str {
    match kind {
        crate::runtime::WebKind::Browser => "web",
        crate::runtime::WebKind::Dev => "web-dev",
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{AppCrate, Link, Nsh, RootConfig, RustApp};

    /// Serialises the tests that set [`super::RUNNER_FEATURES`].
    static RUNNER_FEATURES_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn a_release_runner_builds_with_the_chosen_features() {
        let _guard = RUNNER_FEATURES_TEST
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        assert!(super::runner_feature_args("nsh-platform-windows").is_empty());
        super::set_runner_features(vec!["js".into(), "net".into(), "svg".into(), "plot".into()]);
        let args = super::runner_feature_args("nsh-platform-windows");
        assert_eq!(
            args,
            [
                "--no-default-features",
                "--features",
                "js,plot,svg,net,media"
            ]
        );
        // macOS has no `net`; Linux keeps `sound` and Windows `media`, which no
        // import tells.
        assert_eq!(
            super::runner_feature_args("nsh-platform-macos")[2],
            "js,plot,svg"
        );
        assert_eq!(
            super::runner_feature_args("nsh-platform-linux")[2],
            "js,plot,svg,net,sound"
        );
        // `webview` only when chosen (#2377).
        super::set_runner_features(vec!["js".into(), "webview".into()]);
        assert_eq!(
            super::runner_feature_args("nsh-platform-linux")[2],
            "js,webview,sound"
        );
        super::set_runner_features(vec!["js".into(), "net".into(), "svg".into(), "plot".into()]);
        // Android: a TSX app's own library, trimmed the same way.
        assert_eq!(
            super::runner_feature_args("nsh-platform-android")[2],
            "js,plot,svg"
        );
        *super::RUNNER_FEATURES.lock().unwrap() = None;
    }

    #[test]
    fn a_rust_runner_turns_web_views_on_like_its_package() {
        use crate::runtime::Platform;
        let _guard = RUNNER_FEATURES_TEST
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *super::RUNNER_FEATURES.lock().unwrap() = None;
        // `nsh run`: when the app's code may make a web view (#2706).
        assert_eq!(
            super::rust_runner_web_view(Platform::Linux, || true),
            ["--features", "nsh-platform-linux/webview"]
        );
        assert_eq!(
            super::rust_runner_web_view(Platform::Windows, || true),
            ["--features", "nsh-platform-windows/webview"]
        );
        assert!(super::rust_runner_web_view(Platform::Linux, || false).is_empty());
        // Web views are no feature on macOS.
        assert!(super::rust_runner_web_view(Platform::MacOs, || true).is_empty());
        // A package: what it chose, whatever the scan says.
        super::set_runner_features(vec!["webview".into()]);
        assert_eq!(
            super::rust_runner_web_view(Platform::Linux, || false).len(),
            2
        );
        super::set_runner_features(vec!["js".into()]);
        assert!(super::rust_runner_web_view(Platform::Linux, || true).is_empty());
        *super::RUNNER_FEATURES.lock().unwrap() = None;
    }

    #[test]
    fn rust_app_platforms_name_only_features_they_have() {
        let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for platform in [
            "nsh-platform-linux",
            "nsh-platform-macos",
            "nsh-platform-windows",
            "nsh-platform-ios",
            "nsh-platform-android",
        ] {
            let manifest = super::nsh_crate(&checkout, platform).join("Cargo.toml");
            let manifest = std::fs::read_to_string(&manifest).unwrap();
            let features: Vec<&str> = super::toml_tables(&manifest)
                .filter(|(table, line)| *table == "features" && !line.starts_with('#'))
                .filter_map(|(_, line)| Some(line.split_once('=')?.0.trim()))
                .collect();
            let named = super::rust_app_platform(platform);
            let (_, list) = named.split_once("features = [").unwrap();
            for feature in list.trim_end_matches(']').split(',') {
                let feature = feature.trim().trim_matches('"');
                assert!(
                    features.contains(&feature),
                    "{platform} has no feature `{feature}`: {named}"
                );
            }
        }
        // HTTP on ureq where `fetch` is not the system's.
        for (platform, net) in [
            ("nsh-platform-linux", true),
            ("nsh-platform-windows", true),
            ("nsh-platform-macos", false),
            ("nsh-platform-ios", false),
            ("nsh-platform-android", false),
        ] {
            let named = super::rust_app_platform(platform);
            assert_eq!(named.contains("\"net\""), net, "{platform}: {named}");
        }
    }

    #[test]
    fn release_libraries_upgrade_old_caches_and_restore_symbols() {
        use std::{
            fs,
            time::{Duration, SystemTime},
        };

        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.nsh")
            .join(format!("strip-cache-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("linked.so");
        let dest = dir.join("libnsh.so");
        let symbols = dir.join("symbols/libnsh.so");
        fs::write(&source, b"complete library").unwrap();
        let old = SystemTime::now() - Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_modified(old)
            .unwrap();
        // The old CLI copied the complete library after Cargo linked it.
        fs::copy(&source, &dest).unwrap();
        assert!(super::up_to_date(&dest, &source));
        let strip = |_: &Path, to: &Path| -> anyhow::Result<()> {
            fs::write(to, b"stripped library")?;
            Ok(())
        };
        super::install_stripped(&source, &dest, &symbols, strip).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"stripped library");
        assert_eq!(fs::read(&symbols).unwrap(), b"complete library");
        // A complete cache avoids running the NDK again.
        super::install_stripped(&source, &dest, &symbols, |_, _| panic!("cache miss")).unwrap();
        // Losing the symbol backup repairs both artifacts, even with a fresh APK library.
        fs::remove_file(&symbols).unwrap();
        super::install_stripped(&source, &dest, &symbols, strip).unwrap();
        assert_eq!(fs::read(&symbols).unwrap(), b"complete library");
        // A stale backup must also be refreshed.
        fs::File::options()
            .write(true)
            .open(&symbols)
            .unwrap()
            .set_modified(old - Duration::from_secs(60))
            .unwrap();
        super::install_stripped(&source, &dest, &symbols, strip).unwrap();
        assert!(super::up_to_date(&symbols, &source));
        fs::remove_dir_all(dir).unwrap();
    }

    /// An app in `dir` with `crates` (package, directory), built against
    /// this checkout.
    fn app(dir: &Path, crates: &[(&str, PathBuf)], root: Option<RootConfig>) -> RustApp {
        let crates: Vec<AppCrate> = crates
            .iter()
            .map(|(package, dir)| AppCrate::new((*package).into(), dir.clone()))
            .collect();
        RustApp {
            workspace: dir.join(".nsh/rust"),
            nsh: Nsh::Source(Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")),
            watched: crates.iter().map(|c| c.dir.clone()).collect(),
            crates,
            root,
            retargeted: false,
            unify: true,
            modules: Vec::new(),
            minimums: crate::apple::AppleMinimums::default(),
            shared: false,
        }
    }

    /// Builds for an Apple system get the deployment target of the app's
    /// packages (the raised one when the app raises it); one the user set
    /// is theirs.
    #[test]
    fn apple_builds_set_the_deployment_target_the_user_has_not() {
        use std::process::Command;

        use crate::apple::AppleMinimums;
        let env = |cmd: &Command, name: &str| {
            cmd.get_envs()
                .find(|(key, _)| *key == name)
                .and_then(|(_, value)| value)
                .map(|value| value.to_string_lossy().into_owned())
        };
        let ios = "IPHONEOS_DEPLOYMENT_TARGET";
        let default = AppleMinimums::default();
        let mut cmd = Command::new("cargo");
        super::set_deployment_target(&mut cmd, Some("aarch64-apple-ios"), &default, |_| false);
        assert_eq!(env(&cmd, ios).as_deref(), Some(crate::apple::IOS_MINIMUM));

        let raised = AppleMinimums::of(&serde_json::json!({
            "ios": { "infoPlist": { "MinimumOSVersion": "16.4" } }
        }))
        .unwrap();
        let mut cmd = Command::new("cargo");
        super::set_deployment_target(&mut cmd, Some("aarch64-apple-ios-sim"), &raised, |_| false);
        assert_eq!(env(&cmd, ios).as_deref(), Some("16.4"));

        let mut cmd = Command::new("cargo");
        super::set_deployment_target(&mut cmd, Some("aarch64-apple-ios"), &raised, |name| {
            name == ios
        });
        assert!(cmd.get_envs().next().is_none());

        let mut cmd = Command::new("cargo");
        super::set_deployment_target(&mut cmd, Some("wasm32-unknown-unknown"), &raised, |_| false);
        assert!(cmd.get_envs().next().is_none());
    }

    #[test]
    fn describing_alone_builds_with_an_empty_hack() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-web-hack-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let native = dir.join("native");
        write_crate(&native, "app-native", "", "");
        let mut app = app(&dir, &[("app-native", native)], None);
        app.unify = false;
        // A former session on this machine filled the hack.
        let hack = dir.join(".nsh/rust/hack/Cargo.toml");
        std::fs::create_dir_all(hack.parent().unwrap()).unwrap();
        std::fs::write(
            &hack,
            "# Generated by nsh\n# key: abc\n[target.'x86_64-unknown-linux-gnu'.dependencies]\nwebkit6 = \"0.6\"\n",
        )
        .unwrap();
        app.write_workspace().unwrap();
        let written = std::fs::read_to_string(&hack).unwrap();
        assert_eq!(written.lines().nth(1), Some("# key: "), "{written}");
        assert!(!written.contains("dependencies"), "{written}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Writes the crate `package` in `dir` with `lib` as its `src/lib.rs`
    /// and `deps` in its `[dependencies]`.
    fn write_crate(dir: &Path, package: &str, lib: &str, deps: &str) {
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(
            dir.join("Cargo.toml"),
            format!(
                "[package]\nname = \"{package}\"\nversion = \"0.1.0\"\n\n[dependencies]\n{deps}"
            ),
        )
        .unwrap();
        std::fs::write(dir.join("src/lib.rs"), lib).unwrap();
    }

    #[test]
    fn the_crates_assets_are_its_code() {
        let mut app = app(
            Path::new("/app"),
            &[("app-native", "/app/native".into())],
            None,
        );
        app.watched.push("/shared/ui".into());
        for (path, rust) in [
            ("/app/native/src/lib.rs", true),
            ("/app/native/Cargo.toml", true),
            // `asset!` reads them when the crate builds.
            ("/app/native/assets/logo@2x.png", true),
            ("/app/native/assets/fonts/Script.ttf", true),
            ("/app/native/target/debug/build.rs", false),
            ("/app/native/.nsh/rust/test/main.rs", false),
            ("/app/native/.git/hooks/build.rs", false),
            ("/app/native/README.md", false),
            ("/app/App.tsx", false),
            // A local crate the app's crates depend on.
            ("/shared/ui/src/card.rs", true),
            ("/shared/other.rs", false),
        ] {
            assert_eq!(app.is_rust(Path::new(path)), rust, "{path}");
        }
    }

    #[test]
    fn what_builds_write_in_a_crate_is_not_its_code() {
        let app = app(
            Path::new("/app"),
            &[("app-native", "/app/native".into())],
            None,
        );
        let target = Some(Path::new("/app/native/build-cache"));
        for (path, rust) in [
            ("/app/native/src/lib.rs", true),
            ("/app/native/build-cache/debug/build/out.rs", false),
            ("/app/native/build-cache/Cargo.toml", false),
        ] {
            assert_eq!(app.is_rust_in(Path::new(path), target), rust, "{path}");
        }
    }

    #[test]
    fn android_libraries_are_named_after_the_app() {
        let lib = |package: &str, file: &str| {
            let dir = std::env::temp_dir()
                .join(format!("nsh-rust-android-{package}-{}", std::process::id()));
            let root = RootConfig {
                component: "App".into(),
                theme: None,
                appearance: None,
                app_id: None,
                status_bar: None,
                url_schemes: Vec::new(),
                links: None,
                window: None,
                application: None,
                capabilities: None,
                translations: None,
                app_info: "{}".into(),
            };
            let app = app(&dir, &[(package, dir.join("native"))], Some(root));
            app.write_workspace().unwrap();
            let manifest = std::fs::read_to_string(app.workspace.join(file)).unwrap();
            let _ = std::fs::remove_dir_all(&dir);
            let at = manifest.find("[lib]\nname = ").expect("a [lib]");
            manifest[at..].lines().nth(1).unwrap().to_owned()
        };
        for file in ["android/Cargo.toml", "rust-android/Cargo.toml"] {
            // Apps sharing CARGO_TARGET_DIR build libraries of their own.
            let (charts, notes) = (lib("charts", file), lib("notes", file));
            assert_ne!(charts, notes, "{file}");
            assert!(charts.contains("charts"), "{file}: {charts}");
        }
    }

    #[test]
    fn rust_is_a_crate_or_a_list_of_them() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-crates-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_crate(
            &dir.join("native/charts"),
            "charts",
            "#[native_module(\"app/charts\")]\nfn native(r: &mut Registry) {}\n",
            "",
        );
        write_crate(
            &dir.join("native/storage"),
            "storage",
            "use nsh_core::prelude::*;\n\n#[nsh_core::element::native_module( \"app/storage\" )]\nfn native(r: &mut Registry) {}\n",
            "",
        );
        let json = |text: &str| serde_json::from_str::<serde_json::Value>(text).unwrap();
        let packages = |rust: &str| -> Vec<String> {
            super::crates(&dir, &json(rust))
                .unwrap()
                .into_iter()
                .map(|c| c.package)
                .collect()
        };
        assert_eq!(packages(r#""native/charts""#), ["charts"]);
        assert_eq!(
            packages(r#"["native/charts", "native/storage"]"#),
            ["charts", "storage"]
        );
        let crates = super::crates(&dir, &json(r#"["native/storage"]"#)).unwrap();
        assert_eq!(
            crates[0].dir,
            dunce::canonicalize(dir.join("native/storage")).unwrap()
        );
        assert_eq!(crates[0].name(), "app_storage");
        let error = |rust: &str| super::crates(&dir, &json(rust)).unwrap_err().to_string();
        for bad in ["[]", "1", "[\"native/charts\", 2]", "{}"] {
            assert!(error(bad).contains("a list of them"), "{bad}");
        }
        assert!(error(r#"["native/nothing"]"#).contains("no crate at native/nothing"));
        // The same crate twice, by two paths.
        assert!(
            error(r#"["native/charts", "native/../native/charts"]"#)
                .contains("lists the crate native/charts twice")
        );
        // Two packages of one name (Cargo takes `-` as `_`).
        write_crate(&dir.join("native/charts-2"), "charts", "", "");
        write_crate(&dir.join("native/my-ui"), "my-ui", "", "");
        write_crate(&dir.join("native/my_ui"), "my_ui", "", "");
        let same = error(r#"["native/charts", "native/charts-2"]"#);
        assert!(
            same.contains("native/charts and native/charts-2 are both the package `charts`"),
            "{same}"
        );
        assert!(
            error(r#"["native/my-ui", "native/my_ui"]"#)
                .contains("are the packages `my-ui` and `my_ui`, one name to Cargo")
        );
        // Two crates of one specifier: one import could not tell them apart.
        write_crate(
            &dir.join("native/charts-copy"),
            "charts-copy",
            "#[native_module(\"app/charts\")]\nfn native(r: &mut Registry) {}\n",
            "",
        );
        let same = error(r#"["native/charts", "native/charts-copy"]"#);
        assert!(
            same.contains(
                "native/charts and native/charts-copy both have `#[native_module(\"app/charts\")]`"
            ),
            "{same}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn specifiers_and_path_dependencies_come_from_the_crates() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-deps-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let nsh = dir.join("nsh");
        write_crate(&nsh.join("crates/nsh-core"), "nsh-core", "", "");
        write_crate(&dir.join("shared/base"), "base", "", "");
        write_crate(
            &dir.join("shared/ui"),
            "ui",
            "",
            "base = { version = \"1\", path = '../base' }\n",
        );
        write_crate(
            &dir.join("app/charts"),
            "charts",
            "// #[native_module(\"commented/out\")]\n#[native_module(\"app/charts\")]\nfn native(r: &mut Registry) {}\n",
            &format!(
                "nsh-core = {{ path = {:?} }}\nui = {{ path = \"../../shared/ui\" }}\nlog = \"0.4\"\n\n\
                 [dev-dependencies]\ntest-only = {{ path = \"../test-only\" }}\n",
                nsh.join("crates/nsh-core").to_string_lossy()
            ),
        );
        write_crate(
            &dir.join("app/storage"),
            "storage",
            "",
            "\n[target.'cfg(unix)'.dependencies.ui]\npath = \"../../shared/ui\"\n",
        );
        std::fs::write(
            dir.join("app/storage/Cargo.toml"),
            std::fs::read_to_string(dir.join("app/storage/Cargo.toml")).unwrap()
                + "\n[lib]\npath = \"lib/root.rs\"\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("app/storage/lib")).unwrap();
        std::fs::write(
            dir.join("app/storage/lib/root.rs"),
            "#[native_module(\"app/storage\")]\nfn native(r: &mut Registry) {}\n",
        )
        .unwrap();
        assert_eq!(
            super::specifier_of(&dir.join("app/charts")).as_deref(),
            Some("app/charts")
        );
        assert_eq!(
            super::specifier_of(&dir.join("app/storage")).as_deref(),
            Some("app/storage")
        );
        assert_eq!(super::specifier_of(&dir.join("shared/ui")), None);
        let crates =
            super::crates(&dir, &serde_json::json!(["app/charts", "app/storage"])).unwrap();
        // The crates, then the local crates they build with (not nsh's, not
        // their dev-dependencies), each once.
        let canonical = |p: &str| dunce::canonicalize(dir.join(p)).unwrap();
        assert_eq!(
            super::watched(&crates, Some(&nsh)),
            [
                canonical("app/charts"),
                canonical("app/storage"),
                canonical("shared/ui"),
                canonical("shared/base"),
            ]
        );
        for (line, value) in [
            ("path = \"../a\"", Some("../a")),
            ("x = { version = \"1\", path = \"../a\" }", Some("../a")),
            ("x = {path='../a'}", Some("../a")),
            ("xpath = \"../a\"", None),
            ("path-x = \"../a\"", None),
            ("x = \"1\"", None),
        ] {
            assert_eq!(super::toml_string(line, "path").as_deref(), value, "{line}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn package_names_come_from_the_package_table() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-app-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = dir.join("Cargo.toml");
        std::fs::write(
            &manifest,
            "[workspace]\nname = \"no\"\n\n[package]\nname = \"gallery-native\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        assert_eq!(super::package_name(&manifest).unwrap(), "gallery-native");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rust_app_declares_its_root_theme_and_appearance() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-root-{}", std::process::id()));
        let ws = dir.join(".nsh/rust");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(dir.join("theme.json"), r#"{ "name": "t", "colors": {} }"#).ok();
        let config = |json: &str| serde_json::from_str::<serde_json::Value>(json).unwrap();
        let root = super::root_config(
            &dir,
            &config(r#"{ "root": "shell::Gallery", "appearance": "dark" }"#),
            &ws,
        )
        .unwrap();
        assert_eq!(root.component, "shell::Gallery");
        assert_eq!(root.appearance.as_deref(), Some("dark"));
        assert_eq!(root.theme, None);
        // `"system"` is the system's appearance: nothing to set.
        let root = super::root_config(
            &dir,
            &config(r#"{ "root": "App", "appearance": "system" }"#),
            &ws,
        )
        .unwrap();
        assert_eq!(root.appearance, None);
        for bad in [
            r#"{ "root": "my app" }"#,
            r#"{ "root": "App<T>" }"#,
            r#"{ "root": 1 }"#,
        ] {
            assert!(
                super::root_config(&dir, &config(bad), &ws).is_err(),
                "{bad}"
            );
        }
        // A value of a newer NSH (or a typo) is warned of and left out.
        let root = super::root_config(
            &dir,
            &config(r#"{ "root": "App", "appearance": "dim" }"#),
            &ws,
        )
        .unwrap();
        assert_eq!(root.appearance, None);
        let root = super::root_config(
            &dir,
            &config(r#"{ "root": "App", "statusBar": { "foreground": "light" } }"#),
            &ws,
        )
        .unwrap();
        assert_eq!(
            root.status_bar.as_deref(),
            Some(r#"{"foreground":"light"}"#)
        );
        for bad in [
            r#""light""#,
            r#"{ "foreground": "dim" }"#,
            r#"{ "hidden": "yes" }"#,
        ] {
            let json = format!(r#"{{ "root": "App", "statusBar": {bad} }}"#);
            assert!(
                super::root_config(&dir, &config(&json), &ws).is_ok(),
                "{bad}"
            );
        }
        let code = super::root_fn(
            "#[cfg(x)]\n",
            "app_native",
            &super::RootConfig {
                component: "App".into(),
                theme: Some("/app/theme.json".into()),
                appearance: Some("dark".into()),
                app_id: Some("com.example.app".into()),
                status_bar: Some(r#"{"foreground":"light","hidden":false}"#.into()),
                url_schemes: vec!["myapp".into()],
                links: Some(r#"{"links":[{"host":"example.com","paths":["/orders/*"]}]}"#.into()),
                window: Some(
                    r#"{"defaultSize":{"width":900,"height":600},"title":"Notes"}"#.into(),
                ),
                application: Some(r#"{"quitMode":"platform"}"#.into()),
                capabilities: None,
                translations: None,
                app_info: "{}".into(),
            },
        );
        for line in [
            "#[cfg(x)]\nfn app_root() -> nsh_core::element::Root {",
            "nsh_core::element::Root::of::<app_native::App>()",
            "include_str!(\"/app/theme.json\")",
            ".appearance(nsh_core::element::Appearance::Dark)",
            ".application_json(",
            ".main_window_json(",
            ".status_bar(",
            ".app_id(\"com.example.app\")",
            ".url_schemes([\"myapp\"])",
            r#".links_json("{\"links\":[{\"host\":\"example.com\",\"paths\":[\"/orders/*\"]}]}")"#,
            r#".app_info_json("{}")"#,
            ".status_bar(nsh_core::StatusBarSetting::default().foreground(nsh_core::StatusBarStyle::Light).hidden(false))",
            r#".main_window_json("{\"defaultSize\":{\"width\":900,\"height\":600},\"title\":\"Notes\"}")"#,
        ] {
            assert!(code.contains(line), "no {line:?} in\n{code}");
        }
        // The web links, then the schemes, which `links_json` would reset.
        assert!(
            code.find(".links_json(") < code.find(".url_schemes("),
            "{code}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rust_app_reports_nsh_jsons_or_its_packages_identity() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-app-info-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let read = |json: &str, package| {
            std::fs::write(dir.join("nsh.json"), json).unwrap();
            let config = serde_json::from_str(json).unwrap();
            let info = super::app_info_json(&dir, &config, package).unwrap();
            serde_json::from_str::<serde_json::Value>(&info).unwrap()
        };
        let json = r#"{ "root": "App", "id": "com.example.orders", "name": "Orders", "version": "2.1.0" }"#;
        // In development: `nsh.json`'s, as a TSX app's `appInfo()` reports it.
        assert_eq!(
            read(json, None),
            serde_json::json!({
                "id": "com.example.orders", "name": "Orders", "version": "2.1.0", "build": null,
                "development": true,
            })
        );
        // A package's, its flags first.
        let flags = super::PackageIdentity {
            version: Some("3.0.0".into()),
            build: Some(9),
            ..Default::default()
        };
        assert_eq!(
            read(json, Some(flags)),
            serde_json::json!({
                "id": "com.example.orders", "name": "Orders", "version": "3.0.0", "build": 9,
                "development": false,
            })
        );
        // With the package writers' defaults where nothing gives them.
        let info = read(
            r#"{ "root": "App", "id": "com.example.orders", "name": "Orders" }"#,
            Some(super::PackageIdentity::default()),
        );
        assert_eq!(info["version"], "1.0.0");
        assert_eq!(info["build"], 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rust_app_declares_its_capabilities() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-caps-{}", std::process::id()));
        let ws = dir.join(".nsh/rust");
        std::fs::create_dir_all(&ws).unwrap();
        let config = |json: &str| serde_json::from_str::<serde_json::Value>(json).unwrap();
        let root = super::root_config(&dir, &config(r#"{ "root": "App" }"#), &ws).unwrap();
        assert_eq!(root.capabilities, None);
        // What this NSH does not know is not granted; the rest is kept.
        let root = super::root_config(
            &dir,
            &config(
                r#"{ "root": "App", "capabilities": { "openUrl": { "schemes": ["https"] }, "bluetooth": true } }"#,
            ),
            &ws,
        )
        .unwrap();
        let json = root.capabilities.clone().unwrap();
        let read = nsh_core::access::Capabilities::from_json(&config(&json)).unwrap();
        let expected = nsh_core::access::Capabilities::from_json(&config(
            r#"{ "openUrl": { "schemes": ["https"] } }"#,
        ))
        .unwrap();
        assert_eq!(read, expected);
        let code = super::root_fn("", "app_native", &root);
        assert!(
            code.contains(&format!(".capabilities_json({json:?})")),
            "{code}"
        );
        // A declaration that is no object grants nothing.
        let root = super::root_config(
            &dir,
            &config(r#"{ "root": "App", "capabilities": 1 }"#),
            &ws,
        )
        .unwrap();
        let read = nsh_core::access::Capabilities::from_json(&config(&root.capabilities.unwrap()))
            .unwrap();
        assert_eq!(read, nsh_core::access::Capabilities::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rust_app_gets_runners_without_js() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-runners-{}", std::process::id()));
        let app = app(
            &dir,
            &[("app-native", dir.join("native"))],
            Some(super::RootConfig {
                component: "App".into(),
                theme: None,
                appearance: None,
                app_id: None,
                status_bar: None,
                url_schemes: Vec::new(),
                links: None,
                window: None,
                application: None,
                capabilities: None,
                translations: None,
                app_info: "{}".into(),
            }),
        );
        app.write_workspace().unwrap();
        let read = |file: &str| std::fs::read_to_string(app.workspace.join(file)).unwrap();
        let manifest = read("Cargo.toml");
        assert!(manifest.contains("\"rust-linux\", \"rust-macos\", \"rust-windows\", \"rust-ios\", \"rust-android\", \"rust-web\", \"rust-app\"]"), "{manifest}");
        for (dir, lib, platform) in [
            ("rust-linux", "nsh-linux-app", "nsh-platform-linux"),
            ("rust-macos", "nsh-macos-app", "nsh-platform-macos"),
            ("rust-windows", "nsh-windows-app", "nsh-platform-windows"),
            ("rust-ios", "nsh-ios-app", "nsh-platform-ios"),
        ] {
            let cargo = read(&format!("{dir}/Cargo.toml"));
            // No `js`: the runner links no QuickJS.
            assert!(cargo.contains(&format!("{lib} = {{ path =")), "{cargo}");
            assert!(
                cargo.contains(&format!("{platform} = {{ path =")),
                "{cargo}"
            );
            assert_eq!(
                cargo.matches("default-features = false").count(),
                2,
                "{cargo}"
            );
            let main = read(&format!("{dir}/main.rs"));
            assert!(
                main.contains(&format!("{}::run_rust(app_root())", lib.replace('-', "_"))),
                "{main}"
            );
            assert!(
                main.contains("nsh_core::element::Root::of::<app_app_native::App>()"),
                "{main}"
            );
        }
        // Optional platform features come from the app, not its runner.
        assert!(!read("rust-linux/Cargo.toml").contains("webview"));
        // `net` only on the platform crates that have it: a feature a crate
        // lacks fails the resolution of the whole workspace.
        for (dir, net) in [
            ("rust-linux", true),
            ("rust-windows", true),
            ("rust-macos", false),
            ("rust-ios", false),
            ("rust-android", false),
        ] {
            let cargo = read(&format!("{dir}/Cargo.toml"));
            assert_eq!(cargo.contains("\"net\""), net, "{cargo}");
        }
        let android = read("rust-android/lib.rs");
        assert!(android.contains("nsh::main!(app_root());"), "{android}");
        assert!(read("rust-android/Cargo.toml").contains("default-features = false"));
        // A TSX app's Android library names its features itself: all by
        // default, so `nsh package` can turn off those it does not use.
        let lib = read("android/Cargo.toml");
        assert_eq!(lib.matches("default-features = false").count(), 2, "{lib}");
        assert!(
            lib.contains("plot = [\"nsh-platform-android/plot\"]"),
            "{lib}"
        );
        assert!(lib.contains("default = [\"js\", \"shader\""), "{lib}");
        let web = read("rust-web/lib.rs");
        // Only `nsh/base`'s core part: the root makes the components it uses
        // by type, so the module links those and no others.
        assert!(web.contains("nsh_platform_web::rust_app!(vec![nsh_base::registry_of([nsh_base::parts::core as nsh_base::parts::Part]), set_app_app_native()], app_root());"), "{web}");
        assert!(!web.contains("nsh_base::registry()"), "{web}");
        assert!(read("rust-web/Cargo.toml").contains("default-features = false"));
        // Linkable for `nsh package`, as the TSX app's runtime.
        assert!(read("rust-web/Cargo.toml").contains("linkable = [\"nsh-platform-web/linkable\"]"));
        assert!(read("rust-web/build.rs").contains("-zstack-size=8388608"));
        // Its headless runner opens the root for the tests.
        let test = read("test/main.rs");
        assert!(test.contains("nsh_testing::runner(vec![nsh_base::registry(), set_app_app_native()], Some(app_root))"), "{test}");
        assert!(
            test.contains("nsh_core::element::Root::of::<app_app_native::App>()"),
            "{test}"
        );
        // Platforms outside NSH start the root and sets of `nsh_rust_app`.
        let rust_app = read("rust-app/lib.rs");
        assert!(rust_app.contains("pub fn ui_sets() -> Vec<nsh_core::element::Registry> {\n    vec![nsh_base::registry(), set_app_app_native()]\n}"), "{rust_app}");
        assert!(rust_app.contains("pub fn app_ui_sets() -> Vec<nsh_core::element::Registry> {\n    vec![set_app_app_native()]\n}"), "{rust_app}");
        assert!(
            rust_app.contains("pub fn root() -> nsh_core::element::Root {\n    app_root()\n}"),
            "{rust_app}"
        );
        assert!(
            rust_app.contains("nsh_core::element::Root::of::<app_app_native::App>()"),
            "{rust_app}"
        );
        assert!(read("rust-app/Cargo.toml").contains("name = \"nsh_rust_app\""));
        // GPUI has no runner: a Rust app is embedded in GPUI apps instead.
        app.gpui_workspace().unwrap();
        assert!(!read("gpui/Cargo.toml").contains("rust-gpui"));
        // Its development hosts run the root when a test session says so
        // (`nsh test --target`); its release runners are the `rust-*` ones.
        for (dir, platform) in [
            ("linux-host", "nsh_platform_linux"),
            ("macos-host", "nsh_platform_macos"),
            ("windows-host", "nsh_platform_windows"),
            ("ios-host", "nsh_platform_ios"),
            ("gpui/gpui-host", "nsh_platform_gpui"),
        ] {
            let main = read(&format!("{dir}/main.rs"));
            assert!(
                main.contains(&format!("{platform}::set_root(app_root);")),
                "{main}"
            );
            assert!(
                main.contains("nsh_core::element::Root::of::<app_app_native::App>()"),
                "{main}"
            );
        }
        assert!(!read("macos-app/main.rs").contains("set_root"));
        let android = read("android/lib.rs");
        assert!(android.contains("nsh::root!(app_root());"), "{android}");
        let web = read("web/lib.rs");
        assert!(web.contains("nsh_platform_web::rust_app!(vec![nsh_base::registry(), set_app_app_native()], app_root());"), "{web}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tsx_app_has_no_rust_runners() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-tsx-{}", std::process::id()));
        let app = app(&dir, &[("app-native", dir.join("native"))], None);
        app.write_workspace().unwrap();
        let manifest = std::fs::read_to_string(app.workspace.join("Cargo.toml")).unwrap();
        // No `rust-*` members (paths may hold the word: a checkout in
        // `yf-rust-exports`).
        assert!(!manifest.contains("\"rust-"), "{manifest}");
        assert!(!app.workspace.join("rust-web").exists());
        // Its headless runner runs the bytecode the CLI compiles for it.
        let test = std::fs::read_to_string(app.workspace.join("test/main.rs")).unwrap();
        assert!(
            test.contains(
                "nsh_testing::runner(vec![nsh_base::registry(), set_app_app_native()], None)"
            ) && !test.contains("app_root"),
            "{test}"
        );
        let cargo = std::fs::read_to_string(app.workspace.join("test/Cargo.toml")).unwrap();
        assert!(cargo.contains("features = [\"js\"]"), "{cargo}");
        assert!(super::is_root(Path::new("/app/nsh.json")));
        assert!(!super::is_root(Path::new("/app/App.tsx")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An app crate on `nsh-platform-linux` (a native entry of its own), in
    /// a workspace whose Linux host turns on the platform's `webview`:
    /// `nsh test` builds the describing program and the headless runner
    /// with the hack, and neither may need WebKitGTK.
    #[test]
    fn the_hack_leaves_the_hosts_web_views_out() {
        let crates_io = "registry+https://github.com/rust-lang/crates.io-index";
        let metadata = serde_json::json!({
            "workspace_members": ["describe", "hack", "linux-host"],
            "packages": [
                { "id": "describe", "name": "app-describe", "version": "0.0.0", "source": null, "manifest_path": "/ws/describe/Cargo.toml" },
                { "id": "hack", "name": "app-hack", "version": "0.0.0", "source": null, "manifest_path": "/ws/hack/Cargo.toml" },
                { "id": "linux-host", "name": "app-linux-host", "version": "0.0.0", "source": null, "manifest_path": "/ws/linux-host/Cargo.toml" },
                { "id": "native", "name": "app-native", "version": "0.1.0", "source": null, "manifest_path": "/app/native/Cargo.toml" },
                {
                    "id": "linux", "name": "nsh-platform-linux", "version": "0.5.0", "source": null,
                    "manifest_path": "/nsh/crates/nsh-platform-linux/Cargo.toml",
                    "features": { "math": [], "webview": ["dep:webkit6"], "video": ["dep:gstreamer"] },
                    "dependencies": [
                        { "name": "gtk4", "rename": "gtk", "optional": false },
                        { "name": "webkit6", "rename": null, "optional": true },
                        { "name": "gstreamer", "rename": null, "optional": true }
                    ]
                },
                { "id": "gtk", "name": "gtk4", "version": "0.11.5", "source": crates_io, "manifest_path": "/r/Cargo.toml" },
                { "id": "gst", "name": "gstreamer", "version": "0.24.0", "source": crates_io, "manifest_path": "/r/Cargo.toml" },
                { "id": "webkit", "name": "webkit6", "version": "0.6.1", "source": crates_io, "manifest_path": "/r/Cargo.toml" },
                { "id": "soup", "name": "soup3", "version": "0.9.0", "source": crates_io, "manifest_path": "/r/Cargo.toml" }
            ],
            "resolve": { "nodes": [
                { "id": "describe", "features": [], "deps": [
                    { "pkg": "native", "dep_kinds": [{ "kind": null }] },
                    { "pkg": "hack", "dep_kinds": [{ "kind": null }] }
                ] },
                { "id": "hack", "features": [], "deps": [] },
                { "id": "linux-host", "features": [], "deps": [{ "pkg": "linux", "dep_kinds": [{ "kind": null }] }] },
                { "id": "native", "features": [], "deps": [{ "pkg": "linux", "dep_kinds": [{ "kind": null }] }] },
                { "id": "linux", "features": ["math", "video", "webview"], "deps": [
                    { "pkg": "gtk", "dep_kinds": [{ "kind": null }] },
                    { "pkg": "gst", "dep_kinds": [{ "kind": null }] },
                    { "pkg": "webkit", "dep_kinds": [{ "kind": null }] }
                ] },
                { "id": "gtk", "features": [], "deps": [] },
                { "id": "gst", "features": [], "deps": [] },
                { "id": "webkit", "features": [], "deps": [
                    { "pkg": "gtk", "dep_kinds": [{ "kind": null }] },
                    { "pkg": "soup", "dep_kinds": [{ "kind": null }] }
                ] },
                { "id": "soup", "features": [], "deps": [] }
            ] }
        });
        let hack = super::hack_dependencies(
            &metadata,
            "app-describe",
            "app-hack",
            "x86_64-unknown-linux-gnu",
            &super::parse_tree_packages(
                "app-native v0.1.0\nnsh-platform-linux v0.5.0\ngtk4 v0.11.5\ngstreamer v0.24.0\n",
            ),
        );
        // The platform's other features and dependencies stay shared.
        assert!(
            hack.contains(
                "package = \"nsh-platform-linux\", path = \"/nsh/crates/nsh-platform-linux\", \
                 default-features = false, features = [\"math\", \"video\"] }"
            ),
            "{hack}"
        );
        assert!(hack.contains("package = \"gtk4\""), "{hack}");
        assert!(hack.contains("package = \"gstreamer\""), "{hack}");
        // WebKitGTK's crates are the host's alone.
        assert!(!hack.contains("webkit6"), "{hack}");
        assert!(!hack.contains("soup3"), "{hack}");
    }

    /// A dependency a host's feature turns on stays in the hack when
    /// another feature the platform has turns it on too.
    #[test]
    fn the_hack_keeps_what_another_feature_needs() {
        let crates_io = "registry+https://github.com/rust-lang/crates.io-index";
        let metadata = serde_json::json!({
            "workspace_members": ["describe", "hack"],
            "packages": [
                { "id": "describe", "name": "app-describe", "version": "0.0.0", "source": null, "manifest_path": "/ws/describe/Cargo.toml" },
                { "id": "hack", "name": "app-hack", "version": "0.0.0", "source": null, "manifest_path": "/ws/hack/Cargo.toml" },
                {
                    "id": "linux", "name": "nsh-platform-linux", "version": "0.5.0", "source": null,
                    "manifest_path": "/nsh/crates/nsh-platform-linux/Cargo.toml",
                    "features": { "webview": ["dep:webkit6"], "pages": ["dep:webkit6"] },
                    "dependencies": [{ "name": "webkit6", "rename": null, "optional": true }]
                },
                { "id": "webkit", "name": "webkit6", "version": "0.6.1", "source": crates_io, "manifest_path": "/r/Cargo.toml" }
            ],
            "resolve": { "nodes": [
                { "id": "describe", "features": [], "deps": [{ "pkg": "linux", "dep_kinds": [{ "kind": null }] }] },
                { "id": "hack", "features": [], "deps": [] },
                { "id": "linux", "features": ["pages", "webview"], "deps": [
                    { "pkg": "webkit", "dep_kinds": [{ "kind": null }] }
                ] },
                { "id": "webkit", "features": [], "deps": [] }
            ] }
        });
        let hack = super::hack_dependencies(
            &metadata,
            "app-describe",
            "app-hack",
            "x86_64-unknown-linux-gnu",
            &super::parse_tree_packages("nsh-platform-linux v0.5.0\nwebkit6 v0.6.1\n"),
        );
        assert!(hack.contains("features = [\"pages\"] }"), "{hack}");
        assert!(hack.contains("package = \"webkit6\""), "{hack}");
    }

    /// A workspace whose describing program builds `nsh-core` and what it
    /// depends on; the test runner alone builds `wgpu`.
    fn hack_metadata() -> serde_json::Value {
        serde_json::json!({
            "workspace_members": ["describe", "hack", "test"],
            "packages": [
                { "id": "describe", "name": "app-describe", "version": "0.0.0", "source": null, "manifest_path": "/ws/describe/Cargo.toml" },
                { "id": "hack", "name": "app-hack", "version": "0.0.0", "source": null, "manifest_path": "/ws/hack/Cargo.toml" },
                { "id": "test", "name": "app-test", "version": "0.0.0", "source": null, "manifest_path": "/ws/test/Cargo.toml" },
                { "id": "core", "name": "nsh-core", "version": "0.5.0", "source": null, "manifest_path": "/nsh/crates/nsh-core/Cargo.toml" },
                { "id": "sv1", "name": "smallvec", "version": "1.15.1", "source": "registry+https://github.com/rust-lang/crates.io-index", "manifest_path": "/r/Cargo.toml" },
                { "id": "sv2", "name": "smallvec", "version": "2.0.0", "source": "sparse+https://index.crates.io/", "manifest_path": "/r/Cargo.toml" },
                { "id": "git", "name": "taffy", "version": "0.9.0", "source": "git+https://github.com/x/taffy?branch=main#abc", "manifest_path": "/g/Cargo.toml" },
                { "id": "cc", "name": "cc", "version": "1.2.0", "source": "registry+https://github.com/rust-lang/crates.io-index", "manifest_path": "/r/Cargo.toml" },
                { "id": "other", "name": "private", "version": "1.0.0", "source": "registry+https://example.com/index", "manifest_path": "/r/Cargo.toml" },
                { "id": "dev", "name": "pretty", "version": "1.0.0", "source": "registry+https://github.com/rust-lang/crates.io-index", "manifest_path": "/r/Cargo.toml" },
                { "id": "only-test", "name": "wgpu", "version": "27.0.0", "source": "registry+https://github.com/rust-lang/crates.io-index", "manifest_path": "/r/Cargo.toml" }
            ],
            "resolve": { "nodes": [
                { "id": "describe", "features": [], "deps": [
                    { "pkg": "core", "dep_kinds": [{ "kind": null }] },
                    { "pkg": "hack", "dep_kinds": [{ "kind": null }] },
                    { "pkg": "dev", "dep_kinds": [{ "kind": "dev" }] }
                ] },
                { "id": "hack", "features": [], "deps": [{ "pkg": "only-test", "dep_kinds": [{ "kind": null }] }] },
                { "id": "test", "features": [], "deps": [{ "pkg": "only-test", "dep_kinds": [{ "kind": null }] }] },
                { "id": "core", "features": ["declarations", "shader", "svg"], "deps": [
                    { "pkg": "sv1", "dep_kinds": [{ "kind": null }] },
                    { "pkg": "sv2", "dep_kinds": [{ "kind": null }] },
                    { "pkg": "git", "dep_kinds": [{ "kind": null }] },
                    { "pkg": "other", "dep_kinds": [{ "kind": null }] },
                    { "pkg": "cc", "dep_kinds": [{ "kind": "build" }] }
                ] },
                { "id": "sv1", "features": ["const_generics"], "deps": [] },
                { "id": "sv2", "features": [], "deps": [] },
                { "id": "git", "features": ["default"], "deps": [] },
                { "id": "cc", "features": [], "deps": [] },
                { "id": "other", "features": [], "deps": [] },
                { "id": "dev", "features": [], "deps": [] },
                { "id": "only-test", "features": [], "deps": [] }
            ] }
        })
    }

    /// `cargo tree -p app-describe` of [`hack_metadata`].
    const DESCRIBE_TREE: &str = "app-describe v0.0.0 (/ws/describe)\n\
         nsh-core v0.5.0 (/nsh/crates/nsh-core)\n\
         smallvec v1.15.1\n\
         smallvec v2.0.0\n\
         taffy v0.9.0 (https://github.com/x/taffy?branch=main#abc)\n\
         private v1.0.0 (registry `example`)\n\
         cc v1.2.0\n\
         nsh-core v0.5.0 (/nsh/crates/nsh-core) (*)\n";

    fn hack_of(metadata: &serde_json::Value, tree: &str) -> String {
        super::hack_dependencies(
            metadata,
            "app-describe",
            "app-hack",
            "x86_64-unknown-linux-gnu",
            &super::parse_tree_packages(tree),
        )
    }

    #[test]
    fn the_hack_names_what_describe_builds_with_its_resolved_features() {
        let hack = hack_of(&hack_metadata(), DESCRIBE_TREE);
        let (normal, build) = hack
            .split_once("[target.\"x86_64-unknown-linux-gnu\".build-dependencies]")
            .unwrap();
        assert_eq!(
            normal.trim(),
            "[target.\"x86_64-unknown-linux-gnu\".dependencies]\n\
             nsh-core-0-5-0 = { package = \"nsh-core\", path = \"/nsh/crates/nsh-core\", default-features = false, features = [\"declarations\", \"shader\", \"svg\"] }\n\
             smallvec-1-15-1 = { package = \"smallvec\", version = \"1.15.1\", default-features = false, features = [\"const_generics\"] }\n\
             smallvec-2-0-0 = { package = \"smallvec\", version = \"2.0.0\", default-features = false, features = [] }\n\
             taffy-0-9-0 = { package = \"taffy\", git = \"https://github.com/x/taffy\", branch = \"main\", default-features = false, features = [\"default\"] }"
        );
        assert_eq!(
            build.trim(),
            "cc-1-2-0 = { package = \"cc\", version = \"1.2.0\", default-features = false, features = [] }"
        );
    }

    /// Another program's features add a package to the workspace's graph
    /// (`nsh-engine`'s `js` turning QuickJS on): the hack stays empty
    /// rather than make the describing program build it.
    #[test]
    fn the_hack_is_empty_when_the_workspace_adds_to_describes_packages() {
        let tree = DESCRIBE_TREE.replace("smallvec v2.0.0\n", "");
        assert_eq!(hack_of(&hack_metadata(), &tree), "");
    }

    /// `cargo tree` names packages by name and version: when two sources
    /// supply one of describe's, the hack stays empty.
    #[test]
    fn the_hack_is_empty_when_describes_packages_are_ambiguous() {
        let mut metadata = hack_metadata();
        metadata["packages"].as_array_mut().unwrap().push(serde_json::json!(
            { "id": "sv1-git", "name": "smallvec", "version": "1.15.1", "source": "git+https://example.com/smallvec#abc", "manifest_path": "/g/Cargo.toml" }
        ));
        assert_eq!(hack_of(&metadata, DESCRIBE_TREE), "");
    }

    #[test]
    fn a_packaged_tsx_runner_uses_the_installed_nightly_commit() {
        let rev = "f577c51901a2857956f8ba0580da4db9ce3a3311";
        let nightly = Nsh::for_runner(None, "nightly", rev).unwrap();
        assert_eq!(
            nightly.dep("nsh-platform-macos", ", default-features = false"),
            format!(
                r#"{{ git = "https://github.com/longbridge/nsh", rev = "{rev}", default-features = false }}"#
            ),
        );
        assert_eq!(Nsh::for_runner(None, "stable", rev).unwrap(), Nsh::Registry);
        assert!(Nsh::for_runner(None, "nightly", "unknown").is_err());
        let local = PathBuf::from("checkout");
        assert_eq!(
            Nsh::for_runner(Some(local.clone()), "nightly", rev).unwrap(),
            Nsh::Source(local),
        );
    }

    #[test]
    fn from_crates_io_every_crate_of_nsh_is_this_version() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-registry-{}", std::process::id()));
        let mut app = app(&dir, &[("app-native", dir.join("native"))], None);
        app.nsh = Nsh::Registry;
        app.write_workspace().unwrap();
        app.gpui_workspace().unwrap();
        let exact = format!("{{ version = \"={}\"", super::VERSION);
        for file in [
            "describe/Cargo.toml",
            "test/Cargo.toml",
            "macos-host/Cargo.toml",
            "ios-app/Cargo.toml",
            "android/Cargo.toml",
            "web/Cargo.toml",
            "gpui/gpui-host/Cargo.toml",
        ] {
            let manifest = std::fs::read_to_string(app.workspace.join(file)).unwrap();
            assert!(manifest.contains(&exact), "{file}: {manifest}");
            let by_path = manifest
                .lines()
                .any(|l| l.starts_with("nsh-") && l.contains("path ="));
            assert!(!by_path, "{file}: {manifest}");
        }
        for file in ["Cargo.toml", "gpui/Cargo.toml"] {
            let manifest = std::fs::read_to_string(app.workspace.join(file)).unwrap();
            assert!(
                !manifest.contains("[patch.crates-io]"),
                "{file}: {manifest}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generated_hosts_optimize_interaction_dependencies_in_debug() {
        let dir =
            std::env::temp_dir().join(format!("nsh-rust-debug-profile-{}", std::process::id()));
        let app = app(&dir, &[("app-native", dir.join("native"))], None);
        app.write_workspace().unwrap();
        app.gpui_workspace().unwrap();
        for file in ["Cargo.toml", "gpui/Cargo.toml"] {
            let manifest = std::fs::read_to_string(app.workspace.join(file)).unwrap();
            for package in ["quickjs-jit-sys", "taffy", "objc2", "objc2-encode"] {
                assert!(
                    manifest.contains(&format!("[profile.dev.package.{package}]\nopt-level = 3")),
                    "{file} must keep {package} fast in debug builds"
                );
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn builds_go_to_cargo_target_dir_else_the_app_s_target() {
        let ws = Path::new("/apps/charts/.nsh/rust");
        let app = super::target_dir(ws, None).unwrap();
        assert_eq!(app, Path::new("/apps/charts/target"));
        assert_eq!(super::target_dir(ws, Some("".into())).unwrap(), app);
        // Absolute on this system: `/cache/target` has no drive on Windows.
        let absolute = if cfg!(windows) {
            r"C:\cache\target"
        } else {
            "/cache/target"
        };
        let shared = super::target_dir(ws, Some(absolute.into())).unwrap();
        assert_eq!(shared, Path::new(absolute));
        let relative = super::target_dir(ws, Some("build".into())).unwrap();
        assert_eq!(relative, std::env::current_dir().unwrap().join("build"));
    }

    #[test]
    fn the_app_s_crates_say_where_nsh_comes_from() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-versions-{}", std::process::id()));
        let checkout =
            dunce::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap();
        let by_path = |c: &str| {
            let path = checkout.join("crates").join(c);
            format!("{c} = {{ path = {:?} }}\n", path.to_string_lossy())
        };
        let of = |crates: &[(&str, String)]| {
            let crates: Vec<AppCrate> = crates
                .iter()
                .map(|(package, deps)| {
                    let crate_dir = dir.join(package);
                    write_crate(&crate_dir, package, "", deps);
                    AppCrate::new((*package).into(), crate_dir)
                })
                .collect();
            Nsh::of(&crates).map_err(|e| e.to_string())
        };
        let this = super::VERSION;
        // crates.io: this version, exactly or by a requirement it meets.
        let exact = format!("nsh-core = \"={this}\"\n");
        assert_eq!(of(&[("a", exact.clone())]), Ok(Nsh::Registry));
        let caret = format!("nsh-core = \"{this}\"\nserde = \"1\"\n");
        assert_eq!(of(&[("a", caret)]), Ok(Nsh::Registry));
        // Another version: still crates.io, retargeted to this one.
        let other = of(&[("a", "nsh-base = \"=0.0.1\"\n".into())]);
        assert_eq!(other, Ok(Nsh::Registry));
        // By path: the checkout the crates are in.
        let source = Ok(Nsh::Source(checkout.clone()));
        assert_eq!(of(&[("a", by_path("nsh-core"))]), source);
        assert_eq!(
            of(&[(
                "a",
                format!("{}{}", by_path("nsh-base"), by_path("nsh-engine"))
            )]),
            source
        );
        // One place only.
        let error = of(&[("a", by_path("nsh-core")), ("b", exact)]).unwrap_err();
        assert!(error.contains("from one place"), "{error}");
        // No nsh at all: crates.io (the build then asks for the entry).
        assert_eq!(of(&[("a", "serde = \"1\"\n".into())]), Ok(Nsh::Registry));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_dev_dependency_on_nsh_does_not_choose_the_generated_workspace_s_nsh() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-dev-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname = \"dev-app\"\nversion = \"0.1.0\"\n\n[dev-dependencies]\nnsh-testing = { git = \"https://example.com/nsh.git\", rev = \"0123456789abcdef0123456789abcdef01234567\" }\n",
        )
        .unwrap();
        std::fs::write(dir.join("src/lib.rs"), "").unwrap();
        let nsh = Nsh::resolve(&[AppCrate::new("dev-app".into(), dir.clone())]).unwrap();
        assert_eq!(nsh, Nsh::Registry);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retargeted_manifest_asks_for_this_version_and_keeps_the_rest() {
        let dir = std::env::temp_dir().join(format!("nsh-retarget-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let app = dir.join("app");
        write_crate(
            &app,
            "app-native",
            "",
            "nsh-core = \"=0.0.1\"\nnsh-base = { git = \"https://example.com/nsh.git\", tag = \"v0.0.1\", default-features = false }\nserde = { version = \"1\", features = [\"rc\"] }\n",
        );
        let crates = [AppCrate::new("app-native".into(), app.clone())];
        assert!(super::retargeted(&crates, &Nsh::Registry).unwrap());
        let out = super::write_retargeted(&dir.join("ws"), &app, &Nsh::Registry).unwrap();
        let text = std::fs::read_to_string(out.join("Cargo.toml")).unwrap();
        let this = super::VERSION;
        assert!(
            text.contains(&format!("\"nsh-core\" = {{ version = \"={this}\"")),
            "{text}"
        );
        assert!(
            text.contains(&format!("\"nsh-base\" = {{ version = \"={this}\", package = \"nsh-base\", default-features = false")),
            "{text}"
        );
        assert!(text.contains("features = [\"rc\"]"), "{text}");
        assert!(!text.contains("example.com"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unresolved_git_pin_is_not_retargeted_by_itself() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-optional-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_crate(
            &dir,
            "optional-app",
            "",
            "nsh-core = { git = \"https://example.com/nsh.git\", rev = \"0123456789abcdef0123456789abcdef01234567\", optional = true }\nserde = \"1\"\n",
        );
        let crates = [AppCrate::new("optional-app".into(), dir.clone())];
        assert!(!super::retargeted(&crates, &Nsh::Registry).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_resolution_uses_patched_registry_dependencies_and_renamed_edges() {
        let mut dependencies = vec![serde_json::json!({
            "name": "nsh-core", "rename": "core_runtime", "req": "=0.1.1",
            "source": "registry+https://github.com/rust-lang/crates.io-index"
        })];
        let metadata = serde_json::json!({
            "packages": [
                {"name": "app-native", "id": "app"},
                {"name": "nsh-core", "id": "core",
                 "source": "git+https://example.com/nsh.git?branch=main#0123456789abcdef0123456789abcdef01234567",
                 "manifest_path": "/cargo/git/checkouts/nsh/locked/crates/nsh-core/Cargo.toml"}
            ],
            "resolve": {"nodes": [
                {"id": "app", "deps": [{"name": "core_runtime", "pkg": "core"}]}
            ]}
        });
        super::resolve_git_dependencies(&mut dependencies, &metadata, "app-native").unwrap();
        assert_eq!(dependencies[0]["git"], "https://example.com/nsh.git");
        assert_eq!(
            dependencies[0]["rev"],
            "0123456789abcdef0123456789abcdef01234567"
        );
        assert_eq!(
            dependencies[0]["path"],
            "/cargo/git/checkouts/nsh/locked/crates/nsh-core"
        );
    }

    /// A Git dependency whose library is named apart from its package
    /// (`nsh-platform-android`'s is `nsh`) is found by its package, not
    /// taken for one from crates.io beside the others from Git.
    #[test]
    fn git_resolution_finds_dependencies_by_package_not_library_name() {
        let git = |name: &str| {
            serde_json::json!({
                "name": name, "req": "*",
                "source": "git+https://example.com/nsh.git?branch=main"
            })
        };
        let mut dependencies = vec![git("nsh-core"), git("nsh-platform-android")];
        let locked = "0123456789abcdef0123456789abcdef01234567";
        let resolved = |name: &str| {
            serde_json::json!({
                "name": name, "id": name,
                "source": format!("git+https://example.com/nsh.git?branch=main#{locked}"),
                "manifest_path": format!("/cargo/git/checkouts/nsh/locked/crates/{name}/Cargo.toml")
            })
        };
        let metadata = serde_json::json!({
            "packages": [
                {"name": "app-native", "id": "app"},
                resolved("nsh-core"),
                resolved("nsh-platform-android"),
                // Another package whose library is `nsh`.
                {"name": "other-nsh", "id": "other", "manifest_path": "/elsewhere/Cargo.toml"}
            ],
            "resolve": {"nodes": [
                {"id": "app", "deps": [
                    {"name": "nsh", "pkg": "other"},
                    {"name": "nsh_core", "pkg": "nsh-core"},
                    {"name": "nsh", "pkg": "nsh-platform-android"}
                ]}
            ]}
        });
        super::resolve_git_dependencies(&mut dependencies, &metadata, "app-native").unwrap();
        for (dep, name) in dependencies
            .iter()
            .zip(["nsh-core", "nsh-platform-android"])
        {
            assert_eq!(dep["git"], "https://example.com/nsh.git", "{name}");
            assert_eq!(dep["rev"], locked, "{name}");
            assert_eq!(
                dep["path"],
                format!("/cargo/git/checkouts/nsh/locked/crates/{name}"),
                "{name}"
            );
        }
    }

    #[test]
    fn git_dependencies_use_the_locked_checkout_and_patch_both_sources() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = dir.join("repo");
        write_crate(&repo.join("crates/nsh-core"), "nsh-core", "", "");
        write_crate(&repo.join("crates/nsh-base"), "nsh-base", "", "");
        std::fs::write(repo.join("Cargo.toml"), format!(
            "[workspace]\nmembers = [\"crates/*\"]\nresolver = \"3\"\n[workspace.package]\nversion = {:?}\n", super::VERSION
        )).unwrap();
        for args in [
            vec!["init"],
            vec!["add", "."],
            vec![
                "-c",
                "user.name=NSH test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "fixture",
            ],
        ] {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let repo_path = dunce::canonicalize(&repo).unwrap();
        let url = format!(
            "{}{}",
            if cfg!(windows) { "file:///" } else { "file://" },
            repo_path.to_string_lossy().replace('\\', "/")
        );
        let native = dir.join("app/native");
        write_crate(
            &native,
            "git-app",
            "",
            &format!("nsh-core = {{ git = {url:?} }}\nnsh-base = {{ git = {url:?} }}\n"),
        );
        let app_crate = AppCrate::new("git-app".into(), native.clone());
        let nsh = Nsh::resolve(std::slice::from_ref(&app_crate)).unwrap();
        let Nsh::Git {
            checkout,
            url: resolved_url,
            rev: resolved_rev,
        } = &nsh
        else {
            panic!("Git dependencies must keep their resolved source: {nsh:?}");
        };
        assert_eq!(resolved_url, &url);
        assert_ne!(checkout, &repo);
        assert!(checkout.join("crates/nsh-core/Cargo.toml").is_file());
        let resolved_rev = resolved_rev
            .as_deref()
            .expect("Cargo locks the Git dependency's revision");
        assert_eq!(super::checkout_rev(checkout).as_deref(), Some(resolved_rev));
        // The production entry point refuses a checkout of another revision,
        // naming both, and accepts the revision this nsh was built from.
        let built = "0".repeat(40);
        let error = Nsh::of_with(std::slice::from_ref(&app_crate), &built).unwrap_err();
        let message = error.to_string();
        assert!(message.contains(resolved_rev), "{message}");
        assert!(message.contains(&built), "{message}");
        assert!(matches!(
            Nsh::of_with(std::slice::from_ref(&app_crate), resolved_rev),
            Ok(Nsh::Git { .. })
        ));
        let mut app = app(&dir.join("app"), &[("git-app", native)], None);
        app.nsh = nsh;
        app.write_workspace().unwrap();
        let manifest = std::fs::read_to_string(app.workspace.join("Cargo.toml")).unwrap();
        assert!(manifest.contains("[patch.crates-io]"), "{manifest}");
        assert!(manifest.contains(&format!("[patch.{url:?}]")), "{manifest}");
        let host = std::fs::read_to_string(app.workspace.join("ios-host/Cargo.toml")).unwrap();
        assert!(host.contains("nsh-ios-host = { path ="), "{host}");
        assert!(!host.contains("version = \"="), "{host}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_git_pin_is_checked_by_version_when_a_revision_is_unknown() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-git-version-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("Cargo.toml"),
            "[workspace.package]\nversion = \"0.0.0\"\n",
        )
        .unwrap();
        let rev = "1".repeat(40);
        // This nsh does not know its own revision: the checkout's version
        // is all that can be compared.
        let error = super::check_checkout(&dir, Some(&rev), "unknown").unwrap_err();
        let message = error.to_string();
        assert!(message.contains("0.0.0"), "{message}");
        assert!(message.contains(super::VERSION), "{message}");
        // Nor can Git read the checkout (this directory is no repository):
        // the same version comparison applies.
        let error = super::check_checkout(&dir, None, &rev).unwrap_err();
        assert!(error.to_string().contains("0.0.0"), "{error}");
        std::fs::write(
            dir.join("Cargo.toml"),
            format!("[workspace.package]\nversion = \"{}\"\n", super::VERSION),
        )
        .unwrap();
        assert!(super::check_checkout(&dir, Some(&rev), "unknown").is_ok());
        assert!(super::check_checkout(&dir, None, &rev).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn web_dev_profile_builds_the_development_runtime_incrementally() {
        use crate::runtime::WebKind;
        let dir = std::env::temp_dir().join(format!("nsh-rust-web-dev-{}", std::process::id()));
        let app = app(
            &dir,
            &[
                ("app-charts", dir.join("charts")),
                ("app-storage", dir.join("storage")),
            ],
            None,
        );
        app.write_workspace().unwrap();
        let manifest = std::fs::read_to_string(app.workspace.join("Cargo.toml")).unwrap();
        assert_eq!(super::web_profile(WebKind::Dev), "web-dev");
        let profile = |name: &str| -> Vec<String> {
            let header = format!("[{name}]");
            let mut lines = manifest.lines().skip_while(|l| *l != header).skip(1);
            let mut keys = Vec::new();
            for line in lines.by_ref() {
                if line.starts_with('[') || line.is_empty() {
                    break;
                }
                keys.push(line.to_owned());
            }
            keys
        };
        let web_dev = profile("profile.web-dev");
        for key in [
            "inherits = \"dev\"",
            "opt-level = 1",
            "panic = \"abort\"",
            "debug-assertions = false",
        ] {
            assert!(web_dev.iter().any(|l| l == key), "{key}: {manifest}");
        }
        // Incremental: no LTO, and dev's codegen units.
        assert!(
            !web_dev
                .iter()
                .any(|l| l.starts_with("lto") || l.starts_with("codegen-units"))
        );
        assert_eq!(
            profile("profile.web-dev.package.\"*\""),
            ["opt-level = \"s\""]
        );
        assert!(profile("profile.web-dev.package.quickjs-jit-sys").is_empty());
        for package in ["app-charts", "app-storage"] {
            let name = format!("profile.web-dev.package.\"{package}\"");
            assert_eq!(profile(&name), ["opt-level = 1"], "{manifest}");
        }
        // As nsh's own manifest, for the debug builds of the hosts: each
        // table once, or Cargo rejects the manifest as a duplicate key.
        assert_eq!(
            profile("profile.dev.package.quickjs-jit-sys"),
            ["opt-level = 3"]
        );
        assert_eq!(profile("profile.dev.package.taffy"), ["opt-level = 3"]);
        for table in [
            "[profile.dev.package.quickjs-jit-sys]",
            "[profile.dev.package.taffy]",
            "[profile.web-dev]",
        ] {
            assert_eq!(manifest.matches(table).count(), 1, "{table}: {manifest}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn web_dev_profile_leaves_the_release_runtime_s_profile_as_it_was() {
        use crate::runtime::WebKind;
        let dir = std::env::temp_dir().join(format!("nsh-rust-web-rel-{}", std::process::id()));
        let app = app(&dir, &[("app-native", dir.join("native"))], None);
        app.write_workspace().unwrap();
        let manifest = std::fs::read_to_string(app.workspace.join("Cargo.toml")).unwrap();
        assert_eq!(super::web_profile(WebKind::Browser), "web");
        let web = "[profile.web]
inherits = \"release\"
opt-level = \"z\"
lto = \"fat\"
codegen-units = 1
strip = true
panic = \"abort\"
";
        assert!(manifest.contains(web), "{manifest}");
        assert_eq!(manifest.matches("[profile.web.").count(), 0, "{manifest}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_generated_code_calls_the_entry_of_the_crate() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-app-ws-{}", std::process::id()));
        let app = app(&dir, &[("app-native", dir.join("native"))], None);
        app.write_workspace().unwrap();
        let read = |file: &str| std::fs::read_to_string(app.workspace.join(file)).unwrap();
        // GPUI's hosts are written only for a GPUI build, in a workspace of
        // their own, so other builds never resolve GPUI's crates.
        let manifest = read("Cargo.toml");
        assert!(!manifest.contains("gpui-"), "{manifest}");
        assert!(manifest.contains("[patch.crates-io]"), "{manifest}");
        assert!(manifest.contains("nsh-core = { path ="), "{manifest}");
        assert!(
            manifest.contains("exclude = [\"gpui\", \"tui\"]"),
            "{manifest}"
        );
        // The terminal's host too: nsh's releases before the terminal
        // backend have no crates for it to resolve.
        assert!(!manifest.contains("\"tui-host\""), "{manifest}");
        // The web runtime is built as nsh builds its own.
        assert!(manifest.contains("\"web\"]"), "{manifest}");
        assert!(manifest.contains("[profile.web]"), "{manifest}");
        let web = read("web/Cargo.toml");
        assert!(web.contains("crate-type = [\"cdylib\"]"), "{web}");
        assert!(web.contains("name = \"nsh_app_app_native_web\""), "{web}");
        assert!(web.contains("dev = [\"nsh-platform-web/dev\"]"), "{web}");
        let build = read("web/build.rs");
        assert!(build.contains("-zstack-size=8388608"), "{build}");
        // The web runtime: linkable, with a gate per set (`nsh/base`'s are
        // the runtime's own parts), which `nsh package` keeps when imported.
        assert!(
            web.contains("linkable = [\"nsh-platform-web/linkable\"]"),
            "{web}"
        );
        let lib = read("web/lib.rs");
        assert!(
            lib.contains("#[cfg(target_arch = \"wasm32\")]\nnsh_platform_web::ui_set!(nsh_ui_set_app_app_native, set_app_app_native());"),
            "{lib}"
        );
        assert!(!lib.contains("nsh_base::registry()"), "{lib}");
        assert!(!app.workspace.join("gpui").exists());
        assert_eq!(app.gpui_workspace().unwrap(), app.workspace.join("gpui"));
        assert!(read("gpui/Cargo.toml").contains("members = [\"gpui-host\"]"));
        assert!(!app.workspace.join("tui").exists());
        assert_eq!(app.tui_workspace().unwrap(), app.workspace.join("tui"));
        let tui = read("tui/Cargo.toml");
        assert!(tui.contains("members = [\"tui-host\"]"), "{tui}");
        assert!(tui.contains("[patch.crates-io]"), "{tui}");
        assert!(
            read("tui/tui-host/main.rs")
                .contains("vec![nsh_base::registry(), set_app_app_native()]")
        );
        for (file, cfg) in [
            ("test/main.rs", ""),
            ("ios-host/main.rs", "#[cfg(target_os = \"ios\")]\n"),
            ("ios-app/main.rs", "#[cfg(target_os = \"ios\")]\n"),
            ("linux-host/main.rs", "#[cfg(target_os = \"linux\")]\n"),
            ("linux-app/main.rs", "#[cfg(target_os = \"linux\")]\n"),
            ("macos-host/main.rs", "#[cfg(target_os = \"macos\")]\n"),
            ("macos-app/main.rs", "#[cfg(target_os = \"macos\")]\n"),
            ("windows-host/main.rs", "#[cfg(target_os = \"windows\")]\n"),
            ("windows-app/main.rs", "#[cfg(target_os = \"windows\")]\n"),
            (
                "gpui/gpui-host/main.rs",
                "#[cfg(any(target_os = \"linux\", target_os = \"macos\", windows))]\n",
            ),
            ("android/lib.rs", "#[cfg(target_os = \"android\")]\n"),
            ("web/lib.rs", "#[cfg(target_arch = \"wasm32\")]\n"),
        ] {
            let code = read(file);
            // The web runtime registers each set through its gate.
            let sets = if file == "web/lib.rs" {
                "set_app_app_native()".to_owned()
            } else {
                "vec![nsh_base::registry(), set_app_app_native()]".to_owned()
            };
            for line in [
                sets,
                format!(
                    "{cfg}fn set_app_app_native() -> nsh_core::element::Registry {{\n    #[allow(unused_imports)]\n    use app_app_native::*;\n    __nsh_native_module() // the crate app-native (nsh.json \"rust\")\n}}"
                ),
                format!(
                    "{cfg}#[allow(unused_imports)]\nuse nsh_core::element::__private::no_native_module as __nsh_native_module;"
                ),
            ] {
                assert!(code.contains(&line), "{file}: no {line:?} in\n{code}");
            }
        }
        for dir in [
            "describe",
            "test",
            "ios-host",
            "ios-app",
            "linux-host",
            "linux-app",
            "macos-host",
            "macos-app",
            "windows-host",
            "windows-app",
            "gpui/gpui-host",
            "tui/tui-host",
            "android",
            "web",
        ] {
            assert!(
                read(&format!("{dir}/Cargo.toml")).contains("\nnsh-core = "),
                "{dir}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_workspace_on_crates_io_names_no_terminal_crate_until_its_host_is_built() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-app-tui-{}", std::process::id()));
        let mut app = app(&dir, &[("app-native", dir.join("native"))], None);
        app.nsh = Nsh::Registry;
        // A host written by an earlier nsh into the main workspace.
        std::fs::create_dir_all(app.workspace.join("tui-host")).unwrap();
        app.write_workspace().unwrap();
        assert!(!app.workspace.join("tui-host").exists());
        // The main workspace's manifest and its members'.
        let mut main = std::fs::read_to_string(app.workspace.join("Cargo.toml")).unwrap();
        for entry in std::fs::read_dir(&app.workspace).unwrap() {
            let member = entry.unwrap().path().join("Cargo.toml");
            if let Ok(manifest) = std::fs::read_to_string(member) {
                main.push_str(&manifest);
            }
        }
        assert!(
            main.contains(&format!(
                "nsh-core = {{ version = \"={}\" }}",
                super::VERSION
            )),
            "{main}"
        );
        assert!(!main.contains("nsh-platform-tui"), "{main}");
        assert!(!main.contains("nsh-tui-host"), "{main}");
        let tui = std::fs::read_to_string(app.tui_workspace().unwrap().join("tui-host/Cargo.toml"))
            .unwrap();
        assert!(
            tui.contains(&format!(
                "nsh-platform-tui = {{ version = \"={}\" }}",
                super::VERSION
            )),
            "{tui}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_generated_registration_compiles_whatever_the_crates_export() {
        // `app_components()` as the hosts have it, built by `rustc` with
        // stand-ins for the platform's crate, nsh-core and two crates: one
        // exporting a function named as a parameter of the generated code
        // could be (`pub fn components`), one without native components.
        let dir = std::env::temp_dir().join(format!("nsh-rust-components-{}", std::process::id()));
        let app = app(
            &dir,
            &[
                ("charts", dir.join("native/charts")),
                ("app-storage", dir.join("native/storage")),
            ],
            None,
        );
        let generated = app.app_components("", "nsh_platform_windows", "windows");
        let source = format!(
            "mod nsh_platform_windows {{\n    pub struct Components(pub std::cell::Cell<u32>);\n}}\n\
             mod nsh_core {{\n    pub mod element {{\n        pub mod __private {{\n            \
             pub fn no_native_components<C>(_components: C) {{}}\n        }}\n    }}\n}}\n\
             mod app_charts {{\n    use crate::nsh_platform_windows::Components;\n    \
             pub fn components(components: &Components) {{\n        components.0.set(components.0.get() + 1);\n    }}\n    \
             pub fn __nsh_native_components_windows(registry: &Components) {{\n        components(registry)\n    }}\n}}\n\
             mod app_app_storage {{}}\n{generated}\n\
             fn main() {{\n    let components = nsh_platform_windows::Components(Default::default());\n    \
             app_components(&components);\n    assert_eq!(components.0.get(), 1, \"charts registers once, storage nothing\");\n}}\n"
        );
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("registration.rs");
        let exe = dir.join(format!("registration{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&file, &source).unwrap();
        let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
        let built = std::process::Command::new(rustc)
            .args(["--edition", "2024", "--crate-type", "bin", "-o"])
            .arg(&exe)
            .arg(&file)
            .output()
            .unwrap();
        assert!(
            built.status.success(),
            "{}\n{source}",
            String::from_utf8_lossy(&built.stderr)
        );
        let ran = std::process::Command::new(&exe).output().unwrap();
        assert!(
            ran.status.success(),
            "{}",
            String::from_utf8_lossy(&ran.stderr)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_generated_code_calls_the_entry_of_each_crate() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-two-{}", std::process::id()));
        let app = app(
            &dir,
            &[
                ("charts", dir.join("native/charts")),
                ("app-storage", dir.join("native/storage")),
            ],
            Some(super::RootConfig {
                component: "shell::Home".into(),
                theme: None,
                appearance: None,
                app_id: None,
                status_bar: None,
                url_schemes: Vec::new(),
                links: None,
                window: None,
                application: None,
                capabilities: None,
                translations: None,
                app_info: "{}".into(),
            }),
        );
        app.write_workspace().unwrap();
        app.gpui_workspace().unwrap();
        let read = |file: &str| std::fs::read_to_string(app.workspace.join(file)).unwrap();
        let sets = "vec![nsh_base::registry(), set_app_charts(), set_app_app_storage()]";
        for dir in [
            "test",
            "ios-host",
            "ios-app",
            "linux-host",
            "linux-app",
            "macos-host",
            "macos-app",
            "windows-host",
            "windows-app",
            "gpui/gpui-host",
            "android",
            "web",
            "rust-linux",
            "rust-macos",
            "rust-windows",
            "rust-ios",
            "rust-android",
            "rust-web",
            "rust-app",
        ] {
            let cargo = read(&format!("{dir}/Cargo.toml"));
            for (name, package, path) in [
                ("app_charts", "charts", "native/charts"),
                ("app_app_storage", "app-storage", "native/storage"),
            ] {
                let line = format!(
                    "\n{name} = {{ package = \"{package}\", path = {:?} }}\n",
                    dir_of(&app, path)
                );
                assert!(cargo.contains(&line), "{dir}: no {line:?} in\n{cargo}");
            }
            let file = if dir == "android"
                || dir.ends_with("web")
                || dir == "rust-android"
                || dir == "rust-app"
            {
                "lib.rs"
            } else {
                "main.rs"
            };
            let code = read(&format!("{dir}/{file}"));
            // A Rust app's runners and web runtime run no JS: they take
            // `nsh/base`'s core part only.
            let sets = if matches!(
                dir,
                "rust-web" | "rust-linux" | "rust-macos" | "rust-windows" | "rust-ios"
            ) {
                "vec![nsh_base::registry_of([nsh_base::parts::core as nsh_base::parts::Part]), set_app_charts(), set_app_app_storage()]"
            } else {
                sets
            };
            assert!(code.contains(sets), "{dir}: no {sets:?} in\n{code}");
            // Each crate's entry in its own function; one stand-in.
            for (name, package) in [("app_charts", "charts"), ("app_app_storage", "app-storage")] {
                let set = format!(
                    "fn set_{name}() -> nsh_core::element::Registry {{\n    #[allow(unused_imports)]\n    use {name}::*;\n    __nsh_native_module() // the crate {package} (nsh.json \"rust\")\n}}"
                );
                assert!(code.contains(&set), "{dir}: no {set:?} in\n{code}");
            }
            assert_eq!(
                code.matches("no_native_module as __nsh_native_module;")
                    .count(),
                1,
                "{dir}"
            );
            // The root is a component of the first crate listed.
            if dir.contains("rust-") {
                assert!(
                    code.contains("nsh_core::element::Root::of::<app_charts::shell::Home>()"),
                    "{dir}: {code}"
                );
            }
            // The desktops' standalone backends and iOS register each
            // crate's native components, over one stand-in that registers
            // nothing.
            match super::components_platform(dir) {
                Some(key) => {
                    let platform = format!("nsh_platform_{key}");
                    let set = format!("{platform}::set_components(app_components);");
                    assert!(code.contains(&set), "{dir}: no {set:?} in\n{code}");
                    let entry = format!("__nsh_native_components_{key}");
                    assert!(
                        code.contains(&format!(
                            "fn app_components(__nsh_components: &{platform}::Components) {{\n"
                        )),
                        "{dir}: {code}"
                    );
                    for (name, package) in
                        [("app_charts", "charts"), ("app_app_storage", "app-storage")]
                    {
                        let call = format!(
                            "    {{\n        #[allow(unused_imports)]\n        use {name}::*;\n        {entry}(__nsh_components); // the crate {package} (nsh.json \"rust\")\n    }}\n"
                        );
                        assert!(code.contains(&call), "{dir}: no {call:?} in\n{code}");
                    }
                    assert_eq!(
                        code.matches(&format!("no_native_components as {entry};"))
                            .count(),
                        1,
                        "{dir}"
                    );
                }
                None if dir == "android" || dir == "rust-android" => {
                    assert!(
                        code.contains("nsh::components!(app_components);"),
                        "{dir}: {code}"
                    );
                    assert!(
                        code.contains("fn app_components(__nsh_components: &nsh::Components) {\n"),
                        "{dir}: {code}"
                    );
                    for (name, package) in
                        [("app_charts", "charts"), ("app_app_storage", "app-storage")]
                    {
                        let call = format!(
                            "    {{\n        #[allow(unused_imports)]\n        use {name}::*;\n        __nsh_native_components_android(__nsh_components); // the crate {package} (nsh.json \"rust\")\n    }}\n"
                        );
                        assert!(code.contains(&call), "{dir}: no {call:?} in\n{code}");
                    }
                    assert_eq!(
                        code.matches("no_native_components as __nsh_native_components_android;")
                            .count(),
                        1,
                        "{dir}"
                    );
                }
                None => assert!(
                    !code.contains("set_components") && !code.contains("components!("),
                    "{dir}: {code}"
                ),
            }
        }
        for (dir, key) in [
            ("windows-host", Some("windows")),
            ("windows-app", Some("windows")),
            ("rust-windows", Some("windows")),
            ("macos-app", Some("macos")),
            ("rust-linux", Some("linux")),
            ("linux-host", Some("linux")),
            ("rust-ios", Some("ios")),
            ("ios-host", Some("ios")),
            ("ios-app", Some("ios")),
            ("gpui-host", None),
            ("android", None),
            ("web", None),
        ] {
            assert_eq!(super::components_platform(dir), key, "{dir}");
        }
        // The describe program: the app's sets only, and nsh-core.
        let describe = read("describe/main.rs");
        assert!(
            describe.contains("let sets = vec![set_app_charts(), set_app_app_storage()];"),
            "{describe}"
        );
        assert!(
            describe.contains("Description::of(&sets).to_json()"),
            "{describe}"
        );
        let manifest = read("describe/Cargo.toml");
        let nsh: Vec<&str> = manifest
            .lines()
            .filter(|l| l.starts_with("nsh-"))
            .map(|l| l.split(' ').next().unwrap())
            .collect();
        assert_eq!(nsh, ["nsh-core"], "{manifest}");
        assert!(manifest.contains("name = \"nsh-app-charts-aebab085-describe\""));
        // Named after its first crate and a digest of all of them: another
        // app's crates build apart.
        assert!(read("test/Cargo.toml").contains("name = \"nsh-app-charts-aebab085-test\""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The nshm in the Cargo graph of the app's crates are those it links,
    /// transitively, that depend on nsh-core and have a `#[native_module]`
    /// at their root, ordered by package; dev and build dependencies,
    /// crates without the entry and nsh's own are not.
    #[test]
    fn the_nshm_of_the_app_s_cargo_dependencies_are_found() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-cargo-nshm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let entry = |specifier: &str| {
            format!("#[native_module(\"{specifier}\")]\nfn native(r: &mut Registry) {{}}\n")
        };
        let core = "nsh-core = { path = \"../nsh-core\" }\n";
        write_crate(&dir.join("nsh-core"), "nsh-core", "", "");
        write_crate(&dir.join("probe"), "probe", &entry("probe"), core);
        write_crate(&dir.join("zeta"), "zeta", &entry("zeta"), core);
        write_crate(&dir.join("dev-only"), "dev-only", &entry("dev-only"), core);
        write_crate(
            &dir.join("build-only"),
            "build-only",
            &entry("build-only"),
            core,
        );
        // Its entry would not build without nsh-core.
        write_crate(&dir.join("no-core"), "no-core", &entry("no-core"), "");
        write_crate(
            &dir.join("shared"),
            "shared",
            "pub fn helper() {}\n",
            &format!("{core}probe = {{ path = \"../probe\" }}\n"),
        );
        write_crate(
            &dir.join("app"),
            "app",
            &entry("app"),
            &format!(
                "{core}zeta = {{ path = \"../zeta\" }}\nshared = {{ path = \"../shared\" }}\n\
                 no-core = {{ path = \"../no-core\" }}\n\n\
                 [dev-dependencies]\ndev-only = {{ path = \"../dev-only\" }}\n\n\
                 [build-dependencies]\nbuild-only = {{ path = \"../build-only\" }}\n"
            ),
        );
        let app = AppCrate::new("app".into(), dunce::canonicalize(dir.join("app")).unwrap());
        let found = super::cargo_nshm(std::slice::from_ref(&app)).unwrap();
        let canonical = |name: &str| dunce::canonicalize(dir.join(name)).unwrap();
        let mut probe = AppCrate::new("probe".into(), canonical("probe"));
        probe.link = Link::Cargo(None);
        let mut zeta = AppCrate::new("zeta".into(), canonical("zeta"));
        zeta.link = Link::Cargo(None);
        assert_eq!(
            found,
            vec![
                ("probe 0.1.0 (a Cargo dependency of app)".to_owned(), probe),
                ("zeta 0.1.0 (a Cargo dependency of app)".to_owned(), zeta),
            ]
        );
        // A crate whose graph has no nshm links nothing more.
        let shared = AppCrate::new("probe".into(), canonical("probe"));
        assert_eq!(super::cargo_nshm(&[shared]).unwrap(), Vec::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A found nshm is linked from where Cargo takes it for the app.
    #[test]
    fn a_found_nshm_is_linked_from_its_cargo_source() {
        let source = |source: Option<&str>| {
            super::cargo_source(&serde_json::json!({
                "name": "acme", "version": "0.6.1", "source": source,
            }))
        };
        assert_eq!(source(None).unwrap(), None);
        for crates_io in [
            "registry+https://github.com/rust-lang/crates.io-index",
            "sparse+https://index.crates.io/",
        ] {
            assert_eq!(
                source(Some(crates_io)).unwrap().as_deref(),
                Some("version = \"0.6.1\"")
            );
        }
        assert_eq!(
            source(Some("sparse+https://example.com/index/"))
                .unwrap()
                .as_deref(),
            Some("version = \"0.6.1\", registry-index = \"sparse+https://example.com/index/\"")
        );
        assert_eq!(
            source(Some("registry+https://example.com/index"))
                .unwrap()
                .as_deref(),
            Some("version = \"0.6.1\", registry-index = \"https://example.com/index\"")
        );
        let sha = "0123456789abcdef0123456789abcdef01234567";
        for (git, keys) in [
            (
                format!("git+https://example.com/acme#{sha}"),
                "git = \"https://example.com/acme\"",
            ),
            (
                format!("git+https://example.com/acme?branch=dev#{sha}"),
                "git = \"https://example.com/acme\", branch = \"dev\"",
            ),
            (
                format!("git+https://example.com/acme?rev=0123456#{sha}"),
                "git = \"https://example.com/acme\", rev = \"0123456\"",
            ),
        ] {
            assert_eq!(source(Some(&git)).unwrap().as_deref(), Some(keys));
        }
        assert!(source(Some("local-registry+file:///x")).is_err());
    }

    /// A found nshm `nsh.json` lists as well is linked once, as it lists
    /// it; one that clashes with a listed crate fails as two listed would.
    #[test]
    fn a_found_nshm_is_linked_once() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-found-once-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let entry = |specifier: &str| {
            format!("#[native_module(\"{specifier}\")]\nfn native(r: &mut Registry) {{}}\n")
        };
        write_crate(&dir.join("native"), "app-native", &entry("app/native"), "");
        write_crate(&dir.join("installed"), "acme", &entry("acme"), "");
        write_crate(&dir.join("cargo/acme"), "acme", &entry("acme"), "");
        write_crate(&dir.join("cargo/local"), "app-native", &entry("local"), "");
        write_crate(&dir.join("cargo/same"), "same", &entry("app/native"), "");
        let krate = |package: &str, path: &str, link: Link| {
            let mut c = AppCrate::new(package.into(), dir.join(path));
            c.link = link;
            c
        };
        let native = krate("app-native", "native", Link::Listed);
        let installed = krate("acme", "installed", Link::Listed);
        let listed = || {
            vec![
                ("native".to_owned(), native.clone()),
                ("acme".to_owned(), installed.clone()),
            ]
        };
        let found = |c: AppCrate| (format!("{} (found)", c.package), c);
        let fetched = Link::Cargo(Some("version = \"0.6.1\"".into()));
        // The listed crate itself and the installed nshm's package.
        let crates = super::with_found(
            listed(),
            &[installed.name()],
            vec![
                found(krate("acme", "cargo/acme", fetched.clone())),
                found(krate("app-native", "native", Link::Cargo(None))),
            ],
        )
        .unwrap();
        assert_eq!(crates, vec![native.clone(), installed.clone()]);
        // Another crate of a listed one's package.
        let error = super::with_found(
            listed(),
            &[installed.name()],
            vec![found(krate("app-native", "cargo/local", Link::Cargo(None)))],
        )
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("are both the package `app-native`"),
            "{error}"
        );
        // Another crate of a listed one's specifier.
        let error = super::with_found(
            listed(),
            &[installed.name()],
            vec![found(krate("same", "cargo/same", fetched))],
        )
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("native and same (found) both have `#[native_module(\"app/native\")]`"),
            "{error}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The generated code links a found nshm from its source, with only the
    /// features the app's crates turn on, and calls its entries after the
    /// listed crates'; built optimized when Cargo fetches it.
    #[test]
    fn the_generated_code_calls_the_entries_of_found_nshm() {
        let dir = std::env::temp_dir().join(format!("nsh-rust-found-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut app = app(&dir, &[("app-native", dir.join("native"))], None);
        let mut probe = AppCrate::new("probe".into(), dir.join("probe"));
        probe.link = Link::Cargo(None);
        let mut extra = AppCrate::new("acme-extra".into(), dir.join("registry/acme-extra"));
        extra.link = Link::Cargo(Some("version = \"0.6.1\"".into()));
        app.crates.extend([probe, extra]);
        app.write_workspace().unwrap();
        let read = |file: &str| std::fs::read_to_string(app.workspace.join(file)).unwrap();
        let cargo = read("macos-host/Cargo.toml");
        for line in [
            format!(
                "\napp_app_native = {{ package = \"app-native\", path = {:?} }}\n",
                dir_of(&app, "native")
            ),
            format!(
                "\napp_probe = {{ package = \"probe\", path = {:?}, default-features = false }}\n",
                dir_of(&app, "probe")
            ),
            "\napp_acme_extra = { package = \"acme-extra\", version = \"0.6.1\", default-features = false }\n"
                .to_owned(),
        ] {
            assert!(cargo.contains(&line), "no {line:?} in\n{cargo}");
        }
        let main = read("macos-host/main.rs");
        assert!(
            main.contains("vec![nsh_base::registry(), set_app_app_native(), set_app_probe(), set_app_acme_extra()]"),
            "{main}"
        );
        assert!(
            main.contains(
                "    use app_acme_extra::*;\n    __nsh_native_module() // the crate acme-extra (a Cargo dependency of the app's crates)\n"
            ),
            "{main}"
        );
        let manifest = read("Cargo.toml");
        assert!(
            manifest.contains("[profile.dev.package.\"probe\"]"),
            "{manifest}"
        );
        assert!(!manifest.contains("acme-extra"), "{manifest}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_cli_reads_the_description_of_the_app_s_crates() {
        use nsh_core::element::description::{Description, SetDescription};
        let crates = |packages: &[&str]| -> Vec<AppCrate> {
            packages
                .iter()
                .map(|p| AppCrate::new((*p).into(), PathBuf::from("/app").join(p)))
                .collect()
        };
        let set = |specifier: &'static str| -> SetDescription {
            nsh_core::element::Registry::ui_set(specifier).into()
        };
        let text = |sets: Vec<SetDescription>| {
            Description {
                nsh: super::VERSION.into(),
                sets,
            }
            .to_json()
        };
        let read = |text: &str, packages: &[&str]| {
            super::read_description(text, &crates(packages), "the Rust crates")
                .map_err(|e| e.to_string())
        };
        let two = text(vec![set("app/charts"), set("app/storage")]);
        let sets = read(&two, &["charts", "storage"]).unwrap();
        assert_eq!(sets[1].specifier, "app/storage");
        // One set per crate.
        assert_eq!(
            read(&two, &["charts"]).unwrap_err(),
            "the description of the Rust crates has 2 UI sets for 1 crates"
        );
        // Another nsh's description.
        let mut other = Description::from_json(&two).unwrap();
        other.nsh = "0.0.1".into();
        let error = read(&other.to_json(), &["charts", "storage"]).unwrap_err();
        assert!(
            error.contains("described by nsh 0.0.1 and this nsh is"),
            "{error}"
        );
        assert!(
            read("{\"format\": 0}", &["charts"])
                .unwrap_err()
                .starts_with("the description of the Rust crates: the description is in format 0")
        );
        // A specifier of nsh's own or of another crate.
        for nsh in ["nsh/base", "nsh", "nsh/mobile"] {
            let error = read(&text(vec![set(nsh)]), &["charts"]).unwrap_err();
            assert!(
                error.contains(&format!(
                    "the crate charts is imported as {nsh:?}, one of nsh's own modules"
                )),
                "{error}"
            );
        }
        let error = read(
            &text(vec![set("app/charts"), set("app/charts")]),
            &["charts", "storage"],
        )
        .unwrap_err();
        assert!(
            error.contains("the crates charts and storage are both imported as \"app/charts\""),
            "{error}"
        );
    }

    /// The directory `path` of the app's crates, as the generated code
    /// names it.
    fn dir_of(app: &RustApp, path: &str) -> String {
        app.workspace
            .parent()
            .and_then(Path::parent)
            .unwrap()
            .join(path)
            .to_string_lossy()
            .into_owned()
    }

    /// The names of the generated crates and their binaries
    /// ([`super::bin_name`]).
    mod crate_names {
        use super::super::bin_name;

        /// The twelve bridges of the app that found the bug.
        const BRIDGES: [&str; 12] = [
            "shell-bridge",
            "feed-bridge",
            "media-bridge",
            "auth-bridge",
            "storage-bridge",
            "network-bridge",
            "camera-bridge",
            "location-bridge",
            "share-bridge",
            "payments-bridge",
            "analytics-bridge",
            "notifications-bridge",
        ];

        /// What the generated crates are for, the longest included.
        const WHATS: [&str; 4] = ["describe", "test", "rust-android", "tui-host"];

        #[test]
        fn one_crate_keeps_its_name() {
            assert_eq!(
                bin_name(&["gallery-native"], "describe"),
                "nsh-app-gallery-native-describe"
            );
        }

        #[test]
        fn several_crates_name_the_first_and_a_digest() {
            assert_eq!(
                bin_name(&["charts", "storage"], "describe"),
                "nsh-app-charts-ef5aa537-describe"
            );
            let name = bin_name(&BRIDGES, "describe");
            assert!(name.starts_with("nsh-app-shell-bridge-"), "{name}");
            assert!(name.ends_with("-describe"), "{name}");
        }

        #[test]
        fn names_stay_short_however_many_crates() {
            for count in [1, 2, 12] {
                for what in WHATS {
                    let name = bin_name(&BRIDGES[..count], what);
                    assert!(name.len() <= 42, "{count} crates: {name} ({})", name.len());
                }
            }
            // As short with twelve crates as with two.
            assert_eq!(
                bin_name(&BRIDGES[..2], "describe").len(),
                bin_name(&BRIDGES, "describe").len()
            );
        }

        #[test]
        fn names_are_stable() {
            assert_eq!(bin_name(&BRIDGES, "test"), bin_name(&BRIDGES, "test"));
            // The digest is of the packages, whatever their order.
            let mut reordered = BRIDGES;
            reordered[1..].reverse();
            assert_eq!(bin_name(&reordered, "test"), bin_name(&BRIDGES, "test"));
        }

        #[test]
        fn names_are_distinct() {
            let mut names = Vec::new();
            for count in 1..=BRIDGES.len() {
                for what in WHATS {
                    names.push(bin_name(&BRIDGES[..count], what));
                }
            }
            // The same first crate with other crates beside it.
            names.push(bin_name(&["shell-bridge", "other-bridge"], "describe"));
            // The same crates, another first.
            names.push(bin_name(&["feed-bridge", "shell-bridge"], "describe"));
            let count = names.len();
            names.sort();
            names.dedup();
            assert_eq!(names.len(), count, "{names:#?}");
        }

        #[test]
        fn names_keep_the_prefix() {
            for count in [1, 2, 12] {
                let name = bin_name(&BRIDGES[..count], "describe");
                assert!(name.starts_with("nsh-app-"), "{name}");
            }
        }
    }

    #[test]
    fn an_nshm_links_with_the_features_the_app_turns_on() {
        let extra = AppCrate::new("nsh-extra".into(), PathBuf::from("/cache/nsh-extra"));
        assert_eq!(
            extra.dependency(),
            r#"app_nsh_extra = { package = "nsh-extra", path = "/cache/nsh-extra" }"#
        );
        let extra = extra.with_features(vec!["camera".into(), "push".into()]);
        assert_eq!(
            extra.dependency(),
            r#"app_nsh_extra = { package = "nsh-extra", path = "/cache/nsh-extra", features = ["camera", "push"] }"#
        );
    }
}
