//! Replacing the installed app with a downloaded one, on the desktop.
//!
//! The new app is unpacked next to the installed one (a rename needs the
//! same volume) and checked: it must hold one runnable app, and on macOS
//! `codesign` must accept it. Its id and executable name may differ from the
//! installed app's (an app renamed, or moved to a new id): the manifest's
//! signature, checked before, is what binds the update to this app. Then, on
//! Linux and macOS, the whole directory or `.app` is swapped by two renames,
//! under the path the user knows (on macOS, a renamed `.app` takes its new
//! name beside the old one's place when that name is free). Windows refuses to rename a directory holding the running
//! executable but renames the executable itself, so there each entry of the
//! directory is swapped (inside the directories holding the executable, their
//! entries), undone if one fails, and what is still in use is removed by the
//! next run ([`Installation::remove_leftovers`]).
//!
//! Installing may be split in two ([`Installation::stage`],
//! [`Staged::finish`]): unpacked and checked now, swapped in later, as the
//! app quits, so that what can fail fails while the app can still say so
//! and quitting only renames.
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
pub(crate) const STAGING: &str = ".nsh-updater-";
const OLD: &str = ".nsh-updater-old-";
/// An update unpacked and checked, waiting to replace the app
/// (`<STAGED><pid>-<app's directory name>`, [`Installation::stage`]).
const STAGED: &str = ".nsh-updater-staged-";

/// The app on disk.
#[derive(Debug, Clone)]
pub struct Installation {
    /// The directory or `.app` replaced.
    root: PathBuf,
    /// The executable, under `root`.
    executable: PathBuf,
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

    /// Writes the installed app as the reference of a patch to it
    /// ([`crate::delta::base`]), returning its SHA-256.
    pub fn delta_base(&self, out: impl std::io::Write) -> Result<String, Error> {
        crate::delta::base(&self.root, out)
    }

    /// Where the new app is unpacked: the directory it can be renamed from.
    fn scratch_parent(&self) -> &Path {
        self.root.parent().unwrap_or(&self.root)
    }

