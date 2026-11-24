//! Resolving an app's nshm: from its `"dependencies"` through each
//! nshm's own, one version of each package, pinned in `nsh.lock`.
//!
//! A package keeps the version the lock has while every requirement on it
//! still accepts that version, so resolving an unchanged app reads nothing
//! from the network. Otherwise it takes the newest version every
//! requirement accepts. The app's own entry decides where a package comes
//! from; nshm that depend on it from elsewhere are overruled, as Cargo's
//! `[patch]` does, while their version requirements still apply.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context as _, bail};
use serde::{Deserialize, Serialize};

use super::{
    dep::{Dep, Origin},
    fetch::{Candidate, Fetch},
    manifest::Manifest,
    relative,
};

/// The version of `nsh.lock`'s format.
const LOCK_VERSION: u64 = 2;

/// `nsh.lock`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Lock {
    pub version: u64,
    #[serde(default)]
    pub packages: Vec<Locked>,
}

impl Default for Lock {
    fn default() -> Self {
        Lock {
            version: LOCK_VERSION,
            packages: Vec::new(),
        }
    }
}

impl Lock {
    /// The lock in `dir`; an empty one when there is none, or one of an
    /// earlier format (never released: resolved again).
    pub(crate) fn read(dir: &Path) -> anyhow::Result<Self> {
        let Ok(text) = fs::read_to_string(dir.join(super::LOCK)) else {
            return Ok(Lock::default());
        };
        let value: serde_json::Value =
            serde_json::from_str(&text).with_context(|| format!("{} is not JSON", super::LOCK))?;
        match value.get("version").and_then(|v| v.as_u64()) {
            Some(LOCK_VERSION) => serde_json::from_value(value)
                .with_context(|| format!("{} is not valid", super::LOCK)),
            Some(v) if v > LOCK_VERSION => bail!(
                "{} is of a newer nsh (format {v}): update nsh (`nsh update`)",
                super::LOCK
            ),
            _ => Ok(Lock::default()),
        }
    }

    pub(crate) fn write(&self, dir: &Path) -> anyhow::Result<()> {
        let text = serde_json::to_string_pretty(self)? + "\n";
        fs::write(dir.join(super::LOCK), text).with_context(|| format!("writing {}", super::LOCK))
    }

    /// The lock of `resolved`.
    pub(crate) fn of(resolved: &[Resolved]) -> Self {
        let mut packages: Vec<Locked> = resolved.iter().map(|r| r.locked.clone()).collect();
        packages.sort_by(|a, b| a.name.cmp(&b.name));
        Lock {
            version: LOCK_VERSION,
            packages,
        }
    }

    fn find(&self, name: &str) -> Option<&Locked> {
        self.packages.iter().find(|p| p.name == name)
    }
}

/// A package in `nsh.lock`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Locked {
    pub name: String,
    pub version: String,
    /// `crates.io` or `git+<url>[?tag=|?rev=]` ([`Origin::lock_source`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// A local directory, relative to `nsh.json`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
    /// Where it is installed, relative to `~/.nsh/nshms`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    /// Its Rust module's specifier: an nshm with Rust.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// Its TSX, by specifier (read by the bundler, `nsh_bundler::nshm`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub exports: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    /// The packages it depends on.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<String>,
}

impl Locked {
    fn origin(&self) -> anyhow::Result<Origin> {
        Origin::from_lock(self.source.as_deref(), self.path.as_deref())
    }

    fn candidate(&self) -> anyhow::Result<Candidate> {
        Ok(Candidate {
            version: Some(semver::Version::parse(&self.version).with_context(|| {
                format!("{}: {}: version {:?}", super::LOCK, self.name, self.version)
            })?),
            commit: self.commit.clone(),
            checksum: self.checksum.clone(),
            yanked: false,
        })
    }
}

/// A package of the resolved graph.
#[derive(Debug, Clone)]
pub(crate) struct Resolved {
    pub locked: Locked,
    pub origin: Origin,
    /// Its directory.
    pub dir: PathBuf,
    pub manifest: Manifest,
}

