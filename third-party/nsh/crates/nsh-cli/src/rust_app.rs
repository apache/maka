//! Apps with Rust components of their own: `"rust": "<crate dir>"` in
//! `nsh.json` (or a list of them, [`crates`]) names library crates, each
//! with a `#[native_module("<specifier>")]` function at its root, which
//! registers its components and modules into a UI set the app imports by
//! that specifier. The attribute makes the entry the generated code calls
//! ([`ENTRY`]); each crate is linked under a name of its own
//! ([`AppCrate::name`]), so their entries do not clash.
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
//! to that checkout. An app on another version of nsh runs with this one: its
//! crates are built from manifests written in the workspace, asking for this
//! version ([`write_retargeted`]), and only a real API change stops the
//! build, as a compile error. It builds in the app's own `target`, as a Cargo project in the app's
//! directory would, or in `CARGO_TARGET_DIR`.

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context as _, bail};
use nsh_core::element::description::{Description, SetDescription};
use sha2::{Digest as _, Sha256};

use crate::{runtime::Platform, ui};

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

/// Makes `app` the app of this command ([`current`]).
pub(crate) fn set_current(app: RustApp) {
    *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
}

/// The app of this command, if it has Rust crates of its own.
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
    /// The crates `nsh.json` `"rust"` lists, in its order: each is a UI set
    /// of its own, after nsh's.
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
}

/// A crate of the app (`nsh.json` `"rust"`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppCrate {
    /// Its package name (`gallery-native`).
    package: String,
    /// Its directory.
    dir: PathBuf,
}

impl AppCrate {
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
        format!(
            "{} = {{ package = {:?}, path = {:?} }}",
            self.name(),
            self.package,
            self.dir.to_string_lossy()
        )
    }
}

/// Where the generated workspace takes nsh's crates from: where the app's
/// crates take them from ([`Nsh::of`]), so the app and its hosts share one
/// core (or their component and registry types differ).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Nsh {
    /// crates.io, at this `nsh`'s version ([`VERSION`]): the app's crates
    /// ask for it (`nsh-core = "0.1.1"`, what `nsh init --template rust` writes).
    Registry,
    /// The checkout the app's crates depend on by path (`nsh init
    /// --template rust --nsh-source <dir>`): nsh's own examples, or an app
    /// trying changes to nsh.
    Source(PathBuf),
    /// The Git checkout Cargo resolved for the app, and its repository URL.
    Git { checkout: PathBuf, url: String },
}

/// The version of nsh's crates an app builds with: this command line's, as
/// the code it generates calls their API.
const VERSION: &str = env!("CARGO_PKG_VERSION");

impl Nsh {
    /// Where the app's `crates` take nsh's crates from, as their
    /// dependencies say (`cargo metadata --no-deps`): from crates.io, or by
    /// path from one checkout, whatever its version. Git dependencies use
    /// Cargo's resolved checkout, including patched registry dependencies,
    /// or crates.io when that checkout is another version ([`retargeted`]).
    /// Mixed sources stop the command before a build fails on two
    /// `nsh-core`s.
    fn of(crates: &[AppCrate]) -> anyhow::Result<Nsh> {
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
        let nsh = first.map_or(Nsh::Registry, |(nsh, _)| nsh);
        if let Nsh::Git { checkout, .. } = &nsh
            && checkout_version(checkout)? != VERSION
        {
            return Ok(Nsh::Registry);
        }
        Ok(nsh)
    }

    /// The checkout, if it is one.
    fn source(&self) -> Option<&Path> {
        match self {
            Nsh::Registry => None,
            Nsh::Source(dir) | Nsh::Git { checkout: dir, .. } => Some(dir),
        }
    }

