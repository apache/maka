//! `nsh.json` `"ios"` and `"macos"`: the `Info.plist` keys and the
//! entitlements an app adds to what `nsh package` writes for it, and how a
//! macOS app takes part in the system's UI (`macos.activationPolicy`), and
//! what iOS shows while the app starts (`ios.launchScreen`).
//!
//! Values are JSON, written as property list values (strings, numbers,
//! booleans, arrays, dictionaries). The keys NSH sets from other `nsh.json`
//! keys or that the runtime depends on are NSH's ([`ApplePlatform::reserved`]):
//! an app setting one is an error that names what to set instead. Every other
//! key the app sets replaces NSH's default, if it has one. The oldest system
//! the app runs on (`MinimumOSVersion`, `LSMinimumSystemVersion`) is such a
//! default, which an app raises for the APIs of a later system but never
//! lowers below the runtime's own ([`IOS_MINIMUM`], [`MACOS_MINIMUM`]);
//! builds of the app's Rust code compile for it too ([`AppleMinimums`]).
//!
//! `<platform>.infoPlistStrings` gives the text of `Info.plist` strings in
//! other languages, by language: packages write each language's
//! `<lang>.lproj/InfoPlist.strings`, which the system reads in place of
//! the `Info.plist` value for users of that language. The `Info.plist`
//! value is the text of every other language, so a translated key needs
//! one there ([`localized_info`]).

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use anyhow::bail;
use serde::Deserialize;

/// The oldest iOS the runtime runs on. Packages declare it
/// (`MinimumOSVersion`, and `actool`'s deployment target) unless the app
/// raises it, and every build `nsh` makes of an app's Rust code for iOS
/// compiles its Rust and C for it ([`AppleMinimums::deployment_target`]),
/// as nsh's own builds do (`.cargo/config.toml`'s
/// `IPHONEOS_DEPLOYMENT_TARGET`, `cargo xtask dist`).
pub(crate) const IOS_MINIMUM: &str = "15.0";

/// The oldest macOS the AppKit runtime runs on (its display links are
/// `NSView`'s, new in macOS 14). Packages declare it
/// (`LSMinimumSystemVersion`) unless the app raises it, and builds of an
/// app's Rust code for macOS compile for it as for iOS.
pub(crate) const MACOS_MINIMUM: &str = "14.0";

/// The oldest systems an app runs on, as its packages declare them: its
/// own `<platform>.infoPlist` minimum when it raises the runtime's, else
/// the runtime's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppleMinimums {
    /// iOS's (Mac Catalyst's too: its versions are iOS's).
    ios: String,
    /// macOS's.
    macos: String,
}

impl Default for AppleMinimums {
    fn default() -> Self {
        AppleMinimums {
            ios: IOS_MINIMUM.into(),
            macos: MACOS_MINIMUM.into(),
        }
    }
}

impl AppleMinimums {
    /// The minimums of the app whose `nsh.json` is `config`. A minimum the
    /// app sets is checked as packages check it; a section of another form
    /// is left to the reading of the whole `nsh.json` to reject.
    pub(crate) fn of(config: &serde_json::Value) -> anyhow::Result<Self> {
        let minimum = |platform: ApplePlatform| -> anyhow::Result<String> {
            let Some(value) = config
                .get(platform.key())
                .and_then(|section| section.get("infoPlist"))
                .and_then(|info| info.get(platform.minimum_key()))
            else {
                return Ok(platform.minimum().into());
            };
            check_minimum(value, platform, &format!("{}.infoPlist", platform.key()))?;
            Ok(value.as_str().unwrap_or_default().into())
        };
        Ok(AppleMinimums {
            ios: minimum(ApplePlatform::Ios)?,
            macos: minimum(ApplePlatform::Macos)?,
        })
    }

    /// The deployment target variable and version of a build for `triple`
    /// (`None`: this machine) when it is an Apple system's. rustc links for
    /// it and `cc` compiles C for it; without it they disagree (rustc's
    /// old default against the SDK's own version), and the C code may need
    /// a later system than the package declares, or fail to link.
    pub(crate) fn deployment_target(&self, triple: Option<&str>) -> Option<(&'static str, &str)> {
        let platform = match triple {
            Some(triple) if triple.contains("-apple-ios") => ApplePlatform::Ios,
            Some(triple) if triple.contains("-apple-darwin") => ApplePlatform::Macos,
            Some(_) => return None,
            None if cfg!(target_os = "macos") => ApplePlatform::Macos,
            None => return None,
        };
        Some(match platform {
            ApplePlatform::Ios => ("IPHONEOS_DEPLOYMENT_TARGET", &self.ios),
            ApplePlatform::Macos => ("MACOSX_DEPLOYMENT_TARGET", &self.macos),
        })
    }
}

/// `nsh.json` `"ios"` (and the keys [`MacosConfig`] shares with it).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppleConfig {
    /// Keys added to the app's `Info.plist`.
    #[serde(default)]
    pub(crate) info_plist: serde_json::Map<String, serde_json::Value>,
    /// The text of `Info.plist` strings in other languages, by language
    /// (`{ "zh-Hans": { "NSCameraUsageDescription": ".." } }`).
    #[serde(default)]
    pub(crate) info_plist_strings: serde_json::Map<String, serde_json::Value>,
    /// Entitlements the app is signed with. iOS device builds check them
    /// against the provisioning profile.
    #[serde(default)]
    pub(crate) entitlements: serde_json::Map<String, serde_json::Value>,
    /// What iOS shows from the tap on the app's icon until the app's first
    /// frame: the system's background without it.
    pub(crate) launch_screen: Option<LaunchScreen>,
    /// App extensions the app builds itself, which iOS packages carry in
    /// `PlugIns/` ([`crate::app_extensions`]).
    #[serde(default)]
    pub(crate) extensions: Vec<crate::app_extensions::AppExtension>,
    /// The app's privacy manifest, which iOS packages carry as
    /// `PrivacyInfo.xcprivacy` ([`keep_privacy_manifest`] leaves out what
    /// is not one of its keys in its form).
    #[serde(default)]
    pub(crate) privacy_manifest: serde_json::Map<String, serde_json::Value>,
}

/// `nsh.json` `ios.launchScreen`: a background color and an image in the
/// middle of the screen, each one for both appearances or one for each.
/// Packages compile them into the app's asset catalog and name them in
/// `UILaunchScreen`, so the system draws them before the app runs.
#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchScreen {
    /// The screen's color (`"#131312"`, or `{ "light": .., "dark": .. }`).
    pub(crate) background: Option<Themed<Color>>,
    /// A PNG relative to `nsh.json`, drawn for 3x screens: the system
    /// shows it centered, at a third of its pixel size in points.
    pub(crate) image: Option<Themed<PathBuf>>,
}

/// One value for both appearances, or one for each.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub(crate) enum Themed<T> {
    /// The value in light and dark appearance.
    Both(T),
    /// A value for each appearance.
    Each {
        /// In light appearance.
        light: T,
        /// In dark appearance.
        dark: T,
    },
}

impl<T> Themed<T> {
    /// The light value, and the dark one when it differs.
    pub(crate) fn variants(&self) -> (&T, Option<&T>) {
        match self {
            Themed::Both(value) => (value, None),
            Themed::Each { light, dark } => (light, Some(dark)),
        }
    }

    fn map<U>(self, f: impl Fn(T) -> U) -> Themed<U> {
        match self {
            Themed::Both(value) => Themed::Both(f(value)),
            Themed::Each { light, dark } => Themed::Each {
                light: f(light),
                dark: f(dark),
            },
        }
    }
}

/// An sRGB color written `#rrggbb` or `#rrggbbaa`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub(crate) struct Color(pub(crate) [u8; 4]);

impl TryFrom<String> for Color {
    type Error = String;

    fn try_from(text: String) -> Result<Self, String> {
        let digits = text.strip_prefix('#').unwrap_or_default();
        let byte = |i: usize| u8::from_str_radix(digits.get(i * 2..i * 2 + 2)?, 16).ok();
        let alpha = match digits.len() {
            6 => Some(255),
            8 => byte(3),
            _ => None,
        };
        // Digits only: `from_str_radix` also takes a sign.
        let hex = digits.bytes().all(|b| b.is_ascii_hexdigit());
        match (hex, byte(0), byte(1), byte(2), alpha) {
            (true, Some(r), Some(g), Some(b), Some(a)) => Ok(Color([r, g, b, a])),
            _ => Err(format!(
                "{text:?} is no color; write `#rrggbb` or `#rrggbbaa`"
            )),
        }
    }
}

impl LaunchScreen {
    /// The same, with its image relative to `dir`.
    pub(crate) fn relative_to(self, dir: &Path) -> Self {
        LaunchScreen {
            image: self.image.map(|image| image.map(|path| dir.join(path))),
            ..self
        }
    }
}

