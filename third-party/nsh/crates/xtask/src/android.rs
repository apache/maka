//! Android runtime builds: Rust (`libnsh.so`) with the NDK, Java with
//! `javac` + `d8` from the SDK. No Gradle.

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context as _, bail};

use crate::term;

/// ABIs built by default: phones' 64-bit and 32-bit processes, and the
/// emulators of x86-64 hosts.
pub(crate) const ABIS: [&str; 3] = ["arm64-v8a", "armeabi-v7a", "x86_64"];
/// Minimum Android API level (Android 9): hardware-accelerated shadow
/// layers and the `Typeface` weight API.
pub(crate) const MIN_SDK: u32 = 28;
/// The SDK platform compiled against.
pub(crate) const COMPILE_SDK: u32 = 35;

/// Locations of the Android SDK and NDK.
pub(crate) struct Sdk {
    pub(crate) root: PathBuf,
    pub(crate) ndk: PathBuf,
    pub(crate) build_tools: PathBuf,
}

impl Sdk {
    pub(crate) fn find() -> anyhow::Result<Sdk> {
        let root = ["ANDROID_HOME", "ANDROID_SDK_ROOT"]
            .iter()
            .find_map(env::var_os)
            .map(PathBuf::from)
            // Android Studio's default place.
            .or_else(|| {
                if cfg!(windows) {
                    env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Android/Sdk"))
                } else {
                    env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Android/sdk"))
                }
            })
            .filter(|p| p.exists())
            .context("Android SDK not found: set ANDROID_HOME")?;
        let ndk = match env::var_os("ANDROID_NDK_HOME") {
            Some(ndk) => PathBuf::from(ndk),
            None => {
                newest(&root.join("ndk")).context("no NDK in the SDK: install `ndk;<version>`")?
            }
        };
        let build_tools = newest(&root.join("build-tools")).context("no SDK build-tools")?;
        Ok(Sdk {
            root,
            ndk,
            build_tools,
        })
    }

    pub(crate) fn android_jar(&self) -> PathBuf {
        self.root
            .join(format!("platforms/android-{COMPILE_SDK}/android.jar"))
    }

    fn toolchain(&self) -> PathBuf {
        // The NDK's "darwin-x86_64" toolchain is universal.
        let host = if cfg!(target_os = "macos") {
            "darwin-x86_64"
        } else if cfg!(windows) {
            "windows-x86_64"
        } else {
            "linux-x86_64"
        };
        self.ndk.join("toolchains/llvm/prebuilt").join(host)
    }
}

/// The highest version-named subdirectory of `dir`.
fn newest(dir: &Path) -> Option<PathBuf> {
    let mut versions: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect();
    let key = |p: &PathBuf| -> Vec<u64> {
        p.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .split(['.', '-'])
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    };
    versions.sort_by_key(key);
    versions.pop()
}

fn triple(abi: &str) -> anyhow::Result<&'static str> {
    Ok(match abi {
        "arm64-v8a" => "aarch64-linux-android",
        "armeabi-v7a" => "armv7-linux-androideabi",
        "x86_64" => "x86_64-linux-android",
        other => bail!("unsupported ABI {other} (arm64-v8a, armeabi-v7a, x86_64)"),
    })
}

/// Repository root (this crate lives in `crates/xtask`).
pub(crate) fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Builds `libnsh.so` for `abis` and `classes.dex` into
/// `target/android/<profile>[-dev]`, returning that directory.
pub(crate) fn build(release: bool, dev: bool, abis: &[String]) -> anyhow::Result<PathBuf> {
    let sdk = Sdk::find()?;
    let profile = if release { "release" } else { "debug" };
    let out = root().join("target/android").join(if dev {
        format!("{profile}-dev")
    } else {
        profile.to_owned()
    });
    for abi in abis {
        let triple = triple(abi)?;
        let so = cargo_lib(&sdk, triple, abi, release, dev)?;
        check_alignment(&sdk, &so)?;
        let dest = out.join("lib").join(abi);
        fs::create_dir_all(&dest)?;
        // Unchanged files keep their times: `nsh run` rebuilds and
        // reinstalls the development host when they change.
        let dest = dest.join("libnsh.so");
        if !up_to_date(&dest, std::slice::from_ref(&so)) {
            fs::copy(&so, &dest)?;
        }
    }
    let java_dir = root().join("crates/nsh-platform-android/java");
    let mut sources = Vec::new();
    collect(&java_dir, &mut sources)?;
    // The directories too: removing a source changes its directory.
    let mut inputs = sources.clone();
    collect_dirs(&java_dir, &mut inputs)?;
    if !up_to_date(&out.join("classes.dex"), &inputs) || !out.join("classes.jar").exists() {
        let step = term::Step::start("compiling the Java runtime");
        java(&sdk, &out, &sources)?;
        step.done("compiled the Java runtime");
    }
    term::note(out.strip_prefix(root()).unwrap_or(&out).display());
    Ok(out)
}

