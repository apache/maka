//! Locates the prebuilt runtime: native executables and libraries that
//! apps are packaged with, so building an app never needs Rust.
//!
//! Distribution layout (`cargo xtask dist`), next to `bin/nsh`:
//!
//! ```text
//! runtime/ios/iphoneos/nsh-ios-app           release runner (device)
//! runtime/ios/iphonesimulator/nsh-ios-app    release runner (simulator)
//! runtime/ios/iphonesimulator/nsh-ios-host   development host (simulator)
//! runtime/ios/maccatalyst/nsh-ios-host       development host (Mac Catalyst)
//! runtime/linux/nsh-linux-host               development host (Linux, GTK)
//! runtime/linux/nsh-linux-app                release runner (Linux)
//! runtime/macos/nsh-macos-host               development host (macOS, AppKit)
//! runtime/macos/nsh-macos-app                release runner (macOS)
//! runtime/windows/nsh-windows-host.exe       development host (Windows)
//! runtime/windows/nsh-windows-app.exe        release runner (Windows)
//! runtime/gpui/nsh-gpui-host[.exe]           development host (GPUI, this OS)
//! runtime/android/release/             classes.dex + lib/<abi>/libnsh.so
//! runtime/android/dev/                 the same with development support
//! runtime/web/nsh.wasm                 the web runtime (`nsh-platform-web`)
//!                                      (`nsh-browser.wasm`: linkable, `nsh package` links each app's from it)
//! runtime/web/nsh.js                   the DOM runtime that loads it
//! runtime/web/nsh-syntaxes.bin         the syntaxes it fetches to highlight code
//! ```
//!
//! A release archive holds this machine's own runtime; the others are
//! components (`crate::component`), added the first time a command needs
//! them (or with `nsh component add`).
//!
//! In a cargo checkout, the same files come from `target/<triple>/<profile>`
//! (with the profile of this CLI; Linux's, macOS's, Windows' and GPUI's
//! from `target/<profile>`, as they are built for this machine), and are
//! built with cargo first, so a run never uses a missing or stale host.
//! The web runtime is always built with the `web` profile (a debug build is
//! several times larger and slower), into
//! `target/wasm32-unknown-unknown/web/`, its `nsh.js` read from the crate.
//! `NSH_RUNTIME` overrides the root. An app with a Rust crate of its own
//! gets hosts built for it instead (`rust_app.rs`).

use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context as _, bail};

/// The Rust target of the iOS simulator on this machine: the simulator runs
/// the processor of the Mac, so an Intel Mac's is x86_64. Which CLI runs here
/// decides, as a distribution is installed for the machine's own processor.
pub(crate) const IOS_SIMULATOR_TRIPLE: &str = if cfg!(target_arch = "x86_64") {
    "x86_64-apple-ios"
} else {
    "aarch64-apple-ios-sim"
};

/// The Rust target of Mac Catalyst on this machine, by its processor.
pub(crate) const MAC_CATALYST_TRIPLE: &str = if cfg!(target_arch = "x86_64") {
    "x86_64-apple-ios-macabi"
} else {
    "aarch64-apple-ios-macabi"
};

/// A runtime platform directory and its cargo target triple.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Platform {
    /// iOS devices.
    IphoneOs,
    /// The iOS simulator.
    IphoneSimulator,
    /// Mac Catalyst.
    MacCatalyst,
    /// Linux (GTK), on this machine.
    Linux,
    /// macOS (AppKit), on this machine.
    MacOs,
    /// Windows (Win32), on this machine.
    Windows,
    /// GPUI, on this machine (macOS, Windows or Linux): a development host
    /// only, as GPUI is the backend for embedding in GPUI apps.
    Gpui,
    /// The terminal host on this machine.
    Tui,
}

