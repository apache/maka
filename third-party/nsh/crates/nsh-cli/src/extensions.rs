//! Third-party extensions: Rust crates that export components, modules
//! and classes to the app, as the app's own crates do (`nsh.json`
//! `"rust"`, [`crate::rust_app`]). `nsh add <source>` lists one in
//! `nsh.json`; a crate from crates.io is the default:
//!
//! ```json
//! { "extensions": [
//!   "acme-ui@1.2",
//!   "github:acme/chart@v0.3.0",
//!   { "git": "https://git.example.com/ui.git", "rev": "4f2a1c0" },
//!   { "path": "../my-ui" }
//! ] }
//! ```
//!
//! Versions are Cargo version requirements with Cargo's meaning: `"1.2"`
//! is `^1.2`, and `"~1.2"`, `"=1.2.3"`, `">=1.2, <2"` and `"*"` work as in
//! `Cargo.toml`. A Git or path entry may add `"version"` (the object form)
//! and, as Cargo does, the package must be such a version.
//!
//! `nsh.json` says what is acceptable; `nsh add` pins what it resolved to
//! (a crate's exact version, a Git commit) in `nsh.lock`, next to `nsh.json`,
//! which the app commits: a build takes the locked commit, never what a tag
//! or branch points to now. An extension is an ordinary Cargo library with
//! a `#[native_module("<module>")]` entry at its root and, in its
//! `Cargo.toml`, what NSH checks before anything compiles:
//!
//! ```toml
//! [package.metadata.nsh]
//! format = 1                   # this metadata's version
//! module = "acme/ui"           # the specifier TSX imports it by, its #[native_module]
//! nsh = "0.6"                  # the NSH versions it builds with (a Cargo version requirement)
//! targets = ["macos", "linux"] # optional: the targets it supports (default: all)
//! ```
//!
//! Each locked commit is checked out once in nsh's cache
//! (`<cache>/extensions/<repository>/<commit>`) and linked into the app's
//! generated workspace like an app crate, so a pure TSX app gets hosts
//! built with it, and a Rust app's runners stay without a JS engine.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context as _, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::rust_app::{self, AppCrate};

/// The lock file beside `nsh.json`.
pub(crate) const LOCK: &str = "nsh.lock";

