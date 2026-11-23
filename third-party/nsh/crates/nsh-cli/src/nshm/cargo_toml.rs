//! The app's own crate depending on its Rust nshm: the `[dependencies]`
//! line `nsh add` writes (from crates.io at the resolved version, from Git
//! at the locked commit, or from a directory), and the crate's features.

use std::{path::Path, process::Command};

use anyhow::{Context as _, bail};

use crate::rust_app;

/// How the app's crate depends on an nshm: from where, with which
/// features.
#[derive(Debug)]
pub(crate) struct Dependency {
    pub place: Place,
    pub features: Vec<String>,
}

/// Where the app's crate takes an nshm from.
#[derive(Debug, Clone)]
pub(crate) enum Place {
    Git { url: String, commit: String },
    Crate { version: String },
    Path { path: String },
}

impl Dependency {
    /// Its value in `[dependencies]`, without the crate's default features
    /// when `default_features` is false.
    fn value_with(&self, default_features: bool) -> String {
        let mut features = String::new();
        if !default_features {
            features.push_str(", default-features = false");
        }
        features.push_str(&rust_app::features_value(&self.features));
        match &self.place {
            Place::Git { url, commit } => {
                format!("{{ git = {url:?}, rev = {commit:?}{features} }}")
            }
            Place::Crate { version } if features.is_empty() => format!("{version:?}"),
            Place::Crate { version } => format!("{{ version = {version:?}{features} }}"),
            Place::Path { path } => format!("{{ path = {path:?}{features} }}"),
        }
    }

    /// Whether the dependency `line` takes the crate from the same place.
    fn same_place(&self, line: &str) -> bool {
        let git = rust_app::toml_string(line, "git");
        let path = rust_app::toml_string(line, "path");
        match &self.place {
            Place::Git { url, .. } => git.as_deref() == Some(url.as_str()),
            Place::Crate { .. } => git.is_none() && path.is_none(),
            Place::Path { .. } => path.is_some(),
        }
    }
}

/// The text after `key =` in the TOML `line`, `key` being a whole key
/// (`features` is not the end of `default-features`).
fn toml_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let mut from = 0;
    while let Some(found) = line[from..].find(key) {
        let at = from + found;
        from = at + key.len();
        let before = line[..at].trim_end();
        if !(before.is_empty() || before.ends_with('{') || before.ends_with(',')) {
            continue;
        }
        if let Some(value) = line[at + key.len()..].trim_start().strip_prefix('=') {
            let value = value.trim_start();
            // An array runs to its `]`; a scalar to the next `,` or `}`.
            return Some(if value.starts_with('[') {
                value
            } else {
                value
                    .split([',', '}'])
                    .next()
                    .unwrap_or_default()
                    .trim_end()
            });
        }
    }
    None
}

/// The features of the crate in `dir`, as Cargo reads them: its
/// `[features]` and the optional dependencies no feature names as
/// `dep:<name>`, in whichever form its manifest writes them.
pub(crate) fn crate_features(dir: &Path) -> anyhow::Result<Vec<String>> {
    let manifest = dir.join("Cargo.toml");
    let output = Command::new(rust_app::cargo())
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
            "cargo cannot read {}:\n{}",
            manifest.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("cargo metadata's output")?;
    let package = rust_app::package_name(&manifest)?;
    Ok(features_of(&metadata, &package))
}

