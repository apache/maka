//! The distribution: everything an app developer needs, prebuilt.
//!
//! ```text
//! dist/nsh/bin/nsh                                             the CLI
//! dist/nsh/runtime/ios/iphoneos/nsh-ios-app                    packaged app runner
//! dist/nsh/runtime/ios/iphonesimulator/{nsh-ios-app,nsh-ios-host}
//! dist/nsh/runtime/ios/maccatalyst/nsh-ios-host                development host
//! dist/nsh/runtime/macos/{nsh-macos-host,nsh-macos-app}        development host, packaged app runner
//! dist/nsh/runtime/linux/{nsh-linux-host,nsh-linux-app}        development host, packaged app runner
//! dist/nsh/runtime/windows/{nsh-windows-host,nsh-windows-app}.exe  development host, packaged app runner
//! dist/nsh/runtime/gpui/nsh-gpui-host[.exe]                   development host (GPUI; apps embed it, never package it)
//! dist/nsh/runtime/tui/nsh-tui-host[.exe]                     development host (the terminal, `nsh run --target tui`)
//! dist/nsh/runtime/android/{release,dev}/                      classes.dex, lib/<abi>/libnsh.so (stripped),
//!                                                              symbols/<abi>/libnsh.so (with symbols)
//! dist/nsh/runtime/web/{nsh-browser.wasm,nsh-dev.wasm,nsh.js,browser/}  the web runtimes (published apps' to link from, the dev host's)
//! dist/nsh/runtime/web/nsh-syntaxes.bin                       the syntaxes they fetch to highlight code
//! dist/nsh/embed/ios/{NativeShell,NativeShellDev}.xcframework  embedding in iOS apps
//! dist/nsh/embed/android/{nsh,nsh-dev}.aar                     embedding in Android apps
//! ```
//!
//! The iOS runtimes and SDK need Xcode: they are built on Apple silicon Macs
//! only. The macOS (AppKit) runtime is built on macOS, for this machine. The
//! Linux runtime is built for this machine, on Linux only (where it runs,
//! GTK 4, Pango and, for web views, WebKitGTK 6.0 must be installed;
//! without WebKitGTK's development files it is built with placeholders for
//! web views and needs only GTK); the Windows runtime likewise, on
//! Windows only (where the CLI is `bin/nsh.exe`). The GPUI and terminal
//! development hosts are built for this machine on each of the three. The web runtime is built
//! everywhere: it needs a clang that targets wasm32 and `llvm-ar`
//! (`docs/dev/web.md`). `NSH_DIST_NO_ANDROID` and `NSH_DIST_NO_WEB` leave the
//! Android and web runtimes out, which the release builds only once.

use std::{
    env,
    ffi::{OsStr, OsString},
    fs,
    path::Path,
    process::Command,
};

use anyhow::{Context as _, bail};

use crate::{android, term};

const IOS: &str = "aarch64-apple-ios";
const IOS_SIM: &str = "aarch64-apple-ios-sim";
const CATALYST: &str = "aarch64-apple-ios-macabi";
/// Whether the distribution has the iOS runtimes and SDK: on Apple silicon
/// only, the `ios` component's one host. They are built for arm64 (devices,
/// Apple silicon's simulator, Mac Catalyst), which an Intel Mac's simulator
/// and Mac Catalyst do not run.
const WITH_IOS: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"));

