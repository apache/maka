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

//! Short-lived live-mount directory observations for single operations and cursors.
use cap_fs_ext::MetadataExt;
use cap_std::{ambient_authority, fs::Dir};
use serde::{Deserialize, Serialize};
use std::{
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "String", into = "String")]
#[schemars(with = "String")]
pub struct Observation(String);

impl Observation {
    pub fn matches(&self, directory: &Dir) -> io::Result<bool> {
        Ok(&identity(directory)? == self)
    }
}

impl TryFrom<String> for Observation {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.strip_prefix("sha256:").is_none_or(|hex| {
            hex.len() != 64
                || !hex
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            return Err("invalid directory observation");
        }
        Ok(Self(value))
    }
}

impl From<Observation> for String {
    fn from(observation: Observation) -> Self {
        observation.0
    }
}

pub fn capture(path: &Path) -> io::Result<(PathBuf, Observation)> {
    let (path, _directory, observed) = capture_directory(path)?;
    Ok((path, observed))
}

pub fn capture_directory(path: &Path) -> io::Result<(PathBuf, Dir, Observation)> {
    let path = path.canonicalize()?;
    let directory = Dir::open_ambient_dir(&path, ambient_authority())?;
    let observed = identity(&directory)?;
    if path.canonicalize()? != path {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "authorized directory was replaced",
        ));
    }
    open(&path, &observed)?;
    Ok((path, directory, observed))
}

pub fn open(path: &Path, expected: &Observation) -> io::Result<Dir> {
    let directory = Dir::open_ambient_dir(path, ambient_authority())?;
    if !expected.matches(&directory)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "authorized directory was replaced",
        ));
    }
    Ok(directory)
}

/// Identify the held directory on its current mount without reopening its ambient pathname.
pub fn identity(directory: &Dir) -> io::Result<Observation> {
    let metadata = directory.dir_metadata()?;
    let birth = if stable_birth(directory)? {
        metadata
            .created()
            .ok()
            .and_then(|time| time.into_std().duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| (duration.as_secs(), duration.subsec_nanos()))
    } else {
        None
    };
    let bytes =
        serde_json::to_vec(&(metadata.dev(), metadata.ino(), birth)).map_err(io::Error::other)?;
    Observation::try_from(maka_agent_facts::artifact::content_digest(&bytes))
        .map_err(io::Error::other)
}

#[cfg(target_os = "linux")]
fn stable_birth(directory: &Dir) -> io::Result<bool> {
    use std::os::fd::AsRawFd;
    // SAFETY: fstatfs initializes the struct on success, and directory owns the fd.
    let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(directory.as_raw_fd(), filesystem.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let filesystem = unsafe { filesystem.assume_init() };
    // Overlayfs copy-up replaces a lower directory's birth time while keeping its origin inode.
    Ok(filesystem.f_type != libc::OVERLAYFS_SUPER_MAGIC)
}

#[cfg(not(target_os = "linux"))]
fn stable_birth(_directory: &Dir) -> io::Result<bool> {
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_tracks_live_directory_and_rejects_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("workspace");
        std::fs::create_dir(&path).unwrap();
        let (canonical, directory, observed) = capture_directory(&path).unwrap();

        std::fs::write(canonical.join("probe.txt"), b"ok").unwrap();
        std::fs::remove_file(canonical.join("probe.txt")).unwrap();
        assert!(open(&canonical, &observed).is_ok());

        std::fs::rename(&canonical, temp.path().join("moved")).unwrap();
        std::fs::create_dir(&canonical).unwrap();
        assert!(open(&canonical, &observed).is_err());
        assert!(observed.matches(&directory).unwrap());
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires a fresh lower-layer overlayfs directory in MAKA_TEST_OVERLAYFS_DIR"]
    fn observation_and_published_directory_survive_linux_overlayfs_copy_up() {
        use std::{os::fd::AsRawFd, sync::atomic::AtomicBool};

        let target = PathBuf::from(
            std::env::var_os("MAKA_TEST_OVERLAYFS_DIR").expect("overlayfs fixture directory"),
        );
        let private = tempfile::tempdir().unwrap();
        let control = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);

        let (canonical, before_dir, observed) = capture_directory(&target).unwrap();
        let mut statfs = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // SAFETY: fstatfs initializes the struct on success, and before_dir holds the fd.
        assert_eq!(
            unsafe { libc::fstatfs(before_dir.as_raw_fd(), statfs.as_mut_ptr()) },
            0
        );
        // SAFETY: fstatfs succeeded and initialized the struct.
        assert_eq!(
            unsafe { statfs.assume_init() }.f_type,
            libc::OVERLAYFS_SUPER_MAGIC
        );
        let before_birth = before_dir.dir_metadata().unwrap().created().ok();

        let published = crate::workspace::directory::PublishedDirectory::open(&canonical).unwrap();
        let before_page = crate::files::Directory::open(
            &canonical,
            &observed,
            private.path(),
            control.path(),
            None,
            None,
            &cancel,
        )
        .unwrap()
        .list(None, &cancel)
        .unwrap();

        std::fs::write(canonical.join("trigger-copy-up.txt"), b"copied").unwrap();

        let after_dir = open(&canonical, &observed).unwrap();
        let after_birth = after_dir.dir_metadata().unwrap().created().ok();
        assert_ne!(
            before_birth, after_birth,
            "expected overlayfs copy-up to update directory birth time"
        );
        assert!(observed.matches(&after_dir).unwrap());
        published.validate(&canonical).unwrap();

        let after_page = crate::files::Directory::open(
            &canonical,
            &observed,
            private.path(),
            control.path(),
            None,
            None,
            &cancel,
        )
        .unwrap()
        .list(None, &cancel)
        .unwrap();
        assert_eq!(
            before_page.directory_identity,
            after_page.directory_identity
        );
    }
}