/// An extension as `nsh.json` lists it: from Git (`git`, with `tag` or
/// `rev`), from crates.io (`crate`, with a `version` requirement) or from
/// a local directory (`path`, relative to `nsh.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Source {
    /// The repository's URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<String>,
    /// A tag to take.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// A commit (or branch) to take.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
    /// The crate's name on crates.io.
    #[serde(rename = "crate", default, skip_serializing_if = "Option::is_none")]
    pub krate: Option<String>,
    /// The versions of the crate to take (a Cargo version requirement).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// A local directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl Source {
    /// The reference to resolve: the tag, the rev, else the default branch.
    fn reference(&self) -> &str {
        self.tag
            .as_deref()
            .or(self.rev.as_deref())
            .unwrap_or("HEAD")
    }

    /// What names it: its URL, crate or path. Two sources with the same
    /// one are the same extension.
    pub(crate) fn id(&self) -> &str {
        self.git
            .as_deref()
            .or(self.krate.as_deref())
            .or(self.path.as_deref())
            .unwrap_or_default()
    }

    /// Checks it names exactly one place.
    fn validate(&self) -> anyhow::Result<()> {
        let kinds = [&self.git, &self.krate, &self.path]
            .iter()
            .filter(|k| k.is_some())
            .count();
        if kinds != 1 {
            bail!("nsh.json: \"extensions\": each has one of \"git\", \"crate\" or \"path\"");
        }
        if self.tag.is_some() && self.rev.is_some() {
            bail!(
                "nsh.json: \"extensions\": {} has both \"tag\" and \"rev\"",
                self.id()
            );
        }
        if self.git.is_none() && (self.tag.is_some() || self.rev.is_some()) {
            bail!(
                "nsh.json: \"extensions\": {}: \"tag\" and \"rev\" are for \"git\"",
                self.id()
            );
        }
        if let Some(v) = &self.version {
            semver::VersionReq::parse(v).with_context(|| {
                format!(
                    "nsh.json: \"extensions\": {}: {v:?} is not a version requirement",
                    self.id()
                )
            })?;
        }
        Ok(())
    }

    /// A source written as a string, in `nsh.json` or to `nsh add`: a
    /// crate by default (`acme-ui`, `acme-ui@1.2`), `github:<owner>/<repo>`
    /// (`@<tag>`), or a Git URL. `tag`/`rev` (from `--tag`/`--rev`) apply to
    /// Git only.
    pub(crate) fn short(s: &str, tag: Option<String>, rev: Option<String>) -> anyhow::Result<Self> {
        let source = if let Some(repo) = s.strip_prefix("github:") {
            let (repo, at) = match repo.split_once('@') {
                Some((repo, t)) => (repo, Some(t.to_owned())),
                None => (repo, None),
            };
            if repo.split('/').count() != 2 || repo.split('/').any(str::is_empty) {
                bail!("{s}: write github:<owner>/<repo>");
            }
            if at.is_some() && (tag.is_some() || rev.is_some()) {
                bail!("{s}: give the tag once");
            }
            Source {
                git: Some(github_url(repo)),
                tag: at.or(tag),
                rev,
                ..Default::default()
            }
        } else if s.contains("://") || s.starts_with("git@") || s.ends_with(".git") {
            Source {
                git: Some(s.to_owned()),
                tag,
                rev,
                ..Default::default()
            }
        } else {
            let (name, version) = match s.split_once('@') {
                Some((name, v)) => (name.to_owned(), Some(v.to_owned())),
                None => (s.to_owned(), None),
            };
            if let Some(v) = &version {
                semver::VersionReq::parse(v)
                    .with_context(|| format!("{name}@{v}: not a version requirement"))?;
            }
            if tag.is_some() || rev.is_some() {
                bail!("--tag and --rev are for Git; take a crate's version with {name}@<version>");
            }
            Source {
                krate: Some(name),
                version,
                ..Default::default()
            }
        };
        source.validate()?;
        Ok(source)
    }

    /// The source `nsh add` was given: [`Source::short`], or `path`.
    pub(crate) fn parse(
        source: Option<String>,
        path: Option<String>,
        tag: Option<String>,
        rev: Option<String>,
    ) -> anyhow::Result<Self> {
        match (source, path) {
            (None, Some(path)) => Ok(Source {
                // Written with a separator, never read as a crate's name.
                path: Some(if path.contains(['/', '\\']) || path.starts_with('.') {
                    path
                } else {
                    format!("./{path}")
                }),
                ..Default::default()
            }),
            (Some(s), None) => Source::short(&s, tag, rev),
            _ => bail!(
                "nsh add takes a crate name, github:<owner>/<repo>, a Git URL or --path <dir>"
            ),
        }
    }

    /// How `nsh.json` lists it: a string when it can be one.
    fn entry(&self) -> serde_json::Value {
        use serde_json::{Value, json};
        if let Some(name) = &self.krate {
            return Value::String(match &self.version {
                Some(v) => format!("{name}@{v}"),
                None => name.clone(),
            });
        }
        if let Some(path) = &self.path {
            let mut o = json!({ "path": path });
            if let Some(v) = &self.version {
                o["version"] = json!(v);
            }
            return o;
        }
        let url = self.git.clone().unwrap_or_default();
        let github = github_repo(&url);
        if let Some(v) = &self.version {
            // A version requirement on Git: only the object form carries it.
            let mut o = match github {
                Some(repo) => json!({ "github": repo }),
                None => json!({ "git": url }),
            };
            if let Some(t) = &self.tag {
                o["tag"] = json!(t);
            }
            if let Some(r) = &self.rev {
                o["rev"] = json!(r);
            }
            o["version"] = json!(v);
            return o;
        }
        match (github, &self.tag, &self.rev) {
            (Some(repo), None, None) => Value::String(format!("github:{repo}")),
            (Some(repo), Some(tag), None) => Value::String(format!("github:{repo}@{tag}")),
            (Some(repo), _, Some(rev)) => json!({ "github": repo, "rev": rev }),
            (None, tag, rev) => {
                let mut o = json!({ "git": url });
                if let Some(t) = tag {
                    o["tag"] = json!(t);
                }
                if let Some(r) = rev {
                    o["rev"] = json!(r);
                }
                o
            }
        }
    }

    /// Reads an entry of `nsh.json` `"extensions"`.
    fn from_entry(value: &serde_json::Value) -> anyhow::Result<Self> {
        if let Some(s) = value.as_str() {
            return Source::short(s, None, None);
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Full {
            git: Option<String>,
            github: Option<String>,
            tag: Option<String>,
            rev: Option<String>,
            path: Option<String>,
            version: Option<String>,
        }
        let full: Full = serde_json::from_value(value.clone()).context(
            "nsh.json: \"extensions\": each is \"<crate>[@<version>]\", \"github:<owner>/<repo>[@<tag>]\", { \"git\" | \"github\": ..., \"tag\" | \"rev\" } or { \"path\": \"<dir>\" }",
        )?;
        if full.git.is_some() && full.github.is_some() {
            bail!("nsh.json: \"extensions\": an entry has both \"git\" and \"github\"");
        }
        let source = Source {
            git: full.git.or(full.github.as_deref().map(github_url)),
            tag: full.tag,
            rev: full.rev,
            path: full.path,
            version: full.version,
            ..Default::default()
        };
        source.validate()?;
        Ok(source)
    }
}

