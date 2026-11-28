//! `nsh package`: builds an installable app from the prebuilt runtime, the
//! app bundle and its assets. Needs no Rust; iOS packaging uses Xcode's
//! command line tools (`codesign`, and `actool` for icons), macOS packaging
//! `codesign` and `sips`, Linux packaging `tar`; Windows packaging needs
//! nothing (`windows.rs`), nor does the web's (`web.rs`). Each desktop OS
//! packages with its native backend's runner; GPUI is the backend for
//! embedding in GPUI apps and has no package of its own.

use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use anyhow::{Context as _, bail};
use serde::Deserialize;

use crate::{
    android,
    apple::{
        ActivationPolicy, AppleConfig, ApplePlatform, IOS_MINIMUM, MACOS_MINIMUM, MacosConfig,
    },
    provisioning::Profile,
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
    /// Linux (GTK): a directory with the runner, the bundle, a `.desktop`
    /// file and AppStream metainfo, and the same as a `.tar.gz`; with
    /// `--format appimage` also an AppImage, with `--format flatpak` a
    /// Flatpak manifest (and bundle, with `flatpak-builder`).
    Linux,
    /// macOS (AppKit): a signed `.app` (ad hoc without `--sign`).
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
    /// The platform [`crate::module_meta`] reads the app's dependency
    /// graph for, and the Rust targets it reads it for: iOS, macOS and
    /// Android, where crates declare package entries. A macOS package is
    /// read for each architecture it is built for (`arch`; `None`: the one
    /// Cargo builds for with no `--target`, [`Arch::native`]), so a crate
    /// only another architecture links counts.
    fn module_meta_triples(
        self,
        arch: Option<Arch>,
    ) -> Option<(&'static [&'static str], crate::module_meta::Platform)> {
        use crate::module_meta::Platform;
        match self {
            PackageTarget::Ios => Some((&["aarch64-apple-ios"], Platform::Ios)),
            PackageTarget::IosSimulator => Some((&[runtime::IOS_SIMULATOR_TRIPLE], Platform::Ios)),
            PackageTarget::Macos => Some((
                arch.unwrap_or_else(Arch::native).macos_triples(),
                Platform::Macos,
            )),
            PackageTarget::Android => Some((&["aarch64-linux-android"], Platform::Android)),
            _ => None,
        }
    }

    /// The target a crate's files are scoped to
    /// (`Registry::assets_for`); `None` for the removed GPUI packages.
    pub(crate) fn asset_target(self) -> Option<nsh_core::platform::Os> {
        use nsh_core::platform::Os;
        match self {
            PackageTarget::Ios | PackageTarget::IosSimulator => Some(Os::Ios),
            PackageTarget::Android => Some(Os::Android),
            PackageTarget::Linux => Some(Os::Linux),
            PackageTarget::Macos => Some(Os::MacOs),
            PackageTarget::Windows => Some(Os::Windows),
            PackageTarget::Web => Some(Os::Web),
            PackageTarget::Gpui => None,
        }
    }

    /// This machine's desktop target (`None` off macOS, Windows and
    /// Linux): where `--target gpui` points.
    pub(crate) fn desktop() -> Option<PackageTarget> {
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
    /// The processor a package with no `--arch` is built for: the one a
    /// Cargo build with no `--target` is for, the host of the toolchain
    /// ([`runtime::rustc_host`]), which is the Mac's own even when this nsh
    /// runs translated (an Intel nsh under Rosetta); without a toolchain,
    /// this nsh's own, whose prebuilt runner the package then has.
    fn native() -> Self {
        Self::of_host(runtime::rustc_host(None).as_deref())
    }

    /// The processor of the Rust target `host` (`None`: unknown, this
    /// nsh's own).
    fn of_host(host: Option<&str>) -> Self {
        match host.and_then(|host| host.split('-').next()) {
            Some("aarch64") => Arch::Arm64,
            Some("x86_64") => Arch::X86_64,
            _ if cfg!(target_arch = "aarch64") => Arch::Arm64,
            _ => Arch::X86_64,
        }
    }

    /// The Rust targets of its builds, one per architecture.
    fn macos_triples(self) -> &'static [&'static str] {
        match self {
            Arch::Arm64 => &[MACOS_ARM64],
            Arch::X86_64 => &[MACOS_X86_64],
            Arch::Universal => &[MACOS_ARM64, MACOS_X86_64],
        }
    }
}

/// The architecture of a macOS `triple` as `lipo` names it.
fn lipo_arch(triple: &str) -> &str {
    match triple.split('-').next() {
        Some("aarch64") => "arm64",
        Some(arch) => arch,
        None => triple,
    }
}

/// The updater's names of the platforms a macOS executable of the
/// architectures `archs` (as `lipo` names them) runs on, which its
/// package's update archives are named after: a universal package is the
/// archive of either.
fn macos_update_platforms(archs: &[String]) -> Vec<String> {
    let mut platforms: Vec<String> = archs
        .iter()
        .map(|arch| match arch.as_str() {
            "arm64" => "macos-aarch64".to_owned(),
            arch => format!("macos-{arch}"),
        })
        .collect();
    platforms.sort();
    platforms.dedup();
    platforms
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
    /// The NSH versions the app is written for (`">=0.5"`), which every
    /// command checks this CLI against first ([`check_nsh_version`]).
    #[serde(default, rename = "nsh")]
    _nsh: Option<serde_json::Value>,
    /// Read and checked by the bundler.
    #[serde(default, rename = "tailwind")]
    _tailwind: Option<serde_json::Value>,
    /// Read and checked by the bundler; packages read only what the
    /// system must be told ahead (`webview.media`'s usage descriptions,
    /// `notifications`).
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
    /// The named time zones whose rules the app ships (checked by the
    /// bundler).
    #[serde(default, rename = "timeZones")]
    _time_zones: Option<serde_json::Value>,
    /// The store listing, read by `nsh publish <store>` (`store.rs`).
    #[serde(default)]
    pub(crate) store: Option<serde_json::Value>,
    /// The locales the app ships (`locales`, else its translations'
    /// languages: `nsh_i18n::app_locales`), which Apple packages declare
    /// (`CFBundleLocalizations`) so that system UI shows in them.
    #[serde(skip)]
    pub(crate) localizations: Vec<String>,
    /// Read and checked by the bundler.
    #[serde(default, rename = "resolve")]
    _resolve: Option<serde_json::Value>,
    /// The entry module, relative to `nsh.json` (`"app/App.tsx"`; `App.tsx`
    /// beside it by default): read by `entry::resolve`, checked by
    /// `nsh_bundler::app_dir::config_entry`.
    #[serde(default, rename = "entry")]
    _entry: Option<String>,
    /// The app's Rust crate: its builds are the app's own (`rust_app.rs`).
    #[serde(default, rename = "rust")]
    _rust: Option<serde_json::Value>,
    /// The app's nshm, resolved and linked by `nshm/`.
    #[serde(default, rename = "dependencies")]
    _dependencies: Option<serde_json::Value>,
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
    /// What the development watcher skips.
    #[serde(default)]
    pub(crate) watch: WatchConfig,
    /// URL schemes that open the app (`"myapp"`: `myapp://...`), which
    /// packages register with the system; the app hears them through
    /// `UrlScheme.on("open", ...)`. [`read_config`] checks them and lowers
    /// their case ([`AppConfig::app_links`]).
    #[serde(default)]
    pub(crate) schemes: Vec<String>,
    /// Web links that open the app (`[{ "host": "example.com", "paths":
    /// ["/orders/*"] }]`: Universal Links on iOS, App Links on Android),
    /// which packages claim with the system; the app hears them through
    /// `UrlScheme.on("open", ...)` as it does its schemes' links.
    /// [`read_config`] checks them, and leaves out (warning) each one it
    /// cannot read whole ([`AppConfig::app_links`]).
    #[serde(default)]
    pub(crate) links: Option<serde_json::Value>,
    /// The app runs once (`"singleInstance": true`, Windows and Linux): a
    /// second launch hands its arguments and working directory to the
    /// running instance (`Application.on("secondInstance", ...)`) and exits
    /// before it opens a window. Written into `app.json`, where the
    /// release runner reads it; macOS runs one instance of an app already.
    #[serde(default)]
    pub(crate) single_instance: bool,
    /// The packaged app's data directory (`"dataDir": "${homeDir}/.myapp"`),
    /// in place of the one under its id in the system's directory for apps'
    /// data: its storage (`nsh/storage`), logs, `process.dataDir` and
    /// `${dataDir}`. An absolute path, or `${homeDir}` followed by one under
    /// the user's home ([`nsh_engine::resolve_data_dir`]); it stays put when
    /// the app's id changes. Written into `app.json`, where the desktop
    /// release runners (macOS, Windows, Linux) read it; [`read_config`]
    /// drops a value they would refuse.
    pub(crate) data_dir: Option<String>,
    /// The directory of the packaged app's log files (`"logDir":
    /// "${homeDir}/.myapp/logs/ui"`), in place of `logs` in its data
    /// directory. Spelled and checked like [`Self::data_dir`]; written into
    /// `app.json` for the desktop release runners, and [`read_config`] drops
    /// a value they would refuse.
    pub(crate) log_dir: Option<String>,
    /// Gives the app's address (`UrlScheme.setUrl`) to the system on iOS
    /// and macOS (`"handoff": true`), so Handoff continues it on the user's
    /// other devices. iOS and macOS
    /// packages declare `<id>.url` in `NSUserActivityTypes`
    /// ([`activity_types`]), which the release runners read.
    #[serde(default)]
    pub(crate) handoff: bool,
    /// Native features a package always includes (`"features": ["plot"]`),
    /// which nothing in the bundle shows it uses: what its Rust code or a
    /// computed import needs (`native_features`).
    #[serde(default)]
    pub(crate) features: Vec<String>,
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
    /// The app's lifecycle (`"application"`, checked by [`read_config`]):
    /// `{ "quitMode": "platform" | "lastWindowClosed" | "explicit" }`.
    /// Written into `app.json` and the dev server's app info, where the
    /// engine sets the quit mode before the app's code runs.
    pub(crate) application: Option<serde_json::Value>,
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
    /// What Linux packages set (`"linux"`): the Flatpak manifest's runtime
    /// and permissions.
    #[serde(default)]
    pub(crate) linux: crate::linux_store::LinuxConfig,
    /// The identity of Windows' MSIX packages (`msix.rs`) and the app's
    /// Microsoft Store id (`nsh publish windows`).
    #[serde(default)]
    pub(crate) windows: crate::msix::WindowsConfig,
}

/// The file name of a desktop package's executable: the app's name
/// without what file names and `Exec=` lines trip on.
pub(crate) fn executable_name(name: &str) -> String {
    let executable: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if executable.is_empty() {
        "App".to_owned()
    } else {
        executable
    }
}

/// The directory of the app's `nsh.json`.
pub(crate) fn config_dir(entry: &Path) -> PathBuf {
    nsh_bundler::app_dir::config_dir_of(entry)
}

/// The app's Linux `.desktop` entry, with its store categories.
pub(crate) fn linux_desktop_entry(
    config: &AppConfig,
    store: &crate::linux_store::StoreConfig,
    name: &str,
    id: &str,
    executable: &str,
    icon: bool,
) -> String {
    desktop_entry(
        name,
        id,
        executable,
        icon,
        &config.schemes,
        &file_mime_types(&config.file_types()),
    )
    .replace(
        "Categories=Utility;",
        &crate::linux_store::desktop_categories(store),
    )
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
    /// Java libraries the app ships (`"libraries"`: jar, AAR and dex files,
    /// relative to `nsh.json`), before the ones its crates list
    /// ([`crate::module_meta`]): packaged after the runtime's
    /// `classes.dex`, so the app's class loader finds their classes as it
    /// finds NSH's. An AAR listed here is the version of its library the
    /// package takes, whichever its crates list.
    #[serde(default)]
    pub(crate) libraries: Vec<crate::android::Library>,
    /// The values of the placeholders (`${name}`) the libraries' manifests
    /// and the crates' manifest entries use: a service's key, for one.
    /// Only the app sets them; `${applicationId}` is its package.
    #[serde(default)]
    pub(crate) manifest_placeholders: std::collections::BTreeMap<String, String>,
    /// Permissions the manifest declares besides the ones NSH declares
    /// itself (`<uses-permission>`): a bare name (`ACCESS_NETWORK_STATE`)
    /// is Android's, `android.permission.<name>`; a dotted one is written
    /// as it is. Declaring a runtime permission does not grant it.
    #[serde(default)]
    pub(crate) permissions: Vec<String>,
    /// Elements of the manifest's `<queries>`: `<intent>`, `<package>` and
    /// `<provider>`, one balanced element each. The app's crates add theirs
    /// after the app's ([`crate::module_meta`]).
    #[serde(default)]
    pub(crate) queries: Vec<String>,
    /// Elements of the manifest's `<application>`: `<service>`,
    /// `<receiver>`, `<provider>`, `<activity>` and `<meta-data>`, one
    /// balanced element each; `${applicationId}` in them is the app's
    /// package. The app's crates add theirs after the app's
    /// ([`crate::module_meta`]).
    #[serde(default)]
    pub(crate) application: Vec<String>,
    /// What the app's window shows from the tap on its icon until its first
    /// frame, the same keys as `ios.launchScreen`: the window's background
    /// and, on Android 12+, the splash screen's color and image. Without it
    /// the platform theme's background and the launcher icon.
    pub(crate) launch_screen: Option<crate::apple::LaunchScreen>,
}

