//! The toolchain's side of app updates (`docs/dev/updater.md`): `nsh.json`'s
//! `"updater"` goes into the package, packages also leave an archive named
//! for their platform, and `nsh update-manifest` writes the manifest
//! describing the archives of one version and a signed package of the app's
//! code (`--package`).

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context as _, bail};
use nsh_updater::{
    Asset, CONFIG_ASSET, Config, MANIFEST, Manifest, PackageAsset, Packages, SIGNATURE,
};
use serde::Deserialize;

use crate::{package::AppConfig, ui};

/// `nsh.json`'s `"updater"`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdaterConfig {
    /// `owner/repo`: updates from its GitHub Releases.
    pub(crate) github: Option<String>,
    /// The manifest's URL on a host of the app's own.
    pub(crate) url: Option<String>,
    /// The manifests' Ed25519 key (`nsh keygen`'s `.pub`).
    pub(crate) public_key: Option<String>,
    /// Signed packages of the app's code the app runs over the air.
    pub(crate) packages: Option<PackagesConfig>,
}

/// `nsh.json`'s `"updater": { "packages": … }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackagesConfig {
    /// The roots (`nsh keygen`'s `root.pub`, base64) whose certified
    /// release keys sign the app's packages.
    pub(crate) roots: Vec<String>,
}

/// The app's version, as packages have it.
fn version(config: &AppConfig) -> &str {
    config.version.as_deref().unwrap_or("1.0.0")
}

/// The checked configuration of an app with `"updater"`.
fn runtime_config(config: &AppConfig, id: &str) -> anyhow::Result<Option<Config>> {
    let Some(updater) = &config.updater else {
        return Ok(None);
    };
    let mut runtime = Config::default();
    runtime.id = id.to_owned();
    runtime.version = version(config).to_owned();
    runtime.github = updater.github.clone();
    runtime.url = updater.url.clone();
    runtime.public_key = updater.public_key.clone();
    runtime.build = Some(config.build.unwrap_or(1).into());
    runtime.packages = updater.packages.as_ref().map(|packages| {
        let mut runtime = Packages::default();
        runtime.roots = packages.roots.iter().map(|r| r.trim().to_owned()).collect();
        runtime
    });
    runtime.validate().context("nsh.json")?;
    Ok(Some(runtime))
}

/// Adds the configuration to the package's assets, where `nsh/updater` reads
/// it on every platform.
pub(crate) fn add_config(
    config: &AppConfig,
    id: &str,
    out: &Path,
    built: &mut crate::build::Built,
) -> anyhow::Result<()> {
    let Some(runtime) = runtime_config(config, id)? else {
        return Ok(());
    };
    fs::create_dir_all(out)?;
    let source = out.join(format!(".{CONFIG_ASSET}"));
    fs::write(&source, serde_json::to_vec(&runtime)?)?;
    built.assets.push(crate::build::Asset {
        path: CONFIG_ASSET.to_owned(),
        source,
    });
    Ok(())
}

/// `<name>-<version>-<os>-<arch>.<extension>`: what a release publishes, one
/// per platform (desktop packages are built on the platform they are for).
fn archive_name(name: &str, version: &str, extension: &str) -> String {
    platform_archive_name(name, version, &nsh_updater::platform(), extension)
}

/// [`archive_name`] for `platform` (`macos-x86_64`): a macOS package built
/// for another processor (`nsh package --arch`).
fn platform_archive_name(name: &str, version: &str, platform: &str, extension: &str) -> String {
    let name: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    format!("{name}-{version}-{platform}.{extension}")
}

/// Copies the package's archive under its release name, for an app with
/// `"updater"`.
pub(crate) fn copy_archive(
    config: &AppConfig,
    name: &str,
    archive: &Path,
    out: &Path,
) -> anyhow::Result<()> {
    if config.updater.is_none() {
        return Ok(());
    }
    let extension = match archive.extension().and_then(|e| e.to_str()) {
        Some("zip") => "zip",
        _ => "tar.gz",
    };
    let release = out.join(archive_name(name, version(config), extension));
    fs::copy(archive, &release).with_context(|| format!("copy {}", archive.display()))?;
    ui::done(format!("update archive {}", ui::path(&release)));
    Ok(())
}

