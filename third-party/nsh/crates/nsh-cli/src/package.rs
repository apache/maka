//! `nsh package`: builds an installable app from the prebuilt runtime, the
//! app bundle and its assets. Needs no Rust; iOS packaging uses Xcode's
//! command line tools (`codesign`, and `actool` for icons), macOS packaging
//! `codesign` and `sips`, Linux packaging `tar`; Windows packaging needs
//! nothing (`windows.rs`), nor does the web's (`web.rs`). Each desktop OS
//! packages with its native backend's runner; GPUI is the backend for
//! embedding in GPUI apps and has no package of its own.
//! Terminal apps use a console runner and resources archived as `.tar.gz`
//! on Unix and `.zip` on Windows.

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use anyhow::{Context as _, bail};
use serde::Deserialize;

use crate::{
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
    /// A terminal: a console executable and resources, archived for this OS.
    Tui,
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

/// App metadata: `nsh.json` next to the entry, overridden by flags.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AppConfig {
    /// Display name.
    pub(crate) name: Option<String>,
    /// Bundle identifier (`com.example.app`).
    pub(crate) id: Option<String>,
    /// User-visible version (`1.2.0`).
    pub(crate) version: Option<String>,
    /// Build number.
    pub(crate) build: Option<u32>,
    /// App icon: a square PNG, ideally 1024×1024, relative to `nsh.json`.
    pub(crate) icon: Option<PathBuf>,
    /// The lowest runtime that runs a signed package (`nsh publish`).
    pub(crate) min_runtime: Option<String>,
    /// Read and checked by the bundler.
    #[serde(default, rename = "tailwind")]
    _tailwind: Option<serde::de::IgnoredAny>,
    /// Read and checked by the bundler.
    #[serde(default, rename = "capabilities")]
    _capabilities: Option<serde::de::IgnoredAny>,
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
    _theme: Option<serde::de::IgnoredAny>,
    /// Read and checked by the bundler.
    #[serde(default, rename = "resolve")]
    _resolve: Option<serde::de::IgnoredAny>,
    /// The app's Rust crate: its builds are the app's own (`rust_app.rs`).
    #[serde(default, rename = "rust")]
    _rust: Option<serde::de::IgnoredAny>,
    /// A Rust app's root component in its crate (`rust_app::RootConfig`).
    #[serde(default, rename = "root")]
    _root: Option<serde::de::IgnoredAny>,
    /// What the web's packages add to the page (`web.rs`).
    #[serde(default)]
    pub(crate) web: WebConfig,
}

/// `nsh.json` `"web"`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    /// Install and launch in the simulator or on the device afterwards
    /// (Linux, macOS, Windows: launch it; the web: serve it and open it in
    /// the browser).
    pub(crate) run: bool,
}

/// Reads `nsh.json` next to `entry`, if any; relative paths become absolute.
pub(crate) fn read_config(entry: &Path) -> anyhow::Result<AppConfig> {
    let dir = entry.parent().unwrap_or(Path::new("."));
    let path = dir.join("nsh.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(AppConfig::default());
    };
    let mut config: AppConfig =
        serde_json::from_str(&text).with_context(|| format!("invalid {}", path.display()))?;
    config.icon = config.icon.map(|icon| dir.join(icon));
    config.web.host = config.web.host.map(|host| dir.join(host));
    Ok(config)
}

