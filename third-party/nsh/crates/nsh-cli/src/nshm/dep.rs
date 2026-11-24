//! A dependency on an nshm as `nsh.json` `"dependencies"` declares it (an
//! app's, or an nshm's own): its package name, where it comes from, the
//! versions it accepts and the Cargo features it turns on.

use anyhow::{Context as _, bail};
use serde::Deserialize;

/// Where an nshm comes from.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Origin {
    /// crates.io.
    Registry,
    /// A Git repository at `reference`.
    Git { url: String, reference: Ref },
    /// A local directory, relative to the app's `nsh.json`.
    Path(String),
}

/// What of a Git repository to take.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Ref {
    /// Its newest tag that is a version the requirement accepts, or its
    /// default branch when it has no such tags.
    Default,
    /// A tag.
    Tag(String),
    /// A commit or a branch.
    Rev(String),
}

impl Origin {
    /// How `nsh.lock` writes it: `crates.io`, `git+<url>[?tag=<tag>|?rev=<rev>]`;
    /// `None` for a directory (the lock writes its `"path"`).
    pub(crate) fn lock_source(&self) -> Option<String> {
        match self {
            Origin::Registry => Some("crates.io".to_owned()),
            Origin::Git { url, reference } => Some(match reference {
                Ref::Default => format!("git+{url}"),
                Ref::Tag(t) => format!("git+{url}?tag={t}"),
                Ref::Rev(r) => format!("git+{url}?rev={r}"),
            }),
            Origin::Path(_) => None,
        }
    }

    /// The origin `nsh.lock` wrote as `source` (or `path`).
    pub(crate) fn from_lock(source: Option<&str>, path: Option<&str>) -> anyhow::Result<Self> {
        if let Some(path) = path {
            return Ok(Origin::Path(path.to_owned()));
        }
        let source = source.context("an entry has neither \"source\" nor \"path\"")?;
        if source == "crates.io" {
            return Ok(Origin::Registry);
        }
        let rest = source
            .strip_prefix("git+")
            .with_context(|| format!("unknown source {source:?}"))?;
        Ok(match rest.split_once('?') {
            None => Origin::Git {
                url: rest.to_owned(),
                reference: Ref::Default,
            },
            Some((url, query)) => {
                let reference = if let Some(t) = query.strip_prefix("tag=") {
                    Ref::Tag(t.to_owned())
                } else if let Some(r) = query.strip_prefix("rev=") {
                    Ref::Rev(r.to_owned())
                } else {
                    bail!("unknown source {source:?}")
                };
                Origin::Git {
                    url: url.to_owned(),
                    reference,
                }
            }
        })
    }

    /// For messages: crates.io, the repository or the directory.
    pub(crate) fn describe(&self) -> String {
        match self {
            Origin::Registry => "crates.io".to_owned(),
            Origin::Git { url, reference } => match reference {
                Ref::Default => url.clone(),
                Ref::Tag(t) => format!("{url} (tag {t})"),
                Ref::Rev(r) => format!("{url} (rev {r})"),
            },
            Origin::Path(p) => p.clone(),
        }
    }
}

/// A dependency on an nshm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Dep {
    /// The package's name: its key in `"dependencies"`.
    pub name: String,
    pub origin: Origin,
    /// The versions it accepts (a Cargo version requirement); `None`: any.
    pub req: Option<String>,
    /// Its Cargo features to turn on (an nshm with Rust).
    pub features: Vec<String>,
}

impl Dep {
    /// The parsed version requirement (`*` when there is none).
    pub(crate) fn version_req(&self) -> semver::VersionReq {
        self.req
            .as_deref()
            .and_then(|r| semver::VersionReq::parse(r).ok())
            .unwrap_or(semver::VersionReq::STAR)
    }

