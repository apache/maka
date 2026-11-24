//! nshm (NSH modules): packages that extend Native Shell apps, as crates
//! extend Rust programs. An app lists them in `nsh.json` `"dependencies"`
//! by package name; `nsh add`, `nsh remove` and `nsh upgrade` edit that
//! list:
//!
//! ```json
//! { "dependencies": {
//!   "nsh-omarchy": "^0.3",
//!   "nsh-extra": { "version": "^0.6", "features": ["camera"] },
//!   "acme-ui": { "github": "acme/ui", "version": "^1.4" },
//!   "my-gauge": { "path": "../my-gauge" }
//! } }
//! ```
//!
//! Two kinds, one model ([`manifest`]):
//!
//! - A **Rust nshm** is a Cargo library with a `#[native_module]` at its
//!   root, published on crates.io (or Git). It is linked into the app's
//!   hosts like the app's own crates ([`crate::rust_app`]), so the app then
//!   builds with Rust.
//! - A **TSX nshm** is TSX in a Git repository (versions are its tags,
//!   `v1.4.0`), described by its `nsh.json` `"exports"`. The bundler
//!   compiles it into the app's bundle (`nsh_bundler::nshm`): no Rust, and
//!   it ships in the app's packages and over-the-air updates.
//!
//! An nshm may be both, depend on other nshm (its own `"dependencies"`) and
//! provide a target (`"platform"`, [`platform_program`]).
//!
//! [`resolve`] settles one version of each package, transitively, and
//! `nsh.lock` beside `nsh.json` pins it (the app commits both); a build
//! takes only what the lock pins. Each version is installed once in
//! `~/.nsh/nshms/` ([`fetch`]) and shared by every app on the machine.

mod cargo_toml;
mod dep;
mod fetch;
mod manifest;
mod resolve;

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context as _, bail};
pub(crate) use cargo_toml::relative;
pub(crate) use dep::Added;
use dep::{Dep, Origin};
use resolve::{Lock, Resolved};

use crate::rust_app::{self, AppCrate};

/// The lock file beside `nsh.json`.
pub(crate) const LOCK: &str = nsh_bundler::nshm::LOCK;

/// A Cargo-style status line on stderr: `    Updating crates.io index`.
pub(crate) fn status(verb: &str, what: impl std::fmt::Display) {
    crate::ui::plain(format!(
        "{} {what}",
        crate::ui::green(format!("{verb:>12}"))
    ));
}

/// A status line to heed, in the same column: `        Note …`.
fn notice(verb: &str, what: impl std::fmt::Display) {
    crate::ui::plain(format!(
        "{} {what}",
        crate::ui::yellow(format!("{verb:>12}"))
    ));
}

/// Where nshm are installed.
fn root() -> anyhow::Result<PathBuf> {
    nsh_bundler::nshm::installed_dir().context("no home directory to install nshm in: set NSH_HOME")
}

/// The app's nshm, resolved where the lock no longer fits, installed and
/// locked (`nsh.lock` written when it changed). `config` is the `nsh.json`
/// in `dir`.
fn ensure(dir: &Path, config: &serde_json::Value) -> anyhow::Result<Vec<Resolved>> {
    let deps = dep::read_all(config)?;
    let lock = Lock::read(dir)?;
    if deps.is_empty() && lock.packages.is_empty() {
        return Ok(Vec::new());
    }
    let mut net = fetch::Net::new(root()?);
    let resolved = resolve::resolve(dir, &deps, &lock, &|_| false, &mut net)?;
    write_lock(dir, &lock, &resolved)?;
    Ok(resolved)
}

/// Writes the lock of `resolved` when it differs from `old`.
fn write_lock(dir: &Path, old: &Lock, resolved: &[Resolved]) -> anyhow::Result<()> {
    let new = Lock::of(resolved);
    if new != *old || !dir.join(LOCK).is_file() {
        if new.packages.is_empty() && !dir.join(LOCK).is_file() {
            return Ok(());
        }
        new.write(dir)?;
    }
    Ok(())
}

/// The id the generated workspace patches a Rust nshm by
/// ([`patch_table`]): its URL, its crate's name or its directory.
fn patch_id(r: &Resolved) -> String {
    match &r.origin {
        Origin::Registry => r.locked.name.clone(),
        Origin::Git { url, .. } => url.clone(),
        Origin::Path(p) => p.clone(),
    }
}

