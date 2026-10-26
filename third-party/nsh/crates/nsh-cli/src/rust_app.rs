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
//! to that checkout. It builds in the app's own `target`, as a Cargo project in the app's
//! directory would, or in `CARGO_TARGET_DIR`.

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context as _, bail};
use nsh_core::ui::description::{Description, SetDescription};

use crate::{runtime::Platform, ui};

/// The function `#[native_module]` makes at the root of the app's crate
/// (`nsh-macros` `native_module.rs`): the crate's UI set.
const ENTRY: &str = "__nsh_native_module";

/// The app of this command, if it has Rust crates ([`set_current`]).
static CURRENT: std::sync::Mutex<Option<RustApp>> = std::sync::Mutex::new(None);

/// Set once a development session started again after a change to the
/// app's Rust code: a failed build then waits for the next change instead
/// of ending the session ([`RustApp::build_with`]).
static RESTARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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
/// changed: the command starts again (`main.rs` `run`).
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
    /// dependencies say (`cargo metadata --no-deps`): from crates.io, which
    /// must accept [`VERSION`], or by path from one checkout of that
    /// version. Git dependencies use Cargo's resolved checkout, including
    /// patched registry dependencies. Mixed sources, or another version,
    /// stop the command before a build fails on two `nsh-core`s.
    fn of(crates: &[AppCrate]) -> anyhow::Result<Nsh> {
        let wanted = semver::Version::parse(VERSION).context("nsh's own version")?;
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
                    None => {
                        if !semver::VersionReq::parse(req).is_ok_and(|r| r.matches(&wanted)) {
                            bail!(
                                "{} asks for {name} {req} and this nsh is {VERSION}: install nsh {req}, or ask for {name} = \"{VERSION}\"",
                                c.package
                            );
                        }
                        (
                            Nsh::Registry,
                            format!("{} takes {name} {req} from crates.io", c.package),
                        )
                    }
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
        if let Some(dir) = nsh.source() {
            let version = checkout_version(dir)?;
            if version != VERSION {
                bail!(
                    "the app's crates take nsh from {}, which is nsh {version}, and this nsh is {VERSION}: run the nsh built in that checkout",
                    dir.display()
                );
            }
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
}

/// Whether `entry` is a Rust app's (`entry::resolve` gives its `nsh.json`
/// when it declares a `"root"`): it runs with no JS.
pub(crate) fn is_root(entry: &Path) -> bool {
    entry
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("nsh.json"))
}

