//! Android apps without Gradle: the APK is assembled from the prebuilt
//! runtime (`classes.dex`, `libnsh.so` per ABI) and the app bundle with the
//! SDK's build tools (`aapt2`, `zipalign`, `apksigner`).

use std::{
    env, fs,
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context as _, bail};

/// Minimum Android version (API 26, Android 8.0), as the runtime is built.
pub(crate) const MIN_SDK: u32 = 26;
/// The Android version apps target unless `nsh.json` `android.targetSdk`
/// names another (API 35, Android 15: what Google Play requires).
pub(crate) const DEFAULT_TARGET_SDK: u32 = 35;
/// The ABIs the runtime is built for: `nsh package --abi`'s values.
pub(crate) const ABIS: [&str; 3] = ["arm64-v8a", "armeabi-v7a", "x86_64"];
/// The ABIs `nsh package` puts into an APK unless `--abi` names others:
/// the 64-bit and 32-bit processes of phones (`--run` adds the device's,
/// an emulator's `x86_64`).
pub(crate) const DEFAULT_ABIS: [&str; 2] = ["arm64-v8a", "armeabi-v7a"];

/// The Android SDK.
pub(crate) struct Sdk {
    root: PathBuf,
    build_tools: PathBuf,
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
            .context("Android SDK not found: install it and set ANDROID_HOME")?;
        let build_tools = newest(&root.join("build-tools"))
            .context("no SDK build-tools: install them with `sdkmanager \"build-tools;35.0.1\"`")?;
        Ok(Sdk { root, build_tools })
    }

    /// The platform an app targeting `level` compiles against.
    fn android_jar(&self, level: u32) -> anyhow::Result<PathBuf> {
        let jar = self
            .root
            .join(format!("platforms/android-{level}/android.jar"));
        if !jar.exists() {
            bail!(
                "{} missing: install it with `sdkmanager \"platforms;android-{level}\"`",
                jar.display()
            );
        }
        Ok(jar)
    }

    pub(crate) fn adb(&self) -> PathBuf {
        self.root.join("platform-tools/adb")
    }

    /// A cargo command set up to cross-compile for `triple` with the NDK
    /// (`ANDROID_NDK_HOME`, else the newest NDK of the SDK): an app's own
    /// `libnsh.so` (`rust_app.rs`).
    pub(crate) fn ndk_cargo(&self, triple: &str) -> anyhow::Result<Command> {
        let toolchain = self.ndk_toolchain()?;
        let bin = toolchain.join("bin");
        // On Windows the NDK's per-target compilers are batch files.
        let script = if cfg!(windows) { ".cmd" } else { "" };
        // ARMv7's compilers are named `armv7a-linux-androideabi`, the
        // others after Rust's triple.
        let clang_target = match triple {
            "armv7-linux-androideabi" => "armv7a-linux-androideabi",
            other => other,
        };
        let clang = bin.join(format!("{clang_target}{MIN_SDK}-clang{script}"));
        let env_triple = triple.replace('-', "_");
        // New NDKs keep the C standard headers their clang carries (stdbool.h
        // &c.) out of the sysroot: whatever libclang bindgen of the C
        // dependencies (quickjs-jit-sys) loads, give it that directory to
        // search as well. Last (`-idirafter`), so the libclang's own headers
        // still win and `#include_next` reaches the sysroot (#1282: `'stdbool.h'
        // file not found`, `unknown type name 'uint32_t'` on Windows).
        let clang_include = fs::read_dir(toolchain.join("lib/clang"))
            .ok()
            .and_then(|versions| {
                versions
                    .filter_map(|version| version.ok().map(|version| version.path()))
                    .map(|version| version.join("include"))
                    .find(|include| include.is_dir())
            });
        // bindgen splits this variable like a shell: quoted, with forward slashes,
        // so that the backslashes and spaces of a Windows path survive.
        let mut extra = format!(
            "--target={clang_target}{MIN_SDK} --sysroot=\"{}\"",
            toolchain
                .join("sysroot")
                .display()
                .to_string()
                .replace('\\', "/")
        );
        if let Some(include) = clang_include {
            let include = include.display().to_string().replace('\\', "/");
            extra.push_str(&format!(" -idirafter \"{include}\""));
        }
        let mut cmd = Command::new(env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
        cmd.env(format!("CC_{env_triple}"), &clang)
            .env(format!("AR_{env_triple}"), bin.join("llvm-ar"))
            .env(
                format!("CARGO_TARGET_{}_LINKER", env_triple.to_uppercase()),
                &clang,
            )
            .env(format!("BINDGEN_EXTRA_CLANG_ARGS_{env_triple}"), extra);
        // Use the NDK's own libclang when it carries one (r27+ do not);
        // setting LIBCLANG_PATH otherwise would cut clang-sys's discovery off.
        let ndk_libclang = bin.join(if cfg!(windows) {
            "libclang.dll"
        } else {
            "libclang.so"
        });
        if ndk_libclang.exists() {
            cmd.env("LIBCLANG_PATH", &bin);
        }
        Ok(cmd)
    }

    /// The NDK's LLVM toolchain (`ANDROID_NDK_HOME`, else the newest NDK of
    /// the SDK).
    fn ndk_toolchain(&self) -> anyhow::Result<PathBuf> {
        let ndk = match env::var_os("ANDROID_NDK_HOME") {
            Some(ndk) => PathBuf::from(ndk),
            None => newest(&self.root.join("ndk"))
                .context("no NDK in the SDK: install it with `sdkmanager \"ndk;<version>\"`")?,
        };
        // The NDK's "darwin-x86_64" toolchain is universal.
        let host = if cfg!(target_os = "macos") {
            "darwin-x86_64"
        } else if cfg!(windows) {
            "windows-x86_64"
        } else {
            "linux-x86_64"
        };
        Ok(ndk.join("toolchains/llvm/prebuilt").join(host))
    }

    /// Writes `library` to `to` without the symbols nothing links against
    /// (the dynamic ones, `JNI_OnLoad` and the natives, stay): an app's
    /// release `libnsh.so`, which APKs store uncompressed.
    pub(crate) fn strip(&self, library: &Path, to: &Path) -> anyhow::Result<()> {
        run(Command::new(self.ndk_toolchain()?.join("bin/llvm-strip"))
            .arg("--strip-unneeded")
            .arg("-o")
            .arg(to)
            .arg(library))
    }

    fn tool(&self, name: &str) -> PathBuf {
        // On Windows, the Java tools are batch files.
        if cfg!(windows) && name == "apksigner" {
            return self.build_tools.join("apksigner.bat");
        }
        self.build_tools.join(name)
    }
}