    /// Reads `"dependencies"` entry `name`: a crates.io version requirement
    /// (`"^0.3"`), or an object with `"version"`, `"features"` and, for an
    /// nshm not from crates.io, one of `"github"`, `"git"` or `"path"` (Git
    /// with `"tag"` or `"rev"`), as a `Cargo.toml` dependency.
    pub(crate) fn read(name: &str, value: &serde_json::Value) -> anyhow::Result<Self> {
        if !is_package_name(name) {
            bail!("dependencies: {name:?} is not a package name");
        }
        let star = |v: Option<String>| v.filter(|v| v.trim() != "*");
        if let Some(req) = value.as_str() {
            let dep = Dep {
                name: name.to_owned(),
                origin: Origin::Registry,
                req: star(Some(req.to_owned())),
                features: Vec::new(),
            };
            dep.validate()?;
            return Ok(dep);
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
            #[serde(default)]
            features: Vec<String>,
        }
        let full: Full = serde_json::from_value(value.clone()).with_context(|| {
            format!(
                "dependencies: {name} is a version requirement (\"^0.3\") or \
                 {{ \"version\", \"features\", \"github\" | \"git\" | \"path\", \"tag\" | \"rev\" }}"
            )
        })?;
        if full.git.is_some() && full.github.is_some() {
            bail!("dependencies: {name} has both \"git\" and \"github\"");
        }
        if let Some(repo) = &full.github
            && (repo.split('/').count() != 2 || repo.split('/').any(str::is_empty))
        {
            bail!("dependencies: {name}: \"github\" is \"<owner>/<repo>\"");
        }
        let git = full.git.or(full.github.as_deref().map(github_url));
        if full.tag.is_some() && full.rev.is_some() {
            bail!("dependencies: {name} has both \"tag\" and \"rev\"");
        }
        if git.is_none() && (full.tag.is_some() || full.rev.is_some()) {
            bail!("dependencies: {name}: \"tag\" and \"rev\" are for \"github\" and \"git\"");
        }
        let origin = match (git, full.path) {
            (Some(_), Some(_)) => bail!("dependencies: {name} has both a repository and a path"),
            (Some(url), None) => Origin::Git {
                url,
                reference: match (full.tag, full.rev) {
                    (Some(t), _) => Ref::Tag(t),
                    (_, Some(r)) => Ref::Rev(r),
                    _ => Ref::Default,
                },
            },
            (None, Some(path)) => Origin::Path(path),
            (None, None) => Origin::Registry,
        };
        let dep = Dep {
            name: name.to_owned(),
            req: star(full.version),
            origin,
            features: Vec::new(),
        }
        .with_features(full.features)?;
        Ok(dep)
    }

    /// Its `"dependencies"` value: the version requirement when it can be
    /// one (`"*"` for any), else the object form.
    pub(crate) fn value(&self) -> serde_json::Value {
        use serde_json::json;
        if self.origin == Origin::Registry && self.features.is_empty() {
            return json!(self.req.as_deref().unwrap_or("*"));
        }
        let mut o = serde_json::Map::new();
        match &self.origin {
            Origin::Registry => {}
            Origin::Git { url, reference } => {
                match github_repo(url) {
                    Some(repo) => o.insert("github".into(), json!(repo)),
                    None => o.insert("git".into(), json!(url)),
                };
                match reference {
                    Ref::Default => {}
                    Ref::Tag(t) => {
                        o.insert("tag".into(), json!(t));
                    }
                    Ref::Rev(r) => {
                        o.insert("rev".into(), json!(r));
                    }
                }
            }
            Origin::Path(p) => {
                o.insert("path".into(), json!(p));
            }
        }
        match &self.req {
            Some(v) => {
                o.insert("version".into(), json!(v));
            }
            None if self.origin == Origin::Registry => {
                o.insert("version".into(), json!("*"));
            }
            None => {}
        }
        if !self.features.is_empty() {
            o.insert("features".into(), json!(self.features));
        }
        serde_json::Value::Object(o)
    }

    /// The same with `features` on too, each once, in order.
    pub(crate) fn with_features(mut self, features: Vec<String>) -> anyhow::Result<Self> {
        for feature in features {
            if !self.features.contains(&feature) {
                self.features.push(feature);
            }
        }
        self.validate()?;
        Ok(self)
    }

    fn validate(&self) -> anyhow::Result<()> {
        if let Some(v) = &self.req {
            semver::VersionReq::parse(v).with_context(|| {
                format!(
                    "dependencies: {}: {v:?} is not a version requirement",
                    self.name
                )
            })?;
        }
        for feature in &self.features {
            if !is_package_name(feature) {
                bail!(
                    "dependencies: {}: {feature:?} is not a Cargo feature's name",
                    self.name
                );
            }
        }
        Ok(())
    }
}

/// The `"dependencies"` of the `nsh.json` `config` (an app's or an
/// nshm's), in its order.
pub(crate) fn read_all(config: &serde_json::Value) -> anyhow::Result<Vec<Dep>> {
    // The lists of earlier development builds, never released.
    for old in ["extensions", "modules"] {
        if config.get(old).is_some() {
            bail!(
                "nsh.json: \"{old}\" is now \"dependencies\", an object by package name: \
                 {{ \"acme-ui\": \"^1.2\", \"acme-chart\": {{ \"github\": \"acme/chart\" }} }}"
            );
        }
    }
    let Some(value) = config.get("dependencies") else {
        return Ok(Vec::new());
    };
    let map = value.as_object().context(
        "nsh.json: \"dependencies\" is an object by package name, e.g. { \"acme-ui\": \"^1.2\" }",
    )?;
    map.iter()
        .map(|(name, v)| Dep::read(name, v).map_err(|e| e.context("nsh.json")))
        .collect()
}