impl Platform {
    fn dir(self) -> &'static str {
        match self {
            Platform::IphoneOs => "ios/iphoneos",
            Platform::IphoneSimulator => "ios/iphonesimulator",
            Platform::MacCatalyst => "ios/maccatalyst",
            Platform::Linux => "linux",
            Platform::MacOs => "macos",
            Platform::Windows => "windows",
            Platform::Gpui => "gpui",
            Platform::Tui => "tui",
        }
    }

    /// The component of the distribution holding its runtime
    /// ([`crate::component`]); `None` for this machine's own, which the
    /// release archive holds.
    fn component(self) -> Option<&'static str> {
        match self {
            Platform::IphoneOs | Platform::IphoneSimulator | Platform::MacCatalyst => Some("ios"),
            Platform::Gpui => Some("gpui"),
            Platform::Tui => Some("tui"),
            Platform::Linux | Platform::MacOs | Platform::Windows => None,
        }
    }

    /// The cargo target triple (`None`: this machine's).
    pub(crate) fn triple(self) -> Option<&'static str> {
        match self {
            Platform::IphoneOs => Some("aarch64-apple-ios"),
            Platform::IphoneSimulator => Some(IOS_SIMULATOR_TRIPLE),
            Platform::MacCatalyst => Some(MAC_CATALYST_TRIPLE),
            // Packaged off Windows: cross-built ([`cross_build`]).
            Platform::Windows if !cfg!(windows) => Some(WINDOWS_TRIPLE),
            Platform::Linux
            | Platform::MacOs
            | Platform::Windows
            | Platform::Gpui
            | Platform::Tui => None,
        }
    }

    /// The development host (`runner` false) or release runner binary:
    /// its package, and its file without the executable suffix.
    pub(crate) fn binary(self, runner: bool) -> &'static str {
        match (self, runner) {
            (Platform::Linux, false) => "nsh-linux-host",
            (Platform::Linux, true) => "nsh-linux-app",
            (Platform::MacOs, false) => "nsh-macos-host",
            (Platform::MacOs, true) => "nsh-macos-app",
            (Platform::Windows, false) => "nsh-windows-host",
            (Platform::Windows, true) => "nsh-windows-app",
            (Platform::Tui, false) => "nsh-tui-host",
            (Platform::Tui, true) => "nsh-tui-app",
            (Platform::Gpui, false) => "nsh-gpui-host",
            (Platform::Gpui, true) => unreachable!("GPUI apps are embedded, never packaged"),
            (_, false) => "nsh-ios-host",
            (_, true) => "nsh-ios-app",
        }
    }

    /// The file of [`Platform::binary`] built for `triple` (`None`: this
    /// machine): with this machine's executable suffix (`.exe`) when it is
    /// built for this machine.
    pub(crate) fn file_name(self, runner: bool, triple: Option<&str>) -> String {
        format!("{}{}", self.binary(runner), exe_suffix(triple))
    }

    /// The development host (`runner` false) or release runner for it, as
    /// steps name it: "the development host for the iOS simulator".
    pub(crate) fn host(self, runner: bool) -> String {
        let what = if runner {
            "release runner"
        } else {
            "development host"
        };
        let platform = match self {
            Platform::IphoneOs => "iOS devices",
            Platform::IphoneSimulator => "the iOS simulator",
            Platform::MacCatalyst => "Mac Catalyst",
            Platform::Linux => "Linux",
            Platform::MacOs => "macOS",
            Platform::Windows => "Windows",
            Platform::Gpui => "GPUI",
            Platform::Tui => "the terminal",
        };
        format!("the {what} for {platform}")
    }
}

/// In an installed distribution, adds the component `name` that holds
/// `missing` ([`crate::component`]) and answers `true`; a checkout's build
/// (`false`) builds its runtimes with cargo instead.
fn add_component(name: &str, missing: &Path) -> anyhow::Result<bool> {
    let Some(root) = crate::component::distribution() else {
        return Ok(false);
    };
    crate::component::ensure(&root, name, missing)?;
    Ok(true)
}

/// Whether the component `name` of this CLI's distribution was built with
/// it; outside a distribution (a checkout's build, a runtime laid out by
/// hand) whatever is there is used.
fn distribution_current(name: &str) -> bool {
    let Some(root) = crate::component::distribution() else {
        return true;
    };
    // Laid out without the component machinery: no record to check.
    if !root
        .join("components")
        .join(format!("{name}.json"))
        .exists()
    {
        return true;
    }
    crate::component::current(&root, name)
}

/// This `nsh`, through symlinks: an installer links `~/.local/bin/nsh` (or
/// `/opt/homebrew/bin/nsh`) to the distribution's `bin/nsh`, whose runtimes
/// are next to the real file. macOS reports the path as it was run, Linux
/// the resolved one; on Windows nothing links it, and canonical paths there
/// are `\\?\` ones that other tools reject.
pub(crate) fn cli_exe() -> std::io::Result<PathBuf> {
    let exe = env::current_exe()?;
    if cfg!(windows) {
        return Ok(exe);
    }
    Ok(exe.canonicalize().unwrap_or(exe))
}

/// The Android runtime directory (`classes.dex`, `lib/<abi>/libnsh.so`),
/// with development support or not; a Rust app's library is built for
/// `abis` (empty: every ABI of the prebuilt runtime).
pub(crate) fn android(dev: bool, abis: &[String]) -> anyhow::Result<PathBuf> {
    let prebuilt = prebuilt_android(dev)?;
    match crate::rust_app::current() {
        // The app's own library with the prebuilt Java runtime.
        Some(app) => app.android(&prebuilt, dev, abis),
        None => Ok(prebuilt),
    }
}

/// The Android runtime `nsh test --target android` runs apps in: the
/// development one, a Rust app's too, built for `abis` (empty: every ABI of
/// the prebuilt runtime) ([`crate::rust_app::RustApp::test_android`]).
pub(crate) fn test_android(abis: &[String]) -> anyhow::Result<PathBuf> {
    let prebuilt = prebuilt_android(true)?;
    match crate::rust_app::current() {
        Some(app) => app.test_android(&prebuilt, abis),
        None => Ok(prebuilt),
    }
}

fn prebuilt_android(dev: bool) -> anyhow::Result<PathBuf> {
    let variant = if dev { "dev" } else { "release" };
    if let Some(root) = env::var_os("NSH_RUNTIME") {
        return android_existing(PathBuf::from(root).join("android").join(variant), dev);
    }
    let exe = cli_exe()?;
    let bin = exe.parent().context("cli has no parent directory")?;
    let dist = bin.join("../runtime/android").join(variant);
    if dist.join("classes.dex").exists() && distribution_current("android") {
        return Ok(dist);
    }
    if add_component("android", &dist.join("classes.dex"))? {
        return Ok(dist);
    }
    // Cargo checkout: `cargo xtask android [--release] [--dev]` output.
    let profile = bin
        .file_name()
        .context("cli profile dir")?
        .to_string_lossy();
    if let Some(root) = checkout(bin) {
        let mut args = vec!["xtask", "android"];
        if profile == "release" {
            args.push("--release");
        }
        if dev {
            args.push("--dev");
        }
        let what = if dev {
            "the Android runtime with development support"
        } else {
            "the Android runtime"
        };
        cargo(&root, &args, what)?;
    }
    let name = if dev {
        format!("{profile}-dev")
    } else {
        profile.into_owned()
    };
    let built = bin
        .parent()
        .context("cli is not in a target directory")?
        .join("android")
        .join(name);
    android_existing(built, dev)
}

