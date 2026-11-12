//! `nsh.json` `"ios"` and `"macos"`: the `Info.plist` keys and the
//! entitlements an app adds to what `nsh package` writes for it, and how a
//! macOS app takes part in the system's UI (`macos.activationPolicy`).
//!
//! Values are JSON, written as property list values (strings, numbers,
//! booleans, arrays, dictionaries). The keys NSH sets from other `nsh.json`
//! keys or that the runtime depends on are NSH's ([`ApplePlatform::reserved`]):
//! an app setting one is an error that names what to set instead. Every other
//! key the app sets replaces NSH's default, if it has one. The oldest system
//! the app runs on (`MinimumOSVersion`, `LSMinimumSystemVersion`) is such a
//! default, which an app raises for the APIs of a later system but never
//! lowers below the runtime's own ([`IOS_MINIMUM`], [`MACOS_MINIMUM`]).

use anyhow::bail;
use serde::Deserialize;

/// The oldest iOS the runtime runs on: the deployment target it is built
/// for (`.cargo/config.toml`'s `IPHONEOS_DEPLOYMENT_TARGET`, `cargo xtask
/// dist`). Packages declare it (`MinimumOSVersion`, and `actool`'s
/// deployment target) unless the app raises it.
pub(crate) const IOS_MINIMUM: &str = "15.0";

/// The oldest macOS the AppKit runtime runs on (its display links are
/// `NSView`'s, new in macOS 14). Packages declare it
/// (`LSMinimumSystemVersion`) unless the app raises it.
pub(crate) const MACOS_MINIMUM: &str = "14.0";

/// `nsh.json` `"ios"` (and the keys [`MacosConfig`] shares with it).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppleConfig {
    /// Keys added to the app's `Info.plist`.
    #[serde(default)]
    pub(crate) info_plist: serde_json::Map<String, serde_json::Value>,
    /// Entitlements the app is signed with. iOS device builds check them
    /// against the provisioning profile.
    #[serde(default)]
    pub(crate) entitlements: serde_json::Map<String, serde_json::Value>,
}

/// `nsh.json` `"macos"`: [`AppleConfig`]'s keys, and the app's activation
/// policy, which iOS has no counterpart of.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MacosConfig {
    /// Keys added to the app's `Info.plist`.
    #[serde(default)]
    pub(crate) info_plist: serde_json::Map<String, serde_json::Value>,
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
    fn key(self) -> &'static str {
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
        self.entitlements(platform)?;
        Ok(())
    }
}

impl MacosConfig {
    /// The app's `Info.plist` keys as property list values.
    pub(crate) fn info_plist(&self) -> anyhow::Result<plist::Dictionary> {
        info_plist(&self.info_plist, ApplePlatform::Macos)
    }

    /// The app's entitlements as property list values.
    pub(crate) fn entitlements(&self) -> anyhow::Result<plist::Dictionary> {
        entitlements(&self.entitlements, ApplePlatform::Macos)
    }

    /// Checks both when `nsh.json` is read, so a mistake shows before a
    /// build.
    pub(crate) fn check(&self) -> anyhow::Result<()> {
        self.info_plist()?;
        self.entitlements()?;
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

/// Adds the app's entitlements (`requested`, from `nsh.json`
/// `ios.entitlements`) to those a provisioning profile grants (`granted`),
/// checking that the profile covers each one. The app's value replaces the
/// profile's: a profile grants `com.apple.developer.associated-domains` as
/// `*`, the app names its domains.
pub(crate) fn grant(
    granted: &mut plist::Dictionary,
    requested: plist::Dictionary,
) -> anyhow::Result<()> {
    for (key, value) in requested {
        let Some(allowed) = granted.get(&key) else {
            bail!(
                "the provisioning profile does not grant the entitlement `{key}` (nsh.json ios.entitlements): \
                 enable its capability for the app's identifier and download the profile again"
            );
        };
        if !covers(allowed, &value) {
            bail!(
                "the provisioning profile grants `{key}` as {}, which does not cover {} (nsh.json ios.entitlements)",
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
            grant(&mut profile(), dictionary(json))
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