    /// The dependency on nsh's crate `name` for a generated manifest, with
    /// `extra` keys (`, default-features = false`): `{ version = "=0.1.1" }`
    /// or `{ path = "…" }`.
    fn dep(&self, name: &str, extra: &str) -> String {
        match self {
            Nsh::Registry => format!("{{ version = \"={VERSION}\"{extra} }}"),
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

/// The `[target.'<triple>'.dependencies]` and `build-dependencies` of the
/// hack, from `cargo metadata`: every package the workspace member
/// `describe` depends on, normally or to build (`hack` itself left out),
/// with the features Cargo resolved for it; only what builds build scripts
/// as build dependencies.
fn hack_dependencies(
    metadata: &serde_json::Value,
    describe: &str,
    hack: &str,
    triple: &str,
) -> String {
    use std::collections::{BTreeMap, HashMap, HashSet};
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
        for dep in node["deps"].as_array().into_iter().flatten() {
            let Some(pkg) = dep["pkg"].as_str() else {
                continue;
            };
            if name(pkg) == Some(hack) {
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

/// How the hack names `package` (`cargo metadata`), with the features its
/// node resolved: a crates.io version, a path, or a Git source with the
/// reference Cargo.lock has; `None` for other registries.
fn hack_spec(package: &serde_json::Value, node: Option<&serde_json::Value>) -> Option<String> {
    let name = package["name"].as_str()?;
    let features: Vec<String> = node
        .and_then(|n| n["features"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|f| f.as_str())
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
/// and the standard JS modules, which a Rust app does not run.
pub(crate) const RUST_APP_PLATFORM: &str = ", default-features = false, features = [\"shader\", \"editor\", \"emoji-picker\", \"highlight\", \"math\", \"plot\", \"rich-editor\", \"term\"]";
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

/// The version of the nsh checkout `dir` (`[workspace.package]` of its
/// `Cargo.toml`).
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
    /// `"window"` (JSON, checked): the main window's launch options.
    window: Option<String>,
    /// `"capabilities"` (JSON, as this NSH reads it: what it does not know
    /// left out): what the app may reach.
    capabilities: Option<String>,
    /// The app's translations (`locales/`) as JSON, written to the
    /// workspace and compiled into the runners.
    translations: Option<PathBuf>,
}

/// Whether `entry` is a Rust app's (`entry::resolve` gives its `nsh.json`
/// when it declares a `"root"`): it runs with no JS.
pub(crate) fn is_root(entry: &Path) -> bool {
    entry
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("nsh.json"))
}

/// The `"rust"` crates of the app whose entry is `entry`, if it has any.
/// `unify`: the command builds programs for this machine besides the
/// describing one ([`RustApp::unify_features`]).
pub(crate) fn of(entry: &Path, unify: bool) -> anyhow::Result<Option<RustApp>> {
    let entry = dunce::canonicalize(entry)
        .with_context(|| format!("entry not found: {}", entry.display()))?;
    let dir = entry.parent().context("entry has no directory")?;
    let Ok(text) = fs::read_to_string(dir.join("nsh.json")) else {
        return Ok(None);
    };
    let config: serde_json::Value = serde_json::from_str(&text).context("nsh.json is not JSON")?;
    let Some(rust) = config.get("rust") else {
        return Ok(None);
    };
    let crates = crates(dir, rust)?;
    let nsh = Nsh::of(&crates)?;
    let watched = watched(&crates, nsh.source());
    let workspace = dir.join(".nsh/rust");
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
    };
    app.write_workspace()?;
    Ok(Some(app))
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
    let mut crates: Vec<(&str, AppCrate)> = Vec::new();
    for path in paths {
        let dir = dunce::canonicalize(dir.join(path))
            .with_context(|| format!("nsh.json: \"rust\": no crate at {path}"))?;
        let package = package_name(&dir.join("Cargo.toml"))?;
        let krate = AppCrate { package, dir };
        if let Some((other, _)) = crates.iter().find(|(_, c)| c.dir == krate.dir) {
            bail!("nsh.json: \"rust\" lists the crate {other} twice ({path})");
        }
        // Cargo takes `-` and `_` in names as one: so do the names the
        // generated code links the crates by.
        if let Some((other, first)) = crates.iter().find(|(_, c)| c.name() == krate.name()) {
            let same = if first.package == krate.package {
                format!("are both the package `{}`", krate.package)
            } else {
                format!(
                    "are the packages `{}` and `{}`, one name to Cargo",
                    first.package, krate.package
                )
            };
            bail!(
                "nsh.json: \"rust\": {other} and {path} {same}: give each crate a [package] name of its own"
            );
        }
        crates.push((path, krate));
    }
    let mut specifiers: Vec<(&str, String)> = Vec::new();
    for (path, krate) in &crates {
        let Some(specifier) = specifier_of(&krate.dir) else {
            continue;
        };
        if let Some((other, _)) = specifiers.iter().find(|(_, s)| *s == specifier) {
            bail!(
                "nsh.json: \"rust\": {other} and {path} both have `#[native_module({specifier:?})]`: give each crate a specifier of its own, the one its TSX imports it by"
            );
        }
        specifiers.push((path, specifier));
    }
    Ok(crates.into_iter().map(|(_, c)| c).collect())
}

/// The specifier of the `#[native_module("…")]` at the root of the crate
/// in `dir` (its `[lib] path`, or `src/lib.rs`), if it has one; the build
/// fails on a crate without one ([`RustApp::app_sets`]).
fn specifier_of(dir: &Path) -> Option<String> {
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
fn toml_tables(text: &str) -> impl Iterator<Item = (&str, &str)> {
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
fn toml_string(line: &str, key: &str) -> Option<String> {
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
    let window = match config.get("window") {
        None => None,
        Some(v) => {
            nsh_core::desktop::MainWindowOptions::from_json(v)
                .map_err(|e| anyhow::anyhow!("nsh.json: window: {e}"))?;
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
    Ok(RootConfig {
        component,
        theme,
        appearance,
        app_id: crate::package::app_id(&dir.join("nsh.json")).ok(),
        status_bar,
        url_schemes,
        window,
        capabilities,
        translations,
    })
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
/// resolved checkout, keeping the repository URL for generated patches.
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
        let name = dep["rename"]
            .as_str()
            .or(dep["name"].as_str())
            .unwrap_or_default()
            .replace('-', "_");
        let Some(edge) = node["deps"]
            .as_array()
            .and_then(|deps| deps.iter().find(|d| d["name"] == name))
        else {
            continue;
        };
        let resolved = packages
            .iter()
            .find(|p| p["id"] == edge["pkg"])
            .context("cargo metadata resolved dependency")?;
        if let Some(source) = resolved["source"]
            .as_str()
            .and_then(|s| s.strip_prefix("git+"))
        {
            let url = source
                .split(['?', '#'])
                .next()
                .context("Git repository URL")?;
            let path = Path::new(
                resolved["manifest_path"]
                    .as_str()
                    .context("Git manifest path")?,
            )
            .parent()
            .context("Git crate directory")?;
            dep["path"] = path.to_string_lossy().as_ref().into();
            dep["git"] = url.into();
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

/// Whether the app's crates, taking nsh from crates.io, declare something
/// [`VERSION`] does not satisfy: a requirement it fails, or a Git checkout of
/// another version.
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
                dep["source"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("git+"))
                    || !dep["req"]
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
        let (url, query) = source.split_once('?').unwrap_or((source, ""));
        let reference = query.split('#').next().unwrap_or_default();
        let reference = reference
            .split_once('=')
            .map(|(key, value)| format!(", {key} = {value:?}"))
            .unwrap_or_default();
        return format!(
            "{{ git = {:?}{reference}{extra} }}",
            url.split('#').next().unwrap_or(url)
        );
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
fn package_name(manifest: &Path) -> anyhow::Result<String> {
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
                && (rest.starts_with("assets")
                    || path.extension().is_some_and(|e| e == "rs")
                    || path.file_name().is_some_and(|n| n == "Cargo.toml"))
        })
    }

    /// The crates `nsh.json` `"rust"` lists, in its order.
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
            for c in &self.crates {
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
        write(
            &ws.join("android/Cargo.toml"),
            &format!(
                "{}\n[lib]\nname = {:?}\npath = \"lib.rs\"\ncrate-type = [\"cdylib\"]\n\n[features]\ndev = [\"nsh-platform-android/dev\"]\n\n\
                 [dependencies]\nnsh-core = {}\nnsh-platform-android = {}\nnsh-base = {}\n{app}\n",
                package("android"),
                self.android_lib(false),
                src("nsh-core"),
                src("nsh-platform-android"),
                self.nsh.dep("nsh-base", HIGHLIGHT),
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
                 {android}nsh::ui_sets!({sets});\n{root}{}",
                self.app_sets(android)
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
    /// Best effort: when Cargo cannot say, the hack stays empty and each
    /// program builds as before. It stays empty too when only the
    /// describing program is built for this machine (`nsh build`, `nsh
    /// check`, a package or a host for another target): it has nothing to
    /// share, and the hack would give it the features of this machine's
    /// hosts and runners, with the system libraries they need (WebKitGTK
    /// for Linux's web views).
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
        let dependencies =
            hack_dependencies(&metadata, &self.bin("describe"), &self.bin("hack"), &triple);
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
                self.nsh.dep("nsh-platform-android", RUST_APP_PLATFORM),
            ),
        )?;
        write(
            &ws.join("rust-android/lib.rs"),
            &format!(
                "//! The Rust app's `libnsh.so`: its root, which `AppActivity` runs, with\n\
                 //! `nsh/base` and the app's components; no JS runtime.\n\n\
                 {android}nsh::ui_sets!({sets});\n{android}nsh::main!(app_root());\n\n\
                 // Off Android it is empty, as nsh-platform-android is.\n\
                 #[cfg(not(target_os = \"android\"))]\nuse nsh_core as _;\n\
                 #[cfg(not(target_os = \"android\"))]\nuse nsh_base as _;\n{}{}",
                self.app_sets(android),
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
        let sets = self.rust_web_sets();
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
        let sets = self.sets();
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
                self.nsh.dep(platform, RUST_APP_PLATFORM),
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
        for c in &self.crates {
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
            // A checkout's own, so edits to it apply; from crates.io the
            // published crate's, copied next to the module when it is built.
            js: match &self.nsh {
                Nsh::Source(source)
                | Nsh::Git {
                    checkout: source, ..
                } => source.join("crates/nsh-platform-web/web/nsh.js"),
                Nsh::Registry => out.join("nsh.js"),
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
        if self.nsh == Nsh::Registry {
            let js = self.registry_crate("nsh-platform-web")?.join("web/nsh.js");
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

    /// The directory Cargo unpacked nsh's crate `name` (from crates.io, at
    /// [`VERSION`]) into for the workspace, as `cargo metadata` reports it.
    fn registry_crate(&self, name: &str) -> anyhow::Result<PathBuf> {
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
        // These run on every interaction. Keep Objective-C signature
        // checks enabled, but optimize their parser as well as the bridge.
        // App Rust code stays easy to debug.
        for package in ["quickjs-jit-sys", "taffy", "objc2", "objc2-encode"] {
            manifest.push_str(&format!(
                "\n[profile.dev.package.{package}]\nopt-level = 3\n"
            ));
        }
        if let Some(source) = self.nsh.source() {
            manifest.push_str("\n[patch.crates-io]\n");
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
        write(
            &ws.join(dir).join("Cargo.toml"),
            &format!(
                "[package]\nname = {:?}\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n\
                 [[bin]]\nname = {:?}\npath = \"main.rs\"\n\n[dependencies]\n{lib} = {}\nnsh-core = {}\nnsh-base = {}\n{app}\n{hack}\n\
                 [target.'cfg({os})'.dependencies]\n{platform} = {}\n",
                self.bin(dir),
                self.bin(dir),
                src(lib),
                src("nsh-core"),
                self.nsh.dep("nsh-base", HIGHLIGHT),
                src(platform),
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
        if path.exists() {
            return Ok(path);
        }
        // A cargo that keeps its own target directory (a wrapper ignoring
        // CARGO_TARGET_DIR) built it elsewhere: Cargo says where, or it is
        // the generated workspace's own `target` (a cargo that always uses
        // `./target`, whatever its metadata reports).
        Ok(cargo_target_directory(workspace)
            .into_iter()
            .chain([workspace.join("target")])
            .map(place)
            .find(|candidate| candidate.exists())
            .unwrap_or(path))
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
        let (workspace, features) = match platform {
            Platform::Gpui => (self.gpui_workspace()?, crate::runtime::gpui_features()),
            Platform::Tui => (self.tui_workspace()?, &[][..]),
            _ => (self.workspace.clone(), &[][..]),
        };
        let package = self.bin(name);
        let release = runner || RELEASE_HOSTS.load(std::sync::atomic::Ordering::Relaxed);
        let what = if release && !runner {
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
        self.build(&self.workspace, &self.bin(dir), triple, release, &[], &what)
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
    /// when the test session says so).
    pub(crate) fn test_android(&self, prebuilt: &Path) -> anyhow::Result<PathBuf> {
        self.android_runtime(prebuilt, true, false, &[])
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
            let features: &[&str] = if dev && !rust {
                &["--features", "dev"]
            } else {
                &[]
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
                what: &format!("libnsh.so of {} for {abi}", self.packages()),
            };
            let lib = self.build_with(sdk.ndk_cargo(triple)?, &build)?;
            let dir = out.join("lib").join(&abi);
            fs::create_dir_all(&dir)?;
            let dest = dir.join("libnsh.so");
            if dev {
                install(&lib, &dest)?;
            } else {
                // Without its symbol tables and debug info, which APKs
                // store uncompressed; `symbols/<abi>` keeps them, for
                // `ndk-stack` and Play Console.
                let symbols = out.join("symbols").join(&abi).join("libnsh.so");
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
                    format!(
                        "{} = {{ package = {:?}, path = {:?} }}",
                        c.name(),
                        c.package,
                        self.workspace
                            .join("app-crates")
                            .join(&c.package)
                            .to_string_lossy()
                    )
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

    /// The UI sets of a Rust app's web runtime: `nsh/base`'s core part
    /// only, then the app's ([`Self::sets`]). A Rust app runs no JS, so
    /// nothing makes a component by its registered name: its code makes
    /// each of `nsh/base`'s components by type (`nsh_base::button()`),
    /// which links that component's code where it is used. What the app
    /// needs of the set itself is the theme's tokens, which every set of
    /// `nsh/base` has, and the built-in scroll bars, the core part's.
    /// Registering every part would link every component into the module,
    /// the ones the app never makes included (`nsh_base::registry_of`).
    fn rust_web_sets(&self) -> String {
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
                 {ENTRY}() // the crate {} (nsh.json \"rust\")\n}}\n",
                krate.package,
                set_fn(krate),
                krate.name(),
                krate.package,
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
                 {entry}(__nsh_components); // the crate {} (nsh.json \"rust\")\n    }}\n",
                krate.name(),
                krate.package,
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
    if let Some(translations) = &root.translations {
        make.push_str(&format!(
            "\n        .translations_json(include_str!({:?}))",
            translations.to_string_lossy()
        ));
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

fn cargo() -> std::ffi::OsString {
    env::var_os("CARGO").unwrap_or_else(|| "cargo".into())
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

    use super::{AppCrate, Nsh, RootConfig, RustApp};

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
            .map(|(package, dir)| AppCrate {
                package: (*package).into(),
                dir: dir.clone(),
            })
            .collect();
        RustApp {
            workspace: dir.join(".nsh/rust"),
            nsh: Nsh::Source(Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")),
            watched: crates.iter().map(|c| c.dir.clone()).collect(),
            crates,
            root,
            retargeted: false,
            unify: true,
        }
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
                window: None,
                capabilities: None,
                translations: None,
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
                window: Some(
                    r#"{"defaultSize":{"width":900,"height":600},"title":"Notes"}"#.into(),
                ),
                capabilities: None,
                translations: None,
            },
        );
        for line in [
            "#[cfg(x)]\nfn app_root() -> nsh_core::element::Root {",
            "nsh_core::element::Root::of::<app_native::App>()",
            "include_str!(\"/app/theme.json\")",
            ".appearance(nsh_core::element::Appearance::Dark)",
            ".app_id(\"com.example.app\")",
            ".url_schemes([\"myapp\"])",
            ".status_bar(nsh_core::StatusBarSetting::default().foreground(nsh_core::StatusBarStyle::Light).hidden(false))",
            r#".main_window_json("{\"defaultSize\":{\"width\":900,\"height\":600},\"title\":\"Notes\"}")"#,
        ] {
            assert!(code.contains(line), "no {line:?} in\n{code}");
        }
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
                window: None,
                capabilities: None,
                translations: None,
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
        let android = read("rust-android/lib.rs");
        assert!(android.contains("nsh::main!(app_root());"), "{android}");
        assert!(read("rust-android/Cargo.toml").contains("default-features = false"));
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

    #[test]
    fn the_hack_names_what_describe_builds_with_its_resolved_features() {
        let metadata = serde_json::json!({
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
        });
        let hack = super::hack_dependencies(
            &metadata,
            "app-describe",
            "app-hack",
            "x86_64-unknown-linux-gnu",
        );
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
                    AppCrate {
                        package: (*package).into(),
                        dir: crate_dir,
                    }
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
        let crates = [AppCrate {
            package: "app-native".into(),
            dir: app.clone(),
        }];
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
    fn git_resolution_uses_patched_registry_dependencies_and_renamed_edges() {
        let mut dependencies = vec![serde_json::json!({
            "name": "nsh-core", "rename": "core_runtime", "req": "=0.1.1",
            "source": "registry+https://github.com/rust-lang/crates.io-index"
        })];
        let metadata = serde_json::json!({
            "packages": [
                {"name": "app-native", "id": "app"},
                {"name": "nsh-core", "id": "core",
                 "source": "git+https://example.com/nsh.git?branch=main#locked-revision",
                 "manifest_path": "/cargo/git/checkouts/nsh/locked/crates/nsh-core/Cargo.toml"}
            ],
            "resolve": {"nodes": [
                {"id": "app", "deps": [{"name": "core_runtime", "pkg": "core"}]}
            ]}
        });
        super::resolve_git_dependencies(&mut dependencies, &metadata, "app-native").unwrap();
        assert_eq!(dependencies[0]["git"], "https://example.com/nsh.git");
        assert_eq!(
            dependencies[0]["path"],
            "/cargo/git/checkouts/nsh/locked/crates/nsh-core"
        );
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
        let nsh = Nsh::of(&[AppCrate {
            package: "git-app".into(),
            dir: native.clone(),
        }])
        .unwrap();
        let Nsh::Git {
            checkout,
            url: resolved_url,
        } = &nsh
        else {
            panic!("Git dependencies must keep their resolved source: {nsh:?}");
        };
        assert_eq!(resolved_url, &url);
        assert_ne!(checkout, &repo);
        assert!(checkout.join("crates/nsh-core/Cargo.toml").is_file());
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
                window: None,
                capabilities: None,
                translations: None,
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
            // A Rust app's web runtime takes `nsh/base`'s core part only.
            let sets = if dir == "rust-web" {
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
                None => assert!(!code.contains("set_components"), "{dir}: {code}"),
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

    #[test]
    fn the_cli_reads_the_description_of_the_app_s_crates() {
        use nsh_core::element::description::{Description, SetDescription};
        let crates = |packages: &[&str]| -> Vec<AppCrate> {
            packages
                .iter()
                .map(|p| AppCrate {
                    package: (*p).into(),
                    dir: PathBuf::from("/app").join(p),
                })
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
}
