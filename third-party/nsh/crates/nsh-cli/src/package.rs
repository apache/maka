//! `nsh package`: builds an installable app from the prebuilt runtime, the
//! app bundle and its assets. Needs no Rust; iOS packaging uses Xcode's
//! command line tools (`codesign`, and `actool` for icons), macOS packaging
//! `codesign` and `sips`, Linux packaging `tar`; Windows packaging needs
//! nothing (`windows.rs`), nor does the web's (`web.rs`). Each desktop OS
//! packages with its native backend's runner; GPUI is the backend for
//! embedding in GPUI apps and has no package of its own.

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use anyhow::{Context as _, bail};
use serde::Deserialize;

use crate::{
    apple::{
        ActivationPolicy, AppleConfig, ApplePlatform, IOS_MINIMUM, MACOS_MINIMUM, MacosConfig,
    },
    runtime::{self, Platform},
    ui,
};

/// Where the app runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub(crate) enum PackageTarget {
    /// iOS devices: a signed `.ipa` (or an unsigned `.app` without `--sign`).
    Ios,
    /// The iOS simulator: an ad hoc signed `.app`.
    IosSimulator,
    /// Android: a signed `.apk`.
    Android,
    /// Linux (GTK): a directory with the runner, the bundle and a `.desktop`
    /// file, and the same as a `.tar.gz`.
    Linux,
    /// macOS (AppKit): an ad hoc signed `.app`.
    Macos,
    /// Windows: a directory with the runner as `<name>.exe` (the app's
    /// icon embedded) and the bundle, and the same as a `.zip`.
    Windows,
    /// The web: a static site (`index.html` and files named by their
    /// content) for any web server or CDN.
    Web,
    /// Packages made with the GPUI runner, which is gone: GPUI is the
    /// backend for embedding in GPUI apps. Refused with the OS's own target
    /// to use instead ([`PackageTarget::desktop`]).
    #[value(hide = true)]
    Gpui,
}

impl PackageTarget {
    /// This machine's desktop target (`None` off macOS, Windows and
    /// Linux): where `--target gpui` points.
    fn desktop() -> Option<PackageTarget> {
        if cfg!(target_os = "macos") {
            Some(PackageTarget::Macos)
        } else if cfg!(windows) {
            Some(PackageTarget::Windows)
        } else if cfg!(target_os = "linux") {
            Some(PackageTarget::Linux)
        } else {
            None
        }
    }
}

/// The processors a macOS package runs on (`--arch`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub(crate) enum Arch {
    /// Apple silicon.
    #[value(name = "arm64", alias = "aarch64")]
    Arm64,
    /// Intel.
    #[value(name = "x86_64")]
    X86_64,
    /// Apple silicon and Intel: one universal executable of both builds.
    Universal,
}

/// The Rust target of macOS on Apple silicon.
const MACOS_ARM64: &str = "aarch64-apple-darwin";
/// The Rust target of macOS on Intel.
const MACOS_X86_64: &str = "x86_64-apple-darwin";

impl Arch {
    /// The Rust targets of its builds, one per architecture.
    fn macos_triples(self) -> &'static [&'static str] {
        match self {
            Arch::Arm64 => &[MACOS_ARM64],
            Arch::X86_64 => &[MACOS_X86_64],
            Arch::Universal => &[MACOS_ARM64, MACOS_X86_64],
        }
    }
}

/// The Rust target of macOS on this machine's processor.
fn host_macos_triple() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        MACOS_ARM64
    } else {
        MACOS_X86_64
    }
}

/// What cargo builds the runner for `triple` with: nothing for this
/// machine's processor, so the build is the one `nsh run` and every other
/// package share (`target/release`), else `--target triple`
/// (`target/<triple>/release`).
fn macos_build_triple(triple: &'static str) -> Option<&'static str> {
    (triple != host_macos_triple()).then_some(triple)
}

/// The architecture of a macOS `triple` as `lipo` names it.
fn lipo_arch(triple: &str) -> &str {
    match triple.split('-').next() {
        Some("aarch64") => "arm64",
        Some(arch) => arch,
        None => triple,
    }
}

/// The updater's names of the platforms a macOS package for `arch` runs on
/// (`None`: this machine's), which its update archives are named after: a
/// universal package is the archive of either.
fn macos_update_platforms(arch: Option<Arch>) -> Vec<String> {
    match arch {
        None => vec![nsh_updater::platform()],
        Some(arch) => arch
            .macos_triples()
            .iter()
            .map(|triple| format!("macos-{}", triple.split('-').next().unwrap_or(triple)))
            .collect(),
    }
}

/// App metadata: `nsh.json` next to the entry, overridden by flags.
///
/// Keys it does not know, here or in its sections, are warned of and
/// ignored ([`read_config`]), never refused: an app written for a newer
/// NSH still builds with this one, and one for an older NSH keeps building
/// after a key it set is retired.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppConfig {
    /// Display name.
    pub(crate) name: Option<String>,
    /// Bundle identifier (`com.example.app`).
    pub(crate) id: Option<String>,
    /// User-visible version (`1.2.0`).
    pub(crate) version: Option<String>,
    /// Build number.
    pub(crate) build: Option<u32>,
    /// App icon: a square PNG, ideally 1024×1024, relative to `nsh.json`;
    /// one for every target or one per platform ([`AppIcon`]).
    pub(crate) icon: Option<AppIcon>,
    /// The lowest runtime that runs a signed package (`nsh publish`).
    pub(crate) min_runtime: Option<String>,
    /// Read and checked by the bundler.
    #[serde(default, rename = "tailwind")]
    _tailwind: Option<serde_json::Value>,
    /// Read and checked by the bundler; packages read only what the
    /// system must be told ahead (`speech`'s usage descriptions).
    #[serde(default)]
    pub(crate) capabilities: Option<serde_json::Value>,
    /// `"light"` / `"dark"` / `"system"`: the app's appearance (checked by
    /// the bundler, which hands it to the runtime); packages also start in
    /// it (the launch screen, the window's theme).
    pub(crate) appearance: Option<String>,
    /// `"statusBar"`: the status bar's default (checked by the bundler,
    /// which hands it to the runtime); iOS packages also show it from the
    /// launch screen on (Info.plist).
    pub(crate) status_bar: Option<serde_json::Value>,
    /// Read and checked by the bundler.
    #[serde(default, rename = "theme")]
    _theme: Option<serde_json::Value>,
    /// The languages whose data the app ships (checked by the bundler).
    #[serde(default)]
    locales: Option<serde_json::Value>,
    /// The locales the app ships (`locales`, else its translations'
    /// languages: `nsh_i18n::app_locales`), which Apple packages declare
    /// (`CFBundleLocalizations`) so that system UI shows in them.
    #[serde(skip)]
    pub(crate) localizations: Vec<String>,
    /// Read and checked by the bundler.
    #[serde(default, rename = "resolve")]
    _resolve: Option<serde_json::Value>,
    /// The app's Rust crate: its builds are the app's own (`rust_app.rs`).
    #[serde(default, rename = "rust")]
    _rust: Option<serde_json::Value>,
    /// A Rust app's root component in its crate (`rust_app::RootConfig`).
    #[serde(default, rename = "root")]
    _root: Option<serde_json::Value>,
    /// What the web's packages add to the page (`web.rs`).
    #[serde(default)]
    pub(crate) web: WebConfig,
    /// Where the app finds its updates (`update.rs`).
    pub(crate) updater: Option<crate::updater::UpdaterConfig>,
    /// Terminal layout options.
    #[serde(default)]
    pub(crate) tui: TuiConfig,
    /// URL schemes that open the app (`"myapp"`: `myapp://...`), which
    /// packages register with the system; the app hears them through
    /// `UrlScheme.on("open", ...)`. [`read_config`] checks them and lowers
    /// their case ([`AppConfig::url_schemes`]).
    #[serde(default)]
    pub(crate) schemes: Vec<String>,
    /// The app runs once (`"singleInstance": true`, Windows and Linux): a
    /// second launch hands its arguments and working directory to the
    /// running instance (`Application.on("secondInstance", ...)`) and exits
    /// before it opens a window. Written into `app.json`, where the
    /// release runner reads it; macOS runs one instance of an app already.
    #[serde(default)]
    pub(crate) single_instance: bool,
    /// The file types the app opens (`"fileTypes"`: `[{ "name": "Video",
    /// "extensions": ["mp4"] }]`), which packages declare to the system;
    /// the app hears the files through `Application.on("openFiles", ...)`
    /// (`nsh_core::file_type`). [`read_config`]
    /// checks them ([`AppConfig::file_types`]).
    #[serde(default)]
    pub(crate) file_types: Option<serde_json::Value>,
    /// The main window's launch-time options (`"window"`, checked by
    /// [`read_config`]): written into `app.json` and the dev server's app
    /// info, where the runners read them before the app's code runs.
    pub(crate) window: Option<serde_json::Value>,
    /// What iOS packages add to their `Info.plist` and entitlements.
    #[serde(default)]
    pub(crate) ios: AppleConfig,
    /// What macOS packages add to their `Info.plist` and entitlements, and
    /// how the app takes part in the system's UI.
    #[serde(default)]
    pub(crate) macos: MacosConfig,
    /// What Android packages set in their manifest.
    #[serde(default)]
    pub(crate) android: AndroidConfig,
}

/// `nsh.json` `"android"`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AndroidConfig {
    /// The API level the app targets (`targetSdkVersion`; default
    /// [`android::DEFAULT_TARGET_SDK`]), which it also compiles against:
    /// the SDK must have its platform.
    ///
    /// [`android::DEFAULT_TARGET_SDK`]: crate::android::DEFAULT_TARGET_SDK
    pub(crate) target_sdk: Option<u32>,
    /// The app may make plain HTTP requests
    /// (`android:usesCleartextTraffic`): servers on a local network without
    /// TLS. Off by default, as Android has it from API 28 on.
    #[serde(default)]
    pub(crate) uses_cleartext_traffic: bool,
}

impl AndroidConfig {
    /// `targetSdk`, checked: no lower than the runtime's minimum.
    pub(crate) fn target_sdk(&self) -> anyhow::Result<u32> {
        use crate::android::{DEFAULT_TARGET_SDK, MIN_SDK};
        let level = self.target_sdk.unwrap_or(DEFAULT_TARGET_SDK);
        if level < MIN_SDK {
            bail!(
                "nsh.json android.targetSdk {level} is below the minimum, {MIN_SDK} (Android 8.0)"
            );
        }
        Ok(level)
    }
}

/// `nsh.json` `"tui"`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TuiConfig {
    /// Width and height of one Cell in points (`8x16` by default).
    pub(crate) points_per_cell: Option<String>,
}

impl AppConfig {
    /// Whether the app may recognize speech: it declares no capabilities
    /// (it gets them all) or grants `speech`.
    fn speech(&self) -> bool {
        match &self.capabilities {
            None => true,
            Some(capabilities) => {
                capabilities.get("speech") == Some(&serde_json::Value::Bool(true))
            }
        }
    }

    /// Whether the app may show notifications: it declares no capabilities
    /// (it gets them all) or grants `notifications`.
    pub(crate) fn notifications(&self) -> bool {
        match &self.capabilities {
            None => true,
            Some(capabilities) => {
                capabilities.get("notifications") == Some(&serde_json::Value::Bool(true))
            }
        }
    }

    /// The URL schemes the app claims (`"schemes": [...]`), checked, in
    /// lower case; those it cannot claim are left out ([`read_config`]
    /// warns of them).
    pub(crate) fn url_schemes(&self) -> Vec<String> {
        nsh_core::url_scheme::schemes_from_json(&serde_json::json!(self.schemes))
    }

    /// The file types the app opens (`"fileTypes"`), checked; those it
    /// cannot take are left out ([`read_config`] warns of them).
    pub(crate) fn file_types(&self) -> Vec<nsh_core::file_type::FileType> {
        self.file_types
            .as_ref()
            .map(nsh_core::file_type::file_types_from_json)
            .unwrap_or_default()
    }

    /// Adds the file types to a package's `app.json` `info`, where the
    /// runner reads them (the core then lets the files' `file:` URLs
    /// through).
    pub(crate) fn add_file_types_to_app_json(&self, info: &mut serde_json::Value) {
        if let Some(types) = self.file_types_json() {
            info["fileTypes"] = types;
        }
    }

    /// The checked file types as JSON, for `app.json`; `None` without any.
    pub(crate) fn file_types_json(&self) -> Option<serde_json::Value> {
        let types = self.file_types();
        (!types.is_empty()).then(|| types.iter().map(|t| t.to_json()).collect())
    }

    /// What `capabilities.webview.media` lets web pages capture
    /// (`"microphone"`, `"camera"`): never granted without a declaration.
    pub(crate) fn web_media(&self, kind: &str) -> bool {
        self.capabilities
            .as_ref()
            .and_then(|c| c.pointer("/webview/media"))
            .and_then(|m| m.as_array())
            .is_some_and(|m| m.iter().any(|k| k.as_str() == Some(kind)))
    }