/// The Rust nshm of the app in `dir` (`config` its `nsh.json`), each
/// installed at its locked version, with how the workspace patches it: its
/// TSX nshm are the bundler's. Resolved and locked first where needed.
pub(crate) fn crates(
    dir: &Path,
    config: &serde_json::Value,
) -> anyhow::Result<Vec<(String, AppCrate)>> {
    let deps = dep::read_all(config)?;
    let resolved = ensure(dir, config)?;
    Ok(rust_crates(&resolved, &deps))
}

fn rust_crates(resolved: &[Resolved], deps: &[Dep]) -> Vec<(String, AppCrate)> {
    resolved
        .iter()
        .filter(|r| r.manifest.module.is_some())
        .map(|r| {
            let features = deps
                .iter()
                .find(|d| d.name == r.locked.name)
                .map(|d| d.features.clone())
                .unwrap_or_default();
            let krate = AppCrate::new(r.locked.name.clone(), r.dir.clone()).with_features(features);
            (patch_id(r), krate)
        })
        .collect()
}

/// The `[patch]` table that sends the app's dependency on the nshm
/// named `id` (as [`crates`] names it) to its installed copy:
/// `Some(Some(url))` for Git, `Some(None)` for crates.io, `None` for a
/// directory, which the app's crate takes as it is.
pub(crate) fn patch_table(id: &str) -> Option<Option<&str>> {
    if id.contains("://") || id.starts_with("git@") || id.ends_with(".git") {
        Some(Some(id))
    } else if id.contains(['/', '\\', '.']) {
        None
    } else {
        Some(None)
    }
}

/// The app `nsh add` run in `dir` adds to: the nearest directory, `dir`
/// or one above it, with `nsh.json` (as `cargo add` finds `Cargo.toml`).
fn app_dir(dir: &Path) -> anyhow::Result<PathBuf> {
    dir.ancestors()
        .find(|d| d.join("nsh.json").is_file())
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "this command works on an NSH app, but neither {} nor a directory above it \
                 has nsh.json; run it in the app's directory, or create an app first with \
                 `nsh init`",
                dir.display()
            )
        })
}

/// The app's files a command changes, put back when it fails.
struct Backup {
    files: Vec<(PathBuf, Option<String>)>,
}

impl Backup {
    fn of(paths: &[PathBuf]) -> Self {
        Backup {
            files: paths
                .iter()
                .map(|p| (p.clone(), fs::read_to_string(p).ok()))
                .collect(),
        }
    }

    fn add(&mut self, path: &Path) {
        if !self.files.iter().any(|(p, _)| p == path) {
            self.files
                .push((path.to_owned(), fs::read_to_string(path).ok()));
        }
    }

    fn restore(&self) -> anyhow::Result<()> {
        for (path, text) in &self.files {
            match text {
                Some(text) => fs::write(path, text)?,
                None => {
                    let _ = fs::remove_file(path);
                }
            }
        }
        Ok(())
    }
}

/// An app: its directory and `nsh.json`.
struct App {
    dir: PathBuf,
    config: serde_json::Value,
}

impl App {
    fn open(cwd: &Path) -> anyhow::Result<Self> {
        let dir = app_dir(cwd)?;
        let path = dir.join("nsh.json");
        let text =
            fs::read_to_string(&path).with_context(|| format!("can't read {}", path.display()))?;
        let config = serde_json::from_str(&text).context("nsh.json is not JSON")?;
        Ok(App { dir, config })
    }

    /// Writes `deps` as its `"dependencies"`, keeping the order of those
    /// it had.
    fn write_dependencies(&mut self, deps: &[Dep]) -> anyhow::Result<()> {
        let mut map = serde_json::Map::new();
        for d in deps {
            if map.insert(d.name.clone(), d.value()).is_some() {
                bail!("nsh.json: dependencies: {} twice", d.name);
            }
        }
        let object = self
            .config
            .as_object_mut()
            .context("nsh.json is not an object")?;
        if map.is_empty() {
            object.remove("dependencies");
        } else {
            object.insert("dependencies".into(), map.into());
        }
        fs::write(
            self.dir.join("nsh.json"),
            serde_json::to_string_pretty(&self.config)? + "\n",
        )?;
        Ok(())
    }