fn android_existing(dir: PathBuf, dev: bool) -> anyhow::Result<PathBuf> {
    if dir.join("classes.dex").exists() {
        return Ok(dir);
    }
    bail!(
        "the Android runtime is not at {}\nin a nsh checkout, build it with: cargo xtask android{}",
        dir.display(),
        if dev { " --dev" } else { "" }
    )
}

/// The web runtime: the engine (`nsh.wasm`) and the DOM runtime that
/// loads it (`nsh.js`), which only work together.
pub(crate) struct WebRuntime {
    pub(crate) wasm: PathBuf,
    pub(crate) js: PathBuf,
    /// The wasm-bindgen glue of an app's runtime whose crates call JS
    /// through wasm-bindgen (`crate::bindgen`), served and packaged next to
    /// `nsh.js`.
    pub(crate) glue: Option<PathBuf>,
    /// The syntaxes the module leaves out ([`SYNTAXES`]), which the page
    /// fetches the first time code is highlighted.
    pub(crate) syntaxes: Option<PathBuf>,
}

/// The file of the syntaxes the web runtime leaves out of `nsh.wasm`:
/// two-face's dump of bat's, which `nsh-base` embeds on the native
/// platforms. It sits next to the module of the build that made it.
pub(crate) const SYNTAXES: &str = "nsh-syntaxes.bin";

/// The syntaxes file of the runtime in `dir`, if it has one.
pub(crate) fn syntaxes_in(dir: &Path) -> Option<PathBuf> {
    Some(dir.join(SYNTAXES)).filter(|path| path.exists())
}

/// Writes [`SYNTAXES`] into `dir`: two-face's dump as the workspace of
/// `manifest` resolves it, so it matches the syntect the runtime built
/// there reads it with. A copy written after the workspace's lock file last
/// changed is kept: the resolution is the same, and `cargo metadata` takes
/// longer than an incremental build of a development runtime.
pub(crate) fn write_syntaxes(manifest: &Path, dir: &Path) -> anyhow::Result<PathBuf> {
    let to = dir.join(SYNTAXES);
    let modified = |path: &Path| fs::metadata(path).and_then(|m| m.modified()).ok();
    if let (Some(copy), Some(lock)) = (
        modified(&to),
        modified(&manifest.with_file_name("Cargo.lock")),
    ) && copy > lock
    {
        return Ok(to);
    }
    let package = package_dir(manifest, "two-face", None)?;
    let dump = package.join("generated/syntaxes-fancy-newlines.bin");
    // Written, not copied: a copy may keep the source's time, which is
    // what tells this copy's age.
    let bytes = fs::read(&dump).with_context(|| format!("read {}", dump.display()))?;
    fs::write(&to, bytes).with_context(|| format!("write {}", to.display()))?;
    Ok(to)
}

/// The directory of package `name` (at `version`, when given) in the
/// workspace of `manifest`, as `cargo metadata` resolves it.
pub(crate) fn package_dir(
    manifest: &Path,
    name: &str,
    version: Option<&str>,
) -> anyhow::Result<PathBuf> {
    let cargo = env::var_os("CARGO").unwrap_or_else(|| OsString::from("cargo"));
    let output = Command::new(cargo)
        .args(["metadata", "--format-version", "1", "--manifest-path"])
        .arg(manifest)
        .output()
        .context("run cargo metadata")?;
    if !output.status.success() {
        bail!(
            "cargo metadata of {}:\n{}",
            manifest.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("cargo metadata's output")?;
    let mut found = metadata["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["name"].as_str() == Some(name))
        .filter(|p| version.is_none_or(|v| p["version"].as_str() == Some(v)));
    let package = found.next();
    if found.next().is_some() {
        bail!("{} resolves several versions of {name}", manifest.display());
    }
    package
        .and_then(|p| {
            Path::new(p["manifest_path"].as_str()?)
                .parent()
                .map(Path::to_path_buf)
        })
        .with_context(|| match version {
            Some(version) => format!("{} resolves no {name} {version}", manifest.display()),
            None => format!("{} resolves no {name}", manifest.display()),
        })
}

/// Which web runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WebKind {
    /// Published apps': every part of `nsh/base` and every standard
    /// module, linkable (feature `linkable`): `nsh package` drops what the
    /// app does not use (`web/prune.rs`). `nsh-browser.wasm`.
    Browser,
    /// The development host's (`nsh dev`, `nsh run --target web`): it runs
    /// development bundles on the browser's JavaScript engine, with hot
    /// updates. `nsh-dev.wasm`.
    Dev,
}

impl WebKind {
    /// Its file in the distribution (`runtime/web/`) and, in a checkout,
    /// next to the build's output.
    pub(crate) fn file(self) -> &'static str {
        match self {
            WebKind::Browser => "nsh-browser.wasm",
            WebKind::Dev => "nsh-dev.wasm",
        }
    }

    /// The features `nsh-platform-web` is built with for it.
    pub(crate) fn features(self) -> &'static [&'static str] {
        match self {
            WebKind::Browser => &["--no-default-features", "--features", "browser,linkable"],
            WebKind::Dev => &["--no-default-features", "--features", "dev"],
        }
    }
}