/// Check the linked ELF, before it is copied into a runtime or an AAR.
fn check_alignment(sdk: &Sdk, library: &Path) -> anyhow::Result<()> {
    let output = Command::new(sdk.toolchain().join("bin/llvm-objdump"))
        .arg("-p")
        .arg(library)
        .output()
        .with_context(|| format!("inspect ELF alignment of {}", library.display()))?;
    if !output.status.success() {
        bail!(
            "llvm-objdump failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    check_load_alignment(&String::from_utf8(output.stdout)?)
        .with_context(|| format!("{} is not 16 KB aligned", library.display()))
}

fn check_load_alignment(headers: &str) -> anyhow::Result<()> {
    let mut loads = 0;
    for line in headers
        .lines()
        .filter(|line| line.split_whitespace().next() == Some("LOAD"))
    {
        let (_, exponent) = line
            .rsplit_once("align 2**")
            .context("missing LOAD alignment")?;
        let exponent: u32 = exponent.trim().parse().context("invalid LOAD alignment")?;
        if exponent < 14 {
            bail!("LOAD alignment is 2**{exponent}; expected at least 2**14");
        }
        loads += 1;
    }
    if loads == 0 {
        bail!("no ELF LOAD segments found");
    }
    Ok(())
}

/// The NDK's name of `triple` in its compilers' names: ARMv7's is
/// `armv7a-linux-androideabi`, the others are Rust's.
fn clang_target(triple: &str) -> &str {
    match triple {
        "armv7-linux-androideabi" => "armv7a-linux-androideabi",
        other => other,
    }
}

/// A cargo command set up to cross-compile for `triple` with the NDK.
fn ndk_cargo(sdk: &Sdk, triple: &str) -> Command {
    let toolchain = sdk.toolchain();
    let bin = toolchain.join("bin");
    // On Windows the NDK's per-target compilers are batch files.
    let script = if cfg!(windows) { ".cmd" } else { "" };
    let clang = bin.join(format!("{}{MIN_SDK}-clang{script}", clang_target(triple)));
    let env_triple = triple.replace('-', "_");
    let mut cmd = Command::new(env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
    cmd.current_dir(root())
        .env(format!("CC_{env_triple}"), &clang)
        .env(format!("AR_{env_triple}"), bin.join("llvm-ar"))
        .env(
            format!("CARGO_TARGET_{}_LINKER", env_triple.to_uppercase()),
            &clang,
        )
        // bindgen splits this variable like a shell: quoted, with forward slashes,
        // so that the backslashes and spaces of a Windows path survive.
        .env(
            format!("BINDGEN_EXTRA_CLANG_ARGS_{env_triple}"),
            format!(
                "--sysroot=\"{}\"",
                toolchain
                    .join("sysroot")
                    .display()
                    .to_string()
                    .replace('\\', "/")
            ),
        );
    cmd
}

/// Clippy on the Android crate (it is empty on other targets): with every
/// feature, and as a Rust app's library (no JS).
pub(crate) fn clippy() -> anyhow::Result<()> {
    let sdk = Sdk::find()?;
    for features in ["--all-features", "--no-default-features"] {
        let status = ndk_cargo(&sdk, "aarch64-linux-android")
            .args([
                "clippy",
                "-p",
                "nsh-platform-android",
                "--target",
                "aarch64-linux-android",
                features,
                "--",
                "-D",
                "warnings",
            ])
            .status()?;
        if !status.success() {
            bail!("clippy found problems ({features})");
        }
    }
    Ok(())
}

fn cargo_lib(
    sdk: &Sdk,
    triple: &str,
    abi: &str,
    release: bool,
    dev: bool,
) -> anyhow::Result<PathBuf> {
    let mut cmd = ndk_cargo(sdk, triple);
    cmd.args(["build", "-p", "nsh-platform-android", "--target", triple]);
    if release {
        cmd.arg("--release");
    }
    if dev {
        cmd.args(["--features", "dev"]);
    }
    term::cargo(&mut cmd, &format!("libnsh.so for {abi}"))?;
    let profile = if release { "release" } else { "debug" };
    Ok(root()
        .join("target")
        .join(triple)
        .join(profile)
        .join("libnsh.so"))
}

/// Whether `file` exists and is newer than each of `sources`.
fn up_to_date(file: &Path, sources: &[PathBuf]) -> bool {
    let modified = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
    let Some(built) = modified(file) else {
        return false;
    };
    sources
        .iter()
        .all(|s| modified(s).is_some_and(|m| m <= built))
}

/// Compiles the Java runtime (`sources`) to `out/classes.dex`.
fn java(sdk: &Sdk, out: &Path, sources: &[PathBuf]) -> anyhow::Result<()> {
    let classes = out.join("classes");
    if classes.exists() {
        fs::remove_dir_all(&classes)?;
    }
    fs::create_dir_all(&classes)?;
    // Java 17 bytecode: d8 desugars it for every supported API level.
    term::run(
        Command::new("javac")
            .args([
                "--release",
                "17",
                "-Xlint:-options",
                "-encoding",
                "UTF-8",
                "-classpath",
            ])
            .arg(sdk.android_jar())
            .arg("-d")
            .arg(&classes)
            .args(sources),
    )?;
    // One jar for d8 rather than every class file: on Windows `d8.bat` runs
    // through cmd.exe, whose command line ends at 8191 characters. It is
    // also the AAR's `classes.jar` (Gradle projects dex it themselves).
    let jar = out.join("classes.jar");
    let _ = fs::remove_file(&jar);
    term::run(
        Command::new("jar")
            .arg("cf")
            .arg(&jar)
            .arg("-C")
            .arg(&classes)
            .arg("."),
    )?;
    term::run(
        Command::new(
            sdk.build_tools
                .join(if cfg!(windows) { "d8.bat" } else { "d8" }),
        )
        .args(["--min-api", &MIN_SDK.to_string(), "--lib"])
        .arg(sdk.android_jar())
        .arg("--output")
        .arg(out)
        .arg(&jar),
    )
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    collect_ext(dir, "java", out)
}

/// `dir` and the directories in it.
fn collect_dirs(dir: &Path, out: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    out.push(dir.to_owned());
    for entry in fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let path = entry?.path();
        if path.is_dir() {
            collect_dirs(&path, out)?;
        }
    }
    Ok(())
}

fn collect_ext(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    for entry in fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let path = entry?.path();
        if path.is_dir() {
            collect_ext(&path, ext, out)?;
        } else if path.extension().is_some_and(|e| e == ext) {
            out.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::check_load_alignment;

    #[test]
    fn load_segments_support_16_kb_pages() {
        let headers = "libnsh.so: file format elf64-littleaarch64\n\
            LOAD off 0x0000 vaddr 0x0000 paddr 0x0000 align 2**14\n\
            LOAD off 0x4000 vaddr 0x4000 paddr 0x4000 align 2**16\n\
            DYNAMIC off 0x4010 vaddr 0x4010 paddr 0x4010 align 2**3\n";
        check_load_alignment(headers).unwrap();
        for exponent in [12, 13] {
            let headers = headers.replace("align 2**16", &format!("align 2**{exponent}"));
            let error = check_load_alignment(&headers).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains(&format!("LOAD alignment is 2**{exponent}"))
            );
        }
    }

    #[test]
    fn missing_or_invalid_load_headers_fail_the_check() {
        for headers in ["", "LOAD off 0x0000", "LOAD off 0x0000 align 2**invalid"] {
            assert!(check_load_alignment(headers).is_err(), "{headers}");
        }
    }
}