    /// The directory of its own crate (the first of `"rust"`), if any.
    fn own_crate(&self) -> anyhow::Result<Option<PathBuf>> {
        let first = match self.config.get("rust") {
            Some(serde_json::Value::String(p)) => Some(p.clone()),
            Some(serde_json::Value::Array(ps)) => {
                ps.first().and_then(|p| p.as_str()).map(str::to_owned)
            }
            _ => None,
        };
        first
            .map(|p| {
                dunce::canonicalize(self.dir.join(&p))
                    .with_context(|| format!("nsh.json: \"rust\": no crate at {p}"))
            })
            .transpose()
    }

    /// Its own crates, named by their paths.
    fn own_crates(&self) -> anyhow::Result<Vec<(String, AppCrate)>> {
        let paths: Vec<String> = match self.config.get("rust") {
            Some(serde_json::Value::String(p)) => vec![p.clone()],
            Some(serde_json::Value::Array(ps)) => ps
                .iter()
                .filter_map(|p| p.as_str().map(str::to_owned))
                .collect(),
            _ => Vec::new(),
        };
        paths
            .into_iter()
            .map(|path| {
                let dir = dunce::canonicalize(self.dir.join(&path))
                    .with_context(|| format!("nsh.json: \"rust\": no crate at {path}"))?;
                let package = rust_app::package_name(&dir.join("Cargo.toml"))?;
                Ok((path, AppCrate::new(package, dir)))
            })
            .collect()
    }
}

/// Makes the app's own crate depend on the Rust nshm `r` (`use acme_ui::Gauge`)
/// with `features`, as `cargo add` would; nothing when the app has no crate.
fn depend_from_own_crate(
    app: &App,
    backup: &mut Backup,
    r: &Resolved,
    features: &[String],
) -> anyhow::Result<()> {
    let Some(crate_dir) = app.own_crate()? else {
        return Ok(());
    };
    let manifest = crate_dir.join("Cargo.toml");
    let place = match (&r.origin, &r.locked.commit) {
        (Origin::Git { url, .. }, Some(commit)) => cargo_toml::Place::Git {
            url: url.clone(),
            commit: commit.clone(),
        },
        (Origin::Registry, _) => cargo_toml::Place::Crate {
            version: r.locked.version.clone(),
        },
        _ => cargo_toml::Place::Path {
            path: relative(&crate_dir, &r.dir),
        },
    };
    let dependency = cargo_toml::Dependency {
        place,
        features: features.to_vec(),
    };
    let text = fs::read_to_string(&manifest)?;
    backup.add(&manifest);
    if let Some(new) = cargo_toml::with_dependency(&text, &r.locked.name, &dependency)? {
        fs::write(&manifest, new)?;
    }
    Ok(())
}

/// Says the app needs Rust now, when its nshm bring Rust in, it has no
/// crate of its own and `lock` (before the change) had no Rust nshm.
fn say_rust_needed(app: &App, lock: &Lock, resolved: &[Resolved]) {
    if app.config.get("rust").is_some() || lock.packages.iter().any(|p| p.module.is_some()) {
        return;
    }
    let rust: Vec<&str> = resolved
        .iter()
        .filter(|r| r.manifest.module.is_some())
        .map(|r| r.locked.name.as_str())
        .collect();
    if !rust.is_empty() {
        notice(
            "Note",
            format!(
                "{} {} Rust, so this app now builds with the Rust toolchain (https://rustup.rs)",
                rust.join(", "),
                if rust.len() == 1 { "has" } else { "have" },
            ),
        );
    }
}

/// Checks the app's crates and its Rust nshm together: a clash of
/// packages or modules is reported here, before a build.
fn check_rust(app: &App, resolved: &[Resolved], deps: &[Dep]) -> anyhow::Result<()> {
    let mut all = app.own_crates()?;
    all.extend(rust_crates(resolved, deps));
    if all.len() > 1 {
        rust_app::check_crates(&all)?;
    }
    Ok(())
}

/// `nsh add`: lists the nshm `added` in the `nsh.json` of the app in or
/// above `cwd` (replacing an entry of the same package, whose features it
/// keeps), resolves and locks it anew, and makes the app's own crate
/// depend on it when it has Rust. On an error the app's files are left as
/// they were.
pub(crate) fn add(cwd: &Path, added: Added) -> anyhow::Result<()> {
    let mut app = App::open(cwd)?;
    let mut backup = Backup::of(&[app.dir.join("nsh.json"), app.dir.join(LOCK)]);
    let result = add_to(&mut app, &mut backup, added);
    if result.is_err() {
        backup.restore()?;
    }
    result.map_err(|e| e.context(format!("nsh add: nsh.json and {LOCK} are unchanged")))
}

