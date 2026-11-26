//! The store listing an app ships with, shared by every `nsh publish <store>`.
//!
//! It is read from `nsh.json` `"store"` and from a `store/` directory beside
//! it; a value in `nsh.json` wins over the file:
//!
//! ```text
//! store/
//!   en-US/
//!     description.txt  keywords.txt  release_notes.txt  ...
//!     short_description.txt          Google Play's short description
//!     screenshots/phone/01.png  screenshots/tablet/01.png
//!     android/phoneScreenshots/1.png a store's own image types, by platform
//! ```
//!
//! Every store identity lives under `store.<platform>` or is the app's
//! top-level `id`, so that a configured app publishes with
//! `nsh publish <platform> <artifact>` alone. Unknown keys are ignored, as
//! everywhere else in `nsh.json`.
//!
//! Locales are BCP 47 tags (`en-US`, `zh-Hans`). Screenshots are grouped by
//! device class (`phone`, `tablet`, `desktop`), which each store maps to its
//! own sizes; a store's own name for a size (`APP_IPHONE_67`) is taken as is
//! by that store and skipped by the others.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use anyhow::{Context, bail, ensure};
use serde::{Deserialize, Serialize};

/// `nsh.json` `"store"`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoreConfig {
    /// The listing per locale.
    #[serde(default)]
    pub locales: BTreeMap<String, Listing>,
    /// App Store Connect settings.
    #[serde(default)]
    pub ios: IosStore,
    /// Flathub and the AppStream metainfo of Linux packages.
    #[serde(default)]
    pub linux: LinuxStore,
    /// The Microsoft Store.
    #[serde(default)]
    pub windows: WindowsStore,
}

/// `store.windows`. The package identity (`identityName`, `publisher`)
/// stays in `nsh.json` `windows`, which MSIX packaging reads.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsStore {
    /// The app's Store ID in Partner Center (Product identity → Store ID,
    /// e.g. `9NBLGGH4R315`), which `nsh publish windows` submits to.
    /// `storeId` is taken too.
    #[serde(alias = "storeId")]
    pub product_id: Option<String>,
}

/// `store.linux`. Flathub names the app by `nsh.json` `id`; the summary,
/// description and keywords come from the listing (`subtitle`,
/// `description`, `keywords`).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinuxStore {
    /// The app's license as an SPDX expression (`MIT`, `Apache-2.0`).
    pub license: Option<String>,
    /// Who makes the app.
    pub developer: Option<String>,
    /// The app's web site (default: the listing's `marketingUrl`).
    pub homepage: Option<String>,
    /// Freedesktop categories (`["Development", "Utility"]`; default
    /// `Utility`).
    #[serde(default)]
    pub categories: Vec<String>,
    /// Screenshot image URLs (Flathub downloads them), the first being the
    /// default one.
    #[serde(default)]
    pub screenshots: Vec<String>,
    /// Where each release archive is downloaded from, with `{version}` for
    /// `nsh.json` `version`, so `nsh publish linux` needs no `--url`.
    pub archive_url: Option<String>,
}

/// One locale's listing. Every field is optional: a store leaves what is
/// not given as it is.
#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Listing {
    pub name: Option<String>,
    pub subtitle: Option<String>,
    /// Google Play's short description (80 characters).
    pub short_description: Option<String>,
    pub description: Option<String>,
    /// Search keywords, comma separated (a list is joined with commas).
    #[serde(default, deserialize_with = "keywords")]
    pub keywords: Option<String>,
    pub promotional_text: Option<String>,
    /// Release notes of this version, for every store (`whatsNew` is
    /// taken too).
    #[serde(alias = "whatsNew")]
    pub release_notes: Option<String>,
    pub support_url: Option<String>,
    pub marketing_url: Option<String>,
    pub privacy_policy_url: Option<String>,
    /// Device class → image paths, relative to `nsh.json`, in display order.
    #[serde(default)]
    pub screenshots: BTreeMap<String, Vec<PathBuf>>,
    /// Platform → a store's own image type (`phoneScreenshots`,
    /// `featureGraphic`) → image paths, from `store/<locale>/<platform>/`.
    #[serde(default)]
    pub images: BTreeMap<String, BTreeMap<String, Vec<PathBuf>>>,
}

/// One locale's listing as a store uploads it, with the images of one
/// platform.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Locale {
    pub tag: String,
    pub name: Option<String>,
    pub short_description: Option<String>,
    pub description: Option<String>,
    pub release_notes: Option<String>,
    /// `(image type, files in upload order)` of the platform.
    pub images: Vec<(String, Vec<PathBuf>)>,
}

/// The platforms whose own image types `store/<locale>/<platform>/` holds.
const IMAGE_PLATFORMS: [&str; 1] = ["android"];