fn newest(dir: &Path) -> Option<PathBuf> {
    let mut versions: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect();
    versions.sort_by_key(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .split(['.', '-'])
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    });
    versions.pop()
}

/// What goes into an APK.
pub(crate) struct Apk<'a> {
    pub(crate) package: &'a str,
    pub(crate) label: &'a str,
    pub(crate) version_name: &'a str,
    pub(crate) version_code: u32,
    /// The API level the app targets (`targetSdkVersion`), which it also
    /// compiles against.
    pub(crate) target_sdk: u32,
    /// `com.longbridge.nsh.DevActivity` or `com.longbridge.nsh.AppActivity`.
    pub(crate) activity: &'a str,
    /// Development builds: debuggable, cleartext HTTP (the dev server).
    pub(crate) dev: bool,
    /// Plain HTTP is allowed (`android:usesCleartextTraffic`): development
    /// builds (the dev server's assets) and apps whose `nsh.json` sets
    /// `android.usesCleartextTraffic`.
    pub(crate) cleartext: bool,
    /// The app may show notifications: `POST_NOTIFICATIONS` is declared.
    pub(crate) notifications: bool,
    /// Web pages may use the microphone and the camera
    /// (`webview.media`): `RECORD_AUDIO` and `CAMERA` are declared.
    pub(crate) microphone: bool,
    pub(crate) camera: bool,
    /// URL schemes that open the app (nsh.json `schemes`): one
    /// `VIEW` intent filter.
    pub(crate) schemes: &'a [String],
    /// A Rust app: its `libnsh.so` has the root, which `AppActivity` runs
    /// instead of a bundle (manifest meta-data `com.longbridge.nsh.RUST`).
    pub(crate) rust: bool,
    /// `nsh.json` `"appearance": "dark"`: the window's theme is dark from
    /// the start (no light flash before the first frame).
    pub(crate) dark: bool,
    /// `classes.dex` and `lib/<abi>/libnsh.so`.
    pub(crate) runtime: &'a Path,
    /// The ABIs whose `libnsh.so` goes in, each of which the runtime must
    /// have (empty: every one it has).
    pub(crate) abis: &'a [String],
    /// Launcher icon (square PNG).
    pub(crate) icon: Option<&'a Path>,
    /// Files under `assets/` in the APK: (path in the APK, contents).
    pub(crate) assets: Vec<(String, Vec<u8>)>,
    pub(crate) signing: Signing,
}