    /// Adds what the system shows when the app first asks for the
    /// microphone, the camera and speech recognition, which it requires
    /// (it ends an app that asks without them): for speech recognition and
    /// web pages' media capture (`webview.media`). The app's `infoPlist`
    /// may word them its own way.
    fn usage_descriptions(&self, info: &mut plist::Dictionary) {
        if self.speech() {
            for (key, text) in USAGE_DESCRIPTIONS {
                info.insert(key.into(), plist::Value::String(text.to_owned()));
            }
        }
        for (kind, key, text) in WEB_MEDIA_USAGE_DESCRIPTIONS {
            if self.web_media(kind) && !info.contains_key(key) {
                info.insert(key.into(), plist::Value::String(text.to_owned()));
            }
        }
    }

    /// The macOS entitlements web pages' media capture needs under the
    /// hardened runtime and the sandbox (`webview.media`).
    fn web_media_entitlements(&self, entitlements: &mut plist::Dictionary) {
        for (kind, key) in [
            ("microphone", "com.apple.security.device.audio-input"),
            ("camera", "com.apple.security.device.camera"),
        ] {
            if self.web_media(kind) && !entitlements.contains_key(key) {
                entitlements.insert(key.into(), true.into());
            }
        }
    }
}

/// The usage descriptions of an app that recognizes speech (`Speech`).
pub(crate) const USAGE_DESCRIPTIONS: [(&str, &str); 2] = [
    (
        "NSMicrophoneUsageDescription",
        "The app listens to the microphone while you dictate.",
    ),
    (
        "NSSpeechRecognitionUsageDescription",
        "The app turns what you say into text.",
    ),
];

/// The usage descriptions of an app whose web pages capture media
/// (`webview.media`), by kind.
pub(crate) const WEB_MEDIA_USAGE_DESCRIPTIONS: [(&str, &str, &str); 2] = [
    (
        "microphone",
        "NSMicrophoneUsageDescription",
        "The app's web pages use the microphone.",
    ),
    (
        "camera",
        "NSCameraUsageDescription",
        "The app's web pages use the camera.",
    ),
];

/// The `app.json` of a package: `info` (the app's id, ...) with the
/// schemes it claims, which its runner hands the core so the links of
/// others are dropped (`nsh_engine::Bundle::url_schemes`).
pub(crate) fn app_json(
    mut info: serde_json::Value,
    schemes: &[String],
    window: Option<&serde_json::Value>,
) -> String {
    if !schemes.is_empty() {
        info["schemes"] = serde_json::json!(schemes);
    }
    if let Some(window) = window {
        info["window"] = window.clone();
    }
    info.to_string()
}

/// The `app.json` of a desktop package (Linux, Windows), which its runner
/// reads before the app runs: the app's name (the window's title), id and
/// version, the appearance its window opens in, and `nsh.json` `"window"`,
/// the main window's options (`Bundle::read_trusted`).
pub(crate) fn desktop_app_json(
    config: &AppConfig,
    name: &str,
    id: &str,
    version: &str,
) -> serde_json::Value {
    let mut info = serde_json::json!({ "name": name, "id": id, "version": version });
    if let Some(appearance) = &config.appearance {
        info["appearance"] = appearance.as_str().into();
    }
    if let Some(window) = &config.window {
        info["window"] = window.clone();
    }
    if config.single_instance {
        info["singleInstance"] = true.into();
    }
    config.add_file_types_to_app_json(&mut info);
    info
}

/// `nsh.json` `"window"` of the app at `entry` (checked), as JSON: the
/// dev server's app info carries it.
pub(crate) fn window_json(entry: &Path) -> Option<String> {
    let entry = dunce::canonicalize(entry).ok()?;
    read_config(&entry).ok()?.window.map(|w| w.to_string())
}

/// Says, once per app, that the main window of the app at `entry` starts
/// hidden (`nsh.json` `window.defaultVisible: false`): the desktop hosts of
/// `nsh run` and `nsh test --target` open it so, as its package does, and
/// only the app shows it.
pub(crate) fn note_hidden_main_window(entry: &Path) {
    static NOTED: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());
    let Ok(entry) = dunce::canonicalize(entry) else {
        return;
    };
    let hidden = read_config(&entry)
        .ok()
        .and_then(|config| config.window)
        .and_then(|window| nsh_core::desktop::MainWindowOptions::from_json(&window).ok())
        .is_some_and(|window| !window.visible_at_launch());
    let mut noted = NOTED.lock().unwrap_or_else(|e| e.into_inner());
    if hidden && !noted.contains(&entry) {
        noted.push(entry);
        crate::ui::note(
            "the main window starts hidden (nsh.json window.defaultVisible: false) until the app shows it",
        );
    }
}

/// Declares the file types the app opens in an Apple `Info.plist`
/// (`CFBundleDocumentTypes`), so the system lists the app in Open With and
/// hands it the files (`application:openURLs:`).
fn document_types(info: &mut plist::Dictionary, types: &[nsh_core::file_type::FileType]) {
    use plist::Value;
    if types.is_empty() {
        return;
    }
    let strings =
        |items: &[String]| Value::Array(items.iter().cloned().map(Value::String).collect());
    let list = types
        .iter()
        .map(|t| {
            let mut d = plist::Dictionary::new();
            d.insert("CFBundleTypeName".into(), Value::String(t.name.clone()));
            d.insert(
                "CFBundleTypeRole".into(),
                Value::String(t.role.apple().into()),
            );
            if !t.extensions.is_empty() {
                d.insert("CFBundleTypeExtensions".into(), strings(&t.extensions));
            }
            if !t.mime_types.is_empty() {
                d.insert("CFBundleTypeMIMETypes".into(), strings(&t.mime_types));
            }
            if !t.content_types.is_empty() {
                d.insert("LSItemContentTypes".into(), strings(&t.content_types));
            }
            d.insert("LSHandlerRank".into(), Value::String("Alternate".into()));
            Value::Dictionary(d)
        })
        .collect();
    info.insert("CFBundleDocumentTypes".into(), Value::Array(list));
}

/// Declares the URL schemes the app claims in an Apple `Info.plist`
/// (`CFBundleURLTypes`), so the system opens the app for their links.
fn url_types(info: &mut plist::Dictionary, id: &str, schemes: &[String]) {
    use plist::Value;
    if schemes.is_empty() {
        return;
    }
    let mut url_type = plist::Dictionary::new();
    url_type.insert("CFBundleURLName".into(), Value::String(id.to_owned()));
    url_type.insert(
        "CFBundleURLSchemes".into(),
        Value::Array(schemes.iter().cloned().map(Value::String).collect()),
    );
    info.insert(
        "CFBundleURLTypes".into(),
        Value::Array(vec![Value::Dictionary(url_type)]),
    );
}

/// `nsh.json` `"web"`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebConfig {
    /// The page's host: a JS module, relative to `nsh.json`, whose
    /// `createHost(player)` returns what `nsh/host` calls reach
    /// (`createPlayer`'s `host`).
    pub(crate) host: Option<PathBuf>,
    /// The hosts the page's host module reaches (patterns, as
    /// `capabilities.network.hosts`): the page's `connect-src` allows them
    /// too, while the app's own requests stay checked against its
    /// `capabilities`.
    #[serde(default)]
    pub(crate) connect: Vec<String>,
    /// The path the site is served under (`/`, `/apps/counter/`): the page
    /// gets a `<base href>`, so it loads at any of the app's own paths
    /// (`/apps/counter/sports/football`). Without it the page's URLs are
    /// relative to the page.
    pub(crate) base: Option<String>,
    /// Whether pushed pages and open dialogs are entries of the browser's
    /// history (`createPlayer`'s `history`), on the packaged page and the
    /// dev server's; by default only where the app is the whole page, not
    /// in an iframe.
    pub(crate) history: Option<bool>,
}

/// Options of `nsh package`.
pub(crate) struct PackageOptions<'a> {
    pub(crate) entry: &'a Path,
    pub(crate) target: PackageTarget,
    pub(crate) out: &'a Path,
    pub(crate) config: AppConfig,
    /// Code signing identity (device builds).
    pub(crate) sign: Option<&'a str>,
    /// Provisioning profile (device builds).
    pub(crate) profile: Option<&'a Path>,
    /// Android release keystore, key alias and password.
    pub(crate) keystore: Option<(&'a Path, &'a str, &'a str)>,
    /// Android: the ABIs of the APK (empty: [`android::DEFAULT_ABIS`], plus
    /// the device's with `run`).
    ///
    /// [`android::DEFAULT_ABIS`]: crate::android::DEFAULT_ABIS
    pub(crate) abis: &'a [String],
    /// Android: an APK or an App Bundle.
    pub(crate) format: crate::android::Format,
    /// macOS: the processors the app runs on (`None`: this Mac's).
    pub(crate) arch: Option<Arch>,
    /// Install and launch in the simulator or on the device afterwards
    /// (Linux, macOS, Windows: launch it; the web: serve it and open it in
    /// the browser).
    pub(crate) run: bool,
    /// The web: the URL the site's files are served from (`--asset-url`).
    pub(crate) asset_url: Option<&'a str>,
}

/// `nsh.json` `"icon"`: one PNG for every target, or one per platform
/// (`{ "macos": "icon-mac.png", "windows": "icon-win.png" }`) since their
/// conventions differ (macOS draws its artwork inset on a transparent
/// canvas, Windows edge to edge). A platform left out gets no icon.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub(crate) enum AppIcon {
    /// The icon of every target.
    All(PathBuf),
    /// The icons by platform: `macos`, `windows`, `linux`, `ios`, `android`,
    /// `web` ([`AppIcon::PLATFORMS`]).
    Platforms(std::collections::BTreeMap<String, PathBuf>),
}

impl AppIcon {
    /// The keys of [`AppIcon::Platforms`].
    const PLATFORMS: [&str; 6] = ["macos", "windows", "linux", "ios", "android", "web"];

    /// The icon of `target`'s platform.
    pub(crate) fn of(&self, target: PackageTarget) -> Option<&Path> {
        let platform = match target {
            PackageTarget::Ios | PackageTarget::IosSimulator => "ios",
            PackageTarget::Android => "android",
            PackageTarget::Linux => "linux",
            PackageTarget::Macos => "macos",
            PackageTarget::Windows => "windows",
            PackageTarget::Web => "web",
            PackageTarget::Gpui => return None,
        };
        match self {
            AppIcon::All(icon) => Some(icon),
            AppIcon::Platforms(icons) => icons.get(platform).map(PathBuf::as_path),
        }
    }
}

impl AppConfig {
    /// The app's icon for `target` (`nsh.json` `"icon"`, or `--icon`).
    pub(crate) fn icon(&self, target: PackageTarget) -> Option<&Path> {
        self.icon.as_ref()?.of(target)
    }
}

/// Reads `nsh.json` next to `entry`, if any; relative paths become absolute.
pub(crate) fn read_config(entry: &Path) -> anyhow::Result<AppConfig> {
    let dir = entry.parent().unwrap_or(Path::new("."));
    let path = dir.join("nsh.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(AppConfig {
            localizations: app_localizations(dir, None),
            ..AppConfig::default()
        });
    };
    let (mut config, mut ignored) =
        parse_config(&text).with_context(|| format!("invalid {}", path.display()))?;
    if let Some(value) = &config.tui.points_per_cell
        && let Err(e) = crate::run::parse_points_per_cell(value)
    {
        ignored.push(format!("tui.pointsPerCell: {e}"));
        config.tui.points_per_cell = None;
    }
    let (schemes, schemes_ignored) =
        nsh_core::url_scheme::schemes_from_json_lenient(&serde_json::json!(config.schemes));
    config.schemes = schemes;
    ignored.extend(schemes_ignored);
    if let Some(types) = &config.file_types {
        let (_, types_ignored) = nsh_core::file_type::parse_file_types(types);
        ignored.extend(types_ignored);
    }
    // The bundler warns of another value.
    if !matches!(
        config.appearance.as_deref(),
        None | Some("light" | "dark" | "system")
    ) {
        config.appearance = None;
    }
    if let Some(window) = &config.window
        && let Err(e) = nsh_core::desktop::MainWindowOptions::from_json(window)
    {
        ignored.push(format!("window: {e}"));
        config.window = None;
    }
    config.icon = match config.icon {
        Some(AppIcon::All(icon)) => Some(AppIcon::All(dir.join(icon))),
        Some(AppIcon::Platforms(icons)) => Some(AppIcon::Platforms(
            icons
                .into_iter()
                .filter(|(platform, _)| {
                    let known = AppIcon::PLATFORMS.contains(&platform.as_str());
                    if !known {
                        ignored.push(format!("unknown key `icon.{platform}`"));
                    }
                    known
                })
                .map(|(platform, icon)| (platform, dir.join(icon)))
                .collect(),
        )),
        None => None,
    };
    warn_ignored(&path, &ignored);
    config.ios.check(ApplePlatform::Ios)?;
    config.macos.check()?;
    config.web.host = config.web.host.map(|host| dir.join(host));
    config.localizations = app_localizations(dir, config.locales.as_ref());
    Ok(config)
}