/// What `nsh add` was given: an nshm not named yet when it comes from Git
/// or a directory (its name is its package's).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Added {
    /// The package's name, when the source names it (crates.io).
    pub name: Option<String>,
    pub origin: Origin,
    pub req: Option<String>,
    pub features: Vec<String>,
}

impl Added {
    /// The source `nsh add` was given: a crate by default (`acme-ui`,
    /// `acme-ui@1.2`), `github:<owner>/<repo>` (`@<version requirement>`),
    /// a Git URL, or `path`; `tag`/`rev` (from `--tag`/`--rev`) apply to
    /// Git only.
    pub(crate) fn parse(
        source: Option<String>,
        path: Option<String>,
        tag: Option<String>,
        rev: Option<String>,
        features: Vec<String>,
    ) -> anyhow::Result<Self> {
        let added = match (source, path) {
            (None, Some(path)) => {
                if tag.is_some() || rev.is_some() {
                    bail!("--tag and --rev are for Git");
                }
                Added {
                    name: None,
                    // Written with a separator, never read as a crate's name.
                    origin: Origin::Path(if path.contains(['/', '\\']) || path.starts_with('.') {
                        path
                    } else {
                        format!("./{path}")
                    }),
                    req: None,
                    features: Vec::new(),
                }
            }
            (Some(s), None) => Self::short(&s, tag, rev)?,
            _ => bail!(
                "nsh add takes a crate name, github:<owner>/<repo>, a Git URL or --path <dir>"
            ),
        };
        let mut added = added;
        for feature in features {
            if !is_package_name(&feature) {
                bail!("{feature:?} is not a Cargo feature's name");
            }
            if !added.features.contains(&feature) {
                added.features.push(feature);
            }
        }
        Ok(added)
    }

    fn short(s: &str, tag: Option<String>, rev: Option<String>) -> anyhow::Result<Self> {
        let (place, req) = match s.rsplit_once('@') {
            // `git@host:...` is a URL, not a requirement.
            Some((place, req)) if !place.is_empty() && !req.contains([':', '/']) => {
                (place, Some(req.to_owned()))
            }
            _ => (s, None),
        };
        if let Some(r) = &req {
            semver::VersionReq::parse(r)
                .with_context(|| format!("{s}: {r:?} is not a version requirement"))?;
        }
        if tag.is_some() && rev.is_some() {
            bail!("give --tag or --rev, not both");
        }
        let reference = match (tag, rev) {
            (Some(t), _) => Ref::Tag(t),
            (_, Some(r)) => Ref::Rev(r),
            _ => Ref::Default,
        };
        if let Some(repo) = place.strip_prefix("github:") {
            if repo.split('/').count() != 2 || repo.split('/').any(str::is_empty) {
                bail!("{s}: write github:<owner>/<repo>");
            }
            return Ok(Added {
                name: None,
                origin: Origin::Git {
                    url: github_url(repo),
                    reference,
                },
                req,
                features: Vec::new(),
            });
        }
        if place.contains("://") || place.starts_with("git@") || place.ends_with(".git") {
            return Ok(Added {
                name: None,
                origin: Origin::Git {
                    url: place.to_owned(),
                    reference,
                },
                req,
                features: Vec::new(),
            });
        }
        if reference != Ref::Default {
            bail!("--tag and --rev are for Git; take a crate's version with {place}@<version>");
        }
        if !is_package_name(place) {
            bail!("{place:?} is not a crate's name");
        }
        Ok(Added {
            name: Some(place.to_owned()),
            origin: Origin::Registry,
            req,
            features: Vec::new(),
        })
    }
}

/// Whether `name` can be a package's or a Cargo feature's: letters,
/// digits, `_`, `-`, `+` and `.`, starting with a letter, a digit or `_`.
pub(crate) fn is_package_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+' | '.'))
}

/// `https://github.com/<repo>`.
pub(crate) fn github_url(repo: &str) -> String {
    format!("https://github.com/{repo}")
}