/// `nsh.json` `web.host` (`read_config` made it absolute), canonical: the
/// file must be inside the app's directory, symbolic links resolved, as the
/// page ships it as it is.
pub(crate) fn web_host_module(entry: &Path, host: &Path) -> anyhow::Result<PathBuf> {
    let dir = dunce::canonicalize(entry.parent().unwrap_or(Path::new(".")))
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
    let entry = dunce::canonicalize(options.entry)?;
    let config = &options.config;
    let (name, id) = release_name_and_id(&entry, config)?;
    let executable: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let executable = if executable.is_empty() {
        "App".to_owned()
    } else {
        executable
    };

    // Web apps load what `import()` brings in when it is used; native
    // packages are one bundle. A Rust app has none: its runner mounts its
    // root (`rust_app::RustApp::runtime`).
    let built = if crate::rust_app::is_root(&entry) {
        crate::build::rust_root()
    } else {
        let compile = match options.target {
            PackageTarget::Web => crate::build::compile_split,
            _ => crate::build::compile,
        };
        let built = compile(&entry, true).map_err(|e| e.into_error(&entry))?;
        ui::done(format!("built {} {}", ui::path(&entry), built.summary("")));
        built
    };
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
        PackageTarget::Tui => {
            return crate::tui::package(&options, config, &name, &id, &executable, &built);
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
    // The app's id, which names where it keeps its data (`Bundle::read`).
    fs::write(
        resources.join("app.json"),
        serde_json::json!({ "id": id }).to_string(),
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
        | PackageTarget::Gpui
        | PackageTarget::Tui => "iphonesimulator",
    };
    let mut info = info_plist(&name, &id, &executable, config, sdk);
    if let Some(icon) = &config.icon {
        let partial = compile_icon(icon, &app, sdk)?;
        for (key, value) in partial {
            info.insert(key, value);
        }
    }
    plist::Value::Dictionary(info).to_file_xml(app.join("Info.plist"))?;

    match options.target {
        PackageTarget::IosSimulator => {
            codesign(&app, "-", None)?;
            ui::done(format!("packaged {}", ui::path(&app)));
            if options.run {
                let udid = crate::run::simulator(None)?;
                let step = ui::Step::start(format!("installing {id} in the simulator"));
                crate::run::simctl(&["install", &udid, &app.to_string_lossy()])?;
                crate::run::simctl(&["launch", "--terminate-running-process", &udid, &id])?;
                step.done(format!("launched {id} in the simulator"));
            }
        }
        PackageTarget::Android
        | PackageTarget::Linux
        | PackageTarget::Macos
        | PackageTarget::Windows
        | PackageTarget::Web
        | PackageTarget::Gpui
        | PackageTarget::Tui => {
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
            let entitlements = entitlements(profile, &id)?;
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
    let runtime = runtime::android(false)?;
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
        serde_json::json!({ "id": id }).to_string().into_bytes(),
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
    let apk_path = options.out.join(format!("{name}.apk"));
    let version = config.version.as_deref().unwrap_or("1.0.0");
    let step = ui::Step::start(format!("packaging {}", ui::path(&apk_path)));
    android::build_apk(
        &sdk,
        &Apk {
            package: id,
            label: name,
            version_name: version,
            version_code: config.build.unwrap_or(1),
            activity: "com.longbridge.nsh.AppActivity",
            dev: false,
            rust: built.rust_root,
            dark: config.appearance.as_deref() == Some("dark"),
            runtime: &runtime,
            icon: config.icon.as_deref(),
            assets,
            signing,
        },
        &apk_path,
    )?;
    step.done(format!("packaged {}", ui::path(&apk_path)));
    if options.run {
        let serial = android::device(&sdk)?;
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
/// `nsh/app.json` (the window's title, the application id and the app's
/// appearance, which the window opens in), a
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
    let mut info = serde_json::json!({ "name": name, "id": id, "version": version });
    if let Some(appearance) = &config.appearance {
        info["appearance"] = appearance.as_str().into();
    }
    fs::write(resources.join("app.json"), info.to_string())?;
    if let Some(icon) = &config.icon {
        fs::copy(icon, dir.join(format!("{id}.png")))
            .with_context(|| format!("copy {}", icon.display()))?;
    }
    fs::write(
        dir.join(format!("{id}.desktop")),
        desktop_entry(name, id, executable, config.icon.is_some()),
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
    let runner = runtime::file(Platform::MacOs, true)?;
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
    fs::copy(&runner, macos.join(executable))
        .with_context(|| format!("copy {}", runner.display()))?;
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
    fs::write(nsh.join("app.json"), info.to_string())?;
    let icon = match &config.icon {
        Some(icon) => {
            macos_icns(icon, &resources.join("AppIcon.icns"))?;
            true
        }
        None => false,
    };
    plist::Value::Dictionary(macos_info_plist(name, id, executable, config, icon))
        .to_file_xml(contents.join("Info.plist"))
        .context("write Info.plist")?;
    let output = Command::new("codesign")
        .args(["--force", "--sign", "-", "--timestamp=none"])
        .arg(&app)
        .output()
        .context("run codesign")?;
    if !output.status.success() {
        bail!(
            "codesign failed for {}: {}",
            app.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
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
) -> plist::Dictionary {
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
    d.insert("LSMinimumSystemVersion".into(), s(MACOS_MINIMUM));
    d.insert("NSHighResolutionCapable".into(), true.into());
    d.insert("NSPrincipalClass".into(), s("NSApplication"));
    if icon {
        d.insert("CFBundleIconFile".into(), s("AppIcon"));
    }
    d
}

/// The oldest macOS the AppKit runtime runs on (its display links are
/// `NSView`'s, new in macOS 14).
const MACOS_MINIMUM: &str = "14.0";

/// The app's desktop entry. Desktops match windows to it by the file's
/// name and `StartupWMClass`, which GTK sets from the application id.
/// `Exec` names the executable on the `PATH` (install the package
/// directory, or a link to the executable, there).
fn desktop_entry(name: &str, id: &str, executable: &str, icon: bool) -> String {
    let icon = if icon {
        format!("Icon={id}\n")
    } else {
        String::new()
    };
    format!(
        "[Desktop Entry]\nType=Application\nName={name}\nExec={executable}\n{icon}StartupWMClass={id}\nTerminal=false\nCategories=Utility;\n"
    )
}

fn info_plist(
    name: &str,
    id: &str,
    executable: &str,
    config: &AppConfig,
    sdk: &str,
) -> plist::Dictionary {
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
    d.insert("MinimumOSVersion".into(), s(MINIMUM_OS));
    d.insert(
        "UIDeviceFamily".into(),
        Value::Array(vec![1.into(), 2.into()]),
    );
    d.insert("LSRequiresIPhoneOS".into(), true.into());
    // A launch screen entry opts into the full screen (no letterboxing).
    d.insert(
        "UILaunchScreen".into(),
        Value::Dictionary(Default::default()),
    );
    d.insert("UIApplicationSupportsMultipleScenes".into(), false.into());
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
        .and_then(|v| nsh_core::StatusBarSetting::from_json(v).ok())
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
    d
}

/// The deployment target the runtime is built for (`cargo xtask dist`).
const MINIMUM_OS: &str = "15.0";

/// Compiles `icon` into the app's asset catalog (`Assets.car`) with
/// `actool`, returning the Info.plist keys it produces.
fn compile_icon(icon: &Path, app: &Path, sdk: &str) -> anyhow::Result<plist::Dictionary> {
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
        .args(["--platform", sdk, "--minimum-deployment-target", MINIMUM_OS])
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

/// The entitlements a provisioning profile grants, checked against `id`.
fn entitlements(profile: &Path, id: &str) -> anyhow::Result<plist::Value> {
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
            desktop_entry("Counter", "com.example.counter", "Counter", true),
            "[Desktop Entry]\nType=Application\nName=Counter\nExec=Counter\n\
             Icon=com.example.counter\nStartupWMClass=com.example.counter\nTerminal=false\n\
             Categories=Utility;\n"
        );
        assert!(!desktop_entry("A", "com.example.a", "A", false).contains("Icon="));
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
