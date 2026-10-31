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
//! dist/nsh/runtime/tui/{nsh-tui-host,nsh-tui-app}[.exe]       terminal host, packaged app runner
//! dist/nsh/runtime/android/{release,dev}/                      classes.dex, lib/<abi>/libnsh.so (stripped),
//!                                                              symbols/<abi>/libnsh.so (with symbols)
//! dist/nsh/runtime/web/{nsh-browser.wasm,nsh-dev.wasm,nsh.js,browser/}  the web runtimes (published apps' to link from, the dev host's)
//! dist/nsh/runtime/web/nsh-syntaxes.bin                       the syntaxes they fetch to highlight code
//! dist/nsh/embed/ios/{NativeShell,NativeShellDev}.xcframework  embedding in iOS apps
//! dist/nsh/embed/android/{nsh,nsh-dev}.aar                     embedding in Android apps
//! ```
//!
//! The iOS runtimes and SDK need Xcode: they are built on macOS only, as is
//! the macOS (AppKit) runtime, built for this machine. The
//! Linux runtime is built for this machine, on Linux only (where it runs,
//! GTK 4, Pango and, for web views, WebKitGTK 6.0 must be installed;
//! without WebKitGTK's development files it is built with placeholders for
//! web views and needs only GTK); the Windows runtime likewise, on
//! Windows only (where the CLI is `bin/nsh.exe`). The GPUI development host
//! is built for this machine on each of the three. The web runtime is built
//! everywhere: it needs a clang that targets wasm32 and `llvm-ar`
//! (`docs/dev/web.md`).

use std::{env, fs, path::Path, process::Command};

use anyhow::Context as _;

use crate::{android, term};

const IOS: &str = "aarch64-apple-ios";
const IOS_SIM: &str = "aarch64-apple-ios-sim";
const CATALYST: &str = "aarch64-apple-ios-macabi";

pub(crate) fn dist() -> anyhow::Result<()> {
    let root = android::root();
    let out = root.join("dist/nsh");
    if out.exists() {
        fs::remove_dir_all(&out)?;
    }
    let release = root.join("target");

    // The CLI for this machine.
    cargo(&["build", "--release", "-p", "nsh-cli"], "nsh")?;
    copy(
        &release.join("release").join(exe("nsh")),
        &out.join("bin").join(exe("nsh")),
    )?;

    if cfg!(target_os = "macos") {
        ios_runtimes(&release, &out)?;
        for (package, what) in [
            ("nsh-macos-host", "the development host for macOS"),
            ("nsh-macos-app", "the release runner for macOS"),
        ] {
            cargo(&["build", "--release", "-p", package], what)?;
            copy(
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
            }
            cargo(&args, what)?;
            copy(
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
            copy(
                &release.join("release").join(exe(package)),
                &out.join("runtime/windows").join(exe(package)),
            )?;
        }
    }

    // Terminal runtimes use this machine's console and carry no GUI host.
    for (package, what) in [
        ("nsh-tui-host", "the terminal development host"),
        ("nsh-tui-app", "the terminal release runner"),
    ] {
        cargo(&["build", "--release", "-p", package], what)?;
        copy(
            &release.join("release").join(exe(package)),
            &out.join("runtime/tui").join(exe(package)),
        )?;
    }

    // GPUI is the backend for embedding in GPUI apps: its development
    // host only, no release runner.
    if cfg!(any(target_os = "linux", target_os = "macos", windows)) {
        let package = "nsh-gpui-host";
        // The GPUI backend is a workspace of its own (`crates/gpui`), built
        // into the same `target/`.
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
        copy(
            &release.join("release").join(exe(package)),
            &out.join("runtime/gpui").join(exe(package)),
        )?;
    }

    // The web runtimes, the same files on every machine, all running TSX on
    // the browser's JavaScript engine: the linkable one `nsh package` links
    // each published app's from (only what the app uses), and the
    // development host's (hot updates, `nsh test --target web`). They build
    // to the same file, copied in turn.
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
        web.current_dir(&root)
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
        &package_dir(&root, "two-face")?.join("generated/syntaxes-fancy-newlines.bin"),
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

    // Android runtimes. Windows machines often have no Android SDK: the
    // distribution is then made without them.
    let android = !cfg!(windows) || android::Sdk::find().is_ok();
    if !android {
        term::warn("no Android SDK (ANDROID_HOME): the distribution has no Android runtime");
    }
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

    if cfg!(target_os = "macos") {
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
        copy(
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
        copy(
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
    <uses-permission android:name="android.permission.INTERNET" />{}
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

pub(crate) fn copy(from: &Path, to: &Path) -> anyhow::Result<()> {
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::copy(from, to).with_context(|| format!("copy {} -> {}", from.display(), to.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Read as _};

    use super::{AAR_KEEP_RULES, make_aar};

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
}