/// The locales of the app in `dir` ([`nsh_i18n::app_locales`]), from
/// `nsh.json`'s `locales` (its tags; the bundler warns of other values)
/// or `locales/`'s translations (the bundler reports one it cannot read).
fn app_localizations(dir: &Path, locales: Option<&serde_json::Value>) -> Vec<String> {
    let locales = locales.and_then(serde_json::Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    });
    let translations = match locales {
        Some(_) => Default::default(),
        None => nsh_i18n::read_translations(dir).unwrap_or_default(),
    };
    nsh_i18n::app_locales(&translations, locales.as_deref())
}

/// Declares the app's locales to Apple's systems (`CFBundleLocalizations`,
/// English, the development region, first): system UI, such as AppKit's and
/// UIKit's menus, shows in the language the app does, which without it is
/// English whatever the user's.
fn bundle_localizations(d: &mut plist::Dictionary, config: &AppConfig) {
    if config.localizations.is_empty() {
        return;
    }
    let mut list = vec!["en".to_owned()];
    for locale in &config.localizations {
        if !list.contains(locale) {
            list.push(locale.clone());
        }
    }
    d.insert(
        "CFBundleLocalizations".into(),
        plist::Value::Array(list.into_iter().map(plist::Value::String).collect()),
    );
}

/// `nsh.json`'s text as an [`AppConfig`], with what it left out: keys it
/// does not know (`unknown key `updater.channel``) and values of a form it
/// does not know (`build: invalid type: string "7", expected u32`), a newer
/// NSH's or typos. Only text that is no JSON object is an error.
fn parse_config(text: &str) -> anyhow::Result<(AppConfig, Vec<String>)> {
    let mut value: serde_json::Value = serde_json::from_str(text)?;
    if !value.is_object() {
        bail!("expected an object");
    }
    let mut ignored = Vec::new();
    // Each round leaves out the value that failed, until the rest reads;
    // every value can fail once at most.
    loop {
        let mut unknown = Vec::new();
        let read = serde_path_to_error::deserialize::<_, AppConfig>(
            serde_ignored::Deserializer::new(&value, &mut |key: serde_ignored::Path<'_>| {
                let mut name = String::new();
                key_name(&key, &mut name);
                unknown.push(format!("unknown key `{name}`"));
            }),
        );
        match read {
            Ok(config) => {
                ignored.extend(unknown);
                return Ok((config, ignored));
            }
            Err(e) => {
                let at = e.path().clone();
                if !remove_at(&mut value, &at) {
                    return Err(e.into_inner().into());
                }
                ignored.push(format!("{at}: {}", e.into_inner()));
            }
        }
    }
}

/// Removes the value at `path` from `value`; `false` when there is none
/// (the root).
fn remove_at(value: &mut serde_json::Value, path: &serde_path_to_error::Path) -> bool {
    use serde_path_to_error::Segment;
    let segments: Vec<&Segment> = path.iter().collect();
    let Some((last, parents)) = segments.split_last() else {
        return false;
    };
    let mut at = value;
    for segment in parents {
        let next = match (segment, at) {
            (Segment::Map { key }, serde_json::Value::Object(o)) => o.get_mut(key),
            (Segment::Seq { index }, serde_json::Value::Array(a)) => a.get_mut(*index),
            _ => None,
        };
        match next {
            Some(next) => at = next,
            None => return false,
        }
    }
    match (last, at) {
        (Segment::Map { key }, serde_json::Value::Object(o)) => o.remove(key).is_some(),
        (Segment::Seq { index }, serde_json::Value::Array(a)) if *index < a.len() => {
            a.remove(*index);
            true
        }
        _ => false,
    }
}

/// A key's path as `nsh.json` writes it (`updater.channel`): the steps
/// through `Option`s and newtypes are not keys.
fn key_name(path: &serde_ignored::Path<'_>, out: &mut String) {
    use serde_ignored::Path;
    let mut step = |parent: &Path<'_>, segment: &dyn std::fmt::Display| {
        key_name(parent, out);
        if !out.is_empty() {
            out.push('.');
        }
        out.push_str(&segment.to_string());
    };
    match path {
        Path::Root => {}
        Path::Map { parent, key } => step(parent, key),
        Path::Seq { parent, index } => step(parent, index),
        Path::Some { parent }
        | Path::NewtypeStruct { parent }
        | Path::NewtypeVariant { parent } => key_name(parent, out),
    }
}

/// Warns of what `nsh.json` left out, once per file: a command reads it
/// several times.
fn warn_ignored(path: &Path, ignored: &[String]) {
    static WARNED: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());
    if ignored.is_empty() {
        return;
    }
    let mut warned = WARNED.lock().unwrap_or_else(|e| e.into_inner());
    if warned.iter().any(|p| p == path) {
        return;
    }
    warned.push(path.to_owned());
    for what in ignored {
        crate::ui::warn(format_args!(
            "nsh.json: {what}, ignored (one of a newer NSH, or a typo)"
        ));
    }
}

/// `nsh.json` `web.host` (`read_config` made it absolute), canonical: the
/// file must be inside the app's directory, symbolic links resolved, as the
/// page ships it as it is.
pub(crate) fn web_host_module(entry: &Path, host: &Path) -> anyhow::Result<PathBuf> {
    // `App.tsx`'s parent is the empty path, which does not canonicalize.
    let dir = entry.parent().filter(|d| !d.as_os_str().is_empty());
    let dir = dunce::canonicalize(dir.unwrap_or(Path::new(".")))
        .with_context(|| format!("the app's directory of {}", entry.display()))?;
    let module = dunce::canonicalize(host)
        .with_context(|| format!("nsh.json web.host {}", host.display()))?;
    if !module.starts_with(&dir) {
        bail!(
            "nsh.json web.host {} must be inside the app's directory {}",
            host.display(),
            dir.display()
        );
    }
    Ok(module)
}

/// The app's display name and id: from the config, else the entry's
/// directory name and `com.example.<name>`.
pub(crate) fn name_and_id(entry: &Path, config: &AppConfig) -> (String, String) {
    let name = config.name.clone().unwrap_or_else(|| {
        entry
            .parent()
            .and_then(|d| d.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "App".to_owned())
    });
    let id = config.id.clone().unwrap_or_else(|| {
        let slug: String = name
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_lowercase();
        format!("com.example.{slug}")
    });
    (name, id)
}

/// The app's id (`nsh.json` `"id"`, else made up from its name as
/// [`name_and_id`] does): it travels with the bundle (`app.json`, the dev
/// server's messages) and names where the app keeps its data.
pub(crate) fn app_id(entry: &Path) -> anyhow::Result<String> {
    let entry = dunce::canonicalize(entry)?;
    let config = read_config(&entry).unwrap_or_default();
    Ok(name_and_id(&entry, &config).1)
}

/// [`name_and_id`] for a release (`nsh package`, `nsh publish`): the id
/// must be the app's own, written in `nsh.json`, since it also names where
/// the app keeps its data (`nsh/storage`) and two apps with one id share it.
pub(crate) fn release_name_and_id(
    entry: &Path,
    config: &AppConfig,
) -> anyhow::Result<(String, String)> {
    let Some(id) = &config.id else {
        bail!(
            "nsh.json needs an `id` for a release, in reverse-DNS form (`com.yourcompany.app`): it names the app and where it keeps its data, so no other app may use it"
        );
    };
    if id.starts_with("com.example.") {
        ui::warn(format!(
            "app id `{id}` is a placeholder: give the app an id under a domain you own before releasing it, as apps with one id share their data"
        ));
    }
    Ok(name_and_id(entry, config))
}

pub(crate) fn package(options: PackageOptions<'_>) -> anyhow::Result<()> {
    if options.asset_url.is_some() && options.target != PackageTarget::Web {
        bail!("--asset-url is where a web site's files are served from: package with --target web");
    }
    if let Some(url) = options.asset_url {
        crate::web::check_asset_url(url)?;
    }
    if options.target == PackageTarget::Gpui {
        let instead = PackageTarget::desktop()
            .and_then(|t| clap::ValueEnum::to_possible_value(&t))
            .map_or("macos, windows or linux".to_owned(), |v| {
                v.get_name().to_owned()
            });
        bail!(
            "GPUI is the backend for embedding in GPUI and GPUI Kit apps (`AppView`), not for packages: \
             package this app with --target {instead}"
        );
    }
    if !options.abis.is_empty() && options.target != PackageTarget::Android {
        bail!("--abi only applies to --target android");
    }
    if options.arch.is_some() && options.target != PackageTarget::Macos {
        bail!("--arch only applies to --target macos");
    }
    if options.format != crate::android::Format::Apk {
        if options.target != PackageTarget::Android {
            bail!("--format only applies to --target android");
        }
        if options.run {
            bail!(
                "--run installs an APK: drop --format aab, or install the bundle with bundletool"
            );
        }
    }
    let entry = dunce::canonicalize(options.entry)?;
    let config = &options.config;
    let (name, id) = release_name_and_id(&entry, config)?;
    let schemes = config.url_schemes();
    if options.target == PackageTarget::Web && !schemes.is_empty() {
        ui::warn(
            "nsh.json schemes: a web page opens from its address, so the schemes are left out",
        );
    }
    let executable: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let executable = if executable.is_empty() {
        "App".to_owned()
    } else {
        executable
    };

    // Web apps load what `import()` brings in when it is used; native
    // packages are one bundle. A Rust app has none: its runner mounts its
    // root (`rust_app::RustApp::runtime`).
    let mut built = if crate::rust_app::is_root(&entry) {
        crate::build::rust_root()
    } else {
        let split = matches!(options.target, PackageTarget::Web);
        let built = crate::build::compile_package(&entry, split, config)
            .map_err(|e| e.into_error(&entry))?;
        ui::done(format!("built {} {}", ui::path(&entry), built.summary("")));
        built
    };
    if options.target != PackageTarget::Web {
        crate::updater::add_config(config, &id, options.out, &mut built)?;
    }
    let platform = match options.target {
        PackageTarget::Ios => Platform::IphoneOs,
        PackageTarget::IosSimulator => Platform::IphoneSimulator,
        PackageTarget::Android => {
            return package_android(&options, config, &name, &id, &built);
        }
        PackageTarget::Linux => {
            let app = App {
                name: &name,
                id: &id,
                executable: &executable,
            };
            return package_linux(&options, config, &app, &built);
        }
        PackageTarget::Macos => {
            let app = App {
                name: &name,
                id: &id,
                executable: &executable,
            };
            return package_macos(&options, config, &app, &built);
        }
        PackageTarget::Windows => {
            return crate::windows::package(&options, config, &name, &id, &built);
        }
        PackageTarget::Web => {
            return crate::web::package(&options, config, &name, &id, &built);
        }
        PackageTarget::Gpui => unreachable!("refused above"),
    };
    let runner = runtime::file(platform, true)?;

    fs::create_dir_all(options.out)?;
    let app = options.out.join(format!("{name}.app"));
    if app.exists() {
        fs::remove_dir_all(&app)?;
    }
    let resources = app.join("nsh");
    fs::create_dir_all(&resources)?;
    fs::copy(&runner, app.join(&executable))
        .with_context(|| format!("copy {}", runner.display()))?;
    // A Rust app has no bundle: the runner mounts its root.
    if !built.rust_root {
        fs::write(resources.join("bundle.nshc"), &built.bytecode)?;
    }
    if let Some(json) = built.capabilities_json() {
        fs::write(resources.join("capabilities.json"), json)?;
    }
    // The app's id, which names where it keeps its data, and the schemes
    // it claims (`Bundle::read`).
    fs::write(
        resources.join("app.json"),
        app_json(
            {
                let mut info = serde_json::json!({ "id": id, "name": name });
                config.add_file_types_to_app_json(&mut info);
                info
            },
            &schemes,
            config.window.as_ref(),
        ),
    )?;
    for asset in &built.assets {
        let dest = resources.join("assets").join(&asset.path);
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::copy(&asset.source, &dest).with_context(|| format!("copy {}", asset.path))?;
    }

    let sdk = match options.target {
        PackageTarget::Ios => "iphoneos",
        PackageTarget::IosSimulator
        | PackageTarget::Android
        | PackageTarget::Linux
        | PackageTarget::Macos
        | PackageTarget::Windows
        | PackageTarget::Web
        | PackageTarget::Gpui => "iphonesimulator",
    };
    let mut info = info_plist(&name, &id, &executable, config, sdk)?;
    url_types(&mut info, &id, &schemes);
    document_types(&mut info, &config.file_types());
    if let Some(icon) = config.icon(PackageTarget::Ios) {
        let partial = compile_icon(icon, &app, sdk, minimum_os(&info))?;
        for (key, value) in partial {
            info.insert(key, value);
        }
    }
    plist::Value::Dictionary(info).to_file_xml(app.join("Info.plist"))?;

    match options.target {
        PackageTarget::IosSimulator => {
            // The simulator takes the app's entitlements without a profile.
            let entitlements = config.ios.entitlements(ApplePlatform::Ios)?;
            let mut path = None;
            if !entitlements.is_empty() {
                let file = options.out.join(format!("{executable}.entitlements"));
                plist::Value::Dictionary(entitlements).to_file_xml(&file)?;
                path = Some(file);
            }
            codesign(&app, "-", path.as_deref())?;
            ui::done(format!("packaged {}", ui::path(&app)));
            if options.run {
                let udid = crate::run::simulator(None)?;
                let step = ui::Step::start(format!("installing {id} in the simulator"));
                crate::run::simctl(&["install", &udid, &app.to_string_lossy()])?;
                crate::run::simctl_with_env(
                    &["launch", "--terminate-running-process", &udid, &id],
                    &crate::run::simctl_app_env(config),
                )?;
                step.done(format!("launched {id} in the simulator"));
            }
        }
        PackageTarget::Android
        | PackageTarget::Linux
        | PackageTarget::Macos
        | PackageTarget::Windows
        | PackageTarget::Web
        | PackageTarget::Gpui => {
            unreachable!("packaged above")
        }
        PackageTarget::Ios => {
            if options.run {
                bail!("--run only applies to the simulator and Android");
            }
            let (Some(identity), Some(profile)) = (options.sign, options.profile) else {
                ui::warn(format!(
                    "{} is unsigned: pass --sign <identity> and --profile <file.mobileprovision> to install it on devices",
                    ui::path(&app)
                ));
                return Ok(());
            };
            fs::copy(profile, app.join("embedded.mobileprovision"))
                .with_context(|| format!("copy {}", profile.display()))?;
            let requested = config.ios.entitlements(ApplePlatform::Ios)?;
            let entitlements = entitlements(profile, &id, requested)?;
            let path = options.out.join(format!("{executable}.entitlements"));
            entitlements.to_file_xml(&path)?;
            codesign(&app, identity, Some(&path))?;
            let ipa = options.out.join(format!("{name}.ipa"));
            make_ipa(&app, &ipa)?;
            ui::done(format!("packaged {}", ui::path(&ipa)));
        }
    }
    Ok(())
}

