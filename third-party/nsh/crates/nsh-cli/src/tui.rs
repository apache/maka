//! Terminal packages: a console runner with its resources beside it,
//! archived as a `.tar.gz` on Unix or a `.zip` on Windows.

use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use anyhow::{Context as _, bail};

use crate::{
    package::{AppConfig, PackageOptions},
    runtime::{self, Platform},
    ui,
};

/// Packages the terminal runner with the app's bundle, assets and metadata;
/// `--run` gives it this terminal until it exits.
pub(crate) fn package(
    options: &PackageOptions<'_>,
    config: &AppConfig,
    name: &str,
    id: &str,
    executable: &str,
    built: &crate::build::Built,
) -> anyhow::Result<()> {
    let runner = runtime::file(Platform::Tui, true)?;
    let step = ui::Step::start(format!("packaging {}", ui::path(options.out)));
    let files = write_package(options, config, name, id, executable, built, &runner)?;
    step.done(format!(
        "packaged {} and {}",
        ui::path(&files.directory),
        ui::path(&files.archive)
    ));
    if options.run {
        run(&files)?;
    }
    Ok(())
}

struct Files {
    directory: PathBuf,
    executable: PathBuf,
    archive: PathBuf,
}

fn write_package(
    options: &PackageOptions<'_>,
    config: &AppConfig,
    name: &str,
    id: &str,
    executable: &str,
    built: &crate::build::Built,
    runner: &Path,
) -> anyhow::Result<Files> {
    let stem = file_component(name);
    let directory = options.out.join(&stem);
    if directory.exists() {
        fs::remove_dir_all(&directory).with_context(|| {
            format!(
                "remove {} (is the app still running?)",
                ui::path(&directory)
            )
        })?;
    }
    let resources = directory.join("nsh");
    fs::create_dir_all(resources.join("assets"))?;
    let executable = file_component(executable);
    #[cfg(windows)]
    let executable = format!("{executable}.exe");
    // The resources already occupy `nsh/` beside the executable.
    #[cfg(not(windows))]
    let executable = if executable.eq_ignore_ascii_case("nsh") {
        "nsh-app".to_owned()
    } else {
        executable
    };
    let executable = directory.join(executable);
    fs::copy(runner, &executable).with_context(|| format!("copy {}", runner.display()))?;
    if !built.rust_root {
        fs::write(resources.join("bundle.nshc"), &built.bytecode)?;
    }
    if let Some(json) = built.capabilities_json() {
        fs::write(resources.join("capabilities.json"), json)?;
    }
    for asset in &built.assets {
        let path = Path::new(&asset.path);
        if path.as_os_str().is_empty()
            || !path
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            bail!("invalid asset path {:?}", asset.path);
        }
        let destination = resources.join("assets").join(path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&asset.source, &destination).with_context(|| format!("copy {}", asset.path))?;
    }
    let version = config.version.as_deref().unwrap_or("1.0.0");
    let mut info = serde_json::json!({ "name": name, "id": id, "version": version });
    if let Some(appearance) = &config.appearance {
        info["appearance"] = appearance.as_str().into();
    }
    fs::write(resources.join("app.json"), info.to_string())?;
    let archive = options.out.join(format!("{stem}.{}", archive_extension()));
    archive_directory(&directory, &stem, &archive)
        .with_context(|| format!("create {}", archive.display()))?;
    Ok(Files {
        directory,
        executable,
        archive,
    })
}

/// Keeps package paths inside the output directory on every desktop OS.
fn file_component(name: &str) -> String {
    let stem: String = name
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        .collect();
    let stem = stem.trim().trim_end_matches(['.', ' ']);
    if stem.is_empty() {
        return "App".to_owned();
    }
    let base = stem.split('.').next().unwrap_or(stem).to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || base.strip_prefix("COM").is_some_and(device_number)
        || base.strip_prefix("LPT").is_some_and(device_number);
    if reserved {
        format!("_{stem}")
    } else {
        stem.to_owned()
    }
}