/// `<owner>/<repo>` of a `https://github.com/<owner>/<repo>` URL.
pub(crate) fn github_repo(url: &str) -> Option<&str> {
    let repo = url.strip_prefix("https://github.com/")?;
    (repo.split('/').count() == 2 && !repo.ends_with(".git")).then_some(repo)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn dependencies_are_read_and_written_back() {
        let config = json!({ "dependencies": {
            "nsh-omarchy": "^0.3.2",
            "acme-any": "*",
            "nsh-extra": { "version": "0.6", "features": ["camera"] },
            "acme-chart": { "github": "acme/chart", "tag": "v0.3.0" },
            "acme-icons": { "github": "acme/icons", "version": "^2" },
            "acme-grid": { "git": "https://git.example.com/ui.git", "rev": "4f2a1c0" },
            "my-gauge": { "path": "../my-gauge", "version": "~1.2" }
        } });
        let deps = read_all(&config).unwrap();
        let by = |n: &str| deps.iter().find(|d| d.name == n).unwrap();
        assert_eq!(by("nsh-omarchy").origin, Origin::Registry);
        assert_eq!(by("acme-any").req, None);
        assert_eq!(by("nsh-extra").features, ["camera"]);
        assert_eq!(
            by("acme-chart").origin,
            Origin::Git {
                url: "https://github.com/acme/chart".into(),
                reference: Ref::Tag("v0.3.0".into())
            }
        );
        assert_eq!(by("acme-icons").req.as_deref(), Some("^2"));
        assert_eq!(by("my-gauge").origin, Origin::Path("../my-gauge".into()));
        for d in &deps {
            assert_eq!(d.value(), config["dependencies"][&d.name], "{}", d.name);
        }
        for bad in [
            json!({ "dependencies": ["acme-ui"] }),
            json!({ "dependencies": { "a": { "branch": "main" } } }),
            json!({ "dependencies": { "a": "one" } }),
            json!({ "dependencies": { "a": { "github": "acme" } } }),
            json!({ "dependencies": { "a": { "github": "a/b", "path": "../a" } } }),
            json!({ "dependencies": { "a": { "github": "a/b", "tag": "v1", "rev": "x" } } }),
            json!({ "dependencies": { "a": { "tag": "v1" } } }),
            json!({ "dependencies": { "a": { "version": "1", "features": ["dep:x"] } } }),
            json!({ "dependencies": { "a b": "1" } }),
            json!({ "modules": ["acme-ui"] }),
            json!({ "extensions": ["acme-ui"] }),
        ] {
            assert!(read_all(&bad).is_err(), "{bad}");
        }
        assert!(read_all(&json!({})).unwrap().is_empty());
    }

    #[test]
    fn origins_round_trip_through_the_lock() {
        for origin in [
            Origin::Registry,
            Origin::Git {
                url: "https://github.com/a/b".into(),
                reference: Ref::Default,
            },
            Origin::Git {
                url: "https://github.com/a/b".into(),
                reference: Ref::Tag("v1".into()),
            },
            Origin::Git {
                url: "git@host:a/b.git".into(),
                reference: Ref::Rev("abc".into()),
            },
        ] {
            let source = origin.lock_source().unwrap();
            assert_eq!(Origin::from_lock(Some(&source), None).unwrap(), origin);
        }
        assert_eq!(
            Origin::from_lock(None, Some("../ui")).unwrap(),
            Origin::Path("../ui".into())
        );
        assert!(Origin::from_lock(Some("svn+x"), None).is_err());
    }

    #[test]
    fn add_arguments_are_parsed() {
        let parse = |s: &str, tag: Option<&str>, rev: Option<&str>| {
            Added::parse(
                Some(s.into()),
                None,
                tag.map(Into::into),
                rev.map(Into::into),
                Vec::new(),
            )
        };
        let gh = parse("github:acme/ui", Some("v1"), None).unwrap();
        assert_eq!(
            gh.origin,
            Origin::Git {
                url: "https://github.com/acme/ui".into(),
                reference: Ref::Tag("v1".into())
            }
        );
        let gh = parse("github:acme/ui@^1.4", None, None).unwrap();
        assert_eq!(gh.req.as_deref(), Some("^1.4"));
        assert_eq!(gh.name, None);
        let ssh = parse("git@github.com:acme/ui.git", None, None).unwrap();
        assert!(
            matches!(ssh.origin, Origin::Git { ref url, .. } if url == "git@github.com:acme/ui.git")
        );
        assert_eq!(ssh.req, None);
        let krate = parse("acme-ui@1.2", None, None).unwrap();
        assert_eq!(
            (krate.name.as_deref(), krate.req.as_deref()),
            (Some("acme-ui"), Some("1.2"))
        );
        assert!(parse("acme-ui", Some("v1"), None).is_err());
        assert!(parse("acme-ui@nope", None, None).is_err());
        assert!(parse("github:acme", None, None).is_err());
        assert!(parse("github:acme/ui", Some("v1"), Some("x")).is_err());
        let path = Added::parse(None, Some("ui".into()), None, None, vec!["a".into()]).unwrap();
        assert_eq!(path.origin, Origin::Path("./ui".into()));
        assert_eq!(path.features, ["a"]);
        assert!(Added::parse(None, None, None, None, Vec::new()).is_err());
    }
}