/// `https://github.com/<repo>`.
fn github_url(repo: &str) -> String {
    format!("https://github.com/{repo}")
}

/// `<owner>/<repo>` of a `https://github.com/<owner>/<repo>` URL.
fn github_repo(url: &str) -> Option<&str> {
    let repo = url.strip_prefix("https://github.com/")?;
    (repo.split('/').count() == 2 && !repo.ends_with(".git")).then_some(repo)
}

/// `nsh.lock`: the commit each extension resolved to.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Lock {
    version: u64,
    #[serde(default)]
    extensions: Vec<Locked>,
}

/// An extension's entry in `nsh.lock`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Locked {
    #[serde(flatten)]
    source: Source,
    /// The commit a Git source resolved to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    commit: Option<String>,
    /// The version a crate resolved to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resolved: Option<String>,
    package: String,
    module: String,
}

impl Locked {
    /// Where it was resolved to, briefly.
    fn at(&self) -> String {
        match (&self.commit, &self.resolved) {
            (Some(c), _) => c[..c.len().min(12)].to_owned(),
            (_, Some(v)) => v.clone(),
            _ => "the local directory".to_owned(),
        }
    }
}

/// The extensions `config` (the `nsh.json` in `dir`) lists, each checked
/// out at its locked commit, with how `nsh.json` names it. One not locked
/// yet is resolved and locked (`nsh.lock` written).
pub(crate) fn crates(
    dir: &Path,
    config: &serde_json::Value,
) -> anyhow::Result<Vec<(String, AppCrate)>> {
    let sources = sources(config)?;
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    let lock = read_lock(dir)?;
    let mut locked = Vec::new();
    let mut crates = Vec::new();
    for source in &sources {
        if let Some(path) = &source.path {
            // A local directory: read as it is now, nothing to lock.
            let checkout = dunce::canonicalize(dir.join(path))
                .with_context(|| format!("nsh.json: \"extensions\": no directory {path}"))?;
            let package = rust_app::package_name(&checkout.join("Cargo.toml"))?;
            check(&checkout, path)?;
            check_version(&checkout, source)?;
            crates.push((path.clone(), AppCrate::new(package, checkout)));
            continue;
        }
        let entry = match lock.extensions.iter().find(|l| l.source == *source) {
            Some(entry) => entry.clone(),
            None => resolve(source)?,
        };
        let checkout = place(&entry)?;
        let package = rust_app::package_name(&checkout.join("Cargo.toml"))?;
        check(&checkout, source.id())?;
        check_version(&checkout, source)?;
        crates.push((source.id().to_owned(), AppCrate::new(package, checkout)));
        locked.push(entry);
    }
    let new = Lock {
        version: 1,
        extensions: locked,
    };
    if new.extensions != lock.extensions {
        write_lock(dir, &new)?;
    }
    Ok(crates)
}

/// The `[patch]` table that sends the app's dependency on the extension
/// named `id` (as [`crates`] names it) to its checkout: `Some(Some(url))`
/// for Git, `Some(None)` for crates.io, `None` for a directory, which the
/// app's crate takes as it is.
pub(crate) fn patch_table(id: &str) -> Option<Option<&str>> {
    if id.contains("://") || id.starts_with("git@") || id.ends_with(".git") {
        Some(Some(id))
    } else if id.contains(['/', '\\', '.']) {
        None
    } else {
        Some(None)
    }
}

/// The directory of the locked `entry`: a Git checkout or the crate as
/// Cargo downloaded it.
fn place(entry: &Locked) -> anyhow::Result<PathBuf> {
    match (
        &entry.source.git,
        &entry.commit,
        &entry.source.krate,
        &entry.resolved,
    ) {
        (Some(git), Some(commit), _, _) => checkout(git, commit),
        (_, _, Some(name), Some(version)) => Ok(registry(name, &format!("={version}"))?.1),
        _ => bail!(
            "{LOCK}: {} is not resolved: run nsh add again",
            entry.source.id()
        ),
    }
}