/// `nsh.json` `"macos"`: [`AppleConfig`]'s keys, and the app's activation
/// policy, which iOS has no counterpart of.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MacosConfig {
    /// Keys added to the app's `Info.plist`.
    #[serde(default)]
    pub(crate) info_plist: serde_json::Map<String, serde_json::Value>,
    /// The text of `Info.plist` strings in other languages, as `ios`'s.
    #[serde(default)]
    pub(crate) info_plist_strings: serde_json::Map<String, serde_json::Value>,
    /// Entitlements the app is signed with.
    #[serde(default)]
    pub(crate) entitlements: serde_json::Map<String, serde_json::Value>,
    /// How the app takes part in the system's UI. Every way NSH starts it
    /// on macOS applies it before the app's code runs: packages say so in
    /// their `Info.plist` (`LSUIElement`) and `app.json` (as the Rust apps
    /// `nsh run` runs in place do), `nsh run` and `nsh test` pass it to the
    /// development host (`--activation-policy`).
    #[serde(default)]
    pub(crate) activation_policy: ActivationPolicy,
    /// App extensions the app builds itself, which macOS packages carry in
    /// `Contents/PlugIns/` ([`crate::app_extensions`]).
    #[serde(default)]
    pub(crate) extensions: Vec<crate::app_extensions::AppExtension>,
}

/// `nsh.json` `macos.activationPolicy`, as GPUI's `ActivationPolicy`. Read
/// from its name only: serde's own enums also take an object
/// (`{ "accessory": null }`), and one `nsh.json`'s reader could not leave
/// out as it does a value of another form.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub(crate) enum ActivationPolicy {
    /// A Dock icon, the menu bar while the app is active, a place in the
    /// app switcher.
    #[default]
    Regular,
    /// None of them: a menu bar app.
    Accessory,
}

impl ActivationPolicy {
    /// Its name in `nsh.json`, `app.json` and the development host's
    /// `--activation-policy`.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ActivationPolicy::Regular => "regular",
            ActivationPolicy::Accessory => "accessory",
        }
    }
}

impl TryFrom<String> for ActivationPolicy {
    type Error = String;

    fn try_from(name: String) -> Result<Self, String> {
        match name.as_str() {
            "regular" => Ok(ActivationPolicy::Regular),
            "accessory" => Ok(ActivationPolicy::Accessory),
            _ => Err(format!(
                "unknown variant `{name}`, expected `regular` or `accessory`"
            )),
        }
    }
}

/// The Apple platform an [`AppleConfig`] is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApplePlatform {
    Ios,
    Macos,
}

/// Why a key is NSH's to set.
#[derive(Debug, Clone, Copy)]
enum Owner {
    /// Set from this `nsh.json` key.
    Config(&'static str),
    /// Set by the packaging itself: the runtime or the system depends on it.
    Package,
}

/// The `Info.plist` keys of every Apple package that are NSH's.
const RESERVED_INFO: [(&str, Owner); 9] = [
    ("CFBundleIdentifier", Owner::Config("id")),
    ("CFBundleName", Owner::Config("name")),
    ("CFBundleDisplayName", Owner::Config("name")),
    ("CFBundleShortVersionString", Owner::Config("version")),
    ("CFBundleVersion", Owner::Config("build")),
    ("CFBundleURLTypes", Owner::Config("schemes")),
    ("CFBundleDocumentTypes", Owner::Config("fileTypes")),
    ("CFBundleExecutable", Owner::Package),
    ("CFBundlePackageType", Owner::Package),
];

/// Whether `key` of an Apple app's `Info.plist` is one NSH sets itself.
pub(crate) fn is_reserved_info(platform: ApplePlatform, key: &str) -> bool {
    platform.reserved().any(|(k, _)| *k == key)
}

/// Whether `key` of an Apple app's entitlements is one NSH sets itself
/// ([`RESERVED_ENTITLEMENTS`]).
pub(crate) fn is_reserved_entitlement(key: &str) -> bool {
    RESERVED_ENTITLEMENTS.iter().any(|(k, _)| *k == key)
}

/// The `Info.plist` keys of iOS packages that are NSH's, besides
/// [`RESERVED_INFO`].
const RESERVED_IOS_INFO: [(&str, Owner); 10] = [
    ("CFBundleIcons", Owner::Config("icon")),
    ("CFBundleIcons~ipad", Owner::Config("icon")),
    ("CFBundleIconName", Owner::Config("icon")),
    ("UIUserInterfaceStyle", Owner::Config("appearance")),
    ("UIStatusBarStyle", Owner::Config("statusBar")),
    ("UIStatusBarHidden", Owner::Config("statusBar")),
    ("CFBundleSupportedPlatforms", Owner::Package),
    ("LSRequiresIPhoneOS", Owner::Package),
    ("UIApplicationSceneManifest", Owner::Package),
    ("UIApplicationSupportsMultipleScenes", Owner::Package),
];

/// The `Info.plist` keys of macOS packages that are NSH's, besides
/// [`RESERVED_INFO`].
const RESERVED_MACOS_INFO: [(&str, Owner); 4] = [
    ("CFBundleIconFile", Owner::Config("icon")),
    ("LSUIElement", Owner::Config("macos.activationPolicy")),
    ("CFBundleSupportedPlatforms", Owner::Package),
    ("NSPrincipalClass", Owner::Package),
];

/// The entitlements that are NSH's: the app's identity, which signing
/// derives from its `id` and the provisioning profile.
const RESERVED_ENTITLEMENTS: [(&str, Owner); 3] = [
    ("application-identifier", Owner::Config("id")),
    ("com.apple.application-identifier", Owner::Config("id")),
    ("com.apple.developer.team-identifier", Owner::Package),
];

impl ApplePlatform {
    /// Its key in `nsh.json`.
    pub(crate) fn key(self) -> &'static str {
        match self {
            ApplePlatform::Ios => "ios",
            ApplePlatform::Macos => "macos",
        }
    }

    /// The `Info.plist` keys NSH sets on this platform that apps may not.
    fn reserved(self) -> impl Iterator<Item = &'static (&'static str, Owner)> + Clone {
        let own: &'static [(&str, Owner)] = match self {
            ApplePlatform::Ios => &RESERVED_IOS_INFO,
            ApplePlatform::Macos => &RESERVED_MACOS_INFO,
        };
        RESERVED_INFO.iter().chain(own)
    }

    /// Whether apps translate `key` (`infoPlistStrings`): any key but
    /// those NSH sets ([`Self::reserved`]), of which only the app's name.
    fn translatable(self, key: &str) -> bool {
        TRANSLATED_RESERVED_INFO.contains(&key) || !self.reserved().any(|(k, _)| *k == key)
    }

    /// The system's name, for errors.
    fn os(self) -> &'static str {
        match self {
            ApplePlatform::Ios => "iOS",
            ApplePlatform::Macos => "macOS",
        }
    }

    /// The `Info.plist` key of the oldest system version the app runs on.
    fn minimum_key(self) -> &'static str {
        match self {
            ApplePlatform::Ios => "MinimumOSVersion",
            ApplePlatform::Macos => "LSMinimumSystemVersion",
        }
    }

    /// The oldest system version the runtime runs on: the
    /// [`minimum_key`](Self::minimum_key) of packages whose app does not
    /// raise it.
    fn minimum(self) -> &'static str {
        match self {
            ApplePlatform::Ios => IOS_MINIMUM,
            ApplePlatform::Macos => MACOS_MINIMUM,
        }
    }
}

impl AppleConfig {
    /// The app's `Info.plist` keys as property list values.
    pub(crate) fn info_plist(&self, platform: ApplePlatform) -> anyhow::Result<plist::Dictionary> {
        info_plist(&self.info_plist, platform)
    }

    /// The app's `Info.plist` strings in other languages.
    pub(crate) fn info_plist_strings(
        &self,
        platform: ApplePlatform,
    ) -> anyhow::Result<InfoPlistStrings> {
        info_plist_strings(&self.info_plist_strings, platform)
    }

    /// The `InfoPlist.strings` files of a package whose `Info.plist` is
    /// `info` ([`localized_info`]).
    pub(crate) fn localized_info(
        &self,
        platform: ApplePlatform,
        info: &plist::Dictionary,
    ) -> anyhow::Result<BTreeMap<String, String>> {
        localized_info(&self.info_plist_strings(platform)?, info, platform)
    }

    /// The app's entitlements as property list values.
    pub(crate) fn entitlements(
        &self,
        platform: ApplePlatform,
    ) -> anyhow::Result<plist::Dictionary> {
        entitlements(&self.entitlements, platform)
    }

    /// Checks both when `nsh.json` is read, so a mistake shows before a
    /// build.
    pub(crate) fn check(&self, platform: ApplePlatform) -> anyhow::Result<()> {
        self.info_plist(platform)?;
        self.info_plist_strings(platform)?;
        self.entitlements(platform)?;
        for extension in &self.extensions {
            extension_entitlements(extension, platform)?;
        }
        if self.launch_screen.is_some() && self.info_plist.contains_key("UILaunchScreen") {
            bail!(
                "nsh.json {0}.infoPlist: `UILaunchScreen` is set by NSH from `{0}.launchScreen`; \
                 set one of them",
                platform.key()
            );
        }
        Ok(())
    }
}