fn add_to(app: &mut App, backup: &mut Backup, added: Added) -> anyhow::Result<()> {
    let mut net = fetch::Net::new(root()?);
    let mut req = added.req.clone();
    // Its package's name: crates.io's, else what the nshm says it is.
    let name = match (&added.name, &added.origin) {
        (Some(name), _) => name.clone(),
        (None, Origin::Path(p)) => {
            let dir = dunce::canonicalize(app.dir.join(p))
                .with_context(|| format!("no directory {p}"))?;
            manifest::Manifest::read(&dir, p)?.name
        }
        (None, origin) => {
            use fetch::Fetch as _;
            let candidates = net.candidates("", origin)?;
            let wanted = semver::VersionReq::parse(req.as_deref().unwrap_or("*"))?;
            let candidate = candidates
                .iter()
                .filter(|c| c.version.as_ref().is_none_or(|v| wanted.matches(v)))
                .max_by(|a, b| a.version.cmp(&b.version))
                .with_context(|| format!("no version of {} matches {wanted}", origin.describe()))?
                .clone();
            let rel = net.install("", origin, &candidate)?;
            let m = manifest::Manifest::read(&net.root().join(rel), &origin.describe())?;
            m.name
        }
    };
    let mut deps = dep::read_all(&app.config)?;
    let features = match deps.iter().find(|d| d.name == name) {
        Some(listed) => {
            let mut f = listed.features.clone();
            for x in &added.features {
                if !f.contains(x) {
                    f.push(x.clone());
                }
            }
            f
        }
        None => added.features.clone(),
    };
    let dep = Dep {
        name: name.clone(),
        origin: added.origin.clone(),
        req: req.clone(),
        features: features.clone(),
    }
    .with_features(Vec::new())?;
    match deps.iter_mut().find(|d| d.name == name) {
        Some(listed) => *listed = dep,
        None => deps.push(dep),
    }
    let lock = Lock::read(&app.dir)?;
    // `nsh add` again: resolved anew, the newest its requirement accepts.
    let resolved = resolve::resolve(&app.dir, &deps, &lock, &|n| n == name, &mut net)?;
    let this = resolved
        .iter()
        .find(|r| r.locked.name == name)
        .context("the nshm is not resolved")?
        .clone();
    // Listed without a version: what it resolved to, as `cargo add`
    // writes `^0.3.2`. A commit has no version to require.
    let versioned = match &this.origin {
        Origin::Registry => true,
        Origin::Git { .. } => this
            .dir
            .file_name()
            .is_some_and(|n| n.to_string_lossy() == this.locked.version),
        Origin::Path(_) => false,
    };
    if req.is_none() && versioned {
        req = Some(format!("^{}", this.locked.version));
        if let Some(listed) = deps.iter_mut().find(|d| d.name == name) {
            listed.req = req.clone();
        }
    }
    if !added.features.is_empty() {
        if this.manifest.module.is_none() {
            bail!("{name} has no Rust, so no Cargo features to turn on");
        }
        let known = cargo_toml::crate_features(&this.dir)?;
        if let Some(unknown) = added.features.iter().find(|f| !known.contains(f)) {
            bail!(
                "`{unknown}` is not a feature of {name} (its features: {})",
                if known.is_empty() {
                    "none".to_owned()
                } else {
                    known.join(", ")
                }
            );
        }
    }
    check_rust(app, &resolved, &deps)?;
    app.write_dependencies(&deps)?;
    write_lock(&app.dir, &lock, &resolved)?;
    if this.manifest.module.is_some() {
        depend_from_own_crate(app, backup, &this, &features)?;
    }
    let from = match &this.origin {
        Origin::Path(p) => p.clone(),
        other => other.describe(),
    };
    status(
        "Added",
        format!("{name} v{} ({from}) to dependencies", this.locked.version),
    );
    let specifiers: Vec<String> = this
        .manifest
        .module
        .iter()
        .chain(this.manifest.exports.keys())
        .map(|s| format!("\"{s}\""))
        .collect();
    if !specifiers.is_empty() {
        status("Import", format!("from {}", specifiers.join(", ")));
    }
    say_rust_needed(app, &lock, &resolved);
    Ok(())
}