/// The `"rust"` crates of the app whose entry is `entry`, if it has any.
pub(crate) fn of(entry: &Path) -> anyhow::Result<Option<RustApp>> {
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
        nsh_base::Theme::from_json(&json).map_err(|e| anyhow::anyhow!("nsh.json: theme: {e}"))?;
    }
    let appearance = match config.get("appearance").and_then(|a| a.as_str()) {
        None | Some("system") => None,
        Some(a @ ("light" | "dark")) => Some(a.to_owned()),
        Some(other) => {
            bail!("nsh.json: appearance: {other:?} is not \"light\", \"dark\" or \"system\"")
        }
    };
    let status_bar = match config.get("statusBar") {
        None => None,
        Some(v) => {
            nsh_core::StatusBarSetting::from_json(v)
                .map_err(|e| anyhow::anyhow!("nsh.json: statusBar: {e}"))?;
            Some(v.to_string())
        }
    };
    Ok(RootConfig {
        component,
        theme,
        appearance,
        app_id: crate::package::app_id(&dir.join("nsh.json")).ok(),
        status_bar,
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
    "nsh-platform-ios",
    "nsh-platform-android",
    "nsh-platform-linux",
    "nsh-platform-macos",
    "nsh-platform-windows",
    "nsh-platform-web",
    "nsh-platform-tui",
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
    /// Its binaries' names, after the app (`nsh-app-gallery-native-cli`;
    /// the packages of all its crates: `nsh-app-charts-storage-cli`), so
    /// they do not clash with the app's own binaries in its `target`.
    fn bin(&self, what: &str) -> String {
        let packages: Vec<&str> = self.crates.iter().map(|c| c.package.as_str()).collect();
        format!("nsh-app-{}-{what}", packages.join("-"))
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
        for event in &rx {
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
        bail!("stopped watching the app's Rust code")
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
        // A Rust app's runners too (`nsh.json` "root"), only then: they
        // name its root component.
        let rust = if self.root.is_some() {
            ", \"rust-linux\", \"rust-macos\", \"rust-windows\", \"rust-ios\", \"rust-android\", \"rust-tui\", \"rust-web\""
        } else {
            ""
        };
        self.write_workspace_manifest(
            ws,
            &format!("# Generated by nsh for the app's Rust crate (nsh.json \"rust\"): do not edit.\n\
             [workspace]
resolver = \"3\"
members = [\"describe\", \"test\", \"ios-host\", \"ios-app\", \"macos-host\", \"macos-app\", \"linux-host\", \"linux-app\", \"windows-host\", \"windows-app\", \"tui-host\", \"tui-app\", \"android\", \"web\"{rust}]
# GPUI's hosts are a workspace of their own, written when they are built
# (`RustApp::gpui_workspace`): other builds never resolve GPUI's crates.
exclude = [\"gpui\"]

# The web runtime, as nsh builds its own (nsh's `Cargo.toml`): Rust for
# size, QuickJS at -O3.
[profile.web]
inherits = \"release\"
opt-level = \"z\"
lto = \"fat\"
codegen-units = 1
strip = true
panic = \"abort\"
[profile.web.package.quickjs-jit-sys]
opt-level = 3
"),
            false,
        )?;
        // What earlier versions of nsh wrote: the app's own command line,
        // the runners of the former `nsh trace`.
        for old in ["cli", "trace", "rust-trace"] {
            let _ = fs::remove_dir_all(ws.join(old));
        }
        let _ = fs::remove_file(ws.join("app.json"));
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
            ("tui-host", "nsh-tui-host", "development host"),
            ("tui-app", "nsh-tui-app", "release runner"),
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
        Ok(())
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
                 [[bin]]\nname = {:?}\npath = \"main.rs\"\n\n[dependencies]\nnsh-core = {}\n{}\n",
                self.bin("describe"),
                self.bin("describe"),
                self.nsh.dep("nsh-core", ""),
                self.dependencies(),
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
                 println!(\"{{}}\", nsh_core::ui::description::Description::of(&sets).to_json());\n}}\n{}",
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
                 nsh-core = {}\nnsh-testing = {}\nnsh-base = {}\n{}\n",
                self.bin("test"),
                self.bin("test"),
                self.nsh.dep("nsh-core", ""),
                self.nsh.dep("nsh-testing", ", features = [\"js\"]"),
                self.nsh.dep("nsh-base", ""),
                self.dependencies(),
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
                 nsh_testing::runner({}, {make_root})\n}}\n{}{root_fn}",
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
        for dir in [
            "rust-linux",
            "rust-macos",
            "rust-windows",
            "rust-ios",
            "rust-tui",
        ] {
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
                self.nsh
                    .dep("nsh-platform-android", ", default-features = false"),
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
        write(&ws.join("rust-web/build.rs"), WEB_BUILD_RS)?;
        write(
            &ws.join("rust-web/lib.rs"),
            &format!(
                "//! The Rust app's web runtime: its root, which `nsh.js` runs, with the\n\
                 //! `nsh/base` and the app's components; no QuickJS.\n\n\
                 {wasm}nsh_platform_web::rust_app!({sets}, app_root());\n\n\
                 // Off WebAssembly it is empty, as nsh-platform-web is.\n\
                 #[cfg(not(target_arch = \"wasm32\"))]\nuse nsh_core as _;\n\
                 #[cfg(not(target_arch = \"wasm32\"))]\nuse nsh_base as _;\n{}{}",
                self.app_sets(wasm),
                self.root_fn(wasm, root),
            ),
        )
    }

    /// Writes the crate `<ws>/<dir>` (`rust-linux`, `rust-macos`,
    /// `rust-windows`, `rust-ios`, `rust-tui`): the platform's release
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
            "rust-tui" => (
                "any(target_os = \"linux\", target_os = \"macos\", windows)",
                "nsh-tui-app",
                "nsh-platform-tui",
                true,
            ),
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
                self.nsh.dep(platform, ", default-features = false"),
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
        write(
            &ws.join(dir).join("main.rs"),
            &format!(
                "//! The Rust app's executable: its root with `nsh/base` and the app's\n\
                 //! components, on {lib}'s runner; no JS runtime.\n{subsystem}\n\
                 fn main(){ret} {{\n    \
                 #[cfg({os})]\n    {{\n        \
                 {platform}::set_ui_sets({sets});\n        \
                 {lib}::run_rust(app_root()){tail}\n    }}\n    \
                 #[cfg(not({os}))]\n    {lib}::main(){tail}\n}}\n{}{}",
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
                 [features]\n# The runtime of published apps: bytecode only (nsh-platform-web).\n\
                 bytecode-only = [\"nsh-platform-web/bytecode-only\"]\n\
                 # The development host's: what `nsh test --target web` asks about.\n\
                 dev = [\"nsh-platform-web/dev\"]\n\n\
                 [dependencies]\nnsh-core = {}\nnsh-base = {}\n{app}\n\n\
                 [target.'cfg(target_arch = \"wasm32\")'.dependencies]\nnsh-platform-web = {}\n",
                self.bin("web"),
                self.web_lib(),
                src("nsh-core"),
                self.nsh.dep("nsh-base", HIGHLIGHT),
                src("nsh-platform-web"),
            ),
        )?;
        // nsh's `.cargo/config.toml` gives its own web runtime this stack
        // (QuickJS recursion, deep component trees); the app's build does
        // not run under it, so this package passes the link argument.
        write(&ws.join("web/build.rs"), WEB_BUILD_RS)?;
        // A Rust app's root too, which the development host's page runs
        // when a test session says so (`nsh test --target web`).
        let (register, root) = match &self.root {
            Some(root) => (
                format!("nsh_platform_web::rust_app!({sets}, app_root());"),
                self.root_fn(wasm, root),
            ),
            None => (
                format!("nsh_platform_web::ui_sets!({sets});"),
                String::new(),
            ),
        };
        write(
            &ws.join("web/lib.rs"),
            &format!(
                "//! The app's web runtime: `nsh.wasm` with `nsh/base` and the app's\n//! Rust components.\n\n\
                 {wasm}{register}\n{}{root}\n\
                 // Off WebAssembly it is empty, as nsh-platform-web is.\n\
                 #[cfg(not(target_arch = \"wasm32\"))]\nuse nsh_core as _;\n\
                 #[cfg(not(target_arch = \"wasm32\"))]\nuse nsh_base as _;\n",
                self.app_sets(wasm)
            ),
        )
    }

    /// The web runtime's library name (its module is `<name>.wasm`),
    /// after the app as its binaries are ([`Self::bin`]).
    fn web_lib(&self) -> String {
        self.bin("web").replace('-', "_")
    }

    /// The app's web runtime of `kind` (its `nsh.wasm` / `nsh-dev.wasm`, and
    /// nsh's `nsh.js`), built for `wasm32-unknown-unknown` with the `web`
    /// profile as nsh builds its own (`runtime::web`). Without `build`, the
    /// one built before, if any.
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
        };
        if !build {
            return Ok((runtime.wasm.exists() && runtime.js.exists()).then_some(runtime));
        }
        let mut cmd = Command::new(cargo());
        // QuickJS' archive needs an `ar` that knows WebAssembly objects.
        let ar = format!("AR_{}", WASM.replace('-', "_"));
        if env::var_os(&ar).is_none() && env::var_os("AR").is_none() {
            cmd.env(&ar, "llvm-ar");
        }
        // A Rust app's runtime is one: no QuickJS, so neither the parser
        // nor hot updates.
        let features: &[&str] = match kind {
            _ if rust => &[],
            crate::runtime::WebKind::Release => &["--features", "bytecode-only"],
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
            profile: Some("web"),
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
            fs::copy(&js, &runtime.js)
                .with_context(|| format!("copy {} to {}", js.display(), runtime.js.display()))?;
        }
        Ok(Some(runtime))
    }

    /// The directory Cargo unpacked nsh's crate `name` (from crates.io, at
    /// [`VERSION`]) into for the workspace, as `cargo metadata` reports it.
    fn registry_crate(&self, name: &str) -> anyhow::Result<PathBuf> {
        let output = Command::new(cargo())
            .args(["metadata", "--format-version", "1", "--manifest-path"])
            .arg(self.workspace.join("Cargo.toml"))
            .output()
            .context("run cargo metadata")?;
        if !output.status.success() {
            bail!(
                "cargo metadata of {}:\n{}",
                self.workspace.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let metadata: serde_json::Value =
            serde_json::from_slice(&output.stdout).context("cargo metadata's output")?;
        metadata["packages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["name"].as_str() == Some(name) && p["version"].as_str() == Some(VERSION))
            .and_then(|p| {
                Path::new(p["manifest_path"].as_str()?)
                    .parent()
                    .map(Path::to_path_buf)
            })
            .with_context(|| format!("the workspace resolves no {name} {VERSION}"))
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
        } else if dir.starts_with("tui") {
            (
                "any(target_os = \"linux\", target_os = \"macos\", windows)",
                "terminal",
                "nsh-platform-tui",
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
        write(
            &ws.join(dir).join("Cargo.toml"),
            &format!(
                "[package]\nname = {:?}\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n\
                 [[bin]]\nname = {:?}\npath = \"main.rs\"\n\n[dependencies]\n{lib} = {}\nnsh-core = {}\nnsh-base = {}\n{app}\n\n\
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
            Some(root) if dir.ends_with("-host") && dir != "tui-host" => (
                format!("\n    #[cfg({os})]\n    {platform}::set_root(app_root);"),
                self.root_fn(&cfg, root),
            ),
            _ => (String::new(), String::new()),
        };
        write(
            &ws.join(dir).join("main.rs"),
            &format!(
                "//! The {name} {what} with `nsh/base` and the app's Rust components.\n{subsystem}\n\
                 fn main(){exit} {{\n    #[cfg({os})]\n    {platform}::set_ui_sets({sets});{set_root}\n    {lib}::main()\n}}\n{}{root_fn}",
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
        let suffix = if triple.is_none() {
            env::consts::EXE_SUFFIX
        } else {
            ""
        };
        let artifact = format!("{package}{suffix}");
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
        let mut path = self.target_dir()?;
        if let Some(triple) = triple {
            path.push(triple);
        }
        path.push(match profile {
            Some(profile) => profile,
            None if release => "release",
            None => "debug",
        });
        path.push(artifact);
        Ok(path)
    }

    /// The development host (`runner` false) or release runner of the app,
    /// built for `platform`.
    pub(crate) fn runtime(&self, platform: Platform, runner: bool) -> anyhow::Result<PathBuf> {
        if self.root.is_some() {
            return self.rust_runner(platform, runner);
        }
        self.host(platform, runner)
    }

    /// The development host `nsh test --target` runs the app in: a Rust
    /// app's too, built with its root (its runners have no dev server
    /// client), which it runs when the test session says so.
    pub(crate) fn test_host(&self, platform: Platform) -> anyhow::Result<PathBuf> {
        self.host(platform, false)
    }

    /// The development host (`runner` false) or release runner for
    /// `platform` with the app's crates.
    fn host(&self, platform: Platform, runner: bool) -> anyhow::Result<PathBuf> {
        let name = match (platform, runner) {
            (Platform::Linux, false) => "linux-host",
            (Platform::Linux, true) => "linux-app",
            (Platform::MacOs, false) => "macos-host",
            (Platform::MacOs, true) => "macos-app",
            (Platform::Windows, false) => "windows-host",
            (Platform::Windows, true) => "windows-app",
            (Platform::Gpui, false) => "gpui-host",
            (Platform::Gpui, true) => unreachable!("GPUI apps are embedded, never packaged"),
            (Platform::Tui, false) => "tui-host",
            (Platform::Tui, true) => "tui-app",
            (_, false) => "ios-host",
            (_, true) => "ios-app",
        };
        let what = platform.host(runner);
        let (workspace, features) = match platform {
            Platform::Gpui => (self.gpui_workspace()?, crate::runtime::gpui_features()),
            _ => (self.workspace.clone(), &[][..]),
        };
        let package = self.bin(name);
        self.build(
            &workspace,
            &package,
            platform.triple(),
            runner,
            features,
            &what,
        )
    }

    /// A Rust app's runner for `platform` (`rust-<platform>`): a release
    /// build for packages (`release`), a debug one for `nsh run`. Both run
    /// the app's root with no JS runtime.
    fn rust_runner(&self, platform: Platform, release: bool) -> anyhow::Result<PathBuf> {
        let dir = match platform {
            Platform::Linux => "rust-linux",
            Platform::MacOs => "rust-macos",
            Platform::Windows => "rust-windows",
            Platform::Tui => "rust-tui",
            Platform::Gpui => unreachable!("a Rust app does not run on GPUI's host"),
            Platform::IphoneOs | Platform::IphoneSimulator | Platform::MacCatalyst => "rust-ios",
        };
        let what = format!(
            "the {} runner of {}{}",
            match platform {
                Platform::Linux => "Linux",
                Platform::MacOs => "macOS",
                Platform::Windows => "Windows",
                Platform::Gpui => unreachable!(),
                Platform::Tui => "terminal",
                Platform::IphoneOs => "iOS",
                Platform::IphoneSimulator => "iOS simulator",
                Platform::MacCatalyst => "Mac Catalyst",
            },
            self.packages(),
            if release { "" } else { " (debug)" }
        );
        self.build(
            &self.workspace,
            &self.bin(dir),
            platform.triple(),
            release,
            &[],
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
    /// with the app's `libnsh.so` for each of its ABIs.
    pub(crate) fn android(&self, prebuilt: &Path, dev: bool) -> anyhow::Result<PathBuf> {
        self.android_runtime(prebuilt, dev, self.root.is_some())
    }

    /// The Android runtime `nsh test --target android` runs the app in: the
    /// development library, a Rust app's too (with its root, which it runs
    /// when the test session says so).
    pub(crate) fn test_android(&self, prebuilt: &Path) -> anyhow::Result<PathBuf> {
        self.android_runtime(prebuilt, true, false)
    }

    /// [`Self::android`]; `rust`: a Rust app's runner library, with no
    /// development support.
    fn android_runtime(&self, prebuilt: &Path, dev: bool, rust: bool) -> anyhow::Result<PathBuf> {
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
            install(&lib, &dir.join("libnsh.so"))?;
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

/// The `build.rs` of the web runtimes: the 8 MiB stack nsh's own has, and
/// QuickJS' local time from the page (`nsh-platform-web`'s `build.rs`).
const WEB_BUILD_RS: &str = "//! The web runtime's stack: 8 MiB, as nsh's own (`.cargo/config.toml`);\n\
    //! QuickJS' local time from the page, as nsh's own (`nsh-platform-web`'s `build.rs`).\n\n\
    fn main() {\n    if std::env::var(\"CARGO_CFG_TARGET_ARCH\").as_deref() == Ok(\"wasm32\") {\n        \
    println!(\"cargo:rustc-link-arg=-zstack-size=8388608\");\n        \
    println!(\"cargo:rustc-link-arg=--wrap=localtime_r\");\n    }\n}\n";

impl RustApp {
    /// The `[dependencies]` lines of its crates, for a generated crate.
    fn dependencies(&self) -> String {
        let lines: Vec<String> = self.crates.iter().map(AppCrate::dependency).collect();
        lines.join("\n")
    }

    /// The UI sets of the generated code: `nsh/base`, then the app's, one per
    /// crate ([`Self::app_sets`]).
    fn sets(&self) -> String {
        let mut sets = vec!["nsh_base::registry()".to_owned()];
        sets.extend(self.crates.iter().map(|c| format!("{}()", set_fn(c))));
        format!("vec![{}]", sets.join(", "))
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
                 {cfg}fn {}() -> nsh_core::ui::Registry {{\n    \
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
             {cfg}#[allow(unused_imports)]\nuse nsh_core::ui::__private::no_native_module as {ENTRY};\n"
        ));
        code
    }

    /// `app_root()`, a Rust app's root (`nsh.json` `"root"`, `"theme"`,
    /// `"appearance"`, `"statusBar"`: a component of the first crate `"rust"` lists), for
    /// the generated code, under `cfg`.
    fn root_fn(&self, cfg: &str, root: &RootConfig) -> String {
        let krate = self.crates.first().map(AppCrate::name).unwrap_or_default();
        root_fn(cfg, &krate, root)
    }
}

/// The function of the generated code that makes the UI set of `krate`
/// ([`RustApp::app_sets`]).
fn set_fn(krate: &AppCrate) -> String {
    format!("set_{}", krate.name())
}

/// `app_root()`, a Rust app's root (`nsh.json` `"root"`, `"theme"`,
/// `"appearance"`, `"statusBar"`, `"id"`) in the crate the generated code links as `krate`, under
/// `cfg`.
fn root_fn(cfg: &str, krate: &str, root: &RootConfig) -> String {
    let mut make = format!("nsh_core::ui::Root::of::<{krate}::{}>()", root.component);
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
    if let Some(appearance) = &root.appearance {
        let variant = if appearance == "dark" {
            "Dark"
        } else {
            "Light"
        };
        make.push_str(&format!(
            "\n        .appearance(nsh_core::ui::Appearance::{variant})"
        ));
    }
    if let Some(setting) = root
        .status_bar
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok())
        .and_then(|v| nsh_core::StatusBarSetting::from_json(&v).ok())
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
    format!(
        "\n/// The app's root (`nsh.json` `\"root\"`), with its theme, appearance and\n\
         /// status bar.\n\
         {cfg}fn app_root() -> nsh_core::ui::Root {{\n    {make}\n}}\n"
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
    let modified = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
    if modified(to).is_some() && modified(to) >= modified(from) {
        return Ok(());
    }
    fs::copy(from, to).with_context(|| format!("copy {} to {}", from.display(), to.display()))?;
    Ok(())
}

/// The cargo to run.
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

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{AppCrate, Nsh, RootConfig, RustApp};

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
        }
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
            "use nsh_core::ui::prelude::*;\n\n#[nsh_core::ui::native_module( \"app/storage\" )]\nfn native(r: &mut Registry) {}\n",
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
        assert!(
            super::root_config(
                &dir,
                &config(r#"{ "root": "App", "appearance": "dim" }"#),
                &ws
            )
            .is_err()
        );
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
        for (bad, message) in [
            (r#""light""#, "nsh.json: statusBar: expected an object"),
            (
                r#"{ "foreground": "dim" }"#,
                "nsh.json: statusBar: foreground: \"dim\" is not",
            ),
            (
                r#"{ "hidden": "yes" }"#,
                "nsh.json: statusBar: hidden: \"yes\" is not true or false",
            ),
            (
                r#"{ "style": "light" }"#,
                "nsh.json: statusBar: unknown key \"style\"",
            ),
        ] {
            let json = format!(r#"{{ "root": "App", "statusBar": {bad} }}"#);
            let err = super::root_config(&dir, &config(&json), &ws)
                .unwrap_err()
                .to_string();
            assert!(err.starts_with(message), "{err}");
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
            },
        );
        for line in [
            "#[cfg(x)]\nfn app_root() -> nsh_core::ui::Root {",
            "nsh_core::ui::Root::of::<app_native::App>()",
            "include_str!(\"/app/theme.json\")",
            ".appearance(nsh_core::ui::Appearance::Dark)",
            ".app_id(\"com.example.app\")",
            ".status_bar(nsh_core::StatusBarSetting::default().foreground(nsh_core::StatusBarStyle::Light).hidden(false))",
        ] {
            assert!(code.contains(line), "no {line:?} in\n{code}");
        }
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
            }),
        );
        app.write_workspace().unwrap();
        let read = |file: &str| std::fs::read_to_string(app.workspace.join(file)).unwrap();
        let manifest = read("Cargo.toml");
        assert!(manifest.contains("\"rust-linux\", \"rust-macos\", \"rust-windows\", \"rust-ios\", \"rust-android\", \"rust-tui\", \"rust-web\"]"), "{manifest}");
        for (dir, lib, platform) in [
            ("rust-linux", "nsh-linux-app", "nsh-platform-linux"),
            ("rust-macos", "nsh-macos-app", "nsh-platform-macos"),
            ("rust-windows", "nsh-windows-app", "nsh-platform-windows"),
            ("rust-ios", "nsh-ios-app", "nsh-platform-ios"),
            ("rust-tui", "nsh-tui-app", "nsh-platform-tui"),
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
                main.contains("nsh_core::ui::Root::of::<app_app_native::App>()"),
                "{main}"
            );
        }
        // Optional platform features come from the app, not its runner.
        assert!(!read("rust-linux/Cargo.toml").contains("webview"));
        assert!(!read("rust-tui/main.rs").contains("windows_subsystem"));
        let android = read("rust-android/lib.rs");
        assert!(android.contains("nsh::main!(app_root());"), "{android}");
        assert!(read("rust-android/Cargo.toml").contains("default-features = false"));
        let web = read("rust-web/lib.rs");
        assert!(web.contains("nsh_platform_web::rust_app!(vec![nsh_base::registry(), set_app_app_native()], app_root());"), "{web}");
        assert!(read("rust-web/Cargo.toml").contains("default-features = false"));
        assert!(read("rust-web/build.rs").contains("-zstack-size=8388608"));
        // Its headless runner opens the root for the tests.
        let test = read("test/main.rs");
        assert!(test.contains("nsh_testing::runner(vec![nsh_base::registry(), set_app_app_native()], Some(app_root))"), "{test}");
        assert!(
            test.contains("nsh_core::ui::Root::of::<app_app_native::App>()"),
            "{test}"
        );
        assert!(manifest.contains("\"rust-web\"]"), "{manifest}");
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
                main.contains("nsh_core::ui::Root::of::<app_app_native::App>()"),
                "{main}"
            );
        }
        assert!(!read("macos-app/main.rs").contains("set_root"));
        // The terminal host has no test agent; Rust terminal apps use
        // their `rust-tui` runner instead.
        assert!(!read("tui-host/main.rs").contains("set_root"));
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
            "tui-host/Cargo.toml",
            "tui-app/Cargo.toml",
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
        // Another version: the error says what to do.
        let error = of(&[("a", "nsh-base = \"=0.0.1\"\n".into())]).unwrap_err();
        assert!(error.contains("a asks for nsh-base =0.0.1"), "{error}");
        assert!(error.contains(&format!("nsh-base = \"{this}\"")), "{error}");
        // By path: the checkout the crates are in, GPUI's a level deeper.
        let source = Ok(Nsh::Source(checkout.clone()));
        assert_eq!(of(&[("a", by_path("nsh-core"))]), source);
        let gpui = by_path("gpui/nsh-platform-gpui")
            .replace("gpui/nsh-platform-gpui =", "nsh-platform-gpui =");
        assert_eq!(
            of(&[("a", format!("{}{gpui}", by_path("nsh-base")))]),
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
        assert!(manifest.contains("exclude = [\"gpui\"]"), "{manifest}");
        // The web runtime is built as nsh builds its own.
        assert!(manifest.contains("\"web\"]"), "{manifest}");
        assert!(manifest.contains("[profile.web]"), "{manifest}");
        let web = read("web/Cargo.toml");
        assert!(web.contains("crate-type = [\"cdylib\"]"), "{web}");
        assert!(web.contains("name = \"nsh_app_app_native_web\""), "{web}");
        assert!(
            web.contains("bytecode-only = [\"nsh-platform-web/bytecode-only\"]"),
            "{web}"
        );
        let build = read("web/build.rs");
        assert!(build.contains("-zstack-size=8388608"), "{build}");
        // QuickJS' local time comes from the page (`__wrap_localtime_r`).
        assert!(build.contains("--wrap=localtime_r"), "{build}");
        assert!(read("web/lib.rs").contains("nsh_platform_web::ui_sets!("));
        assert!(!app.workspace.join("gpui").exists());
        assert_eq!(app.gpui_workspace().unwrap(), app.workspace.join("gpui"));
        assert!(read("gpui/Cargo.toml").contains("members = [\"gpui-host\"]"));
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
                "tui-host/main.rs",
                "#[cfg(any(target_os = \"linux\", target_os = \"macos\", windows))]\n",
            ),
            (
                "tui-app/main.rs",
                "#[cfg(any(target_os = \"linux\", target_os = \"macos\", windows))]\n",
            ),
            (
                "gpui/gpui-host/main.rs",
                "#[cfg(any(target_os = \"linux\", target_os = \"macos\", windows))]\n",
            ),
            ("android/lib.rs", "#[cfg(target_os = \"android\")]\n"),
            ("web/lib.rs", "#[cfg(target_arch = \"wasm32\")]\n"),
        ] {
            let code = read(file);
            for line in [
                "vec![nsh_base::registry(), set_app_app_native()]".to_owned(),
                format!(
                    "{cfg}fn set_app_app_native() -> nsh_core::ui::Registry {{\n    #[allow(unused_imports)]\n    use app_app_native::*;\n    __nsh_native_module() // the crate app-native (nsh.json \"rust\")\n}}"
                ),
                format!(
                    "{cfg}#[allow(unused_imports)]\nuse nsh_core::ui::__private::no_native_module as __nsh_native_module;"
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
            "tui-host",
            "tui-app",
            "gpui/gpui-host",
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
            "tui-host",
            "tui-app",
            "gpui/gpui-host",
            "android",
            "web",
            "rust-linux",
            "rust-macos",
            "rust-windows",
            "rust-ios",
            "rust-tui",
            "rust-android",
            "rust-web",
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
            let file = if dir == "android" || dir.ends_with("web") || dir == "rust-android" {
                "lib.rs"
            } else {
                "main.rs"
            };
            let code = read(&format!("{dir}/{file}"));
            assert!(code.contains(sets), "{dir}: no {sets:?} in\n{code}");
            // Each crate's entry in its own function; one stand-in.
            for (name, package) in [("app_charts", "charts"), ("app_app_storage", "app-storage")] {
                let set = format!(
                    "fn set_{name}() -> nsh_core::ui::Registry {{\n    #[allow(unused_imports)]\n    use {name}::*;\n    __nsh_native_module() // the crate {package} (nsh.json \"rust\")\n}}"
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
                    code.contains("nsh_core::ui::Root::of::<app_charts::shell::Home>()"),
                    "{dir}: {code}"
                );
            }
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
        assert!(manifest.contains("name = \"nsh-app-charts-app-storage-describe\""));
        // Named after all its crates: another app's crates build apart.
        assert!(read("test/Cargo.toml").contains("name = \"nsh-app-charts-app-storage-test\""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_cli_reads_the_description_of_the_app_s_crates() {
        use nsh_core::ui::description::{Description, SetDescription};
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
            nsh_core::ui::Registry::ui_set(specifier).into()
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
        for nsh in ["nsh/base", "nsh", "nsh/image"] {
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
}