/// A desktop app to package: its name, id and executable file name.
#[derive(Clone, Copy)]
struct App<'a> {
    name: &'a str,
    id: &'a str,
    executable: &'a str,
}

/// The ABIs of an APK: `requested`, else [`android::DEFAULT_ABIS`] and the
/// preferred ABI of the device it is installed on (`device`: its ABIs,
/// preferred first), when the runtime is built for it: an emulator's
/// `x86_64`.
///
/// [`android::DEFAULT_ABIS`]: crate::android::DEFAULT_ABIS
fn apk_abis(requested: &[String], device: Option<&[String]>) -> anyhow::Result<Vec<String>> {
    use crate::android::{ABIS, DEFAULT_ABIS};
    if !requested.is_empty() {
        let mut abis = Vec::new();
        for abi in requested {
            if !abis.contains(abi) {
                abis.push(abi.clone());
            }
        }
        if let Some(device) = device
            && !device.iter().any(|abi| abis.contains(abi))
        {
            bail!(
                "the device runs {}, which --abi leaves out",
                device.join(", ")
            );
        }
        return Ok(abis);
    }
    let mut abis: Vec<String> = DEFAULT_ABIS.iter().map(|abi| abi.to_string()).collect();
    if let Some(abi) = device
        .unwrap_or_default()
        .iter()
        .find(|abi| ABIS.contains(&abi.as_str()))
        && !abis.contains(abi)
    {
        abis.push(abi.clone());
    }
    Ok(abis)
}

/// An APK with the release runtime: `AppActivity` runs `assets/nsh/bundle.nshc`.
fn package_android(
    options: &PackageOptions<'_>,
    config: &AppConfig,
    name: &str,
    id: &str,
    built: &crate::build::Built,
) -> anyhow::Result<()> {
    use crate::android::{self, Apk, Signing};
    let sdk = android::Sdk::find()?;
    let serial = if options.run {
        Some(android::device(&sdk)?)
    } else {
        None
    };
    let device = match &serial {
        Some(serial) => Some(android::device_abis(&sdk, serial)?),
        None => None,
    };
    let abis = apk_abis(options.abis, device.as_deref())?;
    let runtime = runtime::android(false, &abis)?;
    // A Rust app has no bundle: `AppActivity` runs its root (the
    // manifest's `com.longbridge.nsh.RUST`).
    let mut assets = Vec::new();
    if !built.rust_root {
        assets.push(("nsh/bundle.nshc".to_owned(), built.bytecode.clone()));
    }
    if let Some(json) = built.capabilities_json() {
        assets.push(("nsh/capabilities.json".to_owned(), json.into_bytes()));
    }
    // The app's id, which names where it keeps its data.
    assets.push((
        "nsh/app.json".to_owned(),
        app_json(
            serde_json::json!({ "id": id }),
            &config.schemes,
            config.window.as_ref(),
        )
        .into_bytes(),
    ));
    for asset in &built.assets {
        let bytes = fs::read(&asset.source).with_context(|| format!("read {}", asset.path))?;
        assets.push((format!("nsh/assets/{}", asset.path), bytes));
    }
    let signing = match options.keystore {
        Some((path, alias, password)) => Signing::Keystore {
            path: path.to_path_buf(),
            alias: alias.to_owned(),
            password: password.to_owned(),
        },
        None => {
            ui::warn("signing with the debug key: pass --keystore for store releases");
            Signing::Debug
        }
    };
    fs::create_dir_all(options.out)?;
    let target_sdk = config.android.target_sdk()?;
    let apk_path = options
        .out
        .join(format!("{name}.{}", options.format.extension()));
    let version = config.version.as_deref().unwrap_or("1.0.0");
    let step = ui::Step::start(format!("packaging {}", ui::path(&apk_path)));
    android::build(
        &sdk,
        &Apk {
            package: id,
            label: name,
            version_name: version,
            version_code: config.build.unwrap_or(1),
            target_sdk,
            activity: "com.longbridge.nsh.AppActivity",
            dev: false,
            cleartext: config.android.uses_cleartext_traffic,
            notifications: config.notifications(),
            microphone: config.web_media("microphone"),
            camera: config.web_media("camera"),
            schemes: &config.schemes,
            rust: built.rust_root,
            dark: config.appearance.as_deref() == Some("dark"),
            runtime: &runtime,
            abis: &abis,
            icon: config.icon(PackageTarget::Android),
            assets,
            signing,
        },
        options.format,
        &apk_path,
    )?;
    step.done(format!(
        "packaged {} {}",
        ui::path(&apk_path),
        ui::dim(format!("({})", abis.join(", ")))
    ));
    if let Some(serial) = serial {
        let step = ui::Step::start(format!("installing {id} on {serial}"));
        android::adb(
            &sdk,
            &serial,
            &["install", "-r", &apk_path.to_string_lossy()],
        )?;
        android::adb(
            &sdk,
            &serial,
            &[
                "shell",
                "am",
                "start",
                "-n",
                &format!("{id}/com.longbridge.nsh.AppActivity"),
            ],
        )?;
        step.done(format!("launched {id} on {serial}"));
    }
    Ok(())
}

