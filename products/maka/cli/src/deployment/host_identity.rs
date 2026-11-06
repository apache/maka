/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! The identity the Host runs under on macOS.
//!
//! macOS grants Accessibility and Screen Recording, which Computer Use
//! needs, to the application responsible for a process. Started directly,
//! the Host belongs to whichever application started it first (Maka, or the
//! terminal a CLI ran in). `Maka.app` therefore carries a helper,
//! `Maka Host.app`, whose executable runs the Host as its own application,
//! so the grants belong to "Maka Host" however the Host was started.
//!
//! macOS ties a grant to the exact bytes of that executable, and every
//! package is installed into a directory of its own. So the helper is
//! copied once into the account data directory and replaced only when a
//! package carries a higher bundle version or the installed signature is
//! broken. A new build of the same version
//! keeps the copy, and with it the grants. Bump `hostApp.version` in
//! `scripts/rust/build-cli.mjs` only when the helper must change.

use std::path::{Path, PathBuf};

/// The program and its leading arguments that run `executable` as the Host.
/// A development build without a packaged or installed helper runs directly.
pub(super) async fn command(executable: &Path) -> Result<(PathBuf, Vec<String>), String> {
    let argument = executable
        .to_str()
        .ok_or("Host executable path must be UTF-8")?
        .to_owned();
    let executable = executable.to_owned();
    let source = executable.clone();
    match tokio::task::spawn_blocking(move || shell(&source))
        .await
        .map_err(|error| error.to_string())??
    {
        Some(shell) => Ok((shell, vec![argument])),
        None => Ok((executable, Vec::new())),
    }
}

const BUNDLE: &str = "Maka Host.app";
const EXECUTABLE: &str = "Contents/MacOS/maka-host-shell";

/// Installs, upgrades or repairs the Host identity. This blocks on file and
/// signature checks and must not run on an asynchronous executor thread.
pub(super) fn shell(executable: &Path) -> Result<Option<PathBuf>, String> {
    let namespaces = maka_event_log::root::RootNamespaces::for_current_account()
        .map_err(|error| format!("find macOS Host identity directory: {error}"))?;
    let installed = namespaces
        .ownership
        .parent()
        .ok_or("Host identity directory has no parent")?
        .join(BUNDLE);
    let packaged = executable
        .parent()
        .ok_or("Host executable has no parent")?
        .join("Maka.app/Contents/Helpers")
        .join(BUNDLE);
    let shell = prepare(&packaged, &installed)
        .map_err(|error| format!("prepare macOS Host identity: {error}"))?;
    if shell.is_some() {
        maka_computer_use::system_permission::register_application(&installed)?;
    }
    Ok(shell)
}

fn prepare(packaged: &Path, installed: &Path) -> std::io::Result<Option<PathBuf>> {
    let current = verified(installed);
    if (current.is_err() || version(packaged) > version(installed)) && packaged.try_exists()? {
        verified(packaged)?;
        install(packaged, installed)?;
        return verified(installed).map(Some);
    }
    if installed.try_exists()? {
        current.map(Some)
    } else {
        Ok(None)
    }
}

fn verified(bundle: &Path) -> std::io::Result<PathBuf> {
    if version(bundle).is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{} has no valid Host bundle version", bundle.display()),
        ));
    }
    let signature = std::process::Command::new("/usr/bin/codesign")
        .args([
            "--verify",
            "--strict",
            "--test-requirement",
            "=identifier \"org.apache.maka.host\"",
        ])
        .arg(bundle)
        .output()?;
    if !signature.status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "invalid Host identity at {}: {}",
                bundle.display(),
                String::from_utf8_lossy(&signature.stderr).trim()
            ),
        ));
    }
    Ok(bundle.join(EXECUTABLE))
}

/// The bundle's `CFBundleVersion`, an integer the build sets.
fn version(bundle: &Path) -> Option<u64> {
    let plist = std::fs::read_to_string(bundle.join("Contents/Info.plist")).ok()?;
    let (_, after) = plist.split_once("<key>CFBundleVersion</key>")?;
    let (_, value) = after.split_once("<string>")?;
    let (value, _) = value.split_once("</string>")?;
    value.trim().parse().ok()
}

/// Copies the bundle byte for byte next to `destination`, then swaps it
/// into place in one step, so a reader sees either the old or the new
/// bundle, never a partial or missing one.
fn install(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;

    let parent = destination.parent().ok_or(std::io::ErrorKind::NotFound)?;
    remove_abandoned(parent);
    let staged = parent.join(format!("{STAGED}{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staged);
    copy(source, &staged).inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&staged);
    })?;
    let from = std::ffi::CString::new(staged.as_os_str().as_bytes())?;
    let to = std::ffi::CString::new(destination.as_os_str().as_bytes())?;
    // SAFETY: both are valid NUL-terminated paths.
    let swapped = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_SWAP) };
    let result = if swapped == 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound && !destination.exists() {
            // Nothing to swap with: a plain rename never replaces a bundle
            // that appeared meanwhile, because it fails on a full directory.
            std::fs::rename(&staged, destination)
        } else {
            Err(error)
        }
    };
    // After a swap the staged path holds the old bundle.
    let _ = std::fs::remove_dir_all(&staged);
    result
}

/// The prefix of a bundle being installed, followed by the installer's pid.
const STAGED: &str = ".Maka Host.app-";