fn device_number(suffix: &str) -> bool {
    matches!(suffix.as_bytes(), [b'1'..=b'9'])
}

fn archive_extension() -> &'static str {
    if cfg!(windows) { "zip" } else { "tar.gz" }
}

#[cfg(not(windows))]
fn archive_directory(directory: &Path, root: &str, archive: &Path) -> anyhow::Result<()> {
    let gzip =
        flate2::write::GzEncoder::new(fs::File::create(archive)?, flate2::Compression::default());
    let mut tar = tar::Builder::new(gzip);
    tar.append_dir_all(root, directory)?;
    tar.into_inner()?.finish()?;
    Ok(())
}

#[cfg(windows)]
fn archive_directory(directory: &Path, root: &str, archive: &Path) -> anyhow::Result<()> {
    use std::io::Write as _;

    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    let mut zip = ZipWriter::new(fs::File::create(archive)?);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut pending = vec![(directory.to_path_buf(), root.to_owned())];
    while let Some((directory, prefix)) = pending.pop() {
        zip.add_directory(format!("{prefix}/"), options)?;
        let mut entries: Vec<_> = fs::read_dir(directory)?.collect::<Result<_, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = format!("{prefix}/{}", entry.file_name().to_string_lossy());
            if entry.file_type()?.is_dir() {
                pending.push((entry.path(), name));
            } else {
                zip.start_file(name, options)?;
                std::io::copy(&mut fs::File::open(entry.path())?, &mut zip)?;
            }
        }
    }
    zip.finish()?.flush()?;
    Ok(())
}