impl MacosConfig {
    /// The app's `Info.plist` keys as property list values.
    pub(crate) fn info_plist(&self) -> anyhow::Result<plist::Dictionary> {
        info_plist(&self.info_plist, ApplePlatform::Macos)
    }

    /// The app's `Info.plist` strings in other languages.
    pub(crate) fn info_plist_strings(&self) -> anyhow::Result<InfoPlistStrings> {
        info_plist_strings(&self.info_plist_strings, ApplePlatform::Macos)
    }

    /// The `InfoPlist.strings` files of a package whose `Info.plist` is
    /// `info` ([`localized_info`]).
    pub(crate) fn localized_info(
        &self,
        info: &plist::Dictionary,
    ) -> anyhow::Result<BTreeMap<String, String>> {
        localized_info(&self.info_plist_strings()?, info, ApplePlatform::Macos)
    }

    /// The app's entitlements as property list values.
    pub(crate) fn entitlements(&self) -> anyhow::Result<plist::Dictionary> {
        entitlements(&self.entitlements, ApplePlatform::Macos)
    }

    /// Checks both when `nsh.json` is read, so a mistake shows before a
    /// build.
    pub(crate) fn check(&self) -> anyhow::Result<()> {
        self.info_plist()?;
        self.info_plist_strings()?;
        self.entitlements()?;
        for extension in &self.extensions {
            extension_entitlements(extension, ApplePlatform::Macos)?;
        }
        Ok(())
    }

    /// The development host's arguments that start the app as `nsh.json`
    /// says (`nsh run`, `nsh test`): none for the default.
    pub(crate) fn host_args(&self) -> Vec<&'static str> {
        match self.activation_policy {
            ActivationPolicy::Regular => Vec::new(),
            policy => vec!["--activation-policy", policy.as_str()],
        }
    }

    /// Adds to `info`, the app's `app.json`, what the release runner reads
    /// before the app's code runs: nothing for the default.
    pub(crate) fn add_to_app_json(&self, info: &mut serde_json::Value) {
        if self.activation_policy != ActivationPolicy::Regular {
            info["activationPolicy"] = self.activation_policy.as_str().into();
        }
    }
}

/// The keys of a privacy manifest (`PrivacyInfo.xcprivacy`) and, for the
/// arrays of dictionaries, the keys their entries have, each of which an
/// entry must have: Apple's "Privacy manifest files", which App Store
/// Connect checks for exactly these.
const PRIVACY_KEYS: [(&str, PrivacyForm); 4] = [
    ("NSPrivacyTracking", PrivacyForm::Boolean),
    ("NSPrivacyTrackingDomains", PrivacyForm::Strings),
    (
        "NSPrivacyCollectedDataTypes",
        PrivacyForm::Entries(&[
            ("NSPrivacyCollectedDataType", PrivacyForm::String),
            ("NSPrivacyCollectedDataTypeLinked", PrivacyForm::Boolean),
            ("NSPrivacyCollectedDataTypeTracking", PrivacyForm::Boolean),
            ("NSPrivacyCollectedDataTypePurposes", PrivacyForm::Strings),
        ]),
    ),
    (
        "NSPrivacyAccessedAPITypes",
        PrivacyForm::Entries(&[
            ("NSPrivacyAccessedAPIType", PrivacyForm::String),
            ("NSPrivacyAccessedAPITypeReasons", PrivacyForm::Strings),
        ]),
    ),
];

/// The form of a privacy manifest value.
#[derive(Clone, Copy)]
enum PrivacyForm {
    Boolean,
    String,
    Strings,
    /// An array of dictionaries with exactly these keys, each its form.
    Entries(&'static [(&'static str, PrivacyForm)]),
}

impl PrivacyForm {
    /// Whether `value` has this form (an array of entries: is an array).
    fn fits(self, value: &serde_json::Value) -> bool {
        use serde_json::Value as Json;
        match (self, value) {
            (PrivacyForm::Boolean, Json::Bool(_)) | (PrivacyForm::String, Json::String(_)) => true,
            (PrivacyForm::Strings, Json::Array(items)) => items.iter().all(Json::is_string),
            (PrivacyForm::Entries(_), Json::Array(_)) => true,
            _ => false,
        }
    }