/// `store.ios`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IosStore {
    /// The app's numeric Apple ID in App Store Connect (App Information →
    /// Apple ID), so that `nsh publish ios` needs no `--app-id`. A string
    /// or a number.
    #[serde(default, deserialize_with = "numeric_id")]
    pub app_id: Option<String>,
    /// Export compliance answer set on every build (Apple asks for it
    /// before a build can be tested or submitted).
    pub uses_non_exempt_encryption: Option<bool>,
    /// TestFlight groups that get each processed build.
    #[serde(default)]
    pub beta_groups: Vec<String>,
    /// How an approved version is released (default: `manual`).
    pub release: Option<ReleaseMode>,
}

/// Keywords written as `"a, b"` or `["a", "b"]`.
fn keywords<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Keywords {
        Text(String),
        List(Vec<String>),
    }
    Ok(Option::<Keywords>::deserialize(d)?.map(|k| match k {
        Keywords::Text(text) => text,
        Keywords::List(list) => list.join(","),
    }))
}

/// An id written as `"6835723652"` or `6835723652`.
fn numeric_id<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Id {
        Text(String),
        Number(u64),
    }
    Ok(Option::<Id>::deserialize(d)?.map(|id| match id {
        Id::Text(text) => text,
        Id::Number(n) => n.to_string(),
    }))
}

/// How a version goes live once the store approves it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ReleaseMode {
    /// The developer releases it (in the console or with a later command).
    Manual,
    /// Released as soon as it is approved.
    Auto,
    /// Released on approval to a growing share of users over 7 days.
    Phased,
}

/// The text files `store/<locale>/` may hold, by listing field.
const TEXT_FILES: [&str; 10] = [
    "name",
    "subtitle",
    "short_description",
    "description",
    "keywords",
    "promotional_text",
    "release_notes",
    "support_url",
    "marketing_url",
    "privacy_policy_url",
];

impl Listing {
    fn field(&mut self, name: &str) -> &mut Option<String> {
        match name {
            "name" => &mut self.name,
            "subtitle" => &mut self.subtitle,
            "short_description" => &mut self.short_description,
            "description" => &mut self.description,
            "keywords" => &mut self.keywords,
            "promotional_text" => &mut self.promotional_text,
            "release_notes" => &mut self.release_notes,
            "support_url" => &mut self.support_url,
            "marketing_url" => &mut self.marketing_url,
            _ => &mut self.privacy_policy_url,
        }
    }
}

/// Reads the store listing of the app at `entry`: `nsh.json` `"store"`
/// merged over `store/`, with screenshot paths made absolute and checked.
pub(crate) fn read(entry: &Path) -> anyhow::Result<StoreConfig> {
    read_with(entry, None)
}

/// [`read`] with the store directory at `store_dir` instead of `store/`
/// beside `nsh.json`.
pub(crate) fn read_with(entry: &Path, store_dir: Option<&Path>) -> anyhow::Result<StoreConfig> {
    let entry = &app_entry(entry);
    let dir = nsh_bundler::app_dir::config_dir_of(entry);
    let config = crate::package::read_config(entry)?;
    let mut store: StoreConfig = match config.store {
        Some(value) => serde_json::from_value(value).context("invalid nsh.json `store`")?,
        None => StoreConfig::default(),
    };
    let store_dir = store_dir.map_or_else(|| dir.join("store"), Path::to_owned);
    merge_dir(&mut store, &store_dir)?;
    for (locale, listing) in &mut store.locales {
        ensure!(
            valid_locale(locale),
            "store locale `{locale}` is not a BCP 47 tag like en-US"
        );
        let platform_images = listing
            .images
            .iter_mut()
            .flat_map(|(_, kinds)| kinds.iter_mut());
        for (class, paths) in listing.screenshots.iter_mut().chain(platform_images) {
            for path in paths {
                if path.is_relative() {
                    *path = dir.join(&*path);
                }
                ensure!(
                    image_kind(path).is_some(),
                    "store screenshot {} ({locale}, {class}) must be a .png or .jpg",
                    path.display()
                );
                ensure!(
                    path.is_file(),
                    "store screenshot {} ({locale}, {class}) does not exist",
                    path.display()
                );
            }
        }
    }
    Ok(store)
}

impl StoreConfig {
    /// Every locale's listing with `platform`'s own images, sorted by tag.
    pub(crate) fn locales(&self, platform: &str) -> Vec<Locale> {
        self.locales
            .iter()
            .map(|(tag, l)| Locale {
                tag: tag.clone(),
                name: l.name.clone(),
                short_description: l.short_description.clone(),
                description: l.description.clone(),
                release_notes: l.release_notes.clone(),
                images: l
                    .images
                    .get(platform)
                    .map(|kinds| kinds.iter().map(|(k, f)| (k.clone(), f.clone())).collect())
                    .unwrap_or_default(),
            })
            .collect()
    }
}