    /// Removes what an earlier update could not (Windows: the old
    /// executable, in use until the app exited), and updates of this app
    /// that other processes staged and never finished (one that crashed
    /// before it quit).
    pub fn remove_leftovers(&self) {
        if let (Ok(own), Some(name), Ok(entries)) = (
            self.staged_dir(),
            self.root.file_name(),
            fs::read_dir(self.scratch_parent()),
        ) {
            for entry in entries.flatten() {
                let path = entry.path();
                let file_name = entry.file_name();
                let file_name = file_name.to_string_lossy();
                let theirs = file_name.strip_prefix(STAGED).is_some_and(|rest| {
                    rest.split_once('-').is_some_and(|(pid, app)| {
                        pid.parse::<u32>().is_ok() && *app == *name.to_string_lossy()
                    })
                });
                if theirs && path != own {
                    let _ = fs::remove_dir_all(&path);
                }
            }
        }
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
    /// already verified, as `nsh package` makes them), returning the new
    /// app's executable, the one to restart (its name, and on macOS its
    /// `.app`'s, may have changed). The running app is left as it is: the
    /// caller restarts it (`nsh_core::restart`).
    pub fn install(&self, archive: &Path) -> Result<PathBuf, Error> {
        self.stage(archive)?.finish()
    }

    /// The first half of [`Installation::install`]: unpacks `archive` next
    /// to the app and checks the new app as `install` does, without
    /// touching the installed one. [`Staged::finish`] then swaps it in, for
    /// instance as the app quits; dropping the [`Staged`] removes what was
    /// unpacked. A process stages one update per installation at a time: a
    /// second stage replaces the first's directory. What a process that
    /// ended without finishing or dropping left is removed by the next
    /// [`Installation::remove_leftovers`].
    pub fn stage(&self, archive: &Path) -> Result<Staged, Error> {
        let scratch = self.staged_dir()?;
        let _ = fs::remove_dir_all(&scratch);
        fs::create_dir(&scratch)?;
        // Removes the directory again if a step below fails.
        let mut staged = Staged {
            installation: self.clone(),
            scratch,
            new: PathBuf::new(),
            target: self.root.clone(),
            executable: PathBuf::new(),
        };
        unpack(archive, &staged.scratch)?;
        staged.new = single_entry(&staged.scratch)?;
        staged.executable = self.check_new(&staged.new)?;
        staged.target = self.target(&staged.new);
        Ok(staged)
    }

    /// Where this process stages an update of this app: beside it, named
    /// after the process and the app so that the next run of the app (and
    /// no other app sharing the directory) knows it for its own.
    fn staged_dir(&self) -> Result<PathBuf, Error> {
        let name = self
            .root
            .file_name()
            .ok_or_else(|| Error::Install("the app has no directory name".into()))?;
        let mut staged = OsString::from(format!("{STAGED}{}-", std::process::id()));
        staged.push(name);
        Ok(self.scratch_parent().join(staged))
    }

    /// Where the new app goes: the installed app's place, except on macOS
    /// for a `.app` renamed by the update (`Pal.app` to `Endless.app`) when
    /// its new name is free beside it. Windows swaps the entries of the
    /// directory holding the running executable, which cannot move, and
    /// Linux keeps the directory the user's launchers name.
    fn target(&self, new: &Path) -> PathBuf {
        if cfg!(target_os = "macos")
            && let (Some(name), Some(parent)) = (new.file_name(), self.root.parent())
            && Some(name) != self.root.file_name()
            && !parent.join(name).exists()
        {
            return parent.join(name);
        }
        self.root.clone()
    }

    /// Whether `new` holds a runnable app; its executable, under `new`.
    fn check_new(&self, new: &Path) -> Result<PathBuf, Error> {
        let executable = new_executable(new, &self.executable)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            if fs::metadata(new.join(&executable))?.permissions().mode() & 0o111 == 0 {
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
        Ok(executable)
    }
}

/// An update unpacked and checked beside the app ([`Installation::stage`]),
/// not yet in its place. Dropping it removes what was unpacked.
#[derive(Debug)]
pub struct Staged {
    installation: Installation,
    /// The directory unpacked into, beside the app.
    scratch: PathBuf,
    /// The new app, in `scratch`.
    new: PathBuf,
    /// Where the new app goes: the installed app's place, or on macOS its
    /// new name beside it ([`Installation::target`]).
    target: PathBuf,
    /// The new app's executable, under it.
    executable: PathBuf,
}

impl Staged {
    /// Swaps the staged app in for the installed one, as
    /// [`Installation::install`] does: on Linux and macOS two renames, on
    /// Windows the entries of the directory. Fails, leaving the installed
    /// app as it was, when either moved meanwhile (another update, the user
    /// moving the app). Returns the new app's executable, the one to
    /// restart. The running app is left as it is.
    pub fn finish(self) -> Result<PathBuf, Error> {
        let Installation { root, executable } = &self.installation;
        if self.target != *root {
            // The next run, under the new name, would not know these.
            self.installation.remove_leftovers();
        }
        if cfg!(windows) {
            swap_entries(root, &self.new, executable)?;
        } else {
            swap_directory(root, &self.new, &self.target)?;
        }
        Ok(self.target.join(&self.executable))
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.scratch);
    }
}

/// The executable of the app at `new`, relative to it: where the installed
/// app has its own (`installed`) when it is there, else the one the new app
/// names (macOS: `Info.plist`'s `CFBundleExecutable`), else the one runnable
/// file in the directory the installed app's executable sits in
/// (`Contents/MacOS`, or the app's directory).
fn new_executable(new: &Path, installed: &Path) -> Result<PathBuf, Error> {
    if new.join(installed).is_file() {
        return Ok(installed.to_owned());
    }
    if cfg!(target_os = "macos")
        && let Some(name) = bundle_executable(new)
    {
        let executable = Path::new("Contents/MacOS").join(name);
        if new.join(&executable).is_file() {
            return Ok(executable);
        }
    }
    let dir = installed.parent().unwrap_or(Path::new(""));
    let mut found = fs::read_dir(new.join(dir))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .filter(|entry| runnable(&entry.path()))
        .map(|entry| dir.join(entry.file_name()));
    match (found.next(), found.next()) {
        (Some(executable), None) => Ok(executable),
        _ => Err(Error::Install(format!(
            "the archive has no single app executable in {:?}",
            dir.display().to_string()
        ))),
    }
}

/// Whether the file at `path` is a program: an `.exe` on Windows, an
/// executable file elsewhere.
fn runnable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
    }
}

