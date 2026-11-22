//! The iOS embedding SDK: `NativeShell.xcframework` (and `NativeShellDev`
//! with development support).
//!
//! Each platform slice is a `NativeShell.framework` (static, or dynamic with
//! `--dynamic`) whose binary
//! holds the Rust runtime (`nsh-platform-ios` with feature `embed`, built as
//! a static library) and the `NativeShell` Swift module
//! (`crates/nsh-platform-ios/swift`), compiled with library evolution so apps
//! built with other Swift compilers can import it (`.swiftinterface`). The C
//! ABI (`NativeShellC`) is only used to compile the Swift module and is not
//! shipped.
//!
//! The Rust runtime goes into the framework as one relocatable object that
//! exports only the C ABI (`nsh_*`): Rust's runtime symbols
//! (`rust_eh_personality`), the standard library's and QuickJS' (`JS_*`)
//! become local, so apps that link another Rust static library (or QuickJS)
//! link NativeShell without duplicate symbols.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::Context as _;

use crate::{
    android,
    dist::{cargo, copy},
    term::{self, run},
};

/// The lowest iOS the frameworks support (as `.cargo/config.toml`).
const MIN_IOS: &str = "15.0";

/// What `cargo xtask ios-embed` builds.
#[derive(clap::Args, Clone, Copy, Debug, Default)]
pub(crate) struct Options {
    /// Also build the x86_64 simulator slice (apps whose simulator builds run
    /// under Rosetta, Intel Macs); needs `rustup target add x86_64-apple-ios`.
    #[arg(long)]
    pub(crate) x86_64_simulator: bool,
    /// Leave out the Mac Catalyst slice.
    #[arg(long)]
    pub(crate) no_catalyst: bool,
    /// Build only `NativeShell.xcframework`, not `NativeShellDev`.
    #[arg(long)]
    pub(crate) no_dev: bool,
    /// Build dynamic frameworks (embedded in the app) instead of static
    /// ones: the runtime gets an image of its own, with its own compact
    /// unwind table (an image can encode three personality routines; an app
    /// with the Objective-C and C++ ones and another Rust library's has no
    /// room for NSH's).
    #[arg(long)]
    pub(crate) dynamic: bool,
}

/// One architecture of a platform.
struct Arch {
    /// Rust target.
    rust: &'static str,
    /// Swift target, without the OS version.
    swift: (&'static str, &'static str),
}

impl Arch {
    /// The Swift (and clang) target with the OS version.
    fn target(&self) -> String {
        let (arch_os, env) = self.swift;
        format!("{arch_os}{MIN_IOS}{env}")
    }
}

/// A platform: one framework in the XCFramework, its binary holding every
/// architecture (merged with `lipo`).
struct Platform {
    archs: Vec<Arch>,
    /// SDK name for `xcrun --sdk`.
    sdk: &'static str,
    /// Mac Catalyst frameworks use the macOS (versioned) bundle layout.
    versioned: bool,
}

fn platforms(options: Options) -> Vec<Platform> {
    let mut simulator = vec![Arch {
        rust: "aarch64-apple-ios-sim",
        swift: ("arm64-apple-ios", "-simulator"),
    }];
    if options.x86_64_simulator {
        simulator.push(Arch {
            rust: "x86_64-apple-ios",
            swift: ("x86_64-apple-ios", "-simulator"),
        });
    }
    let mut platforms = vec![
        Platform {
            archs: vec![Arch {
                rust: "aarch64-apple-ios",
                swift: ("arm64-apple-ios", ""),
            }],
            sdk: "iphoneos",
            versioned: false,
        },
        Platform {
            archs: simulator,
            sdk: "iphonesimulator",
            versioned: false,
        },
    ];
    if !options.no_catalyst {
        platforms.push(Platform {
            archs: vec![Arch {
                rust: "aarch64-apple-ios-macabi",
                swift: ("arm64-apple-ios", "-macabi"),
            }],
            sdk: "macosx",
            versioned: true,
        });
    }
    platforms
}