/// What `nsh package --target android` writes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, clap::ValueEnum)]
pub(crate) enum Format {
    /// An APK: installed directly (`adb install`, sideloading).
    #[default]
    Apk,
    /// An Android App Bundle: uploaded to Google Play, which builds the
    /// APKs each device installs.
    Aab,
}

impl Format {
    pub(crate) fn extension(self) -> &'static str {
        match self {
            Format::Apk => "apk",
            Format::Aab => "aab",
        }
    }
}

/// How to sign the APK.
pub(crate) enum Signing {
    /// `~/.android/debug.keystore`, created if missing.
    Debug,
    /// A release keystore.
    Keystore {
        path: PathBuf,
        alias: String,
        password: String,
    },
}

pub(crate) fn build_apk(sdk: &Sdk, apk: &Apk<'_>, out: &Path) -> anyhow::Result<()> {
    build(sdk, apk, Format::Apk, out)
}

/// Writes `apk` to `out` as an APK or an Android App Bundle. A bundle's
/// manifest and resources are linked in the protobuf format and its files
/// laid out as Google Play reads them (module `base`): the same as Gradle's
/// `bundleRelease`, without Gradle or bundletool.
pub(crate) fn build(sdk: &Sdk, apk: &Apk<'_>, format: Format, out: &Path) -> anyhow::Result<()> {
    let work = out.with_extension(format!("{}-work", format.extension()));
    if work.exists() {
        fs::remove_dir_all(&work)?;
    }
    fs::create_dir_all(&work)?;

    // Resources: only the launcher icon.
    let mut flat = Vec::new();
    if let Some(icon) = apk.icon {
        // aapt2 parses the file's path itself: the components joined in one
        // go (`join("res/mipmap-xxxhdpi")`) leave a mix of `/` and `\` on
        // Windows, which it calls no valid file path. Joined by component
        // the path comes out uniform.
        let res = work.join("res").join("mipmap-xxxhdpi");
        fs::create_dir_all(&res)?;
        let icon_path = res.join("ic_launcher.png");
        resize_png(icon, &icon_path, 192)?;
        let compiled = work.join("compiled");
        fs::create_dir_all(&compiled)?;
        run(Command::new(sdk.tool("aapt2"))
            .arg("compile")
            .arg(&icon_path)
            .arg("-o")
            .arg(&compiled))?;
        for entry in fs::read_dir(&compiled)? {
            flat.push(entry?.path());
        }
    }

    let manifest = work.join("AndroidManifest.xml");
    fs::write(&manifest, manifest_xml(apk))?;
    let base = work.join("base.apk");
    let mut link = Command::new(sdk.tool("aapt2"));
    link.arg("link")
        .arg("-o")
        .arg(&base)
        .arg("-I")
        .arg(sdk.android_jar(apk.target_sdk)?)
        .arg("--manifest")
        .arg(&manifest)
        .args(["--min-sdk-version", &MIN_SDK.to_string()])
        .args(["--target-sdk-version", &apk.target_sdk.to_string()])
        .args(["--version-code", &apk.version_code.to_string()])
        .args(["--version-name", apk.version_name]);
    if apk.dev {
        link.arg("--debug-mode");
    }
    if format == Format::Aab {
        link.arg("--proto-format");
    }
    link.args(&flat);
    run(&mut link)?;

    if format == Format::Aab {
        let unsigned = work.join("unsigned.aab");
        write_bundle(&base, &unsigned, apk)?;
        sign_bundle(&apk.signing, &unsigned)?;
        fs::rename(&unsigned, out)?;
        fs::remove_dir_all(&work)?;
        return Ok(());
    }

    // Code, native libraries and app files.
    let unaligned = work.join("unaligned.apk");
    add_files(&base, &unaligned, apk, &Layout::APK)?;
    let aligned = work.join("aligned.apk");
    // `-P 16`: shared libraries on 16 KB pages (Android 15 devices).
    run(Command::new(sdk.tool("zipalign"))
        .args(["-P", "16", "-f", "4"])
        .arg(&unaligned)
        .arg(&aligned))?;
    sign(sdk, &apk.signing, &aligned)?;
    fs::rename(&aligned, out)?;
    fs::remove_dir_all(&work)?;
    Ok(())
}