/// Who requires a package, and how.
#[derive(Debug, Clone)]
struct Requirement {
    /// `nsh.json` or the requiring package's name.
    by: String,
    dep: Dep,
}

/// The most versions a resolution tries before it gives up.
const MAX_TRIES: usize = 256;

/// Resolves `deps` (the app's in `app`), keeping what `lock` has where it
/// still fits except for the packages `fresh` names.
///
/// A depth-first search: each package in turn takes the locked version,
/// then the others newest first, and a choice that leaves a later package
/// with no version every requirement accepts is undone for the next one.
pub(crate) fn resolve(
    app: &Path,
    deps: &[Dep],
    lock: &Lock,
    fresh: &dyn Fn(&str) -> bool,
    fetch: &mut dyn Fetch,
) -> anyhow::Result<Vec<Resolved>> {
    let mut search = Search {
        app,
        deps,
        lock,
        fresh,
        fetch,
        dead_end: None,
        tries: 0,
    };
    let mut chosen = BTreeMap::new();
    if !search.solve(&mut chosen)? {
        bail!(
            "{}",
            search
                .dead_end
                .unwrap_or_else(|| "the nshm requirements cannot all be met".to_owned())
        );
    }
    let resolved: Vec<Resolved> = chosen.into_values().collect();
    check_specifiers(&resolved)?;
    Ok(resolved)
}

/// A resolution in progress.
struct Search<'a> {
    app: &'a Path,
    deps: &'a [Dep],
    lock: &'a Lock,
    fresh: &'a dyn Fn(&str) -> bool,
    fetch: &'a mut dyn Fetch,
    /// The first dead end met: the error when every way ends in one.
    dead_end: Option<String>,
    tries: usize,
}