/// The web runtime `nsh package` links an app's from ([`WebKind::Browser`]).
pub(crate) fn package_web() -> anyhow::Result<WebRuntime> {
    web(WebKind::Browser, true)?.context("no web runtime")
}

/// The web runtime ([`WebRuntime`]) of `kind`. In a checkout it is built
/// first when `build` is set; without it, the build that is there, if any
/// (`None`).
/// The web runtime `nsh test --target web` runs apps in: the development
/// host's, a Rust app's too ([`crate::rust_app::RustApp::test_web`]).
pub(crate) fn test_web() -> anyhow::Result<WebRuntime> {
    match crate::rust_app::current() {
        Some(app) => app.test_web(),
        None => web(WebKind::Dev, true)?.context("no web runtime"),
    }
}

pub(crate) fn web(kind: WebKind, build: bool) -> anyhow::Result<Option<WebRuntime>> {
    const WASM: &str = "wasm32-unknown-unknown";
    // An app with Rust components of its own: a runtime with its set.
    if let Some(app) = crate::rust_app::current() {
        return app.web(kind, build);
    }
    let found = |dir: PathBuf| {
        let runtime = WebRuntime {
            wasm: dir.join(kind.file()),
            js: dir.join("nsh.js"),
            glue: None,
            syntaxes: syntaxes_in(&dir),
        };
        (runtime.wasm.exists() && runtime.js.exists()).then_some(runtime)
    };
    if let Some(root) = env::var_os("NSH_RUNTIME") {
        let dir = PathBuf::from(root).join("web");
        return match found(dir.clone()) {
            Some(runtime) => Ok(Some(runtime)),
            None if build => bail!("the web runtime is not in {}", dir.display()),
            None => Ok(None),
        };
    }
    let exe = cli_exe()?;
    let bin = exe.parent().context("cli has no parent directory")?;
    if let Some(runtime) = found(bin.join("../runtime/web"))
        && (!build || distribution_current("web"))
    {
        return Ok(Some(runtime));
    }
    if build && add_component("web", &bin.join("../runtime/web").join(kind.file()))? {
        return found(bin.join("../runtime/web"))
            .map(Some)
            .context("the component `web` holds no web runtime");
    }
    let Some(root) = checkout(bin) else {
        if build {
            bail!(
                "the web runtime is not at {}",
                bin.join("../runtime/web").display()
            );
        }
        return Ok(None);
    };
    let out = bin
        .parent()
        .context("cli is not in a target directory")?
        .join(WASM)
        .join("web");
    let features = kind.features();
    if build {
        let cargo = env::var_os("CARGO").unwrap_or_else(|| OsString::from("cargo"));
        let mut command = Command::new(&cargo);
        command
            .args(["build", "--profile", "web", "-p", "nsh-platform-web"])
            .args(features)
            .args(["--target", WASM])
            .current_dir(&root);
        web_build_flags(&mut command);
        // The C code of the dependencies (zstd) needs an `ar` that knows
        // WebAssembly objects.
        let ar = format!("AR_{}", WASM.replace('-', "_"));
        if env::var_os(&ar).is_none() && env::var_os("AR").is_none() {
            command.env(&ar, "llvm-ar");
        }
        crate::ui::cargo(&mut command, "the web runtime")?;
        // Both kinds build to the same file: each keeps a copy of its own.
        let built = out.join("nsh_platform_web.wasm");
        fs::copy(&built, out.join(kind.file()))
            .with_context(|| format!("copy {}", built.display()))?;
        write_syntaxes(&root.join("Cargo.toml"), &out)?;
    }
    let runtime = WebRuntime {
        wasm: out.join(kind.file()),
        js: root.join("crates/nsh-platform-web/web/nsh.js"),
        glue: None,
        syntaxes: syntaxes_in(&out),
    };
    if runtime.wasm.exists() {
        return Ok(Some(runtime));
    }
    if build {
        bail!("the web runtime is not at {}", runtime.wasm.display());
    }
    Ok(None)
}

/// Path of the development host (`runner` false) or release runner for
/// `platform` ([`Platform::binary`]): for an app with a Rust crate, its own
/// build.
/// The development host `nsh test --target` runs apps in on `platform`: a
/// Rust app's too ([`crate::rust_app::RustApp::test_host`]).
pub(crate) fn test_host(platform: Platform) -> anyhow::Result<PathBuf> {
    match crate::rust_app::current() {
        Some(app) => app.test_host(platform),
        None => file(platform, false),
    }
}

pub(crate) fn file(platform: Platform, runner: bool) -> anyhow::Result<PathBuf> {
    file_for(platform, runner, platform.triple())
}

/// [`file`] built for `triple` (`None`: this machine) instead of the
/// platform's own ([`Platform::triple`]): a macOS package for a given
/// processor (`nsh package --arch`). A prebuilt runtime is the one there
/// is, built for the processor of the machine that built it; the caller
/// checks what it holds ([`locate`]).
pub(crate) fn file_for(
    platform: Platform,
    runner: bool,
    triple: Option<&'static str>,
) -> anyhow::Result<PathBuf> {
    locate(platform, runner, triple).map(|file| file.path)
}