/// A directory `<out>/<name>`: the release runner as `<executable>`, the
/// bundle and assets in `nsh/` (where the runner looks, next to itself),
/// `nsh/app.json` (the window's title, the application id, the app's
/// appearance, which the window opens in, and the main window's options), a
/// `<id>.desktop` entry and the icon; then the same as `<name>.tar.gz`.
fn package_linux(
    options: &PackageOptions<'_>,
    config: &AppConfig,
    app: &App<'_>,
    built: &crate::build::Built,
) -> anyhow::Result<()> {
    let App {
        name,
        id,
        executable,
    } = *app;
    let runner = runtime::file(Platform::Linux, true)?;
    let dir = options.out.join(name);
    let step = ui::Step::start(format!("packaging {}", ui::path(&dir)));
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    let resources = dir.join("nsh");
    fs::create_dir_all(&resources)?;
    fs::copy(&runner, dir.join(executable))
        .with_context(|| format!("copy {}", runner.display()))?;
    // A Rust app has no bundle: the runner mounts its root.
    if !built.rust_root {
        fs::write(resources.join("bundle.nshc"), &built.bytecode)?;
    }
    if let Some(json) = built.capabilities_json() {
        fs::write(resources.join("capabilities.json"), json)?;
    }
    for asset in &built.assets {
        let dest = resources.join("assets").join(&asset.path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&asset.source, &dest).with_context(|| format!("copy {}", asset.path))?;
    }
    let version = config.version.as_deref().unwrap_or("1.0.0");
    let mut info = desktop_app_json(config, name, id, version);
    info["schemes"] = serde_json::json!(config.schemes);
    fs::write(resources.join("app.json"), info.to_string())?;
    let icon = config.icon(PackageTarget::Linux);
    if let Some(icon) = icon {
        fs::copy(icon, dir.join(format!("{id}.png")))
            .with_context(|| format!("copy {}", icon.display()))?;
    }
    fs::write(
        dir.join(format!("{id}.desktop")),
        desktop_entry(
            name,
            id,
            executable,
            icon.is_some(),
            &config.schemes,
            &file_mime_types(&config.file_types()),
        ),
    )?;
    let archive = options.out.join(format!("{name}.tar.gz"));
    let _ = fs::remove_file(&archive);
    let output = Command::new("tar")
        .arg("-czf")
        .arg(&archive)
        .arg("-C")
        .arg(options.out)
        .arg(name)
        .output()
        .context("run tar")?;
    if !output.status.success() {
        bail!(
            "creating {} failed: {}",
            archive.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    crate::updater::copy_archive(config, name, &archive, options.out)?;
    step.done(format!(
        "packaged {} and {}",
        ui::path(&dir),
        ui::path(&archive)
    ));
    if options.run {
        let exe = dir.join(executable);
        Command::new(&exe)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("launch {}", exe.display()))?;
        ui::done(format!("launched {name}"));
    }
    Ok(())
}

/// `<out>/<name>.app`, a macOS app bundle: the release runner as
/// `Contents/MacOS/<executable>`, the bundle and assets in
/// `Contents/Resources/nsh/` (where the runner looks), `nsh/app.json` (the
/// window's title and the app's appearance, which the window opens in),
/// the icon as `AppIcon.icns`; signed ad hoc (Apple silicon runs no
/// unsigned code; distribute it signed with a Developer ID instead).
fn package_macos(
    options: &PackageOptions<'_>,
    config: &AppConfig,
    app: &App<'_>,
    built: &crate::build::Built,
) -> anyhow::Result<()> {
    let App {
        name,
        id,
        executable,
    } = *app;
    let runners = macos_runners(options.arch)?;
    let app = options.out.join(format!("{name}.app"));
    let step = ui::Step::start(format!("packaging {}", ui::path(&app)));
    if app.exists() {
        fs::remove_dir_all(&app)?;
    }
    let contents = app.join("Contents");
    let macos = contents.join("MacOS");
    let resources = contents.join("Resources");
    let nsh = resources.join("nsh");
    fs::create_dir_all(&macos)?;
    fs::create_dir_all(&nsh)?;
    install_macos_runner(&runners, &macos.join(executable))?;
    // A Rust app has no bundle: the runner mounts its root.
    if !built.rust_root {
        fs::write(nsh.join("bundle.nshc"), &built.bytecode)?;
    }
    if let Some(json) = built.capabilities_json() {
        fs::write(nsh.join("capabilities.json"), json)?;
    }
    for asset in &built.assets {
        let dest = nsh.join("assets").join(&asset.path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&asset.source, &dest).with_context(|| format!("copy {}", asset.path))?;
    }
    let version = config.version.as_deref().unwrap_or("1.0.0");
    let mut info = serde_json::json!({ "name": name, "id": id, "version": version });
    if let Some(appearance) = &config.appearance {
        info["appearance"] = appearance.as_str().into();
    }
    config.macos.add_to_app_json(&mut info);
    config.add_file_types_to_app_json(&mut info);
    let schemes = config.url_schemes();
    fs::write(
        nsh.join("app.json"),
        app_json(info, &schemes, config.window.as_ref()),
    )?;
    let icon = match config.icon(PackageTarget::Macos) {
        Some(icon) => {
            macos_icns(icon, &resources.join("AppIcon.icns"))?;
            true
        }
        None => false,
    };
    let mut plist = macos_info_plist(name, id, executable, config, icon)?;
    url_types(&mut plist, id, &schemes);
    document_types(&mut plist, &config.file_types());
    plist::Value::Dictionary(plist)
        .to_file_xml(contents.join("Info.plist"))
        .context("write Info.plist")?;
    let mut entitlements = config.macos.entitlements()?;
    config.web_media_entitlements(&mut entitlements);
    for key in entitlements.keys() {
        if crate::apple::needs_profile(key) {
            ui::warn(format!(
                "macOS launches an app signed with `{key}` (nsh.json macos.entitlements) only under a provisioning profile that grants it: \
                 sign {} again with your Developer ID and such a profile before running it",
                ui::path(&app)
            ));
        }
    }
    let mut codesign = Command::new("codesign");
    codesign.args(["--force", "--sign", "-", "--timestamp=none"]);
    if !entitlements.is_empty() {
        let path = options.out.join(format!("{executable}.entitlements"));
        plist::Value::Dictionary(entitlements).to_file_xml(&path)?;
        codesign.arg("--entitlements").arg(path);
    }
    let output = codesign.arg(&app).output().context("run codesign")?;
    if !output.status.success() {
        bail!(
            "codesign failed for {}: {}",
            app.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    crate::updater::archive_macos_app(
        config,
        name,
        &app,
        options.out,
        &macos_update_platforms(options.arch),
    )?;
    step.done(format!("packaged {}", ui::path(&app)));
    if options.run {
        let status = Command::new("open")
            .arg(&app)
            .status()
            .context("run open")?;
        if !status.success() {
            bail!("cannot open {}", app.display());
        }
        ui::done(format!("launched {name}"));
    }
    Ok(())
}

/// A macOS release runner a package is made of.
struct MacRunner {
    path: PathBuf,
    /// The architecture taken from it (`None`: the file as it is).
    arch: Option<&'static str>,
    /// Whether the file holds other architectures besides.
    fat: bool,
}

/// The macOS release runners of a package for `arch` (`None`: this Mac's):
/// one per architecture, each built for its Rust target (this Mac's own
/// with no `--target`).
fn macos_runners(arch: Option<Arch>) -> anyhow::Result<Vec<MacRunner>> {
    let Some(arch) = arch else {
        let path = runtime::file(Platform::MacOs, true)?;
        return Ok(vec![MacRunner {
            path,
            arch: None,
            fat: false,
        }]);
    };
    let mut runners = Vec::new();
    for &triple in arch.macos_triples() {
        let path = runtime::file_for(Platform::MacOs, true, macos_build_triple(triple))?;
        let wanted = lipo_arch(triple);
        // A prebuilt runner (an installed nsh's, `NSH_RUNTIME`) is built
        // for the processor of the machine that built it.
        let archs = lipo_archs(&path)?;
        if !archs.iter().any(|arch| arch == wanted) {
            bail!(
                "the macOS release runner {} is built for {}, not {wanted}: an installed nsh has the runner of its own processor, \
                 so package for {wanted} with the nsh of that processor, or with a nsh checkout, which builds the runner for any",
                path.display(),
                archs.join(" and ")
            );
        }
        runners.push(MacRunner {
            path,
            arch: Some(wanted),
            fat: archs.len() > 1,
        });
    }
    Ok(runners)
}

/// The architectures of the executable `path` (`lipo -archs`): `arm64`,
/// `x86_64`.
fn lipo_archs(path: &Path) -> anyhow::Result<Vec<String>> {
    let output = Command::new("lipo")
        .arg("-archs")
        .arg(path)
        .output()
        .context("run lipo")?;
    if !output.status.success() {
        bail!(
            "lipo -archs {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .map(str::to_owned)
        .collect())
}

/// Runs `lipo` with `args`.
fn lipo(args: &[&std::ffi::OsStr]) -> anyhow::Result<()> {
    let output = Command::new("lipo")
        .args(args)
        .output()
        .context("run lipo")?;
    if !output.status.success() {
        bail!(
            "lipo failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

/// Writes the package's executable `to` from `runners`: one runner's file,
/// its architecture taken out of a universal file, or the runners of
/// several architectures in one universal file.
fn install_macos_runner(runners: &[MacRunner], to: &Path) -> anyhow::Result<()> {
    let mut thin = Vec::new();
    let mut extracted = Vec::new();
    for runner in runners {
        match runner.arch {
            Some(arch) if runner.fat => {
                let part = to.with_extension(arch);
                lipo(&[
                    runner.path.as_os_str(),
                    "-thin".as_ref(),
                    arch.as_ref(),
                    "-output".as_ref(),
                    part.as_os_str(),
                ])?;
                extracted.push(part.clone());
                thin.push(part);
            }
            _ => thin.push(runner.path.clone()),
        }
    }
    let result = match thin.as_slice() {
        [one] => fs::copy(one, to)
            .map(|_| ())
            .with_context(|| format!("copy {}", one.display())),
        several => {
            let mut args: Vec<&std::ffi::OsStr> = vec!["-create".as_ref(), "-output".as_ref()];
            args.push(to.as_os_str());
            args.extend(several.iter().map(|path| path.as_os_str()));
            lipo(&args)
        }
    };
    for part in extracted {
        let _ = fs::remove_file(part);
    }
    result
}

/// Converts `icon` (a PNG) to `icns`: an iconset of every size macOS
/// uses, scaled by `sips`, packed by `iconutil`. `sips -s format icns`
/// alone fails on 1024-pixel images, the size app icons are drawn at.
fn macos_icns(icon: &Path, icns: &Path) -> anyhow::Result<()> {
    let set = icns.with_extension("iconset");
    fs::create_dir_all(&set)?;
    let run = |cmd: &mut Command, what: &str| -> anyhow::Result<()> {
        let output = cmd.output().with_context(|| format!("run {what}"))?;
        if !output.status.success() {
            bail!(
                "converting {} to an icon failed ({what}): {}",
                icon.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    };
    let result = (|| {
        for size in [16u32, 32, 128, 256, 512] {
            for (scale, suffix) in [(1, ""), (2, "@2x")] {
                let px = (size * scale).to_string();
                run(
                    Command::new("sips")
                        .args(["-s", "format", "png", "-z", &px, &px])
                        .arg(icon)
                        .arg("--out")
                        .arg(set.join(format!("icon_{size}x{size}{suffix}.png"))),
                    "sips",
                )?;
            }
        }
        run(
            Command::new("iconutil")
                .args(["-c", "icns"])
                .arg(&set)
                .arg("-o")
                .arg(icns),
            "iconutil",
        )
    })();
    let _ = fs::remove_dir_all(&set);
    result
}

/// The `Info.plist` of a macOS app.
fn macos_info_plist(
    name: &str,
    id: &str,
    executable: &str,
    config: &AppConfig,
    icon: bool,
) -> anyhow::Result<plist::Dictionary> {
    use plist::Value;
    let mut d = plist::Dictionary::new();
    let s = |v: &str| Value::String(v.to_owned());
    d.insert("CFBundleDevelopmentRegion".into(), s("en"));
    d.insert("CFBundleExecutable".into(), s(executable));
    d.insert("CFBundleIdentifier".into(), s(id));
    d.insert("CFBundleName".into(), s(name));
    d.insert("CFBundleDisplayName".into(), s(name));
    d.insert("CFBundlePackageType".into(), s("APPL"));
    d.insert(
        "CFBundleShortVersionString".into(),
        s(config.version.as_deref().unwrap_or("1.0.0")),
    );
    d.insert(
        "CFBundleVersion".into(),
        s(&config.build.unwrap_or(1).to_string()),
    );
    d.insert(
        "CFBundleSupportedPlatforms".into(),
        Value::Array(vec![s("MacOSX")]),
    );
    // The runtime's, unless the app raises it (`macos.infoPlist`).
    d.insert("LSMinimumSystemVersion".into(), s(MACOS_MINIMUM));
    d.insert("NSHighResolutionCapable".into(), true.into());
    d.insert("NSPrincipalClass".into(), s("NSApplication"));
    if icon {
        d.insert("CFBundleIconFile".into(), s("AppIcon"));
    }
    // A menu bar app is one from launch: the Dock never shows it.
    if config.macos.activation_policy == ActivationPolicy::Accessory {
        d.insert("LSUIElement".into(), true.into());
    }
    config.usage_descriptions(&mut d);
    bundle_localizations(&mut d, config);
    // The app's own keys, over NSH's defaults (never over its reserved ones).
    d.extend(config.macos.info_plist()?);
    Ok(d)
}

/// The MIME types of `types`, each once, for a Linux desktop entry.
pub(crate) fn file_mime_types(types: &[nsh_core::file_type::FileType]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for mime in types.iter().flat_map(|t| &t.mime_types) {
        if !out.contains(mime) {
            out.push(mime.clone());
        }
    }
    out
}

/// The app's desktop entry. Desktops match windows to it by the file's
/// name and `StartupWMClass`, which GTK sets from the application id.
/// `Exec` names the executable on the `PATH` (install the package
/// directory, or a link to the executable, there).
/// `schemes` are the URL schemes it opens (`MimeType=x-scheme-handler/…`):
/// the URL is `Exec`'s `%u`. `mime_types` are those of the files it opens
/// (nsh.json `fileTypes`), which make it `%U`: the files' URLs, several.
pub(crate) fn desktop_entry(
    name: &str,
    id: &str,
    executable: &str,
    icon: bool,
    schemes: &[String],
    mime_types: &[String],
) -> String {
    let icon = if icon {
        format!("Icon={id}\n")
    } else {
        String::new()
    };
    let types: String = schemes
        .iter()
        .map(|s| format!("x-scheme-handler/{s};"))
        .chain(mime_types.iter().map(|m| format!("{m};")))
        .collect();
    let (url, mime) = if types.is_empty() {
        ("", String::new())
    } else if mime_types.is_empty() {
        (" %u", format!("MimeType={types}\n"))
    } else {
        (" %U", format!("MimeType={types}\n"))
    };
    format!(
        "[Desktop Entry]\nType=Application\nName={name}\nExec={executable}{url}\n{icon}StartupWMClass={id}\nTerminal=false\nCategories=Utility;\n{mime}"
    )
}

fn info_plist(
    name: &str,
    id: &str,
    executable: &str,
    config: &AppConfig,
    sdk: &str,
) -> anyhow::Result<plist::Dictionary> {
    use plist::Value;
    let mut d = plist::Dictionary::new();
    let s = |v: &str| Value::String(v.to_owned());
    d.insert("CFBundleDevelopmentRegion".into(), s("en"));
    d.insert("CFBundleExecutable".into(), s(executable));
    d.insert("CFBundleIdentifier".into(), s(id));
    d.insert("CFBundleName".into(), s(name));
    d.insert("CFBundleDisplayName".into(), s(name));
    d.insert("CFBundlePackageType".into(), s("APPL"));
    d.insert(
        "CFBundleShortVersionString".into(),
        s(config.version.as_deref().unwrap_or("1.0.0")),
    );
    d.insert(
        "CFBundleVersion".into(),
        s(&config.build.unwrap_or(1).to_string()),
    );
    d.insert(
        "CFBundleSupportedPlatforms".into(),
        Value::Array(vec![s(if sdk == "iphoneos" {
            "iPhoneOS"
        } else {
            "iPhoneSimulator"
        })]),
    );
    // The runtime's, unless the app raises it (`ios.infoPlist`).
    d.insert("MinimumOSVersion".into(), s(IOS_MINIMUM));
    d.insert(
        "UIDeviceFamily".into(),
        Value::Array(vec![1.into(), 2.into()]),
    );
    d.insert("LSRequiresIPhoneOS".into(), true.into());
    config.usage_descriptions(&mut d);
    bundle_localizations(&mut d, config);
    // A launch screen entry opts into the full screen (no letterboxing).
    d.insert(
        "UILaunchScreen".into(),
        Value::Dictionary(Default::default()),
    );
    d.insert("UIApplicationSupportsMultipleScenes".into(), false.into());
    // ProMotion iPhones run display links above 60 Hz only with this:
    // animations move at the rate scrolling does.
    d.insert("CADisableMinimumFrameDurationOnPhone".into(), true.into());
    // The app's own appearance, from the launch screen on.
    match config.appearance.as_deref() {
        Some("light") => d.insert("UIUserInterfaceStyle".into(), s("Light")),
        Some("dark") => d.insert("UIUserInterfaceStyle".into(), s("Dark")),
        _ => None,
    };
    // The status bar's default, for the launch screen (pages and dialogs
    // decide it afterwards, as view controllers).
    if let Some(setting) = config
        .status_bar
        .as_ref()
        .map(nsh_core::StatusBarSetting::from_json)
    {
        if let Some(style) = setting.style {
            let style = match style {
                nsh_core::StatusBarStyle::Default => "UIStatusBarStyleDefault",
                nsh_core::StatusBarStyle::Light => "UIStatusBarStyleLightContent",
                nsh_core::StatusBarStyle::Dark => "UIStatusBarStyleDarkContent",
            };
            d.insert("UIStatusBarStyle".into(), s(style));
        }
        if let Some(hidden) = setting.hidden {
            d.insert("UIStatusBarHidden".into(), hidden.into());
        }
    }
    d.insert(
        "UISupportedInterfaceOrientations".into(),
        Value::Array(vec![
            s("UIInterfaceOrientationPortrait"),
            s("UIInterfaceOrientationLandscapeLeft"),
            s("UIInterfaceOrientationLandscapeRight"),
        ]),
    );
    d.insert(
        "UISupportedInterfaceOrientations~ipad".into(),
        Value::Array(vec![
            s("UIInterfaceOrientationPortrait"),
            s("UIInterfaceOrientationPortraitUpsideDown"),
            s("UIInterfaceOrientationLandscapeLeft"),
            s("UIInterfaceOrientationLandscapeRight"),
        ]),
    );
    // The app's own keys, over NSH's defaults (never over its reserved ones).
    d.extend(config.ios.info_plist(ApplePlatform::Ios)?);
    Ok(d)
}

/// The oldest iOS an app's `Info.plist` (`info`) declares: the app's own
/// `MinimumOSVersion`, or the runtime's.
fn minimum_os(info: &plist::Dictionary) -> &str {
    info.get("MinimumOSVersion")
        .and_then(plist::Value::as_string)
        .unwrap_or(IOS_MINIMUM)
}

/// Compiles `icon` into the app's asset catalog (`Assets.car`) with
/// `actool`, for `minimum`, the oldest iOS the app declares (as Xcode
/// compiles it for the deployment target), returning the Info.plist keys
/// it produces.
fn compile_icon(
    icon: &Path,
    app: &Path,
    sdk: &str,
    minimum: &str,
) -> anyhow::Result<plist::Dictionary> {
    let work = app.with_extension("xcassets-work");
    let set = work.join("Assets.xcassets/AppIcon.appiconset");
    fs::create_dir_all(&set)?;
    fs::copy(icon, set.join("icon.png")).with_context(|| format!("copy {}", icon.display()))?;
    fs::write(
        work.join("Assets.xcassets/Contents.json"),
        r#"{"info":{"author":"nsh","version":1}}"#,
    )?;
    // One 1024 pt image; actool derives every size (Xcode 14+ catalogs).
    fs::write(
        set.join("Contents.json"),
        r#"{"images":[{"filename":"icon.png","idiom":"universal","platform":"ios","size":"1024x1024"}],"info":{"author":"nsh","version":1}}"#,
    )?;
    let partial = work.join("partial.plist");
    let output = Command::new("xcrun")
        .args(["actool", "--compile"])
        .arg(app)
        .args(["--platform", sdk, "--minimum-deployment-target", minimum])
        .args(["--app-icon", "AppIcon", "--output-partial-info-plist"])
        .arg(&partial)
        .args([
            "--target-device",
            "iphone",
            "--target-device",
            "ipad",
            "--output-format",
            "human-readable-text",
        ])
        .arg(work.join("Assets.xcassets"))
        .output()
        .context("run xcrun actool (is Xcode installed?)")?;
    if !output.status.success() || !partial.exists() {
        bail!(
            "actool failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let keys = plist::Value::from_file(&partial)?
        .into_dictionary()
        .unwrap_or_default();
    fs::remove_dir_all(&work)?;
    Ok(keys)
}

fn codesign(app: &Path, identity: &str, entitlements: Option<&Path>) -> anyhow::Result<()> {
    let mut cmd = Command::new("codesign");
    cmd.args(["--force", "--sign", identity]);
    if identity == "-" {
        cmd.arg("--timestamp=none");
    }
    if let Some(e) = entitlements {
        cmd.arg("--entitlements").arg(e);
    }
    let output = cmd
        .arg(app)
        .stdout(Stdio::null())
        .output()
        .context("run codesign")?;
    if !output.status.success() {
        bail!(
            "codesign failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

/// The entitlements an app is signed with: those a provisioning profile
/// grants, checked against `id`, with the app's own (`requested`, `nsh.json`
/// `ios.entitlements`) in place of the profile's values, each checked
/// against what the profile grants.
fn entitlements(
    profile: &Path,
    id: &str,
    requested: plist::Dictionary,
) -> anyhow::Result<plist::Value> {
    let output = Command::new("security")
        .args(["cms", "-D", "-i"])
        .arg(profile)
        .output()
        .context("run security cms")?;
    if !output.status.success() {
        bail!("cannot read provisioning profile {}", profile.display());
    }
    let profile = plist::Value::from_reader_xml(output.stdout.as_slice())?;
    let mut entitlements = profile
        .as_dictionary()
        .and_then(|d| d.get("Entitlements"))
        .cloned()
        .context("the provisioning profile has no entitlements")?;
    let app_id = entitlements
        .as_dictionary()
        .and_then(|d| d.get("application-identifier"))
        .and_then(|v| v.as_string())
        .unwrap_or_default()
        .to_owned();
    if !profile_allows(&app_id, id) {
        bail!("the provisioning profile is for {app_id}, not {id}");
    }
    // A wildcard profile (`TEAMID.*`) signs the app as `TEAMID.<id>`, as
    // Xcode does: devices refuse an app signed with the wildcard itself.
    if let Some(dictionary) = entitlements.as_dictionary_mut() {
        crate::apple::grant(dictionary, requested)?;
        dictionary.insert(
            "application-identifier".to_owned(),
            plist::Value::String(signed_app_id(&app_id, id)),
        );
    }
    Ok(entitlements)
}

/// The `application-identifier` an app with bundle id `id` is signed with
/// under a profile's (`TEAMID.com.example.app` or a wildcard such as
/// `TEAMID.*`), which covers it.
fn signed_app_id(app_id: &str, id: &str) -> String {
    match app_id.split_once('.') {
        Some((team, pattern)) if pattern.ends_with('*') => format!("{team}.{id}"),
        _ => app_id.to_owned(),
    }
}

/// Whether a profile's `application-identifier` (`TEAMID.com.example.app`,
/// or a wildcard such as `TEAMID.*`) covers bundle id `id`.
fn profile_allows(app_id: &str, id: &str) -> bool {
    app_id
        .split_once('.')
        .map(|(_, pattern)| match pattern.strip_suffix('*') {
            Some(prefix) => id.starts_with(prefix),
            None => pattern == id,
        })
        .unwrap_or(false)
}

/// `Payload/<App>.app` zipped, keeping permissions and symlinks.
fn make_ipa(app: &Path, ipa: &Path) -> anyhow::Result<()> {
    let staging = ipa.with_extension("payload");
    let payload = staging.join("Payload");
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&payload)?;
    let status = Command::new("ditto")
        .arg(app)
        .arg(payload.join(app.file_name().context("app name")?))
        .status()?;
    if !status.success() {
        bail!("copying the app failed");
    }
    let _ = fs::remove_file(ipa);
    // `--keepParent`: entries start with `Payload/`; `--norsrc`: no
    // `__MACOSX/` resource forks.
    let status = Command::new("ditto")
        .args(["-c", "-k", "--norsrc", "--keepParent"])
        .arg(&payload)
        .arg(ipa)
        .status()?;
    fs::remove_dir_all(&staging)?;
    if !status.success() {
        bail!("creating {} failed", ipa.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each processor is a build for its Rust target, this Mac's own
    /// without `--target` (the build `nsh run` shares), named as `lipo`
    /// and the updater name it.
    #[test]
    fn macos_packages_build_a_runner_per_processor() {
        assert_eq!(Arch::Arm64.macos_triples(), ["aarch64-apple-darwin"]);
        assert_eq!(Arch::X86_64.macos_triples(), ["x86_64-apple-darwin"]);
        assert_eq!(
            Arch::Universal.macos_triples(),
            ["aarch64-apple-darwin", "x86_64-apple-darwin"]
        );
        let (here, other) = if cfg!(target_arch = "aarch64") {
            ("aarch64-apple-darwin", "x86_64-apple-darwin")
        } else {
            ("x86_64-apple-darwin", "aarch64-apple-darwin")
        };
        assert_eq!(macos_build_triple(here), None);
        assert_eq!(macos_build_triple(other), Some(other));
        assert_eq!(lipo_arch("aarch64-apple-darwin"), "arm64");
        assert_eq!(lipo_arch("x86_64-apple-darwin"), "x86_64");
        assert_eq!(macos_update_platforms(None), [nsh_updater::platform()]);
        assert_eq!(macos_update_platforms(Some(Arch::X86_64)), ["macos-x86_64"]);
        assert_eq!(
            macos_update_platforms(Some(Arch::Universal)),
            ["macos-aarch64", "macos-x86_64"]
        );
    }

    #[test]
    fn only_macos_packages_take_an_arch() {
        for target in [
            PackageTarget::Linux,
            PackageTarget::Windows,
            PackageTarget::Ios,
            PackageTarget::Android,
            PackageTarget::Web,
        ] {
            let error = package(PackageOptions {
                entry: Path::new("App.tsx"),
                target,
                out: Path::new(".nsh/out"),
                config: AppConfig::default(),
                sign: None,
                profile: None,
                keystore: None,
                abis: &[],
                format: crate::android::Format::Apk,
                arch: Some(Arch::X86_64),
                run: false,
                asset_url: None,
            })
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                "--arch only applies to --target macos",
                "{target:?}"
            );
        }
    }

    /// A universal package's executable is one file of both runners; an
    /// architecture is taken out of a universal runner.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_runners_merge_into_one_universal_executable() {
        let dir = std::env::temp_dir().join(format!("nsh-macos-runner-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("main.c");
        fs::write(&source, "int main(void) { return 0; }\n").unwrap();
        let compile = |arch: &str| {
            let out = dir.join(format!("runner-{arch}"));
            let status = Command::new("cc")
                .args(["-arch", arch, "-o"])
                .arg(&out)
                .arg(&source)
                .status()
                .unwrap();
            assert!(status.success());
            out
        };
        let (arm, intel) = (compile("arm64"), compile("x86_64"));
        let runner = |path: &Path, arch: &'static str| MacRunner {
            path: path.to_owned(),
            arch: Some(arch),
            fat: lipo_archs(path).unwrap().len() > 1,
        };

        let universal = dir.join("App");
        install_macos_runner(
            &[runner(&arm, "arm64"), runner(&intel, "x86_64")],
            &universal,
        )
        .unwrap();
        let mut archs = lipo_archs(&universal).unwrap();
        archs.sort();
        assert_eq!(archs, ["arm64", "x86_64"]);

        let thin = dir.join("Thin");
        install_macos_runner(&[runner(&universal, "x86_64")], &thin).unwrap();
        assert_eq!(lipo_archs(&thin).unwrap(), ["x86_64"]);
        // The part taken out is not left beside the executable.
        assert!(!dir.join("Thin.x86_64").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_apk_takes_the_phones_abis_and_the_devices() {
        let abis = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        let phones = abis(&["arm64-v8a", "armeabi-v7a"]);
        assert_eq!(apk_abis(&[], None).unwrap(), phones);
        // A phone: nothing more.
        assert_eq!(
            apk_abis(&[], Some(&abis(&["arm64-v8a", "armeabi-v7a", "armeabi"]))).unwrap(),
            phones
        );
        // An emulator: its own, first of those the runtime has.
        assert_eq!(
            apk_abis(&[], Some(&abis(&["x86_64", "arm64-v8a"]))).unwrap(),
            abis(&["arm64-v8a", "armeabi-v7a", "x86_64"])
        );
        // --abi, once each.
        let only = abis(&["arm64-v8a", "arm64-v8a"]);
        assert_eq!(apk_abis(&only, None).unwrap(), abis(&["arm64-v8a"]));
        let error = apk_abis(&only, Some(&abis(&["x86_64"])))
            .unwrap_err()
            .to_string();
        assert!(error.contains("x86_64"), "{error}");
    }

    #[test]
    fn android_target_sdk_defaults_and_is_checked() {
        let target = |json: serde_json::Value| {
            serde_json::from_value::<AppConfig>(json)
                .unwrap()
                .android
                .target_sdk()
        };
        assert_eq!(
            target(serde_json::json!({})).unwrap(),
            crate::android::DEFAULT_TARGET_SDK
        );
        assert_eq!(
            target(serde_json::json!({ "android": { "targetSdk": 36 } })).unwrap(),
            36
        );
        assert!(target(serde_json::json!({ "android": { "targetSdk": 21 } })).is_err());
    }

    #[test]
    fn android_cleartext_traffic_is_off_unless_asked_for() {
        let cleartext = |json: serde_json::Value| {
            serde_json::from_value::<AppConfig>(json)
                .unwrap()
                .android
                .uses_cleartext_traffic
        };
        assert!(!cleartext(serde_json::json!({})));
        assert!(!cleartext(
            serde_json::json!({ "android": { "targetSdk": 36 } })
        ));
        assert!(cleartext(
            serde_json::json!({ "android": { "usesCleartextTraffic": true } })
        ));
    }

    #[test]
    fn apps_that_may_recognize_speech_explain_it() {
        let usage = |capabilities: Option<serde_json::Value>| {
            let config = AppConfig {
                capabilities,
                ..AppConfig::default()
            };
            let info = macos_info_plist("A", "com.a", "a", &config, false).unwrap();
            let ios = info_plist("A", "com.a", "a", &config, "iphoneos").unwrap();
            assert_eq!(
                info.contains_key("NSMicrophoneUsageDescription"),
                ios.contains_key("NSSpeechRecognitionUsageDescription")
            );
            info.contains_key("NSSpeechRecognitionUsageDescription")
        };
        assert!(usage(None));
        assert!(usage(Some(serde_json::json!({ "speech": true }))));
        assert!(!usage(Some(serde_json::json!({ "picker": true }))));
    }

    #[test]
    fn web_pages_that_capture_media_explain_it() {
        let config = AppConfig {
            capabilities: Some(serde_json::json!({
                "webview": { "hosts": ["*"], "media": ["microphone", "camera"] }
            })),
            ..AppConfig::default()
        };
        for info in [
            macos_info_plist("A", "com.a", "a", &config, false).unwrap(),
            info_plist("A", "com.a", "a", &config, "iphoneos").unwrap(),
        ] {
            assert!(info.contains_key("NSMicrophoneUsageDescription"));
            assert!(info.contains_key("NSCameraUsageDescription"));
            assert!(!info.contains_key("NSSpeechRecognitionUsageDescription"));
        }
        let mut entitlements = plist::Dictionary::new();
        config.web_media_entitlements(&mut entitlements);
        assert!(entitlements.contains_key("com.apple.security.device.audio-input"));
        assert!(entitlements.contains_key("com.apple.security.device.camera"));
        // Not declared: nothing, even for an app that declares no capabilities.
        for capabilities in [
            None,
            Some(serde_json::json!({ "webview": { "hosts": ["*"] } })),
        ] {
            let config = AppConfig {
                capabilities,
                ..AppConfig::default()
            };
            let info = macos_info_plist("A", "com.a", "a", &config, false).unwrap();
            assert!(!info.contains_key("NSCameraUsageDescription"));
        }
    }

    #[test]
    fn apple_packages_declare_the_apps_languages() {
        let dir = std::env::temp_dir().join(format!("nsh-localizations-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("locales")).unwrap();
        fs::write(dir.join("App.tsx"), "").unwrap();
        fs::write(dir.join("locales/en.yml"), "hello: Hello\n").unwrap();
        fs::write(dir.join("locales/zh-CN.yml"), "hello: 你好\n").unwrap();
        let declared = |config: &AppConfig| {
            let macos = macos_info_plist("A", "com.a", "a", config, false).unwrap();
            let ios = info_plist("A", "com.a", "a", config, "iphoneos").unwrap();
            assert_eq!(
                macos.get("CFBundleLocalizations"),
                ios.get("CFBundleLocalizations")
            );
            macos.get("CFBundleLocalizations").map(|list| {
                list.as_array()
                    .unwrap()
                    .iter()
                    .filter_map(plist::Value::as_string)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
        };
        // The translations' languages, English (the development region) first...
        let config = read_config(&dir.join("App.tsx")).unwrap();
        assert_eq!(declared(&config).unwrap(), ["en", "zh-CN"]);
        // ...or exactly those `locales` lists, as the bundle carries them.
        fs::write(dir.join("nsh.json"), r#"{ "locales": ["ja", "zh-TW", 7] }"#).unwrap();
        let config = read_config(&dir.join("App.tsx")).unwrap();
        assert_eq!(declared(&config).unwrap(), ["en", "ja", "zh-TW"]);
        // An app without either declares nothing: English, as before.
        assert_eq!(declared(&AppConfig::default()), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn apps_claim_their_url_schemes_in_the_package() {
        let config: AppConfig =
            serde_json::from_str(r#"{ "schemes": ["MyApp", "myapp-dev"] }"#).unwrap();
        let schemes = config.url_schemes();
        assert_eq!(schemes, ["myapp", "myapp-dev"]);
        // The system opens the app for their links...
        let mut info = info_plist("A", "com.a", "a", &config, "iphoneos").unwrap();
        url_types(&mut info, "com.a", &schemes);
        let types = info["CFBundleURLTypes"].as_array().unwrap();
        let url_type = types[0].as_dictionary().unwrap();
        assert_eq!(url_type["CFBundleURLName"].as_string(), Some("com.a"));
        let listed: Vec<_> = url_type["CFBundleURLSchemes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(plist::Value::as_string)
            .collect();
        assert_eq!(listed, ["myapp", "myapp-dev"]);
        // ...and the runner lets them through.
        let json: serde_json::Value = serde_json::from_str(&app_json(
            serde_json::json!({ "id": "com.a" }),
            &schemes,
            None,
        ))
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "id": "com.a", "schemes": ["myapp", "myapp-dev"] })
        );
        // An app that claims none declares none.
        let mut info = macos_info_plist("A", "com.a", "a", &AppConfig::default(), false).unwrap();
        url_types(&mut info, "com.a", &[]);
        assert!(!info.contains_key("CFBundleURLTypes"));
        assert_eq!(
            app_json(serde_json::json!({ "id": "com.a" }), &[], None),
            r#"{"id":"com.a"}"#
        );
        // Schemes of the system and other apps are left out.
        let config: AppConfig =
            serde_json::from_str(r#"{ "schemes": ["https", "myapp"] }"#).unwrap();
        assert_eq!(config.url_schemes(), ["myapp"]);
    }

    #[test]
    fn desktop_packages_carry_the_main_windows_options() {
        let config: AppConfig = serde_json::from_str(
            r#"{ "appearance": "dark", "window": { "title": "Focus", "closeOnPress": false } }"#,
        )
        .unwrap();
        let info = desktop_app_json(&config, "Focus", "com.a", "1.0.0");
        assert_eq!(
            info,
            serde_json::json!({
                "name": "Focus",
                "id": "com.a",
                "version": "1.0.0",
                "appearance": "dark",
                "window": { "title": "Focus", "closeOnPress": false },
            })
        );
        // The runner opens the main window with them (`Bundle::read_trusted`).
        let window = nsh_core::desktop::MainWindowOptions::from_json(&info["window"]).unwrap();
        assert_eq!(window.attributes.title.as_deref(), Some("Focus"));
        // An app without them has none.
        let info = desktop_app_json(&AppConfig::default(), "A", "com.a", "1.0.0");
        assert!(info.get("window").is_none());
    }

    #[test]
    fn single_instance_apps_say_so_in_app_json() {
        let config: AppConfig = serde_json::from_str(r#"{ "singleInstance": true }"#).unwrap();
        let info = desktop_app_json(&config, "A", "com.a", "1.0.0");
        assert_eq!(info["singleInstance"], serde_json::json!(true));
        let info = desktop_app_json(&AppConfig::default(), "A", "com.a", "1.0.0");
        assert!(info.get("singleInstance").is_none());
    }

    #[test]
    fn apps_add_their_own_info_plist_keys() {
        let config: AppConfig = serde_json::from_value(serde_json::json!({
            "ios": {
                "infoPlist": {
                    "ITSAppUsesNonExemptEncryption": false,
                    "NSMicrophoneUsageDescription": "Voice notes.",
                    "UISupportedInterfaceOrientations": ["UIInterfaceOrientationPortrait"]
                }
            },
            "macos": {
                "infoPlist": { "LSApplicationCategoryType": "public.app-category.finance" }
            }
        }))
        .unwrap();
        let ios = info_plist("A", "com.a", "a", &config, "iphoneos").unwrap();
        assert_eq!(
            ios["ITSAppUsesNonExemptEncryption"],
            plist::Value::Boolean(false)
        );
        // The app's value replaces NSH's default.
        assert_eq!(
            ios["NSMicrophoneUsageDescription"],
            plist::Value::String("Voice notes.".into())
        );
        assert_eq!(
            ios["UISupportedInterfaceOrientations"],
            plist::Value::Array(vec!["UIInterfaceOrientationPortrait".into()])
        );
        // NSH's own keys stay.
        assert_eq!(
            ios["CFBundleIdentifier"],
            plist::Value::String("com.a".into())
        );
        assert!(!ios.contains_key("LSApplicationCategoryType"));
        let macos = macos_info_plist("A", "com.a", "a", &config, false).unwrap();
        assert_eq!(
            macos["LSApplicationCategoryType"],
            plist::Value::String("public.app-category.finance".into())
        );
        assert!(!macos.contains_key("ITSAppUsesNonExemptEncryption"));
        assert!(!macos.contains_key("LSUIElement"));
    }

    /// A package runs from the runtime's oldest system on, or from the
    /// later one the app names, which the iOS icon is compiled for too.
    #[test]
    fn apps_raise_the_minimum_system_version() {
        let string = |value: &str| plist::Value::String(value.into());
        let config = AppConfig::default();
        let macos = macos_info_plist("A", "com.a", "a", &config, false).unwrap();
        assert_eq!(macos["LSMinimumSystemVersion"], string(MACOS_MINIMUM));
        let ios = info_plist("A", "com.a", "a", &config, "iphoneos").unwrap();
        assert_eq!(ios["MinimumOSVersion"], string(IOS_MINIMUM));
        assert_eq!(minimum_os(&ios), IOS_MINIMUM);

        let config: AppConfig = serde_json::from_value(serde_json::json!({
            "ios": { "infoPlist": { "MinimumOSVersion": "16.4" } },
            "macos": { "infoPlist": { "LSMinimumSystemVersion": "15.2" } }
        }))
        .unwrap();
        let macos = macos_info_plist("A", "com.a", "a", &config, false).unwrap();
        assert_eq!(macos["LSMinimumSystemVersion"], string("15.2"));
        assert!(!macos.contains_key("MinimumOSVersion"));
        let ios = info_plist("A", "com.a", "a", &config, "iphonesimulator").unwrap();
        assert_eq!(ios["MinimumOSVersion"], string("16.4"));
        assert!(!ios.contains_key("LSMinimumSystemVersion"));
        assert_eq!(minimum_os(&ios), "16.4");

        // Reading nsh.json refuses one below the runtime's.
        let app = std::env::temp_dir().join(format!("nsh-minimum-{}", std::process::id()));
        fs::create_dir_all(&app).unwrap();
        fs::write(
            app.join("nsh.json"),
            serde_json::json!({ "macos": { "infoPlist": { "LSMinimumSystemVersion": "13.0" } } })
                .to_string(),
        )
        .unwrap();
        let error = read_config(&app.join("App.tsx")).unwrap_err().to_string();
        assert!(
            error.contains(
                "nsh.json macos.infoPlist.LSMinimumSystemVersion: \"13.0\" is below NSH's minimum"
            ),
            "{error}"
        );
        fs::write(
            app.join("nsh.json"),
            serde_json::json!({ "ios": { "infoPlist": { "MinimumOSVersion": 17 } } }).to_string(),
        )
        .unwrap();
        let error = read_config(&app.join("App.tsx")).unwrap_err().to_string();
        assert!(
            error.contains("nsh.json ios.infoPlist.MinimumOSVersion: 17 is no string"),
            "{error}"
        );
        fs::remove_dir_all(&app).unwrap();
    }

    /// A menu bar app's package launches as one (`LSUIElement`).
    #[test]
    fn menu_bar_apps_launch_as_one() {
        let config: AppConfig = serde_json::from_value(serde_json::json!({
            "macos": { "activationPolicy": "accessory" }
        }))
        .unwrap();
        let macos = macos_info_plist("A", "com.a", "a", &config, false).unwrap();
        assert_eq!(macos["LSUIElement"], plist::Value::Boolean(true));
        // iOS has no counterpart.
        let ios = info_plist("A", "com.a", "a", &config, "iphoneos").unwrap();
        assert!(!ios.contains_key("LSUIElement"));
    }

    #[test]
    fn nsh_json_icon_is_one_for_every_target_or_one_per_platform() {
        let dir = std::env::temp_dir().join(format!("nsh-icon-config-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let entry = dir.join("app.tsx");
        fs::write(dir.join("nsh.json"), r#"{ "icon": "icon.png" }"#).unwrap();
        let config = read_config(&entry).unwrap();
        for target in [
            PackageTarget::Macos,
            PackageTarget::Windows,
            PackageTarget::Web,
        ] {
            assert_eq!(config.icon(target), Some(dir.join("icon.png").as_path()));
        }
        fs::write(
            dir.join("nsh.json"),
            r#"{ "icon": { "macos": "mac.png", "windows": "win.png", "mac": "typo.png" } }"#,
        )
        .unwrap();
        let config = read_config(&entry).unwrap();
        assert_eq!(
            config.icon(PackageTarget::Macos),
            Some(dir.join("mac.png").as_path())
        );
        assert_eq!(
            config.icon(PackageTarget::Windows),
            Some(dir.join("win.png").as_path())
        );
        assert_eq!(config.icon(PackageTarget::Linux), None);
        assert_eq!(
            config.icon,
            Some(AppIcon::Platforms(
                [
                    ("macos".to_owned(), dir.join("mac.png")),
                    ("windows".to_owned(), dir.join("win.png")),
                ]
                .into()
            ))
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn nsh_json_ignores_keys_it_does_not_know() {
        let (config, unknown) = parse_config(
            r#"{
                "name": "Orders",
                "futureKey": { "anything": [1, 2] },
                "web": { "base": "/orders/", "futureWebKey": true },
                "updater": { "github": "acme/orders", "channel": "beta" },
                "android": { "targetSdk": 35, "futureAndroidKey": 1 },
                "tui": { "futureTuiKey": "x" },
                "ios": { "futureIosKey": {}, "activationPolicy": "accessory" }
            }"#,
        )
        .unwrap();
        assert_eq!(config.name.as_deref(), Some("Orders"));
        assert_eq!(config.web.base.as_deref(), Some("/orders/"));
        assert_eq!(
            config.updater.unwrap().github.as_deref(),
            Some("acme/orders")
        );
        assert_eq!(config.android.target_sdk, Some(35));
        let mut unknown = unknown;
        unknown.sort();
        assert_eq!(
            unknown,
            [
                "unknown key `android.futureAndroidKey`",
                "unknown key `futureKey`",
                "unknown key `ios.activationPolicy`",
                "unknown key `ios.futureIosKey`",
                "unknown key `tui.futureTuiKey`",
                "unknown key `updater.channel`",
                "unknown key `web.futureWebKey`",
            ]
        );
    }

    #[test]
    fn nsh_json_leaves_out_values_of_a_form_it_does_not_know() {
        let (config, ignored) = parse_config(
            r#"{
                "name": "Orders",
                "build": "7",
                "icon": ["a.png"],
                "schemes": ["orders", { "scheme": "x" }],
                "web": { "base": "/orders/", "connect": ["a.com", 1] },
                "android": { "targetSdk": "latest" },
                "macos": {
                    "activationPolicy": "dock",
                    "infoPlist": { "LSApplicationCategoryType": "public.app-category.finance" }
                }
            }"#,
        )
        .unwrap();
        assert_eq!(config.name.as_deref(), Some("Orders"));
        assert_eq!(config.build, None);
        assert_eq!(config.icon, None);
        assert_eq!(config.schemes, ["orders"]);
        assert_eq!(config.web.base.as_deref(), Some("/orders/"));
        assert_eq!(config.web.connect, ["a.com"]);
        assert_eq!(config.android.target_sdk, None);
        // The rest of a section applies without the value it left out.
        assert_eq!(config.macos.activation_policy, ActivationPolicy::Regular);
        assert!(
            config
                .macos
                .info_plist
                .contains_key("LSApplicationCategoryType")
        );
        let mut at: Vec<&str> = ignored
            .iter()
            .map(|m| m.split_once(':').unwrap().0)
            .collect();
        at.sort();
        assert_eq!(
            at,
            [
                "android.targetSdk",
                "build",
                "icon",
                "macos.activationPolicy",
                "schemes[1]",
                "web.connect[1]"
            ]
        );
        // Text that is no JSON object is still an error.
        assert!(parse_config("not json").is_err());
        assert!(parse_config("[]").is_err());
    }

    #[test]
    fn an_activation_policy_of_another_form_is_left_out() {
        // Objects are the form serde's own enums also take: one would pick
        // a policy, the other fail where the reader cannot leave it out.
        for policy in [
            serde_json::json!({ "accessory": null }),
            serde_json::json!({ "accessory": true }),
            serde_json::json!(1),
        ] {
            let text = serde_json::json!({
                "macos": {
                    "activationPolicy": policy,
                    "infoPlist": { "LSApplicationCategoryType": "public.app-category.finance" }
                }
            })
            .to_string();
            let (config, ignored) = parse_config(&text).unwrap();
            assert_eq!(
                config.macos.activation_policy,
                ActivationPolicy::Regular,
                "{policy}"
            );
            assert!(
                config
                    .macos
                    .info_plist
                    .contains_key("LSApplicationCategoryType"),
                "{policy}"
            );
            assert_eq!(ignored.len(), 1, "{policy}: {ignored:?}");
            assert!(
                ignored[0].starts_with("macos.activationPolicy: "),
                "{policy}: {ignored:?}"
            );
        }
    }

    #[test]
    fn reading_nsh_json_refuses_nshs_own_keys() {
        let app = std::env::temp_dir().join(format!("nsh-plist-{}", std::process::id()));
        fs::create_dir_all(&app).unwrap();
        fs::write(
            app.join("nsh.json"),
            serde_json::json!({ "macos": { "infoPlist": { "CFBundleVersion": "7" } } }).to_string(),
        )
        .unwrap();
        let error = read_config(&app.join("App.tsx")).unwrap_err().to_string();
        assert!(
            error.contains("macos.infoPlist: `CFBundleVersion` is set by NSH from `build`"),
            "{error}"
        );
        fs::remove_dir_all(&app).unwrap();
    }

    #[test]
    fn a_release_needs_the_apps_own_id() {
        let entry = Path::new("apps/Orders/App.tsx");
        let config = |id: Option<&str>| AppConfig {
            id: id.map(str::to_owned),
            ..AppConfig::default()
        };
        // Development makes one up from the name.
        assert_eq!(
            name_and_id(entry, &config(None)),
            ("Orders".to_owned(), "com.example.orders".to_owned())
        );
        // A release asks for it.
        let error = release_name_and_id(entry, &config(None))
            .unwrap_err()
            .to_string();
        assert!(error.contains("nsh.json needs an `id`"), "{error}");
        // The placeholder is only warned about.
        assert_eq!(
            release_name_and_id(entry, &config(Some("com.example.orders")))
                .unwrap()
                .1,
            "com.example.orders"
        );
        assert_eq!(
            release_name_and_id(entry, &config(Some("com.acme.orders"))).unwrap(),
            ("Orders".to_owned(), "com.acme.orders".to_owned())
        );
    }

    #[test]
    fn the_web_host_module_stays_in_the_app_directory() {
        let root = std::env::temp_dir().join(format!("nsh-web-host-{}", std::process::id()));
        let app = root.join("app");
        fs::create_dir_all(app.join("web")).unwrap();
        fs::write(app.join("web/host.js"), "").unwrap();
        fs::write(root.join("outside.js"), "").unwrap();
        let entry = app.join("App.tsx");
        let config = |host: &str| {
            fs::write(
                app.join("nsh.json"),
                serde_json::json!({ "web": { "host": host } }).to_string(),
            )
            .unwrap();
            read_config(&entry).unwrap().web.host.unwrap()
        };
        let inside = web_host_module(&entry, &config("web/host.js")).unwrap();
        assert_eq!(
            inside,
            dunce::canonicalize(app.join("web/host.js")).unwrap()
        );
        assert!(web_host_module(&entry, &config("./web/../web/host.js")).is_ok());
        let outside = root.join("outside.js");
        let refused = [config("../outside.js"), config(outside.to_str().unwrap())];
        #[cfg(unix)]
        let refused = {
            std::os::unix::fs::symlink(&outside, app.join("link.js")).unwrap();
            let mut refused = refused.to_vec();
            refused.push(config("link.js"));
            refused
        };
        for host in refused {
            let error = web_host_module(&entry, &host).unwrap_err().to_string();
            assert!(error.contains("inside the app's directory"), "{error}");
        }
        fs::remove_dir_all(&root).unwrap();
        // An entry named without its directory is in the working directory
        // (the crate's, under `cargo test`).
        assert!(web_host_module(Path::new("App.tsx"), Path::new("Cargo.toml")).is_ok());
    }

    /// App icons are drawn at 1024 pixels, which `sips` alone cannot
    /// convert.
    #[cfg(target_os = "macos")]
    #[test]
    fn converts_large_icons() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let dir = std::env::temp_dir().join(format!("nsh-icns-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let icns = dir.join("AppIcon.icns");
        macos_icns(&root.join("examples/gallery/icon.png"), &icns).unwrap();
        assert!(fs::metadata(&icns).unwrap().len() > 0);
        assert!(!dir.join("AppIcon.iconset").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn profiles_match_bundle_ids() {
        assert!(profile_allows(
            "ABCDE12345.com.example.app",
            "com.example.app"
        ));
        assert!(!profile_allows(
            "ABCDE12345.com.example.app",
            "com.example.other"
        ));
        assert!(profile_allows("ABCDE12345.*", "com.example.app"));
        assert!(profile_allows(
            "ABCDE12345.com.example.*",
            "com.example.app"
        ));
        assert!(!profile_allows("ABCDE12345.com.other.*", "com.example.app"));
        assert!(!profile_allows("", "com.example.app"));
    }

    #[test]
    fn wildcard_profiles_sign_the_bundle_id() {
        assert_eq!(
            signed_app_id("ABCDE12345.*", "com.example.app"),
            "ABCDE12345.com.example.app"
        );
        assert_eq!(
            signed_app_id("ABCDE12345.com.example.*", "com.example.app"),
            "ABCDE12345.com.example.app"
        );
        assert_eq!(
            signed_app_id("ABCDE12345.com.example.app", "com.example.app"),
            "ABCDE12345.com.example.app"
        );
    }

    #[test]
    fn gpui_points_to_this_oss_target() {
        use clap::ValueEnum as _;

        use super::PackageTarget;
        // Still parsed, so the refusal can say what to use instead.
        assert_eq!(
            PackageTarget::from_str("gpui", false).unwrap(),
            PackageTarget::Gpui
        );
        assert!(
            PackageTarget::Gpui
                .to_possible_value()
                .unwrap()
                .is_hide_set()
        );
        let expected = if cfg!(target_os = "macos") {
            Some(PackageTarget::Macos)
        } else if cfg!(windows) {
            Some(PackageTarget::Windows)
        } else if cfg!(target_os = "linux") {
            Some(PackageTarget::Linux)
        } else {
            None
        };
        assert_eq!(PackageTarget::desktop(), expected);
    }

    #[test]
    fn desktop_entries_match_windows_by_the_app_id() {
        assert_eq!(
            desktop_entry("Counter", "com.example.counter", "Counter", true, &[], &[]),
            "[Desktop Entry]\nType=Application\nName=Counter\nExec=Counter\n\
             Icon=com.example.counter\nStartupWMClass=com.example.counter\nTerminal=false\n\
             Categories=Utility;\n"
        );
        assert!(!desktop_entry("A", "com.example.a", "A", false, &[], &[]).contains("Icon="));
    }

    #[test]
    fn desktop_entries_open_the_apps_schemes() {
        let entry = desktop_entry(
            "A",
            "com.example.a",
            "A",
            false,
            &["a".into(), "b2".into()],
            &[],
        );
        assert!(entry.contains("Exec=A %u\n"));
        assert!(entry.contains("MimeType=x-scheme-handler/a;x-scheme-handler/b2;\n"));
    }

    #[test]
    fn apps_declare_the_file_types_they_open() {
        let config: AppConfig = serde_json::from_str(
            r#"{ "fileTypes": [
                { "name": "Video", "extensions": ["mp4"], "mimeTypes": ["video/mp4"] },
                { "name": "Notes", "extensions": ["note"], "role": "editor" },
                { "name": "Broken" }
            ] }"#,
        )
        .unwrap();
        // Linux: the desktop entry lists their MIME types and takes files.
        let entry = desktop_entry(
            "A",
            "com.a",
            "A",
            false,
            &["a".into()],
            &file_mime_types(&config.file_types()),
        );
        assert!(entry.contains("Exec=A %U\n"));
        assert!(entry.contains("MimeType=x-scheme-handler/a;video/mp4;\n"));
        // Apple: `CFBundleDocumentTypes`.
        let mut info = plist::Dictionary::new();
        document_types(&mut info, &config.file_types());
        let types = info["CFBundleDocumentTypes"].as_array().unwrap();
        assert_eq!(types.len(), 2);
        let video = types[0].as_dictionary().unwrap();
        assert_eq!(video["CFBundleTypeName"].as_string(), Some("Video"));
        assert_eq!(video["CFBundleTypeRole"].as_string(), Some("Viewer"));
        assert_eq!(
            video["CFBundleTypeExtensions"].as_array().unwrap()[0].as_string(),
            Some("mp4")
        );
        let notes = types[1].as_dictionary().unwrap();
        assert_eq!(notes["CFBundleTypeRole"].as_string(), Some("Editor"));
        // The runners read them from `app.json`.
        let app = desktop_app_json(&config, "A", "com.a", "1.0.0");
        assert_eq!(app["fileTypes"].as_array().unwrap().len(), 2);
        assert!(nsh_core::file_type::declares_file_types(&app));
        let none = desktop_app_json(&AppConfig::default(), "A", "com.a", "1.0.0");
        assert!(none.get("fileTypes").is_none());
    }

    // `ditto` is macOS's.
    #[cfg(target_os = "macos")]
    #[test]
    fn ipa_holds_the_app_under_payload() {
        let dir = std::env::temp_dir().join(format!("nsh-ipa-{}", std::process::id()));
        let app = dir.join("Demo.app");
        fs::create_dir_all(app.join("nsh")).unwrap();
        fs::write(app.join("Demo"), b"binary").unwrap();
        fs::write(app.join("nsh/bundle.nshc"), b"code").unwrap();
        let ipa = dir.join("Demo.ipa");
        make_ipa(&app, &ipa).unwrap();
        let listing = Command::new("unzip").arg("-Z1").arg(&ipa).output().unwrap();
        let listing = String::from_utf8(listing.stdout).unwrap();
        let mut entries: Vec<&str> = listing.lines().collect();
        entries.sort_unstable();
        assert_eq!(
            entries,
            [
                "Payload/",
                "Payload/Demo.app/",
                "Payload/Demo.app/Demo",
                "Payload/Demo.app/nsh/",
                "Payload/Demo.app/nsh/bundle.nshc"
            ]
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