impl Search<'_> {
    fn dead(&mut self, message: String) {
        self.dead_end.get_or_insert(message);
    }

    /// Extends `chosen` to every package the app reaches, each a version
    /// all its requirements accept: `false` when nothing can (a dead end).
    fn solve(&mut self, chosen: &mut BTreeMap<String, Resolved>) -> anyhow::Result<bool> {
        let required = requirements(self.app, self.deps, chosen)?;
        for (name, reqs) in &required {
            if let Some(current) = chosen.get(name) {
                let origin = origin_of(name, reqs)?;
                if current.origin != origin || !accepts(reqs, &current.manifest.version) {
                    let message = format!(
                        "{name} {} from {} does not fit {}",
                        current.manifest.version,
                        current.origin.describe(),
                        asked(reqs)
                    );
                    self.dead(message);
                    return Ok(false);
                }
            }
        }
        let Some((name, reqs)) = required.iter().find(|(n, _)| !chosen.contains_key(*n)) else {
            return Ok(true);
        };
        let origin = origin_of(name, reqs)?;
        if let Origin::Path(p) = &origin {
            let dir = dunce::canonicalize(self.app.join(p))
                .with_context(|| format!("{name}: no directory {p}"))?;
            let manifest = Manifest::read(&dir, name)?;
            let resolved = finish(name, &origin, None, dir, manifest, Some(p.clone()), None)?;
            return self.choose(name, reqs, resolved, chosen);
        }
        // The locked version first, while it fits: no network.
        let mut locked_version = None;
        if !(self.fresh)(name)
            && let Some(locked) = self.lock.find(name)
            && locked.origin().is_ok_and(|o| o == origin)
        {
            let candidate = locked.candidate()?;
            if candidate.version.as_ref().is_some_and(|v| accepts(reqs, v)) {
                locked_version = candidate.version.clone();
                let rel = match &locked.dir {
                    Some(rel) if self.fetch.root().join(rel).is_dir() => rel.clone(),
                    _ => self.fetch.install(name, &origin, &candidate)?,
                };
                let resolved = self.installed(name, &origin, candidate, rel)?;
                if self.choose(name, reqs, resolved, chosen)? {
                    return Ok(true);
                }
            }
        }
        for candidate in self.candidates(name, &origin, reqs)? {
            if candidate.version.is_some() && candidate.version == locked_version {
                continue;
            }
            let rel = self.fetch.install(name, &origin, &candidate)?;
            let resolved = self.installed(name, &origin, candidate, rel)?;
            if self.choose(name, reqs, resolved, chosen)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Tries `resolved` for `name`, and the rest after it.
    fn choose(
        &mut self,
        name: &str,
        reqs: &[Requirement],
        resolved: Resolved,
        chosen: &mut BTreeMap<String, Resolved>,
    ) -> anyhow::Result<bool> {
        self.tries += 1;
        if self.tries > MAX_TRIES {
            bail!(
                "the nshm requirements took more than {MAX_TRIES} versions to try; narrow them in nsh.json"
            );
        }
        if !accepts(reqs, &resolved.manifest.version) {
            let message = format!(
                "{name} from {} is version {}, which {} does not accept",
                resolved.origin.describe(),
                resolved.manifest.version,
                asked(reqs)
            );
            self.dead(message);
            return Ok(false);
        }
        chosen.insert(name.to_owned(), resolved);
        if self.solve(chosen)? {
            return Ok(true);
        }
        chosen.remove(name);
        Ok(false)
    }

    /// The installed `candidate` (in `rel`), read.
    fn installed(
        &mut self,
        name: &str,
        origin: &Origin,
        candidate: Candidate,
        rel: String,
    ) -> anyhow::Result<Resolved> {
        let dir = self.fetch.root().join(&rel);
        let manifest = Manifest::read(&dir, name)?;
        finish(
            name,
            origin,
            Some(candidate),
            dir,
            manifest,
            None,
            Some(rel),
        )
    }

    /// The versions of `name` from `origin` to try: those `reqs` accept,
    /// newest first; or the commit a Git reference names (its version is
    /// checked once installed).
    fn candidates(
        &mut self,
        name: &str,
        origin: &Origin,
        reqs: &[Requirement],
    ) -> anyhow::Result<Vec<Candidate>> {
        let all = self.fetch.candidates(name, origin)?;
        if all.iter().all(|c| c.version.is_none()) {
            return Ok(all);
        }
        let mut fit: Vec<Candidate> = all
            .iter()
            .filter(|c| !c.yanked)
            .filter(|c| c.version.as_ref().is_some_and(|v| accepts(reqs, v)))
            .cloned()
            .collect();
        fit.sort_by(|a, b| b.version.cmp(&a.version));
        if fit.is_empty() {
            let mut newest: Vec<&semver::Version> = all
                .iter()
                .filter(|c| !c.yanked)
                .filter_map(|c| c.version.as_ref())
                .collect();
            newest.sort_by(|a, b| b.cmp(a));
            let newest: Vec<String> = newest.iter().take(5).map(ToString::to_string).collect();
            let message = format!(
                "no version of {name} from {} matches {}; the newest are {}",
                origin.describe(),
                asked(reqs),
                if newest.is_empty() {
                    "none".to_owned()
                } else {
                    newest.join(", ")
                }
            );
            self.dead(message);
        }
        Ok(fit)
    }
}

/// What `deps` and the chosen packages' manifests require, by package:
/// only what the app reaches.
fn requirements(
    app: &Path,
    deps: &[Dep],
    chosen: &BTreeMap<String, Resolved>,
) -> anyhow::Result<BTreeMap<String, Vec<Requirement>>> {
    let mut out: BTreeMap<String, Vec<Requirement>> = BTreeMap::new();
    let mut queue: Vec<String> = Vec::new();
    for dep in deps {
        out.entry(dep.name.clone()).or_default().push(Requirement {
            by: "nsh.json".to_owned(),
            dep: dep.clone(),
        });
        queue.push(dep.name.clone());
    }
    let mut seen = BTreeSet::new();
    while let Some(name) = queue.pop() {
        if !seen.insert(name.clone()) {
            continue;
        }
        let Some(package) = chosen.get(&name) else {
            continue;
        };
        for dep in &package.manifest.dependencies {
            let mut dep = dep.clone();
            if let Origin::Path(p) = &dep.origin {
                // Relative to the nshm that names it: only one that is a
                // directory itself may (an installed copy has no neighbors).
                if !matches!(package.origin, Origin::Path(_)) {
                    bail!(
                        "{name} depends on {} by path ({p}): a published nshm takes its dependencies from crates.io or Git",
                        dep.name
                    );
                }
                let target = dunce::canonicalize(package.dir.join(p)).with_context(|| {
                    format!("{name}: dependencies: {}: no directory {p}", dep.name)
                })?;
                dep.origin = Origin::Path(relative(app, &target));
            }
            queue.push(dep.name.clone());
            out.entry(dep.name.clone()).or_default().push(Requirement {
                by: name.clone(),
                dep,
            });
        }
    }
    Ok(out)
}

/// Where `name` comes from: the app's say, else the one all requirers agree on.
fn origin_of(name: &str, reqs: &[Requirement]) -> anyhow::Result<Origin> {
    if let Some(app) = reqs.iter().find(|r| r.by == "nsh.json") {
        return Ok(app.dep.origin.clone());
    }
    let first = &reqs[0];
    if let Some(other) = reqs.iter().find(|r| r.dep.origin != first.dep.origin) {
        bail!(
            "{name} is required from {} by {} and from {} by {}: list it in the app's nsh.json \
             to say which",
            first.dep.origin.describe(),
            first.by,
            other.dep.origin.describe(),
            other.by
        );
    }
    Ok(first.dep.origin.clone())
}

/// Whether every requirement accepts `version`.
fn accepts(reqs: &[Requirement], version: &semver::Version) -> bool {
    reqs.iter().all(|r| r.dep.version_req().matches(version))
}

/// What `reqs` ask for, for messages: `^1.2 (nsh.json), ^1.3 (acme-ui)`.
fn asked(reqs: &[Requirement]) -> String {
    reqs.iter()
        .map(|r| format!("{} ({})", r.dep.req.as_deref().unwrap_or("*"), r.by))
        .collect::<Vec<_>>()
        .join(", ")
}

#[allow(clippy::too_many_arguments)]
fn finish(
    name: &str,
    origin: &Origin,
    candidate: Option<Candidate>,
    dir: PathBuf,
    manifest: Manifest,
    path: Option<String>,
    rel: Option<String>,
) -> anyhow::Result<Resolved> {
    if manifest.name != name {
        bail!(
            "{} is the package {}, not {name}: list it as \"{}\"",
            origin.describe(),
            manifest.name,
            manifest.name
        );
    }
    if let Some(v) = candidate.as_ref().and_then(|c| c.version.as_ref())
        && *v != manifest.version
    {
        bail!(
            "{name} {v} from {} says it is version {}",
            origin.describe(),
            manifest.version
        );
    }
    let mut dependencies: Vec<String> = manifest
        .dependencies
        .iter()
        .map(|d| d.name.clone())
        .collect();
    dependencies.sort();
    let candidate = candidate.unwrap_or(Candidate {
        version: None,
        commit: None,
        checksum: None,
        yanked: false,
    });
    Ok(Resolved {
        locked: Locked {
            name: name.to_owned(),
            version: manifest.version.to_string(),
            source: origin.lock_source(),
            path,
            commit: candidate.commit,
            checksum: candidate.checksum,
            dir: rel,
            module: manifest.module.clone(),
            exports: manifest.exports.clone(),
            platform: manifest.platform.clone(),
            dependencies,
        },
        origin: origin.clone(),
        dir,
        manifest,
    })
}

/// Checks no two packages give one specifier or one platform.
fn check_specifiers(resolved: &[Resolved]) -> anyhow::Result<()> {
    let mut seen: BTreeMap<&str, &str> = BTreeMap::new();
    let mut platforms: BTreeMap<&str, &str> = BTreeMap::new();
    for r in resolved {
        let name = r.manifest.name.as_str();
        let specifiers = r
            .manifest
            .module
            .iter()
            .map(String::as_str)
            .chain(r.manifest.exports.keys().map(String::as_str));
        for s in specifiers {
            if s == "nsh" || s.starts_with("nsh/") || s.starts_with("nsh:") {
                bail!("{name} exports {s:?}, a specifier of NSH's own modules");
            }
            if let Some(other) = seen.insert(s, name) {
                bail!("{other} and {name} both export {s:?}: an import can take only one");
            }
        }
        if let Some(p) = &r.manifest.platform
            && let Some(other) = platforms.insert(p, name)
        {
            bail!("{other} and {name} both provide the platform {p:?}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::nshm::dep::Ref;

    /// A version and the requirements of its dependencies.
    type Release = (&'static str, Vec<(&'static str, &'static str)>);

    /// A registry of TSX nshm in a directory: `name` → versions, each
    /// with its dependencies.
    struct Fake {
        root: PathBuf,
        versions: HashMap<String, Vec<Release>>,
        listed: Vec<String>,
    }

    impl Fetch for Fake {
        fn root(&self) -> &Path {
            &self.root
        }

        fn candidates(&mut self, name: &str, _: &Origin) -> anyhow::Result<Vec<Candidate>> {
            self.listed.push(name.to_owned());
            Ok(self
                .versions
                .get(name)
                .context("unknown")?
                .iter()
                .map(|(v, _)| Candidate {
                    version: Some(semver::Version::parse(v).unwrap()),
                    commit: None,
                    checksum: Some(format!("sha256-{name}{v}")),
                    yanked: false,
                })
                .collect())
        }

        fn install(&mut self, name: &str, _: &Origin, c: &Candidate) -> anyhow::Result<String> {
            let version = c.version.as_ref().unwrap().to_string();
            let rel = format!("{name}/{version}");
            let dir = self.root.join(&rel);
            let deps = &self.versions[name]
                .iter()
                .find(|(v, _)| *v == version)
                .unwrap()
                .1;
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("index.tsx"), "export {};").unwrap();
            let deps: serde_json::Map<String, serde_json::Value> = deps
                .iter()
                .map(|(n, r)| ((*n).to_owned(), serde_json::json!(r)))
                .collect();
            fs::write(
                dir.join("nsh.json"),
                serde_json::json!({
                    "name": name, "version": version,
                    "exports": { name: "index.tsx" }, "dependencies": deps
                })
                .to_string(),
            )
            .unwrap();
            Ok(rel)
        }
    }

    fn fake(label: &str) -> Fake {
        let root = std::env::temp_dir().join(format!("nsh-resolve-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let mut versions = HashMap::new();
        versions.insert(
            "ui".to_owned(),
            vec![
                ("1.0.0", vec![("icons", "^1")]),
                ("1.1.0", vec![("icons", "^1.2")]),
                ("2.0.0", vec![("icons", "^2")]),
            ],
        );
        versions.insert(
            "icons".to_owned(),
            vec![("1.1.0", vec![]), ("1.3.0", vec![]), ("2.0.0", vec![])],
        );
        versions.insert("chart".to_owned(), vec![("0.1.0", vec![("icons", "~1.1")])]);
        Fake {
            root,
            versions,
            listed: Vec::new(),
        }
    }

    fn dep(name: &str, req: &str) -> Dep {
        Dep {
            name: name.into(),
            origin: Origin::Registry,
            req: Some(req.into()),
            features: Vec::new(),
        }
    }

    fn versions(resolved: &[Resolved]) -> Vec<String> {
        resolved
            .iter()
            .map(|r| format!("{}@{}", r.locked.name, r.locked.version))
            .collect()
    }

    #[test]
    fn the_newest_versions_every_requirement_accepts() {
        let mut f = fake("newest");
        let app = f.root.clone();
        let r = resolve(
            &app,
            &[dep("ui", "^1")],
            &Lock::default(),
            &|_| false,
            &mut f,
        )
        .unwrap();
        assert_eq!(versions(&r), ["icons@1.3.0", "ui@1.1.0"]);
        assert_eq!(r[1].locked.dependencies, ["icons"]);
        assert_eq!(r[1].locked.exports["ui"], "index.tsx");
        // Two requirers: one version both accept.
        let r = resolve(
            &app,
            &[dep("ui", "1.0"), dep("chart", "*")],
            &Lock::default(),
            &|_| false,
            &mut f,
        )
        .unwrap();
        assert_eq!(versions(&r), ["chart@0.1.0", "icons@1.1.0", "ui@1.0.0"]);
        // None fits: the requirers are named.
        let err = resolve(
            &app,
            &[dep("ui", "^2"), dep("chart", "*")],
            &Lock::default(),
            &|_| false,
            &mut f,
        )
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("icons") && err.contains("(chart)") && err.contains("(ui)"),
            "{err}"
        );
        fs::remove_dir_all(&f.root).unwrap();
    }

    #[test]
    fn the_lock_is_kept_while_it_fits() {
        let mut f = fake("lock");
        let app = f.root.clone();
        let first = resolve(
            &app,
            &[dep("ui", "=1.0.0")],
            &Lock::default(),
            &|_| false,
            &mut f,
        )
        .unwrap();
        let lock = Lock::of(&first);
        assert_eq!(versions(&first), ["icons@1.3.0", "ui@1.0.0"]);
        // Wider now: the locked versions stay, nothing is listed.
        f.listed.clear();
        let again = resolve(&app, &[dep("ui", "^1")], &lock, &|_| false, &mut f).unwrap();
        assert_eq!(versions(&again), versions(&first));
        assert!(f.listed.is_empty(), "{:?}", f.listed);
        // Updating `ui` takes its newest; `icons` still fits.
        let updated = resolve(&app, &[dep("ui", "^1")], &lock, &|n| n == "ui", &mut f).unwrap();
        assert_eq!(versions(&updated), ["icons@1.3.0", "ui@1.1.0"]);
        // A package no longer required leaves the lock.
        let none = resolve(&app, &[], &lock, &|_| false, &mut f).unwrap();
        assert!(none.is_empty());
        fs::remove_dir_all(&f.root).unwrap();
    }

    #[test]
    fn the_app_says_where_a_package_comes_from() {
        let mut f = fake("origin");
        let app = f.root.join("app");
        let local = f.root.join("icons-local");
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(&local).unwrap();
        fs::write(local.join("index.tsx"), "export {};").unwrap();
        fs::write(
            local.join("nsh.json"),
            r#"{ "name": "icons", "version": "1.5.0", "exports": { "icons": "index.tsx" } }"#,
        )
        .unwrap();
        let icons = Dep {
            name: "icons".into(),
            origin: Origin::Path("../icons-local".into()),
            req: None,
            features: Vec::new(),
        };
        let r = resolve(
            &app,
            &[dep("ui", "^1"), icons],
            &Lock::default(),
            &|_| false,
            &mut f,
        )
        .unwrap();
        let icons = r.iter().find(|r| r.locked.name == "icons").unwrap();
        assert_eq!(icons.locked.path.as_deref(), Some("../icons-local"));
        assert_eq!(icons.locked.dir, None);
        let lock = Lock::of(&r);
        let text = serde_json::to_string(&lock).unwrap();
        assert_eq!(serde_json::from_str::<Lock>(&text).unwrap(), lock);
        assert!(
            Origin::from_lock(Some("git+https://x?tag=v1"), None).unwrap()
                == Origin::Git {
                    url: "https://x".into(),
                    reference: Ref::Tag("v1".into())
                }
        );
        fs::remove_dir_all(&f.root).unwrap();
    }
}