/// A runtime binary [`locate`] found.
pub(crate) struct RuntimeFile {
    pub(crate) path: PathBuf,
    /// Built by Cargo for this command (an app's crates, a checkout's
    /// runtime), so for the target asked; else prebuilt (an installed
    /// nsh's, `NSH_RUNTIME`), for whatever processor it was built for.
    pub(crate) built: bool,
}

/// [`file_for`], and whether Cargo built the file for it.
pub(crate) fn locate(
    platform: Platform,
    runner: bool,
    triple: Option<&'static str>,
) -> anyhow::Result<RuntimeFile> {
    if let Some(app) = crate::rust_app::current() {
        return Ok(RuntimeFile {
            path: app.runtime(platform, runner, triple)?,
            built: true,
        });
    }
    let prebuilt = |path| RuntimeFile { path, built: false };
    let name = platform.binary(runner);
    let file_name = platform.file_name(runner, triple);
    if let Some(root) = env::var_os("NSH_RUNTIME") {
        return existing(
            PathBuf::from(root).join(platform.dir()).join(&file_name),
            platform,
            name,
            triple,
        )
        .map(prebuilt);
    }
    let exe = cli_exe()?;
    let bin = exe.parent().context("cli has no parent directory")?;
    // Distribution: bin/nsh + runtime/.
    let dist = bin.join("../runtime").join(platform.dir()).join(&file_name);
    if dist.exists() && platform.component().is_none_or(distribution_current) {
        return Ok(prebuilt(dist));
    }
    if let Some(component) = platform.component()
        && add_component(component, &dist)?
    {
        return Ok(prebuilt(dist));
    }
    // Cargo checkout: target/<profile>/nsh -> target/<triple>/<profile>/<name>.
    let profile = bin.file_name().context("cli profile dir")?;
    let mut host_target = None;
    let mut triple = triple;
    let root = checkout(bin);
    if let Some(root) = &root {
        let mut args = vec!["build", "-p", name];
        // Web views need WebKitGTK 6.0 to build: without it, the host shows
        // a placeholder instead (#2377).
        if matches!(platform, Platform::Linux) && !runner && !linux_web_views() {
            args.push("--no-default-features");
        }
        // GPUI has its own workspace. Run there so Cargo reads its config,
        // and ask Cargo where it builds rather than imposing the CLI's target.
        let workspace = if matches!(platform, Platform::Gpui) {
            args.extend(gpui_features());
            root.join("crates/gpui")
        } else {
            root.clone()
        };
        triple = build_target(platform, triple, Some(&workspace))?;
        if let Some(triple) = triple {
            args.extend(["--target", triple]);
        }
        match profile.to_str() {
            Some("debug") => {}
            Some("release") => args.push("--release"),
            Some(other) => args.extend(["--profile", other]),
            None => bail!("cli profile dir is not UTF-8"),
        }
        // The runner is "release" as opposed to the development host; the
        // build follows the CLI's own profile, so say which one it is.
        let what = match profile.to_str() {
            Some("release") => platform.host(runner),
            Some(other) => format!("{} ({other} build)", platform.host(runner)),
            None => platform.host(runner),
        };
        let what = format!("{what}{}", other_triple(platform, triple));
        cargo(&workspace, &args, &what)?;
        if matches!(platform, Platform::Gpui) {
            host_target = Some(
                crate::rust_app::cargo_target_directory(&workspace)
                    .context("Cargo did not report the GPUI workspace's target directory")?,
            );
        }
    }
    let mut built = host_target.unwrap_or(
        bin.parent()
            .context("cli is not in a target directory")?
            .to_path_buf(),
    );
    if let Some(triple) = triple {
        built.push(triple);
    }
    built.push(profile);
    built.push(&file_name);
    let path = existing(built, platform, name, triple)?;
    let path = match &root {
        Some(root) if cfg!(target_os = "macos") && triple.is_none() => stable_copy(
            &path,
            &root.join(".nsh/hosts").join(profile).join(&file_name),
        )?,
        _ => path,
    };
    Ok(RuntimeFile {
        path,
        built: root.is_some(),
    })
}

/// A copy of the executable `built` at `copy` that changes only when the
/// build does. Every `cargo build`, even one with nothing to do, links the
/// binary into `target/<profile>/` again, and macOS checks an executable whose
/// file changed again the first time it runs: a second or more for a debug
/// host, on every `nsh run`. The copy keeps its file until the build is new
/// (its modification time or size differ); on APFS the copy is a clone.
fn stable_copy(built: &Path, copy: &Path) -> anyhow::Result<PathBuf> {
    let source = fs::metadata(built).with_context(|| format!("read {}", built.display()))?;
    let fresh = fs::metadata(copy).is_ok_and(|copied| {
        copied.len() == source.len() && copied.modified().ok() == source.modified().ok()
    });
    if !fresh {
        if let Some(dir) = copy.parent() {
            fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        }
        // A new file rather than one written over: a running host keeps its own.
        let _ = fs::remove_file(copy);
        fs::copy(built, copy).with_context(|| format!("copy {}", built.display()))?;
        let modified = source.modified().context("modification time")?;
        fs::File::options()
            .write(true)
            .open(copy)
            .and_then(|file| file.set_modified(modified))
            .with_context(|| format!("stamp {}", copy.display()))?;
    }
    Ok(copy.to_path_buf())
}

