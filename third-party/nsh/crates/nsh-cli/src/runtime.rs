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
//! runtime/tui/{nsh-tui-host,nsh-tui-app}[.exe] terminal host and release runner
//! runtime/android/release/             classes.dex + lib/<abi>/libnsh.so
//! runtime/android/dev/                 the same with development support
//! runtime/web/nsh.wasm                 the web runtime (`nsh-platform-web`)
//! runtime/web/nsh-browser-lite.wasm            the same with `nsh/base`'s core only, no `zlib` / `crypto`
//! runtime/web/nsh.js                   the DOM runtime that loads it
//! runtime/web/nsh-syntaxes.bin         the syntaxes it fetches to highlight code
//! ```
//!
//! In a cargo checkout, the same files come from `target/<triple>/<profile>`
//! (with the profile of this CLI; Linux's, macOS's, Windows', GPUI's and TUI's
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
    /// A terminal on this machine.
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

    /// The cargo target triple (`None`: this machine's).
    pub(crate) fn triple(self) -> Option<&'static str> {
        match self {
            Platform::IphoneOs => Some("aarch64-apple-ios"),
            Platform::IphoneSimulator => Some("aarch64-apple-ios-sim"),
            Platform::MacCatalyst => Some("aarch64-apple-ios-macabi"),
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
            (Platform::Gpui, false) => "nsh-gpui-host",
            (Platform::Gpui, true) => unreachable!("GPUI apps are embedded, never packaged"),
            (Platform::Tui, false) => "nsh-tui-host",
            (Platform::Tui, true) => "nsh-tui-app",
            (_, false) => "nsh-ios-host",
            (_, true) => "nsh-ios-app",
        }
    }

    /// The file of [`Platform::binary`]: with this machine's executable
    /// suffix (`.exe`) when it is built for this machine.
    pub(crate) fn file_name(self, runner: bool) -> String {
        let suffix = if self.triple().is_none() {
            env::consts::EXE_SUFFIX
        } else {
            ""
        };
        format!("{}{suffix}", self.binary(runner))
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
/// development one, a Rust app's too ([`crate::rust_app::RustApp::test_android`]).
pub(crate) fn test_android() -> anyhow::Result<PathBuf> {
    let prebuilt = prebuilt_android(true)?;
    match crate::rust_app::current() {
        Some(app) => app.test_android(&prebuilt),
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
    if dist.join("classes.dex").exists() {
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
    /// Trusted standalone apps, executed by browser JavaScript.
    Browser,
    /// Browser runtime with the core base components only.
    Lite,
    /// The development host's (`nsh dev`, `nsh run --target web`): it runs
    /// JS source and hot updates. `nsh-dev.wasm`.
    Dev,
}

impl WebKind {
    /// Its file in the distribution (`runtime/web/`) and, in a checkout,
    /// next to the build's output.
    pub(crate) fn file(self) -> &'static str {
        match self {
            WebKind::Browser => "nsh-browser.wasm",
            WebKind::Lite => "nsh-browser-lite.wasm",
            WebKind::Dev => "nsh-dev.wasm",
        }
    }

    /// The features `nsh-platform-web` is built with for it.
    pub(crate) fn features(self) -> &'static [&'static str] {
        match self {
            WebKind::Browser => &["--no-default-features", "--features", "browser"],
            WebKind::Lite => &["--no-default-features", "--features", "browser-core"],
            WebKind::Dev => &["--features", "dev"],
        }
    }
}

/// The web runtime `nsh package --target web` ships: the lite one when
/// `lite` (the app uses nothing else) and this CLI has one (its
/// distribution's, or this checkout's, built now), else the full one.
pub(crate) fn package_web(lite: bool) -> anyhow::Result<(WebRuntime, WebKind)> {
    if lite && crate::rust_app::current().is_none() && has_lite()? {
        let mut runtime = web(WebKind::Lite, true)?.context("no web runtime")?;
        // It has nothing that highlights code.
        runtime.syntaxes = None;
        return Ok((runtime, WebKind::Lite));
    }
    let runtime = web(WebKind::Browser, true)?.context("no web runtime")?;
    Ok((runtime, WebKind::Browser))
}

/// Whether there is a lite web runtime: in `NSH_RUNTIME` or the
/// distribution, or a checkout that builds one.
fn has_lite() -> anyhow::Result<bool> {
    if let Some(root) = env::var_os("NSH_RUNTIME") {
        return Ok(PathBuf::from(root)
            .join("web")
            .join(WebKind::Lite.file())
            .exists());
    }
    let exe = cli_exe()?;
    let bin = exe.parent().context("cli has no parent directory")?;
    Ok(bin
        .join("../runtime/web")
        .join(WebKind::Lite.file())
        .exists()
        || checkout(bin).is_some())
}

/// The web runtime `nsh test --target web` runs apps in: the development
/// host's, a Rust app's too ([`crate::rust_app::RustApp::test_web`]).
pub(crate) fn test_web() -> anyhow::Result<WebRuntime> {
    match crate::rust_app::current() {
        Some(app) => app.test_web(),
        None => web(WebKind::Dev, true)?.context("no web runtime"),
    }
}

/// The web runtime ([`WebRuntime`]) of `kind`. In a checkout it is built
/// first when `build` is set; without it, the build that is there, if any
/// (`None`).
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
    if let Some(runtime) = found(bin.join("../runtime/web")) {
        return Ok(Some(runtime));
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
        // QuickJS' archive needs an `ar` that knows WebAssembly objects.
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

/// The development host `nsh test --target` runs apps in on `platform`: a
/// Rust app's too ([`crate::rust_app::RustApp::test_host`]).
pub(crate) fn test_host(platform: Platform) -> anyhow::Result<PathBuf> {
    match crate::rust_app::current() {
        Some(app) => app.test_host(platform),
        None => file(platform, false),
    }
}

/// Path of the development host (`runner` false) or release runner for
/// `platform` ([`Platform::binary`]): for an app with a Rust crate, its own
/// build.
pub(crate) fn file(platform: Platform, runner: bool) -> anyhow::Result<PathBuf> {
    if let Some(app) = crate::rust_app::current() {
        return app.runtime(platform, runner);
    }
    let name = platform.binary(runner);
    let file_name = platform.file_name(runner);
    if let Some(root) = env::var_os("NSH_RUNTIME") {
        return existing(
            PathBuf::from(root).join(platform.dir()).join(&file_name),
            platform,
            name,
        );
    }
    let exe = cli_exe()?;
    let bin = exe.parent().context("cli has no parent directory")?;
    // Distribution: bin/nsh + runtime/.
    let dist = bin.join("../runtime").join(platform.dir()).join(&file_name);
    if dist.exists() {
        return Ok(dist);
    }
    // Cargo checkout: target/<profile>/nsh -> target/<triple>/<profile>/<name>.
    let profile = bin.file_name().context("cli profile dir")?;
    if let Some(root) = checkout(bin) {
        let mut args = vec!["build", "-p", name];
        // The GPUI backend is a workspace of its own, built into the same
        // `target/` (cargo reads `crates/gpui/.cargo/config.toml` only when
        // run from there).
        let manifest = root.join("crates/gpui/Cargo.toml");
        let manifest = manifest.to_string_lossy();
        let target_dir = root.join("target");
        let target_dir = target_dir.to_string_lossy();
        if matches!(platform, Platform::Gpui) {
            args.extend(["--manifest-path", &manifest, "--target-dir", &target_dir]);
            args.extend(gpui_features());
        }
        if let Some(triple) = platform.triple() {
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
        cargo(&root, &args, &what)?;
    }
    let mut built = bin
        .parent()
        .context("cli is not in a target directory")?
        .to_path_buf();
    if let Some(triple) = platform.triple() {
        built.push(triple);
    }
    built.push(profile);
    built.push(file_name);
    existing(built, platform, name)
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

/// Runs cargo in the checkout `root` (the one that runs this CLI under
/// `cargo run`, else `cargo` from the path): the step "building <what>".
fn cargo(root: &Path, args: &[&str], what: &str) -> anyhow::Result<()> {
    let cargo = env::var_os("CARGO").unwrap_or_else(|| OsString::from("cargo"));
    crate::ui::cargo(Command::new(&cargo).args(args).current_dir(root), what)
}

fn existing(path: PathBuf, platform: Platform, name: &str) -> anyhow::Result<PathBuf> {
    if path.exists() {
        return Ok(path);
    }
    let target = platform
        .triple()
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

#[cfg(test)]
mod tests {
    use super::Platform;

    #[test]
    fn tui_runtimes_are_console_programs_for_this_machine() {
        assert_eq!(Platform::Tui.dir(), "tui");
        assert_eq!(Platform::Tui.triple(), None);
        assert_eq!(Platform::Tui.binary(false), "nsh-tui-host");
        assert_eq!(Platform::Tui.binary(true), "nsh-tui-app");
        assert_eq!(
            Platform::Tui.file_name(true),
            format!("nsh-tui-app{}", std::env::consts::EXE_SUFFIX)
        );
        assert_eq!(
            Platform::Tui.host(false),
            "the development host for the terminal"
        );
    }

    #[test]
    fn published_runtime_variants_use_browser_execution() {
        use super::WebKind;
        assert_eq!(
            WebKind::Browser.features(),
            ["--no-default-features", "--features", "browser"]
        );
        assert_eq!(
            WebKind::Lite.features(),
            ["--no-default-features", "--features", "browser-core"]
        );
        assert_eq!(WebKind::Lite.file(), "nsh-browser-lite.wasm");
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
            Platform::Gpui.file_name(false),
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