/// Builds `NativeShell.xcframework` and `NativeShellDev.xcframework` into
/// `out`; intermediate files go to `work`.
pub(crate) fn xcframeworks(out: &Path, work: &Path, options: Options) -> anyhow::Result<()> {
    let root = android::root();
    let crate_dir = root.join("crates/nsh-platform-ios");
    let platforms = platforms(options);
    // The Swift module, once per architecture (the same for both variants).
    let step = term::Step::start("compiling the NativeShell Swift module");
    for platform in &platforms {
        for arch in &platform.archs {
            compile_swift(
                platform,
                arch,
                &crate_dir,
                &work.join("swift").join(arch.rust),
            )?;
        }
    }
    step.done("compiled the NativeShell Swift module");
    let variants: &[(bool, &str)] = if options.no_dev {
        &[(false, "NativeShell")]
    } else {
        &[(false, "NativeShell"), (true, "NativeShellDev")]
    };
    for &(dev, name) in variants {
        let mut frameworks = Vec::new();
        for platform in &platforms {
            let mut binaries = Vec::new();
            for arch in &platform.archs {
                let features = if dev { "embed,dev" } else { "embed" };
                cargo(
                    &[
                        "rustc",
                        "--release",
                        "-p",
                        "nsh-platform-ios",
                        "--target",
                        arch.rust,
                        "--features",
                        features,
                        "--crate-type",
                        "staticlib",
                    ],
                    &format!("the runtime of {name} for {}", arch.rust),
                )?;
                let rust_lib = root
                    .join("target")
                    .join(arch.rust)
                    .join("release/libnsh_platform_ios.a");
                let dir = work.join(name).join(arch.rust);
                fs::create_dir_all(&dir)?;
                let runtime = dir.join("nsh-runtime.o");
                hide_symbols(platform, arch, &rust_lib, &runtime)?;
                let binary = dir.join("NativeShell");
                if options.dynamic {
                    link_dynamic(platform, arch, &crate_dir, &runtime, &binary)?;
                } else {
                    run(Command::new("xcrun")
                        .args(["libtool", "-static", "-no_warning_for_no_symbols", "-o"])
                        .arg(&binary)
                        .arg(&runtime)
                        .arg(
                            work.join("swift")
                                .join(arch.rust)
                                .join("libNativeShellSwift.a"),
                        ))?;
                }
                binaries.push(binary);
            }
            let first = platform.archs[0].rust;
            let framework = work.join(name).join(first).join("NativeShell.framework");
            let swift: Vec<_> = platform
                .archs
                .iter()
                .map(|arch| work.join("swift").join(arch.rust))
                .collect();
            make_framework(platform, &binaries, &swift, &framework)?;
            frameworks.push(framework);
        }
        let xcframework = out.join(format!("{name}.xcframework"));
        if xcframework.exists() {
            fs::remove_dir_all(&xcframework)?;
        }
        let mut cmd = Command::new("xcodebuild");
        cmd.arg("-create-xcframework");
        for framework in &frameworks {
            cmd.arg("-framework").arg(framework);
        }
        cmd.arg("-output").arg(&xcframework);
        run(&mut cmd)?;
        term::done(format!("packed {name}.xcframework"));
    }
    Ok(())
}

/// The Rust static library as one relocatable object (`ld -r`) that exports
/// only the C ABI: every other global symbol (Rust's runtime and standard
/// library, QuickJS, the crates' C code) becomes local, so the app's other
/// Rust static libraries do not clash with it (`rust_eh_personality` is
/// defined by each of them).
fn hide_symbols(
    platform: &Platform,
    arch: &Arch,
    rust_lib: &Path,
    out: &Path,
) -> anyhow::Result<()> {
    let exports = out.with_extension("exports");
    fs::write(&exports, "_nsh_*\n")?;
    let sdk = sdk_path(platform.sdk)?;
    run(Command::new("xcrun")
        .args(["--sdk", platform.sdk, "clang", "-r", "-nostdlib"])
        .args(["-target", &arch.target(), "-isysroot", &sdk])
        .arg(format!("-Wl,-force_load,{}", rust_lib.display()))
        .arg(format!("-Wl,-exported_symbols_list,{}", exports.display()))
        .arg("-o")
        .arg(out))
}