/// The cargo arguments a build of a GPUI host adds: on a Mac
/// where Xcode cannot run `metal`, which GPUI's build script precompiles
/// its shaders with, `nsh-platform-gpui`'s `runtime-shaders` feature, so
/// GPUI compiles them when the app starts. Every GPUI host, the
/// checkout's and those of apps with Rust crates, depends on
/// `nsh-platform-gpui`.
pub(crate) fn gpui_features() -> &'static [&'static str] {
    if !metal_toolchain_missing() {
        return &[];
    }
    crate::ui::note(
        "no Metal Toolchain: GPUI compiles its shaders when the app starts \
         (`xcodebuild -downloadComponent MetalToolchain` installs one to precompile them)",
    );
    &["--features", "nsh-platform-gpui/runtime-shaders"]
}

/// Whether this is a Mac where Xcode cannot run `metal` (no Metal
/// Toolchain).
fn metal_toolchain_missing() -> bool {
    cfg!(target_os = "macos")
        && !Command::new("xcrun")
            .args(["metal", "--version"])
            .output()
            .is_ok_and(|out| out.status.success())
}

/// The nsh checkout this CLI was built in, if it was built in one.
pub(crate) fn cli_checkout() -> Option<PathBuf> {
    checkout(cli_exe().ok()?.parent()?)
}

/// The workspace of a cargo checkout of nsh this CLI was built in
/// (`<root>/target/<profile>/nsh`), if it is one.
fn checkout(bin: &Path) -> Option<PathBuf> {
    let root = bin.parent()?.parent()?;
    root.join("crates/nsh-ios-host/Cargo.toml")
        .exists()
        .then(|| root.to_owned())
}

/// Selects the browser entropy provider for all dependencies of a web build.
/// Cargo config arrays merge, preserving the workspace's stack link argument.
pub(crate) fn web_build_flags(command: &mut Command) {
    append_web_flags(
        command,
        env::var_os("CARGO_ENCODED_RUSTFLAGS"),
        env::var_os("RUSTFLAGS")
            .or_else(|| env::var_os("CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS")),
    );
}

fn append_web_flags(command: &mut Command, encoded: Option<OsString>, plain: Option<OsString>) {
    // Environment flags override Cargo config, so append there when present.
    if let Some(mut flags) = encoded {
        if !flags.is_empty() {
            flags.push("\x1f");
        }
        flags.push("--cfg\x1fgetrandom_backend=\"custom\"");
        command.env("CARGO_ENCODED_RUSTFLAGS", flags);
    } else if let Some(mut flags) = plain {
        flags.push(" --cfg getrandom_backend=\"custom\"");
        command.env("RUSTFLAGS", flags);
    } else {
        command.args([
            "--config",
            r#"target.wasm32-unknown-unknown.rustflags=["--cfg", "getrandom_backend=\"custom\""]"#,
        ]);
    }
}

/// The Windows target a Windows runtime is cross-built for off Windows.
pub(crate) const WINDOWS_TRIPLE: &str = "x86_64-pc-windows-msvc";

/// The executable suffix of a build for `triple` (`None`: this machine).
pub(crate) fn exe_suffix(triple: Option<&str>) -> &'static str {
    match triple {
        None => env::consts::EXE_SUFFIX,
        Some(triple) if triple.contains("-windows-") => ".exe",
        Some(_) => "",
    }
}

/// Sets up `cmd` (`cargo` with no arguments yet) to build for `triple`.
/// A Windows (MSVC) build off Windows links with cargo-xwin, whose
/// `cargo xwin build` takes the same arguments as `cargo build`, and links
/// the C runtime statically so the executable needs no Visual C++
/// redistributable on the machine it runs on.
pub(crate) fn cross_build(cmd: &mut Command, triple: Option<&str>) -> anyhow::Result<()> {
    if cfg!(windows) || triple != Some(WINDOWS_TRIPLE) {
        return Ok(());
    }
    let program = cmd.get_program().to_owned();
    let found = Command::new(&program)
        .args(["xwin", "--version"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if !found {
        bail!(
            "building for Windows on this machine needs cargo-xwin and the {WINDOWS_TRIPLE} target:\n  cargo install --locked cargo-xwin\n  rustup target add {WINDOWS_TRIPLE}\nor set NSH_RUNTIME to a runtime with a Windows release runner"
        );
    }
    cmd.arg("xwin").env(
        "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS",
        "-C target-feature=+crt-static",
    );
    Ok(())
}

/// Runs cargo in the checkout `root` (the one that runs this CLI under
/// `cargo run`, else `cargo` from the path): the step "building <what>".
fn cargo(root: &Path, args: &[&str], what: &str) -> anyhow::Result<()> {
    let cargo = env::var_os("CARGO").unwrap_or_else(|| OsString::from("cargo"));
    let mut cmd = Command::new(&cargo);
    let triple = args
        .iter()
        .position(|arg| *arg == "--target")
        .and_then(|i| args.get(i + 1).copied());
    cross_build(&mut cmd, triple)?;
    crate::ui::cargo(cmd.args(args).current_dir(root), what)
}

/// What the step of a build for `triple` adds to its name when that is not
/// the platform's own triple: ` for x86_64-apple-darwin`.
pub(crate) fn other_triple(platform: Platform, triple: Option<&str>) -> String {
    match triple {
        Some(triple) if Some(triple) != platform.triple() => format!(" for {triple}"),
        _ => String::new(),
    }
}

/// The target triple a Cargo build with no `--target` is for in `dir`
/// (`None`: this process's directory): the host of the Rust toolchain
/// there (`rustc -vV`). It is the processor's own even when this CLI runs
/// translated (an Intel nsh under Rosetta), so it can differ from the
/// architecture of this CLI.
pub(crate) fn rustc_host(dir: Option<&Path>) -> Option<String> {
    let rustc = env::var_os("RUSTC").unwrap_or_else(|| OsString::from("rustc"));
    let mut command = Command::new(rustc);
    command.arg("-vV");
    if let Some(dir) = dir {
        command.current_dir(dir);
    }
    let output = command.output().ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    text.lines()
        .find_map(|line| line.strip_prefix("host: "))
        .map(str::to_owned)
}

/// The `--target` Cargo builds `platform`'s runtime for `triple` with in
/// `dir` (`None`: this process's directory). A triple that is not the
/// platform's own (a macOS package for a given processor) is left out when
/// it is the toolchain's host ([`rustc_host`]), so the build is the one
/// every other command shares (`target/<profile>`); any other needs its
/// standard library ([`require_target`]).
pub(crate) fn build_target<'a>(
    platform: Platform,
    triple: Option<&'a str>,
    dir: Option<&Path>,
) -> anyhow::Result<Option<&'a str>> {
    let Some(other) = triple.filter(|triple| Some(*triple) != platform.triple()) else {
        return Ok(triple);
    };
    let target = cross_target(other, rustc_host(dir).as_deref());
    if let Some(target) = target {
        require_target(dir, target)?;
    }
    Ok(target)
}

