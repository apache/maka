//! Replacing the installed app with a downloaded one, on the desktop.
//!
//! The new app is unpacked next to the installed one (a rename needs the
//! same volume) and checked: its id and executable must be this app's, and
//! on macOS `codesign` must accept it. Then, on Linux and macOS, the whole
//! directory or `.app` is swapped by two renames, under the path the user
//! knows. Windows refuses to rename a directory holding the running
//! executable but renames the executable itself, so there each entry of the
//! directory is swapped (inside the directories holding the executable, their
//! entries), undone if one fails, and what is still in use is removed by the
//! next run ([`Installation::remove_leftovers`]).
//!
//! The same machinery replaces a plain directory holding an executable
//! ([`Installation::directory`]): the `nsh` distribution, which `nsh update`
//! replaces with a release's archive.
//!
//! An app installed where the user cannot write (a system package) has no
//! [`Installation::can_install`]: the app sends the user to the download.

use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use crate::Error;

/// Names what this code leaves next to the app or in it.
const STAGING: &str = ".nsh-updater-";
const OLD: &str = ".nsh-updater-old-";

/// The app on disk.
#[derive(Debug, Clone)]
pub struct Installation {
    /// The directory or `.app` replaced.
    root: PathBuf,
    /// The executable, under `root`.
    executable: PathBuf,
    /// The app's id; `None` for a plain directory.
    id: Option<String>,
}

impl Installation {
    /// The running app, if it is the package `config` (the bytes of its
    /// [`crate::CONFIG_ASSET`]) came from: the executable sits where `nsh
    /// package` puts it, beside that very file and an `app.json` of this
    /// id. Anything else has no installation (a development host, an app
    /// embedding NSH), and a plugin that names its host's id still does not
    /// hold its host's configuration unless it updates from the same source.
    pub fn current(id: &str, config: &[u8]) -> Option<Installation> {
        let executable = std::env::current_exe().ok()?;
        let executable = dunce_like(&executable);
        Installation::of(&executable, id, config)
    }

    /// As [`Installation::current`], for the executable at `executable`.
    pub fn of(executable: &Path, id: &str, config: &[u8]) -> Option<Installation> {
        let parent = executable.parent()?;
        let root = if cfg!(target_os = "macos") {
            let root = parent.parent()?.parent()?;
            root.extension().filter(|e| *e == "app")?;
            root
        } else {
            parent
        };
        let installation = Installation {
            root: root.to_owned(),
            executable: executable.strip_prefix(root).ok()?.to_owned(),
            id: Some(id.to_owned()),
        };
        let holds_config = fs::read(resources(root).join("assets").join(crate::CONFIG_ASSET))
            .is_ok_and(|held| held == config);
        (holds_config && package_id(root).as_deref() == Some(id)).then_some(installation)
    }

    /// A directory replaced as a whole, `executable` under it: an archive
    /// holding one directory with an executable at the same place replaces
    /// it. `None` when `executable` is not under `root`.
    pub fn directory(root: &Path, executable: &Path) -> Option<Installation> {
        Some(Installation {
            root: root.to_owned(),
            executable: executable.strip_prefix(root).ok()?.to_owned(),
            id: None,
        })
    }

    /// Whether the user can replace the app: `false` under a directory only
    /// the system writes.
    pub fn can_install(&self) -> bool {
        let Ok(probe) = staging(self.scratch_parent()) else {
            return false;
        };
        fs::remove_dir(&probe).is_ok()
    }

    /// Where the new app is unpacked: the directory it can be renamed from.
    fn scratch_parent(&self) -> &Path {
        self.root.parent().unwrap_or(&self.root)
    }