/// `nsh add`: lists the extension at `git` (`tag` or `rev`, else the
/// default branch) in the `nsh.json` in `dir`, replacing one of the same
/// repository, locks it, and checks it with the app's crates. On an error
/// `nsh.json` and `nsh.lock` are left as they were.
pub(crate) fn add(dir: &Path, source: Source) -> anyhow::Result<()> {
    let config_path = dir.join("nsh.json");
    let lock_path = dir.join(LOCK);
    let config_text = fs::read_to_string(&config_path).with_context(|| {
        format!(
            "no nsh.json in {}: run nsh add in the app's directory",
            dir.display()
        )
    })?;
    let lock_text = fs::read_to_string(&lock_path).ok();
    let mut config: serde_json::Value =
        serde_json::from_str(&config_text).context("nsh.json is not JSON")?;
    let id = source.id().to_owned();
    let mut manifest_backup: Option<(PathBuf, String)> = None;
    let result = (|| {
        // `nsh add` again: resolved anew, what the reference points to now.
        if let Ok(mut lock) = read_lock(dir)
            && lock.extensions.iter().any(|l| l.source.id() == id)
        {
            lock.extensions.retain(|l| l.source.id() != id);
            write_lock(dir, &lock)?;
        }
        let mut sources = sources(&config)?;
        sources.retain(|s| s.id() != id);
        sources.push(source.clone());
        config["extensions"] =
            serde_json::Value::Array(sources.iter().map(Source::entry).collect());
        fs::write(&config_path, serde_json::to_string_pretty(&config)? + "\n")?;
        // The app's crates and the extensions together: a clash of
        // packages or modules is reported here, before a build.
        let extensions = crates(dir, &config)?;
        let mut all: Vec<(String, AppCrate)> = match config.get("rust") {
            Some(rust) => rust_crates(dir, rust)?,
            None => Vec::new(),
        };
        let app_crate = all.first().map(|(_, c)| c.dir().to_owned());
        let added = extensions
            .iter()
            .find(|(name, _)| *name == id)
            .map(|(_, c)| c.clone())
            .context("the extension is not listed")?;
        all.extend(extensions);
        rust_app::check_crates(&all)?;
        let lock = read_lock(dir)?;
        let entry = lock.extensions.iter().find(|l| l.source == source).cloned();
        // The app's crate uses it from Rust too (`use acme_ui::Gauge`).
        if let Some(crate_dir) = &app_crate {
            let manifest = crate_dir.join("Cargo.toml");
            let package = rust_app::package_name(&added.dir().join("Cargo.toml"))?;
            let dependency = match &entry {
                Some(Locked {
                    commit: Some(commit),
                    ..
                }) => Dependency::Git {
                    url: id.clone(),
                    commit: commit.clone(),
                },
                Some(Locked {
                    resolved: Some(version),
                    ..
                }) => Dependency::Crate {
                    version: version.clone(),
                },
                _ => Dependency::Path {
                    path: relative(crate_dir, added.dir()),
                },
            };
            let text = fs::read_to_string(&manifest)?;
            manifest_backup = Some((manifest.clone(), text.clone()));
            if let Some(new) = with_dependency(&text, &package, &dependency)? {
                fs::write(&manifest, new)?;
            }
        }
        let module = check(added.dir(), &id)?;
        let at = entry
            .map(|e| e.at())
            .unwrap_or_else(|| "the local directory".into());
        anyhow::Ok((module, at))
    })();
    match result {
        Ok((module, at)) => {
            println!("added {id} at {at}: import from \"{module}\"");
            Ok(())
        }
        Err(e) => {
            fs::write(&config_path, config_text)?;
            if let Some((path, text)) = manifest_backup {
                fs::write(path, text)?;
            }
            match lock_text {
                Some(text) => fs::write(&lock_path, text)?,
                None => {
                    let _ = fs::remove_file(&lock_path);
                }
            }
            Err(e.context(format!("nsh add {id}: nsh.json and {LOCK} are unchanged")))
        }
    }
}

/// How the app's crate depends on an extension.
#[derive(Debug)]
enum Dependency {
    Git { url: String, commit: String },
    Crate { version: String },
    Path { path: String },
}

impl Dependency {
    /// Its value in `[dependencies]`.
    fn value(&self) -> String {
        match self {
            Dependency::Git { url, commit } => format!("{{ git = {url:?}, rev = {commit:?} }}"),
            Dependency::Crate { version } => format!("{version:?}"),
            Dependency::Path { path } => format!("{{ path = {path:?} }}"),
        }
    }

    /// Whether the dependency `line` takes the crate from the same place.
    fn same_place(&self, line: &str) -> bool {
        let git = rust_app::toml_string(line, "git");
        let path = rust_app::toml_string(line, "path");
        match self {
            Dependency::Git { url, .. } => git.as_deref() == Some(url.as_str()),
            Dependency::Crate { .. } => git.is_none() && path.is_none(),
            Dependency::Path { .. } => path.is_some(),
        }
    }
}

/// `to` relative to `from`, with `/`.
fn relative(from: &Path, to: &Path) -> String {
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> = vec!["..".into(); from.len() - common];
    parts.extend(
        to[common..]
            .iter()
            .map(|c| c.as_os_str().to_string_lossy().into_owned()),
    );
    if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    }
}