/// The `--target` a build for `triple` takes when the toolchain's host is
/// `host` (`None`: unknown): none for the host itself.
fn cross_target<'a>(triple: &'a str, host: Option<&str>) -> Option<&'a str> {
    (Some(triple) != host).then_some(triple)
}

/// Fails with the command that adds the Rust target `triple` when the
/// toolchain cargo builds with in `dir` (`None`: this process's directory)
/// has no standard library for it. Without a `rustc` to ask, cargo's own
/// error says it.
pub(crate) fn require_target(dir: Option<&Path>, triple: &str) -> anyhow::Result<()> {
    let rustc = env::var_os("RUSTC").unwrap_or_else(|| OsString::from("rustc"));
    let mut command = Command::new(rustc);
    command.args(["--print", "target-libdir", "--target", triple]);
    if let Some(dir) = dir {
        command.current_dir(dir);
    }
    let Ok(output) = command.output() else {
        return Ok(());
    };
    if !output.status.success() {
        return Ok(());
    }
    let libdir = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    if has_core(&libdir) {
        return Ok(());
    }
    bail!("the Rust target {triple} is not installed; add it with: rustup target add {triple}")
}

/// Whether `libdir` (`rustc --print target-libdir`) holds a target's `core`.
fn has_core(libdir: &Path) -> bool {
    fs::read_dir(libdir).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with("libcore-"))
    })
}

fn existing(
    path: PathBuf,
    platform: Platform,
    name: &str,
    triple: Option<&str>,
) -> anyhow::Result<PathBuf> {
    if path.exists() {
        return Ok(path);
    }
    let target = triple
        .map(|triple| format!(" --target {triple}"))
        .unwrap_or_default();
    bail!(
        "{name} for {} not found at {}\nin a nsh checkout, build it with: cargo build -p {name}{target}",
        platform.dir(),
        path.display(),
    )
}