/// Removes bundles staged by installers that are no longer running.
fn remove_abandoned(parent: &Path) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|name| name.strip_prefix(STAGED))
            .and_then(|pid| pid.parse::<libc::pid_t>().ok())
        else {
            continue;
        };
        // SAFETY: signal 0 only checks that the process exists.
        let gone = pid > 0
            && unsafe { libc::kill(pid, 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        if gone {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn copy(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::create_dir(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            copy(&entry.path(), &target)?;
        } else if kind.is_file() {
            // Copies the permissions too.
            std::fs::copy(entry.path(), &target)?;
        } else {
            return Err(std::io::Error::other("helper bundle holds a link"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKER: &str = "Contents/Resources/version";

    fn bundle(root: &Path, name: &str, version: &str, marker: &[u8]) -> PathBuf {
        let bundle = root.join(name);
        std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        std::fs::create_dir_all(bundle.join("Contents/Resources")).unwrap();
        std::fs::write(
            bundle.join("Contents/Info.plist"),
            format!(
                "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict>\n\
             <key>CFBundleIdentifier</key><string>org.apache.maka.host</string>\n\
             <key>CFBundleExecutable</key><string>maka-host-shell</string>\n\
             <key>CFBundlePackageType</key><string>APPL</string>\n\
             <key>CFBundleVersion</key><string>{version}</string>\n</dict></plist>\n"
            ),
        )
        .unwrap();
        std::fs::copy("/usr/bin/true", bundle.join(EXECUTABLE)).unwrap();
        std::fs::write(bundle.join(MARKER), marker).unwrap();
        let signed = std::process::Command::new("/usr/bin/codesign")
            .args([
                "--force",
                "--sign",
                "-",
                "--identifier",
                "org.apache.maka.host",
                "--timestamp=none",
            ])
            .arg(&bundle)
            .output()
            .unwrap();
        assert!(
            signed.status.success(),
            "{}",
            String::from_utf8_lossy(&signed.stderr)
        );
        bundle
    }

    #[test]
    fn reads_the_bundle_version() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(version(&bundle(root.path(), "a.app", "3", b"x")), Some(3));
        assert_eq!(version(&bundle(root.path(), "b.app", "1.0", b"x")), None);
        assert_eq!(version(&root.path().join("missing.app")), None);
    }

    #[test]
    fn installs_and_replaces_the_whole_bundle() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join(BUNDLE);
        install(&bundle(root.path(), "one.app", "1", b"one"), &destination).unwrap();
        assert_eq!(std::fs::read(destination.join(MARKER)).unwrap(), b"one");
        install(&bundle(root.path(), "two.app", "2", b"two"), &destination).unwrap();
        assert_eq!(std::fs::read(destination.join(MARKER)).unwrap(), b"two");
        assert_eq!(version(&destination), Some(2));
        let leftovers = std::fs::read_dir(root.path())
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with('.')
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn installs_upgrades_and_repairs_but_never_downgrades() {
        let root = tempfile::tempdir().unwrap();
        let installed = root.path().join(BUNDLE);
        let one = bundle(root.path(), "one.app", "1", b"one");
        let two = bundle(root.path(), "two.app", "2", b"two");
        let shell = prepare(&one, &installed).unwrap().unwrap();
        assert_eq!(std::fs::read(installed.join(MARKER)).unwrap(), b"one");
        prepare(&two, &installed).unwrap();
        assert_eq!(std::fs::read(installed.join(MARKER)).unwrap(), b"two");
        // An older package keeps the newer helper and its grants.
        prepare(&one, &installed).unwrap();
        assert_eq!(std::fs::read(installed.join(MARKER)).unwrap(), b"two");
        // A helper without its executable is replaced.
        std::fs::remove_file(&shell).unwrap();
        prepare(&one, &installed).unwrap();
        assert_eq!(std::fs::read(installed.join(MARKER)).unwrap(), b"one");
        // Nothing to install and nothing installed.
        let missing = root.path().join("missing.app");
        assert_eq!(
            prepare(&missing, &root.path().join("none.app")).unwrap(),
            None
        );
    }

    #[test]
    fn repairs_a_same_version_with_a_broken_signature() {
        let root = tempfile::tempdir().unwrap();
        let source = bundle(root.path(), "source.app", "2", b"original");
        let installed = root.path().join(BUNDLE);
        prepare(&source, &installed).unwrap();
        std::fs::write(installed.join(MARKER), b"corrupted").unwrap();
        assert!(verified(&installed).is_err());
        prepare(&source, &installed).unwrap();
        assert_eq!(std::fs::read(installed.join(MARKER)).unwrap(), b"original");
        assert!(verified(&installed).is_ok());
    }

    #[test]
    fn rejects_invalid_updates_and_reports_install_failures() {
        let root = tempfile::tempdir().unwrap();
        let old = bundle(root.path(), "old.app", "1", b"old");
        let new = bundle(root.path(), "new.app", "2", b"new");
        let installed = root.path().join(BUNDLE);
        prepare(&old, &installed).unwrap();
        std::fs::write(new.join(MARKER), b"corrupted").unwrap();
        assert!(prepare(&new, &installed).is_err());
        assert!(verified(&installed).is_ok());
        assert_eq!(version(&installed), Some(1));
        let blocked = root.path().join("not-a-directory");
        std::fs::write(&blocked, b"x").unwrap();
        assert!(prepare(&old, &blocked.join(BUNDLE)).is_err());
        let missing = root.path().join("missing.app");
        std::fs::write(installed.join(MARKER), b"corrupted").unwrap();
        assert!(prepare(&missing, &installed).is_err());
    }

    #[test]
    fn removes_bundles_abandoned_by_stopped_installers() {
        let root = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let stopped = child.id();
        child.wait().unwrap();
        let abandoned = root.path().join(format!("{STAGED}{stopped}"));
        let running = root.path().join(format!("{STAGED}{}", std::process::id()));
        std::fs::create_dir(&abandoned).unwrap();
        std::fs::create_dir(&running).unwrap();
        remove_abandoned(root.path());
        assert!(!abandoned.exists());
        assert!(running.exists());
    }
}