    /// What is wrong with `entry` of an array of entries with `keys`, if
    /// anything: a key of another kind or form, or one it lacks.
    fn entry_problem(
        keys: &[(&'static str, PrivacyForm)],
        entry: &serde_json::Value,
    ) -> Option<String> {
        let Some(entry) = entry.as_object() else {
            return Some("is no dictionary".into());
        };
        for (key, value) in entry {
            match keys.iter().find(|(name, _)| name == key) {
                None => return Some(format!("has `{key}`, which is no key of it")),
                Some((_, form)) if !form.fits(value) => {
                    return Some(format!("`{key}` is not in its form"));
                }
                Some(_) => {}
            }
        }
        keys.iter()
            .find(|(name, _)| !entry.contains_key(*name))
            .map(|(name, _)| format!("lacks `{name}`"))
    }
}

/// Keeps the keys of `nsh.json` `ios.privacyManifest` (`manifest`) that are
/// a privacy manifest's, in their form, and of its arrays of entries the
/// entries that are whole: each other key or entry is reported in
/// `ignored` and left out, as any `nsh.json` value an `nsh` cannot read
/// is. What App Store Connect would refuse in the values it keeps (an
/// entry without reasons, tracking without its domains) is reported too.
pub(crate) fn keep_privacy_manifest(
    manifest: &mut serde_json::Map<String, serde_json::Value>,
    ignored: &mut Vec<String>,
) {
    let at = "ios.privacyManifest";
    manifest.retain(|key, value| {
        let Some((_, form)) = PRIVACY_KEYS.iter().find(|(name, _)| name == key) else {
            ignored.push(format!(
                "unknown key `{at}.{key}`: a privacy manifest has {}",
                PRIVACY_KEYS
                    .iter()
                    .map(|(name, _)| format!("`{name}`"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            return false;
        };
        if !form.fits(value) {
            ignored.push(format!(
                "{at}.{key}: not in the form a privacy manifest has"
            ));
            return false;
        }
        if let (PrivacyForm::Entries(keys), serde_json::Value::Array(entries)) = (form, value) {
            let mut i = 0;
            entries.retain(|entry| {
                let problem = PrivacyForm::entry_problem(keys, entry);
                if let Some(problem) = &problem {
                    ignored.push(format!("{at}.{key}[{i}] {problem}: left out"));
                }
                i += 1;
                problem.is_none()
            });
        }
        true
    });
    // Kept, but what App Store Connect refuses as it is.
    let mut refused = |problem: String| {
        ignored.push(format!("{at}: {problem}, which App Store Connect refuses"));
    };
    let accessed = manifest
        .get("NSPrivacyAccessedAPITypes")
        .and_then(serde_json::Value::as_array);
    if accessed.is_some_and(Vec::is_empty) {
        refused("`NSPrivacyAccessedAPITypes` is empty".into());
    }
    for (i, entry) in accessed.into_iter().flatten().enumerate() {
        if entry["NSPrivacyAccessedAPITypeReasons"]
            .as_array()
            .is_some_and(Vec::is_empty)
        {
            refused(format!("`NSPrivacyAccessedAPITypes[{i}]` gives no reason"));
        }
    }
    let tracking = manifest
        .get("NSPrivacyTracking")
        .and_then(serde_json::Value::as_bool);
    let domains = manifest
        .get("NSPrivacyTrackingDomains")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|d| !d.is_empty());
    match (tracking, domains) {
        (Some(true), false) => refused("`NSPrivacyTracking` is on with no tracking domains".into()),
        (Some(false) | None, true) => {
            refused("tracking domains are listed with `NSPrivacyTracking` off".into());
        }
        _ => {}
    }
}

/// Writes the app's privacy manifest (`nsh.json` `ios.privacyManifest`)
/// into the iOS app bundle `app`, where the system and App Store Connect
/// read it, before the bundle is signed; nothing when the app has none.
pub(crate) fn write_privacy_manifest(
    manifest: &serde_json::Map<String, serde_json::Value>,
    app: &std::path::Path,
) -> anyhow::Result<()> {
    if manifest.is_empty() {
        return Ok(());
    }
    let dictionary = convert(manifest, "ios.privacyManifest", std::iter::empty())?;
    plist::Value::Dictionary(dictionary)
        .to_file_xml(app.join("PrivacyInfo.xcprivacy"))
        .map_err(|e| anyhow::anyhow!("write PrivacyInfo.xcprivacy: {e}"))
}

/// `nsh.json` `<platform>.infoPlist` as property list values.
fn info_plist(
    entries: &serde_json::Map<String, serde_json::Value>,
    platform: ApplePlatform,
) -> anyhow::Result<plist::Dictionary> {
    let section = format!("{}.infoPlist", platform.key());
    if let Some(value) = entries.get(platform.minimum_key()) {
        check_minimum(value, platform, &section)?;
    }
    convert(entries, &section, platform.reserved())
}

/// `Info.plist` strings in other languages: by language (`"zh-Hans"`),
/// the text of each key.
pub(crate) type InfoPlistStrings = BTreeMap<String, BTreeMap<String, String>>;

/// The keys of NSH's that apps translate: the app's name, which NSH sets
/// from `name` in the language of `Info.plist`.
const TRANSLATED_RESERVED_INFO: [&str; 2] = ["CFBundleDisplayName", "CFBundleName"];

/// Whether an app or a crate may translate `key` of `platform`'s
/// `Info.plist` ([`ApplePlatform::translatable`]).
pub(crate) fn is_translatable_info(platform: ApplePlatform, key: &str) -> bool {
    platform.translatable(key)
}

/// `nsh.json` `<platform>.infoPlistStrings`, checked: each language's code
/// ([`check_language`]), an object of strings, of keys apps translate.
fn info_plist_strings(
    entries: &serde_json::Map<String, serde_json::Value>,
    platform: ApplePlatform,
) -> anyhow::Result<InfoPlistStrings> {
    let section = format!("{}.infoPlistStrings", platform.key());
    let mut languages = InfoPlistStrings::new();
    for (language, texts) in entries {
        if let Err(why) = check_language(language) {
            bail!("nsh.json {section}: {why}");
        }
        let Some(texts) = texts.as_object() else {
            bail!(
                "nsh.json {section}.{language}: {texts} is no object; write the language's text of \
                 each `Info.plist` key, as `{{ \"NSCameraUsageDescription\": \"..\" }}`"
            );
        };
        let mut strings = BTreeMap::new();
        for (key, text) in texts {
            if !platform.translatable(key) {
                bail!(
                    "nsh.json {section}.{language}: `{key}` is set by NSH and not translated; of \
                     NSH's keys, apps translate the app's name (`CFBundleDisplayName`, `CFBundleName`)"
                );
            }
            let Some(text) = text.as_str() else {
                bail!(
                    "nsh.json {section}.{language}.{key}: {text} is no string; `InfoPlist.strings` \
                     translates strings only"
                );
            };
            strings.insert(key.clone(), text.to_owned());
        }
        languages.insert(language.clone(), strings);
    }
    Ok(languages)
}

/// Checks `code` names a language as `.lproj` directories do: a language
/// (`en`, `fil`), then a script (`Hans`) or a region (`BR`, `419`) or
/// both, joined with `-` as Xcode names them (`zh-Hans`, `pt-BR`,
/// `zh-Hant-HK`), cased as the system names them: the system finds the
/// directory by this name. The older `_` (`zh_TW`) is refused, so one
/// language never has two directories.
pub(crate) fn check_language(code: &str) -> Result<(), String> {
    let mut parts = code.split('-');
    let language = parts.next().unwrap_or_default();
    let mut ok =
        (2..=3).contains(&language.len()) && language.bytes().all(|b| b.is_ascii_lowercase());
    let mut script = false;
    let mut region = false;
    for part in parts {
        let bytes = part.as_bytes();
        if !script
            && !region
            && bytes.len() == 4
            && bytes[0].is_ascii_uppercase()
            && bytes[1..].iter().all(u8::is_ascii_lowercase)
        {
            script = true;
        } else if !region
            && ((bytes.len() == 2 && bytes.iter().all(u8::is_ascii_uppercase))
                || (bytes.len() == 3 && bytes.iter().all(u8::is_ascii_digit)))
        {
            region = true;
        } else {
            ok = false;
        }
    }
    if ok {
        Ok(())
    } else {
        Err(format!(
            "{code:?} is no language code; write a language, then a script or a region if needed, \
             joined with `-` and cased as the system names them: \"en\", \"ja\", \"zh-Hans\", \
             \"zh-Hant\", \"pt-BR\""
        ))
    }
}

/// The `<lang>.lproj/InfoPlist.strings` files of a package whose
/// `Info.plist` is `info`, by language: `strings`, each key checked against
/// `info`. A key without a string there is an error: the system shows the
/// translated text only in place of the `Info.plist` value, and the users
/// of every language without one see that value, so a translation of a
/// missing key never shows (a misspelled key, a usage description left out).
pub(crate) fn localized_info(
    strings: &InfoPlistStrings,
    info: &plist::Dictionary,
    platform: ApplePlatform,
) -> anyhow::Result<BTreeMap<String, String>> {
    let section = format!("{}.infoPlistStrings", platform.key());
    let mut files = BTreeMap::new();
    for (language, texts) in strings {
        for key in texts.keys() {
            match info.get(key) {
                Some(plist::Value::String(_)) => {}
                Some(_) => bail!(
                    "nsh.json {section}.{language}.{key}: the app's Info.plist value of `{key}` is \
                     no string; `InfoPlist.strings` translates strings only"
                ),
                None => bail!(
                    "nsh.json {section}.{language}.{key}: the app's Info.plist has no `{key}`; set \
                     its text in `{}.infoPlist`, which users of the other languages see",
                    platform.key()
                ),
            }
        }
        if !texts.is_empty() {
            files.insert(language.clone(), strings_file(texts));
        }
    }
    Ok(files)
}

/// `texts` as a strings file: `"key" = "text";` lines, quoted and escaped
/// as the system's old-style property lists read them, in UTF-8.
pub(crate) fn strings_file(texts: &BTreeMap<String, String>) -> String {
    let mut out = String::new();
    for (key, text) in texts {
        quote(&mut out, key);
        out.push_str(" = ");
        quote(&mut out, text);
        out.push_str(";\n");
    }
    out
}

/// Appends `text` to `out` in quotes, escaping the quote, the backslash and
/// control characters.
fn quote(out: &mut String, text: &str) {
    use std::fmt::Write as _;
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                let _ = write!(out, "\\U{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Writes `files` (by language, [`localized_info`]) to `dir` as
/// `<lang>.lproj/InfoPlist.strings`, and removes the `InfoPlist.strings`
/// of the other languages a previous write left there (a refreshed
/// development host), with their directory when nothing else is in it.
/// Whether anything changed.
pub(crate) fn write_localized_info(
    dir: &Path,
    files: &BTreeMap<String, String>,
) -> anyhow::Result<bool> {
    let mut changed = false;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries {
            let path = entry?.path();
            let stale = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_suffix(".lproj"))
                .is_some_and(|language| !files.contains_key(language));
            let file = path.join("InfoPlist.strings");
            if stale && file.exists() {
                std::fs::remove_file(&file)?;
                // Only when empty: another file of the language stays.
                let _ = std::fs::remove_dir(&path);
                changed = true;
            }
        }
    }
    for (language, text) in files {
        let file = dir
            .join(format!("{language}.lproj"))
            .join("InfoPlist.strings");
        if std::fs::read_to_string(&file).ok().as_deref() == Some(text.as_str()) {
            continue;
        }
        std::fs::create_dir_all(file.parent().expect("a file in a directory"))?;
        std::fs::write(&file, text)?;
        changed = true;
    }
    Ok(changed)
}

/// Checks the app's own minimum system version (`value`, its
/// [`ApplePlatform::minimum_key`] in `section`): a version string that
/// raises the runtime's minimum or names it, never one below it, which
/// would let the system install the app where the runtime cannot run.
fn check_minimum(
    value: &serde_json::Value,
    platform: ApplePlatform,
    section: &str,
) -> anyhow::Result<()> {
    let minimum = platform.minimum();
    let problem = match value {
        serde_json::Value::String(text) => match version(text) {
            Some(raised) if version(minimum).is_some_and(|floor| raised >= floor) => {
                return Ok(());
            }
            Some(_) => format!("{text:?} is below NSH's minimum"),
            None => format!("{text:?} is no version"),
        },
        other => format!("{other} is no string"),
    };
    bail!(
        "nsh.json {section}.{}: {problem}; write the {} version the app needs as a string of \
         numbers and dots, from NSH's minimum, \"{minimum}\", up",
        platform.minimum_key(),
        platform.os()
    )
}

/// The numbers of a version string of one to three (`"15"`, `"15.2"`,
/// `"15.2.1"`), those left out 0, so `"14"` is `"14.0"`; `None` for
/// anything else.
fn version(text: &str) -> Option<[u32; 3]> {
    let mut numbers = [0; 3];
    for (i, part) in text.split('.').enumerate() {
        // Digits only: `parse` also takes a sign.
        if i == numbers.len() || part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        numbers[i] = part.parse().ok()?;
    }
    Some(numbers)
}

/// `nsh.json` `<platform>.entitlements` as property list values.
fn entitlements(
    entries: &serde_json::Map<String, serde_json::Value>,
    platform: ApplePlatform,
) -> anyhow::Result<plist::Dictionary> {
    let section = format!("{}.entitlements", platform.key());
    convert(entries, &section, RESERVED_ENTITLEMENTS.iter())
}

/// The entitlements of one of `ios.extensions` or `macos.extensions` as
/// property list values, refusing the keys `<platform>.entitlements` refuses,
/// with the `nsh.json` key they come from, for errors.
pub(crate) fn extension_entitlements(
    extension: &crate::app_extensions::AppExtension,
    platform: ApplePlatform,
) -> anyhow::Result<(plist::Dictionary, String)> {
    let section = format!(
        "{}.extensions[{}].entitlements",
        platform.key(),
        extension.index
    );
    let dictionary = convert(
        &extension.entitlements,
        &section,
        RESERVED_ENTITLEMENTS.iter(),
    )?;
    Ok((dictionary, section))
}

/// `entries` as a property list dictionary, refusing the `reserved` keys.
fn convert<'a>(
    entries: &serde_json::Map<String, serde_json::Value>,
    section: &str,
    reserved: impl Iterator<Item = &'a (&'static str, Owner)> + Clone,
) -> anyhow::Result<plist::Dictionary> {
    let mut dictionary = plist::Dictionary::new();
    for (key, value) in entries {
        if let Some((_, owner)) = reserved.clone().find(|(name, _)| name == key) {
            match owner {
                Owner::Config(config) => bail!(
                    "nsh.json {section}: `{key}` is set by NSH from `{config}`; set `{config}` instead"
                ),
                Owner::Package => bail!(
                    "nsh.json {section}: `{key}` is set by NSH, as the packaged app depends on its value"
                ),
            }
        }
        dictionary.insert(key.clone(), to_plist(value, &format!("{section}.{key}"))?);
    }
    Ok(dictionary)
}

/// A JSON value as a property list value: strings, booleans, integers,
/// reals, arrays and dictionaries; `null` has no property list form.
fn to_plist(value: &serde_json::Value, path: &str) -> anyhow::Result<plist::Value> {
    use serde_json::Value as Json;
    Ok(match value {
        Json::Null => bail!("nsh.json {path}: null has no property list form"),
        Json::Bool(b) => plist::Value::Boolean(*b),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                plist::Value::Integer(i.into())
            } else if let Some(u) = n.as_u64() {
                plist::Value::Integer(u.into())
            } else {
                plist::Value::Real(n.as_f64().unwrap_or_default())
            }
        }
        Json::String(s) => plist::Value::String(s.clone()),
        Json::Array(items) => plist::Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(i, item)| to_plist(item, &format!("{path}[{i}]")))
                .collect::<anyhow::Result<_>>()?,
        ),
        Json::Object(entries) => plist::Value::Dictionary(
            entries
                .iter()
                .map(|(key, item)| Ok((key.clone(), to_plist(item, &format!("{path}.{key}"))?)))
                .collect::<anyhow::Result<_>>()?,
        ),
    })
}