/// `CFBundleExecutable` in a bundle's XML `Info.plist`, as `nsh package`
/// writes it.
fn bundle_executable(bundle: &Path) -> Option<String> {
    let text = fs::read_to_string(bundle.join("Contents/Info.plist")).ok()?;
    let rest = &text[text.find("<key>CFBundleExecutable</key>")? + 29..];
    let rest = rest.trim_start().strip_prefix("<string>")?;
    let name = &rest[..rest.find("</string>")?];
    (!name.is_empty() && !name.contains('/')).then(|| name.to_owned())
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
        _ if is_tar(&mut file)? => {
            let mut tar = tar::Archive::new(file);
            tar.set_preserve_permissions(true);
            unpack_tar(&mut tar, into).map_err(|e| Error::Install(format!("unpack: {e}")))
        }
        b"PK" => zip::ZipArchive::new(file)
            .and_then(|mut zip| zip.extract(into))
            .map_err(|e| Error::Install(format!("unpack: {e}"))),
        _ => Err(Error::Install("not a .tar.gz, .tar or .zip".into())),
    }
}

/// Whether `file` is a plain `.tar` (a patched update, [`crate::delta`]):
/// `ustar` at offset 257. Leaves the file at its start.
fn is_tar(file: &mut fs::File) -> std::io::Result<bool> {
    use std::io::{Read as _, Seek as _, SeekFrom};
    let mut magic = [0u8; 5];
    file.seek(SeekFrom::Start(257))?;
    let tar = file.read_exact(&mut magic).is_ok() && &magic == b"ustar";
    file.rewind()?;
    Ok(tar)
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

/// Replaces `root` by `new`, moved to `target` (`root`, or a new name
/// beside it), by renames; puts the old one back if the new one cannot
/// move.
fn swap_directory(root: &Path, new: &Path, target: &Path) -> Result<(), Error> {
    let name = root
        .file_name()
        .ok_or_else(|| Error::Install("the app has no directory name".into()))?;
    let old = root.with_file_name(format!(
        "{OLD}{}-{}",
        std::process::id(),
        name.to_string_lossy()
    ));
    fs::rename(root, &old)?;
    if let Err(e) = fs::rename(new, target) {
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
        package_of(dir, name, "App", id, version)
    }

    /// As [`package`], its executable named `executable`.
    fn package_of(
        dir: &Path,
        name: &str,
        executable: &str,
        id: &str,
        version: &str,
    ) -> (PathBuf, PathBuf) {
        let root = dir.join(name);
        let (exe, resources) = if cfg!(target_os = "macos") {
            (
                root.join("Contents/MacOS").join(executable),
                root.join("Contents/Resources/nsh"),
            )
        } else if cfg!(windows) {
            (root.join(format!("{executable}.exe")), root.join("nsh"))
        } else {
            (root.join(executable), root.join("nsh"))
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
        sign_as(root, "App", "com.example.app");
    }

    fn sign_as(root: &Path, executable: &str, id: &str) {
        if !cfg!(target_os = "macos") {
            return;
        }
        fs::copy(
            "/usr/bin/true",
            root.join("Contents/MacOS").join(executable),
        )
        .unwrap();
        fs::write(
            root.join("Contents/Info.plist"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>{executable}</string>
<key>CFBundleIdentifier</key><string>{id}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>"#
            ),
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
    fn a_patch_from_the_installed_app_installs() {
        let dir = TempDir::new();
        let (root, exe) = package(dir.path(), name(), "com.example.app", "1.0.0");
        let build = dir.path().join("build");
        let (new, _) = package(&build, name(), "com.example.app", "2.0.0");
        fs::write(resources(&new).join("added"), "x").unwrap();
        sign(&new);
        let installation = Installation::of(&exe, "com.example.app", CONFIG).unwrap();
        let mut base = Vec::new();
        installation.delta_base(&mut base).unwrap();
        let mut tar = Vec::new();
        let result = crate::delta::tree(&new, &mut tar).unwrap();
        let mut patch = Vec::new();
        crate::delta::make(&base, &tar, &mut patch).unwrap();

        let patched = build.join("patched.tar");
        let out = fs::File::create(&patched).unwrap();
        crate::delta::apply(&base, &patch[..], out, &result).unwrap();
        installation.install(&patched).unwrap();
        assert_eq!(version(&root), "2.0.0");
        assert!(resources(&root).join("added").exists());
    }

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

    /// `Pal` (`com.example.pal`) becomes `Endless` (`com.example.endless`):
    /// a new id and executable name install, the restart starts the new
    /// executable, and nothing is left beside the app.
    #[test]
    fn an_app_moved_to_a_new_id_and_name_installs() {
        let (old_name, new_name) = if cfg!(target_os = "macos") {
            ("Pal.app", "Endless.app")
        } else {
            ("Pal", "Endless")
        };
        let dir = TempDir::new();
        let (root, exe) = package_of(dir.path(), old_name, "Pal", "com.example.pal", "1.0.0");
        let build = dir.path().join("build");
        let (new, _) = package_of(&build, new_name, "Endless", "com.example.endless", "2.0.0");
        sign_as(&new, "Endless", "com.example.endless");
        let archive = tar_gz(&build, &new, "new.tar.gz");

        let installation = Installation::of(&exe, "com.example.pal", CONFIG).unwrap();
        // A stage an earlier run of Pal left when it crashed.
        let crashed = dir.path().join(format!("{STAGED}1-{old_name}"));
        fs::create_dir_all(&crashed).unwrap();
        let installed = installation.install(&archive).unwrap();

        // macOS renames the bundle; Linux and Windows keep the directory.
        let expected_root = if cfg!(target_os = "macos") {
            dir.path().join(new_name)
        } else {
            root.clone()
        };
        let expected_exe = if cfg!(target_os = "macos") {
            expected_root.join("Contents/MacOS/Endless")
        } else if cfg!(windows) {
            expected_root.join("Endless.exe")
        } else {
            expected_root.join("Endless")
        };
        assert_eq!(installed, expected_exe);
        assert!(installed.is_file());
        assert_eq!(version(&expected_root), "2.0.0");
        assert_eq!(
            package_id(&expected_root).as_deref(),
            Some("com.example.endless")
        );
        if cfg!(target_os = "macos") {
            assert!(!root.exists());
        } else {
            assert!(!exe.exists());
        }
        // The new app, at its next start, is found by its new id and
        // removes what it may (Windows: the old executable).
        Installation::of(&installed, "com.example.endless", CONFIG)
            .unwrap()
            .remove_leftovers();
        assert_eq!(left_beside(dir.path()), Vec::<String>::new());
    }

    /// Windows' layout, on every system: the running `Pal.exe` is swapped
    /// for `Endless.exe` in place.
    #[test]
    fn entries_swap_to_a_renamed_executable() {
        let dir = TempDir::new();
        let root = dir.path().join("Pal");
        let new = dir.path().join("Endless");
        fs::create_dir_all(root.join("nsh")).unwrap();
        fs::create_dir_all(new.join("nsh")).unwrap();
        fs::write(root.join("Pal.exe"), "old").unwrap();
        fs::write(new.join("Endless.exe"), "new").unwrap();
        swap_entries(&root, &new, Path::new("Pal.exe")).unwrap();
        assert_eq!(fs::read_to_string(root.join("Endless.exe")).unwrap(), "new");
        assert!(!root.join("Pal.exe").exists());
    }

    #[test]
    fn an_archive_without_a_single_executable_changes_nothing() {
        let dir = TempDir::new();
        let (root, exe) = package(dir.path(), name(), "com.example.app", "1.0.0");
        let build = dir.path().join("build");
        let (new, new_exe) = package_of(&build, name(), "One", "com.example.app", "2.0.0");
        let second = new_exe.with_file_name(if cfg!(windows) { "Two.exe" } else { "Two" });
        fs::copy(&new_exe, &second).unwrap();
        let archive = tar_gz(&build, &new, "new.tar.gz");
        let installation = Installation::of(&exe, "com.example.app", CONFIG).unwrap();
        let error = installation.install(&archive).unwrap_err().to_string();
        assert!(error.contains("single app executable"), "{error}");
        assert_eq!(version(&root), "1.0.0");
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

    /// What `.nsh-updater` left beside the app.
    fn left_beside(dir: &Path) -> Vec<String> {
        let mut left: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".nsh-updater"))
            .collect();
        left.sort();
        left
    }

    #[test]
    fn a_staged_update_replaces_the_app_only_when_finished() {
        let dir = TempDir::new();
        let (root, exe) = package(dir.path(), name(), "com.example.app", "1.0.0");
        let build = dir.path().join("build");
        let (new, _) = package(&build, name(), "com.example.app", "2.0.0");
        sign(&new);
        let archive = tar_gz(&build, &new, "new.tar.gz");
        let installation = Installation::of(&exe, "com.example.app", CONFIG).unwrap();

        // Dropped: the app stays, nothing is left.
        drop(installation.stage(&archive).unwrap());
        assert_eq!(version(&root), "1.0.0");
        assert_eq!(left_beside(dir.path()), Vec::<String>::new());

        // Staged again (replacing an earlier stage), then finished.
        let first = installation.stage(&archive).unwrap();
        std::mem::forget(first);
        let staged = installation.stage(&archive).unwrap();
        assert_eq!(version(&root), "1.0.0");
        assert_eq!(left_beside(dir.path()).len(), 1);
        staged.finish().unwrap();
        assert_eq!(version(&root), "2.0.0");
        assert_eq!(left_beside(dir.path()), Vec::<String>::new());
    }

    #[test]
    fn a_staged_update_is_checked_when_staged() {
        let dir = TempDir::new();
        let (root, exe) = package(dir.path(), name(), "com.example.app", "1.0.0");
        let build = dir.path().join("build");
        let new = build.join(name());
        fs::create_dir_all(resources(&new)).unwrap();
        let archive = tar_gz(&build, &new, "new.tar.gz");
        let installation = Installation::of(&exe, "com.example.app", CONFIG).unwrap();
        assert!(installation.stage(&archive).is_err());
        assert_eq!(version(&root), "1.0.0");
        assert_eq!(left_beside(dir.path()), Vec::<String>::new());
    }

    #[test]
    fn finishing_after_the_app_moved_changes_nothing() {
        let dir = TempDir::new();
        let (root, exe) = package(dir.path(), name(), "com.example.app", "1.0.0");
        let build = dir.path().join("build");
        let (new, _) = package(&build, name(), "com.example.app", "2.0.0");
        sign(&new);
        let archive = tar_gz(&build, &new, "new.tar.gz");
        let installation = Installation::of(&exe, "com.example.app", CONFIG).unwrap();
        let staged = installation.stage(&archive).unwrap();
        let moved = dir.path().join("moved");
        fs::rename(&root, &moved).unwrap();
        assert!(staged.finish().is_err());
        assert!(!root.exists());
        assert_eq!(version(&moved), "1.0.0");
        assert_eq!(left_beside(dir.path()), Vec::<String>::new());
    }

    #[test]
    fn leftovers_are_stages_of_this_app_by_other_processes() {
        let dir = TempDir::new();
        let (_, exe) = package(dir.path(), name(), "com.example.app", "1.0.0");
        let installation = Installation::of(&exe, "com.example.app", CONFIG).unwrap();
        let own = installation.staged_dir().unwrap();
        let crashed = dir.path().join(format!("{STAGED}1-{}", name()));
        let other_app = dir.path().join(format!("{STAGED}1-Other{}", name()));
        let other_app_dashed = dir.path().join(format!("{STAGED}1-x-{}", name()));
        for path in [&own, &crashed, &other_app, &other_app_dashed] {
            fs::create_dir_all(path).unwrap();
        }
        installation.remove_leftovers();
        assert!(own.exists());
        assert!(!crashed.exists());
        assert!(other_app.exists());
        assert!(other_app_dashed.exists());
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