/// `entry` as `package::read_config` takes it: an app's directory names its
/// `nsh.json`.
pub(crate) fn app_entry(entry: &Path) -> PathBuf {
    if entry.is_dir() {
        entry.join("nsh.json")
    } else {
        entry.to_owned()
    }
}

/// Fills what `nsh.json` left out from `store/<locale>/`.
fn merge_dir(store: &mut StoreConfig, dir: &Path) -> anyhow::Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Some(locale) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let listing = store.locales.entry(locale).or_default();
        for name in TEXT_FILES {
            let field = listing.field(name);
            if field.is_some() {
                continue;
            }
            // `whats_new.txt` is App Store's name for the release notes.
            let files = match name {
                "release_notes" => &["release_notes", "whats_new"][..],
                _ => &[name][..],
            };
            if let Some(text) = files.iter().find_map(|file| {
                std::fs::read_to_string(entry.path().join(format!("{file}.txt"))).ok()
            }) && !text.trim().is_empty()
            {
                *field = Some(text.trim().to_owned());
            }
        }
        for platform in IMAGE_PLATFORMS {
            if listing.images.contains_key(platform) {
                continue;
            }
            let kinds = image_dirs(&entry.path().join(platform))?;
            if !kinds.is_empty() {
                listing.images.insert(platform.to_owned(), kinds);
            }
        }
        for (name, images) in image_dirs(&entry.path().join("screenshots"))? {
            listing.screenshots.entry(name).or_insert(images);
        }
    }
    Ok(())
}

/// The images of each directory in `dir`, by directory name, in file-name
/// order. A missing directory has none.
fn image_dirs(dir: &Path) -> anyhow::Result<BTreeMap<String, Vec<PathBuf>>> {
    let mut out = BTreeMap::new();
    let Ok(classes) = std::fs::read_dir(dir) else {
        return Ok(out);
    };
    for class in classes {
        let class = class?;
        let Some(name) = class.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !class.file_type()?.is_dir() {
            continue;
        }
        let mut images: Vec<PathBuf> = std::fs::read_dir(class.path())?
            .filter_map(|f| f.ok().map(|f| f.path()))
            .filter(|p| image_kind(p).is_some())
            .collect();
        images.sort();
        if !images.is_empty() {
            out.insert(name, images);
        }
    }
    Ok(out)
}

pub(crate) fn image_kind(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        _ => None,
    }
}

fn valid_locale(tag: &str) -> bool {
    let mut parts = tag.split('-');
    parts
        .next()
        .is_some_and(|p| (2..=3).contains(&p.len()) && p.bytes().all(|c| c.is_ascii_alphabetic()))
        && parts.all(|p| (2..=8).contains(&p.len()) && p.bytes().all(|c| c.is_ascii_alphanumeric()))
}

/// Where a store has a release, as `nsh publish status` reports it. The exit
/// code lets a script or agent poll without reading the output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum StoreState {
    /// Live, or approved and waiting only for a manual release: exit 0.
    Live,
    /// Processing or in review: nothing to do but wait. Exit 10.
    Pending,
    /// Being prepared, not submitted: exit 11.
    Draft,
    /// Rejected or invalid: someone has to act. Exit 12.
    ActionNeeded,
}

impl StoreState {
    pub(crate) fn exit_code(self) -> i32 {
        match self {
            Self::Live => 0,
            Self::Pending => 10,
            Self::Draft => 11,
            Self::ActionNeeded => 12,
        }
    }
}