/// The manifest `text` depending on `package` as `dependency` says, or
/// `None` when it does already; an error when it takes `package` from
/// elsewhere.
fn with_dependency(
    text: &str,
    package: &str,
    dependency: &Dependency,
) -> anyhow::Result<Option<String>> {
    let line = format!("{package} = {}", dependency.value());
    let mut out = Vec::new();
    let mut found = false;
    let mut table = String::new();
    for l in text.lines() {
        let t = l.trim();
        if t.starts_with('[') {
            table = t.to_owned();
        }
        if table == "[dependencies]" && t.split(['=', ' ']).next() == Some(package) {
            if dependency.same_place(t) {
                // The same place: as now, written under the table's header.
                continue;
            }
            bail!("Cargo.toml: [dependencies] already has {package} from elsewhere: `{t}`");
        }
        out.push(l.to_owned());
        if t == "[dependencies]" && !found {
            out.push(line.clone());
            found = true;
        }
    }
    if !found {
        out.push(String::new());
        out.push("[dependencies]".to_owned());
        out.push(line);
    }
    let new = out.join("\n") + "\n";
    Ok((new != text).then_some(new))
}

/// The app's own crates (`"rust"`), named by their paths.
fn rust_crates(dir: &Path, rust: &serde_json::Value) -> anyhow::Result<Vec<(String, AppCrate)>> {
    let paths: Vec<String> = match rust {
        serde_json::Value::String(p) => vec![p.clone()],
        serde_json::Value::Array(ps) => ps
            .iter()
            .filter_map(|p| p.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    };
    paths
        .into_iter()
        .map(|path| {
            let crate_dir = dunce::canonicalize(dir.join(&path))
                .with_context(|| format!("nsh.json: \"rust\": no crate at {path}"))?;
            let package = rust_app::package_name(&crate_dir.join("Cargo.toml"))?;
            Ok((path, AppCrate::new(package, crate_dir)))
        })
        .collect()
}

/// `"extensions"` of `config`.
fn sources(config: &serde_json::Value) -> anyhow::Result<Vec<Source>> {
    match config.get("extensions") {
        None => Ok(Vec::new()),
        Some(value) => {
            let list = value.as_array().context(
                "nsh.json: \"extensions\" is a list, e.g. [\"acme-ui@1.2\", \"github:acme/ui\"]",
            )?;
            let sources = list
                .iter()
                .map(Source::from_entry)
                .collect::<anyhow::Result<Vec<_>>>()?;
            for s in &sources {
                s.validate()?;
            }
            Ok(sources)
        }
    }
}

fn read_lock(dir: &Path) -> anyhow::Result<Lock> {
    match fs::read_to_string(dir.join(LOCK)) {
        Ok(text) => serde_json::from_str(&text).with_context(|| format!("{LOCK} is not valid")),
        Err(_) => Ok(Lock::default()),
    }
}

fn write_lock(dir: &Path, lock: &Lock) -> anyhow::Result<()> {
    let text = serde_json::to_string_pretty(lock)? + "\n";
    fs::write(dir.join(LOCK), text).with_context(|| format!("writing {LOCK}"))
}

/// Resolves `source` (from Git or crates.io) and reads its metadata.
fn resolve(source: &Source) -> anyhow::Result<Locked> {
    if let Some(name) = &source.krate {
        let (version, dir) = registry(name, source.version.as_deref().unwrap_or("*"))?;
        let package = rust_app::package_name(&dir.join("Cargo.toml"))?;
        let module = check(&dir, name)?;
        return Ok(Locked {
            source: source.clone(),
            commit: None,
            resolved: Some(version),
            package,
            module,
        });
    }
    let url = source.git.as_deref().context("nothing to resolve")?;
    let repo = repository(url, true)?;
    let reference = source.reference();
    let spec = match (&source.tag, &source.rev) {
        (Some(tag), _) => format!("refs/tags/{tag}^{{commit}}"),
        (_, Some(rev)) => format!("{rev}^{{commit}}"),
        _ => "HEAD^{commit}".to_owned(),
    };
    let commit = git(Some(&repo), &["rev-parse", "--verify", "--quiet", &spec])
        .or_else(|_| {
            git(
                Some(&repo),
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("origin/{reference}^{{commit}}"),
                ],
            )
        })
        .with_context(|| format!("{url}: no {reference}"))?;
    let checkout = checkout(url, &commit)?;
    let package = rust_app::package_name(&checkout.join("Cargo.toml"))?;
    let module = check(&checkout, url)?;
    Ok(Locked {
        source: source.clone(),
        commit: Some(commit),
        resolved: None,
        package,
        module,
    })
}