fn run(files: &Files) -> anyhow::Result<()> {
    // A relative executable would otherwise resolve against the child's
    // package directory a second time when `current_dir` takes effect.
    let executable = dunce::canonicalize(&files.executable)?;
    let _terminal = ui::TerminalSession::new();
    let _stop = ui::Stoppable::new();
    let mut command = Command::new(&executable);
    command
        .current_dir(&files.directory)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("launch {}", executable.display()))?;
    #[cfg(windows)]
    let _job = crate::run::KillOnClose::assign(&child);
    let result = loop {
        match child.try_wait().context("wait for terminal app") {
            Ok(Some(status)) if status.success() || ui::stop_requested() => break Ok(()),
            Ok(Some(status)) => {
                break Err(anyhow::anyhow!(
                    "{} exited with {status}",
                    executable.display()
                ));
            }
            Ok(None) => {}
            Err(error) => break Err(error),
        }
        if ui::stop_requested() {
            break Ok(());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    crate::run::stop_terminal(&mut child);
    result
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    struct Directory(PathBuf);

    impl Directory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "nsh-tui-package-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn options(output: &Path) -> PackageOptions<'_> {
        PackageOptions {
            entry: Path::new("App.tsx"),
            target: crate::package::PackageTarget::Tui,
            out: output,
            config: AppConfig::default(),
            sign: None,
            profile: None,
            keystore: None,
            abis: &[],
            run: false,
        }
    }

    #[test]
    fn packages_runner_metadata_capabilities_and_assets() {
        let directory = Directory::new();
        let runner = directory.0.join("runner");
        fs::write(&runner, b"runner").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&runner, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let asset = directory.0.join("asset");
        fs::write(&asset, b"asset").unwrap();
        let mut config = AppConfig::default();
        config.version = Some("2.0.0".to_owned());
        config.appearance = Some("dark".to_owned());
        // Terminal packages use metadata without requiring GUI icon tools.
        config.icon = Some(directory.0.join("unused-icon.png"));
        let mut built = crate::build::rust_root();
        built.rust_root = false;
        built.bytecode = b"code".to_vec();
        built.capabilities = Some(nsh_core::access::Capabilities::default());
        built.assets = vec![crate::build::Asset {
            path: "images/example.bin".to_owned(),
            source: asset,
        }];
        let options = options(&directory.0);
        let files = write_package(
            &options,
            &config,
            "Demo Terminal",
            "com.example.demo",
            "Demo",
            &built,
            &runner,
        )
        .unwrap();
        assert_eq!(fs::read(&files.executable).unwrap(), b"runner");
        let resources = files.directory.join("nsh");
        assert_eq!(fs::read(resources.join("bundle.nshc")).unwrap(), b"code");
        assert_eq!(
            fs::read(resources.join("assets/images/example.bin")).unwrap(),
            b"asset"
        );
        let info: serde_json::Value =
            serde_json::from_slice(&fs::read(resources.join("app.json")).unwrap()).unwrap();
        assert_eq!(info["name"], "Demo Terminal");
        assert_eq!(info["id"], "com.example.demo");
        assert_eq!(info["version"], "2.0.0");
        assert_eq!(info["appearance"], "dark");
        assert_eq!(
            fs::read_to_string(resources.join("capabilities.json")).unwrap(),
            built.capabilities_json().unwrap()
        );
        assert!(!files.directory.join("com.example.demo.desktop").exists());
        assert_archive(&files);
    }

    #[cfg(not(windows))]
    fn assert_archive(files: &Files) {
        use std::io::Read as _;

        let gzip = flate2::read::GzDecoder::new(fs::File::open(&files.archive).unwrap());
        let mut archive = tar::Archive::new(gzip);
        let mut found = false;
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let path = entry.path().unwrap().into_owned();
            if path == Path::new("Demo Terminal/Demo") {
                assert_eq!(entry.header().mode().unwrap() & 0o111, 0o111);
            }
            if path == Path::new("Demo Terminal/nsh/bundle.nshc") {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                assert_eq!(bytes, b"code");
                found = true;
            }
        }
        assert!(found, "archive contains the app bundle under its directory");
    }

    #[cfg(windows)]
    fn assert_archive(files: &Files) {
        use std::io::Read as _;

        let mut archive = zip::ZipArchive::new(fs::File::open(&files.archive).unwrap()).unwrap();
        let mut bytes = Vec::new();
        archive
            .by_name("Demo Terminal/nsh/bundle.nshc")
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, b"code");
        assert!(archive.by_name("Demo Terminal/Demo.exe").is_ok());
    }

    #[test]
    fn rust_packages_replace_previous_bundle_and_keep_resource_directory() {
        let directory = Directory::new();
        let runner = directory.0.join("runner");
        fs::write(&runner, b"runner").unwrap();
        let options = options(&directory.0);
        let mut built = crate::build::rust_root();
        built.assets.clear();
        built.rust_root = false;
        built.bytecode = b"old code".to_vec();
        built.capabilities = Some(nsh_core::access::Capabilities::default());
        let config = AppConfig::default();
        write_package(
            &options,
            &config,
            "nsh",
            "com.example.nsh",
            "nsh",
            &built,
            &runner,
        )
        .unwrap();
        built.rust_root = true;
        built.capabilities = None;
        let files = write_package(
            &options,
            &config,
            "nsh",
            "com.example.nsh",
            "nsh",
            &built,
            &runner,
        )
        .unwrap();
        assert!(files.executable.is_file());
        assert!(files.directory.join("nsh/assets").is_dir());
        assert!(!files.directory.join("nsh/bundle.nshc").exists());
        assert!(!files.directory.join("nsh/capabilities.json").exists());
    }

    #[test]
    fn package_names_are_single_portable_path_components() {
        assert_eq!(file_component("Demo Terminal"), "Demo Terminal");
        assert_eq!(file_component("A/B: C?"), "AB C");
        assert_eq!(file_component("../../"), "App");
        assert_eq!(file_component(" .. "), "App");
        assert_eq!(file_component("CON"), "_CON");
        assert_eq!(file_component("com1.txt"), "_com1.txt");
        assert_eq!(file_component("LPT9"), "_LPT9");
        assert_eq!(file_component("COM10"), "COM10");
    }
}