impl AndroidConfig {
    /// `permissions`, checked and spelled out in full.
    pub(crate) fn permissions(&self) -> anyhow::Result<Vec<String>> {
        for name in &self.permissions {
            if let Some(warning) = lower_case_android_warning(name, "nsh.json android.permissions")
            {
                ui::warn(warning);
            }
        }
        self.permissions
            .iter()
            .map(|name| android_permission(name, "nsh.json android.permissions"))
            .collect()
    }

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

/// Whether `name` is a bare name (one of Android's own) with a lower case
/// letter, which no permission of Android's has: most likely a typo.
fn lower_case_android_name(name: &str) -> bool {
    !name.contains('.') && name.chars().any(|c| c.is_ascii_lowercase())
}

/// The warning about the `android.permissions` entry `name` written at
/// `at`, when it is a bare name in lower case.
pub(crate) fn lower_case_android_warning(name: &str, at: &str) -> Option<String> {
    lower_case_android_name(name).then(|| {
        format!(
            "{at}: `{name}` is not upper case, as Android's own permission names are \
             (`ACCESS_NETWORK_STATE`): Android ignores a name it does not know"
        )
    })
}

/// An `android.permissions` entry in full: a bare name is one of
/// Android's own (`android.permission.<name>`). Each part of the name is a
/// Java identifier, so nothing but the name reaches the manifest. `at`
/// names where the entry was written, for the error.
pub(crate) fn android_permission(name: &str, at: &str) -> anyhow::Result<String> {
    let identifier = |part: &str| {
        let mut chars = part.chars();
        chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    };
    if !name.split('.').all(identifier) {
        bail!(
            "{at}: `{name}` is not a permission name \
             (`ACCESS_NETWORK_STATE`, or `com.example.permission.NAME`)"
        );
    }
    Ok(if name.contains('.') {
        name.to_owned()
    } else {
        format!("android.permission.{name}")
    })
}

/// `nsh.json` `"tui"`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TuiConfig {
    /// Width and height of one Cell in points (`8x16` by default).
    pub(crate) points_per_cell: Option<String>,
}

/// `nsh.json` `"watch"`: what `nsh run` and `nsh dev` leave out of the
/// watcher ([`crate::dev`], [`crate::rust_app`]).
#[derive(Debug, Default, Deserialize)]
pub(crate) struct WatchConfig {
    /// Directories whose file events the watcher skips: paths relative to
    /// `nsh.json` (`"vendor"`, `"third/jpeg-turbo"`), absolute ones as they
    /// are. One inside the watch (the app's directory, a crate's) that
    /// holds generated code or another checkout is the usual one.
    #[serde(default)]
    pub(crate) ignore: Vec<String>,
}

impl AppConfig {
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

    /// The links the app claims: its URL schemes (`"schemes": [...]`)
    /// and web links (`"links": [...]`), checked; those it cannot claim are
    /// left out ([`read_config`] warns of them).
    pub(crate) fn app_links(&self) -> nsh_core::url_scheme::AppLinks {
        let mut config = serde_json::json!({ "schemes": self.schemes });
        if let Some(links) = &self.links {
            config["links"] = links.clone();
        }
        nsh_core::url_scheme::AppLinks::from_json(&config)
    }