/// The features of `package` in the `cargo metadata` output `metadata`
/// (a crate of a workspace lists the workspace's packages), sorted.
fn features_of(metadata: &serde_json::Value, package: &str) -> Vec<String> {
    metadata["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["name"].as_str() == Some(package))
        .and_then(|p| p["features"].as_object())
        .map(|features| {
            let mut names: Vec<String> = features.keys().cloned().collect();
            names.sort_unstable();
            names
        })
        .unwrap_or_default()
}

/// The strings of the inline array `key = [...]` in the TOML `line`.
fn toml_strings(line: &str, key: &str) -> Vec<String> {
    let Some(list) = toml_value(line, key).and_then(|v| v.strip_prefix('[')) else {
        return Vec::new();
    };
    let list = list.split(']').next().unwrap_or_default();
    list.split(',')
        .map(|item| item.trim().trim_matches(['"', '\'']).to_owned())
        .filter(|item| !item.is_empty())
        .collect()
}

/// `to` relative to `from`, with `/`.
pub(crate) fn relative(from: &Path, to: &Path) -> String {
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
pub(crate) fn with_dependency(
    text: &str,
    package: &str,
    dependency: &Dependency,
) -> anyhow::Result<Option<String>> {
    // Features the manifest turns on already stay on, and so does turning
    // the default ones off.
    let mut features = dependency.features.clone();
    let mut default_features = true;
    let mut table = String::new();
    for l in text.lines() {
        let t = l.trim();
        if t.starts_with('[') {
            table = t.to_owned();
        }
        if table == "[dependencies]"
            && t.split(['=', ' ']).next() == Some(package)
            && dependency.same_place(t)
        {
            for feature in toml_strings(t, "features") {
                if !features.contains(&feature) {
                    features.push(feature);
                }
            }
            if toml_value(t, "default-features") == Some("false") {
                default_features = false;
            }
        }
    }
    let dependency = &Dependency {
        place: dependency.place.clone(),
        features,
    };
    let line = format!("{package} = {}", dependency.value_with(default_features));
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

/// The manifest `text` without `package` in its `[dependencies]`, or
/// `None` when it has no such line.
pub(crate) fn without_dependency(text: &str, package: &str) -> Option<String> {
    let mut table = String::new();
    let mut found = false;
    let mut out = Vec::new();
    for l in text.lines() {
        let t = l.trim();
        if t.starts_with('[') {
            table = t.to_owned();
        }
        if table == "[dependencies]" && t.split(['=', ' ']).next() == Some(package) {
            found = true;
            continue;
        }
        out.push(l);
    }
    found.then(|| out.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_app_crate_depends_on_the_nshm() {
        let manifest = "[package]\nname = \"app\"\n\n[dependencies]\nnsh-core = \"0.6\"\n";
        let at = |commit: &str| Dependency {
            place: Place::Git {
                url: "https://x/ui".into(),
                commit: commit.into(),
            },
            features: Vec::new(),
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
        let krate = Dependency {
            place: Place::Crate {
                version: "1.2.0".into(),
            },
            features: Vec::new(),
        };
        let new = with_dependency(manifest, "acme-ui", &krate)
            .unwrap()
            .unwrap();
        assert!(new.contains("acme-ui = \"1.2.0\""), "{new}");
        let path = Dependency {
            place: Place::Path {
                path: "../ui".into(),
            },
            features: Vec::new(),
        };
        assert!(with_dependency(&new, "acme-ui", &path).is_err());
        let new = with_dependency(manifest, "acme-ui", &path)
            .unwrap()
            .unwrap();
        assert!(new.contains("acme-ui = { path = \"../ui\" }"), "{new}");
        // With the features the app turns on.
        let featured = Dependency {
            place: Place::Crate {
                version: "0.6.0".into(),
            },
            features: vec!["camera".into()],
        };
        let new = with_dependency(manifest, "nsh-extra", &featured)
            .unwrap()
            .unwrap();
        assert!(
            new.contains("nsh-extra = { version = \"0.6.0\", features = [\"camera\"] }"),
            "{new}"
        );
        let featured = Dependency {
            place: Place::Git {
                url: "https://x/extra".into(),
                commit: "abc".into(),
            },
            features: vec!["camera".into(), "push".into()],
        };
        // Features the manifest has already stay on.
        let manifest =
            "[dependencies]\nnsh-extra = { version = \"0.6.0\", features = [\"push\"] }\n";
        let more = Dependency {
            place: Place::Crate {
                version: "0.6.0".into(),
            },
            features: vec!["camera".into()],
        };
        let new = with_dependency(manifest, "nsh-extra", &more)
            .unwrap()
            .unwrap();
        assert!(
            new.contains("nsh-extra = { version = \"0.6.0\", features = [\"camera\", \"push\"] }"),
            "{new}"
        );
        assert_eq!(
            toml_strings(r#"x = { git = "u", features = ['a', "b"] }"#, "features"),
            ["a", "b"]
        );
        // `default-features` is not `features`, and stays off.
        let manifest = "[dependencies]\nacme-ui = { version = \"1.0.0\", default-features = false, features = [\"push\"] }\n";
        let camera = Dependency {
            place: Place::Crate {
                version: "1.0.0".into(),
            },
            features: vec!["camera".into()],
        };
        let new = with_dependency(manifest, "acme-ui", &camera)
            .unwrap()
            .unwrap();
        assert!(
            new.contains(
                "acme-ui = { version = \"1.0.0\", default-features = false, features = [\"camera\", \"push\"] }"
            ),
            "{new}"
        );
        assert!(toml_strings("x = { default-features = false }", "features").is_empty());
        assert_eq!(
            featured.value_with(true),
            "{ git = \"https://x/extra\", rev = \"abc\", features = [\"camera\", \"push\"] }"
        );
    }

    #[test]
    fn a_crates_features_are_read_from_its_metadata() {
        // `cargo metadata` lists a workspace's packages, implicit features
        // of optional dependencies included.
        let metadata = serde_json::json!({ "packages": [
            { "name": "acme-core", "features": { "fast": [] } },
            { "name": "acme-ui", "features": {
                "default": [],
                "camera": ["dep:tokio"],
                "serde": ["dep:serde"],
            } },
        ] });
        assert_eq!(
            features_of(&metadata, "acme-ui"),
            ["camera", "default", "serde"]
        );
        assert!(features_of(&metadata, "acme-gauge").is_empty());
        assert!(features_of(&serde_json::json!({}), "acme-ui").is_empty());
    }

    #[test]
    fn relative_paths() {
        assert_eq!(
            relative(Path::new("/a/app/rust"), Path::new("/a/ext/ui")),
            "../../ext/ui"
        );
        assert_eq!(relative(Path::new("/a"), Path::new("/a/b")), "b");
    }

    #[test]
    fn a_dependency_is_taken_out() {
        let text = "[package]\nname = \"app\"\n\n[dependencies]\nacme-ui = \"1.2.0\"\nnsh-core = \"0.6\"\n";
        assert_eq!(
            without_dependency(text, "acme-ui").unwrap(),
            "[package]\nname = \"app\"\n\n[dependencies]\nnsh-core = \"0.6\"\n"
        );
        assert_eq!(without_dependency(text, "acme"), None);
    }
}