    /// Removes what an earlier update could not (Windows: the old
    /// executable, in use until the app exited).
    pub fn remove_leftovers(&self) {
        let mut dir = self.root.clone();
        let mut components = self.executable.components();
        components.next_back();
        loop {
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().contains(OLD) {
                        let _ = remove(&entry.path());
                    }
                }
            }
            match components.next() {
                Some(component) => dir.push(component),
                None => break,
            }
        }
    }

    /// Replaces the app with the archive at `archive` (`.tar.gz` or `.zip`,
    /// already verified, as `nsh package` makes them). The running app is
    /// left as it is: the caller restarts it (`nsh_core::restart`).
    pub fn install(&self, archive: &Path) -> Result<(), Error> {
        let scratch = staging(self.scratch_parent())?;
        let result = self.install_from(archive, &scratch);
        let _ = fs::remove_dir_all(&scratch);
        result
    }

    fn install_from(&self, archive: &Path, scratch: &Path) -> Result<(), Error> {
        unpack(archive, scratch)?;
        let new = single_entry(scratch)?;
        self.check_new(&new)?;
        if cfg!(windows) {
            swap_entries(&self.root, &new, &self.executable)
        } else {
            swap_directory(&self.root, &new)
        }
    }

    /// Whether `new` is this app, runnable.
    fn check_new(&self, new: &Path) -> Result<(), Error> {
        if let Some(id) = &self.id {
            match package_id(new) {
                Some(new_id) if new_id == *id => {}
                new_id => {
                    return Err(Error::Install(format!(
                        "the archive holds {new_id:?}, this app is {id:?}"
                    )));
                }
            }
        }
        if !new.join(&self.executable).is_file() {
            return Err(Error::Install(format!(
                "the archive has no {}",
                self.executable.display()
            )));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            if fs::metadata(new.join(&self.executable))?
                .permissions()
                .mode()
                & 0o111
                == 0
            {
                return Err(Error::Install("the new app is not executable".into()));
            }
        }
        if cfg!(target_os = "macos") && new.extension().is_some_and(|e| e == "app") {
            let status = Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(new)
                .status()?;
            if !status.success() {
                return Err(Error::Install("its code signature is not valid".into()));
            }
        }
        Ok(())
    }
}

/// The id in a package's `nsh/app.json`.
fn package_id(root: &Path) -> Option<String> {
    let text = fs::read_to_string(resources(root).join("app.json")).ok()?;
    let info: serde_json::Value = serde_json::from_str(&text).ok()?;
    info.get("id")?.as_str().map(str::to_owned)
}

/// A package's `nsh` directory.
fn resources(root: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        root.join("Contents/Resources/nsh")
    } else {
        root.join("nsh")
    }
}

/// Linux reports a replaced executable as `<path> (deleted)`; the path is
/// the one the user started.
fn dunce_like(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_suffix(" (deleted)") {
        Some(path) => PathBuf::from(path),
        None => path.to_owned(),
    }
}

/// A fresh directory in `parent`.
fn staging(parent: &Path) -> std::io::Result<PathBuf> {
    let pid = std::process::id();
    for attempt in 0..100 {
        let path = parent.join(format!("{STAGING}{pid}-{attempt}"));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other("no free staging directory"))
}

/// Unpacks an archive; entries outside `into` are refused by both readers.
fn unpack(archive: &Path, into: &Path) -> Result<(), Error> {
    let mut file = fs::File::open(archive)?;
    let mut magic = [0u8; 2];
    std::io::Read::read_exact(&mut file, &mut magic)?;
    std::io::Seek::rewind(&mut file)?;
    match &magic {
        [0x1f, 0x8b] => {
            let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
            tar.set_preserve_permissions(true);
            unpack_tar(&mut tar, into).map_err(|e| Error::Install(format!("unpack: {e}")))
        }
        b"PK" => zip::ZipArchive::new(file)
            .and_then(|mut zip| zip.extract(into))
            .map_err(|e| Error::Install(format!("unpack: {e}"))),
        _ => Err(Error::Install("not a .tar.gz or .zip".into())),
    }
}