    /// Claims the web links' hosts in iOS `entitlements`:
    /// `applinks:<host>` in `com.apple.developer.associated-domains`, after
    /// what `ios.entitlements` lists there. Their paths are the host's to
    /// confirm (`apple-app-site-association`); the core keeps only the
    /// claimed ones.
    pub(crate) fn add_links_to_entitlements(
        &self,
        entitlements: &mut plist::Dictionary,
    ) -> anyhow::Result<()> {
        const KEY: &str = "com.apple.developer.associated-domains";
        let links = self.app_links();
        if links.web().is_empty() {
            return Ok(());
        }
        let mut entries = match entitlements.remove(KEY) {
            Some(plist::Value::Array(entries)) => entries,
            None => Vec::new(),
            Some(_) => anyhow::bail!(
                "ios.entitlements: `{KEY}` is not an array of domains (`[\"applinks:example.com\"]`), so the web links of nsh.json `links` cannot be added to it"
            ),
        };
        for link in links.web() {
            let entry = plist::Value::String(format!("applinks:{}", link.host()));
            if !entries.contains(&entry) {
                entries.push(entry);
            }
        }
        entitlements.insert(KEY.into(), plist::Value::Array(entries));
        Ok(())
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

    /// Adds `"dataDir"` to a package's `app.json` `info`, where the desktop
    /// release runners read it (their `setup`).
    pub(crate) fn add_data_dir_to_app_json(&self, info: &mut serde_json::Value) {
        if let Some(dir) = &self.data_dir {
            info["dataDir"] = dir.as_str().into();
        }
        if let Some(dir) = &self.log_dir {
            info["logDir"] = dir.as_str().into();
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

    /// Adds what the system shows when the app's web pages first ask for
    /// the microphone or the camera (`webview.media`), which it requires
    /// (it ends an app that asks without them). The app's `infoPlist` may
    /// word them its own way. Native modules that use them (`nsh-extra`'s
    /// `speech`) declare theirs in their crate's metadata
    /// ([`crate::module_meta`]).
    fn usage_descriptions(&self, info: &mut plist::Dictionary) {
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
/// links it claims (`"schemes"`, `"links"`), which its runner hands the
/// core so other links are dropped (`nsh_engine::Bundle::links`).
pub(crate) fn app_json(
    mut info: serde_json::Value,
    links: &nsh_core::url_scheme::AppLinks,
    window: Option<&serde_json::Value>,
) -> String {
    if let Some(info) = info.as_object_mut() {
        links.add_to_json(info);
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
    if let Some(application) = &config.application {
        info["application"] = application.clone();
    }
    if config.single_instance {
        info["singleInstance"] = true.into();
    }
    config.add_file_types_to_app_json(&mut info);
    config.add_data_dir_to_app_json(&mut info);
    info
}

/// `nsh.json` `"window"` of the app at `entry` (checked), as JSON: the
/// dev server's app info carries it.
pub(crate) fn window_json(entry: &Path) -> Option<String> {
    let entry = dunce::canonicalize(entry).ok()?;
    read_config(&entry).ok()?.window.map(|w| w.to_string())
}

/// `nsh.json` `"application"` of the app at `entry` (checked), as JSON: the
/// dev server's app info carries it.
pub(crate) fn application_json(entry: &Path) -> Option<String> {
    let entry = dunce::canonicalize(entry).ok()?;
    read_config(&entry).ok()?.application.map(|a| a.to_string())
}

/// Says, once per app, that `nsh.json` `window.defaultVisible: false` has no
/// effect in window model v2: the app host never shows, and the app opens the
/// windows it declares with `<Window>`.
pub(crate) fn note_hidden_main_window(entry: &Path) {
    static NOTED: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());
    let Ok(entry) = dunce::canonicalize(entry) else {
        return;
    };
    let hidden = read_config(&entry)
        .ok()
        .and_then(|config| config.window)
        .and_then(|window| window.get("defaultVisible").and_then(|v| v.as_bool()))
        == Some(false);
    let mut noted = NOTED.lock().unwrap_or_else(|e| e.into_inner());
    if hidden && !noted.contains(&entry) {
        noted.push(entry);
        crate::ui::note(
            "nsh.json window.defaultVisible has no effect in window model v2: the app host never shows; the app opens its <Window> when ready",
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

/// Declares the activity type of the app's addresses that are no web pages
/// (`<id>.url`, `nsh_platform_apple::handoff`) in an Apple `Info.plist`
/// (`NSUserActivityTypes`, after those `infoPlist` gives) for `nsh.json`
/// `"handoff": true`.
fn activity_types(info: &mut plist::Dictionary, id: &str, handoff: bool) {
    use plist::Value;
    if !handoff {
        return;
    }
    let kind = Value::String(format!("{id}.url"));
    match info.get_mut("NSUserActivityTypes") {
        Some(Value::Array(types)) if types.contains(&kind) => {}
        Some(Value::Array(types)) => types.push(kind),
        _ => {
            info.insert("NSUserActivityTypes".into(), Value::Array(vec![kind]));
        }
    }
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
    /// Code signing identity (iOS device builds and macOS packages).
    pub(crate) sign: Option<&'a str>,
    /// Provisioning profiles (device builds): the app's, and one for each of
    /// its app extensions (`ios.extensions`), found by bundle identifier.
    pub(crate) profiles: &'a [PathBuf],
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
    /// With `run`: the simulator (name or UDID, `ios-simulator`) or the
    /// Android device (serial) to run in; `None`: the default one
    /// ([`crate::run::simulator`], [`crate::android::device`]).
    pub(crate) device: Option<&'a str>,
    /// The web: the URL the site's files are served from (`--asset-url`).
    pub(crate) asset_url: Option<&'a str>,
    /// The web: package the shared runtime (`--shared-runtime`).
    pub(crate) shared_runtime: bool,
    /// A development build for `nsh run`. Android: the APK is debuggable,
    /// so `AppActivity` takes the environment `nsh run` passes it.
    pub(crate) development: bool,
}

/// `nsh.json` `"icon"`: one PNG for every target, or one per platform
/// (`{ "macos": "icon-mac.png", "windows": "icon-win.png" }`) since their
/// conventions differ (macOS draws its artwork inset on a transparent
/// canvas, Windows edge to edge). A platform left out gets no icon.
/// Android's may also be an adaptive icon ([`PlatformIcon::Adaptive`]).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub(crate) enum AppIcon {
    /// The icon of every target.
    All(PathBuf),
    /// The icons by platform: `macos`, `windows`, `linux`, `ios`, `android`,
    /// `web` ([`AppIcon::PLATFORMS`]).
    Platforms(std::collections::BTreeMap<String, PlatformIcon>),
}

/// One platform's icon in [`AppIcon::Platforms`].
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(from = "serde_json::Value")]
pub(crate) enum PlatformIcon {
    /// A PNG.
    Image(PathBuf),
    /// Android: the layers of an adaptive icon (`{ "foreground": ..,
    /// "background": .., "monochrome": .. }`).
    Adaptive(android::AdaptiveIcon),
    /// A value that is neither, with why: [`read_config`] warns of it and
    /// leaves the platform without an icon, as it does an adaptive icon
    /// given for another platform than Android. Read here rather than
    /// failing, which would drop the whole `icon`.
    Invalid(String),
}

impl From<serde_json::Value> for PlatformIcon {
    fn from(value: serde_json::Value) -> Self {
        match value {
            serde_json::Value::String(path) => PlatformIcon::Image(path.into()),
            serde_json::Value::Object(_) => {
                let mut unknown = Vec::new();
                match serde_ignored::deserialize::<_, _, android::AdaptiveIcon>(&value, |key| {
                    unknown.push(key.to_string())
                }) {
                    Ok(icon) => PlatformIcon::Adaptive(android::AdaptiveIcon { unknown, ..icon }),
                    Err(e) => PlatformIcon::Invalid(e.to_string()),
                }
            }
            _ => PlatformIcon::Invalid(
                "expected the path of a PNG, or (Android) an adaptive icon's layers".into(),
            ),
        }
    }
}

impl AppIcon {
    /// The keys of [`AppIcon::Platforms`].
    const PLATFORMS: [&str; 6] = ["macos", "windows", "linux", "ios", "android", "web"];

    /// The icon of `target`'s platform.
    pub(crate) fn of(&self, target: PackageTarget) -> Option<android::Icon<'_>> {
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
            AppIcon::All(icon) => Some(android::Icon::Image(icon)),
            AppIcon::Platforms(icons) => match icons.get(platform)? {
                PlatformIcon::Image(icon) => Some(android::Icon::Image(icon)),
                PlatformIcon::Adaptive(icon) => Some(android::Icon::Adaptive(icon)),
                PlatformIcon::Invalid(_) => None,
            },
        }
    }
}

impl AppConfig {
    /// The app's icon for `target` (`nsh.json` `"icon"`, or `--icon`): a
    /// PNG. Android's may be adaptive instead ([`AppConfig::android_icon`]).
    pub(crate) fn icon(&self, target: PackageTarget) -> Option<&Path> {
        match self.icon.as_ref()?.of(target)? {
            android::Icon::Image(icon) => Some(icon),
            android::Icon::Adaptive(_) => None,
        }
    }

    /// The app's Android launcher icon: a PNG or an adaptive icon.
    pub(crate) fn android_icon(&self) -> Option<android::Icon<'_>> {
        self.icon.as_ref()?.of(PackageTarget::Android)
    }

    /// The macOS development host's arguments for the app (`nsh run`,
    /// `nsh test`): its activation policy ([`MacosConfig::host_args`]) and
    /// its icon. The host is an executable without an app bundle around it,
    /// so the Dock and the app switcher show the app's icon only when the
    /// host is given it.
    pub(crate) fn macos_host_args(&self) -> Vec<OsString> {
        let mut args: Vec<OsString> = self.macos.host_args().into_iter().map(Into::into).collect();
        if let Some(icon) = self.icon(PackageTarget::Macos) {
            args.extend(["--icon".into(), icon.into()]);
        }
        args
    }
}

/// Fails when the `nsh.json` of `entry` asks for NSH versions
/// (`"nsh": ">=0.5"`) this CLI is not one of, with one message that names
/// both, before a build fails on what the other version lacks.
pub(crate) fn check_nsh_version(entry: &Path) -> anyhow::Result<()> {
    let path = nsh_bundler::app_dir::config_dir_of(entry).join("nsh.json");
    let Ok(text) = nsh_bundler::app_dir::read(&path) else {
        return Ok(());
    };
    // A file that does not read is reported by the command itself.
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Ok(());
    };
    nsh_version_error(&value["nsh"], env!("CARGO_PKG_VERSION"))
        .map_or(Ok(()), |e| Err(anyhow::anyhow!("{}: {e}", path.display())))
}

/// Why `required` (`nsh.json` `"nsh"`) does not take NSH `version`, if it
/// does not.
fn nsh_version_error(required: &serde_json::Value, version: &str) -> Option<String> {
    if required.is_null() {
        return None;
    }
    let Some(text) = required.as_str() else {
        return Some("\"nsh\" must be a version requirement string, e.g. \">=0.5\"".into());
    };
    let req = match semver::VersionReq::parse(text) {
        Ok(req) => req,
        Err(e) => {
            return Some(format!(
                "\"nsh\": invalid version requirement {text:?}: {e}"
            ));
        }
    };
    // A nightly or other prerelease counts as its release.
    let mut this = semver::Version::parse(version).ok()?;
    this.pre = semver::Prerelease::EMPTY;
    (!req.matches(&this)).then(|| format!("this app requires nsh {text}; this is nsh {version}"))
}

/// Reads the `nsh.json` of `entry`, if any: beside it, or the one above
/// that names it (`"entry"`, `nsh_bundler::app_dir::config_dir_of`);
/// relative paths become absolute, from its directory.
pub(crate) fn read_config(entry: &Path) -> anyhow::Result<AppConfig> {
    let config_dir = nsh_bundler::app_dir::config_dir_of(entry);
    let dir = config_dir.as_path();
    let path = dir.join("nsh.json");
    let Ok(text) = nsh_bundler::app_dir::read(&path) else {
        return Ok(AppConfig {
            localizations: app_localizations(dir, None),
            ..AppConfig::default()
        });
    };
    let (mut config, mut ignored) =
        parse_config(&text).with_context(|| format!("invalid {}", path.display()))?;
    crate::module_meta::keep_app_android_elements(
        &mut config.android.queries,
        &mut config.android.application,
        &mut ignored,
    );
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
    if let Some(links) = &config.links {
        let (_, links_ignored) = nsh_core::url_scheme::AppLinks::from_json_lenient(
            &serde_json::json!({ "links": links }),
        );
        ignored.extend(links_ignored);
    }
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
    if let Some(application) = &config.application
        && let Err(e) = nsh_core::desktop::ApplicationOptions::from_json(application)
    {
        ignored.push(format!("application: {e}"));
        config.application = None;
    }
    // The runner resolves it again on the user's machine, with their home.
    if let Some(dir) = &config.data_dir
        && nsh_engine::resolve_data_dir(dir).is_none()
    {
        ignored.push(format!(
            "dataDir: `{dir}` is neither an absolute path nor `${{homeDir}}/...` (no `..`, no other `${{...}}`)"
        ));
        config.data_dir = None;
    }
    if let Some(dir) = &config.log_dir
        && nsh_engine::resolve_data_dir(dir).is_none()
    {
        ignored.push(format!(
            "logDir: `{dir}` is neither an absolute path nor `${{homeDir}}/...` (no `..`, no other `${{...}}`)"
        ));
        config.log_dir = None;
    }
    for library in &mut config.android.libraries {
        library.path = dir.join(&library.path);
    }
    config.ios.extensions = crate::app_extensions::read(
        std::mem::take(&mut config.ios.extensions),
        dir,
        ApplePlatform::Ios,
        &mut ignored,
    );
    config.macos.extensions = crate::app_extensions::read(
        std::mem::take(&mut config.macos.extensions),
        dir,
        ApplePlatform::Macos,
        &mut ignored,
    );
    config.icon = match config.icon {
        Some(AppIcon::All(icon)) => Some(AppIcon::All(dir.join(icon))),
        Some(AppIcon::Platforms(icons)) => Some(AppIcon::Platforms(
            icons
                .into_iter()
                .filter_map(|(platform, icon)| {
                    if !AppIcon::PLATFORMS.contains(&platform.as_str()) {
                        ignored.push(format!("unknown key `icon.{platform}`"));
                        return None;
                    }
                    let icon = match icon {
                        PlatformIcon::Image(path) => PlatformIcon::Image(dir.join(path)),
                        PlatformIcon::Adaptive(icon) if platform == "android" => {
                            ignored.extend(
                                icon.unknown
                                    .iter()
                                    .map(|key| format!("unknown key `icon.android.{key}`")),
                            );
                            PlatformIcon::Adaptive(icon.relative_to(dir))
                        }
                        PlatformIcon::Adaptive(_) => {
                            ignored.push(format!(
                                "icon.{platform}: an adaptive icon is Android's only; give the path of a PNG"
                            ));
                            return None;
                        }
                        PlatformIcon::Invalid(why) => {
                            ignored.push(format!("icon.{platform}: {why}"));
                            return None;
                        }
                    };
                    Some((platform, icon))
                })
                .collect(),
        )),
        None => None,
    };
    crate::apple::keep_privacy_manifest(&mut config.ios.privacy_manifest, &mut ignored);
    warn_ignored(&path, &ignored);
    config.ios.launch_screen = config
        .ios
        .launch_screen
        .map(|screen| screen.relative_to(dir));
    config.android.launch_screen = config
        .android
        .launch_screen
        .map(|screen| screen.relative_to(dir));
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
/// English whatever the user's. The languages of the app's `Info.plist`
/// strings (`strings`, `<platform>.infoPlistStrings`) are among them
/// ([`bundle_languages`]).
fn bundle_localizations(
    d: &mut plist::Dictionary,
    config: &AppConfig,
    strings: &serde_json::Map<String, serde_json::Value>,
) {
    let list = bundle_languages(&config.localizations, strings);
    if !list.is_empty() {
        d.insert(
            "CFBundleLocalizations".into(),
            plist::Value::Array(list.into_iter().map(plist::Value::String).collect()),
        );
    }
}

/// The languages an Apple bundle declares (`CFBundleLocalizations`): none
/// for an app with neither `locales` nor `Info.plist` strings, else
/// English, the development region, first, then `locales` and the
/// languages `strings` (`<platform>.infoPlistStrings`) has text in, whose
/// `.lproj` directories the bundle carries; one without text has none. The
/// development region has no directory: listed, it stays the language of
/// every user whose language the app does not have.
pub(crate) fn bundle_languages(
    locales: &[String],
    strings: &serde_json::Map<String, serde_json::Value>,
) -> Vec<String> {
    let translated = strings
        .iter()
        .filter(|(_, texts)| texts.as_object().is_some_and(|texts| !texts.is_empty()))
        .map(|(language, _)| language);
    let mut list = Vec::new();
    for language in locales.iter().chain(translated) {
        if list.is_empty() {
            list.push("en".to_owned());
        }
        if !list.contains(language) {
            list.push(language.clone());
        }
    }
    list
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
    let dir = dunce::canonicalize(nsh_bundler::app_dir::config_dir_of(entry))
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

/// The app's display name and id: from the config, else the name of its
/// directory (`nsh.json`'s, else the entry's) and `com.example.<name>`.
pub(crate) fn name_and_id(entry: &Path, config: &AppConfig) -> (String, String) {
    let name = config.name.clone().unwrap_or_else(|| {
        nsh_bundler::app_dir::config_dir_of(entry)
            .file_name()
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

/// Whether the TSX app at `entry` builds its own release runner for
/// `target` (`rust_app::runner_only`): this machine's desktop, with cargo
/// here and no prebuilt runtime asked for (`NSH_RUNTIME`). It is then the
/// app of this command ([`crate::rust_app::current`]). Another OS's
/// package keeps the prebuilt runner, which needs no cross toolchain.
fn trimmed_runner(entry: &Path, target: PackageTarget) -> bool {
    let this_machine = match target {
        PackageTarget::Linux => cfg!(target_os = "linux"),
        PackageTarget::Macos => cfg!(target_os = "macos"),
        PackageTarget::Windows => cfg!(windows),
        // iOS's runner builds with Xcode's SDK, so only on macOS.
        PackageTarget::Ios | PackageTarget::IosSimulator => cfg!(target_os = "macos"),
        // Android's library is cross-compiled with the NDK on any OS;
        // without it (or the Rust target) the build fails and the package
        // gets the prebuilt library.
        PackageTarget::Android => true,
        _ => false,
    };
    if !this_machine || std::env::var_os("NSH_RUNTIME").is_some() {
        return false;
    }
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let has_cargo = std::process::Command::new(cargo)
        .arg("--version")
        .output()
        .is_ok_and(|out| out.status.success());
    if !has_cargo {
        ui::note(
            "no cargo here: the package has the prebuilt runner, with every native feature; \
             install Rust (rustup.rs) to build one with only those the app uses",
        );
        return false;
    }
    match crate::rust_app::runner_only(entry) {
        Ok(app) => {
            crate::rust_app::set_current(app);
            true
        }
        Err(e) => {
            ui::warn(format!(
                "the prebuilt runner it is, with every native feature: {e:#}"
            ));
            false
        }
    }
}

pub(crate) fn package(mut options: PackageOptions<'_>) -> anyhow::Result<()> {
    if options.asset_url.is_some() && options.target != PackageTarget::Web {
        bail!("--asset-url is where a web site's files are served from: package with --target web");
    }
    // `--shared-runtime` only means something for the web; other targets ignore it.
    if options.target != PackageTarget::Web {
        options.shared_runtime = false;
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
    if options.target == PackageTarget::Windows
        && options.sign.is_some()
        && options.format != crate::android::Format::Msix
    {
        bail!("--sign signs the MSIX package on Windows: add --format msix");
    }
    if options.arch.is_some() && options.target != PackageTarget::Macos {
        bail!("--arch only applies to --target macos");
    }
    if options.device.is_some() {
        if !matches!(
            options.target,
            PackageTarget::IosSimulator | PackageTarget::Android
        ) {
            bail!("--device only applies to --target ios-simulator or android");
        }
        if !options.run {
            bail!("--device is where --run installs the app: add --run");
        }
    }
    if options.format == crate::android::Format::Msix {
        if options.target != PackageTarget::Windows {
            bail!("--format msix only applies to --target windows");
        }
    } else if options.format.is_linux() {
        if options.target != PackageTarget::Linux {
            bail!("--format appimage and flatpak only apply to --target linux");
        }
        if options.run {
            bail!(
                "--run launches the packaged directory: drop --format, or open the package itself"
            );
        }
    } else if options.format != crate::android::Format::Apk {
        if options.target != PackageTarget::Android {
            bail!("--format aab only applies to --target android");
        }
        if options.run {
            bail!(
                "--run installs an APK: drop --format aab, or install the bundle with bundletool"
            );
        }
    }
    let entry = dunce::canonicalize(options.entry)?;
    // What the app's crates and nshm declare for the package (an
    // `Info.plist` key, a manifest entry), under what `nsh.json` sets.
    if let Some((triples, platform)) = options.target.module_meta_triples(options.arch)
        && let Some(app) = crate::rust_app::current()
    {
        crate::module_meta::ModuleMeta::of_workspace(&app.workspace().join("Cargo.toml"), triples)?
            .apply(&mut options.config, platform)?;
        match platform {
            crate::module_meta::Platform::Ios => options.config.ios.check(ApplePlatform::Ios)?,
            crate::module_meta::Platform::Macos => options.config.macos.check()?,
            crate::module_meta::Platform::Android => {}
        }
    }
    let config = &options.config;
    let (name, id) = release_name_and_id(&entry, config)?;
    let links = config.app_links();
    if options.target == PackageTarget::Web && !links.schemes().is_empty() {
        ui::warn(
            "nsh.json schemes: a web page opens from its address, so the schemes are left out",
        );
    }
    if options.target == PackageTarget::Web && !links.web().is_empty() {
        ui::warn("nsh.json links: a web page is its own link, so the links are left out");
    }
    if matches!(
        options.target,
        PackageTarget::Linux | PackageTarget::Windows
    ) && !links.web().is_empty()
    {
        ui::warn(
            "nsh.json links: Linux and Windows open web links in the browser, so the links are left out",
        );
    }
    let executable = executable_name(&name);

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
    // An app builds its own release runner: with only the native features
    // its bundle can reach, and those `nsh.json` keeps. A TSX app does too
    // where cargo is, else it ships the prebuilt runner, which has all.
    let has_crates = crate::rust_app::current().is_some();
    let mut own_runner = false;
    if options.target != PackageTarget::Web
        && !crate::rust_app::is_root(&entry)
        && (has_crates || trimmed_runner(&entry, options.target))
    {
        own_runner = !has_crates;
        let choices = crate::native_features::choose(
            built.native_use.as_ref(),
            &config.features,
            crate::rust_app::current()
                .map(|app| crate::rust_app::rust_code_use(&app))
                .unwrap_or_default(),
        );
        // Why each feature is in or out is detail: only verbose runs
        // (`-v`) show it, a normal build stays quiet.
        for c in &choices {
            let mark = if c.keep { "keep" } else { "leave out" };
            ui::debug(format!("{mark} `{}`: {}", c.feature, c.why));
        }
        crate::rust_app::set_runner_features(
            choices
                .into_iter()
                .filter(|c| c.keep)
                .map(|c| c.feature.to_owned())
                .collect(),
        );
        // A TSX app's own runner is a saving, never a requirement: built
        // now, so a failure (system libraries, a Rust target, crates.io)
        // leaves it the prebuilt runner as before, not a failed package.
        // The packaging below finds the runner built.
        // Android's is built when packaging, for the APK's ABIs
        // (`package_android`), which falls back the same way.
        if !has_crates && options.target != PackageTarget::Android {
            let built = match options.target {
                PackageTarget::Macos => macos_runners(options.arch).map(drop),
                PackageTarget::Linux => runtime::file(Platform::Linux, true).map(drop),
                PackageTarget::Ios => runtime::file(Platform::IphoneOs, true).map(drop),
                PackageTarget::IosSimulator => {
                    runtime::file(Platform::IphoneSimulator, true).map(drop)
                }
                _ => runtime::file(Platform::Windows, true).map(drop),
            };
            if let Err(e) = built {
                crate::rust_app::clear_current();
                ui::warn(format!(
                    "the app's own runner did not build, so it has the prebuilt one, with every native feature: {e:#}"
                ));
            }
        }
    }
    let platform = match options.target {
        PackageTarget::Ios => Platform::IphoneOs,
        PackageTarget::IosSimulator => Platform::IphoneSimulator,
        PackageTarget::Android => {
            return package_android(&options, config, &name, &id, &built, own_runner);
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
    if options.target == PackageTarget::Ios && !lipo_archs(&runner)?.iter().any(|a| a == "arm64") {
        bail!("iOS device runner must contain arm64: {}", runner.display());
    }

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
    // The app's id, which names where it keeps its data, and the links it
    // claims (`Bundle::read`).
    fs::write(
        resources.join("app.json"),
        app_json(
            {
                let mut info = serde_json::json!({ "id": id, "name": name });
                config.add_file_types_to_app_json(&mut info);
                config.add_data_dir_to_app_json(&mut info);
                if let Some(application) = &config.application {
                    info["application"] = application.clone();
                }
                info
            },
            &links,
            config.window.as_ref(),
        ),
    )?;
    for asset in built.assets_for(options.target.asset_target()) {
        let dest = resources.join("assets").join(&asset.path);
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::copy(&asset.source, &dest).with_context(|| format!("copy {}", asset.path))?;
    }
    copy_apple_sounds(config, &built, &app)?;

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
    if sdk == "iphoneos" {
        info.extend(ios_toolchain_info()?);
    }
    url_types(&mut info, &id, links.schemes());
    activity_types(&mut info, &id, config.handoff);
    document_types(&mut info, &config.file_types());
    let icon = config.icon(PackageTarget::Ios);
    let launch_screen = config.ios.launch_screen.as_ref();
    if icon.is_some() || launch_screen.is_some() {
        let partial = compile_assets(icon, launch_screen, &app, sdk, minimum_os(&info))?;
        for (key, value) in partial {
            info.insert(key, value);
        }
    }
    let extensions = crate::app_extensions::embed(
        &config.ios.extensions,
        &app,
        &info,
        options.target == PackageTarget::IosSimulator,
        None,
    )?;
    let localized = config.ios.localized_info(ApplePlatform::Ios, &info)?;
    crate::apple::write_localized_info(&app, &localized)?;
    plist::Value::Dictionary(info).to_file_xml(app.join("Info.plist"))?;
    crate::apple::write_privacy_manifest(&config.ios.privacy_manifest, &app)?;

    match options.target {
        PackageTarget::IosSimulator => {
            // The app's signature seals its extensions': they are signed
            // first.
            crate::app_extensions::sign_ad_hoc(&extensions, options.out)?;
            // The simulator takes the app's entitlements without a profile.
            let mut entitlements = config.ios.entitlements(ApplePlatform::Ios)?;
            config.add_links_to_entitlements(&mut entitlements)?;
            let mut path = None;
            if !entitlements.is_empty() {
                let file = options.out.join(format!("{executable}.entitlements"));
                plist::Value::Dictionary(entitlements).to_file_xml(&file)?;
                path = Some(file);
            }
            codesign(&app, "-", path.as_deref())?;
            ui::done(format!("packaged {}", ui::path(&app)));
            if options.run {
                let udid =
                    crate::run::simulator(options.device, crate::run::SimulatorWindow::Front)?;
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
            let (Some(identity), false) = (options.sign, options.profiles.is_empty()) else {
                ui::warn(format!(
                    "{} is unsigned: pass --sign <identity> and --profile <file.mobileprovision> to install it on devices",
                    ui::path(&app)
                ));
                return Ok(());
            };
            let profiles = options
                .profiles
                .iter()
                .map(|path| Profile::read(path))
                .collect::<anyhow::Result<Vec<_>>>()?;
            // The app's signature seals its extensions': they are signed
            // first.
            crate::app_extensions::sign_device(&extensions, identity, &profiles, options.out)?;
            let profile = Profile::choose(&profiles, &id, false)?;
            crate::provisioning::warn_unused(&profiles);
            fs::copy(&profile.path, app.join("embedded.mobileprovision"))
                .with_context(|| format!("copy {}", profile.path.display()))?;
            let mut requested = config.ios.entitlements(ApplePlatform::Ios)?;
            // The profile grants Associated Domains for the web links'.
            config.add_links_to_entitlements(&mut requested)?;
            let entitlements = profile.entitlements(&id, requested, "ios.entitlements")?;
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
    own_runner: bool,
) -> anyhow::Result<()> {
    use crate::android::{self, Apk, Signing};
    let sdk = android::Sdk::find()?;
    let serial = if options.run {
        Some(android::device(&sdk, options.device)?)
    } else {
        None
    };
    let device = match &serial {
        Some(serial) => Some(android::device_abis(&sdk, serial)?),
        None => None,
    };
    let abis = apk_abis(options.abis, device.as_deref())?;
    // A TSX app's own library is a saving, never a requirement
    // (`trimmed_runner`): a failure (no NDK, a Rust target, crates.io)
    // leaves it the prebuilt library, with every native feature.
    let runtime = match runtime::android(false, &abis) {
        Err(e) if own_runner => {
            crate::rust_app::clear_current();
            ui::warn(format!(
                "the app's own library did not build, so it has the prebuilt one, with every native feature: {e:#}"
            ));
            runtime::android(false, &abis)?
        }
        runtime => runtime?,
    };
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
            {
                let mut info = serde_json::json!({ "id": id });
                if let Some(application) = &config.application {
                    info["application"] = application.clone();
                }
                config.add_file_types_to_app_json(&mut info);
                info
            },
            &config.app_links(),
            config.window.as_ref(),
        )
        .into_bytes(),
    ));
    for asset in built.assets_for(options.target.asset_target()) {
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
    let permissions = config.android.permissions()?;
    let apk_path = options
        .out
        .join(format!("{name}.{}", options.format.extension()));
    let version = config.version.as_deref().unwrap_or("1.0.0");
    // `android/res/` next to `nsh.json`: the app's own resources.
    let config_dir = nsh_bundler::app_dir::config_dir_of(options.entry);
    let app_dir = config_dir.as_path();
    let res = Some(app_dir.join("android").join("res")).filter(|dir| dir.is_dir());
    let library_cache = app_dir.join(".nsh/android/libraries");
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
            dev: options.development,
            cleartext: config.android.uses_cleartext_traffic,
            notifications: config.notifications(),
            microphone: config.web_media("microphone"),
            camera: config.web_media("camera"),
            libraries: &config.android.libraries,
            library_cache: &library_cache,
            manifest_placeholders: Some(&config.android.manifest_placeholders),
            permissions: &permissions,
            queries: &config.android.queries,
            application: &config.android.application,
            schemes: &config.schemes,
            share_mime_types: &file_mime_types(&config.file_types()),
            links: config.app_links().web(),
            rust: built.rust_root,
            dark: config.appearance.as_deref() == Some("dark"),
            fixed_appearance: matches!(config.appearance.as_deref(), Some("light" | "dark")),
            runtime: &runtime,
            abis: &abis,
            icon: config.android_icon(),
            launch_screen: config.android.launch_screen.as_ref(),
            assets,
            sounds: android_sounds(config, built),
            res: res.as_deref(),
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
        android::install(
            &sdk,
            &serial,
            &apk_path,
            id,
            &["-r"],
            android::AppData::Kept,
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
    for asset in built.assets_for(options.target.asset_target()) {
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
    let store = crate::linux_store::StoreConfig::read(options.entry)?;
    let icon = config.icon(PackageTarget::Linux);
    if let Some(icon) = icon {
        crate::linux_store::write_icon(icon, &dir.join(format!("{id}.png")))?;
    }
    fs::write(
        dir.join(format!("{id}.desktop")),
        linux_desktop_entry(config, &store, name, id, executable, icon.is_some()),
    )?;
    let store_app = crate::linux_store::LinuxApp {
        name,
        id,
        executable,
        version,
        store: &store,
    };
    fs::write(
        dir.join(format!("{id}.metainfo.xml")),
        crate::linux_store::metainfo(&store_app),
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
    crate::updater::copy_archive(
        config,
        name,
        &nsh_updater::platform(),
        &archive,
        options.out,
    )?;
    step.done(format!(
        "packaged {} and {}",
        ui::path(&dir),
        ui::path(&archive)
    ));
    match options.format {
        crate::android::Format::Appimage => {
            let step = ui::Step::start(format!("making the AppImage of {name}"));
            let image = crate::linux_store::appimage(&dir, options.out, &store_app)?;
            step.done(format!("packaged {}", ui::path(&image)));
        }
        crate::android::Format::Flatpak => {
            let step = ui::Step::start(format!("making the Flatpak of {name}"));
            match crate::linux_store::flatpak(
                &archive,
                options.out,
                &store_app,
                &config.linux.flatpak,
                icon.is_some(),
            )? {
                Some(bundle) => step.done(format!("packaged {}", ui::path(&bundle))),
                None => step.done(format!(
                    "wrote {}",
                    ui::path(&options.out.join("flatpak").join(format!("{id}.yml")))
                )),
            }
        }
        _ => {}
    }
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

/// The file types Apple platforms play as a notification's sound.
const APPLE_SOUNDS: &[&str] = &["caf", "aiff", "aif", "wav"];
/// The file types Android plays as a notification channel's sound.
const ANDROID_SOUNDS: &[&str] = &["ogg", "mp3", "wav"];

/// The app's sounds a notification can play (`Notifications.show`'s
/// `sound`), of the file types in `extensions`: none without the
/// `notifications` capability.
fn notification_sounds<'a>(
    config: &AppConfig,
    built: &'a crate::build::Built,
    extensions: &'static [&'static str],
) -> impl Iterator<Item = &'a crate::build::Asset> {
    let on = config.notifications();
    built.assets.iter().filter(move |asset| {
        on && Path::new(&asset.path)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| extensions.contains(&e.to_ascii_lowercase().as_str()))
    })
}

/// Copies the app's notification sounds into `dir`, the app's main bundle
/// on Apple platforms, where the system finds them by file name.
fn copy_apple_sounds(
    config: &AppConfig,
    built: &crate::build::Built,
    dir: &Path,
) -> anyhow::Result<()> {
    let mut names = std::collections::HashMap::new();
    for asset in notification_sounds(config, built, APPLE_SOUNDS) {
        let name = nsh_core::notifications::Notification::sound_file_name(&asset.path);
        if let Some(other) = names.insert(name.to_owned(), asset.path.clone()) {
            ui::warn(format!(
                "notification sounds {other} and {} share the file name {name}: only the last plays",
                asset.path
            ));
        }
        fs::copy(&asset.source, dir.join(name)).with_context(|| format!("copy {}", asset.path))?;
    }
    Ok(())
}

/// The app's notification sounds as Android raw resources: (resource
/// name, file).
fn android_sounds(config: &AppConfig, built: &crate::build::Built) -> Vec<(String, PathBuf)> {
    let mut sounds: Vec<(String, PathBuf)> = Vec::new();
    for asset in notification_sounds(config, built, ANDROID_SOUNDS) {
        let name = nsh_core::notifications::Notification::sound_resource_name(&asset.path);
        if sounds.iter().any(|(n, _)| *n == name) {
            ui::warn(format!(
                "notification sound {} has the resource name {name} of another: only the first plays",
                asset.path
            ));
            continue;
        }
        sounds.push((name, asset.source.clone()));
    }
    sounds
}

/// `<out>/<name>.app`, a macOS app bundle: the release runner as
/// `Contents/MacOS/<executable>`, the bundle and assets in
/// `Contents/Resources/nsh/` (where the runner looks), `nsh/app.json` (the
/// window's title and the app's appearance, which the window opens in),
/// the icon as `AppIcon.icns`, and any `macos.extensions` in
/// `Contents/PlugIns/`; signed ad hoc by default (Apple silicon runs no
/// unsigned code) or with `--sign` (Hardened Runtime and secure timestamp),
/// then verified with `codesign --verify --deep --strict`.
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
    for asset in built.assets_for(options.target.asset_target()) {
        let dest = nsh.join("assets").join(&asset.path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&asset.source, &dest).with_context(|| format!("copy {}", asset.path))?;
    }
    copy_apple_sounds(config, built, &resources)?;
    let version = config.version.as_deref().unwrap_or("1.0.0");
    let mut info = serde_json::json!({ "name": name, "id": id, "version": version });
    if let Some(appearance) = &config.appearance {
        info["appearance"] = appearance.as_str().into();
    }
    config.macos.add_to_app_json(&mut info);
    config.add_file_types_to_app_json(&mut info);
    config.add_data_dir_to_app_json(&mut info);
    if let Some(application) = &config.application {
        info["application"] = application.clone();
    }
    // macOS opens web links in the app only under a profile that grants
    // Associated Domains, which an ad hoc package has not: the links are
    // there for an app signed so.
    fs::write(
        nsh.join("app.json"),
        app_json(info, &config.app_links(), config.window.as_ref()),
    )?;
    let icon = match config.icon(PackageTarget::Macos) {
        Some(icon) => {
            macos_icns(icon, &resources.join("AppIcon.icns"))?;
            true
        }
        None => false,
    };
    let mut plist = macos_info_plist(name, id, executable, config, icon)?;
    let links = config.app_links();
    url_types(&mut plist, id, links.schemes());
    activity_types(&mut plist, id, config.handoff);
    document_types(&mut plist, &config.file_types());
    let localized = config.macos.localized_info(&plist)?;
    crate::apple::write_localized_info(&resources, &localized)?;
    let extensions = crate::app_extensions::embed_macos(&config.macos.extensions, &app, &plist)?;
    plist::Value::Dictionary(plist)
        .to_file_xml(contents.join("Info.plist"))
        .context("write Info.plist")?;
    let mut entitlements = config.macos.entitlements()?;
    config.web_media_entitlements(&mut entitlements);
    let identity = options.sign.unwrap_or("-");
    for key in entitlements.keys() {
        if crate::apple::needs_profile(key) {
            if identity == "-" {
                ui::warn(format!(
                    "macOS launches an app signed with `{key}` (nsh.json macos.entitlements) only under a provisioning profile that grants it: \
                     sign {} again with your Developer ID and such a profile before running it",
                    ui::path(&app)
                ));
            } else {
                ui::warn(format!(
                    "macOS launches an app signed with `{key}` (nsh.json macos.entitlements) only under a provisioning profile that grants it: \
                     embed such a profile in {} as Contents/embedded.provisionprofile and sign it again before running it",
                    ui::path(&app)
                ));
            }
        }
    }
    // The app's signature seals its extensions': sign them inside-out first.
    crate::app_extensions::sign_macos(&extensions, identity, options.out)?;
    let mut entitlements_path = None;
    if !entitlements.is_empty() {
        let path = options.out.join(format!("{executable}.entitlements"));
        plist::Value::Dictionary(entitlements).to_file_xml(&path)?;
        entitlements_path = Some(path);
    }
    codesign_macos(&app, identity, entitlements_path.as_deref())?;
    codesign_verify(&app)?;
    // Named after what the executable holds: with no `--arch`, the runner
    // as it was built or came.
    let archs = lipo_archs(&macos.join(executable))?;
    crate::updater::archive_macos_app(
        config,
        name,
        &app,
        options.out,
        &macos_update_platforms(&archs),
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

/// The macOS release runners of a package for `arch` (`None`: the runner
/// as Cargo builds it with no `--target`, or as it comes prebuilt): one per
/// architecture, each built for its Rust target ([`runtime::build_target`]).
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
        let runtime::RuntimeFile { path, built } =
            runtime::locate(Platform::MacOs, true, Some(triple))?;
        let wanted = lipo_arch(triple);
        let archs = lipo_archs(&path)?;
        if !archs.iter().any(|arch| arch == wanted) {
            let source = if built {
                RunnerSource::Built
            } else if std::env::var_os("NSH_RUNTIME").is_some() {
                RunnerSource::NshRuntime
            } else {
                RunnerSource::Installed
            };
            bail!("{}", wrong_runner_arch(&path, source, &archs, triple));
        }
        runners.push(MacRunner {
            path,
            arch: Some(wanted),
            fat: archs.len() > 1,
        });
    }
    Ok(runners)
}

/// Where a macOS release runner comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunnerSource {
    /// Built by Cargo for this package (an app's crates, a checkout).
    Built,
    /// An installed nsh's prebuilt runner.
    Installed,
    /// The prebuilt runner of the runtime `NSH_RUNTIME` names.
    NshRuntime,
}

/// Why the macOS release runner at `path`, from `source`, which holds
/// `archs`, cannot be the one for `triple`. A prebuilt runner is built for
/// the processor of the machine that built it.
fn wrong_runner_arch(path: &Path, source: RunnerSource, archs: &[String], triple: &str) -> String {
    let wanted = lipo_arch(triple);
    let held = archs.join(" and ");
    let path = path.display();
    match source {
        // Cargo was told the target, or it was the toolchain's host.
        RunnerSource::Built => format!(
            "the macOS release runner {path} came out built for {held}, not {wanted}, though Cargo built it for {triple}: \
             a Cargo configuration (`build.target`, a wrapper) or a `RUSTC` other than Cargo's builds it for another target"
        ),
        RunnerSource::Installed => format!(
            "the prebuilt macOS release runner {path} is built for {held}, not {wanted}: an installed nsh has the runner of its \
             own processor, so package for {wanted} with the nsh of that processor, or where nsh can build the runner with \
             Cargo (rustup.rs), which builds it for any"
        ),
        RunnerSource::NshRuntime => format!(
            "the macOS release runner {path} of NSH_RUNTIME is built for {held}, not {wanted}: set NSH_RUNTIME to a runtime \
             built for {wanted}, or unset it where Cargo is, with which nsh builds the runner for any"
        ),
    }
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
    bundle_localizations(&mut d, config, &config.macos.info_plist_strings);
    // Finder shows a translated name of the app only with it.
    if config
        .macos
        .info_plist_strings
        .values()
        .any(|texts| texts.get("CFBundleDisplayName").is_some())
    {
        d.insert("LSHasLocalizedDisplayName".into(), true.into());
    }
    // The app's own keys, over NSH's defaults (never over its reserved ones).
    d.extend(config.macos.info_plist()?);
    Ok(d)
}

/// The MIME types of `types`, each once, for a Linux desktop entry and
/// Android's share sheet (a type with only extensions has none).
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

/// Build metadata for device packages, from the active Xcode installation.
/// Keep tool discovery outside `info_plist` so its defaults stay testable on every OS.
fn ios_toolchain_info() -> anyhow::Result<plist::Dictionary> {
    fn read(program: &str, args: &[&str]) -> anyhow::Result<String> {
        let output = Command::new(program)
            .args(args)
            .output()
            .with_context(|| format!("run {program} {}", args.join(" ")))?;
        if !output.status.success() {
            bail!(
                "{program} {}: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let value = String::from_utf8(output.stdout)?.trim().to_owned();
        if value.is_empty() {
            bail!("{program} {} returned no build metadata", args.join(" "));
        }
        Ok(value)
    }
    let version = read("xcrun", &["--sdk", "iphoneos", "--show-sdk-version"])?;
    let sdk_build = read("xcrun", &["--sdk", "iphoneos", "--show-sdk-build-version"])?;
    let xcode = read("xcodebuild", &["-version"])?;
    let (xcode_version, xcode_build) = xcode_info(&xcode)?;
    let os_build = read("sw_vers", &["-buildVersion"])?;
    Ok([
        ("DTPlatformName", "iphoneos".to_owned()),
        ("DTPlatformVersion", version.clone()),
        ("DTPlatformBuild", sdk_build.clone()),
        ("DTSDKName", format!("iphoneos{version}")),
        ("DTSDKBuild", sdk_build),
        ("DTXcode", xcode_version),
        ("DTXcodeBuild", xcode_build),
        (
            "DTCompiler",
            "com.apple.compilers.llvm.clang.1_0".to_owned(),
        ),
        ("BuildMachineOSBuild", os_build),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), plist::Value::String(v)))
    .collect())
}

fn xcode_info(output: &str) -> anyhow::Result<(String, String)> {
    let version = output
        .lines()
        .find_map(|l| l.strip_prefix("Xcode "))
        .context("xcodebuild -version did not report an Xcode version")?;
    let parts = version
        .split('.')
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()?;
    if parts.is_empty() || parts.len() > 3 || parts.iter().skip(1).any(|v| *v > 9) {
        bail!("unsupported Xcode version: {version}");
    }
    let encoded = format!(
        "{:02}{}{}",
        parts[0],
        parts.get(1).unwrap_or(&0),
        parts.get(2).unwrap_or(&0)
    );
    let build = output
        .lines()
        .find_map(|l| l.strip_prefix("Build version "))
        .filter(|v| !v.trim().is_empty())
        .context("xcodebuild -version did not report a build version")?;
    Ok((encoded, build.trim().to_owned()))
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
    if sdk == "iphoneos" {
        d.insert(
            "UIRequiredDeviceCapabilities".into(),
            Value::Array(vec![s("arm64")]),
        );
    }
    // The runtime's, unless the app raises it (`ios.infoPlist`).
    d.insert("MinimumOSVersion".into(), s(IOS_MINIMUM));
    d.insert(
        "UIDeviceFamily".into(),
        Value::Array(vec![1.into(), 2.into()]),
    );
    d.insert("LSRequiresIPhoneOS".into(), true.into());
    config.usage_descriptions(&mut d);
    bundle_localizations(&mut d, config, &config.ios.info_plist_strings);
    // A launch screen entry opts into the full screen (no letterboxing);
    // the app's color and image are in its asset catalog
    // ([`launch_screen_sets`]).
    d.insert(
        "UILaunchScreen".into(),
        Value::Dictionary(launch_screen_info(config.ios.launch_screen.as_ref())),
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

/// The asset catalog's name of the launch screen's color.
const LAUNCH_BACKGROUND: &str = "LaunchBackground";
/// The asset catalog's name of the launch screen's image.
const LAUNCH_IMAGE: &str = "LaunchImage";

/// `UILaunchScreen`: the names of the app's launch screen color and image
/// in its asset catalog, none for the system's background.
fn launch_screen_info(screen: Option<&crate::apple::LaunchScreen>) -> plist::Dictionary {
    let mut d = plist::Dictionary::new();
    if let Some(screen) = screen {
        if screen.background.is_some() {
            d.insert("UIColorName".into(), LAUNCH_BACKGROUND.into());
        }
        if screen.image.is_some() {
            d.insert("UIImageName".into(), LAUNCH_IMAGE.into());
        }
    }
    d
}

/// A set of an asset catalog, as [`compile_assets`] writes it.
#[derive(Debug)]
struct CatalogSet {
    /// Its directory in the catalog (`LaunchImage.imageset`).
    dir: String,
    /// Its `Contents.json`.
    contents: serde_json::Value,
    /// The images it copies in: the source and its file name in the set.
    files: Vec<(PathBuf, String)>,
}

/// The asset catalog sets of a launch screen.
fn launch_screen_sets(screen: &crate::apple::LaunchScreen) -> Vec<CatalogSet> {
    use serde_json::json;
    let info = json!({ "author": "nsh", "version": 1 });
    let dark = json!([{ "appearance": "luminosity", "value": "dark" }]);
    let mut sets = Vec::new();
    if let Some(background) = &screen.background {
        let color = |color: &crate::apple::Color| {
            let [r, g, b, a] = color.0;
            json!({
                "color-space": "srgb",
                "components": {
                    "red": format!("0x{r:02X}"),
                    "green": format!("0x{g:02X}"),
                    "blue": format!("0x{b:02X}"),
                    "alpha": format!("{:.3}", f32::from(a) / 255.0),
                },
            })
        };
        let (light, dark_color) = background.variants();
        let mut colors = vec![json!({ "idiom": "universal", "color": color(light) })];
        if let Some(dark_color) = dark_color {
            colors.push(json!({
                "idiom": "universal",
                "appearances": dark,
                "color": color(dark_color),
            }));
        }
        sets.push(CatalogSet {
            dir: format!("{LAUNCH_BACKGROUND}.colorset"),
            contents: json!({ "colors": colors, "info": info }),
            files: Vec::new(),
        });
    }
    if let Some(image) = &screen.image {
        let (light, dark_image) = image.variants();
        let mut images =
            vec![json!({ "idiom": "universal", "filename": "light.png", "scale": "3x" })];
        let mut files = vec![(light.clone(), "light.png".to_owned())];
        if let Some(dark_image) = dark_image {
            images.push(json!({
                "idiom": "universal",
                "filename": "dark.png",
                "scale": "3x",
                "appearances": dark,
            }));
            files.push((dark_image.clone(), "dark.png".to_owned()));
        }
        sets.push(CatalogSet {
            dir: format!("{LAUNCH_IMAGE}.imageset"),
            contents: json!({ "images": images, "info": info }),
            files,
        });
    }
    sets
}

/// Compiles the app's asset catalog (`Assets.car`) with `actool`: its
/// `icon` and its `launch_screen`'s color and image, for `minimum`, the
/// oldest iOS the app declares (as Xcode compiles it for the deployment
/// target), returning the Info.plist keys it produces.
fn compile_assets(
    icon: Option<&Path>,
    launch_screen: Option<&crate::apple::LaunchScreen>,
    app: &Path,
    sdk: &str,
    minimum: &str,
) -> anyhow::Result<plist::Dictionary> {
    let work = app.with_extension("xcassets-work");
    let catalog = work.join("Assets.xcassets");
    fs::create_dir_all(&catalog)?;
    fs::write(
        catalog.join("Contents.json"),
        r#"{"info":{"author":"nsh","version":1}}"#,
    )?;
    if let Some(icon) = icon {
        let set = catalog.join("AppIcon.appiconset");
        fs::create_dir_all(&set)?;
        fs::copy(icon, set.join("icon.png")).with_context(|| format!("copy {}", icon.display()))?;
        // One 1024 pt image; actool derives every size (Xcode 14+ catalogs).
        fs::write(
            set.join("Contents.json"),
            r#"{"images":[{"filename":"icon.png","idiom":"universal","platform":"ios","size":"1024x1024"}],"info":{"author":"nsh","version":1}}"#,
        )?;
    }
    for CatalogSet {
        dir,
        contents,
        files,
    } in launch_screen.map(launch_screen_sets).unwrap_or_default()
    {
        let set = catalog.join(dir);
        fs::create_dir_all(&set)?;
        fs::write(set.join("Contents.json"), contents.to_string())?;
        for (source, file) in files {
            fs::copy(&source, set.join(file)).with_context(|| {
                format!(
                    "copy {} (nsh.json ios.launchScreen.image)",
                    source.display()
                )
            })?;
        }
    }
    let partial = work.join("partial.plist");
    let mut command = Command::new("xcrun");
    command.args(["actool", "--compile"]).arg(app).args([
        "--platform",
        sdk,
        "--minimum-deployment-target",
        minimum,
    ]);
    if icon.is_some() {
        command.args(["--app-icon", "AppIcon"]);
    }
    let output = command
        .arg("--output-partial-info-plist")
        .arg(&partial)
        .args([
            "--target-device",
            "iphone",
            "--target-device",
            "ipad",
            "--output-format",
            "human-readable-text",
        ])
        .arg(&catalog)
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

pub(crate) fn codesign(
    app: &Path,
    identity: &str,
    entitlements: Option<&Path>,
) -> anyhow::Result<()> {
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
            "codesign failed for {}: {}",
            app.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

/// The arguments passed to `codesign` for a macOS bundle or nested binary.
/// Certificate-signed builds enable Hardened Runtime (`--options runtime`)
/// and a secure timestamp (`--timestamp`), as notarization and Developer ID
/// distribution require; ad-hoc builds (`"-"`) disable timestamping.
pub(crate) fn codesign_macos_args(
    bundle: &Path,
    identity: &str,
    entitlements: Option<&Path>,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--force".into(), "--sign".into(), identity.into()];
    if identity == "-" {
        args.push("--timestamp=none".into());
    } else {
        args.push("--options".into());
        args.push("runtime".into());
        args.push("--timestamp".into());
    }
    if let Some(e) = entitlements {
        args.push("--entitlements".into());
        args.push(e.as_os_str().to_os_string());
    }
    args.push(bundle.as_os_str().to_os_string());
    args
}

/// Signs a macOS bundle or nested code item with `identity` (enabling
/// Hardened Runtime and secure timestamping when signed with a certificate).
pub(crate) fn codesign_macos(
    bundle: &Path,
    identity: &str,
    entitlements: Option<&Path>,
) -> anyhow::Result<()> {
    let output = Command::new("codesign")
        .args(codesign_macos_args(bundle, identity, entitlements))
        .stdout(Stdio::null())
        .output()
        .context("run codesign")?;
    if !output.status.success() {
        bail!(
            "codesign failed for {}: {}",
            bundle.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

/// Verifies a signed macOS app bundle and all nested extensions/code with
/// `codesign --verify --deep --strict`.
pub(crate) fn codesign_verify(app: &Path) -> anyhow::Result<()> {
    let output = Command::new("codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(app)
        .stdout(Stdio::null())
        .output()
        .context("run codesign --verify")?;
    if !output.status.success() {
        bail!(
            "codesign verification failed for {}: {}",
            app.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
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

    /// `watch.ignore` reads as the watcher's skip list; without it there
    /// is nothing to skip.
    #[test]
    fn watch_ignore_is_read_from_nsh_json() {
        let (config, ignored) = parse_config(
            r#"{
                "watch": { "ignore": ["vendor", "third/jpeg-turbo"] }
            }"#,
        )
        .unwrap();
        assert!(ignored.is_empty(), "{ignored:?}");
        assert_eq!(config.watch.ignore, ["vendor", "third/jpeg-turbo"]);
        let (config, ignored) = parse_config("{}").unwrap();
        assert!(ignored.is_empty(), "{ignored:?}");
        assert!(config.watch.ignore.is_empty());
    }

    /// Without `ios.launchScreen` the launch screen is the system's
    /// background; with it `UILaunchScreen` names the catalog's color and
    /// image, which are sets for both appearances or one for each.
    #[test]
    fn launch_screens_become_named_colors_and_images() {
        let info = info_plist("A", "com.a", "a", &AppConfig::default(), "iphoneos").unwrap();
        assert_eq!(
            info["UILaunchScreen"],
            plist::Value::Dictionary(Default::default())
        );

        let (config, ignored) = parse_config(
            r##"{ "ios": { "launchScreen": {
                "background": { "light": "#ffffff", "dark": "#13131280" },
                "image": "launch.png"
            } } }"##,
        )
        .unwrap();
        assert!(ignored.is_empty(), "{ignored:?}");
        let info = info_plist("A", "com.a", "a", &config, "iphoneos").unwrap();
        let screen = info["UILaunchScreen"].as_dictionary().unwrap();
        assert_eq!(
            screen["UIColorName"],
            plist::Value::String(LAUNCH_BACKGROUND.into())
        );
        assert_eq!(
            screen["UIImageName"],
            plist::Value::String(LAUNCH_IMAGE.into())
        );

        let sets = launch_screen_sets(config.ios.launch_screen.as_ref().unwrap());
        let CatalogSet {
            dir,
            contents: color,
            files,
        } = &sets[0];
        assert_eq!(dir, "LaunchBackground.colorset");
        assert!(files.is_empty());
        assert_eq!(color["colors"][0]["color"]["components"]["red"], "0xFF");
        assert_eq!(color["colors"][0].get("appearances"), None);
        assert_eq!(color["colors"][1]["appearances"][0]["value"], "dark");
        assert_eq!(color["colors"][1]["color"]["components"]["blue"], "0x12");
        assert_eq!(color["colors"][1]["color"]["components"]["alpha"], "0.502");
        let CatalogSet {
            dir,
            contents: image,
            files,
        } = &sets[1];
        assert_eq!(dir, "LaunchImage.imageset");
        assert_eq!(image["images"].as_array().unwrap().len(), 1);
        assert_eq!(image["images"][0]["scale"], "3x");
        assert_eq!(
            files,
            &[(PathBuf::from("launch.png"), "light.png".to_owned())]
        );

        // A color that does not read is left out with a warning, as other
        // values are.
        let (config, ignored) =
            parse_config(r#"{ "ios": { "launchScreen": { "background": "white" } } }"#).unwrap();
        assert_eq!(config.ios.launch_screen.unwrap().background, None);
        assert_eq!(ignored.len(), 1, "{ignored:?}");
    }

    #[test]
    fn ios_device_capabilities_and_overrides() {
        let config = AppConfig::default();
        let device = info_plist("A", "com.a", "a", &config, "iphoneos").unwrap();
        assert_eq!(
            device["UIRequiredDeviceCapabilities"].as_array().unwrap(),
            &[plist::Value::String("arm64".into())]
        );
        let simulator = info_plist("A", "com.a", "a", &config, "iphonesimulator").unwrap();
        assert!(!simulator.contains_key("UIRequiredDeviceCapabilities"));
        let config: AppConfig = serde_json::from_value(serde_json::json!({
            "ios": {"infoPlist": {"UIRequiredDeviceCapabilities": ["arm64", "gps"]}}
        }))
        .unwrap();
        let device = info_plist("A", "com.a", "a", &config, "iphoneos").unwrap();
        assert_eq!(
            device["UIRequiredDeviceCapabilities"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn xcode_build_metadata() {
        for (version, encoded) in [
            ("27.2", "2720"),
            ("16.4.1", "1641"),
            ("9.3", "0930"),
            ("27", "2700"),
        ] {
            assert_eq!(
                xcode_info(&format!("Xcode {version}\nBuild version 27B52\n")).unwrap(),
                (encoded.into(), "27B52".into())
            );
        }
        for output in [
            "",
            "Xcode 27.2",
            "Xcode nope\nBuild version A",
            "Xcode 27.10\nBuild version A",
        ] {
            assert!(xcode_info(output).is_err());
        }
    }

    #[test]
    fn nsh_json_names_the_nsh_versions_it_needs() {
        let ok = |r: serde_json::Value, v| nsh_version_error(&r, v);
        assert_eq!(ok(serde_json::Value::Null, "0.4.0"), None);
        assert_eq!(ok(serde_json::json!(">=0.5"), "0.5.0"), None);
        assert_eq!(ok(serde_json::json!(">=0.5, <0.7"), "0.6.3"), None);
        assert_eq!(ok(serde_json::json!("0.5"), "0.5.2"), None);
        // A prerelease counts as its release.
        assert_eq!(ok(serde_json::json!(">=0.5"), "0.5.0-nightly.1"), None);
        assert_eq!(
            ok(serde_json::json!(">=0.5"), "0.4.0").as_deref(),
            Some("this app requires nsh >=0.5; this is nsh 0.4.0")
        );
        assert!(
            ok(serde_json::json!("latest"), "0.5.0")
                .unwrap()
                .contains("invalid")
        );
        assert!(
            ok(serde_json::json!(5), "0.5.0")
                .unwrap()
                .contains("must be")
        );
        // The key is known: no "unknown key" warning.
        let (_, ignored) = parse_config(r#"{ "nsh": ">=0.5" }"#).unwrap();
        assert!(ignored.is_empty(), "{ignored:?}");
    }

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
        assert_eq!(lipo_arch("aarch64-apple-darwin"), "arm64");
        assert_eq!(lipo_arch("x86_64-apple-darwin"), "x86_64");
        let archs = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert_eq!(
            macos_update_platforms(&archs(&["arm64"])),
            ["macos-aarch64"]
        );
        assert_eq!(
            macos_update_platforms(&archs(&["x86_64"])),
            ["macos-x86_64"]
        );
        assert_eq!(
            macos_update_platforms(&archs(&["x86_64", "arm64"])),
            ["macos-aarch64", "macos-x86_64"]
        );
    }

    /// A package with no `--arch` is for the processor of the Rust
    /// toolchain, not of this nsh: an Intel nsh under Rosetta with an Apple
    /// silicon toolchain builds and names an Apple silicon package.
    #[test]
    fn the_default_arch_is_the_toolchains() {
        assert_eq!(Arch::of_host(Some("aarch64-apple-darwin")), Arch::Arm64);
        assert_eq!(Arch::of_host(Some("x86_64-apple-darwin")), Arch::X86_64);
        let own = if cfg!(target_arch = "aarch64") {
            Arch::Arm64
        } else {
            Arch::X86_64
        };
        assert_eq!(Arch::of_host(None), own);
    }

    /// The error of a runner for the wrong processor says where it came
    /// from: a runner Cargo built is not an installed nsh's.
    #[test]
    fn a_runner_for_another_processor_says_where_it_came_from() {
        let path = Path::new("/tmp/nsh-macos-app");
        let archs = ["arm64".to_owned()];
        let built = wrong_runner_arch(path, RunnerSource::Built, &archs, MACOS_X86_64);
        assert!(built.contains("built for arm64, not x86_64"), "{built}");
        assert!(
            built.contains("Cargo built it for x86_64-apple-darwin"),
            "{built}"
        );
        assert!(!built.contains("installed"), "{built}");
        let installed = wrong_runner_arch(path, RunnerSource::Installed, &archs, MACOS_X86_64);
        assert!(
            installed.starts_with("the prebuilt macOS release runner"),
            "{installed}"
        );
        assert!(installed.contains("an installed nsh"), "{installed}");
        let env = wrong_runner_arch(path, RunnerSource::NshRuntime, &archs, MACOS_X86_64);
        assert!(env.contains("NSH_RUNTIME"), "{env}");
        assert!(!env.contains("installed"), "{env}");
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
                profiles: &[],
                keystore: None,
                abis: &[],
                format: crate::android::Format::Apk,
                arch: Some(Arch::X86_64),
                run: false,
                device: None,
                asset_url: None,
                shared_runtime: false,
                development: false,
            })
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                "--arch only applies to --target macos",
                "{target:?}"
            );
        }
    }

    /// `--device` names where `--run` installs the app: a simulator or an
    /// Android device. Other targets, and a package not run, refuse it
    /// before anything is built.
    #[test]
    fn only_runs_on_a_simulator_or_android_device_take_a_device() {
        let options = |target, run| PackageOptions {
            entry: Path::new("App.tsx"),
            target,
            out: Path::new(".nsh/out"),
            config: AppConfig::default(),
            sign: None,
            profiles: &[],
            keystore: None,
            abis: &[],
            format: crate::android::Format::Apk,
            arch: None,
            run,
            device: Some("emulator-5554"),
            asset_url: None,
            shared_runtime: false,
            development: false,
        };
        for target in [
            PackageTarget::Macos,
            PackageTarget::Linux,
            PackageTarget::Windows,
            PackageTarget::Ios,
            PackageTarget::Web,
        ] {
            assert_eq!(
                package(options(target, true)).unwrap_err().to_string(),
                "--device only applies to --target ios-simulator or android",
                "{target:?}"
            );
        }
        for target in [PackageTarget::IosSimulator, PackageTarget::Android] {
            assert_eq!(
                package(options(target, false)).unwrap_err().to_string(),
                "--device is where --run installs the app: add --run",
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

    /// `ios.privacyManifest` is read with the rest of `nsh.json`; what is
    /// not a privacy manifest's is left out there, never an error.
    #[test]
    fn the_privacy_manifest_is_read_from_nsh_json() {
        let dir =
            std::env::temp_dir().join(format!("nsh-cli-privacy-config-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("nsh.json"),
            r#"{ "ios": { "privacyManifest": {
                "NSPrivacyTracking": false,
                "NSPrivacyAccessedAPIType": []
            } } }"#,
        )
        .unwrap();
        let config = read_config(&dir.join("App.tsx")).unwrap();
        assert_eq!(
            config.ios.privacy_manifest,
            *serde_json::json!({ "NSPrivacyTracking": false })
                .as_object()
                .unwrap()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `android.queries` and `android.application` are the app's to write
    /// too; a value of another form is left out with a warning, as any
    /// `nsh.json` value is.
    #[test]
    fn the_app_writes_android_queries_and_components() {
        let (config, ignored) = parse_config(
            r#"{ "android": {
                "queries": ["<package android:name=\"com.singular.sdk\"/>"],
                "application": ["<service android:name=\"${applicationId}.Sync\" android:exported=\"false\"/>"]
            } }"#,
        )
        .unwrap();
        assert!(ignored.is_empty(), "{ignored:?}");
        assert_eq!(
            config.android.queries,
            [r#"<package android:name="com.singular.sdk"/>"#]
        );
        assert_eq!(config.android.application.len(), 1);
        let (config, ignored) =
            parse_config(r#"{ "android": { "queries": "<package android:name=\"a\"/>" } }"#)
                .unwrap();
        assert!(config.android.queries.is_empty());
        assert!(
            ignored.len() == 1 && ignored[0].starts_with("android.queries"),
            "{ignored:?}"
        );
        // Read from the app: an entry that is not one element of those
        // allowed is left out, never an error, and the rest is kept.
        let dir = std::env::temp_dir().join(format!(
            "nsh-cli-android-elements-config-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("nsh.json"),
            r#"{ "android": {
                "queries": ["<service android:name=\"a.B\"/>", "<package android:name=\"com.example.wallet\"/>"],
                "application": ["<receiver android:name=\"a.Boot\" android:exported=\"false\"/></application><application>"]
            } }"#,
        )
        .unwrap();
        let config = read_config(&dir.join("App.tsx")).unwrap();
        assert_eq!(
            config.android.queries,
            [r#"<package android:name="com.example.wallet"/>"#]
        );
        assert!(config.android.application.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
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
    fn android_libraries_are_relative_to_nsh_json() {
        let dir = std::env::temp_dir().join(format!(
            "nsh-cli-android-libraries-config-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("nsh.json"),
            r#"{ "android": { "libraries": ["android/libs/sdk.jar", "java/out/classes.dex"] } }"#,
        )
        .unwrap();
        let config = read_config(&dir.join("App.tsx")).unwrap();
        let libraries: Vec<(PathBuf, &str)> = config
            .android
            .libraries
            .iter()
            .map(|l| (l.path.clone(), l.listed.as_str()))
            .collect();
        assert_eq!(
            libraries,
            [
                (
                    dir.join("android/libs/sdk.jar"),
                    "nsh.json `android.libraries`"
                ),
                (
                    dir.join("java/out/classes.dex"),
                    "nsh.json `android.libraries`"
                ),
            ]
        );
        assert!(
            serde_json::from_value::<AppConfig>(serde_json::json!({}))
                .unwrap()
                .android
                .libraries
                .is_empty()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ios_extensions_are_relative_to_nsh_json() {
        let dir = std::env::temp_dir().join(format!(
            "nsh-cli-ios-extensions-config-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("nsh.json"),
            r#"{ "ios": { "extensions": [
                { "path": "ios/Widget.appex", "simulatorPath": "ios/sim/Widget.appex",
                  "entitlements": { "com.apple.security.application-groups": ["group.com.example"] } },
                { "path": "ios/Service.appex" }
            ] } }"#,
        )
        .unwrap();
        let config = read_config(&dir.join("App.tsx")).unwrap();
        let extensions = &config.ios.extensions;
        assert_eq!(extensions.len(), 2);
        assert_eq!(extensions[0].path, dir.join("ios/Widget.appex"));
        assert_eq!(
            extensions[0].simulator_path.as_deref(),
            Some(dir.join("ios/sim/Widget.appex").as_path())
        );
        assert_eq!(extensions[1].simulator_path, None);
        let (entitlements, section) =
            crate::apple::extension_entitlements(&extensions[0], ApplePlatform::Ios).unwrap();
        assert_eq!(section, "ios.extensions[0].entitlements");
        assert!(entitlements.contains_key("com.apple.security.application-groups"));
        assert!(
            crate::apple::extension_entitlements(&extensions[1], ApplePlatform::Ios)
                .unwrap()
                .0
                .is_empty()
        );

        // An extension's identity is NSH's to sign, as the app's is.
        std::fs::write(
            dir.join("nsh.json"),
            r#"{ "ios": { "extensions": [
                { "path": "Widget.appex", "entitlements": { "application-identifier": "T.x" } }
            ] } }"#,
        )
        .unwrap();
        let error = read_config(&dir.join("App.tsx")).unwrap_err().to_string();
        assert!(
            error.contains("ios.extensions[0].entitlements: `application-identifier`"),
            "{error}"
        );

        // An entry left out keeps the next one's index as the app wrote it.
        std::fs::write(
            dir.join("nsh.json"),
            r#"{ "ios": { "extensions": [
                { "simulatorPath": "sim/A.appex" },
                { "path": "B.appex", "entitlements": { "application-identifier": "T.x" } }
            ] } }"#,
        )
        .unwrap();
        let error = read_config(&dir.join("App.tsx")).unwrap_err().to_string();
        assert!(
            error.contains("ios.extensions[1].entitlements: `application-identifier`"),
            "{error}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn macos_extensions_are_relative_to_nsh_json() {
        let dir = std::env::temp_dir().join(format!(
            "nsh-cli-macos-extensions-config-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("nsh.json"),
            r#"{ "macos": { "extensions": [
                { "path": "macos/Widgets.appex", "simulatorPath": "macos/sim/Widgets.appex",
                  "entitlements": {
                    "com.apple.security.app-sandbox": true,
                    "com.apple.security.application-groups": ["TEAM123456.com.example.widgets"]
                  } },
                { "path": "macos/Share.appex" }
            ] } }"#,
        )
        .unwrap();
        let config = read_config(&dir.join("App.tsx")).unwrap();
        let extensions = &config.macos.extensions;
        assert_eq!(extensions.len(), 2);
        assert_eq!(extensions[0].path, dir.join("macos/Widgets.appex"));
        assert_eq!(extensions[0].simulator_path, None);
        let (entitlements, section) =
            crate::apple::extension_entitlements(&extensions[0], ApplePlatform::Macos).unwrap();
        assert_eq!(section, "macos.extensions[0].entitlements");
        assert!(entitlements.contains_key("com.apple.security.app-sandbox"));
        assert!(entitlements.contains_key("com.apple.security.application-groups"));
        assert!(
            crate::apple::extension_entitlements(&extensions[1], ApplePlatform::Macos)
                .unwrap()
                .0
                .is_empty()
        );

        // An extension's identity is NSH's to sign, as the app's is.
        std::fs::write(
            dir.join("nsh.json"),
            r#"{ "macos": { "extensions": [
                { "path": "Widgets.appex", "entitlements": { "application-identifier": "T.x" } }
            ] } }"#,
        )
        .unwrap();
        let error = read_config(&dir.join("App.tsx")).unwrap_err().to_string();
        assert!(
            error.contains("macos.extensions[0].entitlements: `application-identifier`"),
            "{error}"
        );

        // An entry left out keeps the next one's index as the app wrote it.
        std::fs::write(
            dir.join("nsh.json"),
            r#"{ "macos": { "extensions": [
                { "simulatorPath": "sim/A.appex" },
                { "path": "B.appex", "entitlements": { "application-identifier": "T.x" } }
            ] } }"#,
        )
        .unwrap();
        let error = read_config(&dir.join("App.tsx")).unwrap_err().to_string();
        assert!(
            error.contains("macos.extensions[1].entitlements: `application-identifier`"),
            "{error}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn codesign_macos_args_enables_hardened_runtime_for_certificates() {
        let app = Path::new("/tmp/Pulse.app");
        let ent = Path::new("/tmp/Pulse.entitlements");
        let to_strings = |args: Vec<OsString>| -> Vec<String> {
            args.into_iter()
                .map(|s| s.to_string_lossy().into_owned())
                .collect()
        };
        assert_eq!(
            to_strings(codesign_macos_args(app, "-", None)),
            [
                "--force",
                "--sign",
                "-",
                "--timestamp=none",
                "/tmp/Pulse.app"
            ]
        );
        assert_eq!(
            to_strings(codesign_macos_args(app, "-", Some(ent))),
            [
                "--force",
                "--sign",
                "-",
                "--timestamp=none",
                "--entitlements",
                "/tmp/Pulse.entitlements",
                "/tmp/Pulse.app",
            ]
        );
        let id = "Developer ID Application: Example (TEAM123456)";
        assert_eq!(
            to_strings(codesign_macos_args(app, id, None)),
            [
                "--force",
                "--sign",
                id,
                "--options",
                "runtime",
                "--timestamp",
                "/tmp/Pulse.app",
            ]
        );
        assert_eq!(
            to_strings(codesign_macos_args(app, id, Some(ent))),
            [
                "--force",
                "--sign",
                id,
                "--options",
                "runtime",
                "--timestamp",
                "--entitlements",
                "/tmp/Pulse.entitlements",
                "/tmp/Pulse.app",
            ]
        );
    }

    #[test]
    fn android_permissions_are_spelled_out_and_checked() {
        let permissions = |json: serde_json::Value| {
            serde_json::from_value::<AppConfig>(json)
                .unwrap()
                .android
                .permissions()
        };
        assert!(permissions(serde_json::json!({})).unwrap().is_empty());
        assert_eq!(
            permissions(serde_json::json!({ "android": { "permissions": [
                "ACCESS_NETWORK_STATE",
                "com.example.permission.READ_ORDERS"
            ] } }))
            .unwrap(),
            [
                "android.permission.ACCESS_NETWORK_STATE",
                "com.example.permission.READ_ORDERS"
            ]
        );
        // Only a name reaches the manifest: no markup, no empty part.
        for bad in [
            "",
            "ACCESS NETWORK",
            "A\" /><uses-permission android:name=\"B",
            "com..example",
            "com.example.",
            "1PERMISSION",
        ] {
            let err = permissions(serde_json::json!({ "android": { "permissions": [bad] } }))
                .unwrap_err()
                .to_string();
            assert!(err.contains("android.permissions"), "{bad}: {err}");
        }
        // A bare name in lower case is warned of; a dotted one is the app's.
        assert!(lower_case_android_name("access_network_state"));
        assert!(!lower_case_android_name("ACCESS_NETWORK_STATE"));
        assert!(!lower_case_android_name("com.example.permission.read"));
    }

    #[test]
    fn the_speech_capability_adds_no_usage_description() {
        // Recognizing speech is `nsh-extra`'s `speech`, whose crate
        // declares its usage descriptions: the capability alone (or no
        // declaration) adds none.
        for capabilities in [None, Some(serde_json::json!({ "speech": true }))] {
            let config = AppConfig {
                capabilities,
                ..AppConfig::default()
            };
            for info in [
                macos_info_plist("A", "com.a", "a", &config, false).unwrap(),
                info_plist("A", "com.a", "a", &config, "iphoneos").unwrap(),
            ] {
                assert!(!info.contains_key("NSSpeechRecognitionUsageDescription"));
                assert!(!info.contains_key("NSMicrophoneUsageDescription"));
            }
        }
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
        // The languages the `Info.plist` strings have text in join them:
        // English stays the language of the users the app has no strings
        // for. A language without text has no `.lproj`: not declared.
        let strings = r#"{ "zh-Hans": { "CFBundleDisplayName": "甲" }, "ja": {}, "ko": {} }"#;
        fs::write(
            dir.join("nsh.json"),
            format!(
                r#"{{
                    "locales": ["ja"],
                    "ios": {{ "infoPlistStrings": {strings} }},
                    "macos": {{ "infoPlistStrings": {strings} }}
                }}"#
            ),
        )
        .unwrap();
        let config = read_config(&dir.join("App.tsx")).unwrap();
        assert_eq!(declared(&config).unwrap(), ["en", "ja", "zh-Hans"]);
        // Without translations or `locales`, an empty language alone
        // declares nothing.
        fs::remove_dir_all(dir.join("locales")).unwrap();
        fs::write(
            dir.join("nsh.json"),
            r#"{ "ios": { "infoPlistStrings": { "ko": {} } }, "macos": { "infoPlistStrings": { "ko": {} } } }"#,
        )
        .unwrap();
        let config = read_config(&dir.join("App.tsx")).unwrap();
        assert_eq!(declared(&config), None);
        let _ = fs::remove_dir_all(&dir);
    }

    /// `ios.infoPlistStrings` translates the `Info.plist` packages write,
    /// NSH's keys among them (the app's name, the usage descriptions NSH
    /// adds), and only those it has as strings.
    #[test]
    fn apps_translate_their_info_plist() {
        let config: AppConfig = serde_json::from_value(serde_json::json!({
            "capabilities": { "webview": { "hosts": ["*"], "media": ["camera"] } },
            "ios": {
                "infoPlist": { "NSLocationWhenInUseUsageDescription": "Shows nearby stores." },
                "infoPlistStrings": { "zh-Hans": {
                    "CFBundleDisplayName": "示例",
                    "NSCameraUsageDescription": "网页使用相机。",
                    "NSLocationWhenInUseUsageDescription": "显示附近的门店。"
                } }
            },
            "macos": { "infoPlistStrings": { "de": { "NSCameraUsageDescription": "Kamera." } } }
        }))
        .unwrap();
        let ios = info_plist("A", "com.a", "a", &config, "iphoneos").unwrap();
        let files = config.ios.localized_info(ApplePlatform::Ios, &ios).unwrap();
        assert_eq!(
            files["zh-Hans"],
            "\"CFBundleDisplayName\" = \"示例\";\n\
             \"NSCameraUsageDescription\" = \"网页使用相机。\";\n\
             \"NSLocationWhenInUseUsageDescription\" = \"显示附近的门店。\";\n"
        );
        let macos = macos_info_plist("A", "com.a", "a", &config, false).unwrap();
        assert_eq!(
            config.macos.localized_info(&macos).unwrap()["de"],
            "\"NSCameraUsageDescription\" = \"Kamera.\";\n"
        );
        // Finder shows a translated name only with `LSHasLocalizedDisplayName`,
        // written when the app's name is translated.
        assert!(!macos.contains_key("LSHasLocalizedDisplayName"));
        let named: AppConfig = serde_json::from_value(serde_json::json!({
            "macos": { "infoPlistStrings": { "de": { "CFBundleDisplayName": "Beispiel" } } }
        }))
        .unwrap();
        let macos = macos_info_plist("A", "com.a", "a", &named, false).unwrap();
        assert_eq!(
            macos.get("LSHasLocalizedDisplayName"),
            Some(&plist::Value::Boolean(true))
        );
        // Without the media capture, the package has no camera usage
        // description to translate.
        let config = AppConfig {
            capabilities: None,
            ..config
        };
        let ios = info_plist("A", "com.a", "a", &config, "iphoneos").unwrap();
        let error = config
            .ios
            .localized_info(ApplePlatform::Ios, &ios)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(
                "ios.infoPlistStrings.zh-Hans.NSCameraUsageDescription: the app's Info.plist has no"
            ),
            "{error}"
        );
    }

    #[test]
    fn apps_claim_their_url_schemes_in_the_package() {
        let config: AppConfig =
            serde_json::from_str(r#"{ "schemes": ["MyApp", "myapp-dev"] }"#).unwrap();
        let schemes = config.app_links().schemes().to_vec();
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
            &config.app_links(),
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
            app_json(
                serde_json::json!({ "id": "com.a" }),
                &Default::default(),
                None
            ),
            r#"{"id":"com.a"}"#
        );
        // Schemes of the system and other apps are left out.
        let config: AppConfig =
            serde_json::from_str(r#"{ "schemes": ["https", "myapp"] }"#).unwrap();
        assert_eq!(config.app_links().schemes(), ["myapp"]);
    }

    #[test]
    fn apps_claim_their_web_links_in_the_package() {
        let config: AppConfig = serde_json::from_str(
            r#"{
                "schemes": ["MyApp"],
                "links": [
                    { "host": "Example.com", "paths": ["/orders/*"] },
                    { "host": "*.shop.example" },
                    { "host": "new.example", "exclude": ["/admin/*"] },
                    { "host": "https://x.test" }
                ]
            }"#,
        )
        .unwrap();
        // Checked, lower case, those it cannot read whole left out.
        let links = config.app_links();
        assert_eq!(links.schemes(), ["myapp"]);
        let hosts: Vec<_> = links.web().iter().map(|l| l.host()).collect();
        assert_eq!(hosts, ["example.com", "*.shop.example"]);
        // iOS claims their hosts after the app's own associated domains...
        let mut entitlements = plist::Dictionary::new();
        entitlements.insert(
            "com.apple.developer.associated-domains".into(),
            plist::Value::Array(vec![
                "webcredentials:example.com".into(),
                "applinks:example.com".into(),
            ]),
        );
        config.add_links_to_entitlements(&mut entitlements).unwrap();
        let claimed: Vec<_> = entitlements["com.apple.developer.associated-domains"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(plist::Value::as_string)
            .collect();
        assert_eq!(
            claimed,
            [
                "webcredentials:example.com",
                "applinks:example.com",
                "applinks:*.shop.example"
            ]
        );
        // ...refuses to guess at a value of another form...
        let mut wrong = plist::Dictionary::new();
        wrong.insert(
            "com.apple.developer.associated-domains".into(),
            "applinks:example.com".into(),
        );
        assert!(config.add_links_to_entitlements(&mut wrong).is_err());
        // ...and the runner lets them through, paths and all.
        let json: serde_json::Value = serde_json::from_str(&app_json(
            serde_json::json!({ "id": "com.a" }),
            &links,
            None,
        ))
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "com.a",
                "schemes": ["myapp"],
                "links": [
                    { "host": "example.com", "paths": ["/orders/*"] },
                    { "host": "*.shop.example" }
                ]
            })
        );
        assert_eq!(nsh_core::url_scheme::AppLinks::from_json(&json), links);
        // An app that claims none adds nothing.
        let mut entitlements = plist::Dictionary::new();
        AppConfig::default()
            .add_links_to_entitlements(&mut entitlements)
            .unwrap();
        assert!(entitlements.is_empty());
    }

    #[test]
    fn handoff_declares_the_apps_activity_type() {
        let types = |json: &str| {
            let config: AppConfig = serde_json::from_str(json).unwrap();
            let mut info = info_plist("A", "com.a", "a", &config, "iphoneos").unwrap();
            activity_types(&mut info, "com.a", config.handoff);
            info.get("NSUserActivityTypes").map(|types| {
                types
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(plist::Value::as_string)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
        };
        // Off by default: nothing declared, so the runner gives nothing.
        assert_eq!(types("{}"), None);
        assert_eq!(types(r#"{ "handoff": true }"#).unwrap(), ["com.a.url"]);
        // After the app's own types, once.
        let own = r#"{ "handoff": true, "ios": { "infoPlist": { "NSUserActivityTypes": ["com.a.edit", "com.a.url"] } } }"#;
        assert_eq!(types(own).unwrap(), ["com.a.edit", "com.a.url"]);
    }

    #[test]
    fn desktop_packages_carry_the_main_windows_options() {
        let config: AppConfig = serde_json::from_str(
            r#"{ "appearance": "dark", "window": { "title": "Focus", "closeOnPress": false }, "application": { "quitMode": "explicit" } }"#,
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
                "application": { "quitMode": "explicit" },
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
    fn an_apps_data_dir_goes_into_app_json() {
        let config: AppConfig =
            serde_json::from_str(r#"{ "dataDir": "${homeDir}/.myapp" }"#).unwrap();
        let info = desktop_app_json(&config, "A", "com.a", "1.0.0");
        assert_eq!(info["dataDir"], serde_json::json!("${homeDir}/.myapp"));
        let info = desktop_app_json(&AppConfig::default(), "A", "com.a", "1.0.0");
        assert!(info.get("dataDir").is_none());
    }

    #[test]
    fn a_data_dir_the_runner_would_refuse_is_dropped() {
        let dir = std::env::temp_dir().join(format!("nsh-data-dir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let entry = dir.join("App.tsx");
        for (value, kept) in [
            ("${homeDir}/.myapp", true),
            (".myapp", false),
            ("${homeDir}/../elsewhere", false),
            ("${appId}/data", false),
        ] {
            std::fs::write(
                dir.join("nsh.json"),
                serde_json::json!({ "dataDir": value }).to_string(),
            )
            .unwrap();
            let config = read_config(&entry).unwrap();
            assert_eq!(config.data_dir.is_some(), kept, "{value}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_apps_log_dir_goes_into_app_json() {
        let config: AppConfig =
            serde_json::from_str(r#"{ "logDir": "${homeDir}/.myapp/logs/ui" }"#).unwrap();
        let info = desktop_app_json(&config, "A", "com.a", "1.0.0");
        assert_eq!(
            info["logDir"],
            serde_json::json!("${homeDir}/.myapp/logs/ui")
        );
        let info = desktop_app_json(&AppConfig::default(), "A", "com.a", "1.0.0");
        assert!(info.get("logDir").is_none());
    }

    #[test]
    fn a_log_dir_the_runner_would_refuse_is_dropped() {
        let dir = std::env::temp_dir().join(format!("nsh-log-dir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let entry = dir.join("App.tsx");
        for (value, kept) in [
            ("${homeDir}/.myapp/logs", true),
            ("logs", false),
            ("${homeDir}/../elsewhere", false),
            ("${appId}/logs", false),
        ] {
            std::fs::write(
                dir.join("nsh.json"),
                serde_json::json!({ "logDir": value }).to_string(),
            )
            .unwrap();
            let config = read_config(&entry).unwrap();
            assert_eq!(config.log_dir.is_some(), kept, "{value}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
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
                    ("macos".to_owned(), PlatformIcon::Image(dir.join("mac.png"))),
                    (
                        "windows".to_owned(),
                        PlatformIcon::Image(dir.join("win.png"))
                    ),
                ]
                .into()
            ))
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn nsh_json_android_icon_may_be_adaptive() {
        let dir =
            std::env::temp_dir().join(format!("nsh-adaptive-icon-config-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let entry = dir.join("app.tsx");
        fs::write(
            dir.join("nsh.json"),
            r##"{ "icon": {
                "ios": "ios.png",
                "android": { "foreground": "fg.png", "background": "#ffffff", "monochrome": "mono.png", "inset": 1 },
                "macos": { "foreground": "fg.png", "background": "#ffffff" }
            } }"##,
        )
        .unwrap();
        let config = read_config(&entry).unwrap();
        let Some(android::Icon::Adaptive(icon)) = config.android_icon() else {
            panic!("{:?}", config.icon);
        };
        assert_eq!(icon.foreground, dir.join("fg.png"));
        assert_eq!(
            icon.background,
            android::IconBackground::Color(crate::apple::Color([255, 255, 255, 255]))
        );
        assert_eq!(icon.monochrome, Some(dir.join("mono.png")));
        // No PNG for the targets that take one.
        assert_eq!(config.icon(PackageTarget::Android), None);
        // Android's only: macOS gets none, the other platforms keep theirs.
        assert_eq!(config.icon(PackageTarget::Macos), None);
        assert_eq!(
            config.icon(PackageTarget::Ios),
            Some(dir.join("ios.png").as_path())
        );

        // A background image is relative to `nsh.json`; a malformed color
        // leaves Android without an icon, the other platforms with theirs.
        fs::write(
            dir.join("nsh.json"),
            r##"{ "icon": { "android": { "foreground": "fg.png", "background": "bg.png" } } }"##,
        )
        .unwrap();
        let config = read_config(&entry).unwrap();
        let Some(android::Icon::Adaptive(icon)) = config.android_icon() else {
            panic!("{:?}", config.icon);
        };
        assert_eq!(
            icon.background,
            android::IconBackground::Image(dir.join("bg.png"))
        );
        fs::write(
            dir.join("nsh.json"),
            r##"{ "icon": { "ios": "ios.png", "android": { "foreground": "fg.png", "background": "#fff" } } }"##,
        )
        .unwrap();
        let config = read_config(&entry).unwrap();
        assert!(config.android_icon().is_none());
        assert_eq!(
            config.icon(PackageTarget::Ios),
            Some(dir.join("ios.png").as_path())
        );

        // One PNG for Android stays one.
        fs::write(
            dir.join("nsh.json"),
            r#"{ "icon": { "android": "icon.png" } }"#,
        )
        .unwrap();
        let config = read_config(&entry).unwrap();
        assert!(
            matches!(config.android_icon(), Some(android::Icon::Image(path)) if path == dir.join("icon.png"))
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The macOS development host gets the app's macOS icon, after its
    /// activation policy; an app without one gets none.
    #[test]
    fn the_macos_host_gets_the_apps_icon() {
        let dir = std::env::temp_dir().join(format!("nsh-macos-host-icon-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let entry = dir.join("app.tsx");
        let args = |json: &str| {
            fs::write(dir.join("nsh.json"), json).unwrap();
            read_config(&entry).unwrap().macos_host_args()
        };
        let icon = |name: &str| OsString::from(dir.join(name));
        assert!(args("{}").is_empty());
        assert!(args(r#"{ "icon": { "windows": "win.png" } }"#).is_empty());
        assert_eq!(
            args(r#"{ "icon": "icon.png" }"#),
            [OsString::from("--icon"), icon("icon.png")]
        );
        assert_eq!(
            args(
                r#"{ "icon": { "macos": "mac.png", "windows": "win.png" },
                     "macos": { "activationPolicy": "accessory" } }"#
            ),
            [
                OsString::from("--activation-policy"),
                "accessory".into(),
                "--icon".into(),
                icon("mac.png"),
            ]
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

    /// What crates declare is read for the Rust targets a package is built
    /// for: each architecture of a macOS one.
    #[test]
    fn crates_are_read_for_every_target_a_package_builds() {
        use crate::module_meta::Platform;
        let read = |target: PackageTarget, arch| target.module_meta_triples(arch);
        assert_eq!(
            read(PackageTarget::Macos, Some(Arch::Universal)),
            Some((&[MACOS_ARM64, MACOS_X86_64][..], Platform::Macos))
        );
        assert_eq!(
            read(PackageTarget::Macos, Some(Arch::X86_64)),
            Some((&[MACOS_X86_64][..], Platform::Macos))
        );
        assert_eq!(
            read(PackageTarget::Macos, None),
            Some((Arch::native().macos_triples(), Platform::Macos))
        );
        assert_eq!(
            read(PackageTarget::Ios, None),
            Some((&["aarch64-apple-ios"][..], Platform::Ios))
        );
        assert_eq!(read(PackageTarget::Windows, None), None);
    }

    /// A crate's macOS translation reaches the package's `InfoPlist.strings`
    /// for the app's languages.
    #[test]
    fn crates_macos_translations_reach_the_package() {
        use crate::module_meta::{ModuleMeta, Platform};
        let mut meta = ModuleMeta::default();
        meta.macos_info.insert(
            "NSBluetoothAlwaysUsageDescription".into(),
            serde_json::json!("Connects to peripherals."),
        );
        meta.macos_strings.insert(
            "zh-Hans".into(),
            serde_json::json!({ "NSBluetoothAlwaysUsageDescription": "连接外设。" }),
        );
        let mut config = AppConfig {
            localizations: vec!["zh-Hans".into()],
            ..Default::default()
        };
        meta.apply(&mut config, Platform::Macos).unwrap();
        config.macos.check().unwrap();
        let info = macos_info_plist("Demo", "com.example.demo", "Demo", &config, false).unwrap();
        let localized = config.macos.localized_info(&info).unwrap();
        assert!(
            localized["zh-Hans"]
                .contains("\"NSBluetoothAlwaysUsageDescription\" = \"连接外设。\";"),
            "{localized:?}"
        );
    }

    #[test]
    fn macos_package_merges_and_checks_module_metadata() {
        assert_eq!(
            PackageTarget::Macos.module_meta_triples(None),
            Some((
                Arch::native().macos_triples(),
                crate::module_meta::Platform::Macos
            ))
        );
        let mut config = AppConfig::default();
        let mut meta = crate::module_meta::ModuleMeta::default();
        meta.macos_info.insert(
            "NSBluetoothAlwaysUsageDescription".into(),
            serde_json::json!("Connects to peripherals."),
        );
        meta.macos_info
            .insert("LSMinimumSystemVersion".into(), serde_json::json!("15.0"));
        meta.macos_entitlements.insert(
            "com.apple.security.network.client".into(),
            serde_json::json!(true),
        );
        meta.apply(&mut config, crate::module_meta::Platform::Macos)
            .unwrap();
        config.macos.check().unwrap();
        let info = macos_info_plist("Demo", "com.example.demo", "Demo", &config, false).unwrap();
        assert_eq!(
            info["NSBluetoothAlwaysUsageDescription"],
            plist::Value::String("Connects to peripherals.".into())
        );
        assert_eq!(
            info["LSMinimumSystemVersion"],
            plist::Value::String("15.0".into())
        );
        let entitlements = config.macos.entitlements().unwrap();
        assert_eq!(
            entitlements["com.apple.security.network.client"],
            plist::Value::Boolean(true)
        );

        // An invalid merged minimum macOS version is caught by `config.macos.check()`.
        let mut bad_config = AppConfig::default();
        let mut bad_meta = crate::module_meta::ModuleMeta::default();
        bad_meta
            .macos_info
            .insert("LSMinimumSystemVersion".into(), serde_json::json!("13.0"));
        bad_meta
            .apply(&mut bad_config, crate::module_meta::Platform::Macos)
            .unwrap();
        let error = bad_config.macos.check().unwrap_err().to_string();
        assert!(
            error.contains("macos.infoPlist.LSMinimumSystemVersion: \"13.0\" is below"),
            "{error}"
        );
    }
}