/// Percent-encodes a value for a URL query.
pub(crate) fn query_value(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// One check of `nsh publish doctor`.
pub(crate) struct Check {
    failed: bool,
}

impl Check {
    pub(crate) fn new() -> Self {
        Self { failed: false }
    }

    /// Prints one result; a failure makes the whole check fail.
    pub(crate) fn report(&mut self, what: &str, result: anyhow::Result<String>) {
        match result {
            Ok(detail) => println!(
                "ok    {what}{}",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {detail}")
                }
            ),
            Err(e) => {
                self.failed = true;
                println!("FAIL  {what}: {e:#}");
            }
        }
    }

    pub(crate) fn finish(self) -> anyhow::Result<()> {
        if self.failed {
            bail!("some checks failed");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nsh_json_wins_over_store_files_and_screenshots_are_found_in_order() {
        let dir = std::env::temp_dir().join(format!("nsh-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let shots = dir.join("store/en-US/screenshots/phone");
        std::fs::create_dir_all(&shots).unwrap();
        std::fs::create_dir_all(dir.join("store/zh-Hans")).unwrap();
        std::fs::write(dir.join("store/en-US/release_notes.txt"), "From file\n").unwrap();
        std::fs::write(dir.join("store/en-US/description.txt"), "Described\n").unwrap();
        std::fs::write(dir.join("store/zh-Hans/whats_new.txt"), "更新").unwrap();
        for name in ["02.png", "01.png", "notes.md"] {
            std::fs::write(shots.join(name), b"x").unwrap();
        }
        std::fs::write(
            dir.join("nsh.json"),
            r#"{"id":"com.example.app","store":{"locales":{"en-US":{"whatsNew":"Inline","keywords":["a","b"]}},
               "ios":{"appId":6835723652,"usesNonExemptEncryption":false,"betaGroups":["QA"],"release":"phased"}}}"#,
        )
        .unwrap();
        let store = read(&dir).unwrap();
        let en = &store.locales["en-US"];
        assert_eq!(en.release_notes.as_deref(), Some("Inline"));
        assert_eq!(en.keywords.as_deref(), Some("a,b"));
        assert_eq!(en.description.as_deref(), Some("Described"));
        assert_eq!(
            en.screenshots["phone"],
            vec![shots.join("01.png"), shots.join("02.png")]
        );
        assert_eq!(
            store.locales["zh-Hans"].release_notes.as_deref(),
            Some("更新")
        );
        assert_eq!(store.ios.app_id.as_deref(), Some("6835723652"));
        assert_eq!(store.ios.uses_non_exempt_encryption, Some(false));
        assert_eq!(store.ios.beta_groups, ["QA"]);
        assert_eq!(store.ios.release, Some(ReleaseMode::Phased));

        std::fs::write(
            dir.join("nsh.json"),
            r#"{"store":{"locales":{"en-US":{"screenshots":{"phone":["missing.png"]}}}}}"#,
        )
        .unwrap();
        assert!(read(&dir).is_err());
        std::fs::write(
            dir.join("nsh.json"),
            r#"{"store":{"locales":{"english":{}}}}"#,
        )
        .unwrap();
        assert!(read(&dir).is_err());
        std::fs::write(dir.join("nsh.json"), r#"{"store":{"future":1}}"#).unwrap();
        assert!(read(&dir).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_platforms_own_images_and_texts_reach_its_locales() {
        let dir = std::env::temp_dir().join(format!("nsh-store-android-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let en = dir.join("store/en-US");
        std::fs::create_dir_all(en.join("android/phoneScreenshots")).unwrap();
        std::fs::create_dir_all(dir.join("store/zh-CN")).unwrap();
        std::fs::write(en.join("short_description.txt"), "Short\n").unwrap();
        std::fs::write(en.join("whats_new.txt"), "  \n").unwrap();
        for name in ["2.png", "1.png", "notes.md"] {
            std::fs::write(en.join("android/phoneScreenshots").join(name), b"x").unwrap();
        }
        std::fs::write(dir.join("store/zh-CN/release_notes.txt"), "修复").unwrap();
        std::fs::write(dir.join("nsh.json"), r#"{"id":"a.b"}"#).unwrap();
        let locales = read(&dir).unwrap().locales("android");
        assert_eq!(locales.len(), 2);
        assert_eq!(locales[0].tag, "en-US");
        assert_eq!(locales[0].short_description.as_deref(), Some("Short"));
        assert_eq!(locales[0].release_notes, None);
        assert_eq!(
            locales[0].images,
            [(
                "phoneScreenshots".to_owned(),
                vec![
                    en.join("android/phoneScreenshots/1.png"),
                    en.join("android/phoneScreenshots/2.png")
                ]
            )]
        );
        assert_eq!(locales[1].release_notes.as_deref(), Some("修复"));
        assert!(read(&dir).unwrap().locales("ios")[0].images.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn every_store_identity_is_under_its_platform() {
        let store: StoreConfig = serde_json::from_value(serde_json::json!({
            "ios": { "appId": 6835723652u64 },
            "linux": { "license": "MIT", "archiveUrl": "https://example.com/{version}.tar.gz" },
            "windows": { "storeId": "9NBLGGH4R315" }
        }))
        .unwrap();
        assert_eq!(store.ios.app_id.as_deref(), Some("6835723652"));
        assert_eq!(store.linux.license.as_deref(), Some("MIT"));
        assert_eq!(
            store.linux.archive_url.as_deref(),
            Some("https://example.com/{version}.tar.gz")
        );
        assert_eq!(store.windows.product_id.as_deref(), Some("9NBLGGH4R315"));
        let store: StoreConfig =
            serde_json::from_value(serde_json::json!({"windows": {"productId": "9N"}})).unwrap();
        assert_eq!(store.windows.product_id.as_deref(), Some("9N"));
    }

    #[test]
    fn query_values_are_escaped() {
        assert_eq!(query_value("1.2.0"), "1.2.0");
        assert_eq!(query_value("QA & Beta"), "QA%20%26%20Beta");
    }
}