pub(crate) fn dist() -> anyhow::Result<()> {
    let root = android::root();
    let out = root.join("dist/nsh");
    if out.exists() {
        fs::remove_dir_all(&out)?;
    }
    let release = root.join("target");

    // The CLI for this machine.
    cargo(&["build", "--release", "-p", "nsh-cli"], "nsh")?;
    copy_executable(
        &release.join("release").join(exe("nsh")),
        &out.join("bin").join(exe("nsh")),
    )?;

    if WITH_IOS {
        ios_runtimes(&release, &out)?;
    }
    if cfg!(target_os = "macos") {
        for (package, what) in [
            ("nsh-macos-host", "the development host for macOS"),
            ("nsh-macos-app", "the release runner for macOS"),
        ] {
            cargo(&["build", "--release", "-p", package], what)?;
            copy_executable(
                &release.join("release").join(package),
                &out.join("runtime/macos").join(package),
            )?;
        }
    }
    if cfg!(target_os = "linux") {
        // Web views need WebKitGTK 6.0 to build (and then to run packaged
        // apps): without its development files the runtime is made with
        // placeholders for web views rather than not at all.
        let webkit = Command::new("pkg-config")
            .args(["--exists", "webkitgtk-6.0"])
            .status()
            .is_ok_and(|s| s.success());
        if !webkit {
            term::warn(
                "no WebKitGTK 6.0 (libwebkitgtk-6.0-dev): the Linux runtime shows placeholders for web views",
            );
        }
        for (package, what) in [
            ("nsh-linux-host", "the development host for Linux"),
            ("nsh-linux-app", "the release runner for Linux"),
        ] {
            let mut args = vec!["build", "--release", "-p", package];
            if !webkit {
                args.push("--no-default-features");
                // Without web views only: the release runner keeps the rest.
                if package == "nsh-linux-app" {
                    args.extend([
                        "--features",
                        "js,shader,editor,highlight,math,plot,rich-editor,zlib,crypto",
                    ]);
                }
            }
            cargo(&args, what)?;
            copy_executable(
                &release.join("release").join(package),
                &out.join("runtime/linux").join(package),
            )?;
        }
    }
    if cfg!(windows) {
        for (package, what) in [
            ("nsh-windows-host", "the development host for Windows"),
            ("nsh-windows-app", "the release runner for Windows"),
        ] {
            cargo(&["build", "--release", "-p", package], what)?;
            copy_executable(
                &release.join("release").join(exe(package)),
                &out.join("runtime/windows").join(exe(package)),
            )?;
        }
    }

    // GPUI is the backend for embedding in GPUI apps: its development
    // host only, no release runner.
    if cfg!(any(target_os = "linux", target_os = "macos", windows)) {
        let package = "nsh-gpui-host";
        // The GPUI backend is a workspace of its own (`crates/gpui`), built
        // into the same `target/`; huacnlee/cargo ignores `--target-dir`
        // and puts it in the GPUI workspace's own `target/`. The host is
        // taken from whichever of the two the build wrote.
        let built = [release.clone(), root.join("crates/gpui/target")]
            .map(|dir| dir.join("release").join(exe(package)));
        for file in &built {
            remove(file)?;
        }
        cargo(
            &[
                "build",
                "--release",
                "--manifest-path",
                "crates/gpui/Cargo.toml",
                "--target-dir",
                "target",
                "-p",
                package,
            ],
            "the development host for GPUI",
        )?;
        let host = built
            .iter()
            .find(|file| file.exists())
            .context("the GPUI build wrote no development host")?;
        copy_executable(host, &out.join("runtime/gpui").join(exe(package)))?;

        // The terminal's development host (`nsh run --target tui`).
        let package = "nsh-tui-host";
        cargo(
            &["build", "--release", "-p", package],
            "the development host for the terminal",
        )?;
        copy_executable(
            &release.join("release").join(exe(package)),
            &out.join("runtime/tui").join(exe(package)),
        )?;
    }

    // The web runtimes, the same files on every machine, all running TSX on
    // the browser's JavaScript engine: the linkable one `nsh package` links
    // each published app's from (only what the app uses), and the
    // development host's (hot updates, `nsh test --target web`). They build
    // to the same file, copied in turn. They need a C compiler that can
    // actually target wasm32: without one the distribution is made without
    // them, as with the Android runtimes without an SDK. The compiler is
    // the one the build will use, which docs/dev/web.md lets a macOS
    // developer set to an LLVM toolchain outside PATH.
    // An explicitly configured compiler is a promise that the web runtimes
    // are wanted: on a release runner a broken one must fail the build
    // rather than quietly ship an archive with no `runtime/web`.
    // `NSH_DIST_NO_WEB` leaves them out: the release's builds that don't
    // publish the `web` component set it, as with `NSH_DIST_NO_ANDROID`.
    let configured = ["CC_wasm32_unknown_unknown", "CC"]
        .iter()
        .any(|key| env::var_os(key).is_some_and(|value| !value.is_empty()));
    let compiler = wasm_cc(|key| env::var_os(key));
    let web = web_runtimes_plan(
        env::var_os("NSH_DIST_NO_WEB").is_some_and(|value| !value.is_empty()),
        configured,
        || {
            wasm_compiles(&compiler, |command| {
                command.status().is_ok_and(|status| status.success())
            })
        },
        &compiler,
    )?;
    match web {
        WebRuntimes::Build => web_runtimes(&root, &out, &release)?,
        WebRuntimes::OptedOut => {
            term::warn("NSH_DIST_NO_WEB is set: the distribution has no web runtime")
        }
        WebRuntimes::NoCompiler => term::warn(
            "no working wasm32 C compiler (set CC_wasm32_unknown_unknown): \
             the distribution has no web runtime",
        ),
    }

    // Android runtimes. Windows machines often have no Android SDK: the
    // distribution is then made without them. The NDK has no toolchain that
    // runs on arm64 Linux: there it never has them. `NSH_DIST_NO_ANDROID`
    // leaves them out anywhere: the release's builds that don't publish the
    // `android` component set it, so they skip it even where an SDK is found.
    let skip_android = android_skip(
        env::var_os("NSH_DIST_NO_ANDROID").is_some_and(|value| !value.is_empty()),
        !cfg!(all(target_os = "linux", not(target_arch = "x86_64"))),
        || !cfg!(windows) || android::Sdk::find().is_ok(),
    );
    if let Some(reason) = skip_android {
        term::warn(format!("{reason}: the distribution has no Android runtime"));
    }
    let android = skip_android.is_none();
    let abis: Vec<String> = android::ABIS.iter().map(|a| a.to_string()).collect();
    for (dev, name) in [(false, "release"), (true, "dev")]
        .into_iter()
        .filter(|_| android)
    {
        let built = android::build(true, dev, &abis)?;
        let dest = out.join("runtime/android").join(name);
        copy(&built.join("classes.dex"), &dest.join("classes.dex"))?;
        for abi in &abis {
            for dir in ["lib", "symbols"] {
                copy(
                    &built.join(dir).join(abi).join("libnsh.so"),
                    &dest.join(dir).join(abi).join("libnsh.so"),
                )?;
            }
        }
        let aar = out
            .join("embed/android")
            .join(if dev { "nsh-dev.aar" } else { "nsh.aar" });
        make_aar(&built, &abis, dev, &aar)?;
        term::done(format!(
            "packed {}",
            aar.strip_prefix(&root).unwrap_or(&aar).display()
        ));
    }

    if WITH_IOS {
        // iOS embedding: a static framework per platform (Rust + the Swift
        // module) in an XCFramework.
        crate::ios::xcframeworks(
            &out.join("embed/ios"),
            &out.join("work"),
            crate::ios::Options::default(),
        )?;
        fs::remove_dir_all(out.join("work"))?;
    }
    term::note(out.strip_prefix(&root).unwrap_or(&out).display());
    Ok(())
}

