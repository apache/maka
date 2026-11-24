//! What the app's crates and nshm need of the packaged app: `Info.plist`
//! keys and entitlements on iOS and macOS, permissions and manifest entries on
//! Android, which a crate declares in its `Cargo.toml`:
//!
//! ```toml
//! [package.metadata.nsh.ios.infoPlist]      # always, when the crate is linked
//! NSExampleUsageDescription = "..."
//!
//! [package.metadata.nsh.macos.entitlements] # always, when the crate is linked
//! "com.apple.security.network.client" = true
//!
//! [package.metadata.nsh.features.camera.ios.infoPlist]   # when `camera` is on
//! NSCameraUsageDescription = "The app takes photos with the camera."
//!
//! [package.metadata.nsh.features.camera.ios.infoPlistStrings.zh-Hans]
//! NSCameraUsageDescription = "..."
//!
//! [package.metadata.nsh.features.camera.macos.infoPlistStrings.zh-Hans]
//! NSCameraUsageDescription = "..."
//!
//! [package.metadata.nsh.features.camera.android]
//! permissions = ["android.permission.CAMERA"]
//! queries = ['<intent><action android:name="android.media.action.IMAGE_CAPTURE"/></intent>']
//! application = ['<service android:name="..." android:exported="false"/>']
//! libraries = ["android/libs/scanner-glue.jar"]
//! ```
//!
//! Every package in the generated workspace's dependency graph is read, so
//! a crate the app's own crate depends on (by path, Git or crates.io) counts
//! as an nshm `nsh add` lists does, with the features Cargo turns on for it.
//! The crates' entries are merged ([`ModuleMeta::from_metadata`]): arrays
//! are joined without repeats, and a key two crates set to different values
//! is a clash. The app's own `nsh.json` wins over all of them
//! ([`ModuleMeta::apply`]): a key it sets keeps its value (arrays joined),
//! which also settles a clash; a clash the app leaves open is an error
//! naming both crates. Keys NSH sets itself are refused, naming the crate.
//!
//! A crate's `ios.infoPlistStrings` translates the keys the crates set in
//! `ios.infoPlist`, as the crates word them, and its
//! `macos.infoPlistStrings` those of `macos.infoPlist`; a translation of a key no
//! crate sets (its feature off) is left out with a warning. The app takes
//! them for the languages it declares only, and none for a key it sets
//! itself, which the crates' translations would not say
//! ([`ModuleMeta::crate_strings`]).
//!
//! `ios.infoPlist`, `ios.infoPlistStrings`, `ios.entitlements`,
//! `macos.infoPlist`, `macos.infoPlistStrings`, `macos.entitlements` (named
//! as in `nsh.json`),
//! `android.permissions` (checked and spelled out as `nsh.json`'s are),
//! `android.queries`
//! (`<intent>`, `<package>` and `<provider>` elements) and
//! `android.application` (`<service>`, `<receiver>`, `<provider>`,
//! `<activity>` and `<meta-data>` elements) and `android.libraries` (jar,
//! AAR and dex files, relative to the directory of the crate's `Cargo.toml`,
//! which [`crate::android`] packages) are read; `android.manifestPlaceholders`
//! is an error (only the app sets them); other keys are
//! reported and left out. Each Android entry is one balanced element of
//! those, so a crate cannot close `<application>` or `<queries>` to write
//! elsewhere in the manifest.

use std::{collections::BTreeMap, path::Path, process::Command};

use anyhow::{Context as _, bail};
use serde_json::{Map, Value};

use crate::{android::Library, apple::ApplePlatform, package::AppConfig, ui};

/// The elements `android.queries` takes.
const QUERY_ELEMENTS: &[&str] = &["intent", "package", "provider"];

/// The elements `android.application` takes: components and their
/// metadata, never the `<application>` element's own attributes.
const APPLICATION_ELEMENTS: &[&str] = &["service", "receiver", "provider", "activity", "meta-data"];

/// What the crates of an app declare for its packages.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct ModuleMeta {
    /// `Info.plist` keys of iOS packages.
    pub(crate) ios_info: Map<String, Value>,
    /// `Info.plist` strings of iOS packages in other languages: by
    /// language, an object of texts (`nsh.json`'s `ios.infoPlistStrings`).
    pub(crate) ios_strings: Map<String, Value>,
    /// Entitlements of iOS packages.
    pub(crate) ios_entitlements: Map<String, Value>,
    /// `Info.plist` keys of macOS packages.
    pub(crate) macos_info: Map<String, Value>,
    /// Entitlements of macOS packages.
    pub(crate) macos_entitlements: Map<String, Value>,
    /// `Info.plist` strings of macOS packages in other languages, as
    /// [`Self::ios_strings`] (`nsh.json`'s `macos.infoPlistStrings`).
    pub(crate) macos_strings: Map<String, Value>,
    /// Android permissions (`<uses-permission>`).
    pub(crate) android_permissions: Vec<String>,
    /// Elements of the manifest's `<queries>`.
    pub(crate) android_queries: Vec<String>,
    /// Elements of the manifest's `<application>`.
    pub(crate) android_application: Vec<String>,
    /// Java libraries (jar and dex files), each file once.
    pub(crate) android_libraries: Vec<Library>,
    /// Which package set each key, for errors.
    owners: BTreeMap<String, String>,
    /// Keys two crates set to different values: the first crate's value is
    /// kept until the app's `nsh.json` settles it ([`ModuleMeta::apply`]).
    clashes: Vec<Clash>,
}

/// The platform a package or development host is made for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Platform {
    /// iOS, its simulator and Mac Catalyst.
    Ios,
    /// macOS (AppKit).
    Macos,
    Android,
}

/// A key two crates set to different values.
#[derive(Debug, Clone, PartialEq)]
struct Clash {
    /// `ios.infoPlist`, `ios.infoPlistStrings`, `ios.entitlements`,
    /// `macos.infoPlist`, `macos.infoPlistStrings` or `macos.entitlements`,
    /// the same in `nsh.json`.
    kind: &'static str,
    /// The key; a language's, `<lang>.<key>`, in `infoPlistStrings`.
    key: String,
    /// The crate whose value is kept, and the one that disagrees.
    first: String,
    second: String,
}

impl Clash {
    fn applies_to(&self, platform: Platform) -> bool {
        matches!(
            (platform, self.kind),
            (
                Platform::Ios,
                "ios.infoPlist" | "ios.infoPlistStrings" | "ios.entitlements"
            ) | (
                Platform::Macos,
                "macos.infoPlist" | "macos.infoPlistStrings" | "macos.entitlements"
            )
        )
    }
}

impl std::fmt::Display for Clash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} and {} set `{}` ({}) to different values: set it in the app's nsh.json `{}` to choose",
            self.first, self.second, self.key, self.kind, self.kind
        )
    }
}

impl ModuleMeta {
    /// What the packages of the generated workspace `manifest` declare, as
    /// Cargo resolves it for `triples` together (none: every platform): a
    /// universal macOS package links the crates of both its architectures,
    /// so one reading of both finds what two of them disagree on.
    pub(crate) fn of_workspace(manifest: &Path, triples: &[&str]) -> anyhow::Result<Self> {
        let (meta, warnings) = Self::read_workspace(manifest, triples)?;
        for warning in warnings {
            ui::warn(warning);
        }
        Ok(meta)
    }