fn manifest_xml(apk: &Apk<'_>) -> String {
    let icon = if apk.icon.is_some() {
        r#" android:icon="@mipmap/ic_launcher""#
    } else {
        ""
    };
    let cleartext = if apk.cleartext {
        r#" android:usesCleartextTraffic="true""#
    } else {
        ""
    };
    let rust = if apk.rust {
        "\n        <meta-data android:name=\"com.longbridge.nsh.RUST\" android:value=\"true\" />"
    } else {
        ""
    };
    let label = apk
        .label
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;");
    let post_notifications = if apk.notifications {
        "\n    <uses-permission android:name=\"android.permission.POST_NOTIFICATIONS\" />"
    } else {
        ""
    };
    let media: String = [(apk.microphone, "RECORD_AUDIO"), (apk.camera, "CAMERA")]
        .iter()
        .filter(|(declared, _)| *declared)
        .map(|(_, name)| {
            format!("\n    <uses-permission android:name=\"android.permission.{name}\" />")
        })
        .collect();
    // A link opens the running app (`onNewIntent`), not another activity in
    // the caller's task.
    let launch_mode = if apk.schemes.is_empty() {
        ""
    } else {
        r#" android:launchMode="singleTask""#
    };
    let schemes = if apk.schemes.is_empty() {
        String::new()
    } else {
        let data: String = apk
            .schemes
            .iter()
            .map(|s| format!("\n                <data android:scheme=\"{s}\" />"))
            .collect();
        format!(
            "\n            <intent-filter>\n                <action android:name=\"android.intent.action.VIEW\" />\n                <category android:name=\"android.intent.category.DEFAULT\" />\n                <category android:name=\"android.intent.category.BROWSABLE\" />{data}\n            </intent-filter>"
        )
    };
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{package}">
    <uses-permission android:name="android.permission.INTERNET" />{post_notifications}{media}
    <!-- Text actions (Translate and the like) the selection menu offers,
        as TextView's: Android 11+ hides other apps' activities otherwise. -->
    <queries>
        <intent>
            <action android:name="android.intent.action.PROCESS_TEXT" />
            <data android:mimeType="text/plain" />
        </intent>
    </queries>
    <application android:label="{label}"{icon}{cleartext}
        android:extractNativeLibs="false"
        android:enableOnBackInvokedCallback="true"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.Material{theme}.NoActionBar">{rust}
        <!-- Serves the app's own files to the apps that open them
            (`SystemUi.openPath`): the authority matches what
            `FilesProvider.uriFor` builds. -->
        <provider android:name="com.longbridge.nsh.FilesProvider"
            android:authorities="{package}.files"
            android:exported="false"
            android:grantUriPermissions="true" />
        <activity android:name="{activity}" android:exported="true"{launch_mode}
            android:windowSoftInputMode="adjustResize"
            android:configChanges="orientation|screenSize|screenLayout|smallestScreenSize|keyboard|keyboardHidden|navigation|uiMode|density|fontScale|locale|layoutDirection">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>{schemes}
        </activity>
    </application>
</manifest>
"#,
        package = apk.package,
        activity = apk.activity,
        theme = if apk.dark { "" } else { ".Light" },
    )
}

/// Where an APK or a bundle keeps what [`add_files`] puts in.
struct Layout {
    /// Prefix of what `aapt2 link` wrote; a bundle's manifest goes to
    /// `manifest/` under it.
    linked: &'static str,
    dex: &'static str,
    lib: &'static str,
    assets: &'static str,
}