/// As [`tar::Archive::unpack`], without the AppleDouble files (`._<name>`)
/// macOS's `tar` adds for a file's extended attributes, every file having
/// some there: beside the app they are a second entry, in it they break its
/// signature.
fn unpack_tar<R: std::io::Read>(tar: &mut tar::Archive<R>, into: &Path) -> std::io::Result<()> {
    let mut directories = Vec::new();
    for entry in tar.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;
        if path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("._"))
        {
            continue;
        }
        if entry.header().entry_type().is_dir() {
            directories.push(entry);
        } else {
            entry.unpack_in(into)?;
        }
    }
    // Last and deepest first: a directory's mode may not let files in.
    directories.sort_by(|a, b| b.path_bytes().cmp(&a.path_bytes()));
    for mut directory in directories {
        directory.unpack_in(into)?;
    }
    Ok(())
}

/// The one directory an archive holds (`<name>/`, `<name>.app/`).
fn single_entry(dir: &Path) -> Result<PathBuf, Error> {
    let mut entries = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    match (entries.pop(), entries.is_empty()) {
        (Some(entry), true) if entry.path().is_dir() => Ok(entry.path()),
        _ => Err(Error::Install(
            "the archive must hold one directory, the app".into(),
        )),
    }
}

/// Swaps two directories by renames; puts the old one back if the new one
/// cannot move.
fn swap_directory(root: &Path, new: &Path) -> Result<(), Error> {
    let name = root
        .file_name()
        .ok_or_else(|| Error::Install("the app has no directory name".into()))?;
    let old = root.with_file_name(format!(
        "{OLD}{}-{}",
        std::process::id(),
        name.to_string_lossy()
    ));
    fs::rename(root, &old)?;
    if let Err(e) = fs::rename(new, root) {
        fs::rename(&old, root)?;
        return Err(e.into());
    }
    let _ = fs::remove_dir_all(&old);
    Ok(())
}

/// Swaps the entries of `root` for those of `new`, the old ones renamed in
/// place, since what runs can be renamed but not removed. A directory
/// holding `executable` (relative to `root`) cannot be renamed either, so
/// its entries are swapped instead. Undone if any step fails.
fn swap_entries(root: &Path, new: &Path, executable: &Path) -> Result<(), Error> {
    let mut renames = Vec::new();
    if let Err(e) = swap_into(root, new, executable, &mut renames) {
        for (from, to) in renames.iter().rev() {
            let _ = fs::rename(to, from);
        }
        return Err(e);
    }
    for (_, to) in &renames {
        if to
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(OLD))
        {
            // What is in use goes on the next run.
            let _ = remove(to);
        }
    }
    Ok(())
}

/// One level of [`swap_entries`]; every rename done goes into `renames`.
fn swap_into(
    root: &Path,
    new: &Path,
    executable: &Path,
    renames: &mut Vec<(PathBuf, PathBuf)>,
) -> Result<(), Error> {
    let pid = std::process::id();
    let mut components = executable.components();
    let first = components.next().map(|c| c.as_os_str().to_owned());
    let rest = components.as_path();
    let descend = first.filter(|first| {
        !rest.as_os_str().is_empty() && root.join(first).is_dir() && new.join(first).is_dir()
    });
    let mut rename = |from: PathBuf, to: PathBuf| -> Result<(), Error> {
        fs::rename(&from, &to)?;
        renames.push((from, to));
        Ok(())
    };
    for entry in fs::read_dir(root)?.collect::<Result<Vec<_>, _>>()? {
        let name = entry.file_name();
        if name.to_string_lossy().contains(OLD) || Some(&name) == descend.as_ref() {
            continue;
        }
        let mut old = OsString::from(format!("{OLD}{pid}-"));
        old.push(&name);
        rename(entry.path(), root.join(old))?;
    }
    for entry in fs::read_dir(new)?.collect::<Result<Vec<_>, _>>()? {
        let name = entry.file_name();
        if Some(&name) == descend.as_ref() {
            continue;
        }
        rename(entry.path(), root.join(&name))?;
    }
    match descend {
        Some(dir) => swap_into(&root.join(&dir), &new.join(&dir), rest, renames),
        None => Ok(()),
    }
}