/// The crate `name` from crates.io, its newest version matching `req` as
/// Cargo resolves it: that version and the directory Cargo downloaded it
/// to.
fn registry(name: &str, req: &str) -> anyhow::Result<(String, PathBuf)> {
    let probe = crate::check::cache()?.join("extensions").join("registry");
    fs::create_dir_all(&probe)?;
    fs::write(
        probe.join("Cargo.toml"),
        format!(
            "[package]\nname = \"nsh-extension-probe\"\nversion = \"0.0.0\"\nedition = \"2021\"\npublish = false\n\n[lib]\npath = \"lib.rs\"\n\n[workspace]\n\n[dependencies]\n{name} = {req:?}\n"
        ),
    )?;
    fs::write(probe.join("lib.rs"), "")?;
    // Resolved anew each time: the requirement decides, not a past lock.
    let _ = fs::remove_file(probe.join("Cargo.lock"));
    let out = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .args(["metadata", "--format-version", "1", "--manifest-path"])
        .arg(probe.join("Cargo.toml"))
        .output()
        .context("running cargo")?;
    if !out.status.success() {
        bail!(
            "{name} {req} from crates.io: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let meta: serde_json::Value = serde_json::from_slice(&out.stdout)?;
    let package = meta["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| {
            p["name"] == name
                && p["source"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("registry+"))
        })
        .with_context(|| format!("{name}: not on crates.io"))?;
    let version = package["version"].as_str().unwrap_or_default().to_owned();
    let manifest = PathBuf::from(package["manifest_path"].as_str().unwrap_or_default());
    let dir = manifest.parent().context("no crate directory")?.to_owned();
    Ok((version, dunce::canonicalize(dir)?))
}

/// The directory of the extensions from `url` in nsh's cache.
fn cache_of(url: &str) -> anyhow::Result<PathBuf> {
    let hash = Sha256::digest(url.as_bytes());
    let name: String = hash[..8].iter().map(|b| format!("{b:02x}")).collect();
    let last = url
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .rsplit(['/', ':'])
        .next()
        .unwrap_or("repo")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>();
    Ok(crate::check::cache()?
        .join("extensions")
        .join(format!("{last}-{name}")))
}

/// A clone of `url` in the cache, fetched again when `fetch`.
fn repository(url: &str, fetch: bool) -> anyhow::Result<PathBuf> {
    let repo = cache_of(url)?.join("repo");
    if repo.join(".git").is_dir() {
        if fetch {
            git(
                Some(&repo),
                &["fetch", "--quiet", "--tags", "--force", "origin"],
            )?;
            git(Some(&repo), &["remote", "set-head", "origin", "--auto"]).ok();
        }
    } else {
        fs::create_dir_all(repo.parent().unwrap())?;
        let _ = fs::remove_dir_all(&repo);
        git(
            None,
            &[
                "clone",
                "--quiet",
                "--no-checkout",
                url,
                &repo.to_string_lossy(),
            ],
        )
        .with_context(|| format!("cloning {url}"))?;
    }
    Ok(repo)
}

/// The checkout of `commit` of `url` in the cache, made when missing (from
/// a clone fetched again when it lacks the commit).
fn checkout(url: &str, commit: &str) -> anyhow::Result<PathBuf> {
    let dir = cache_of(url)?.join(commit);
    if dir.join("Cargo.toml").is_file() {
        return Ok(dir);
    }
    let mut repo = repository(url, false)?;
    if git(
        Some(&repo),
        &["cat-file", "-e", &format!("{commit}^{{commit}}")],
    )
    .is_err()
    {
        repo = repository(url, true)?;
    }
    let _ = fs::remove_dir_all(&dir);
    git(Some(&repo), &["worktree", "prune"]).ok();
    git(
        Some(&repo),
        &[
            "worktree",
            "add",
            "--quiet",
            "--detach",
            &dir.to_string_lossy(),
            commit,
        ],
    )
    .with_context(|| format!("{url}: no commit {commit}"))?;
    if !dir.join("Cargo.toml").is_file() {
        bail!("{url}: no Cargo.toml at the repository's root: an extension is a Cargo library");
    }
    Ok(dunce::canonicalize(&dir)?)
}

/// Checks the extension in `dir` (from `url`) can link into this NSH:
/// a `#[native_module]` at its root, and its `nsh-core` requirement (if
/// any) matching this NSH. Its module.
fn check(dir: &Path, url: &str) -> anyhow::Result<String> {
    let manifest = fs::read_to_string(dir.join("Cargo.toml"))?;
    let module = rust_app::specifier_of(dir).with_context(|| {
        format!(
            "{url}: no #[native_module(\"...\")] at the crate's root: is this an NSH extension?"
        )
    })?;
    if let Some(req) = nsh_requirement(&manifest) {
        let req = semver::VersionReq::parse(&req)
            .with_context(|| format!("{url}: Cargo.toml: nsh-core = {req:?}"))?;
        let version = semver::Version::parse(env!("CARGO_PKG_VERSION"))?;
        if !req.matches(&version) {
            bail!("{url}: depends on nsh-core {req}, this is nsh {version}");
        }
    }
    Ok(module)
}

/// The version requirement of `nsh-core` in the `[dependencies]` of the
/// manifest `text` (`nsh-core = "0.6"` or `nsh-core = { version = "0.6", .. }`).
fn nsh_requirement(text: &str) -> Option<String> {
    for (table, line) in rust_app::toml_tables(text) {
        if table != "dependencies" {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "nsh-core" {
            continue;
        }
        let value = value.trim();
        return if value.starts_with('{') {
            rust_app::toml_string(value, "version")
        } else {
            Some(
                value
                    .split(" #")
                    .next()?
                    .trim()
                    .trim_matches('"')
                    .to_owned(),
            )
        };
    }
    None
}

/// Checks the package in `dir` is a version `source` requires (its
/// `"version"`, a Cargo version requirement), as Cargo checks a Git or
/// path dependency's `version`. A crate from crates.io is resolved to one.
fn check_version(dir: &Path, source: &Source) -> anyhow::Result<()> {
    let Some(req) = &source.version else {
        return Ok(());
    };
    let req = semver::VersionReq::parse(req)?;
    let manifest = fs::read_to_string(dir.join("Cargo.toml"))?;
    let version = package_version(&manifest)
        .with_context(|| format!("{}: Cargo.toml has no [package] version", source.id()))?;
    let version = semver::Version::parse(&version)
        .with_context(|| format!("{}: version {version:?}", source.id()))?;
    if !req.matches(&version) {
        bail!(
            "nsh.json: \"extensions\": {} requires version {req}, but it is {version}",
            source.id()
        );
    }
    Ok(())
}

/// The `[package]` version of the manifest `text`.
fn package_version(text: &str) -> Option<String> {
    let mut in_package = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_package = line == "[package]";
        } else if in_package && line.starts_with("version") {
            return rust_app::toml_string(line, "version");
        }
    }
    None
}