impl Layout {
    const APK: Layout = Layout {
        linked: "",
        dex: "classes.dex",
        lib: "lib",
        assets: "assets",
    };
    /// The bundle's one module, `base`.
    const BUNDLE: Layout = Layout {
        linked: "base/",
        dex: "base/dex/classes.dex",
        lib: "base/lib",
        assets: "base/assets",
    };
}

/// An Android App Bundle: the module `base` from the proto-format `linked`,
/// [`add_files`]' code, libraries and assets, the libraries' ABIs
/// (`base/native.pb`) and `BundleConfig.pb`.
fn write_bundle(linked: &Path, out: &Path, apk: &Apk<'_>) -> anyhow::Result<()> {
    let files = work_file(out, "files.zip");
    let abis = add_files(linked, &files, apk, &Layout::BUNDLE)?;
    use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};
    let mut input = ZipArchive::new(fs::File::open(&files)?)?;
    let mut zip = ZipWriter::new(fs::File::create(out)?);
    for i in 0..input.len() {
        zip.raw_copy_file(input.by_index_raw(i)?)?;
    }
    let deflate = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("base/native.pb", deflate)?;
    zip.write_all(&native_pb(&abis)?)?;
    zip.start_file("BundleConfig.pb", deflate)?;
    zip.write_all(&bundle_config_pb())?;
    zip.finish()?;
    fs::remove_file(&files)?;
    Ok(())
}

fn work_file(next_to: &Path, name: &str) -> PathBuf {
    next_to.with_file_name(name)
}

/// Protobuf wire format, as much as the bundle's two files need.
mod pb {
    pub(super) fn varint(out: &mut Vec<u8>, mut value: u64) {
        while value >= 0x80 {
            out.push(value as u8 | 0x80);
            value >>= 7;
        }
        out.push(value as u8);
    }

    /// A length-delimited field: a string or a message.
    pub(super) fn bytes(out: &mut Vec<u8>, field: u32, value: &[u8]) {
        varint(out, (u64::from(field) << 3) | 2);
        varint(out, value.len() as u64);
        out.extend_from_slice(value);
    }

    /// A varint field: an enum.
    pub(super) fn enumeration(out: &mut Vec<u8>, field: u32, value: u64) {
        varint(out, u64::from(field) << 3);
        varint(out, value);
    }
}

/// The bundletool version the bundle says built it, which picks the
/// defaults Google Play builds the APKs with (native libraries stay
/// uncompressed, as `extractNativeLibs="false"` needs).
const BUNDLETOOL_VERSION: &str = "1.18.1";

/// `BundleConfig { bundletool { version } }` (bundletool's `config.proto`).
fn bundle_config_pb() -> Vec<u8> {
    let mut bundletool = Vec::new();
    pb::bytes(&mut bundletool, 2, BUNDLETOOL_VERSION.as_bytes());
    let mut config = Vec::new();
    pb::bytes(&mut config, 1, &bundletool);
    config
}

/// `NativeLibraries`: one `lib/<abi>` directory per ABI with its targeting
/// (bundletool's `files.proto`), from which Google Play makes one split per
/// ABI.
fn native_pb(abis: &[String]) -> anyhow::Result<Vec<u8>> {
    let mut libraries = Vec::new();
    for abi in abis {
        // `targeting.proto`'s `Abi.AbiAlias`.
        let alias = match abi.as_str() {
            "armeabi-v7a" => 2,
            "arm64-v8a" => 3,
            "x86" => 4,
            "x86_64" => 5,
            other => bail!("no bundle targeting for ABI {other}"),
        };
        let mut abi_message = Vec::new();
        pb::enumeration(&mut abi_message, 1, alias);
        let mut targeting = Vec::new();
        pb::bytes(&mut targeting, 1, &abi_message);
        let mut directory = Vec::new();
        pb::bytes(&mut directory, 1, format!("lib/{abi}").as_bytes());
        pb::bytes(&mut directory, 2, &targeting);
        pb::bytes(&mut libraries, 1, &directory);
    }
    Ok(libraries)
}