fn remove(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory removed at the end of the test.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> TempDir {
            static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("nsh-updater-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const CONFIG: &[u8] = b"{config}";

    /// A package of `id`, version `version`, under `dir/name`.
    fn package(dir: &Path, name: &str, id: &str, version: &str) -> (PathBuf, PathBuf) {
        let root = dir.join(name);
        let (exe, resources) = if cfg!(target_os = "macos") {
            (
                root.join("Contents/MacOS/App"),
                root.join("Contents/Resources/nsh"),
            )
        } else {
            (root.join("App"), root.join("nsh"))
        };
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::create_dir_all(resources.join("assets")).unwrap();
        fs::write(resources.join("assets").join(crate::CONFIG_ASSET), CONFIG).unwrap();
        fs::write(&exe, version).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(
            resources.join("app.json"),
            serde_json::json!({ "id": id, "version": version }).to_string(),
        )
        .unwrap();
        (root, exe)
    }

    /// The version in a package's `app.json`.
    fn version(root: &Path) -> String {
        let text = fs::read_to_string(resources(root).join("app.json")).unwrap();
        let info: serde_json::Value = serde_json::from_str(&text).unwrap();
        info["version"].as_str().unwrap().to_owned()
    }

    /// Makes the package runnable as far as `codesign` is concerned, as `nsh
    /// package` does; elsewhere there is nothing to do.
    fn sign(root: &Path) {
        if !cfg!(target_os = "macos") {
            return;
        }
        fs::copy("/usr/bin/true", root.join("Contents/MacOS/App")).unwrap();
        fs::write(
            root.join("Contents/Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>App</string>
<key>CFBundleIdentifier</key><string>com.example.app</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>"#,
        )
        .unwrap();
        let output = Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-", "--timestamp=none"])
            .arg(root)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    }

    fn tar_gz(dir: &Path, root: &Path, archive: &str) -> PathBuf {
        let path = dir.join(archive);
        let gz = flate2::write::GzEncoder::new(
            fs::File::create(&path).unwrap(),
            flate2::Compression::fast(),
        );
        let mut tar = tar::Builder::new(gz);
        tar.append_dir_all(root.file_name().unwrap(), root).unwrap();
        tar.into_inner().unwrap().finish().unwrap();
        path
    }

    fn name() -> &'static str {
        if cfg!(target_os = "macos") {
            "App.app"
        } else {
            "App"
        }
    }

    #[test]
    fn only_a_package_of_this_id_is_an_installation() {
        let dir = TempDir::new();
        let (_, exe) = package(dir.path(), name(), "com.example.app", "1.0.0");
        assert!(Installation::of(&exe, "com.example.app", CONFIG).is_some());
        // A plugin of its own source inside this app, even naming its id.
        assert!(Installation::of(&exe, "com.example.app", b"{other}").is_none());
        assert!(Installation::of(&exe, "com.other", CONFIG).is_none());
        let bare = dir.path().join("bare");
        fs::create_dir_all(&bare).unwrap();
        assert!(Installation::of(&bare.join("host"), "com.example.app", CONFIG).is_none());
    }

    #[test]
    fn an_archive_replaces_the_app() {
        let dir = TempDir::new();
        let (root, exe) = package(dir.path(), name(), "com.example.app", "1.0.0");
        let build = dir.path().join("build");
        let (new, _) = package(&build, name(), "com.example.app", "2.0.0");
        fs::write(resources(&new).join("added"), "x").unwrap();
        sign(&new);
        let archive = tar_gz(&build, &new, "new.tar.gz");

        let installation = Installation::of(&exe, "com.example.app", CONFIG).unwrap();
        assert!(installation.can_install());
        installation.install(&archive).unwrap();

        assert_eq!(version(&root), "2.0.0");
        assert!(resources(&root).join("added").exists());
        // Nothing is left beside it.
        let left: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".nsh-updater"))
            .collect();
        assert_eq!(left, Vec::<String>::new());
    }

    /// `tar -czf` on a Mac, as the guide has a developer archive an app they
    /// signed themselves.
    #[test]
    fn apple_double_files_are_not_installed() {
        let dir = TempDir::new();
        let (root, exe) = package(dir.path(), name(), "com.example.app", "1.0.0");
        let build = dir.path().join("build");
        let (new, _) = package(&build, name(), "com.example.app", "2.0.0");
        sign(&new);
        let path = build.join("new.tar.gz");
        let gz = flate2::write::GzEncoder::new(
            fs::File::create(&path).unwrap(),
            flate2::Compression::fast(),
        );
        let mut tar = tar::Builder::new(gz);
        let double = |tar: &mut tar::Builder<_>, path: String| {
            let mut header = tar::Header::new_gnu();
            header.set_size(1);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, path, &b"x"[..]).unwrap();
        };
        double(&mut tar, format!("._{}", name()));
        double(&mut tar, format!("{}/._inner", name()));
        tar.append_dir_all(name(), &new).unwrap();
        tar.into_inner().unwrap().finish().unwrap();

        let installation = Installation::of(&exe, "com.example.app", CONFIG).unwrap();
        installation.install(&path).unwrap();

        assert_eq!(version(&root), "2.0.0");
        assert!(!root.join("._inner").exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_app_codesign_refuses_changes_nothing() {
        let dir = TempDir::new();
        let (root, exe) = package(dir.path(), name(), "com.example.app", "1.0.0");
        let build = dir.path().join("build");
        let (new, _) = package(&build, name(), "com.example.app", "2.0.0");
        sign(&new);
        // Changed after signing.
        fs::write(
            resources(&new).join("app.json"),
            r#"{"id":"com.example.app","version":"3.0.0"}"#,
        )
        .unwrap();
        let archive = tar_gz(&build, &new, "new.tar.gz");

        let installation = Installation::of(&exe, "com.example.app", CONFIG).unwrap();
        let error = installation.install(&archive).unwrap_err().to_string();
        assert!(error.contains("code signature"), "{error}");
        assert_eq!(version(&root), "1.0.0");
    }

    #[test]
    fn an_archive_of_another_app_changes_nothing() {
        let dir = TempDir::new();
        let (_, exe) = package(dir.path(), name(), "com.example.app", "1.0.0");
        let build = dir.path().join("build");
        let (new, _) = package(&build, name(), "com.other", "2.0.0");
        let archive = tar_gz(&build, &new, "new.tar.gz");
        let installation = Installation::of(&exe, "com.example.app", CONFIG).unwrap();
        assert!(installation.install(&archive).is_err());
        assert_eq!(fs::read_to_string(&exe).unwrap(), "1.0.0");
    }

    #[cfg(unix)]
    #[test]
    fn a_non_executable_update_leaves_the_old_app_intact() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = TempDir::new();
        let (root, exe) = package(dir.path(), name(), "com.example.app", "1.0.0");
        let build = dir.path().join("build");
        let (new, new_exe) = package(&build, name(), "com.example.app", "2.0.0");
        sign(&new);
        fs::set_permissions(new_exe, fs::Permissions::from_mode(0o644)).unwrap();
        let archive = tar_gz(&build, &new, "new.tar.gz");
        let installation = Installation::of(&exe, "com.example.app", CONFIG).unwrap();
        assert!(
            installation
                .install(&archive)
                .unwrap_err()
                .to_string()
                .contains("not executable")
        );
        assert_eq!(version(&root), "1.0.0");
        assert_eq!(fs::read_to_string(exe).unwrap(), "1.0.0");
    }

    #[test]
    fn garbage_is_not_an_archive() {
        let dir = TempDir::new();
        let (_, exe) = package(dir.path(), name(), "com.example.app", "1.0.0");
        let archive = dir.path().join("x");
        fs::write(&archive, "not an archive").unwrap();
        let installation = Installation::of(&exe, "com.example.app", CONFIG).unwrap();
        assert!(installation.install(&archive).is_err());
        assert_eq!(fs::read_to_string(&exe).unwrap(), "1.0.0");
    }

    #[test]
    fn entries_are_swapped_in_place_and_undone_on_failure() {
        let dir = TempDir::new();
        let root = dir.path().join("root");
        let new = dir.path().join("new");
        fs::create_dir_all(root.join("nsh")).unwrap();
        fs::create_dir_all(new.join("nsh")).unwrap();
        fs::write(root.join("App.exe"), "old").unwrap();
        fs::write(root.join("gone"), "old").unwrap();
        fs::write(new.join("App.exe"), "new").unwrap();
        swap_entries(&root, &new, Path::new("App.exe")).unwrap();
        assert_eq!(fs::read_to_string(root.join("App.exe")).unwrap(), "new");
        assert!(!root.join("gone").exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);

        // A new tree that is not there: everything is put back.
        let missing = dir.path().join("missing");
        assert!(swap_entries(&root, &missing, Path::new("App.exe")).is_err());
        assert_eq!(fs::read_to_string(root.join("App.exe")).unwrap(), "new");
        assert!(root.join("nsh").is_dir());
    }

    /// Windows cannot rename the directory holding the running executable
    /// (`bin/nsh.exe`): its entries are swapped, the rest as a whole.
    #[test]
    fn the_directory_holding_the_executable_is_swapped_inside() {
        let dir = TempDir::new();
        let root = dir.path().join("root");
        let new = dir.path().join("new");
        for tree in [&root, &new] {
            fs::create_dir_all(tree.join("bin")).unwrap();
            fs::create_dir_all(tree.join("runtime")).unwrap();
        }
        fs::write(root.join("bin/nsh.exe"), "old").unwrap();
        fs::write(root.join("bin/gone.exe"), "old").unwrap();
        fs::write(root.join("runtime/old"), "old").unwrap();
        fs::write(new.join("bin/nsh.exe"), "new").unwrap();
        fs::write(new.join("runtime/new"), "new").unwrap();
        let exe = Path::new("bin/nsh.exe");
        swap_entries(&root, &new, exe).unwrap();
        assert_eq!(fs::read_to_string(root.join("bin/nsh.exe")).unwrap(), "new");
        assert!(!root.join("bin/gone.exe").exists());
        assert!(root.join("runtime/new").exists());
        assert!(!root.join("runtime/old").exists());
    }

    #[test]
    fn an_archive_replaces_a_directory() {
        let dir = TempDir::new();
        let root = dir.path().join("nsh");
        let build = dir.path().join("build");
        let new = build.join("nsh");
        for (tree, version) in [(&root, "old"), (&new, "new")] {
            fs::create_dir_all(tree.join("bin")).unwrap();
            fs::write(tree.join("bin/nsh"), version).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                fs::set_permissions(tree.join("bin/nsh"), fs::Permissions::from_mode(0o755))
                    .unwrap();
            }
        }
        fs::write(root.join("bin/stale"), "old").unwrap();
        let archive = tar_gz(&build, &new, "nsh.tar.gz");

        let installation = Installation::directory(&root, &root.join("bin/nsh")).unwrap();
        assert!(Installation::directory(&root, &dir.path().join("elsewhere")).is_none());
        installation.install(&archive).unwrap();
        assert_eq!(fs::read_to_string(root.join("bin/nsh")).unwrap(), "new");
        assert!(!root.join("bin/stale").exists());

        // An archive without the executable is refused.
        let empty = build.join("empty");
        fs::create_dir_all(empty.join("bin")).unwrap();
        fs::write(empty.join("bin/other"), "x").unwrap();
        let archive = tar_gz(&build, &empty, "empty.tar.gz");
        assert!(installation.install(&archive).is_err());
        assert_eq!(fs::read_to_string(root.join("bin/nsh")).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_parent_cannot_install() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = TempDir::new();
        let (root, exe) = package(dir.path(), name(), "com.example.app", "1.0.0");
        let parent = root.parent().unwrap();
        fs::set_permissions(parent, fs::Permissions::from_mode(0o555)).unwrap();
        let can = Installation::of(&exe, "com.example.app", CONFIG)
            .unwrap()
            .can_install();
        let writable_anyway = fs::File::create(parent.join("probe")).is_ok();
        fs::set_permissions(parent, fs::Permissions::from_mode(0o755)).unwrap();
        // Root ignores the mode.
        assert_eq!(can, writable_anyway);
    }
}