/// `git` with `args`, in `dir`; its trimmed output.
fn git(dir: Option<&Path>, args: &[&str]) -> anyhow::Result<String> {
    let mut cmd = Command::new("git");
    if let Some(dir) = dir {
        cmd.arg("-C").arg(dir);
    }
    let out = cmd
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .context("running git")?;
    if !out.status.success() {
        bail!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nsh_requirement_is_read() {
        let req = |t: &str| nsh_requirement(t);
        assert_eq!(
            req("[dependencies]\nnsh-core = \"0.6\"\n").as_deref(),
            Some("0.6")
        );
        assert_eq!(
            req("[dependencies]\nnsh-core = { version = \">=0.6, <0.8\", features = [\"x\"] }\n")
                .as_deref(),
            Some(">=0.6, <0.8")
        );
        assert_eq!(req("[dev-dependencies]\nnsh-core = \"0.6\"\n"), None);
        assert_eq!(
            req("[dependencies]\nnsh-core = { path = \"../core\" }\n"),
            None
        );
    }

    #[test]
    fn the_app_crate_depends_on_the_extension() {
        let manifest = "[package]\nname = \"app\"\n\n[dependencies]\nnsh-core = \"0.6\"\n";
        let at = |commit: &str| Dependency::Git {
            url: "https://x/ui".into(),
            commit: commit.into(),
        };
        let new = with_dependency(manifest, "acme-ui", &at("abc"))
            .unwrap()
            .unwrap();
        assert!(
            new.contains(
                "[dependencies]\nacme-ui = { git = \"https://x/ui\", rev = \"abc\" }\nnsh-core"
            ),
            "{new}"
        );
        // Again at another commit: the line is replaced.
        let newer = with_dependency(&new, "acme-ui", &at("def"))
            .unwrap()
            .unwrap();
        assert!(
            newer.contains("rev = \"def\"") && !newer.contains("abc"),
            "{newer}"
        );
        assert_eq!(newer.matches("acme-ui").count(), 1, "{newer}");
        assert!(
            with_dependency(&newer, "acme-ui", &at("def"))
                .unwrap()
                .is_none()
        );
        // Taken from elsewhere: an error, not a second source.
        let other = "[dependencies]\nacme-ui = \"1\"\n";
        assert!(with_dependency(other, "acme-ui", &at("abc")).is_err());
        // From crates.io and a directory.
        let krate = Dependency::Crate {
            version: "1.2.0".into(),
        };
        let new = with_dependency(manifest, "acme-ui", &krate)
            .unwrap()
            .unwrap();
        assert!(new.contains("acme-ui = \"1.2.0\""), "{new}");
        let path = Dependency::Path {
            path: "../ui".into(),
        };
        assert!(with_dependency(&new, "acme-ui", &path).is_err());
        let new = with_dependency(manifest, "acme-ui", &path)
            .unwrap()
            .unwrap();
        assert!(new.contains("acme-ui = { path = \"../ui\" }"), "{new}");
    }

    #[test]
    fn sources_are_checked() {
        let config = serde_json::json!({ "extensions": [
            "acme-ui", "acme-ui@1.2", "github:acme/ui@v1",
            { "github": "acme/ui", "rev": "abc" },
            { "git": "https://x/a", "tag": "v1" },
            { "path": "../ui" },
            { "github": "acme/ui", "tag": "v1", "version": ">=1.2, <2" },
            { "path": "../ui", "version": "~1.2" },
            "acme-ui@=1.2.3"
        ] });
        let list = sources(&config).unwrap();
        assert_eq!(list[6].version.as_deref(), Some(">=1.2, <2"));
        assert_eq!(list[7].version.as_deref(), Some("~1.2"));
        assert_eq!(list[1].krate.as_deref(), Some("acme-ui"));
        assert_eq!(list[1].version.as_deref(), Some("1.2"));
        assert_eq!(list[2].git.as_deref(), Some("https://github.com/acme/ui"));
        assert_eq!(list[2].tag.as_deref(), Some("v1"));
        assert_eq!(list[3].rev.as_deref(), Some("abc"));
        // Written back as it was.
        let back: Vec<_> = list.iter().map(Source::entry).collect();
        assert_eq!(serde_json::Value::Array(back), config["extensions"]);
        let both = serde_json::json!({ "extensions": [{ "git": "g", "tag": "v1", "rev": "abc" }] });
        assert!(sources(&both).unwrap_err().to_string().contains("both"));
        let unknown = serde_json::json!({ "extensions": [{ "git": "g", "branch": "main" }] });
        assert!(sources(&unknown).is_err());
        assert!(sources(&serde_json::json!({})).unwrap().is_empty());
        let old = serde_json::json!({ "extensions": [{ "crate": "a" }] });
        assert!(sources(&old).is_err());
        let two = serde_json::json!({ "extensions": [{ "github": "a/b", "path": "../a" }] });
        assert!(sources(&two).is_err());
        let bad = serde_json::json!({ "extensions": ["github:acme"] });
        assert!(sources(&bad).is_err());
        let req = serde_json::json!({ "extensions": [{ "path": "../a", "version": "one" }] });
        assert!(sources(&req).is_err());
    }

    #[test]
    fn versions_follow_cargo() {
        let dir = std::env::temp_dir().join(format!("nsh-ext-version-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname = \"acme-ui\"\nversion = \"1.2.5\"\n",
        )
        .unwrap();
        let with = |v: &str| Source {
            path: Some("../ui".into()),
            version: Some(v.into()),
            ..Default::default()
        };
        // "1.2" is ^1.2, as in Cargo.
        for ok in ["1.2", "^1", "~1.2", ">=1.2, <2", "=1.2.5", "*"] {
            check_version(&dir, &with(ok)).unwrap();
        }
        for no in ["1.3", "=1.2.4", "~1.1", "2"] {
            assert!(check_version(&dir, &with(no)).is_err(), "{no}");
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn add_arguments_are_parsed() {
        let git = Source::parse(
            Some("https://github.com/acme/ui".into()),
            None,
            Some("v1".into()),
            None,
        )
        .unwrap();
        assert_eq!(git.git.as_deref(), Some("https://github.com/acme/ui"));
        let gh =
            Source::parse(Some("github:acme/ui".into()), None, Some("v1".into()), None).unwrap();
        assert_eq!(gh, git);
        assert_eq!(gh.entry(), serde_json::json!("github:acme/ui@v1"));
        assert!(
            Source::parse(
                Some("github:acme/ui@v1".into()),
                None,
                Some("v2".into()),
                None
            )
            .is_err()
        );
        let krate = Source::parse(Some("acme-ui@1.2".into()), None, None, None).unwrap();
        assert_eq!(
            (krate.krate.as_deref(), krate.version.as_deref()),
            (Some("acme-ui"), Some("1.2"))
        );
        assert!(Source::parse(Some("acme-ui".into()), None, Some("v1".into()), None).is_err());
        assert!(Source::parse(Some("acme-ui@nope".into()), None, None, None).is_err());
        let path = Source::parse(None, Some("../ui".into()), None, None).unwrap();
        assert_eq!(path.path.as_deref(), Some("../ui"));
    }

    #[test]
    fn relative_paths() {
        assert_eq!(
            relative(Path::new("/a/app/rust"), Path::new("/a/ext/ui")),
            "../../ext/ui"
        );
        assert_eq!(relative(Path::new("/a"), Path::new("/a/b")), "b");
    }
}