/// `nsh remove`: takes the nshm `names` out of the app's `nsh.json` (and
/// its own crate's `[dependencies]`), and locks what is left.
pub(crate) fn remove(cwd: &Path, names: &[String]) -> anyhow::Result<()> {
    let mut app = App::open(cwd)?;
    let mut backup = Backup::of(&[app.dir.join("nsh.json"), app.dir.join(LOCK)]);
    let result = (|| {
        let mut deps = dep::read_all(&app.config)?;
        for name in names {
            if !deps.iter().any(|d| &d.name == name) {
                let listed: Vec<&str> = deps.iter().map(|d| d.name.as_str()).collect();
                bail!(
                    "{name} is not a dependency of the app (its dependencies: {})",
                    if listed.is_empty() {
                        "none".to_owned()
                    } else {
                        listed.join(", ")
                    }
                );
            }
        }
        let lock = Lock::read(&app.dir)?;
        deps.retain(|d| !names.contains(&d.name));
        let mut net = fetch::Net::new(root()?);
        let resolved = resolve::resolve(&app.dir, &deps, &lock, &|_| false, &mut net)?;
        app.write_dependencies(&deps)?;
        write_lock(&app.dir, &lock, &resolved)?;
        if let Some(crate_dir) = app.own_crate()? {
            let manifest = crate_dir.join("Cargo.toml");
            for name in names {
                let rust = lock
                    .packages
                    .iter()
                    .any(|p| &p.name == name && p.module.is_some());
                // Unless another nshm still brings it in.
                let still = resolved.iter().any(|r| &r.locked.name == name);
                if rust && !still {
                    let text = fs::read_to_string(&manifest)?;
                    if let Some(new) = cargo_toml::without_dependency(&text, name) {
                        backup.add(&manifest);
                        fs::write(&manifest, new)?;
                    }
                }
            }
        }
        for name in names {
            status("Removed", name);
        }
        anyhow::Ok(())
    })();
    if result.is_err() {
        backup.restore()?;
    }
    result
}

/// `nsh upgrade`: resolves the nshm `names` (every one when empty) anew,
/// to the newest versions the app's and the nshm's requirements accept,
/// and locks them.
pub(crate) fn upgrade(cwd: &Path, names: &[String]) -> anyhow::Result<()> {
    let app = App::open(cwd)?;
    let mut backup = Backup::of(&[app.dir.join(LOCK)]);
    let result = (|| {
        let deps = dep::read_all(&app.config)?;
        let lock = Lock::read(&app.dir)?;
        for name in names {
            if !lock.packages.iter().any(|p| &p.name == name)
                && !deps.iter().any(|d| &d.name == name)
            {
                bail!("{name} is not an nshm of the app");
            }
        }
        let mut net = fetch::Net::new(root()?);
        let resolved = resolve::resolve(
            &app.dir,
            &deps,
            &lock,
            &|n| names.is_empty() || names.iter().any(|x| x == n),
            &mut net,
        )?;
        check_rust(&app, &resolved, &deps)?;
        write_lock(&app.dir, &lock, &resolved)?;
        let mut changed = false;
        for r in &resolved {
            let old = lock.packages.iter().find(|p| p.name == r.locked.name);
            match old {
                Some(old) if old.version == r.locked.version && old.commit == r.locked.commit => {}
                Some(old) => {
                    changed = true;
                    status(
                        "Upgrading",
                        format!(
                            "{} v{} -> v{}",
                            r.locked.name, old.version, r.locked.version
                        ),
                    );
                }
                None => {
                    changed = true;
                    status("Adding", format!("{} v{}", r.locked.name, r.locked.version));
                }
            }
            // The app's crate takes the new version too.
            if r.manifest.module.is_some()
                && deps.iter().any(|d| d.name == r.locked.name)
                && old.is_some_and(|o| o.version != r.locked.version || o.commit != r.locked.commit)
            {
                let features = deps
                    .iter()
                    .find(|d| d.name == r.locked.name)
                    .map(|d| d.features.clone())
                    .unwrap_or_default();
                depend_from_own_crate(&app, &mut backup, r, &features)?;
            }
        }
        for old in &lock.packages {
            if !resolved.iter().any(|r| r.locked.name == old.name) {
                changed = true;
                status("Removing", format!("{} v{}", old.name, old.version));
            }
        }
        if !changed {
            status(
                "Locked",
                "every nshm is at the newest version its requirements accept",
            );
        }
        anyhow::Ok(())
    })();
    if result.is_err() {
        backup.restore()?;
    }
    result
}