/// The C compiler a wasm32 build uses: the documented per-target override,
/// then `CC`, then the `clang` the build defaults to (`docs/dev/web.md`).
fn wasm_cc(get: impl Fn(&str) -> Option<OsString>) -> OsString {
    for key in ["CC_wasm32_unknown_unknown", "CC"] {
        if let Some(value) = get(key)
            && !value.is_empty()
        {
            return value;
        }
    }
    OsString::from("clang")
}

/// Whether the distribution has the web runtimes.
#[derive(Debug, PartialEq, Eq)]
enum WebRuntimes {
    Build,
    /// `NSH_DIST_NO_WEB` is set.
    OptedOut,
    /// No compiler was configured and the default one cannot target wasm32.
    NoCompiler,
}

/// Whether to build the web runtimes. An opt-out wins without probing the
/// compiler. A developer who explicitly configured a wasm32 compiler expects
/// them: a broken toolchain must fail the release rather than quietly ship an
/// archive with no `runtime/web`. With nothing configured, a machine without
/// a wasm32 clang still gets a usable (web-less) distribution, as before.
fn web_runtimes_plan(
    opted_out: bool,
    configured: bool,
    compiles: impl FnOnce() -> bool,
    compiler: &OsStr,
) -> anyhow::Result<WebRuntimes> {
    if opted_out {
        return Ok(WebRuntimes::OptedOut);
    }
    if compiles() {
        return Ok(WebRuntimes::Build);
    }
    if configured {
        bail!(
            "the configured wasm32 C compiler ({}) cannot compile for wasm32: \
             refusing to build a distribution without web runtimes",
            compiler.to_string_lossy()
        );
    }
    Ok(WebRuntimes::NoCompiler)
}

