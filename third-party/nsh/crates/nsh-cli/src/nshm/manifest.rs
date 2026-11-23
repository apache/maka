//! What an installed nshm says about itself.
//!
//! An nshm is a TSX nshm (an `nsh.json` with `"exports"` and no
//! `Cargo.toml`), a Rust nshm (a Cargo library with a `#[native_module]` at
//! its root), or both. A platform nshm (`"platform"`) is a crate whose
//! binary is the platform; its `#[native_module]` is optional. Its `nsh.json` is its manifest when it has
//! `"exports"` or `"platform"` (an app's `nsh.json` has neither), or when
//! there is no `Cargo.toml`:
//!
//! ```json
//! {
//!   "name": "acme-ui",
//!   "version": "1.4.0",
//!   "nsh": "^0.7",
//!   "exports": { "acme-ui": "src/index.tsx" },
//!   "dependencies": { "acme-icons": { "github": "acme/icons", "version": "^2" } }
//! }
//! ```

use std::{collections::BTreeMap, fs, path::Path};

use anyhow::{Context as _, bail};

use super::dep::{self, Dep, is_package_name};
use crate::rust_app;

/// An installed nshm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Manifest {
    /// Its package name.
    pub name: String,
    pub version: semver::Version,
    /// Its TSX: specifier → entry file, relative to its directory.
    pub exports: BTreeMap<String, String>,
    /// The nshm it depends on.
    pub dependencies: Vec<Dep>,
    /// The target it provides (`--target <platform>`): a platform nshm.
    pub platform: Option<String>,
    /// Its `#[native_module]` specifier: a Rust nshm.
    pub module: Option<String>,
}