/// Adds the app's entitlements (`requested`, from `nsh.json` `section`:
/// `ios.entitlements`, or an app extension's) to those a provisioning
/// profile grants (`granted`), checking that the profile covers each one.
/// The app's value replaces the profile's: a profile grants
/// `com.apple.developer.associated-domains` as `*`, the app names its
/// domains.
pub(crate) fn grant(
    granted: &mut plist::Dictionary,
    requested: plist::Dictionary,
    section: &str,
) -> anyhow::Result<()> {
    for (key, value) in requested {
        let Some(allowed) = granted.get(&key) else {
            bail!(
                "the provisioning profile does not grant the entitlement `{key}` (nsh.json {section}): \
                 enable its capability for the app's identifier and download the profile again"
            );
        };
        if !covers(allowed, &value) {
            bail!(
                "the provisioning profile grants `{key}` as {}, which does not cover {} (nsh.json {section})",
                describe(allowed),
                describe(&value)
            );
        }
        granted.insert(key, value);
    }
    Ok(())
}

/// Whether a profile's entitlement value covers the app's: equal, a string
/// pattern (`*`, `TEAMID.*`) matching it or each of its strings, an array
/// whose items cover each of its items, `true` covering `false`, a
/// dictionary covering each of its keys.
fn covers(allowed: &plist::Value, value: &plist::Value) -> bool {
    use plist::Value;
    if allowed == value {
        return true;
    }
    match (allowed, value) {
        (Value::String(pattern), Value::String(value)) => matches(pattern, value),
        (Value::String(_), Value::Array(items)) => items.iter().all(|item| covers(allowed, item)),
        (Value::Array(allowed), Value::Array(items)) => items
            .iter()
            .all(|item| allowed.iter().any(|allowed| covers(allowed, item))),
        (Value::Array(allowed), item) => allowed.iter().any(|allowed| covers(allowed, item)),
        (Value::Boolean(allowed), Value::Boolean(value)) => *allowed || !*value,
        (Value::Dictionary(allowed), Value::Dictionary(entries)) => {
            entries.iter().all(|(key, item)| {
                allowed
                    .get(key)
                    .is_some_and(|allowed| covers(allowed, item))
            })
        }
        _ => false,
    }
}

/// Whether a profile's string `pattern` (`*`, `TEAMID.*` or a value)
/// matches `value`.
fn matches(pattern: &str, value: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => value.starts_with(prefix),
        None => pattern == value,
    }
}

/// A property list value as JSON-like text, for errors.
fn describe(value: &plist::Value) -> String {
    use plist::Value;
    match value {
        Value::String(s) => format!("{s:?}"),
        Value::Boolean(b) => b.to_string(),
        Value::Integer(i) => i.to_string(),
        Value::Real(r) => r.to_string(),
        Value::Array(items) => {
            let items: Vec<String> = items.iter().map(describe).collect();
            format!("[{}]", items.join(", "))
        }
        Value::Dictionary(entries) => {
            let entries: Vec<String> = entries
                .iter()
                .map(|(key, item)| format!("{key:?}: {}", describe(item)))
                .collect();
            format!("{{{}}}", entries.join(", "))
        }
        _ => "a value".to_owned(),
    }
}