/// The executable of the platform `name` that a platform nshm of the app
/// in or above `cwd` provides, built when it is not: `None` when no nshm of
/// the app provides it.
///
/// The nshm is built from a copy in the app's `.nsh/platforms/<name>`, so
/// its build (its `Cargo.lock` and `target/`) stays the app's and the
/// installed copy every app shares stays as it was.
pub(crate) fn platform_program(cwd: &Path, name: &str) -> anyhow::Result<Option<PathBuf>> {
    let Ok(app) = App::open(cwd) else {
        return Ok(None);
    };
    if app.config.get("dependencies").is_none() {
        return Ok(None);
    }
    let resolved = ensure(&app.dir, &app.config)?;
    let Some(r) = resolved
        .iter()
        .find(|r| r.manifest.platform.as_deref() == Some(name))
    else {
        return Ok(None);
    };
    let build = app.dir.join(".nsh/platforms").join(name);
    let stamp = build.join(".nshm");
    let at = format!("{}@{}", r.locked.name, r.dir.display());
    if fs::read_to_string(&stamp).ok().as_deref() != Some(at.as_str()) {
        let _ = fs::remove_dir_all(&build);
        copy_dir(&r.dir, &build)?;
        fs::write(&stamp, &at)?;
    }
    let bin = format!("{}{name}", crate::platforms::PREFIX);
    status(
        "Building",
        format!("platform {name} ({} v{})", r.locked.name, r.locked.version),
    );
    let ok = Command::new(rust_app::cargo())
        .args([
            "build",
            "--release",
            "--quiet",
            "--bin",
            &bin,
            "--manifest-path",
        ])
        .arg(build.join("Cargo.toml"))
        .status()
        .context("running cargo (is Rust installed?)")?
        .success();
    if !ok {
        bail!(
            "{} could not build the platform {name} (its binary `{bin}`)",
            r.locked.name
        );
    }
    let program = build
        .join("target/release")
        .join(format!("{bin}{}", std::env::consts::EXE_SUFFIX));
    if !program.is_file() {
        bail!(
            "{}: no {} after the build",
            r.locked.name,
            program.display()
        );
    }
    Ok(Some(program))
}