    /// [`Self::of_workspace`], with the warnings about what was left out
    /// returned rather than shown.
    pub(crate) fn read_workspace(
        manifest: &Path,
        triples: &[&str],
    ) -> anyhow::Result<(Self, Vec<String>)> {
        let mut cmd = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
        cmd.args(["metadata", "--format-version", "1", "--manifest-path"])
            .arg(manifest);
        for triple in triples {
            cmd.args(["--filter-platform", triple]);
        }
        let out = cmd
            .output()
            .context("running cargo metadata for the app's crates")?;
        if !out.status.success() {
            bail!(
                "cargo metadata failed for the app's crates:\n{}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        let json: Value =
            serde_json::from_slice(&out.stdout).context("cargo metadata printed no JSON")?;
        Self::from_metadata(&json)
    }

    /// What `cargo metadata`'s output `json` declares: each resolved
    /// package's `[package.metadata.nsh]`, its sections for the features
    /// Cargo turned on; and the warnings about what was left out.
    pub(crate) fn from_metadata(json: &Value) -> anyhow::Result<(Self, Vec<String>)> {
        let packages: BTreeMap<&str, &Value> = json["packages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| Some((p["id"].as_str()?, p)))
            .collect();
        let mut meta = ModuleMeta::default();
        let mut warnings = Vec::new();
        let mut nodes: Vec<&Value> = json["resolve"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .collect();
        // One order whatever Cargo printed: errors and arrays stay stable.
        nodes.sort_by_key(|n| n["id"].as_str().unwrap_or_default());
        for node in nodes {
            let Some(package) = node["id"].as_str().and_then(|id| packages.get(id)) else {
                continue;
            };
            let Some(nsh) = package["metadata"]["nsh"].as_object() else {
                continue;
            };
            let name = package["name"].as_str().unwrap_or("?");
            // What the crate's paths are relative to.
            let dir = package["manifest_path"]
                .as_str()
                .and_then(|manifest| Path::new(manifest).parent());
            meta.merge_section(name, dir, "[package.metadata.nsh]", nsh, &mut warnings)?;
            let features = nsh.get("features").and_then(Value::as_object);
            let enabled = node["features"].as_array().into_iter().flatten();
            for feature in enabled.filter_map(Value::as_str) {
                if let Some(section) = features
                    .and_then(|f| f.get(feature))
                    .and_then(Value::as_object)
                {
                    let at = format!("[package.metadata.nsh.features.{feature}]");
                    meta.merge_section(name, dir, &at, section, &mut warnings)?;
                }
            }
        }
        meta.drop_untranslatable(&mut warnings);
        Ok((meta, warnings))
    }

    /// Merges one section (`at`, of package `name` in `dir`): its `ios`,
    /// `macos` and `android` tables.
    fn merge_section(
        &mut self,
        name: &str,
        dir: Option<&Path>,
        at: &str,
        section: &Map<String, Value>,
        warnings: &mut Vec<String>,
    ) -> anyhow::Result<()> {
        for (key, value) in section {
            match key.as_str() {
                // Read by itself: a feature's section is merged only when on.
                "features" if at == "[package.metadata.nsh]" => {}
                "ios" => self.merge_apple(name, at, ApplePlatform::Ios, value, warnings)?,
                "macos" => self.merge_apple(name, at, ApplePlatform::Macos, value, warnings)?,
                "android" => self.merge_android(name, dir, at, value, warnings)?,
                _ => warnings.push(format!(
                    "{name}: {at} `{key}` is not something this nsh reads: left out"
                )),
            }
        }
        Ok(())
    }

    fn merge_apple(
        &mut self,
        name: &str,
        at: &str,
        platform: ApplePlatform,
        table: &Value,
        warnings: &mut Vec<String>,
    ) -> anyhow::Result<()> {
        let section = platform.key();
        let table = table
            .as_object()
            .with_context(|| format!("{name}: {at} `{section}` is a table"))?;
        for (key, value) in table {
            let kind = match (platform, key.as_str()) {
                (ApplePlatform::Ios, "infoPlist") => "ios.infoPlist",
                (ApplePlatform::Ios, "infoPlistStrings") => "ios.infoPlistStrings",
                (ApplePlatform::Ios, "entitlements") => "ios.entitlements",
                (ApplePlatform::Macos, "infoPlist") => "macos.infoPlist",
                (ApplePlatform::Macos, "infoPlistStrings") => "macos.infoPlistStrings",
                (ApplePlatform::Macos, "entitlements") => "macos.entitlements",
                _ => {
                    warnings.push(format!(
                        "{name}: {at} `{section}.{key}` is not something this nsh reads: left out"
                    ));
                    continue;
                }
            };
            let entries = value
                .as_object()
                .with_context(|| format!("{name}: {at} `{kind}` is a table"))?;
            match kind {
                "ios.infoPlistStrings" | "macos.infoPlistStrings" => {
                    for (language, texts) in entries {
                        crate::apple::check_language(language)
                            .map_err(|why| anyhow::anyhow!("{name}: {at} `{kind}`: {why}"))?;
                        let texts = texts.as_object().with_context(|| {
                            format!("{name}: {at} `{kind}.{language}` is a table")
                        })?;
                        for (entry, text) in texts {
                            if !crate::apple::is_translatable_info(platform, entry) {
                                bail!(
                                    "{name}: {at} `{kind}.{language}.{entry}` is a key NSH sets itself"
                                );
                            }
                            if !text.is_string() {
                                bail!("{name}: {at} `{kind}.{language}.{entry}` is a string");
                            }
                        }
                        let strings = match platform {
                            ApplePlatform::Ios => &mut self.ios_strings,
                            ApplePlatform::Macos => &mut self.macos_strings,
                        };
                        let target = strings
                            .entry(language.clone())
                            .or_insert_with(|| Value::Object(Map::new()))
                            .as_object_mut()
                            .expect("languages hold objects");
                        merge_entries(
                            target,
                            texts,
                            Entries {
                                kind,
                                prefix: &format!("{language}."),
                                name,
                            },
                            &mut self.owners,
                            &mut self.clashes,
                        );
                    }
                }
                _ => {
                    for entry in entries.keys() {
                        let reserved = match kind {
                            "ios.infoPlist" => {
                                crate::apple::is_reserved_info(ApplePlatform::Ios, entry)
                            }
                            "macos.infoPlist" => {
                                crate::apple::is_reserved_info(ApplePlatform::Macos, entry)
                            }
                            _ => crate::apple::is_reserved_entitlement(entry),
                        };
                        if reserved {
                            bail!("{name}: {at} `{kind}.{entry}` is a key NSH sets itself");
                        }
                    }
                    let target = match kind {
                        "ios.infoPlist" => &mut self.ios_info,
                        "ios.entitlements" => &mut self.ios_entitlements,
                        "macos.infoPlist" => &mut self.macos_info,
                        _ => &mut self.macos_entitlements,
                    };
                    merge_entries(
                        target,
                        entries,
                        Entries {
                            kind,
                            prefix: "",
                            name,
                        },
                        &mut self.owners,
                        &mut self.clashes,
                    );
                }
            }
        }
        Ok(())
    }

    /// Leaves out, with a warning, the translations of keys no crate sets
    /// in `ios.infoPlist` (`macos.infoPlist` for macOS's) as Cargo
    /// resolved the app: their translations are of the crates' wording. A
    /// translation outside the feature that sets its key is no error, so an
    /// app without the feature, or an Android package, is not stopped by
    /// it.
    fn drop_untranslatable(&mut self, warnings: &mut Vec<String>) {
        for (strings, info, section) in [
            (&mut self.ios_strings, &self.ios_info, "ios"),
            (&mut self.macos_strings, &self.macos_info, "macos"),
        ] {
            for (language, texts) in strings.iter_mut() {
                let Some(texts) = texts.as_object_mut() else {
                    continue;
                };
                texts.retain(|key, _| {
                    if info.contains_key(key) {
                        return true;
                    }
                    let owner = self
                        .owners
                        .get(&format!("{section}.infoPlistStrings.{language}.{key}"))
                        .map_or("a crate", String::as_str);
                    warnings.push(format!(
                        "{owner}: `{section}.infoPlistStrings.{language}.{key}` translates a key \
                         no crate sets in `{section}.infoPlist` (with the features on): left out"
                    ));
                    let (kind, at) = (
                        format!("{section}.infoPlistStrings"),
                        format!("{language}.{key}"),
                    );
                    self.clashes
                        .retain(|clash| clash.kind != kind || clash.key != at);
                    false
                });
            }
            strings.retain(|_, texts| texts.as_object().is_some_and(|texts| !texts.is_empty()));
        }
    }

    /// The crates' translations `platform`'s packages take, by language:
    /// those of the languages the app declares (its `locales`, or its own
    /// `<platform>.infoPlistStrings`), so a crate never adds a language to
    /// the app; and none of a key the app words itself in its
    /// `<platform>.infoPlist`, which the crates' translations of their own
    /// wording would not say.
    pub(crate) fn crate_strings(
        &self,
        config: &AppConfig,
        platform: ApplePlatform,
    ) -> Map<String, Value> {
        let (crates, info, own) = match platform {
            ApplePlatform::Ios => (
                &self.ios_strings,
                &config.ios.info_plist,
                &config.ios.info_plist_strings,
            ),
            ApplePlatform::Macos => (
                &self.macos_strings,
                &config.macos.info_plist,
                &config.macos.info_plist_strings,
            ),
        };
        let declared = |language: &str| {
            config.localizations.iter().any(|l| l == language) || own.contains_key(language)
        };
        crates
            .iter()
            .filter(|(language, _)| declared(language))
            .filter_map(|(language, texts)| {
                let texts: Map<String, Value> = texts
                    .as_object()?
                    .iter()
                    .filter(|(key, _)| !info.contains_key(*key))
                    .map(|(key, text)| (key.clone(), text.clone()))
                    .collect();
                (!texts.is_empty()).then(|| (language.clone(), Value::Object(texts)))
            })
            .collect()
    }

    fn merge_android(
        &mut self,
        name: &str,
        dir: Option<&Path>,
        at: &str,
        android: &Value,
        warnings: &mut Vec<String>,
    ) -> anyhow::Result<()> {
        let android = android
            .as_object()
            .with_context(|| format!("{name}: {at} `android` is a table"))?;
        for (key, value) in android {
            let strings = || -> anyhow::Result<Vec<String>> {
                value
                    .as_array()
                    .and_then(|list| {
                        list.iter()
                            .map(|v| v.as_str().map(str::to_owned))
                            .collect::<Option<Vec<_>>>()
                    })
                    .with_context(|| format!("{name}: {at} `android.{key}` is a list of strings"))
            };
            match key.as_str() {
                "permissions" => {
                    let at = format!("{name}: {at} `android.permissions`");
                    let names = strings()?;
                    warnings.extend(
                        names
                            .iter()
                            .filter_map(|p| crate::package::lower_case_android_warning(p, &at)),
                    );
                    let names = names
                        .iter()
                        .map(|p| crate::package::android_permission(p, &at))
                        .collect::<anyhow::Result<Vec<_>>>()?;
                    join_strings(&mut self.android_permissions, names);
                }
                "queries" => {
                    let elements = strings()?;
                    for e in &elements {
                        check_element(e, QUERY_ELEMENTS)
                            .with_context(|| format!("{name}: {at} `android.queries`"))?;
                    }
                    join_strings(&mut self.android_queries, elements);
                }
                "application" => {
                    let elements = strings()?;
                    for e in &elements {
                        check_element(e, APPLICATION_ELEMENTS)
                            .with_context(|| format!("{name}: {at} `android.application`"))?;
                    }
                    join_strings(&mut self.android_application, elements);
                }
                "libraries" => {
                    let listed = format!("{name}: {at} `android.libraries`");
                    let dir = dir.with_context(|| {
                        format!("{listed}: cargo metadata names no Cargo.toml for the crate")
                    })?;
                    let libraries = strings()?
                        .into_iter()
                        .map(|path| Library {
                            path: dir.join(path),
                            listed: listed.clone(),
                            owner: Some(name.to_owned()),
                        })
                        .collect();
                    join_libraries(&mut self.android_libraries, libraries);
                }
                // A placeholder's value (a service's key) is the app's: a
                // crate's default would ship in every app that uses it.
                "manifestPlaceholders" => bail!(
                    "{name}: {at} `android.manifestPlaceholders`: only the app sets placeholders, \
                     in its nsh.json: their values are the app's"
                ),
                _ => warnings.push(format!(
                    "{name}: {at} `android.{key}` is not something this nsh reads: left out"
                )),
            }
        }
        Ok(())
    }

    /// Adds what the crates declare to the app's `config` (its `nsh.json`):
    /// a key the app sets keeps the app's value, its arrays joined with
    /// the crates' entries; permissions are joined. For an iOS or macOS
    /// `platform`, a key two crates set to different values that the app does
    /// not set is an error naming both.
    pub(crate) fn apply(&self, config: &mut AppConfig, platform: Platform) -> anyhow::Result<()> {
        for clash in self.clashes.iter().filter(|c| c.applies_to(platform)) {
            let settled = match clash.kind {
                "ios.infoPlist" => config.ios.info_plist.contains_key(&clash.key),
                "ios.infoPlistStrings" | "macos.infoPlistStrings" => {
                    let (apple, info, own) = if clash.kind.starts_with("macos.") {
                        (
                            ApplePlatform::Macos,
                            &config.macos.info_plist,
                            &config.macos.info_plist_strings,
                        )
                    } else {
                        (
                            ApplePlatform::Ios,
                            &config.ios.info_plist,
                            &config.ios.info_plist_strings,
                        )
                    };
                    let (language, key) = clash.key.split_once('.').unwrap_or_default();
                    // A language the app does not declare and a key
                    // the app words itself take none of the crates'.
                    !self.crate_strings(config, apple).contains_key(language)
                        || info.contains_key(key)
                        || own
                            .get(language)
                            .and_then(Value::as_object)
                            .is_some_and(|texts| texts.contains_key(key))
                }
                "ios.entitlements" => config.ios.entitlements.contains_key(&clash.key),
                "macos.infoPlist" => config.macos.info_plist.contains_key(&clash.key),
                _ => config.macos.entitlements.contains_key(&clash.key),
            };
            if !settled {
                bail!("{clash}");
            }
        }
        // Before the crates' keys join the app's ([`Self::crate_strings`]).
        let ios_strings = self.crate_strings(config, ApplePlatform::Ios);
        let macos_strings = self.crate_strings(config, ApplePlatform::Macos);
        add_strings(&mut config.ios.info_plist_strings, &ios_strings);
        add_strings(&mut config.macos.info_plist_strings, &macos_strings);
        under(&mut config.ios.info_plist, &self.ios_info);
        under(&mut config.ios.entitlements, &self.ios_entitlements);
        under(&mut config.macos.info_plist, &self.macos_info);
        under(&mut config.macos.entitlements, &self.macos_entitlements);
        join_strings(
            &mut config.android.permissions,
            self.android_permissions.clone(),
        );
        join_strings(&mut config.android.queries, self.android_queries.clone());
        join_strings(
            &mut config.android.application,
            self.android_application.clone(),
        );
        // The app's own first, then the crates'.
        join_libraries(
            &mut config.android.libraries,
            self.android_libraries.clone(),
        );
        Ok(())
    }
}

/// What the current app's crates declare for a development host built for
/// `triple`: nothing when the app has no crates; a failure is reported and
/// nothing taken, so the session still runs.
pub(crate) fn for_dev_host(triple: &str, platform: Platform) -> ModuleMeta {
    let Some(app) = crate::rust_app::current() else {
        return ModuleMeta::default();
    };
    let meta = ModuleMeta::of_workspace(&app.workspace().join("Cargo.toml"), &[triple])
        .unwrap_or_else(|e| {
            ui::warn(format!(
                "the development host leaves out what the app's crates declare: {e:#}"
            ));
            ModuleMeta::default()
        });
    // The host is the same for every app: it takes the first crate's value,
    // where a package takes the app's.
    for clash in meta.clashes.iter().filter(|c| c.applies_to(platform)) {
        ui::warn(format!(
            "{clash}; the development host takes {}'s",
            clash.first
        ));
    }
    meta
}

/// Adds the crates' translations (`from`, by language) to the app's
/// (`app`, `ios.infoPlistStrings` or `macos.infoPlistStrings`): the app's
/// text wins.
pub(crate) fn add_strings(app: &mut Map<String, Value>, from: &Map<String, Value>) {
    for (language, texts) in from {
        // Another form is refused when `nsh.json` is read.
        if let (Value::Object(app), Some(texts)) = (
            app.entry(language.clone())
                .or_insert_with(|| Value::Object(Map::new())),
            texts.as_object(),
        ) {
            under(app, texts);
        }
    }
}

/// Adds `from` to `app`: the app's value wins, arrays are joined.
pub(crate) fn under(app: &mut Map<String, Value>, from: &Map<String, Value>) {
    for (key, value) in from {
        match app.get_mut(key) {
            None => {
                app.insert(key.clone(), value.clone());
            }
            Some(Value::Array(have)) => {
                join(have, value.as_array().into_iter().flatten().cloned());
            }
            Some(_) => {}
        }
    }
}

/// Where [`merge_entries`] merges: the `nsh.json` key the entries are of,
/// the prefix of their keys in it (a language's), and the crate.
struct Entries<'a> {
    kind: &'static str,
    prefix: &'a str,
    name: &'a str,
}

/// Merges the `entries` of a crate into `target`: arrays are joined, a
/// value another crate set differently is a clash.
fn merge_entries(
    target: &mut Map<String, Value>,
    entries: &Map<String, Value>,
    Entries { kind, prefix, name }: Entries<'_>,
    owners: &mut BTreeMap<String, String>,
    clashes: &mut Vec<Clash>,
) {
    for (entry, value) in entries {
        let owner = format!("{kind}.{prefix}{entry}");
        match target.get_mut(entry) {
            None => {
                target.insert(entry.clone(), value.clone());
                owners.insert(owner, name.to_owned());
            }
            Some(Value::Array(have)) if value.is_array() => {
                join(have, value.as_array().into_iter().flatten().cloned());
            }
            Some(have) if have == value => {}
            Some(_) => {
                let first = owners.get(&owner).map_or("another crate", |o| o).to_owned();
                clashes.push(Clash {
                    kind,
                    key: format!("{prefix}{entry}"),
                    first,
                    second: name.to_owned(),
                });
            }
        }
    }
}

/// Appends each of `more` that `list` does not have yet.
fn join(list: &mut Vec<Value>, more: impl IntoIterator<Item = Value>) {
    for value in more {
        if !list.contains(&value) {
            list.push(value);
        }
    }
}

fn join_strings(list: &mut Vec<String>, more: Vec<String>) {
    for value in more {
        if !list.contains(&value) {
            list.push(value);
        }
    }
}

/// Appends each of `more` whose file `list` does not have yet: the first
/// that lists a file is the one errors name.
fn join_libraries(list: &mut Vec<Library>, more: Vec<Library>) {
    for library in more {
        if !list.iter().any(|have| have.path == library.path) {
            list.push(library);
        }
    }
}

/// Keeps the app's own `nsh.json` `android.queries` and
/// `android.application` entries that pass a crate's checks (one balanced
/// element each, of the elements a crate may add there); each other one is
/// reported in `ignored` and left out, as any `nsh.json` value an `nsh`
/// cannot read is.
pub(crate) fn keep_app_android_elements(
    queries: &mut Vec<String>,
    application: &mut Vec<String>,
    ignored: &mut Vec<String>,
) {
    for (list, elements, key) in [
        (queries, QUERY_ELEMENTS, "android.queries"),
        (application, APPLICATION_ELEMENTS, "android.application"),
    ] {
        list.retain(|e| {
            let problem = match check_element(e, elements) {
                Ok(()) => app_entry_problem(e),
                Err(error) => Some(format!("{error:#}")),
            };
            if let Some(problem) = &problem {
                ignored.push(format!("{key}: {problem}"));
            }
            problem.is_none()
        });
    }
}

/// What makes the app's own manifest entry `xml`, one allowed element,
/// unfit for the manifest NSH writes: a `tools:` attribute, which only a
/// manifest merger reads and `aapt2` refuses unbound; or a name NSH
/// declares itself, which Android takes only once.
fn app_entry_problem(xml: &str) -> Option<String> {
    if xml.contains("tools:") {
        return Some(format!(
            "{xml:?}: `tools:` attributes are for libraries' manifests, not nsh.json: leave them out"
        ));
    }
    if xml.contains("\"com.longbridge.nsh.") {
        return Some(format!(
            "{xml:?}: names under `com.longbridge.nsh.` are NSH's own"
        ));
    }
    if xml.contains("${applicationId}.files\"") {
        return Some(format!(
            "{xml:?}: `${{applicationId}}.files` is the authority of NSH's own file provider"
        ));
    }
    None
}

/// Checks `xml` is one element, balanced, whose name is one of `elements`
/// (what it holds is the element's own), with nothing but whitespace and
/// comments around it.
fn check_element(xml: &str, elements: &[&str]) -> anyhow::Result<()> {
    let allowed = || {
        elements
            .iter()
            .map(|e| format!("<{e}>"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut open: Vec<&str> = Vec::new();
    let mut root: Option<&str> = None;
    let mut rest = xml;
    loop {
        // Text: only inside the element.
        let at = rest.find('<').unwrap_or(rest.len());
        if (open.is_empty()) && !rest[..at].trim().is_empty() {
            bail!("{xml:?} has text outside its element");
        }
        rest = &rest[at..];
        if rest.is_empty() {
            break;
        }
        if let Some(comment) = rest.strip_prefix("<!--") {
            let end = comment
                .find("-->")
                .with_context(|| format!("{xml:?} has an unclosed comment"))?;
            rest = &comment[end + 3..];
            continue;
        }
        // The tag, to its `>` outside quotes.
        let mut quote = None;
        let end = rest
            .char_indices()
            .find(|&(_, c)| match quote {
                Some(q) => {
                    if c == q {
                        quote = None;
                    }
                    false
                }
                None if c == '"' || c == '\'' => {
                    quote = Some(c);
                    false
                }
                None => c == '>',
            })
            .map(|(i, _)| i)
            .with_context(|| format!("{xml:?} has an unclosed tag"))?;
        let tag = &rest[1..end];
        rest = &rest[end + 1..];
        if let Some(name) = tag.strip_prefix('/') {
            let name = name.trim();
            if open.pop() != Some(name) {
                bail!("{xml:?} closes <{name}> that it did not open");
            }
            continue;
        }
        let name = tag
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or_default();
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_:.".contains(c))
        {
            bail!("{xml:?} has a tag that is not an element: <{tag}>");
        }
        if open.is_empty() {
            if root.is_some() {
                bail!("{xml:?} is more than one element: write one per entry");
            }
            if !elements.contains(&name) {
                bail!("{xml:?} is not one of the elements it takes: {}", allowed());
            }
            root = Some(name);
        }
        if !tag.trim_end().ends_with('/') {
            open.push(name);
        }
    }
    if let Some(name) = open.last() {
        bail!("{xml:?} does not close <{name}>");
    }
    if root.is_none() {
        bail!("{xml:?} is not one of the elements it takes: {}", allowed());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// `cargo metadata`'s output for `packages` (name, metadata, features
    /// on).
    fn metadata(packages: &[(&str, Value, &[&str])]) -> Value {
        let id = |name: &str| format!("path+file:///work/{name}#0.1.0");
        json!({
            "packages": packages.iter().map(|(name, metadata, _)| json!({
                "id": id(name),
                "name": name,
                "manifest_path": format!("/work/{name}/Cargo.toml"),
                "metadata": metadata,
            })).collect::<Vec<_>>(),
            "resolve": { "nodes": packages.iter().map(|(name, _, features)| json!({
                "id": id(name),
                "features": features,
            })).collect::<Vec<_>>() },
        })
    }

    /// A crate of modules behind features, as nsh-extra declares them.
    fn extra() -> Value {
        json!({ "nsh": { "features": { "camera": {
            "ios": { "infoPlist": { "NSCameraUsageDescription": "The app takes photos with the camera." } },
            "android": { "queries": [
                "<intent><action android:name=\"android.media.action.IMAGE_CAPTURE\"/></intent>"
            ] },
        } } } })
    }

    #[test]
    fn only_the_features_on_count() {
        // The app's crate depends on nsh-extra (by path, Git or crates.io:
        // the graph is the same) with `camera` on.
        let on = metadata(&[
            ("app-native", Value::Null, &[]),
            ("nsh-extra", extra(), &["camera", "default"]),
        ]);
        let (meta, warnings) = ModuleMeta::from_metadata(&on).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(
            meta.ios_info["NSCameraUsageDescription"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        );
        assert_eq!(meta.android_queries.len(), 1);
        assert!(meta.android_queries[0].contains("IMAGE_CAPTURE"));
        // Linked without the feature: nothing of the camera's.
        let off = metadata(&[("nsh-extra", extra(), &[])]);
        let (meta, _) = ModuleMeta::from_metadata(&off).unwrap();
        assert_eq!(meta, ModuleMeta::default());
    }

    #[test]
    fn crates_merge_and_clash() {
        let a = json!({ "nsh": {
            "ios": { "infoPlist": { "UIBackgroundModes": ["remote-notification"], "A": "1" } },
            "android": { "permissions": ["android.permission.CAMERA"] },
        } });
        let b = json!({ "nsh": {
            "ios": {
                "infoPlist": { "UIBackgroundModes": ["remote-notification", "audio"], "A": "1" },
                "entitlements": { "aps-environment": "development" },
            },
            "android": {
                "permissions": ["android.permission.CAMERA", "android.permission.POST_NOTIFICATIONS"],
                "application": ["<service android:name=\"x.Push\" android:exported=\"false\"/>"],
            },
        } });
        let (meta, _) =
            ModuleMeta::from_metadata(&metadata(&[("a", a.clone(), &[]), ("b", b, &[])])).unwrap();
        assert_eq!(
            meta.ios_info["UIBackgroundModes"],
            json!(["remote-notification", "audio"])
        );
        assert_eq!(meta.ios_entitlements["aps-environment"], "development");
        assert_eq!(
            meta.android_permissions,
            [
                "android.permission.CAMERA",
                "android.permission.POST_NOTIFICATIONS"
            ]
        );
        assert_eq!(meta.android_application.len(), 1);
    }

    #[test]
    fn the_app_settles_what_crates_disagree_on() {
        // Two crates with their own camera wording: nsh-extra's `camera` and
        // a scanner nshm.
        let scanner = json!({ "nsh": { "ios": {
            "infoPlist": { "NSCameraUsageDescription": "Scans the codes you point the camera at." },
        } } });
        let (meta, _) = ModuleMeta::from_metadata(&metadata(&[
            ("nsh-extra", extra(), &["camera"]),
            ("scanner", scanner, &[]),
        ]))
        .unwrap();
        // The app has not chosen: the package stops, naming both crates.
        let error = meta
            .apply(&mut AppConfig::default(), Platform::Ios)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("nsh-extra and scanner set `NSCameraUsageDescription` (ios.infoPlist)")
                && error.contains("`ios.infoPlist`"),
            "{error}"
        );
        // The app's own wording settles it: it packages, with the app's.
        let mut config = AppConfig::default();
        config.ios.info_plist.insert(
            "NSCameraUsageDescription".into(),
            json!("Photos of receipts."),
        );
        meta.apply(&mut config, Platform::Ios).unwrap();
        assert_eq!(
            config.ios.info_plist["NSCameraUsageDescription"],
            "Photos of receipts."
        );
        assert!(config.android.queries[0].contains("IMAGE_CAPTURE"));
        // An Android package has no iOS keys: the clash does not stop it.
        let mut android = AppConfig::default();
        meta.apply(&mut android, Platform::Android).unwrap();
        assert!(android.android.queries[0].contains("IMAGE_CAPTURE"));
    }

    /// Crates translate the keys they set, for the languages the app
    /// declares; the app's own text and its own translations win, and a
    /// clash is the app's to settle as for `ios.infoPlist`.
    #[test]
    fn crates_translate_their_own_keys() {
        let camera = |zh: &str| {
            json!({ "nsh": { "ios": {
                "infoPlist": { "NSCameraUsageDescription": "The app takes photos with the camera." },
                "infoPlistStrings": {
                    "zh-Hans": { "NSCameraUsageDescription": zh },
                    "ja": { "NSCameraUsageDescription": "カメラで写真を撮ります。" },
                    "de": { "NSCameraUsageDescription": "Die App macht Fotos." },
                },
            } } })
        };
        let (meta, warnings) =
            ModuleMeta::from_metadata(&metadata(&[("camera", camera("用相机拍照。"), &[])]))
                .unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        // `zh-Hans` from `locales`, `ja` from the app's own translations;
        // `de` is no language of the app's: left out.
        let chinese = || {
            let mut config = AppConfig::default();
            config.localizations = vec!["zh-Hans".into()];
            config
        };
        let mut config = chinese();
        config.ios.info_plist_strings.insert(
            "ja".into(),
            json!({ "NSCameraUsageDescription": "レシートを撮ります。" }),
        );
        meta.apply(&mut config, Platform::Ios).unwrap();
        assert_eq!(
            config.ios.info_plist_strings["zh-Hans"],
            json!({ "NSCameraUsageDescription": "用相机拍照。" })
        );
        assert_eq!(
            config.ios.info_plist_strings["ja"],
            json!({ "NSCameraUsageDescription": "レシートを撮ります。" })
        );
        assert!(!config.ios.info_plist_strings.contains_key("de"));
        // An English-only app takes no language from its crates.
        let mut english = AppConfig::default();
        meta.apply(&mut english, Platform::Ios).unwrap();
        assert!(english.ios.info_plist_strings.is_empty());
        // An empty object declares the language: the crates translate it.
        let mut german = AppConfig::default();
        german.ios.info_plist_strings.insert("de".into(), json!({}));
        meta.apply(&mut german, Platform::Ios).unwrap();
        assert_eq!(
            german.ios.info_plist_strings["de"]["NSCameraUsageDescription"],
            "Die App macht Fotos."
        );
        // The app words the key itself: the crate's translations of the
        // crate's wording are left out.
        let mut own = chinese();
        own.ios.info_plist.insert(
            "NSCameraUsageDescription".into(),
            json!("Photos of receipts."),
        );
        meta.apply(&mut own, Platform::Ios).unwrap();
        assert!(own.ios.info_plist_strings.is_empty());

        // Two crates translate differently: the app settles it, unless the
        // language is none of the app's.
        let (meta, _) = ModuleMeta::from_metadata(&metadata(&[
            ("camera", camera("用相机拍照。"), &[]),
            ("scanner", camera("扫描二维码。"), &[]),
        ]))
        .unwrap();
        meta.apply(&mut AppConfig::default(), Platform::Ios)
            .unwrap();
        let error = meta
            .apply(&mut chinese(), Platform::Ios)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(
                "camera and scanner set `zh-Hans.NSCameraUsageDescription` (ios.infoPlistStrings)"
            ),
            "{error}"
        );
        let mut settled = chinese();
        settled.ios.info_plist_strings.insert(
            "zh-Hans".into(),
            json!({ "NSCameraUsageDescription": "拍摄收据。" }),
        );
        meta.apply(&mut settled, Platform::Ios).unwrap();
        assert_eq!(
            settled.ios.info_plist_strings["zh-Hans"]["NSCameraUsageDescription"],
            "拍摄收据。"
        );
    }

    /// A crate's `macos.infoPlistStrings` follows iOS's rules for macOS
    /// packages: taken for the app's languages, the app's own text winning,
    /// a clash the app's to settle, a key no crate sets left out; the two
    /// platforms' translations stay apart.
    #[test]
    fn crates_translate_their_macos_keys() {
        let camera = |zh: &str| {
            json!({ "nsh": {
                "macos": {
                    "infoPlist": { "NSCameraUsageDescription": "The app takes photos with the camera." },
                    "infoPlistStrings": {
                        "zh-Hans": { "NSCameraUsageDescription": zh },
                        "de": { "NSCameraUsageDescription": "Die App macht Fotos." },
                    },
                },
                "ios": { "infoPlistStrings": { "zh-Hans": { "NSCameraUsageDescription": "iOS 的。" } } },
            } })
        };
        let (meta, warnings) =
            ModuleMeta::from_metadata(&metadata(&[("camera", camera("用相机拍照。"), &[])]))
                .unwrap();
        // iOS's translation is of a key no crate sets in `ios.infoPlist`.
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].starts_with("camera: `ios.infoPlistStrings.zh-Hans.NSCameraUsageDescription` translates a key no crate sets in `ios.infoPlist`"),
            "{warnings:?}"
        );
        assert!(meta.ios_strings.is_empty());
        assert_eq!(
            meta.macos_strings["zh-Hans"]["NSCameraUsageDescription"],
            "用相机拍照。"
        );
        let chinese = || {
            let mut config = AppConfig::default();
            config.localizations = vec!["zh-Hans".into()];
            config
        };
        let mut config = chinese();
        meta.apply(&mut config, Platform::Macos).unwrap();
        assert_eq!(
            config.macos.info_plist_strings["zh-Hans"],
            json!({ "NSCameraUsageDescription": "用相机拍照。" })
        );
        // `de` is no language of the app's; iOS's take none of macOS's.
        assert!(!config.macos.info_plist_strings.contains_key("de"));
        assert!(config.ios.info_plist_strings.is_empty());
        // The app words the key itself on macOS: no crate translation.
        let mut own = chinese();
        own.macos.info_plist.insert(
            "NSCameraUsageDescription".into(),
            json!("Photos of receipts."),
        );
        meta.apply(&mut own, Platform::Macos).unwrap();
        assert!(own.macos.info_plist_strings.is_empty());

        // Two crates translate differently: the app's macOS translation
        // settles it, an iOS one does not; an iOS package is not stopped.
        let (meta, _) = ModuleMeta::from_metadata(&metadata(&[
            ("camera", camera("用相机拍照。"), &[]),
            ("scanner", camera("扫描二维码。"), &[]),
        ]))
        .unwrap();
        meta.apply(&mut chinese(), Platform::Ios).unwrap();
        let mut ios_only = chinese();
        ios_only.ios.info_plist_strings.insert(
            "zh-Hans".into(),
            json!({ "NSCameraUsageDescription": "拍摄收据。" }),
        );
        let error = meta
            .apply(&mut ios_only, Platform::Macos)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(
                "camera and scanner set `zh-Hans.NSCameraUsageDescription` (macos.infoPlistStrings)"
            ),
            "{error}"
        );
        let mut settled = chinese();
        settled.macos.info_plist_strings.insert(
            "zh-Hans".into(),
            json!({ "NSCameraUsageDescription": "拍摄收据。" }),
        );
        meta.apply(&mut settled, Platform::Macos).unwrap();
        assert_eq!(
            settled.macos.info_plist_strings["zh-Hans"]["NSCameraUsageDescription"],
            "拍摄收据。"
        );

        // A key NSH sets on macOS is not a crate's to translate.
        let error = ModuleMeta::from_metadata(&metadata(&[(
            "x",
            json!({ "nsh": { "macos": { "infoPlistStrings": { "ja": { "NSPrincipalClass": "x" } } } } }),
            &[],
        )]))
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("`macos.infoPlistStrings.ja.NSPrincipalClass` is a key NSH sets itself"),
            "{error}"
        );
    }

    /// A translation in a crate's own section of a key its feature sets:
    /// an app without the feature, and an Android package, are not stopped
    /// by it; the translation is left out with a warning.
    #[test]
    fn crates_translations_outside_the_feature_are_left_out() {
        let scanner = json!({ "nsh": {
            "ios": { "infoPlistStrings": { "zh-Hans": { "NSCameraUsageDescription": "扫描二维码。" } } },
            "features": { "camera": { "ios": {
                "infoPlist": { "NSCameraUsageDescription": "Scans codes." }
            } } },
        } });
        let (meta, warnings) =
            ModuleMeta::from_metadata(&metadata(&[("scanner", scanner.clone(), &["camera"])]))
                .unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(
            meta.ios_strings["zh-Hans"]["NSCameraUsageDescription"],
            "扫描二维码。"
        );
        let off = ModuleMeta::from_metadata(&metadata(&[("scanner", scanner, &[])]));
        assert!(off.is_ok(), "{off:?}");
        let (meta, warnings) = off.unwrap();
        assert!(meta.ios_strings.is_empty());
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].contains(
                "scanner: `ios.infoPlistStrings.zh-Hans.NSCameraUsageDescription` translates a key \
                 no crate sets in `ios.infoPlist`"
            ),
            "{warnings:?}"
        );
        meta.apply(&mut AppConfig::default(), Platform::Ios)
            .unwrap();
        meta.apply(&mut AppConfig::default(), Platform::Android)
            .unwrap();
    }