fn sdk_path(sdk: &str) -> anyhow::Result<String> {
    let output = Command::new("xcrun")
        .args(["--sdk", sdk, "--show-sdk-path"])
        .output()
        .context("run xcrun")?;
    anyhow::ensure!(output.status.success(), "no {sdk} SDK (install Xcode)");
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

/// Compiles the Swift module into `dir`: `libNativeShellSwift.a` and the
/// module files named by the target (`arm64-apple-ios-simulator.*`).
fn compile_swift(
    platform: &Platform,
    arch: &Arch,
    crate_dir: &Path,
    dir: &Path,
) -> anyhow::Result<()> {
    fs::create_dir_all(dir)?;
    let (arch_os, env) = arch.swift;
    let target = arch.target();
    let module = dir.join(format!("{arch_os}{env}"));
    let sdk = sdk_path(platform.sdk)?;
    run(swiftc(platform, &target, &sdk)
        .args(["-emit-library", "-static"])
        .arg("-emit-module-path")
        .arg(module.with_extension("swiftmodule"))
        .arg("-emit-module-interface-path")
        .arg(module.with_extension("swiftinterface"))
        .arg("-I")
        .arg(crate_dir.join("include"))
        .arg(crate_dir.join("swift/NativeShell.swift"))
        .arg("-o")
        .arg(dir.join("libNativeShellSwift.a")))
}

/// `swiftc` set up to compile the `NativeShell` module for `target`.
fn swiftc(platform: &Platform, target: &str, sdk: &str) -> Command {
    let mut swiftc = Command::new("xcrun");
    swiftc.arg("swiftc");
    if platform.versioned {
        // Mac Catalyst: UIKit and its Swift overlays live in the macOS SDK's
        // iOSSupport.
        let support = format!("{sdk}/System/iOSSupport");
        swiftc
            .arg("-Fsystem")
            .arg(format!("{support}/System/Library/Frameworks"))
            .arg("-I")
            .arg(format!("{support}/usr/lib/swift"));
    }
    swiftc
        .args(["-parse-as-library", "-module-name", "NativeShell"])
        .args(["-target", target, "-sdk", sdk])
        .args(["-swift-version", "5", "-enable-library-evolution"])
        .args(["-O", "-whole-module-optimization"]);
    swiftc
}

/// A dynamic library: the Swift module linked with the Rust runtime
/// (`runtime`, which exports only the C ABI), installed at
/// `@rpath/NativeShell.framework/...`. The module files are the static
/// build's (`compile_swift`): the same source and flags.
fn link_dynamic(
    platform: &Platform,
    arch: &Arch,
    crate_dir: &Path,
    runtime: &Path,
    out: &Path,
) -> anyhow::Result<()> {
    let sdk = sdk_path(platform.sdk)?;
    let install_name = if platform.versioned {
        "@rpath/NativeShell.framework/Versions/A/NativeShell"
    } else {
        "@rpath/NativeShell.framework/NativeShell"
    };
    run(swiftc(platform, &arch.target(), &sdk)
        .arg("-emit-library")
        .arg("-I")
        .arg(crate_dir.join("include"))
        .arg(crate_dir.join("swift/NativeShell.swift"))
        .arg(runtime)
        .args(["-Xlinker", "-install_name", "-Xlinker", install_name])
        .args(["-Xlinker", "-dead_strip"])
        .arg("-o")
        .arg(out))
}

/// A framework: the binaries of the platform's architectures (each the Rust
/// runtime and the Swift library, as a static library or a dylib) merged
/// into one, the Swift module of every architecture and an Info.plist.
fn make_framework(
    platform: &Platform,
    binaries: &[PathBuf],
    swift: &[PathBuf],
    framework: &Path,
) -> anyhow::Result<()> {
    if framework.exists() {
        fs::remove_dir_all(framework)?;
    }
    let contents = if platform.versioned {
        framework.join("Versions/A")
    } else {
        framework.to_path_buf()
    };
    let resources = if platform.versioned {
        contents.join("Resources")
    } else {
        contents.clone()
    };
    fs::create_dir_all(&resources)?;
    let binary = contents.join("NativeShell");
    if let [single] = binaries {
        copy(single, &binary)?;
    } else {
        run(Command::new("xcrun")
            .arg("lipo")
            .arg("-create")
            .args(binaries)
            .arg("-output")
            .arg(&binary))?;
    }
    let modules = contents.join("Modules/NativeShell.swiftmodule");
    fs::create_dir_all(&modules)?;
    for dir in swift {
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            let keep = path
                .extension()
                .is_some_and(|e| e == "swiftinterface" || e == "swiftmodule" || e == "swiftdoc");
            let private = path.to_string_lossy().ends_with(".private.swiftinterface");
            if keep && !private {
                copy(&path, &modules.join(path.file_name().expect("file")))?;
            }
        }
    }
    fs::write(resources.join("Info.plist"), info_plist(platform))?;
    if platform.versioned {
        let link = |target: &str, name: &str| -> anyhow::Result<()> {
            symlink(target, &framework.join(name)).with_context(|| format!("link {name}"))
        };
        link("A", "Versions/Current")?;
        link("Versions/Current/NativeShell", "NativeShell")?;
        link("Versions/Current/Modules", "Modules")?;
        link("Versions/Current/Resources", "Resources")?;
    }
    Ok(())
}

#[cfg(unix)]
fn symlink(target: &str, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

/// Frameworks are built with Xcode, on macOS only.
#[cfg(not(unix))]
fn symlink(_target: &str, _link: &Path) -> std::io::Result<()> {
    Err(std::io::ErrorKind::Unsupported.into())
}

fn info_plist(platform: &Platform) -> String {
    let platform = match platform.sdk {
        "iphoneos" => "iPhoneOS",
        "iphonesimulator" => "iPhoneSimulator",
        _ => "MacOSX",
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>NativeShell</string>
    <key>CFBundleIdentifier</key><string>com.longbridge.nsh.NativeShell</string>
    <key>CFBundleName</key><string>NativeShell</string>
    <key>CFBundlePackageType</key><string>FMWK</string>
    <key>CFBundleShortVersionString</key><string>{version}</string>
    <key>CFBundleVersion</key><string>{version}</string>
    <key>CFBundleSupportedPlatforms</key><array><string>{platform}</string></array>
    <key>MinimumOSVersion</key><string>{MIN_IOS}</string>
</dict>
</plist>
"#,
        version = env!("CARGO_PKG_VERSION"),
    )
}

/// `cargo xtask ios-embed`: only the XCFrameworks, into
/// `dist/nsh/embed/ios`.
pub(crate) fn build(options: Options) -> anyhow::Result<PathBuf> {
    let root = android::root();
    let out = root.join("dist/nsh/embed/ios");
    let work = root.join("target/ios-embed");
    xcframeworks(&out, &work, options)?;
    Ok(out)
}