/// Why the distribution is made without the Android runtimes, or `None` to
/// build them: not when `NSH_DIST_NO_ANDROID` opts out, not where the NDK has
/// no toolchain (`ndk_host`), and not without an SDK where one is optional
/// (`sdk`, asked last because it searches the disk).
fn android_skip(
    opted_out: bool,
    ndk_host: bool,
    sdk: impl FnOnce() -> bool,
) -> Option<&'static str> {
    if opted_out {
        Some("NSH_DIST_NO_ANDROID is set")
    } else if !ndk_host {
        Some("the NDK does not run on this machine")
    } else if !sdk() {
        Some("no Android SDK (ANDROID_HOME)")
    } else {
        None
    }
}

/// Whether `compiler` can actually produce a wasm32 object. `clang
/// --version` is not an answer: Apple's clang has no WebAssembly target, and
/// a process that starts but exits nonzero still has an `Ok` status.
fn wasm_compiles(compiler: &OsStr, run: impl Fn(&mut Command) -> bool) -> bool {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = env::temp_dir().join(format!(
        "nsh-wasm-probe-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let source = dir.join("probe.c");
    let object = dir.join("probe.o");
    let ok = fs::write(&source, "int nsh_wasm_probe(void) { return 0; }\n").is_ok()
        && run(Command::new(compiler)
            .args(["--target=wasm32-unknown-unknown", "-c"])
            .arg(&source)
            .arg("-o")
            .arg(&object)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null()));
    let _ = fs::remove_dir_all(&dir);
    ok
}

/// The web runtimes: the linkable one and the development host's, the same
/// build linked from in turn, with the scripts and syntaxes they fetch.
fn web_runtimes(root: &Path, out: &Path, release: &Path) -> anyhow::Result<()> {
    for (features, file) in [
        (
            &["--no-default-features", "--features", "browser,linkable"][..],
            "nsh-browser.wasm",
        ),
        (
            &["--no-default-features", "--features", "dev"][..],
            "nsh-dev.wasm",
        ),
    ] {
        let mut web = Command::new(env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
        web.current_dir(root)
            .args(["build", "--profile", "web", "-p", "nsh-platform-web"])
            .args(features)
            .args(["--target", "wasm32-unknown-unknown"]);
        if env::var_os("AR_wasm32_unknown_unknown").is_none() && env::var_os("AR").is_none() {
            web.env("AR_wasm32_unknown_unknown", "llvm-ar");
        }
        term::cargo(&mut web, "the web runtime")?;
        copy(
            &release.join("wasm32-unknown-unknown/web/nsh_platform_web.wasm"),
            &out.join("runtime/web").join(file),
        )?;
    }
    copy(
        &root.join("crates/nsh-platform-web/web/nsh.js"),
        &out.join("runtime/web/nsh.js"),
    )?;
    // The syntaxes the web runtime leaves out and fetches when it first
    // highlights code: two-face's dump, as this workspace resolves it.
    copy(
        &package_dir(root, "two-face")?.join("generated/syntaxes-fancy-newlines.bin"),
        &out.join("runtime/web/nsh-syntaxes.bin"),
    )?;

    for entry in fs::read_dir(root.join("crates/nsh-platform-web/web/browser"))? {
        let entry = entry?;
        if entry
            .path()
            .extension()
            .is_some_and(|ext| ext == "js" || ext == "txt")
        {
            copy(
                &entry.path(),
                &out.join("runtime/web/browser").join(entry.file_name()),
            )?;
        }
    }
    Ok(())
}

/// The iOS runtimes: release runners, development hosts.
fn ios_runtimes(release: &Path, out: &Path) -> anyhow::Result<()> {
    for (triple, dir) in [(IOS, "iphoneos"), (IOS_SIM, "iphonesimulator")] {
        cargo(
            &[
                "build",
                "--release",
                "-p",
                "nsh-ios-app",
                "--target",
                triple,
            ],
            &format!("the release runner for {triple}"),
        )?;
        copy_executable(
            &release.join(triple).join("release/nsh-ios-app"),
            &out.join("runtime/ios").join(dir).join("nsh-ios-app"),
        )?;
    }
    for (triple, dir) in [(IOS_SIM, "iphonesimulator"), (CATALYST, "maccatalyst")] {
        cargo(
            &[
                "build",
                "--release",
                "-p",
                "nsh-ios-host",
                "--target",
                triple,
            ],
            &format!("the development host for {triple}"),
        )?;
        copy_executable(
            &release.join(triple).join("release/nsh-ios-host"),
            &out.join("runtime/ios").join(dir).join("nsh-ios-host"),
        )?;
    }
    Ok(())
}

/// R8 rules the archive carries (`proguard.txt`), which an app's Gradle
/// build applies when it shrinks the app: `libnsh.so` finds the runtime's
/// classes, methods and fields by name over JNI (`TextLayouts` in
/// `JNI_OnLoad`) and binds `native` methods by their Java names, which R8
/// would remove or rename, Java code never naming most of them.
const AAR_KEEP_RULES: &str = "\
# Native Shell: libnsh.so finds these classes and members by name over JNI
# and binds native methods by their Java names.
-keep class com.longbridge.nsh.** { *; }
";

/// An Android library archive: the Java runtime and `libnsh.so` per ABI,
/// with the R8 rules that keep the runtime ([`AAR_KEEP_RULES`]).
///
/// The development library allows cleartext HTTP (merged into the app's
/// manifest): it loads assets from the `nsh dev` server over plain HTTP.
fn make_aar(built: &Path, abis: &[String], dev: bool, aar: &Path) -> anyhow::Result<()> {
    let work = aar.with_extension("aar-work");
    if work.exists() {
        fs::remove_dir_all(&work)?;
    }
    fs::create_dir_all(&work)?;
    fs::write(
        work.join("AndroidManifest.xml"),
        format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.longbridge.nsh">
    <uses-sdk android:minSdkVersion="{}" />
    <uses-permission android:name="android.permission.INTERNET" />
    <!-- Text actions (Translate and the like) the selection menu offers,
        as TextView's: Android 11+ hides other apps' activities otherwise. -->
    <queries>
        <intent>
            <action android:name="android.intent.action.PROCESS_TEXT" />
            <data android:mimeType="text/plain" />
        </intent>
    </queries>{}
</manifest>
"#,
            android::MIN_SDK,
            if dev {
                "\n    <application android:usesCleartextTraffic=\"true\" />"
            } else {
                ""
            }
        ),
    )?;
    fs::write(work.join("R.txt"), "")?;
    fs::write(work.join("proguard.txt"), AAR_KEEP_RULES)?;
    copy(&built.join("classes.jar"), &work.join("classes.jar"))?;
    // With their symbols: the app's Gradle build strips what it packages
    // and keeps them for its crash reports.
    for abi in abis {
        copy(
            &built.join("symbols").join(abi).join("libnsh.so"),
            &work.join("jni").join(abi).join("libnsh.so"),
        )?;
    }
    if let Some(dir) = aar.parent() {
        fs::create_dir_all(dir)?;
    }
    let _ = fs::remove_file(aar);
    zip_dir(&work, aar).with_context(|| format!("create {}", aar.display()))?;
    fs::remove_dir_all(&work)?;
    Ok(())
}

/// Zips the files under `dir` into `archive`, by their paths relative to
/// `dir` (with `/`, whatever this machine's separator).
fn zip_dir(dir: &Path, archive: &Path) -> anyhow::Result<()> {
    use std::io::Write as _;

    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    let mut zip = ZipWriter::new(fs::File::create(archive)?);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut pending = vec![(dir.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = pending.pop() {
        let mut entries: Vec<_> = fs::read_dir(&dir)?.collect::<Result<_, _>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
            if entry.file_type()?.is_dir() {
                zip.add_directory(format!("{name}/"), options)?;
                pending.push((entry.path(), format!("{name}/")));
            } else {
                zip.start_file(name, options)?;
                zip.write_all(&fs::read(entry.path())?)?;
            }
        }
    }
    zip.finish()?;
    Ok(())
}

/// `cargo <args>` in the workspace: the step "building <what>".
pub(crate) fn cargo(args: &[&str], what: &str) -> anyhow::Result<()> {
    let cargo = env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    term::cargo(
        Command::new(cargo).current_dir(android::root()).args(args),
        what,
    )
}

/// The file of executable `name` built for this machine (`nsh.exe` on
/// Windows).
fn exe(name: &str) -> String {
    format!("{name}{}", env::consts::EXE_SUFFIX)
}

/// The directory of package `name` as the workspace at `root` resolves
/// it (`cargo metadata`).
fn package_dir(root: &Path, name: &str) -> anyhow::Result<std::path::PathBuf> {
    let output = Command::new(env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .current_dir(root)
        .args(["metadata", "--format-version", "1"])
        .output()
        .context("run cargo metadata")?;
    anyhow::ensure!(
        output.status.success(),
        "cargo metadata: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    let metadata: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("cargo metadata's output")?;
    let mut found = metadata["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["name"].as_str() == Some(name));
    let package = found
        .next()
        .with_context(|| format!("the workspace resolves no {name}"))?;
    anyhow::ensure!(
        found.next().is_none(),
        "the workspace resolves several versions of {name}"
    );
    let manifest = package["manifest_path"]
        .as_str()
        .context("cargo metadata: a package without manifest_path")?;
    Ok(Path::new(manifest)
        .parent()
        .context("a manifest without directory")?
        .to_path_buf())
}

/// Removes `file` if it is there, so that a build that writes it again
/// shows where it went.
pub(crate) fn remove(file: &Path) -> anyhow::Result<()> {
    match fs::remove_file(file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(e).with_context(|| format!("remove {}", file.display()))
        }
        _ => Ok(()),
    }
}

/// Copies the executable `from` to `to` without its symbol table: a sixth
/// or so of each executable, which nothing that runs it reads (panics name
/// no functions). Stripped after the build, not by the release profile's
/// `strip`, which would build everything again apart from the builds a
/// checkout keeps for profiling. Windows' executables keep their symbols in
/// PDB files, which the distribution leaves out.
fn copy_executable(from: &Path, to: &Path) -> anyhow::Result<()> {
    copy(from, to)?;
    if cfg!(target_os = "macos") {
        term::run(Command::new("strip").arg(to))?;
        // Stripping invalidates the linker's ad-hoc signature, without
        // which Apple silicon refuses to run the file.
        term::run(
            Command::new("codesign")
                .args(["--force", "--sign", "-"])
                .arg(to),
        )?;
    } else if cfg!(target_os = "linux") {
        term::run(Command::new("strip").arg("--strip-all").arg(to))?;
    }
    Ok(())
}

pub(crate) fn copy(from: &Path, to: &Path) -> anyhow::Result<()> {
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::copy(from, to).with_context(|| format!("copy {} -> {}", from.display(), to.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::{OsStr, OsString},
        fs,
        io::Read as _,
    };

    use super::{
        AAR_KEEP_RULES, WebRuntimes, android_skip, make_aar, wasm_cc, wasm_compiles,
        web_runtimes_plan,
    };

    #[test]
    fn an_aar_carries_the_rules_that_keep_the_runtime() {
        let dir = std::env::temp_dir().join(format!("nsh-aar-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let built = dir.join("built");
        fs::create_dir_all(built.join("symbols/arm64-v8a")).unwrap();
        fs::write(built.join("classes.jar"), b"jar").unwrap();
        fs::write(built.join("symbols/arm64-v8a/libnsh.so"), b"so").unwrap();
        let aar = dir.join("nsh.aar");
        make_aar(&built, &["arm64-v8a".to_string()], false, &aar).unwrap();
        let mut zip = zip::ZipArchive::new(fs::File::open(&aar).unwrap()).unwrap();
        let mut rules = String::new();
        zip.by_name("proguard.txt")
            .unwrap()
            .read_to_string(&mut rules)
            .unwrap();
        assert_eq!(rules, AAR_KEEP_RULES);
        assert!(rules.contains("-keep class com.longbridge.nsh.** { *; }"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_configured_wasm_compiler_is_probed_not_a_bare_clang() {
        // docs/dev/web.md: a macOS developer points this at an LLVM clang
        // outside PATH. Looking for `clang` on PATH instead would skip the
        // web runtimes even though the build has a working toolchain.
        let compiler = wasm_cc(|key| {
            (key == "CC_wasm32_unknown_unknown").then(|| OsString::from("/opt/llvm/bin/clang"))
        });
        assert_eq!(compiler, OsString::from("/opt/llvm/bin/clang"));
        assert!(wasm_compiles(&compiler, |command| {
            assert_eq!(command.get_program(), OsStr::new("/opt/llvm/bin/clang"));
            true
        }));
        assert_eq!(
            wasm_cc(|key| (key == "CC").then(|| OsString::from("cc"))),
            OsString::from("cc")
        );
        assert_eq!(wasm_cc(|_| None), OsString::from("clang"));
    }

    #[test]
    fn a_compiler_without_wasm32_is_not_enough() {
        // `clang --version` would have passed: the probe must require an
        // actual successful wasm32 compile.
        assert!(!wasm_compiles(OsStr::new("clang"), |_| false));
        assert!(wasm_compiles(OsStr::new("clang"), |_| true));
    }

    #[test]
    fn a_compiler_that_cannot_run_is_not_enough() {
        // The old guard's `.is_ok()` also accepted a process that never
        // started, or started and exited nonzero.
        let missing = std::env::temp_dir().join("nsh-no-such-clang");
        assert!(!wasm_compiles(missing.as_os_str(), |command| {
            command.status().is_ok_and(|status| status.success())
        }));
    }

    #[test]
    fn an_explicit_compiler_failure_fails_the_distribution() {
        let cc = OsStr::new("/opt/llvm/bin/clang");
        let plan = |configured, compiles| web_runtimes_plan(false, configured, || compiles, cc);
        assert_eq!(plan(false, true).unwrap(), WebRuntimes::Build);
        assert_eq!(plan(true, true).unwrap(), WebRuntimes::Build);
        // Nothing configured: a machine with no wasm32 clang still gets a
        // distribution, just without the web runtimes.
        assert_eq!(plan(false, false).unwrap(), WebRuntimes::NoCompiler);
        // release.yml sets CC_wasm32_unknown_unknown where it builds them: a
        // broken toolchain there must not quietly ship an archive with no
        // runtime/web.
        let error = plan(true, false).unwrap_err().to_string();
        assert!(error.contains("/opt/llvm/bin/clang"), "{error}");
    }

    #[test]
    fn web_is_left_out_when_opted_out() {
        let cc = OsStr::new("/opt/llvm/bin/clang");
        // The opt-out wins over a configured compiler, without probing it.
        let plan = web_runtimes_plan(true, true, || panic!("probed the compiler"), cc);
        assert_eq!(plan.unwrap(), WebRuntimes::OptedOut);
    }

    /// A stripped executable (this test's own) is smaller and still runs:
    /// on macOS, signed again.
    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn a_stripped_executable_still_runs() {
        let dir = std::env::temp_dir().join(format!("nsh-strip-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let exe = std::env::current_exe().unwrap();
        let stripped = dir.join("stripped");
        super::copy_executable(&exe, &stripped).unwrap();
        let size = |p: &std::path::Path| fs::metadata(p).unwrap().len();
        assert!(
            size(&stripped) < size(&exe),
            "{} >= {}",
            size(&stripped),
            size(&exe)
        );
        let output = std::process::Command::new(&stripped)
            .args(["--list", "--format", "terse"])
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("a_stripped_executable_still_runs")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn android_is_left_out_when_opted_out_or_unbuildable() {
        assert_eq!(android_skip(false, true, || true), None);
        assert_eq!(
            android_skip(true, true, || true),
            Some("NSH_DIST_NO_ANDROID is set")
        );
        assert_eq!(
            android_skip(false, false, || true),
            Some("the NDK does not run on this machine")
        );
        assert_eq!(
            android_skip(false, true, || false),
            Some("no Android SDK (ANDROID_HOME)")
        );
        // The opt-out wins without searching for an SDK.
        assert!(android_skip(true, true, || panic!("searched for an SDK")).is_some());
    }
}