/// The browser facade ships with the runtime, including registry-built apps.
pub(crate) fn copy_browser_host(source: &Path, target: &Path) -> anyhow::Result<()> {
    let from = source.join("browser");
    let to = target.join("browser");
    fs::create_dir_all(&to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if entry
            .path()
            .extension()
            .is_some_and(|ext| ext == "js" || ext == "txt")
        {
            fs::copy(entry.path(), to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

/// Whether this machine can build Linux web views: `pkg-config` finds
/// WebKitGTK 6.0, or there is no `pkg-config` to ask (the build says
/// then). A development host built without them shows a placeholder for
/// each web view, which this says once (#2377). Release runners do not
/// ask: an app that makes a web view must build with them.
pub(crate) fn linux_web_views() -> bool {
    static FOUND: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *FOUND.get_or_init(|| {
        let found = std::process::Command::new("pkg-config")
            .args(["--exists", "webkitgtk-6.0"])
            .status()
            .map_or(true, |s| s.success());
        if !found {
            crate::ui::warn(
                "WebKitGTK 6.0 is not installed (webkitgtk-6.0 / libwebkitgtk-6.0-dev): \
                 the development host builds without web views, which show a placeholder",
            );
        }
        found
    })
}

#[cfg(test)]
mod tests {
    use super::Platform;

    #[cfg(unix)]
    #[test]
    fn a_stable_copy_changes_only_with_the_build() {
        use std::{fs, os::unix::fs::MetadataExt as _};
        let dir = std::env::temp_dir().join(format!("nsh-stable-copy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let built = dir.join("host");
        let copy = dir.join("copies/host");
        fs::write(&built, b"one").unwrap();
        super::stable_copy(&built, &copy).unwrap();
        let first = fs::metadata(&copy).unwrap().ino();
        // What cargo does with nothing to rebuild: the same file linked again.
        fs::hard_link(&built, dir.join("again")).unwrap();
        super::stable_copy(&built, &copy).unwrap();
        assert_eq!(fs::metadata(&copy).unwrap().ino(), first);
        fs::remove_file(&built).unwrap();
        fs::write(&built, b"three").unwrap();
        super::stable_copy(&built, &copy).unwrap();
        assert_eq!(fs::read(&copy).unwrap(), b"three");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// A build leaves out `--target` only for the toolchain's host, whatever
    /// processor this CLI is built for: an Intel nsh under Rosetta with an
    /// Apple silicon toolchain cross-builds for Intel and builds Apple
    /// silicon as every other command does.
    #[test]
    fn only_the_toolchains_host_builds_without_a_target() {
        const ARM64: &str = "aarch64-apple-darwin";
        const X86_64: &str = "x86_64-apple-darwin";
        for host in [ARM64, X86_64] {
            let other = if host == ARM64 { X86_64 } else { ARM64 };
            assert_eq!(super::cross_target(host, Some(host)), None);
            assert_eq!(super::cross_target(other, Some(host)), Some(other));
        }
        // Without a toolchain to ask, Cargo is told the target.
        assert_eq!(super::cross_target(X86_64, None), Some(X86_64));
        // The platform's own target, or none, is what it was: no toolchain
        // is asked.
        let ios = Platform::IphoneOs.triple();
        assert_eq!(
            super::build_target(Platform::IphoneOs, ios, None).unwrap(),
            ios
        );
        assert_eq!(
            super::build_target(Platform::MacOs, None, None).unwrap(),
            None
        );
    }

    /// A Rust target is installed when its directory holds `core`: rustc
    /// names the directory of a target it has no library for as well.
    #[test]
    fn a_target_is_installed_when_its_library_has_core() {
        use std::fs;
        let dir = std::env::temp_dir().join(format!("nsh-target-libdir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert!(!super::has_core(&dir));
        fs::create_dir_all(&dir).unwrap();
        assert!(!super::has_core(&dir));
        fs::write(dir.join("libstd-0123.rlib"), b"").unwrap();
        assert!(!super::has_core(&dir));
        fs::write(dir.join("libcore-0123.rlib"), b"").unwrap();
        assert!(super::has_core(&dir));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn published_runtime_variants_use_browser_execution() {
        use super::WebKind;
        assert_eq!(
            WebKind::Browser.features(),
            ["--no-default-features", "--features", "browser,linkable"]
        );
        assert_eq!(WebKind::Browser.file(), "nsh-browser.wasm");
    }

    #[test]
    fn web_entropy_flags_preserve_existing_rustflags() {
        use std::{ffi::OsString, process::Command};

        for (encoded, plain, key, expected) in [
            (
                Some("-C\x1flink-arg=-zstack-size=8388608"),
                None,
                "CARGO_ENCODED_RUSTFLAGS",
                "-C\x1flink-arg=-zstack-size=8388608\x1f--cfg\x1fgetrandom_backend=\"custom\"",
            ),
            (
                None,
                Some("-C link-arg=-zstack-size=8388608"),
                "RUSTFLAGS",
                "-C link-arg=-zstack-size=8388608 --cfg getrandom_backend=\"custom\"",
            ),
        ] {
            let mut command = Command::new("cargo");
            super::append_web_flags(
                &mut command,
                encoded.map(OsString::from),
                plain.map(OsString::from),
            );
            assert_eq!(
                command
                    .get_envs()
                    .find(|(name, _)| *name == key)
                    .unwrap()
                    .1
                    .unwrap(),
                expected
            );
        }
        let mut command = Command::new("cargo");
        super::append_web_flags(&mut command, None, None);
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args[0], "--config");
        assert!(args[1].to_str().unwrap().contains("getrandom_backend"));
        assert!(command.get_envs().next().is_none());
    }

    #[test]
    fn gpui_runtimes_are_built_for_this_machine() {
        assert_eq!(Platform::Gpui.dir(), "gpui");
        assert_eq!(Platform::Gpui.triple(), None);
        assert_eq!(Platform::Gpui.binary(false), "nsh-gpui-host");
        assert_eq!(
            Platform::Gpui.file_name(false, Platform::Gpui.triple()),
            format!("nsh-gpui-host{}", std::env::consts::EXE_SUFFIX)
        );
        assert_eq!(Platform::Gpui.host(false), "the development host for GPUI");
    }

    /// A rebuild of a development runtime keeps the syntaxes it has rather
    /// than asking `cargo metadata` again, until the lock file changes.
    #[test]
    fn syntaxes_newer_than_the_lock_file_are_kept() {
        use std::{
            fs,
            time::{Duration, SystemTime},
        };

        let dir = std::env::temp_dir().join(format!("nsh-syntaxes-kept-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let touch = |name: &str, contents: &str, secs: u64| {
            let path = dir.join(name);
            fs::write(&path, contents).unwrap();
            let time = SystemTime::UNIX_EPOCH + Duration::from_secs(secs);
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(time)
                .unwrap();
        };
        // No workspace there: asking `cargo metadata` about it fails.
        let manifest = dir.join("Cargo.toml");
        touch("Cargo.lock", "", 1_000);
        touch(super::SYNTAXES, "kept", 2_000);
        let path = super::write_syntaxes(&manifest, &dir).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "kept");
        touch("Cargo.lock", "", 3_000);
        assert!(super::write_syntaxes(&manifest, &dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