/// Copies the directory `from` to `to`, without its `target/`, `.git/` and
/// `.nsh/`: a platform nshm in a directory above the app (an example app in
/// the platform's repository, `{ "path": "../.." }`) holds the copy itself in
/// the app's `.nsh/platforms`.
fn copy_dir(from: &Path, to: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let path = entry.path();
        let dest = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            if ["target", ".git", ".nsh"]
                .iter()
                .any(|n| entry.file_name() == *n)
            {
                continue;
            }
            copy_dir(&path, &dest)?;
        } else if kind.is_file() {
            fs::copy(&path, &dest).with_context(|| format!("copying {}", path.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_leave_builds_out() {
        let root = std::env::temp_dir().join(format!("nsh-copy-dir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let from = root.join("platform");
        for dir in [
            "src",
            "target/release",
            ".git",
            "examples/app/.nsh/platforms/x",
        ] {
            fs::create_dir_all(from.join(dir)).unwrap();
        }
        fs::write(from.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(from.join("examples/app/nsh.json"), "{}").unwrap();
        // The app's copy lies inside the platform it copies.
        copy_dir(&from, &from.join("examples/app/.nsh/platforms/x")).unwrap();
        let to = from.join("examples/app/.nsh/platforms/x");
        assert!(to.join("src/main.rs").is_file());
        assert!(to.join("examples/app/nsh.json").is_file());
        assert!(!to.join("target").exists());
        assert!(!to.join(".git").exists());
        assert!(!to.join("examples/app/.nsh").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn add_finds_the_app_above() {
        let root = std::env::temp_dir().join(format!("nsh-app-dir-{}", std::process::id()));
        let src = root.join("app/src/ui");
        fs::create_dir_all(&src).unwrap();
        fs::write(root.join("app/nsh.json"), "{}").unwrap();
        assert_eq!(app_dir(&src).unwrap(), root.join("app"));
        let err = app_dir(&root).unwrap_err().to_string();
        assert!(err.contains("nsh init"), "{err}");
        assert!(!err.contains("os error"), "{err}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn workspace_patches_follow_the_origin() {
        assert_eq!(
            patch_table("https://github.com/acme/ui"),
            Some(Some("https://github.com/acme/ui"))
        );
        assert_eq!(patch_table("nsh-omarchy"), Some(None));
        assert_eq!(patch_table("../ui"), None);
    }

    /// A TSX nshm from a Git repository, end to end: added by URL, listed
    /// with the version its newest tag has, installed once under
    /// `NSH_HOME`, locked, upgraded, removed.
    #[test]
    fn a_tsx_nshm_from_git_is_added_locked_and_removed() {
        if fetch::git(None, &["--version"]).is_err() {
            return;
        }
        let base = std::env::temp_dir().join(format!("nsh-nshm-e2e-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let repo = base.join("acme-ui");
        let app = base.join("app");
        fs::create_dir_all(repo.join("src")).unwrap();
        fs::create_dir_all(&app).unwrap();
        fs::write(app.join("nsh.json"), "{ \"name\": \"Demo\" }\n").unwrap();
        let git = |args: &[&str]| fetch::git(Some(&repo), args).unwrap();
        let commit = |version: &str| {
            fs::write(
                repo.join("src/index.tsx"),
                format!("export const version = {version:?};\n"),
            )
            .unwrap();
            fs::write(
                repo.join("nsh.json"),
                format!(
                    r#"{{ "name": "acme-ui", "version": "{version}", "exports": {{ "acme-ui": "src/index.tsx" }} }}"#
                ),
            )
            .unwrap();
            git(&["add", "."]);
            git(&[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-qm",
                version,
            ]);
            git(&["tag", &format!("v{version}")]);
        };
        git(&["init", "-q", "-b", "main"]);
        commit("1.0.0");
        // SAFETY: tests of this crate that read NSH_HOME run in this one test.
        unsafe { std::env::set_var("NSH_HOME", base.join("home")) };
        let url = format!("file://{}", repo.display());
        add(
            &app,
            Added::parse(Some(url.clone()), None, None, None, Vec::new()).unwrap(),
        )
        .unwrap();
        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(app.join("nsh.json")).unwrap()).unwrap();
        assert_eq!(config["dependencies"]["acme-ui"]["git"], url);
        assert_eq!(config["dependencies"]["acme-ui"]["version"], "^1.0.0");
        let lock = Lock::read(&app).unwrap();
        assert_eq!(lock.packages[0].version, "1.0.0");
        let installed = base
            .join("home/nshms")
            .join(lock.packages[0].dir.as_ref().unwrap());
        assert!(
            installed.join("src/index.tsx").is_file(),
            "{}",
            installed.display()
        );
        // The bundler finds its TSX from the lock.
        let exports = nsh_bundler::nshm::exports(&app).unwrap();
        assert_eq!(exports[0].0, "acme-ui");
        assert!(exports[0].1.starts_with(&installed));
        // A build with the lock in place reads nothing new: unchanged.
        let again = crates(&app, &config).unwrap();
        assert!(again.is_empty(), "a TSX nshm is no crate");
        assert_eq!(Lock::read(&app).unwrap(), lock);
        // A new version within the requirement: `nsh upgrade` takes it.
        commit("1.1.0");
        upgrade(&app, &[]).unwrap();
        assert_eq!(Lock::read(&app).unwrap().packages[0].version, "1.1.0");
        assert!(
            base.join("home/nshms")
                .join(repo_rel(&url))
                .join("1.0.0")
                .is_dir()
        );
        remove(&app, &["acme-ui".into()]).unwrap();
        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(app.join("nsh.json")).unwrap()).unwrap();
        assert!(config.get("dependencies").is_none());
        assert!(Lock::read(&app).unwrap().packages.is_empty());
        assert!(remove(&app, &["acme-ui".into()]).is_err());
        // SAFETY: as above.
        unsafe { std::env::remove_var("NSH_HOME") };
        fs::remove_dir_all(&base).unwrap();
    }

    fn repo_rel(url: &str) -> String {
        fetch::repo_dir(url)
    }
}