impl Manifest {
    /// Reads the nshm in `dir`, `what` naming it in errors, and checks this
    /// NSH can use it.
    pub(crate) fn read(dir: &Path, what: &str) -> anyhow::Result<Self> {
        let cargo = dir.join("Cargo.toml");
        let cargo = cargo.is_file().then_some(cargo);
        let config: Option<serde_json::Value> = match fs::read_to_string(dir.join("nsh.json")) {
            Ok(text) => Some(
                serde_json::from_str(&text)
                    .with_context(|| format!("{what}: nsh.json is not JSON"))?,
            ),
            Err(_) => None,
        };
        let config = config.filter(|c| {
            cargo.is_none() || c.get("exports").is_some() || c.get("platform").is_some()
        });
        let (mut name, mut version, mut module) = (None, None, None);
        if let Some(cargo) = &cargo {
            let text = fs::read_to_string(cargo)?;
            name = Some(rust_app::package_name(cargo)?);
            version = Some(
                package_version(&text)
                    .with_context(|| format!("{what}: Cargo.toml has no [package] version"))?,
            );
            // A platform nshm's crate builds the platform's binary and may
            // give the app no module of its own.
            let platform = config.as_ref().is_some_and(|c| c.get("platform").is_some());
            module = rust_app::specifier_of(dir);
            if module.is_none() && !platform {
                bail!("{what}: no #[native_module(\"...\")] at the crate's root: is this an nshm?");
            }
            if let Some(req) = nsh_core_requirement(&text) {
                check_nsh(&req, &format!("{what}: Cargo.toml: nsh-core"))?;
            }
        }
        let Some(config) = config else {
            if cargo.is_none() {
                bail!("{what}: not an nshm: it has neither nsh.json nor Cargo.toml");
            }
            return Self::finish(
                dir,
                what,
                name,
                version,
                BTreeMap::new(),
                Vec::new(),
                None,
                module,
            );
        };
        let field = |key: &str| config.get(key).and_then(|v| v.as_str()).map(str::to_owned);
        match (&name, field("name")) {
            (Some(cargo), Some(own)) if *cargo != own => {
                bail!("{what}: nsh.json names it {own:?}, Cargo.toml {cargo:?}")
            }
            (None, own) => name = own,
            _ => {}
        }
        match (&version, field("version")) {
            (Some(cargo), Some(own)) if *cargo != own => {
                bail!("{what}: nsh.json's version is {own}, Cargo.toml's {cargo}")
            }
            (None, own) => version = own,
            _ => {}
        }
        if let Some(req) = field("nsh") {
            check_nsh(&req, &format!("{what}: nsh.json: \"nsh\""))?;
        }
        let exports = match config.get("exports") {
            None => BTreeMap::new(),
            Some(v) => serde_json::from_value::<BTreeMap<String, String>>(v.clone()).with_context(
                || format!("{what}: nsh.json: \"exports\" maps specifiers to files"),
            )?,
        };
        let dependencies = dep::read_all(&config).map_err(|e| e.context(what.to_string()))?;
        let platform = field("platform");
        Self::finish(
            dir,
            what,
            name,
            version,
            exports,
            dependencies,
            platform,
            module,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn finish(
        dir: &Path,
        what: &str,
        name: Option<String>,
        version: Option<String>,
        exports: BTreeMap<String, String>,
        dependencies: Vec<Dep>,
        platform: Option<String>,
        module: Option<String>,
    ) -> anyhow::Result<Self> {
        let name = name.with_context(|| format!("{what}: nsh.json has no \"name\""))?;
        if !is_package_name(&name) {
            bail!("{what}: {name:?} is not a package name");
        }
        let version = version.with_context(|| format!("{what}: nsh.json has no \"version\""))?;
        let version = semver::Version::parse(&version)
            .with_context(|| format!("{what}: version {version:?} is not a semver version"))?;
        if module.is_none() && exports.is_empty() && platform.is_none() {
            bail!("{what}: nsh.json has no \"exports\": a TSX nshm names its entry files there");
        }
        for (specifier, file) in &exports {
            if specifier != &name && !specifier.starts_with(&format!("{name}/")) {
                bail!("{what}: exports: {specifier:?} is not {name:?} or below it ({name}/...)");
            }
            if Some(specifier) == module.as_ref() {
                bail!("{what}: exports: {specifier:?} is its Rust module's specifier too");
            }
            if Path::new(file).is_absolute() || file.split(['/', '\\']).any(|p| p == "..") {
                bail!("{what}: exports: {file:?} is not a file inside the nshm");
            }
            if !dir.join(file).is_file() {
                bail!("{what}: exports: {specifier}: no file {file}");
            }
        }
        if let Some(p) = &platform {
            if !dir.join("Cargo.toml").is_file() {
                bail!("{what}: \"platform\" is for an nshm with Rust (it builds the platform)");
            }
            if !crate::platforms::valid_name(p) {
                bail!("{what}: platform {p:?}: lower-case letters, digits and dashes");
            }
        }
        Ok(Manifest {
            name,
            version,
            exports,
            dependencies,
            platform,
            module,
        })
    }
}

/// Checks this NSH is a version `req` accepts.
fn check_nsh(req: &str, what: &str) -> anyhow::Result<()> {
    let parsed = semver::VersionReq::parse(req)
        .with_context(|| format!("{what}: {req:?} is not a version requirement"))?;
    let mut version = semver::Version::parse(env!("CARGO_PKG_VERSION"))?;
    // A nightly counts as its release, as an app's `"nsh"` does.
    version.pre = semver::Prerelease::EMPTY;
    if !parsed.matches(&version) {
        bail!("{what} requires nsh {req}; this is nsh {version}");
    }
    Ok(())
}

/// The `[package]` version of the manifest `text`.
pub(crate) fn package_version(text: &str) -> Option<String> {
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

/// The version requirement of `nsh-core` in the `[dependencies]` of the
/// manifest `text` (`nsh-core = "0.6"` or `nsh-core = { version = "0.6", .. }`).
pub(crate) fn nsh_core_requirement(text: &str) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(label: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nsh-manifest-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("src")).unwrap();
        d
    }

    #[test]
    fn a_tsx_nshm_is_read() {
        let d = dir("tsx");
        fs::write(d.join("src/index.tsx"), "export const a = 1;").unwrap();
        fs::write(
            d.join("nsh.json"),
            r#"{ "name": "acme-ui", "version": "1.4.0", "nsh": ">=0.1",
                "exports": { "acme-ui": "src/index.tsx" },
                "dependencies": { "acme-icons": { "github": "acme/icons", "version": "^2" } } }"#,
        )
        .unwrap();
        let m = Manifest::read(&d, "acme-ui").unwrap();
        assert_eq!(m.name, "acme-ui");
        assert_eq!(m.version.to_string(), "1.4.0");
        assert_eq!(m.exports["acme-ui"], "src/index.tsx");
        assert_eq!(m.dependencies[0].name, "acme-icons");
        assert_eq!(m.module, None);
        // An export outside it, of another name, or missing: refused.
        for exports in [
            r#"{ "acme-ui": "../x.tsx" }"#,
            r#"{ "other": "src/index.tsx" }"#,
            r#"{ "acme-ui": "src/none.tsx" }"#,
            r#"{}"#,
        ] {
            fs::write(
                d.join("nsh.json"),
                format!(r#"{{ "name": "acme-ui", "version": "1.4.0", "exports": {exports} }}"#),
            )
            .unwrap();
            assert!(Manifest::read(&d, "acme-ui").is_err(), "{exports}");
        }
        // A newer NSH required.
        fs::write(
            d.join("nsh.json"),
            r#"{ "name": "acme-ui", "version": "1.4.0", "nsh": ">=99", "exports": { "acme-ui": "src/index.tsx" } }"#,
        )
        .unwrap();
        let err = Manifest::read(&d, "acme-ui").unwrap_err().to_string();
        assert!(err.contains("requires nsh >=99"), "{err}");
        fs::remove_dir_all(&d).unwrap();
        let empty = dir("empty");
        assert!(Manifest::read(&empty, "x").is_err());
        fs::remove_dir_all(&empty).unwrap();
    }

    #[test]
    fn a_rust_nshm_is_read_from_its_crate() {
        let d = dir("rust");
        fs::write(
            d.join("Cargo.toml"),
            "[package]\nname = \"acme-gauge\"\nversion = \"0.2.0\"\n\n[dependencies]\nnsh-core = \">=0.1\"\n",
        )
        .unwrap();
        fs::write(
            d.join("src/lib.rs"),
            "#[native_module(\"acme-gauge\")]\nfn native(r: &mut Registry) {}\n",
        )
        .unwrap();
        // An app's nsh.json beside it (a demo) is not its manifest.
        fs::write(
            d.join("nsh.json"),
            r#"{ "name": "Gauge Demo", "version": "9.0.0" }"#,
        )
        .unwrap();
        let m = Manifest::read(&d, "acme-gauge").unwrap();
        assert_eq!(m.name, "acme-gauge");
        assert_eq!(m.module.as_deref(), Some("acme-gauge"));
        assert!(m.dependencies.is_empty());
        // A platform nshm.
        fs::write(
            d.join("nsh.json"),
            r#"{ "platform": "harmony", "exports": {} }"#,
        )
        .unwrap();
        let m = Manifest::read(&d, "acme-gauge").unwrap();
        assert_eq!(m.platform.as_deref(), Some("harmony"));
        // A platform nshm's crate needs no module of its own: it builds the
        // platform's binary.
        fs::write(d.join("src/lib.rs"), "pub fn backend() {}\n").unwrap();
        let m = Manifest::read(&d, "acme-gauge").unwrap();
        assert_eq!(m.platform.as_deref(), Some("harmony"));
        assert_eq!(m.module, None);
        fs::write(d.join("nsh.json"), r#"{ "exports": {} }"#).unwrap();
        assert!(Manifest::read(&d, "acme-gauge").is_err());
        fs::write(
            d.join("src/lib.rs"),
            "#[native_module(\"acme-gauge\")]\nfn native(r: &mut Registry) {}\n",
        )
        .unwrap();
        fs::write(
            d.join("nsh.json"),
            r#"{ "platform": "harmony", "exports": {} }"#,
        )
        .unwrap();
        fs::write(d.join("nsh.json"), r#"{ "name": "other", "exports": {} }"#).unwrap();
        assert!(Manifest::read(&d, "acme-gauge").is_err());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn nsh_core_requirement_is_read() {
        let req = |t: &str| nsh_core_requirement(t);
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
}