    /// A crate's translations are checked as `nsh.json`'s are.
    #[test]
    fn crates_translations_are_checked() {
        let strings = |strings: Value| {
            ModuleMeta::from_metadata(&metadata(&[(
                "scanner",
                json!({ "nsh": { "ios": {
                    "infoPlist": { "NSCameraUsageDescription": "Scans codes." },
                    "infoPlistStrings": strings,
                } } }),
                &[],
            )]))
            .map(|_| ())
            .unwrap_err()
            .to_string()
        };
        let error = strings(json!({ "zh_Hans": {} }));
        assert!(
            error.contains("scanner: [package.metadata.nsh] `ios.infoPlistStrings`: \"zh_Hans\" is no language code"),
            "{error}"
        );
        let error = strings(json!({ "ja": { "CFBundleIdentifier": "x" } }));
        assert!(error.contains("is a key NSH sets itself"), "{error}");
        let error = strings(json!({ "ja": { "NSCameraUsageDescription": 1 } }));
        assert!(
            error.contains("`ios.infoPlistStrings.ja.NSCameraUsageDescription` is a string"),
            "{error}"
        );
    }

    #[test]
    fn crates_permissions_are_checked_and_spelled_out() {
        let permissions = |list: Value| {
            ModuleMeta::from_metadata(&metadata(&[(
                "scanner",
                json!({ "nsh": { "android": { "permissions": list } } }),
                &[],
            )]))
        };
        let (meta, warnings) =
            permissions(json!(["CAMERA", "com.example.permission.SCAN"])).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(
            meta.android_permissions,
            ["android.permission.CAMERA", "com.example.permission.SCAN"]
        );
        // A bare name in lower case is most likely a typo: warned of, with
        // the crate's name.
        let (_, warnings) = permissions(json!(["camera"])).unwrap();
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].starts_with("scanner: "), "{warnings:?}");
        // Only a name reaches the manifest, and the error names the crate.
        let error = permissions(json!(["CAMERA\"/><application android:debuggable=\"true"]))
            .unwrap_err()
            .to_string();
        assert!(
            error.starts_with("scanner: [package.metadata.nsh] `android.permissions`"),
            "{error}"
        );
    }

    #[test]
    fn elements_and_keys_are_checked() {
        let bad = |android: Value| {
            ModuleMeta::from_metadata(&metadata(&[(
                "x",
                json!({ "nsh": { "android": android } }),
                &[],
            )]))
        };
        // `<application>`'s own attributes are not the crates'.
        assert!(bad(json!({ "application": ["<application android:name=\"x.App\"/>"] })).is_err());
        assert!(bad(json!({ "queries": ["<service android:name=\"x\"/>"] })).is_err());
        assert!(
            bad(json!({ "application": ["<meta-data android:name=\"a\" android:value=\"b\"/>"] }))
                .is_ok()
        );
        assert!(bad(json!({ "queries": ["<package android:name=\"com.example\" />"] })).is_ok());
        assert!(bad(json!({ "permissions": "CAMERA" })).is_err());
        // One balanced element per entry: nothing that closes the element it
        // goes in to write elsewhere in the manifest.
        for escape in [
            "<service android:name=\"a\"/></application><application android:debuggable=\"true\">",
            "<service android:name=\"a\"/><uses-permission android:name=\"b\"/>",
            "<service android:name=\"a\">",
            "<service android:name=\"a\"></activity>",
            "text <service android:name=\"a\"/>",
            "<!DOCTYPE x><service/>",
        ] {
            assert!(bad(json!({ "application": [escape] })).is_err(), "{escape}");
        }
        assert!(
            bad(json!({ "application": [
                "<receiver android:name=\"a.B\" android:exported=\"false\"><!-- push --><intent-filter><action android:name=\"a > b\"/></intent-filter></receiver>"
            ] }))
            .is_ok()
        );
        // Keys NSH sets itself, named with the crate.
        for reserved in [
            json!({ "nsh": { "ios": { "infoPlist": { "CFBundleIdentifier": "x" } } } }),
            json!({ "nsh": { "ios": { "entitlements": { "application-identifier": "x" } } } }),
        ] {
            let error = ModuleMeta::from_metadata(&metadata(&[("x", reserved, &[])]))
                .unwrap_err()
                .to_string();
            assert!(
                error.starts_with("x: ") && error.contains("NSH sets itself"),
                "{error}"
            );
        }
        // Keys a later nsh reads: reported, left out.
        let (meta, warnings) = ModuleMeta::from_metadata(&metadata(&[(
            "x",
            json!({ "nsh": { "android": { "dex": ["a.dex"] }, "ios": { "privacy": {} } } }),
            &[],
        )]))
        .unwrap();
        assert_eq!(meta, ModuleMeta::default());
        assert_eq!(warnings.len(), 2, "{warnings:?}");
    }

    #[test]
    fn crates_libraries_are_relative_to_their_cargo_toml() {
        let scanner = json!({ "nsh": {
            "android": { "libraries": ["android/libs/glue.jar"] },
            "features": { "vendor": { "android": {
                "libraries": ["android/libs/vendor-sdk.jar", "android/libs/glue.jar"],
            } } },
        } });
        let printer = json!({ "nsh": { "android": { "libraries": ["java/out/classes.dex"] } } });
        let (meta, warnings) = ModuleMeta::from_metadata(&metadata(&[
            ("printer", printer, &[]),
            ("scanner", scanner, &["vendor"]),
        ]))
        .unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        let found: Vec<(&Path, &str)> = meta
            .android_libraries
            .iter()
            .map(|l| (l.path.as_path(), l.listed.as_str()))
            .collect();
        assert_eq!(
            found,
            [
                (
                    Path::new("/work/printer/java/out/classes.dex"),
                    "printer: [package.metadata.nsh] `android.libraries`"
                ),
                (
                    Path::new("/work/scanner/android/libs/glue.jar"),
                    "scanner: [package.metadata.nsh] `android.libraries`"
                ),
                (
                    Path::new("/work/scanner/android/libs/vendor-sdk.jar"),
                    "scanner: [package.metadata.nsh.features.vendor] `android.libraries`"
                ),
            ]
        );
        // The app's own come first; a file both list is the app's.
        let mut config = AppConfig::default();
        config.android.libraries.push(Library {
            path: "/work/scanner/android/libs/glue.jar".into(),
            listed: "nsh.json `android.libraries`".into(),
            owner: None,
        });
        meta.apply(&mut config, Platform::Android).unwrap();
        let listed: Vec<&str> = config
            .android
            .libraries
            .iter()
            .map(|l| l.listed.as_str())
            .collect();
        assert_eq!(
            listed,
            [
                "nsh.json `android.libraries`",
                "printer: [package.metadata.nsh] `android.libraries`",
                "scanner: [package.metadata.nsh.features.vendor] `android.libraries`",
            ]
        );
        // Not a list of paths: an error naming the crate.
        let error = ModuleMeta::from_metadata(&metadata(&[(
            "x",
            json!({ "nsh": { "android": { "libraries": "a.jar" } } }),
            &[],
        )]))
        .unwrap_err()
        .to_string();
        assert!(
            error.starts_with("x: [package.metadata.nsh] `android.libraries`"),
            "{error}"
        );
    }

    #[test]
    fn only_the_app_sets_manifest_placeholders() {
        let error = ModuleMeta::from_metadata(&metadata(&[(
            "push",
            json!({ "nsh": { "features": { "vendor": { "android": {
                "manifestPlaceholders": { "PUSH_KEY": "default" },
            } } } } }),
            &["vendor"],
        )]))
        .unwrap_err()
        .to_string();
        assert!(
            error.starts_with(
                "push: [package.metadata.nsh.features.vendor] `android.manifestPlaceholders`: only the app sets"
            ),
            "{error}"
        );
    }

    #[test]
    fn the_apps_own_android_entries_are_checked_as_a_crates() {
        let query =
            "<intent><action android:name=\"android.media.action.IMAGE_CAPTURE\"/></intent>"
                .to_owned();
        let service =
            "<service android:name=\"${applicationId}.Sync\" android:exported=\"false\"/>"
                .to_owned();
        // A `<service>` is no query, and an entry that closes `<application>`
        // to write elsewhere is no element: each is left out and reported,
        // the rest kept.
        let escape =
            "<service android:name=\"a\"/></application><application android:debuggable=\"true\">";
        // Nor is a `tools:` attribute, or a name NSH declares itself.
        let tools = "<service android:name=\"a.B\" tools:node=\"remove\"/>";
        let ours = "<provider android:name=\"com.longbridge.nsh.FilesProvider\" android:authorities=\"x\"/>";
        let files =
            "<provider android:name=\"a.Files\" android:authorities=\"${applicationId}.files\"/>";
        let mut queries = vec![query.clone(), service.clone()];
        let mut application = vec![
            escape.to_owned(),
            tools.to_owned(),
            ours.to_owned(),
            files.to_owned(),
            service.clone(),
        ];
        let mut ignored = Vec::new();
        keep_app_android_elements(&mut queries, &mut application, &mut ignored);
        assert_eq!(queries, std::slice::from_ref(&query));
        assert_eq!(application, std::slice::from_ref(&service));
        assert!(
            ignored.len() == 5
                && ignored[0].starts_with("android.queries: ")
                && ignored[1..]
                    .iter()
                    .all(|i| i.starts_with("android.application: ")),
            "{ignored:?}"
        );
        assert!(ignored[2].contains("`tools:` attributes"), "{ignored:?}");
        assert!(ignored[3].contains("`com.longbridge.nsh.`"), "{ignored:?}");
        assert!(
            ignored[4].contains("NSH's own file provider"),
            "{ignored:?}"
        );
        // The crates' entries follow the app's, each once.
        let mut config = AppConfig::default();
        config.android.queries.push(query.clone());
        config.android.application.push(service.clone());
        let mut meta = ModuleMeta::default();
        meta.android_queries.push(query.clone());
        meta.android_application
            .push("<receiver android:name=\"x.Boot\" android:exported=\"false\"/>".into());
        meta.apply(&mut config, Platform::Android).unwrap();
        assert_eq!(config.android.queries, [query]);
        assert_eq!(config.android.application.len(), 2);
        assert_eq!(config.android.application[0], service);
    }

    #[test]
    fn the_app_wins() {
        let mut config = AppConfig::default();
        config
            .ios
            .info_plist
            .insert("NSCameraUsageDescription".into(), json!("Scan receipts."));
        config
            .ios
            .info_plist
            .insert("UIBackgroundModes".into(), json!(["audio"]));
        config.android.permissions.push("CAMERA".into());
        let mut meta = ModuleMeta::default();
        meta.ios_info
            .insert("NSCameraUsageDescription".into(), json!("Takes photos."));
        meta.ios_info
            .insert("UIBackgroundModes".into(), json!(["remote-notification"]));
        meta.ios_entitlements
            .insert("aps-environment".into(), json!("development"));
        meta.android_permissions
            .push("android.permission.POST_NOTIFICATIONS".into());
        meta.android_queries
            .push("<package android:name=\"a\"/>".into());
        meta.apply(&mut config, Platform::Ios).unwrap();
        assert_eq!(
            config.ios.info_plist["NSCameraUsageDescription"],
            "Scan receipts."
        );
        assert_eq!(
            config.ios.info_plist["UIBackgroundModes"],
            json!(["audio", "remote-notification"])
        );
        assert_eq!(config.ios.entitlements["aps-environment"], "development");
        assert_eq!(
            config.android.permissions,
            ["CAMERA", "android.permission.POST_NOTIFICATIONS"]
        );
        assert_eq!(config.android.queries.len(), 1);
    }

    #[test]
    fn macos_info_plist_and_entitlements_merge_and_join() {
        let a = json!({ "nsh": { "macos": {
            "infoPlist": {
                "NSBluetoothAlwaysUsageDescription": "A uses Bluetooth.",
                "NSUserActivityTypes": ["com.example.browse"],
            },
            "entitlements": {
                "com.apple.security.network.client": true,
                "com.apple.security.application-groups": ["T.a"],
            },
        } } });
        let b = json!({ "nsh": { "macos": {
            "infoPlist": {
                "NSBluetoothAlwaysUsageDescription": "A uses Bluetooth.",
                "NSUserActivityTypes": ["com.example.browse", "com.example.edit"],
            },
            "entitlements": {
                "com.apple.security.network.client": true,
                "com.apple.security.application-groups": ["T.a", "T.b"],
            },
        } } });
        let (meta, warnings) =
            ModuleMeta::from_metadata(&metadata(&[("a", a, &[]), ("b", b, &[])])).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(
            meta.macos_info["NSBluetoothAlwaysUsageDescription"],
            "A uses Bluetooth."
        );
        assert_eq!(
            meta.macos_info["NSUserActivityTypes"],
            json!(["com.example.browse", "com.example.edit"])
        );
        assert_eq!(
            meta.macos_entitlements["com.apple.security.network.client"],
            true
        );
        assert_eq!(
            meta.macos_entitlements["com.apple.security.application-groups"],
            json!(["T.a", "T.b"])
        );

        let mut config = AppConfig::default();
        config.macos.info_plist.insert(
            "NSBluetoothAlwaysUsageDescription".into(),
            json!("App uses Bluetooth."),
        );
        config.macos.entitlements.insert(
            "com.apple.security.application-groups".into(),
            json!(["T.app"]),
        );
        meta.apply(&mut config, Platform::Macos).unwrap();
        assert_eq!(
            config.macos.info_plist["NSBluetoothAlwaysUsageDescription"],
            "App uses Bluetooth."
        );
        assert_eq!(
            config.macos.info_plist["NSUserActivityTypes"],
            json!(["com.example.browse", "com.example.edit"])
        );
        assert_eq!(
            config.macos.entitlements["com.apple.security.network.client"],
            true
        );
        assert_eq!(
            config.macos.entitlements["com.apple.security.application-groups"],
            json!(["T.app", "T.a", "T.b"])
        );
    }

    #[test]
    fn macos_clashes_are_isolated_by_platform_and_settled_by_app() {
        let a = json!({ "nsh": {
            "macos": {
                "infoPlist": { "NSCameraUsageDescription": "A uses camera." },
                "entitlements": { "com.apple.security.app-sandbox": true },
            },
            "ios": {
                "infoPlist": { "NSLocationWhenInUseUsageDescription": "A uses location." },
            },
        } });
        let b = json!({ "nsh": {
            "macos": {
                "infoPlist": { "NSCameraUsageDescription": "B uses camera." },
                "entitlements": { "com.apple.security.app-sandbox": false },
            },
            "ios": {
                "infoPlist": { "NSLocationWhenInUseUsageDescription": "B uses location." },
            },
        } });
        let (meta, warnings) =
            ModuleMeta::from_metadata(&metadata(&[("a", a, &[]), ("b", b, &[])])).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");

        // macOS clash stops macOS packaging, naming both crates and section.
        let error = meta
            .apply(&mut AppConfig::default(), Platform::Macos)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("a and b set `NSCameraUsageDescription` (macos.infoPlist)")
                && error.contains("`macos.infoPlist`"),
            "{error}"
        );

        // Settling infoPlist alone still stops on the macOS entitlements clash.
        let mut config = AppConfig::default();
        config
            .macos
            .info_plist
            .insert("NSCameraUsageDescription".into(), json!("App wins."));
        let error = meta
            .apply(&mut config, Platform::Macos)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("a and b set `com.apple.security.app-sandbox` (macos.entitlements)")
                && error.contains("`macos.entitlements`"),
            "{error}"
        );

        // Settling both lets macOS package even though the iOS clash is still open.
        config
            .macos
            .entitlements
            .insert("com.apple.security.app-sandbox".into(), json!(true));
        meta.apply(&mut config, Platform::Macos).unwrap();
        assert_eq!(
            config.macos.info_plist["NSCameraUsageDescription"],
            "App wins."
        );
        assert_eq!(
            config.macos.entitlements["com.apple.security.app-sandbox"],
            true
        );

        // Settling the iOS clash lets iOS package even though the macOS clashes are open.
        let mut ios_config = AppConfig::default();
        ios_config.ios.info_plist.insert(
            "NSLocationWhenInUseUsageDescription".into(),
            json!("App location."),
        );
        meta.apply(&mut ios_config, Platform::Ios).unwrap();

        // Android has neither Apple clash.
        meta.apply(&mut AppConfig::default(), Platform::Android)
            .unwrap();

        // `Clash::applies_to` keeps dev host clash warnings scoped to the host's platform.
        assert_eq!(
            meta.clashes
                .iter()
                .filter(|c| c.applies_to(Platform::Ios))
                .count(),
            1
        );
        assert_eq!(
            meta.clashes
                .iter()
                .filter(|c| c.applies_to(Platform::Macos))
                .count(),
            2
        );
        assert_eq!(
            meta.clashes
                .iter()
                .filter(|c| c.applies_to(Platform::Android))
                .count(),
            0
        );
    }

    #[test]
    fn macos_reserved_keys_features_and_unknown_keys() {
        // Reserved macOS Info.plist keys and entitlements are rejected, naming the crate.
        for reserved in [
            json!({ "nsh": { "macos": { "infoPlist": { "LSUIElement": true } } } }),
            json!({ "nsh": { "macos": { "infoPlist": { "CFBundleIdentifier": "x" } } } }),
            json!({ "nsh": { "macos": { "infoPlist": { "NSPrincipalClass": "App" } } } }),
            json!({ "nsh": { "macos": { "infoPlist": { "CFBundleIconFile": "Icon" } } } }),
            json!({ "nsh": { "macos": { "entitlements": { "application-identifier": "T.x" } } } }),
            json!({ "nsh": { "macos": { "entitlements": { "com.apple.developer.team-identifier": "T" } } } }),
        ] {
            let error = ModuleMeta::from_metadata(&metadata(&[("x", reserved, &[])]))
                .unwrap_err()
                .to_string();
            assert!(
                error.starts_with("x: ") && error.contains("NSH sets itself"),
                "{error}"
            );
        }

        // Platform-specific reservation: `LSUIElement` is macOS-only, `LSRequiresIPhoneOS` is iOS-only.
        let (meta, warnings) = ModuleMeta::from_metadata(&metadata(&[(
            "x",
            json!({ "nsh": {
                "ios": { "infoPlist": { "LSUIElement": true } },
                "macos": { "infoPlist": { "LSRequiresIPhoneOS": false } },
            } }),
            &[],
        )]))
        .unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(meta.ios_info["LSUIElement"], true);
        assert_eq!(meta.macos_info["LSRequiresIPhoneOS"], false);

        // Feature-gated `[package.metadata.nsh.features.<feat>].macos` applies only when on.
        let gated = json!({ "nsh": { "features": { "audio": { "macos": {
            "infoPlist": { "NSMicrophoneUsageDescription": "Records audio." },
            "entitlements": { "com.apple.security.device.audio-input": true },
        } } } } });
        let (meta, warnings) =
            ModuleMeta::from_metadata(&metadata(&[("rec", gated.clone(), &["audio"])])).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(
            meta.macos_info["NSMicrophoneUsageDescription"],
            "Records audio."
        );
        assert_eq!(
            meta.macos_entitlements["com.apple.security.device.audio-input"],
            true
        );
        let (off, warnings) = ModuleMeta::from_metadata(&metadata(&[("rec", gated, &[])])).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(off, ModuleMeta::default());

        // Unknown keys under `macos` are warned of and left out.
        let (meta, warnings) = ModuleMeta::from_metadata(&metadata(&[(
            "x",
            json!({ "nsh": { "macos": { "privacy": {} } } }),
            &[],
        )]))
        .unwrap();
        assert_eq!(meta, ModuleMeta::default());
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].contains("x: [package.metadata.nsh] `macos.privacy`"),
            "{warnings:?}"
        );

        // Non-table sections under `macos` fail clearly, naming the crate.
        for bad in [
            json!({ "nsh": { "macos": true } }),
            json!({ "nsh": { "macos": { "infoPlist": [] } } }),
            json!({ "nsh": { "macos": { "entitlements": "none" } } }),
        ] {
            let error = ModuleMeta::from_metadata(&metadata(&[("x", bad, &[])]))
                .unwrap_err()
                .to_string();
            assert!(error.starts_with("x: "), "{error}");
        }
    }
}