/// Signs a bundle with `jarsigner` (JAR signing: what Google Play checks
/// an upload against; `apksigner` signs only APKs).
fn sign_bundle(signing: &Signing, bundle: &Path) -> anyhow::Result<()> {
    let (keystore, alias, password) = keystore(signing)?;
    run(Command::new(java_tool("jarsigner"))
        .args(["-sigalg", "SHA256withRSA", "-digestalg", "SHA-256"])
        .arg("-keystore")
        .arg(&keystore)
        .args(["-storepass", &password])
        .args(["-keypass", &password])
        .arg(bundle)
        .arg(&alias))
    .context("sign the bundle (is a JDK installed?)")
}

/// A JDK tool: in `JAVA_HOME`, else on the path.
fn java_tool(name: &str) -> PathBuf {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    env::var_os("JAVA_HOME")
        .map(|home| PathBuf::from(home).join("bin").join(&exe))
        .filter(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from(exe))
}

/// Copies `base` (manifest, resources) and adds the dex, the libraries
/// (stored: the system maps them in place) and the assets, where `layout`
/// keeps them; returns the ABIs of the libraries.
fn add_files(
    base: &Path,
    out: &Path,
    apk: &Apk<'_>,
    layout: &Layout,
) -> anyhow::Result<Vec<String>> {
    use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};
    let mut input = ZipArchive::new(fs::File::open(base)?)?;
    let mut zip = ZipWriter::new(fs::File::create(out)?);
    for i in 0..input.len() {
        let file = input.by_index_raw(i)?;
        let name = file.name()?.into_owned();
        if layout.linked.is_empty() {
            zip.raw_copy_file(file)?;
        } else if name == "AndroidManifest.xml" {
            zip.raw_copy_file_rename(file, format!("{}manifest/{name}", layout.linked))?;
        } else {
            zip.raw_copy_file_rename(file, format!("{}{name}", layout.linked))?;
        }
    }
    let deflate = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    zip.start_file(layout.dex, deflate)?;
    let mut dex = Vec::new();
    fs::File::open(apk.runtime.join("classes.dex"))
        .context("runtime classes.dex missing")?
        .read_to_end(&mut dex)?;
    zip.write_all(&dex)?;
    let libs = apk.runtime.join("lib");
    let mut available = Vec::new();
    for entry in fs::read_dir(&libs).with_context(|| format!("read {}", libs.display()))? {
        let abi_dir = entry?.path();
        if abi_dir.join("libnsh.so").exists() {
            available.push(
                abi_dir
                    .file_name()
                    .context("abi")?
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    available.sort();
    if available.is_empty() {
        bail!("no libnsh.so in {}", libs.display());
    }
    let abis = if apk.abis.is_empty() {
        &available[..]
    } else {
        apk.abis
    };
    for abi in abis {
        if !available.contains(abi) {
            bail!(
                "the Android runtime has no libnsh.so for {abi} (it has {})",
                available.join(", ")
            );
        }
        let so = libs.join(abi).join("libnsh.so");
        zip.start_file(format!("{}/{abi}/libnsh.so", layout.lib), stored)?;
        zip.write_all(&fs::read(&so)?)?;
    }
    for (path, bytes) in &apk.assets {
        // Bytecode and images are compressed already or small.
        zip.start_file(format!("{}/{path}", layout.assets), deflate)?;
        zip.write_all(bytes)?;
    }
    zip.finish()?;
    Ok(abis.to_vec())
}

fn sign(sdk: &Sdk, signing: &Signing, apk: &Path) -> anyhow::Result<()> {
    let (keystore, alias, password) = keystore(signing)?;
    run(Command::new(sdk.tool("apksigner"))
        .args(["sign", "--ks"])
        .arg(&keystore)
        .args(["--ks-key-alias", &alias])
        .args(["--ks-pass", &format!("pass:{password}")])
        .args(["--key-pass", &format!("pass:{password}")])
        .arg(apk))
}

/// The keystore, key alias and password of `signing`.
fn keystore(signing: &Signing) -> anyhow::Result<(PathBuf, String, String)> {
    Ok(match signing {
        Signing::Debug => (
            debug_keystore()?,
            "androiddebugkey".to_owned(),
            "android".to_owned(),
        ),
        Signing::Keystore {
            path,
            alias,
            password,
        } => (path.clone(), alias.clone(), password.clone()),
    })
}

/// The standard debug keystore, created like Android Studio does.
fn debug_keystore() -> anyhow::Result<PathBuf> {
    let home = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let dir = PathBuf::from(env::var_os(home).context(home)?).join(".android");
    let path = dir.join("debug.keystore");
    if !path.exists() {
        fs::create_dir_all(&dir)?;
        run(Command::new("keytool")
            .args(["-genkeypair", "-keystore"])
            .arg(&path)
            .args([
                "-storepass",
                "android",
                "-alias",
                "androiddebugkey",
                "-keypass",
                "android",
                "-keyalg",
                "RSA",
                "-keysize",
                "2048",
                "-validity",
                "10000",
                "-dname",
                "CN=Android Debug,O=Android,C=US",
            ]))
        .context("create the debug keystore (is a JDK installed?)")?;
    }
    Ok(path)
}

fn resize_png(src: &Path, dest: &Path, size: u32) -> anyhow::Result<()> {
    let image = image::open(src).with_context(|| format!("read {}", src.display()))?;
    image
        .resize_exact(size, size, image::imageops::FilterType::Lanczos3)
        .save(dest)?;
    Ok(())
}

fn run(cmd: &mut Command) -> anyhow::Result<()> {
    let output = cmd
        .output()
        .with_context(|| format!("run {:?}", cmd.get_program()))?;
    if !output.status.success() {
        bail!(
            "{} failed:\n{}{}",
            Path::new(cmd.get_program()).display(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

/// The serial of a running device or emulator (the first one).
pub(crate) fn device(sdk: &Sdk) -> anyhow::Result<String> {
    let output = Command::new(sdk.adb()).arg("devices").output()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .skip(1)
        .filter_map(|l| l.split_once('\t'))
        .find(|(_, state)| *state == "device")
        .map(|(serial, _)| serial.to_owned())
        .context("no Android device or emulator connected (see `adb devices`)")
}

/// The ABIs `serial` runs, preferred first (`ro.product.cpu.abilist`).
pub(crate) fn device_abis(sdk: &Sdk, serial: &str) -> anyhow::Result<Vec<String>> {
    let list = adb(sdk, serial, &["shell", "getprop", "ro.product.cpu.abilist"])?;
    Ok(list
        .trim()
        .split(',')
        .filter(|abi| !abi.is_empty())
        .map(str::to_owned)
        .collect())
}

/// A port of the device forwarded to this machine (`adb reverse`), removed
/// when dropped, however the command ends (Ctrl-C too: it is
/// [`ui::Stoppable`] meanwhile): a dev host left on the device would
/// otherwise reach the next dev server on that port, of whatever app.
pub(crate) struct Reverse {
    adb: PathBuf,
    serial: String,
    port: String,
    _stoppable: crate::ui::Stoppable,
}

impl Reverse {
    pub(crate) fn add(sdk: &Sdk, serial: &str, port: u16) -> anyhow::Result<Reverse> {
        let port = format!("tcp:{port}");
        adb(sdk, serial, &["reverse", &port, &port])?;
        Ok(Reverse {
            adb: sdk.adb(),
            serial: serial.to_owned(),
            port,
            _stoppable: crate::ui::Stoppable::new(),
        })
    }
}

impl Drop for Reverse {
    fn drop(&mut self) {
        let removed = Command::new(&self.adb)
            .args(["-s", &self.serial, "reverse", "--remove", &self.port])
            .output();
        if !removed.is_ok_and(|o| o.status.success()) {
            crate::ui::debug(format!(
                "could not remove the adb reverse of {} on {}",
                self.port, self.serial
            ));
        }
    }
}

pub(crate) fn adb(sdk: &Sdk, serial: &str, args: &[&str]) -> anyhow::Result<String> {
    let output = Command::new(sdk.adb())
        .args(["-s", serial])
        .args(args)
        .output()
        .context("run adb")?;
    if !output.status.success() {
        bail!(
            "adb {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    fn apk(rust: bool, notifications: bool) -> super::Apk<'static> {
        super::Apk {
            package: "com.example.app",
            label: "App",
            version_name: "1.0",
            version_code: 1,
            target_sdk: super::DEFAULT_TARGET_SDK,
            activity: "com.longbridge.nsh.AppActivity",
            dev: false,
            cleartext: false,
            notifications,
            microphone: false,
            camera: false,
            schemes: &[],
            rust,
            dark: false,
            runtime: std::path::Path::new("."),
            abis: &[],
            icon: None,
            assets: Vec::new(),
            signing: super::Signing::Debug,
        }
    }

    #[test]
    fn a_rust_app_runs_its_root() {
        // `AppActivity` reads it from the application's meta-data.
        let flag = r#"<meta-data android:name="com.longbridge.nsh.RUST" android:value="true" />"#;
        let manifest = super::manifest_xml(&apk(true, false));
        assert!(manifest.contains(flag), "{manifest}");
        let application = manifest.find("<application").unwrap();
        let activity = manifest.find("<activity").unwrap();
        let at = manifest.find(flag).unwrap();
        assert!(application < at && at < activity, "{manifest}");
        assert!(!super::manifest_xml(&apk(false, false)).contains("com.longbridge.nsh.RUST"));
    }

    #[test]
    fn a_packaged_app_declares_the_files_provider() {
        // `SystemUi.openPath` hands the system's viewer a `content:` URI
        // of this authority; without the declaration the provider is not
        // resolved and the file cannot be opened.
        let manifest = super::manifest_xml(&apk(false, false));
        let provider = "<provider android:name=\"com.longbridge.nsh.FilesProvider\"";
        assert!(manifest.contains(provider), "{manifest}");
        assert!(
            manifest.contains("android:exported=\"false\""),
            "{manifest}"
        );
        assert!(
            manifest.contains("android:grantUriPermissions=\"true\""),
            "{manifest}"
        );
        let application = manifest.find("<application").unwrap();
        let activity = manifest.find("<activity").unwrap();
        let at = manifest.find(provider).unwrap();
        assert!(application < at && at < activity, "{manifest}");
    }

    #[test]
    fn only_an_app_granted_notifications_declares_their_permission() {
        let permission = "android.permission.POST_NOTIFICATIONS";
        assert!(super::manifest_xml(&apk(false, true)).contains(permission));
        assert!(!super::manifest_xml(&apk(false, false)).contains(permission));
    }

    #[test]
    fn only_an_app_whose_pages_capture_media_declares_its_permissions() {
        let manifest = super::manifest_xml(&super::Apk {
            microphone: true,
            ..apk(false, false)
        });
        assert!(manifest.contains("android.permission.RECORD_AUDIO"));
        assert!(!manifest.contains("android.permission.CAMERA"));
        assert!(!super::manifest_xml(&apk(false, false)).contains("RECORD_AUDIO"));
    }

    #[test]
    fn only_an_app_that_asks_allows_cleartext_traffic() {
        let attribute = r#"android:usesCleartextTraffic="true""#;
        assert!(!super::manifest_xml(&apk(false, false)).contains(attribute));
        let manifest = super::manifest_xml(&super::Apk {
            cleartext: true,
            ..apk(false, false)
        });
        let application = manifest.find("<application").unwrap();
        let activity = manifest.find("<activity").unwrap();
        let at = manifest.find(attribute).expect(&manifest);
        assert!(application < at && at < activity, "{manifest}");
    }

    #[test]
    fn bundle_metadata_is_what_bundletool_writes() {
        // `bundletool build-bundle` 1.18.1's own `BundleConfig.pb` and, for
        // a module with these two ABIs, `base/native.pb`.
        assert_eq!(super::bundle_config_pb(), b"\x0a\x08\x12\x061.18.1");
        let abis = ["arm64-v8a".to_owned(), "armeabi-v7a".to_owned()];
        let mut expected = b"\x0a\x15\x0a\x0dlib/arm64-v8a\x12\x04\x0a\x02\x08\x03".to_vec();
        expected.extend_from_slice(b"\x0a\x17\x0a\x0flib/armeabi-v7a\x12\x04\x0a\x02\x08\x02");
        assert_eq!(super::native_pb(&abis).unwrap(), expected);
    }
}
