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

#[cfg(unix)]
use super::SnapshotKind;
use super::SnapshotProof;
use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
};

/// Read-only original capture custody, not a permission document or job owner.
/// Methods perform native filesystem I/O; call them on a blocking worker.
pub struct BaselineReader {
    #[cfg(unix)]
    directory: File,
    proof: SnapshotProof,
}
pub enum BaselineEntry {
    Missing,
    File {
        file: File,
        mode: u32,
    },
    Directory {
        mode: u32,
    },
    Symlink {
        source_target: PathBuf,
        working_target: PathBuf,
    },
}
impl BaselineReader {
    pub fn snapshot(&self) -> &SnapshotProof {
        &self.proof
    }

    #[cfg(unix)]
    pub(super) fn from_resource(resource: &File, proof: SnapshotProof) -> io::Result<Self> {
        use rustix::fs::{Mode, OFlags, openat};
        let directory: File = openat(
            resource,
            "baseline",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )?
        .into();
        if super::snapshot::identity(&directory.metadata()?) != proof.baseline_identity() {
            return Err(changed());
        }
        Ok(Self { directory, proof })
    }
    #[cfg(not(unix))]
    pub(super) fn from_resource(_: &File, _: SnapshotProof) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "immutable baseline unavailable",
        ))
    }

    /// Return original entry bytes/type for an already selected candidate path.
    /// No mtime/size shortcut is used, and no working-tree path is followed.
    /// Missing includes names that were outside the original read ceiling;
    /// publication must still prove current source absence and current authority.
    #[cfg(unix)]
    pub fn open_entry(&self, relative: &Path) -> io::Result<BaselineEntry> {
        open_entry(&self.directory, self.proof.files(), relative)
    }
    #[cfg(not(unix))]
    pub fn open_entry(&self, _: &Path) -> io::Result<BaselineEntry> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "immutable baseline unavailable",
        ))
    }
}
#[cfg(unix)]
fn changed() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "original immutable baseline identity or type changed",
    )
}

#[cfg(unix)]
pub(super) fn open_entry(
    directory: &File,
    files: &[super::SnapshotFile],
    relative: &Path,
) -> io::Result<BaselineEntry> {
    use rustix::fs::{AtFlags, Mode, OFlags, openat, readlinkat, statat};
    use std::path::Component;
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "baseline entry requires a normalized relative path",
        ));
    }
    let Ok(index) = files.binary_search_by(|entry| entry.relative_path.as_path().cmp(relative))
    else {
        return Ok(BaselineEntry::Missing);
    };
    let original = &files[index];
    let mut parent = directory.try_clone()?;
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        if components.peek().is_none() {
            break;
        }
        parent = openat(
            &parent,
            component.as_os_str(),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )?
        .into();
    }
    let name = relative
        .file_name()
        .ok_or_else(|| io::Error::other("baseline entry name"))?;
    match &original.kind {
        SnapshotKind::File | SnapshotKind::Directory => {
            let mut flags = OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK;
            if matches!(original.kind, SnapshotKind::Directory) {
                flags |= OFlags::DIRECTORY;
            }
            let file: File = openat(&parent, name, flags, Mode::empty())?.into();
            let metadata = file.metadata()?;
            if super::snapshot::identity(&metadata) != original.identity {
                return Err(changed());
            }
            match &original.kind {
                SnapshotKind::File if metadata.is_file() => Ok(BaselineEntry::File {
                    file,
                    mode: original.mode,
                }),
                SnapshotKind::Directory if metadata.is_dir() => Ok(BaselineEntry::Directory {
                    mode: original.mode,
                }),
                _ => Err(changed()),
            }
        }
        SnapshotKind::Symlink {
            source_target,
            working_target,
        } => {
            let stat = statat(&parent, name, AtFlags::SYMLINK_NOFOLLOW)?;
            if stat.st_dev as u64 != original.identity.device
                || stat.st_ino as u64 != original.identity.inode
            {
                return Err(changed());
            }
            let target = PathBuf::from(OsString::from_vec(
                readlinkat(&parent, name, Vec::new())?.into_bytes(),
            ));
            if target != *source_target {
                return Err(changed());
            }
            Ok(BaselineEntry::Symlink {
                source_target: source_target.clone(),
                working_target: working_target.clone(),
            })
        }
    }
}