/// Archives a macOS `.app` under its release name, for an app with
/// `"updater"`. `tar` keeps the bundle's links and modes, which its
/// signature covers; `COPYFILE_DISABLE` keeps out the AppleDouble files
/// (`._<name>`) it would add for extended attributes, which it does not.
/// `platforms` are the updater's names of the platforms the app runs on
/// (`macos-aarch64`), one archive each: a universal app is the update of
/// either.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn archive_macos_app(
    config: &AppConfig,
    name: &str,
    app: &Path,
    out: &Path,
    platforms: &[String],
) -> anyhow::Result<()> {
    if config.updater.is_none() {
        return Ok(());
    }
    let Some((first, others)) = platforms.split_first() else {
        return Ok(());
    };
    let release = out.join(platform_archive_name(
        name,
        version(config),
        first,
        "tar.gz",
    ));
    let output = Command::new("tar")
        .env("COPYFILE_DISABLE", "1")
        .arg("-czf")
        .arg(&release)
        .arg("-C")
        .arg(out)
        .arg(app.file_name().context("the app has no name")?)
        .output()
        .context("run tar")?;
    if !output.status.success() {
        bail!(
            "creating {} failed: {}",
            release.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    ui::done(format!("update archive {}", ui::path(&release)));
    for platform in others {
        let copy = out.join(platform_archive_name(
            name,
            version(config),
            platform,
            "tar.gz",
        ));
        fs::copy(&release, &copy).with_context(|| format!("copy {}", release.display()))?;
        ui::done(format!("update archive {}", ui::path(&copy)));
    }
    Ok(())
}

/// Options of `nsh update-manifest`.
pub(crate) struct ManifestOptions<'a> {
    pub(crate) archives: &'a [PathBuf],
    pub(crate) package: Option<&'a Path>,
    pub(crate) entry: &'a Path,
    pub(crate) key: Option<&'a Path>,
    pub(crate) notes: Option<&'a Path>,
    pub(crate) links: &'a [String],
    pub(crate) base_url: Option<&'a str>,
    pub(crate) out: &'a Path,
}

/// The platform in an archive's name, after its version.
fn archive_platform(file: &str, version: &str) -> Option<String> {
    let marker = format!("-{version}-");
    let start = file.rfind(&marker)? + marker.len();
    let rest = &file[start..];
    let platform = rest
        .strip_suffix(".tar.gz")
        .or_else(|| rest.strip_suffix(".zip"))?;
    (!platform.is_empty()).then(|| platform.to_owned())
}

/// `nsh update-manifest`.
pub(crate) fn manifest(options: ManifestOptions<'_>) -> anyhow::Result<()> {
    let entry = dunce::canonicalize(options.entry)?;
    let entry = if entry.is_dir() {
        entry.join("App.tsx")
    } else {
        entry
    };
    let config = crate::package::read_config(&entry)?;
    let (_, id) = crate::package::release_name_and_id(&entry, &config)?;
    let Some(runtime) = runtime_config(&config, &id)? else {
        bail!("nsh.json has no \"updater\"");
    };
    let version = version(&config);
    let mut platforms = std::collections::BTreeMap::new();
    for archive in options.archives {
        let file = archive
            .file_name()
            .and_then(|f| f.to_str())
            .with_context(|| format!("{} has no file name", archive.display()))?;
        let Some(platform) = archive_platform(file, version) else {
            bail!(
                "{file}: expected <name>-{version}-<os>-<arch>.tar.gz or .zip, as `nsh package` names them"
            );
        };
        let bytes = fs::read(archive).with_context(|| format!("read {}", archive.display()))?;
        let url = match options.base_url {
            Some(base) => format!("{}/{file}", base.trim_end_matches('/')),
            None => file.to_owned(),
        };
        let mut asset = Asset::default();
        asset.url = url;
        asset.sha256 = Some(nsh_updater::sha256(&bytes));
        asset.size = Some(bytes.len() as u64);
        platforms.insert(platform, asset);
    }
    for link in options.links {
        let Some((platform @ ("ios" | "android"), url)) = link.split_once('=') else {
            bail!("--link {link}: expected ios=<url> or android=<url>");
        };
        let mut asset = Asset::default();
        asset.url = url.to_owned();
        platforms.insert(platform.to_owned(), asset);
    }
    let package = options
        .package
        .map(|path| package_asset(path, &runtime, options.base_url))
        .transpose()?;
    if options.archives.is_empty() && package.is_none() && options.links.is_empty() {
        bail!("nothing to describe: pass archives, --package or --link");
    }
    let notes = options
        .notes
        .map(fs::read_to_string)
        .transpose()
        .context("read the notes")?;
    let mut manifest = Manifest::default();
    manifest.id = id;
    manifest.version = version.to_owned();
    manifest.notes = notes;
    manifest.platforms = platforms;
    manifest.package = package;
    let bytes = serde_json::to_vec_pretty(&manifest)?;
    fs::create_dir_all(options.out)?;
    let path = options.out.join(MANIFEST);
    fs::write(&path, &bytes)?;
    ui::done(format!("wrote {}", ui::path(&path)));
    match (options.key, &runtime.public_key) {
        (Some(key), Some(public)) => {
            let secret =
                fs::read_to_string(key).with_context(|| format!("read {}", key.display()))?;
            let signature = nsh_updater::sign(&secret, &bytes)?;
            // Signed with the wrong key, every app would refuse the release.
            nsh_updater::verify(public, &bytes, signature.as_bytes())
                .context("--key is not the key of nsh.json's updater.publicKey")?;
            let path = options.out.join(SIGNATURE);
            fs::write(&path, format!("{signature}\n"))?;
            ui::done(format!("wrote {}", ui::path(&path)));
        }
        (None, Some(_)) => {
            bail!("nsh.json has updater.publicKey: pass --key, or apps refuse this manifest")
        }
        (Some(_), None) => bail!("--key without updater.publicKey in nsh.json: apps check nothing"),
        (None, None) => {}
    }
    Ok(())
}

/// The manifest's entry of the signed package at `path`: checked as the
/// app will (its roots in `nsh.json`, its id), so a release cannot offer a
/// package every app refuses.
fn package_asset(
    path: &Path,
    runtime: &Config,
    base_url: Option<&str>,
) -> anyhow::Result<PackageAsset> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let file = path
        .file_name()
        .and_then(|f| f.to_str())
        .with_context(|| format!("{} has no file name", path.display()))?;
    let header = nsh_package::verify_signature(&bytes)
        .with_context(|| format!("{file} is not a signed package"))?;
    let app = header.app();
    if app.id != runtime.id {
        bail!(
            "{file} is a package of {}, the app is {}",
            app.id,
            runtime.id
        );
    }
    let roots = runtime.package_roots();
    if roots.is_empty() {
        ui::warn(
            "nsh.json has no updater.packages.roots: apps of this build run no packages, newer \
             ones will",
        );
    } else {
        let mut trust = nsh_package::TrustStore::new();
        for root in roots {
            trust.add_root(nsh_package::PublicKey::from_base64(root)?);
        }
        trust.verify(&bytes, "").with_context(|| {
            format!("{file}: the app's roots (updater.packages.roots) refuse it")
        })?;
    }
    let mut asset = PackageAsset::default();
    asset.version = app.version.clone();
    asset.build = app.build;
    asset.url = match base_url {
        Some(base) => format!("{}/{file}", base.trim_end_matches('/')),
        None => file.to_owned(),
    };
    asset.sha256 = nsh_updater::sha256(&bytes);
    asset.size = Some(bytes.len() as u64);
    asset.min_runtime = header.min_runtime().to_owned();
    Ok(asset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archives_name_their_platform() {
        assert_eq!(
            archive_platform("My-App-1.2.0-linux-x86_64.tar.gz", "1.2.0").as_deref(),
            Some("linux-x86_64")
        );
        assert_eq!(
            archive_platform("App-1.2.0-windows-aarch64.zip", "1.2.0").as_deref(),
            Some("windows-aarch64")
        );
        assert_eq!(
            archive_platform("App-1.1.0-linux-x86_64.tar.gz", "1.2.0"),
            None
        );
        assert_eq!(archive_platform("App-1.2.0-linux.dmg", "1.2.0"), None);
    }

    /// A package of `id` signed by a release key `root` certifies, in `dir`.
    fn signed_package(dir: &Path, root: &nsh_package::SecretKey, id: &str) -> PathBuf {
        let release = nsh_package::SecretKey::generate().unwrap();
        let cert = nsh_package::certify(root, &release.public(), &["*".into()], 0, u64::MAX);
        let contents = nsh_package::Contents {
            app: nsh_package::App {
                id: id.into(),
                name: "App".into(),
                version: "1.2.1".into(),
                build: 7,
            },
            capabilities: None,
            source: "1".into(),
            bytecode: None,
            source_map: None,
            assets: Vec::new(),
            min_runtime: Some("0.1.0".into()),
        };
        let bytes = nsh_package::build(&contents, &release, &cert).unwrap();
        let path = dir.join(format!("{id}-7.nshpkg"));
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn manifests_offer_a_package_the_app_trusts() {
        let dir = std::env::temp_dir().join(format!("nsh-updater-package-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let root = nsh_package::SecretKey::generate().unwrap();
        let mut runtime = Config::default();
        runtime.id = "com.example.app".into();
        runtime.version = "1.2.0".into();
        runtime.github = Some("owner/repo".into());
        let mut packages = Packages::default();
        packages.roots = vec![root.public().to_base64()];
        runtime.packages = Some(packages);
        let path = signed_package(&dir, &root, "com.example.app");

        let asset = package_asset(&path, &runtime, None).unwrap();
        assert_eq!((asset.version.as_str(), asset.build), ("1.2.1", 7));
        assert_eq!(asset.url, "com.example.app-7.nshpkg");
        assert_eq!(asset.min_runtime, "0.1.0");
        assert_eq!(asset.sha256, nsh_updater::sha256(&fs::read(&path).unwrap()));
        assert_eq!(asset.size, Some(fs::metadata(&path).unwrap().len()));
        let hosted = package_asset(&path, &runtime, Some("https://x.dev/r/")).unwrap();
        assert_eq!(hosted.url, "https://x.dev/r/com.example.app-7.nshpkg");
        let mut manifest = Manifest::default();
        manifest.package = Some(asset);
        let json = serde_json::to_value(&manifest).unwrap();
        assert_eq!(json["package"]["minRuntime"], "0.1.0");
        assert_eq!(json["platforms"], serde_json::json!({}));

        // Another app's, signed under another root, tampered with.
        let other = signed_package(&dir, &root, "com.example.other");
        assert!(package_asset(&other, &runtime, None).is_err());
        let stranger = nsh_package::SecretKey::generate().unwrap();
        let untrusted = signed_package(&dir, &stranger, "com.example.app");
        assert!(package_asset(&untrusted, &runtime, None).is_err());
        let mut bytes = fs::read(&path).unwrap();
        let at = bytes.len() / 2;
        bytes[at] ^= 1;
        fs::write(&path, bytes).unwrap();
        assert!(package_asset(&path, &runtime, None).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn release_names_are_safe_in_urls() {
        let name = archive_name("My App", "1.2.0", "zip");
        assert!(name.starts_with("My-App-1.2.0-"), "{name}");
        assert_eq!(
            archive_platform(&name, "1.2.0").as_deref(),
            Some(nsh_updater::platform().as_str())
        );
    }

    /// `com.apple.provenance` is on all a Mac writes, so without this every
    /// archive has them, `tar -t` hiding them.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_archives_hold_no_apple_double_files() {
        let dir = std::env::temp_dir().join(format!("nsh-updater-archive-{}", std::process::id()));
        let contents = dir.join("App.app/Contents");
        fs::create_dir_all(&contents).unwrap();
        let file = contents.join("Info.plist");
        fs::write(&file, "x").unwrap();
        let status = Command::new("/usr/bin/xattr")
            .args(["-w", "dev.nsh.test", "1"])
            .arg(&file)
            .status()
            .unwrap();
        assert!(status.success());
        let config: AppConfig =
            serde_json::from_str(r#"{ "version": "1.2.0", "updater": {} }"#).unwrap();

        // A universal app: the archive of both processors.
        let platforms = ["macos-aarch64".to_owned(), "macos-x86_64".to_owned()];
        archive_macos_app(&config, "App", &dir.join("App.app"), &dir, &platforms).unwrap();

        let intel = dir.join("App-1.2.0-macos-x86_64.tar.gz");
        assert_eq!(
            archive_platform("App-1.2.0-macos-x86_64.tar.gz", "1.2.0").as_deref(),
            Some("macos-x86_64")
        );
        let archive = dir.join("App-1.2.0-macos-aarch64.tar.gz");
        assert_eq!(fs::read(&intel).unwrap(), fs::read(&archive).unwrap());
        let gz = flate2::read::GzDecoder::new(fs::File::open(archive).unwrap());
        let mut tar = tar::Archive::new(gz);
        let names: Vec<String> = tar
            .entries()
            .unwrap()
            .map(|e| e.unwrap().path().unwrap().to_string_lossy().into_owned())
            .collect();
        let _ = fs::remove_dir_all(&dir);
        assert!(names.iter().any(|n| n.ends_with("Info.plist")), "{names:?}");
        assert!(!names.iter().any(|n| n.contains("._")), "{names:?}");
    }
}