/// Whether macOS launches an app signed with `entitlement` only under a
/// provisioning profile that grants it: the `com.apple.developer.*` ones
/// (associated domains, iCloud, push) and keychain access groups.
pub(crate) fn needs_profile(entitlement: &str) -> bool {
    entitlement.starts_with("com.apple.developer.") || entitlement == "keychain-access-groups"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(json: serde_json::Value) -> AppleConfig {
        serde_json::from_value(json).unwrap()
    }

    /// A privacy manifest as Apple's documentation writes one.
    fn privacy() -> serde_json::Map<String, serde_json::Value> {
        serde_json::json!({
            "NSPrivacyTracking": false,
            "NSPrivacyTrackingDomains": [],
            "NSPrivacyCollectedDataTypes": [{
                "NSPrivacyCollectedDataType": "NSPrivacyCollectedDataTypeCrashData",
                "NSPrivacyCollectedDataTypeLinked": false,
                "NSPrivacyCollectedDataTypeTracking": false,
                "NSPrivacyCollectedDataTypePurposes": ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
            }],
            "NSPrivacyAccessedAPITypes": [{
                "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryUserDefaults",
                "NSPrivacyAccessedAPITypeReasons": ["CA92.1"],
            }],
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn a_privacy_manifest_keeps_its_own_keys_in_their_form() {
        let mut manifest = privacy();
        let mut ignored = Vec::new();
        keep_privacy_manifest(&mut manifest, &mut ignored);
        assert!(ignored.is_empty(), "{ignored:?}");
        assert_eq!(manifest, privacy());
        // An unknown key and a value of another form are left out; of an
        // array of entries, only the entries that are not whole.
        let mut manifest = privacy();
        manifest.insert("NSPrivacyAccessedAPI".into(), serde_json::json!([]));
        manifest.insert("NSPrivacyTrackingDomains".into(), serde_json::json!(true));
        manifest.insert(
            "NSPrivacyAccessedAPITypes".into(),
            serde_json::json!([
                { "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryUserDefaults",
                  "NSPrivacyAccessedAPITypeReasons": ["CA92.1"] },
                { "NSPrivacyAccessedAPIType": "x", "Reasons": ["CA92.1"] },
                { "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategorySystemBootTime" },
            ]),
        );
        let mut ignored = Vec::new();
        keep_privacy_manifest(&mut manifest, &mut ignored);
        let mut kept: Vec<&String> = manifest.keys().collect();
        kept.sort();
        assert_eq!(
            kept,
            [
                "NSPrivacyAccessedAPITypes",
                "NSPrivacyCollectedDataTypes",
                "NSPrivacyTracking"
            ]
        );
        assert_eq!(
            manifest["NSPrivacyAccessedAPITypes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        for says in [
            "unknown key `ios.privacyManifest.NSPrivacyAccessedAPI`",
            "ios.privacyManifest.NSPrivacyTrackingDomains: not in the form",
            "ios.privacyManifest.NSPrivacyAccessedAPITypes[1] has `Reasons`",
            "ios.privacyManifest.NSPrivacyAccessedAPITypes[2] lacks `NSPrivacyAccessedAPITypeReasons`",
        ] {
            assert!(
                ignored.iter().any(|i| i.starts_with(says)),
                "{says}: {ignored:?}"
            );
        }
        assert_eq!(ignored.len(), 4, "{ignored:?}");
    }

    #[test]
    fn what_app_store_connect_refuses_is_reported() {
        let refused = |json: serde_json::Value| {
            let mut manifest = json.as_object().unwrap().clone();
            let mut ignored = Vec::new();
            keep_privacy_manifest(&mut manifest, &mut ignored);
            ignored
        };
        for (json, says) in [
            (
                serde_json::json!({ "NSPrivacyTracking": true }),
                "no tracking domains",
            ),
            (
                serde_json::json!({ "NSPrivacyTracking": false, "NSPrivacyTrackingDomains": ["ads.example"] }),
                "with `NSPrivacyTracking` off",
            ),
            (
                serde_json::json!({ "NSPrivacyAccessedAPITypes": [] }),
                "is empty",
            ),
            (
                serde_json::json!({ "NSPrivacyAccessedAPITypes": [{
                    "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryUserDefaults",
                    "NSPrivacyAccessedAPITypeReasons": [],
                }] }),
                "gives no reason",
            ),
        ] {
            let ignored = refused(json);
            assert!(
                ignored.len() == 1 && ignored[0].contains(says) && ignored[0].contains("refuses"),
                "{says}: {ignored:?}"
            );
        }
        assert!(refused(serde_json::Value::Object(privacy())).is_empty());
    }

    #[test]
    fn the_privacy_manifest_is_written_into_the_app() {
        let app = std::env::temp_dir().join(format!("nsh-cli-privacy-{}.app", std::process::id()));
        let _ = std::fs::remove_dir_all(&app);
        std::fs::create_dir_all(&app).unwrap();
        write_privacy_manifest(&serde_json::Map::new(), &app).unwrap();
        assert!(!app.join("PrivacyInfo.xcprivacy").exists());
        write_privacy_manifest(&privacy(), &app).unwrap();
        let written = plist::Value::from_file(app.join("PrivacyInfo.xcprivacy")).unwrap();
        let written = written.as_dictionary().unwrap();
        assert_eq!(written["NSPrivacyTracking"], plist::Value::Boolean(false));
        let accessed = written["NSPrivacyAccessedAPITypes"].as_array().unwrap();
        assert_eq!(
            accessed[0].as_dictionary().unwrap()["NSPrivacyAccessedAPITypeReasons"],
            plist::Value::Array(vec![plist::Value::String("CA92.1".into())])
        );
        std::fs::remove_dir_all(&app).unwrap();
    }

    /// `ios.launchScreen` takes a color and an image for both appearances
    /// or one for each appearance; colors are `#rrggbb` or `#rrggbbaa`.
    #[test]
    fn launch_screens_read_one_value_or_one_per_appearance() {
        let both = config(serde_json::json!({
            "launchScreen": { "background": "#131312", "image": "launch.png" }
        }));
        assert_eq!(
            both.launch_screen,
            Some(LaunchScreen {
                background: Some(Themed::Both(Color([0x13, 0x13, 0x12, 255]))),
                image: Some(Themed::Both("launch.png".into())),
            })
        );
        let each = config(serde_json::json!({
            "launchScreen": {
                "background": { "light": "#FFFFFF", "dark": "#00000080" },
                "image": { "light": "light.png", "dark": "dark.png" }
            }
        }))
        .launch_screen
        .unwrap()
        .relative_to(Path::new("/app"));
        assert_eq!(
            each.background.unwrap().variants(),
            (&Color([255, 255, 255, 255]), Some(&Color([0, 0, 0, 0x80])))
        );
        assert_eq!(
            each.image.unwrap().variants(),
            (
                &PathBuf::from("/app/light.png"),
                Some(&PathBuf::from("/app/dark.png"))
            )
        );
        for text in [
            "131312",
            "#13131",
            "#1313121",
            "#gg1312",
            "#+f+f+f",
            "#１３１３",
        ] {
            assert!(
                Color::try_from(text.to_owned()).is_err(),
                "{text} is no color"
            );
        }
    }

    /// The launch screen is either NSH's, from `ios.launchScreen`, or the
    /// app's own `UILaunchScreen`, never both.
    #[test]
    fn a_launch_screen_and_its_info_plist_key_are_not_both_set() {
        let error = config(serde_json::json!({
            "launchScreen": { "background": "#131312" },
            "infoPlist": { "UILaunchScreen": {} }
        }))
        .check(ApplePlatform::Ios)
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("`UILaunchScreen` is set by NSH from `ios.launchScreen`"),
            "{error}"
        );
        config(serde_json::json!({ "infoPlist": { "UILaunchScreen": {} } }))
            .check(ApplePlatform::Ios)
            .unwrap();
    }

    #[test]
    fn json_values_become_property_list_values() {
        let config = config(serde_json::json!({
            "infoPlist": {
                "ITSAppUsesNonExemptEncryption": false,
                "LSApplicationCategoryType": "public.app-category.finance",
                "Count": 3,
                "Big": u64::MAX,
                "Ratio": 0.5,
                "Schemes": ["https", "mailto"],
                "NSAppTransportSecurity": {
                    "NSExceptionDomains": {
                        "example.com": { "NSIncludesSubdomains": true }
                    }
                }
            }
        }));
        let info = config.info_plist(ApplePlatform::Ios).unwrap();
        use plist::Value;
        assert_eq!(info["ITSAppUsesNonExemptEncryption"], Value::Boolean(false));
        assert_eq!(
            info["LSApplicationCategoryType"],
            Value::String("public.app-category.finance".into())
        );
        assert_eq!(info["Count"], Value::Integer(3.into()));
        assert_eq!(info["Big"], Value::Integer(u64::MAX.into()));
        assert_eq!(info["Ratio"], Value::Real(0.5));
        assert_eq!(
            info["Schemes"],
            Value::Array(vec!["https".into(), "mailto".into()])
        );
        let domains = info["NSAppTransportSecurity"]
            .as_dictionary()
            .and_then(|d| d.get("NSExceptionDomains"))
            .and_then(|d| d.as_dictionary())
            .and_then(|d| d.get("example.com"))
            .and_then(|d| d.as_dictionary())
            .unwrap();
        assert_eq!(domains["NSIncludesSubdomains"], Value::Boolean(true));
    }

    #[test]
    fn null_has_no_property_list_form() {
        let config = config(serde_json::json!({
            "infoPlist": { "Things": [1, { "Gone": null }] }
        }));
        let error = config
            .info_plist(ApplePlatform::Macos)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("macos.infoPlist.Things[1].Gone: null"),
            "{error}"
        );
    }

    #[test]
    fn nsh_keeps_its_own_keys() {
        let refused = |platform, json| config(json).check(platform).unwrap_err().to_string();
        let error = refused(
            ApplePlatform::Ios,
            serde_json::json!({ "infoPlist": { "CFBundleIdentifier": "com.other" } }),
        );
        assert!(
            error.contains("ios.infoPlist: `CFBundleIdentifier` is set by NSH from `id`"),
            "{error}"
        );
        let error = refused(
            ApplePlatform::Ios,
            serde_json::json!({ "infoPlist": { "LSRequiresIPhoneOS": false } }),
        );
        assert!(
            error.contains("`LSRequiresIPhoneOS` is set by NSH"),
            "{error}"
        );
        let error = refused(
            ApplePlatform::Macos,
            serde_json::json!({ "infoPlist": { "NSPrincipalClass": "App" } }),
        );
        assert!(
            error.contains("macos.infoPlist: `NSPrincipalClass`"),
            "{error}"
        );
        let error = refused(
            ApplePlatform::Macos,
            serde_json::json!({ "entitlements": { "application-identifier": "T.com.other" } }),
        );
        assert!(
            error.contains("macos.entitlements: `application-identifier` is set by NSH from `id`"),
            "{error}"
        );
        let error = refused(
            ApplePlatform::Macos,
            serde_json::json!({ "infoPlist": { "CFBundleURLTypes": [] } }),
        );
        assert!(
            error.contains("`CFBundleURLTypes` is set by NSH from `schemes`"),
            "{error}"
        );
        let macos = |json| serde_json::from_value::<MacosConfig>(json).unwrap();
        let error = macos(serde_json::json!({ "infoPlist": { "LSUIElement": true } }))
            .check()
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(
                "macos.infoPlist: `LSUIElement` is set by NSH from `macos.activationPolicy`; set \
                 `macos.activationPolicy` instead"
            ),
            "{error}"
        );
        // A key that is NSH's on one platform only is the app's on the other.
        assert!(
            config(serde_json::json!({ "infoPlist": { "NSPrincipalClass": "App" } }))
                .check(ApplePlatform::Ios)
                .is_ok()
        );
    }

    /// An app raises the oldest system its package runs on, never below the
    /// runtime's: anything else is an error when `nsh.json` is read.
    #[test]
    fn apps_raise_the_minimum_system_version() {
        let check = |platform: ApplePlatform, value: serde_json::Value| {
            let mut info = serde_json::Map::new();
            info.insert(platform.minimum_key().to_owned(), value);
            config(serde_json::json!({ "infoPlist": info })).check(platform)
        };
        // NSH's own, written either way, and later ones.
        let accepted = [
            (
                ApplePlatform::Ios,
                ["15", "15.0", "15.0.0", "16.4", "17.0.1"],
            ),
            (ApplePlatform::Macos, ["14", "14.0", "15", "15.2", "15.2.1"]),
        ];
        for (platform, values) in accepted {
            for value in values {
                check(platform, value.into()).unwrap();
                // Written as the app wrote it.
                let info = config(serde_json::json!({
                    "infoPlist": { platform.minimum_key(): value }
                }))
                .info_plist(platform)
                .unwrap();
                assert_eq!(
                    info[platform.minimum_key()],
                    plist::Value::String(value.into())
                );
            }
        }
        let below = [
            (ApplePlatform::Ios, ["14.0", "14.9.9", "13", "8"]),
            (ApplePlatform::Macos, ["13.0", "13.9.9", "13", "10.15"]),
        ];
        for (platform, values) in below {
            for value in values {
                let error = check(platform, value.into()).unwrap_err().to_string();
                assert!(
                    error.contains(&format!(
                        "{}.infoPlist.{}: {value:?} is below NSH's minimum",
                        platform.key(),
                        platform.minimum_key()
                    )),
                    "{error}"
                );
                // The error says what to write instead.
                assert!(
                    error.contains(&format!(
                        "write the {} version the app needs as a string of numbers and dots, \
                         from NSH's minimum, \"{}\", up",
                        platform.os(),
                        platform.minimum()
                    )),
                    "{error}"
                );
            }
        }
        for platform in [ApplePlatform::Ios, ApplePlatform::Macos] {
            for malformed in [
                "abc", "15.x", "", "15.", ".15", "15..2", "15.2.1.4", " 15.2", "+15", "v15", "１５",
            ] {
                let error = check(platform, malformed.into()).unwrap_err().to_string();
                assert!(
                    error.contains(&format!("{malformed:?} is no version")),
                    "{error}"
                );
            }
            for other in [
                serde_json::json!(15),
                serde_json::json!(15.2),
                serde_json::json!(true),
                serde_json::json!(null),
                serde_json::json!(["15.2"]),
                serde_json::json!({ "version": "15.2" }),
            ] {
                let error = check(platform, other.clone()).unwrap_err().to_string();
                assert!(error.contains(&format!("{other} is no string")), "{error}");
            }
        }
        // `macos`'s own section reads it as `ios`'s does.
        let macos = |json| serde_json::from_value::<MacosConfig>(json).unwrap();
        assert!(
            macos(serde_json::json!({ "infoPlist": { "LSMinimumSystemVersion": "15.2" } }))
                .check()
                .is_ok()
        );
        let error = macos(serde_json::json!({ "infoPlist": { "LSMinimumSystemVersion": "13.0" } }))
            .check()
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("macos.infoPlist.LSMinimumSystemVersion: \"13.0\" is below"),
            "{error}"
        );
        // The other platform's key is the app's own, as it writes it.
        assert!(
            config(serde_json::json!({ "infoPlist": { "LSMinimumSystemVersion": "11.0" } }))
                .check(ApplePlatform::Ios)
                .is_ok()
        );
        assert!(
            macos(serde_json::json!({ "infoPlist": { "MinimumOSVersion": "11.0" } }))
                .check()
                .is_ok()
        );
    }

    /// Builds for an Apple system compile for the oldest one the package
    /// declares: the app's own minimum when it raises the runtime's.
    #[test]
    fn builds_target_the_minimum_their_package_declares() {
        let minimums = AppleMinimums::of(&serde_json::json!({ "name": "App" })).unwrap();
        assert_eq!(minimums, AppleMinimums::default());
        for triple in [
            "aarch64-apple-ios",
            "aarch64-apple-ios-sim",
            "aarch64-apple-ios-macabi",
        ] {
            assert_eq!(
                minimums.deployment_target(Some(triple)),
                Some(("IPHONEOS_DEPLOYMENT_TARGET", IOS_MINIMUM))
            );
        }
        for triple in ["aarch64-apple-darwin", "x86_64-apple-darwin"] {
            assert_eq!(
                minimums.deployment_target(Some(triple)),
                Some(("MACOSX_DEPLOYMENT_TARGET", MACOS_MINIMUM))
            );
        }
        for triple in [
            "wasm32-unknown-unknown",
            "aarch64-linux-android",
            "x86_64-pc-windows-msvc",
        ] {
            assert_eq!(minimums.deployment_target(Some(triple)), None);
        }
        assert_eq!(
            minimums.deployment_target(None).is_some(),
            cfg!(target_os = "macos")
        );

        let raised = AppleMinimums::of(&serde_json::json!({
            "ios": { "infoPlist": { "MinimumOSVersion": "16.4" } },
            "macos": { "infoPlist": { "LSMinimumSystemVersion": "15.2" } }
        }))
        .unwrap();
        assert_eq!(
            raised.deployment_target(Some("aarch64-apple-ios")),
            Some(("IPHONEOS_DEPLOYMENT_TARGET", "16.4"))
        );
        assert_eq!(
            raised.deployment_target(Some("aarch64-apple-darwin")),
            Some(("MACOSX_DEPLOYMENT_TARGET", "15.2"))
        );

        let error = AppleMinimums::of(&serde_json::json!({
            "ios": { "infoPlist": { "MinimumOSVersion": "13.0" } }
        }))
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("ios.infoPlist.MinimumOSVersion: \"13.0\" is below"),
            "{error}"
        );
    }

    /// Versions compare number by number, the numbers left out 0.
    #[test]
    fn versions_compare_by_their_numbers() {
        assert_eq!(version("15.2.1"), Some([15, 2, 1]));
        assert_eq!(version("14"), version("14.0"));
        assert_eq!(version("14.0"), version("14.0.0"));
        assert!(version("15.10") > version("15.9"));
        assert!(version("15") > version("14.9.9"));
        assert!(version(IOS_MINIMUM).is_some());
        assert!(version(MACOS_MINIMUM).is_some());
        assert_eq!(version("4294967296"), None);
    }

    /// Languages are named as `.lproj` directories are: a language, then a
    /// script or a region or both, cased as the system names them.
    #[test]
    fn languages_are_lproj_names() {
        for code in [
            "en",
            "ja",
            "fil",
            "zh-Hans",
            "zh-Hant",
            "pt-BR",
            "zh-TW",
            "es-419",
            "zh-Hant-HK",
            "sr-Latn-RS",
        ] {
            assert_eq!(check_language(code), Ok(()), "{code}");
        }
        for code in [
            "",
            "e",
            "english",
            "English",
            "EN",
            "zh-hans",
            "zh-CN-Hans",
            "pt-br",
            "en-",
            "-en",
            "en US",
            "Base",
            "zh-Hans-Hant",
            "en-US-US",
            "zh.Hans",
            "../en",
            "en-1234",
            "zh_TW",
            "zh_Hant",
            "sr_Latn_RS",
        ] {
            let error = check_language(code).unwrap_err();
            assert!(error.contains("is no language code"), "{code}: {error}");
        }
    }

    /// `ios.infoPlistStrings` takes, by language, the text of keys apps
    /// translate: errors name the `nsh.json` key.
    #[test]
    fn info_plist_strings_are_checked_when_read() {
        let strings = config(serde_json::json!({
            "infoPlistStrings": {
                "zh-Hans": { "NSCameraUsageDescription": "拍照", "CFBundleDisplayName": "应用" },
                "ja": {}
            }
        }))
        .info_plist_strings(ApplePlatform::Ios)
        .unwrap();
        assert_eq!(strings["zh-Hans"]["NSCameraUsageDescription"], "拍照");
        assert!(strings["ja"].is_empty());
        let error = |json: serde_json::Value| {
            config(serde_json::json!({ "infoPlistStrings": json }))
                .check(ApplePlatform::Ios)
                .unwrap_err()
                .to_string()
        };
        let wrong = error(serde_json::json!({ "zh-hans": {} }));
        assert!(
            wrong.contains("nsh.json ios.infoPlistStrings: \"zh-hans\" is no language code"),
            "{wrong}"
        );
        let wrong = error(serde_json::json!({ "ja": "カメラ" }));
        assert!(
            wrong.contains("nsh.json ios.infoPlistStrings.ja: \"カメラ\" is no object"),
            "{wrong}"
        );
        let wrong = error(serde_json::json!({ "ja": { "UIBackgroundModes": ["audio"] } }));
        assert!(
            wrong.contains(
                "nsh.json ios.infoPlistStrings.ja.UIBackgroundModes: [\"audio\"] is no string"
            ),
            "{wrong}"
        );
        let wrong = error(serde_json::json!({ "ja": { "CFBundleIdentifier": "x" } }));
        assert!(
            wrong.contains("nsh.json ios.infoPlistStrings.ja: `CFBundleIdentifier` is set by NSH"),
            "{wrong}"
        );
        let macos: MacosConfig = serde_json::from_value(serde_json::json!({
            "infoPlistStrings": { "de": { "NSPrincipalClass": "x" } }
        }))
        .unwrap();
        let wrong = macos.check().unwrap_err().to_string();
        assert!(
            wrong.contains("nsh.json macos.infoPlistStrings.de: `NSPrincipalClass` is set by NSH"),
            "{wrong}"
        );
    }

    /// A strings file quotes keys and texts, escaping quotes, backslashes
    /// and control characters, and keeps every other character as it is.
    #[test]
    fn strings_files_escape_what_old_style_property_lists_do() {
        let texts = BTreeMap::from([
            (
                "NSCameraUsageDescription".to_owned(),
                "扫描 \"二维码\"\n路径 C:\\photos\tend\r\u{1}".to_owned(),
            ),
            ("CFBundleDisplayName".to_owned(), "アプリ".to_owned()),
        ]);
        assert_eq!(
            strings_file(&texts),
            "\"CFBundleDisplayName\" = \"アプリ\";\n\
             \"NSCameraUsageDescription\" = \"扫描 \\\"二维码\\\"\\n路径 C:\\\\photos\\tend\\r\\U0001\";\n"
        );
        assert_eq!(strings_file(&BTreeMap::new()), "");
    }

    /// A package translates only what its `Info.plist` has as a string:
    /// the users of the other languages see that value.
    #[test]
    fn translated_keys_need_an_info_plist_string() {
        let config = config(serde_json::json!({
            "infoPlistStrings": {
                "zh-Hans": { "NSCameraUsageDescription": "用相机拍照。" },
                "fr": {}
            }
        }));
        let mut info = plist::Dictionary::new();
        info.insert(
            "NSCameraUsageDescription".into(),
            "The app takes photos.".into(),
        );
        let files = config.localized_info(ApplePlatform::Ios, &info).unwrap();
        assert_eq!(
            files,
            BTreeMap::from([(
                "zh-Hans".to_owned(),
                "\"NSCameraUsageDescription\" = \"用相机拍照。\";\n".to_owned()
            )])
        );
        let missing = config
            .localized_info(ApplePlatform::Ios, &plist::Dictionary::new())
            .unwrap_err()
            .to_string();
        assert!(
            missing.contains(
                "nsh.json ios.infoPlistStrings.zh-Hans.NSCameraUsageDescription: the app's \
                 Info.plist has no `NSCameraUsageDescription`; set its text in `ios.infoPlist`"
            ),
            "{missing}"
        );
        info.insert("NSCameraUsageDescription".into(), true.into());
        let other = config
            .localized_info(ApplePlatform::Ios, &info)
            .unwrap_err()
            .to_string();
        assert!(
            other.contains("value of `NSCameraUsageDescription` is no string"),
            "{other}"
        );
    }

    /// Writing the strings again changes nothing; a language no longer
    /// given loses its file, and its directory unless something else is in it.
    #[test]
    fn localized_info_is_written_per_language() {
        let dir = std::env::temp_dir().join(format!("nsh-lproj-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let files = BTreeMap::from([
            ("ja".to_owned(), "\"A\" = \"あ\";\n".to_owned()),
            ("zh-Hans".to_owned(), "\"A\" = \"甲\";\n".to_owned()),
        ]);
        assert!(write_localized_info(&dir, &files).unwrap());
        assert_eq!(
            std::fs::read_to_string(dir.join("zh-Hans.lproj/InfoPlist.strings")).unwrap(),
            "\"A\" = \"甲\";\n"
        );
        assert!(!write_localized_info(&dir, &files).unwrap());
        std::fs::write(dir.join("ja.lproj/Other.strings"), "").unwrap();
        let fewer = BTreeMap::from([("zh-Hans".to_owned(), files["zh-Hans"].clone())]);
        assert!(write_localized_info(&dir, &fewer).unwrap());
        assert!(!dir.join("ja.lproj/InfoPlist.strings").exists());
        assert!(dir.join("ja.lproj/Other.strings").exists());
        assert!(write_localized_info(&dir, &BTreeMap::new()).unwrap());
        assert!(!dir.join("zh-Hans.lproj").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// `macos.activationPolicy`: `regular` unless the app says
    /// `accessory`, which the development host and `app.json` are told.
    #[test]
    fn macos_apps_choose_their_activation_policy() {
        let macos = |json| serde_json::from_value::<MacosConfig>(json);
        let regular = macos(serde_json::json!({})).unwrap();
        assert_eq!(regular.activation_policy, ActivationPolicy::Regular);
        assert!(regular.host_args().is_empty());
        let mut info = serde_json::json!({ "id": "com.a" });
        regular.add_to_app_json(&mut info);
        assert_eq!(info, serde_json::json!({ "id": "com.a" }));
        let accessory = macos(serde_json::json!({ "activationPolicy": "accessory" })).unwrap();
        assert_eq!(accessory.activation_policy, ActivationPolicy::Accessory);
        assert_eq!(accessory.host_args(), ["--activation-policy", "accessory"]);
        accessory.add_to_app_json(&mut info);
        assert_eq!(
            info,
            serde_json::json!({ "id": "com.a", "activationPolicy": "accessory" })
        );
        assert_eq!(
            macos(serde_json::json!({ "activationPolicy": "regular" }))
                .unwrap()
                .activation_policy,
            ActivationPolicy::Regular
        );
        // `nsh.json`'s reader leaves another value out with a warning, an
        // object (the form serde's own enums also take) too.
        for value in [
            serde_json::json!("dock"),
            serde_json::json!("Accessory"),
            serde_json::json!(true),
            serde_json::json!({ "accessory": null }),
        ] {
            assert!(macos(serde_json::json!({ "activationPolicy": value })).is_err());
        }
    }

    fn dictionary(json: serde_json::Value) -> plist::Dictionary {
        config(serde_json::json!({ "entitlements": json }))
            .entitlements(ApplePlatform::Ios)
            .unwrap()
    }

    #[test]
    fn a_profile_grants_what_it_covers() {
        let profile = || {
            to_plist(
                &serde_json::json!({
                "application-identifier": "TEAM.com.acme.app",
                "get-task-allow": false,
                "aps-environment": "production",
                "keychain-access-groups": ["TEAM.*"],
                "com.apple.developer.associated-domains": "*",
                "com.apple.security.application-groups": ["group.com.acme.a", "group.com.acme.b"]
            }),
                "profile",
            )
            .unwrap()
            .into_dictionary()
            .unwrap()
        };
        let mut granted = profile();
        grant(
            &mut granted,
            dictionary(serde_json::json!({
                "com.apple.developer.associated-domains": ["applinks:acme.com", "webcredentials:acme.com"],
                "keychain-access-groups": ["TEAM.com.acme.shared"],
                "com.apple.security.application-groups": ["group.com.acme.b"],
                "aps-environment": "production"
            })),
            "ios.entitlements",
        )
        .unwrap();
        // The app's values replace the profile's; the rest stays.
        assert_eq!(
            granted["com.apple.developer.associated-domains"],
            plist::Value::Array(vec![
                "applinks:acme.com".into(),
                "webcredentials:acme.com".into()
            ])
        );
        assert_eq!(
            granted["com.apple.security.application-groups"],
            plist::Value::Array(vec!["group.com.acme.b".into()])
        );
        assert_eq!(
            granted["application-identifier"],
            plist::Value::String("TEAM.com.acme.app".into())
        );

        let refused = |json| {
            grant(&mut profile(), dictionary(json), "ios.entitlements")
                .unwrap_err()
                .to_string()
        };
        let error = refused(serde_json::json!({ "com.apple.developer.healthkit": true }));
        assert!(
            error.contains("does not grant the entitlement `com.apple.developer.healthkit`"),
            "{error}"
        );
        let error = refused(serde_json::json!({ "aps-environment": "development" }));
        assert!(
            error.contains(
                "grants `aps-environment` as \"production\", which does not cover \"development\""
            ),
            "{error}"
        );
        let error = refused(serde_json::json!({ "keychain-access-groups": ["OTHER.shared"] }));
        assert!(error.contains("`keychain-access-groups`"), "{error}");
        let error = refused(serde_json::json!({
            "com.apple.security.application-groups": ["group.com.acme.c"]
        }));
        assert!(error.contains("[\"group.com.acme.c\"]"), "{error}");
        let error = refused(serde_json::json!({ "get-task-allow": true }));
        assert!(error.contains("`get-task-allow` as false"), "{error}");
    }

    #[test]
    fn patterns_and_flags() {
        use plist::Value;
        assert!(covers(&"*".into(), &"anything".into()));
        assert!(covers(&"TEAM.*".into(), &"TEAM.x".into()));
        assert!(!covers(&"TEAM.*".into(), &"OTHER.x".into()));
        assert!(covers(&Value::Boolean(true), &Value::Boolean(false)));
        assert!(!covers(&Value::Boolean(false), &Value::Boolean(true)));
        assert!(!covers(&Value::Integer(1.into()), &"1".into()));
        assert!(needs_profile("com.apple.developer.associated-domains"));
        assert!(!needs_profile("com.apple.security.app-sandbox"));
    }
}
